import z from "@deepseek-ai/schemastery";
import { extname } from "node:path";
import { LlmAdapter, LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { effectiveSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { effectiveApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
//#region src/validation.ts
/** Runtime validation helpers for values crossing the App Server JSON boundary. */
/** Return a JSON object or reject the named protocol value. */
function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}`);
	return value;
}
/** Return a non-empty string or reject the named protocol value. */
function string(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}`);
	return value;
}
/** Normalize an unknown rejection into an Error without discarding its text. */
function thrown(value) {
	return value instanceof Error ? value : new Error(String(value));
}
/** Read an optional string field from a JSON object. */
function optionalString(value) {
	return typeof value === "string" ? value : void 0;
}
//#endregion
//#region src/app-server.ts
/** Owned Codex App Server process and JSONL connection. */
var NotificationQueue = class {
	values = [];
	waiters = [];
	terminal;
	push(value) {
		if (this.terminal !== void 0) return;
		const waiter = this.waiters.shift();
		if (waiter === void 0) this.values.push(value);
		else waiter.resolve({
			done: false,
			value
		});
	}
	end() {
		this.settle({});
	}
	fail(error) {
		this.settle({ error });
	}
	settle(terminal) {
		if (this.terminal !== void 0) return;
		this.terminal = terminal;
		for (const waiter of this.waiters.splice(0)) if (terminal.error === void 0) waiter.resolve({
			done: true,
			value: void 0
		});
		else waiter.reject(terminal.error);
	}
	[Symbol.asyncIterator]() {
		return { next: () => {
			const value = this.values.shift();
			if (value !== void 0) return Promise.resolve({
				done: false,
				value
			});
			if (this.terminal?.error !== void 0) return Promise.reject(this.terminal.error);
			if (this.terminal !== void 0) return Promise.resolve({
				done: true,
				value: void 0
			});
			const waiter = Promise.withResolvers();
			this.waiters.push(waiter);
			return waiter.promise;
		} };
	}
};
/** One initialized or initializing App Server child. */
var CodexAppServerConnection = class {
	child;
	transport;
	queue = new NotificationQueue();
	closing = false;
	constructor(child, requestHandler) {
		this.child = child;
		if (child.stdout === void 0 || child.stdin === void 0) throw new Error("codex-plugin-dsh: App Server subprocess requires piped stdin and stdout");
		this.transport = new JsonRpcLineTransport(child.stdout, child.stdin);
		this.transport.onRequest(requestHandler);
		this.transport.onNotification((method, params) => {
			this.queue.push({
				method,
				params
			});
		});
		child.done.then((outcome) => {
			if (this.closing) return;
			this.queue.fail(/* @__PURE__ */ new Error(`codex-plugin-dsh: App Server exited unexpectedly (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${this.stderrSuffix()}`));
		}, (error) => {
			if (!this.closing) this.queue.fail(thrown(error));
		});
	}
	/** Attach protocol listeners and perform the required initialize handshake. */
	async initialize(signal) {
		this.transport.start();
		object(await this.transport.request("initialize", {
			clientInfo: {
				name: "codex-plugin-dsh",
				title: "Codex Plugin for DeepSeek Harness",
				version: "0.1.0"
			},
			capabilities: {
				experimentalApi: true,
				requestAttestation: false
			}
		}, signal), "initialize response");
		this.transport.notify("initialized", {});
		await this.transport.flush();
	}
	/** Send one typed-by-caller App Server request. */
	async request(method, params, signal) {
		return object(await this.transport.request(method, params, signal), `${method} response`);
	}
	/** Send a best-effort interrupt for an active turn. */
	interrupt(threadId, turnId) {
		if (this.closing) return;
		this.transport.request("turn/interrupt", {
			threadId,
			turnId
		}).catch(() => {});
	}
	/** Notifications emitted by this single-operation connection. */
	notifications() {
		return this.queue;
	}
	/** Terminate the managed process tree and wait until it is gone. Idempotent. */
	async close() {
		if (this.closing) return;
		this.closing = true;
		this.queue.end();
		this.transport.close();
		try {
			this.child.stdin?.end();
		} catch {}
		this.child.terminate();
		await this.child.waitForExit();
		await this.child.done.catch(() => {});
	}
	stderrSuffix() {
		const text = (this.child.collected.stderr?.readFrom(0))?.text.trim();
		return text === void 0 || text.length === 0 ? "" : `: ${text}`;
	}
};
//#endregion
//#region src/history.ts
function replayState(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const candidate = value;
	if (candidate.kind !== "codex-app-server" || candidate.version !== 1) return void 0;
	if (typeof candidate.threadId !== "string" || candidate.threadId.length === 0) return void 0;
	if (typeof candidate.turnId !== "string" || candidate.turnId.length === 0) return void 0;
	if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) return void 0;
	return {
		kind: "codex-app-server",
		version: 1,
		threadId: candidate.threadId,
		turnId: candidate.turnId,
		sessionId: candidate.sessionId
	};
}
function latestCheckpoint(messages, provider) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || message.source.kind !== "model" || message.source.provider !== provider) continue;
		const state = replayState(message.source.replayState);
		if (state === void 0) throw new Error("codex-plugin-dsh: a prior Codex response has no compatible App Server checkpoint; start a new session");
		return {
			index,
			state
		};
	}
}
function textBlocks(blocks, label) {
	return blocks.map((block) => {
		if (block.type !== "text") throw new Error(`codex-plugin-dsh: ${label} contains unsupported ${JSON.stringify(block.type)} content`);
		return block.text;
	});
}
function isCurrentTurnInput(message) {
	return message.role === "user" && message.source.kind !== "tool" && message.content.length > 0 && message.content.every((block) => block.type === "text");
}
function toolOutput(block) {
	return textBlocks(block.content, `tool result ${JSON.stringify(block.toolCallId)}`).join("\n");
}
function userHistoryItem(message) {
	if (message.source.kind === "tool") {
		if (message.content.length !== 1 || message.content[0]?.type !== "tool-result") throw new Error("codex-plugin-dsh: a DSH tool message has invalid tool-result content");
		const block = message.content[0];
		return [{
			type: "function_call_output",
			call_id: block.toolCallId,
			output: toolOutput(block)
		}];
	}
	const texts = textBlocks(message.content, "user history");
	return [{
		type: "message",
		role: message.role,
		content: texts.map((text) => ({
			type: "input_text",
			text
		}))
	}];
}
function assistantHistoryItems(message) {
	const items = [];
	let text = [];
	const flushText = () => {
		if (text.length === 0) return;
		items.push({
			type: "message",
			role: "assistant",
			status: "completed",
			content: text
		});
		text = [];
	};
	for (const block of message.content) switch (block.type) {
		case "text":
			text.push({
				type: "output_text",
				text: block.text,
				annotations: []
			});
			break;
		case "tool-call":
			flushText();
			items.push({
				type: "function_call",
				call_id: block.id,
				name: block.name,
				arguments: block.arguments,
				status: "completed"
			});
			break;
		case "reasoning": throw new Error("codex-plugin-dsh: another provider's reasoning history cannot be imported into Codex App Server; start a new session");
		case "image":
		case "tool-result": throw new Error(`codex-plugin-dsh: assistant history contains unsupported ${JSON.stringify(block.type)} content`);
		default: throw new Error("codex-plugin-dsh: assistant history contains a plugin-defined content block that App Server cannot import");
	}
	flushText();
	return items;
}
/** Map completed DSH history to raw Responses items accepted by `thread/inject_items`. */
function responseItems(messages) {
	return messages.flatMap((message) => {
		if (message.role === "assistant") return assistantHistoryItems(message);
		if (message.role === "user" || message.role === "system") return userHistoryItem(message);
		throw new Error(`codex-plugin-dsh: unsupported history role ${JSON.stringify(message.role)}`);
	});
}
/**
* Split a DSH request into a pinned Codex checkpoint, completed history to import, and current text input.
* @param messages - Exact DSH provider message sequence for this request.
* @param provider - Registered Codex provider route.
* @returns Work required to construct the matching App Server thread.
*/
function prepareCodexHistory(messages, provider) {
	const checkpoint = latestCheckpoint(messages, provider);
	const pending = checkpoint === void 0 ? messages : messages.slice(checkpoint.index + 1);
	let inputStart = pending.length;
	while (inputStart > 0 && isCurrentTurnInput(pending[inputStart - 1])) inputStart -= 1;
	const historical = pending.slice(0, inputStart);
	const current = pending.slice(inputStart);
	if (current.length === 0) throw new Error("codex-plugin-dsh: the current Codex turn has no text user input");
	const turnInput = current.flatMap((message) => textBlocks(message.content, "current user input").map((text) => ({
		type: "text",
		text,
		text_elements: []
	})));
	if (turnInput.every((input) => input.text.trim().length === 0)) throw new Error("codex-plugin-dsh: the current Codex turn is empty");
	return {
		...checkpoint === void 0 ? {} : { checkpoint: checkpoint.state },
		injectItems: responseItems(historical),
		turnInput
	};
}
//#endregion
//#region src/adapter.ts
/** Codex App Server implementation of the DeepSeek Harness LLM adapter API. */
/** Provider route registered in the existing DSH model catalog. */
const CODEX_APP_SERVER_PROVIDER = "codex-app-server";
const WINDOWS_EXECUTABLE_ENV = "DSH_CODEX_APP_SERVER_EXECUTABLE";
/**
* Build the fixed App Server command without allowing configured text into a Windows command tail.
* @param executable - Absolute executable path resolved by the DSH subprocess provider.
* @param env - Explicit child environment from plugin configuration.
* @param platform - Host platform selecting the Windows batch-shim path.
* @param commandInterpreter - Resolved Windows command interpreter.
* @returns Child argv and environment for the managed subprocess.
*/
function codexAppServerInvocation(executable, env, platform = process.platform, commandInterpreter = "cmd.exe") {
	const extension = extname(executable).toLowerCase();
	if (platform !== "win32" || extension !== ".cmd" && extension !== ".bat") return {
		argv: [
			executable,
			"app-server",
			"--stdio"
		],
		env
	};
	return {
		argv: [
			commandInterpreter,
			"/d",
			"/v:off",
			"/s",
			"/c",
			`%${WINDOWS_EXECUTABLE_ENV}%`,
			"app-server",
			"--stdio"
		],
		env: {
			...env,
			[WINDOWS_EXECUTABLE_ENV]: `"${executable}"`
		}
	};
}
function combinedSignal(parent, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return parent === void 0 ? timeout : AbortSignal.any([parent, timeout]);
}
function abortError(signal) {
	return signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error(`codex-plugin-dsh: operation aborted: ${String(signal.reason)}`);
}
async function nextNotification(iterator, signal) {
	signal.throwIfAborted();
	const pending = iterator.next();
	let rejectAbort;
	const aborted = new Promise((_resolve, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => {
		rejectAbort(abortError(signal));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([pending, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
function phaseOf(value) {
	if (value === void 0 || value === null) return null;
	if (value === "commentary" || value === "final_answer") return value;
	throw new Error(`codex-plugin-dsh: App Server returned unknown agent message phase ${JSON.stringify(value)}`);
}
function blockType(phase) {
	return phase === "commentary" ? "reasoning" : "text";
}
function messageText(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return String(value);
	const message = value.message;
	return typeof message === "string" ? message : JSON.stringify(value);
}
function turnFailure(turn) {
	const error = turn.error;
	const detail = error === void 0 || error === null ? "" : `: ${messageText(error)}`;
	return new LlmError(`Codex App Server turn ended with status ${String(turn.status)}${detail}`, "CODEX_APP_SERVER");
}
function contextWindowExceeded(turn) {
	if (turn.status !== "failed" || turn.error === null || typeof turn.error !== "object" || Array.isArray(turn.error)) return false;
	return turn.error.codexErrorInfo === "contextWindowExceeded";
}
function usageFrom(value) {
	const last = object(object(value, "token usage").last, "last-turn token usage");
	const integer = (field) => {
		const count = last[field];
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`codex-plugin-dsh: App Server returned invalid ${field}`);
		return count;
	};
	const input = integer("inputTokens");
	const cached = integer("cachedInputTokens");
	return {
		inputTokens: Math.max(0, input - cached),
		outputTokens: integer("outputTokens"),
		cacheReadTokens: cached,
		reasoningTokens: integer("reasoningOutputTokens")
	};
}
function availableDecisions(params) {
	if (!Array.isArray(params.availableDecisions)) return void 0;
	return new Set(params.availableDecisions.filter((value) => typeof value === "string"));
}
function deniedDecision(params, cancelled) {
	const available = availableDecisions(params);
	if (cancelled && (available === void 0 || available.has("cancel"))) return "cancel";
	if (available === void 0 || available.has("decline")) return "decline";
	if (available.has("cancel")) return "cancel";
	throw new Error("codex-plugin-dsh: App Server offered no fail-closed approval decision");
}
function approvalReason(method, params) {
	const facts = [
		optionalString(params.reason),
		optionalString(params.command),
		optionalString(params.cwd)
	].filter((value) => value !== void 0 && value.length > 0);
	return facts.length === 0 ? `Codex App Server requested ${method}` : facts.join("\n");
}
function catalogModel(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const raw = value;
	if (typeof raw.id !== "string" || raw.id.length === 0 || raw.hidden === true) return void 0;
	const efforts = Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts.flatMap((item) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
		const effort = item;
		if (typeof effort.reasoningEffort !== "string" || effort.reasoningEffort.length === 0) return [];
		return [{
			id: effort.reasoningEffort,
			...typeof effort.description === "string" && effort.description.length > 0 ? { description: effort.description } : {}
		}];
	}) : [];
	return {
		id: raw.id,
		name: typeof raw.displayName === "string" && raw.displayName.length > 0 ? raw.displayName : raw.id,
		...typeof raw.description === "string" && raw.description.length > 0 ? { description: raw.description } : {},
		...typeof raw.defaultReasoningEffort === "string" && raw.defaultReasoningEffort.length > 0 ? { defaultReasoningEffort: raw.defaultReasoningEffort } : {},
		supportedReasoningEfforts: efforts
	};
}
/** Local Codex App Server route with session-aware history, permissions, and process ownership. */
var CodexAppServerAdapter = class extends LlmAdapter {
	ctx;
	config;
	cachedModels;
	pendingModels;
	constructor(ctx, config) {
		super();
		this.ctx = ctx;
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Codex App Server (local)"
		};
	}
	async listModels(provider) {
		return (await this.models()).map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			...model.description === void 0 ? {} : { description: model.description },
			inputModalities: ["text"]
		}));
	}
	async resolveModel(provider, modelId, signal) {
		const model = (await this.models(signal)).find((candidate) => candidate.id === modelId);
		if (model === void 0) return {
			provider,
			id: modelId,
			name: modelId,
			inputModalities: ["text"]
		};
		return {
			provider,
			id: model.id,
			name: model.name,
			...model.description === void 0 ? {} : { description: model.description },
			inputModalities: ["text"],
			...model.supportedReasoningEfforts.length === 0 ? {} : { reasoning: {
				efforts: model.supportedReasoningEfforts.map((effort) => ({
					id: ReasoningEffortId(effort.id),
					name: effort.id,
					...effort.description === void 0 ? {} : { description: effort.description }
				})),
				...model.defaultReasoningEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(model.defaultReasoningEffort) }
			} }
		};
	}
	async *stream(options) {
		if (options.provider !== "codex-app-server") throw new Error(`codex-plugin-dsh: unexpected provider ${JSON.stringify(options.provider)}`);
		if (options.sessionId === void 0) throw new Error("codex-plugin-dsh: Codex App Server calls require a live DSH session");
		if (options.tools !== void 0 && options.tools.length > 0) throw new Error("codex-plugin-dsh: DSH tool schemas reached App Server; the provider isolation listener is not active");
		const unsupported = [
			options.temperature === void 0 ? void 0 : "temperature",
			options.maxTokens === void 0 ? void 0 : "maxTokens",
			options.stop === void 0 ? void 0 : "stop"
		].filter((value) => value !== void 0);
		if (unsupported.length > 0) throw new Error(`codex-plugin-dsh: App Server does not support DSH request field(s): ${unsupported.join(", ")}`);
		const session = this.ctx.sessions.get(options.sessionId);
		const agent = this.ctx.agents.get(options.sessionId);
		if (session === void 0 || agent === void 0) throw new Error(`codex-plugin-dsh: session ${JSON.stringify(options.sessionId)} is not live`);
		const cwd = session.header.cwd;
		if (cwd === void 0) throw new Error("codex-plugin-dsh: the selected DSH session has no working directory");
		const history = prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER);
		const signal = combinedSignal(options.signal, this.config.turnTimeoutMs);
		const sandbox = effectiveSandboxMode(session.events) ?? this.config.fallbackSandbox;
		const approval = effectiveApprovalPolicy(session.events) ?? this.ctx.approval.config.policy ?? "ask";
		let activeThreadId;
		let activeTurnId;
		const connection = await this.openConnection(cwd, signal, (method, params) => this.handleServerRequest(agent, signal, method, params));
		const onAbort = () => {
			if (activeThreadId !== void 0 && activeTurnId !== void 0) connection.interrupt(activeThreadId, activeTurnId);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await connection.initialize(signal);
			activeThreadId = string(object((history.checkpoint === void 0 ? await connection.request("thread/start", this.threadParams(options, cwd, sandbox, approval), signal) : await connection.request("thread/fork", {
				...this.threadParams(options, cwd, sandbox, approval),
				threadId: history.checkpoint.threadId,
				lastTurnId: history.checkpoint.turnId
			}, signal)).thread, "thread result").id, "thread id");
			if (history.injectItems.length > 0) await connection.request("thread/inject_items", {
				threadId: activeThreadId,
				items: history.injectItems
			}, signal);
			activeTurnId = string(object((await connection.request("turn/start", {
				threadId: activeThreadId,
				input: history.turnInput,
				model: options.model,
				...options.reasoningEffort === void 0 ? {} : { effort: options.reasoningEffort }
			}, signal)).turn, "turn/start turn").id, "turn id");
			const replayState = {
				kind: "codex-app-server",
				version: 1,
				threadId: activeThreadId,
				turnId: activeTurnId,
				sessionId: options.sessionId
			};
			const blocks = /* @__PURE__ */ new Map();
			let nextBlockIndex = 0;
			let finalText = false;
			let usage;
			const iterator = connection.notifications()[Symbol.asyncIterator]();
			for (;;) {
				const next = await nextNotification(iterator, signal);
				if (next.done) throw new Error("codex-plugin-dsh: App Server closed before turn/completed");
				const { method, params } = next.value;
				if (params.threadId !== activeThreadId) continue;
				if ((method === "turn/completed" ? object(params.turn, "turn/completed turn").id : params.turnId) !== activeTurnId) continue;
				if (method === "item/started") {
					const item = object(params.item, "started item");
					if (item.type !== "agentMessage") continue;
					const itemId = string(item.id, "agent message item id");
					if (blocks.has(itemId)) continue;
					const phase = phaseOf(item.phase);
					const block = {
						index: nextBlockIndex++,
						type: blockType(phase),
						phase,
						text: "",
						ended: false
					};
					blocks.set(itemId, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: block.type
					};
					continue;
				}
				if (method === "item/agentMessage/delta") {
					const itemId = string(params.itemId, "agent message delta item id");
					let block = blocks.get(itemId);
					if (block === void 0) {
						block = {
							index: nextBlockIndex++,
							type: "text",
							phase: null,
							text: "",
							ended: false
						};
						blocks.set(itemId, block);
						yield {
							type: "block-start",
							index: block.index,
							blockType: block.type
						};
					}
					if (block.ended) throw new Error("codex-plugin-dsh: App Server emitted a delta after item/completed");
					const delta = typeof params.delta === "string" ? params.delta : "";
					block.text += delta;
					if (block.type === "reasoning") yield {
						type: "reasoning-delta",
						index: block.index,
						text: delta
					};
					else yield {
						type: "text-delta",
						index: block.index,
						text: delta
					};
					continue;
				}
				if (method === "item/completed") {
					const item = object(params.item, "completed item");
					if (item.type !== "agentMessage") continue;
					const itemId = string(item.id, "completed agent message item id");
					const phase = phaseOf(item.phase);
					let block = blocks.get(itemId);
					if (block === void 0) {
						block = {
							index: nextBlockIndex++,
							type: blockType(phase),
							phase,
							text: "",
							ended: false
						};
						blocks.set(itemId, block);
						yield {
							type: "block-start",
							index: block.index,
							blockType: block.type
						};
					}
					const completedText = typeof item.text === "string" ? item.text : "";
					if (!completedText.startsWith(block.text)) throw new Error("codex-plugin-dsh: completed agent message did not match its streamed deltas");
					const tail = completedText.slice(block.text.length);
					if (tail.length > 0) {
						if (block.type === "reasoning") yield {
							type: "reasoning-delta",
							index: block.index,
							text: tail
						};
						else yield {
							type: "text-delta",
							index: block.index,
							text: tail
						};
						block.text = completedText;
					}
					block.ended = true;
					if (block.type === "reasoning") yield {
						type: "block-end",
						index: block.index,
						block: {
							type: "reasoning",
							text: block.text
						}
					};
					else {
						yield {
							type: "block-end",
							index: block.index,
							block: {
								type: "text",
								text: block.text
							}
						};
						if (block.phase !== "commentary" && block.text.trim().length > 0) finalText = true;
					}
					continue;
				}
				if (method === "thread/tokenUsage/updated") {
					usage = usageFrom(params.tokenUsage);
					continue;
				}
				if (method === "error" && params.willRetry !== true) throw new LlmError(messageText(params.error), "CODEX_APP_SERVER");
				if (method !== "turn/completed") continue;
				const completedTurn = object(params.turn, "turn/completed turn");
				if (contextWindowExceeded(completedTurn)) {
					if (usage !== void 0) yield {
						type: "usage",
						usage
					};
					yield {
						type: "finish",
						reason: { kind: "max-tokens" },
						replayState
					};
					return;
				}
				if (completedTurn.status !== "completed") throw turnFailure(completedTurn);
				if ([...blocks.values()].some((block) => !block.ended)) throw new Error("codex-plugin-dsh: App Server completed with an open agent message");
				if (!finalText) throw new Error("codex-plugin-dsh: App Server completed without a final answer");
				if (usage !== void 0) yield {
					type: "usage",
					usage
				};
				yield {
					type: "finish",
					reason: { kind: "stop" },
					replayState
				};
				return;
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
			await connection.close();
		}
	}
	threadParams(options, cwd, sandbox, approval) {
		return {
			cwd,
			model: options.model,
			approvalPolicy: approval === "never" ? "never" : "on-request",
			sandbox,
			ephemeral: false,
			...options.system === void 0 ? {} : { baseInstructions: options.system }
		};
	}
	async models(parentSignal) {
		if (this.cachedModels !== void 0 && this.cachedModels.expiresAt > Date.now()) return this.cachedModels.models;
		if (this.pendingModels !== void 0) return this.pendingModels;
		const signal = combinedSignal(parentSignal, this.config.catalogTimeoutMs);
		const pending = this.loadModels(signal);
		this.pendingModels = pending;
		try {
			const models = await pending;
			this.cachedModels = {
				expiresAt: Date.now() + this.config.modelCacheMs,
				models
			};
			return models;
		} finally {
			if (this.pendingModels === pending) this.pendingModels = void 0;
		}
	}
	async loadModels(signal) {
		const connection = await this.openConnection(process.cwd(), signal, (method) => Promise.reject(/* @__PURE__ */ new Error(`codex-plugin-dsh: unexpected App Server request during model discovery: ${method}`)));
		try {
			await connection.initialize(signal);
			const accountResult = await connection.request("account/read", { refreshToken: false }, signal);
			if (accountResult.requiresOpenaiAuth === true && accountResult.account == null) throw new LlmError("Codex login is required; run `codex login` on the DSH host", "AUTH");
			const models = [];
			let cursor = null;
			do {
				const result = await connection.request("model/list", {
					cursor,
					includeHidden: false,
					limit: this.config.modelPageSize
				}, signal);
				if (!Array.isArray(result.data)) throw new Error("codex-plugin-dsh: App Server returned invalid model list");
				models.push(...result.data.flatMap((value) => {
					const parsed = catalogModel(value);
					return parsed === void 0 ? [] : [parsed];
				}));
				cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
			} while (cursor !== null);
			if (models.length === 0) throw new Error("codex-plugin-dsh: App Server returned no available models");
			return models;
		} finally {
			await connection.close();
		}
	}
	async openConnection(cwd, signal, requestHandler) {
		const executable = await this.ctx.subprocess.resolveExecutable(this.config.executable, this.config.env, signal);
		const commandInterpreter = process.platform === "win32" && [".cmd", ".bat"].includes(extname(executable).toLowerCase()) ? await this.ctx.subprocess.resolveExecutable("cmd.exe", this.config.env, signal) : void 0;
		const invocation = codexAppServerInvocation(executable, this.config.env, process.platform, commandInterpreter);
		return new CodexAppServerConnection(this.ctx.subprocess.spawn({
			argv: [...invocation.argv],
			cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: { maxBytes: this.config.stderrMaxBytes }
			},
			graceMs: this.config.disposeGraceMs,
			env: invocation.env
		}), requestHandler);
	}
	async handleServerRequest(agent, signal, method, params) {
		switch (method) {
			case "item/commandExecution/requestApproval":
			case "item/fileChange/requestApproval": {
				const outcome = await this.ctx.approval.request({
					agent,
					toolName: method === "item/commandExecution/requestApproval" ? "codex:command" : "codex:file-change",
					reason: approvalReason(method, params),
					signal
				});
				if (outcome === "allowed-once") {
					const available = availableDecisions(params);
					if (available !== void 0 && !available.has("accept")) return { decision: deniedDecision(params, false) };
					return { decision: "accept" };
				}
				return { decision: deniedDecision(params, outcome === "cancelled") };
			}
			case "item/permissions/requestApproval": return await this.ctx.approval.request({
				agent,
				toolName: "codex:permissions",
				reason: approvalReason(method, params),
				signal
			}) === "allowed-once" ? {
				permissions: object(params.permissions, "requested permissions"),
				scope: "turn"
			} : {
				permissions: {},
				scope: "turn"
			};
			case "mcpServer/elicitation/request": return {
				action: "decline",
				content: null,
				_meta: null
			};
			case "item/tool/requestUserInput": throw new Error("codex-plugin-dsh: App Server requested interactive user input, which this adapter does not yet bridge");
			default: throw new Error(`codex-plugin-dsh: unsupported App Server request ${JSON.stringify(method)}`);
		}
	}
};
//#endregion
//#region src/index.ts
const name = "codex-plugin-dsh";
const inject = [
	"llm",
	"subprocess",
	"sessions",
	"agents",
	"approval",
	"systemPrompt"
];
const Config = z.object({
	executable: z.string().default("codex"),
	env: z.dict(z.string()).default({}),
	modelCacheMs: z.number().default(3e4),
	catalogTimeoutMs: z.number().default(1e4),
	turnTimeoutMs: z.number().default(6e5),
	disposeGraceMs: z.number().default(3e3),
	stderrMaxBytes: z.number().default(16384),
	modelPageSize: z.number().default(100),
	fallbackSandbox: z.union([
		"read-only",
		"workspace-write",
		"danger-full-access"
	]).default("read-only")
});
function resolvedConfig(config) {
	const resolved = config;
	if (resolved.executable.trim().length === 0) throw new Error("codex-plugin-dsh: executable must be non-empty");
	const positive = [
		["catalogTimeoutMs", resolved.catalogTimeoutMs],
		["turnTimeoutMs", resolved.turnTimeoutMs],
		["disposeGraceMs", resolved.disposeGraceMs],
		["stderrMaxBytes", resolved.stderrMaxBytes]
	];
	for (const [field, value] of positive) if (!Number.isFinite(value) || value <= 0) throw new Error(`codex-plugin-dsh: ${field} must be positive and finite`);
	if (!Number.isFinite(resolved.modelCacheMs) || resolved.modelCacheMs < 0) throw new Error("codex-plugin-dsh: modelCacheMs must be non-negative and finite");
	if (!Number.isSafeInteger(resolved.modelPageSize) || resolved.modelPageSize <= 0) throw new Error("codex-plugin-dsh: modelPageSize must be a positive safe integer");
	return {
		executable: resolved.executable,
		env: resolved.env,
		modelCacheMs: resolved.modelCacheMs,
		catalogTimeoutMs: resolved.catalogTimeoutMs,
		turnTimeoutMs: resolved.turnTimeoutMs,
		disposeGraceMs: resolved.disposeGraceMs,
		stderrMaxBytes: resolved.stderrMaxBytes,
		modelPageSize: resolved.modelPageSize,
		fallbackSandbox: resolved.fallbackSandbox
	};
}
/** Register the adapter and remove DSH tool schemas only while its route is selected. */
function apply(ctx, config) {
	const adapter = new CodexAppServerAdapter(ctx, resolvedConfig(config));
	ctx.llm.registerAdapter([CODEX_APP_SERVER_PROVIDER], adapter);
	ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
		const assembled = await next();
		if (assembled.variables.provider !== "codex-app-server") return assembled;
		return {
			...assembled,
			tools: []
		};
	}, {
		global: true,
		prepend: true
	});
}
//#endregion
export { CODEX_APP_SERVER_PROVIDER, CodexAppServerAdapter, Config, apply, inject, name };
