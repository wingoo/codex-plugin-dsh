import z from "@deepseek-ai/schemastery";
import { extname } from "node:path";
import { CallId, LlmAdapter, LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { createHash } from "node:crypto";
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
	observer;
	transport;
	queue = new NotificationQueue();
	closing = false;
	constructor(child, requestHandler, observer) {
		this.child = child;
		this.observer = observer;
		if (child.stdout === void 0 || child.stdin === void 0) throw new Error("codex-plugin-dsh: App Server subprocess requires piped stdin and stdout");
		this.transport = new JsonRpcLineTransport(child.stdout, child.stdin);
		this.transport.onRequest(requestHandler);
		this.transport.onNotification((method, params) => {
			const notification = {
				method,
				params
			};
			if (this.observer === void 0) this.queue.push(notification);
			else this.observer.notification(notification);
		});
		child.done.then((outcome) => {
			if (this.closing) return;
			const error = /* @__PURE__ */ new Error(`codex-plugin-dsh: App Server exited unexpectedly (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${this.stderrSuffix()}`);
			if (this.observer === void 0) this.queue.fail(error);
			else this.observer.failure(error);
		}, (error) => {
			if (this.closing) return;
			const failure = thrown(error);
			if (this.observer === void 0) this.queue.fail(failure);
			else this.observer.failure(failure);
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
		sessionId: candidate.sessionId,
		...typeof candidate.toolSignature === "string" && candidate.toolSignature.length > 0 ? { toolSignature: candidate.toolSignature } : {}
	};
}
function latestCheckpoint(messages, provider) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || message.source.kind !== "model" || message.source.provider !== provider) continue;
		const state = replayState(message.source.replayState);
		if (state === void 0) {
			if (message.content.some((block) => block.type === "tool-call")) continue;
			throw new Error("codex-plugin-dsh: a prior Codex response has no compatible App Server checkpoint; start a new session");
		}
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
	return message.role === "user" && message.source.kind !== "tool" && message.content.length > 0 && message.content.every((block) => block.type === "text" || block.type === "image");
}
async function inputContent(blocks, label, resolveImageUrl) {
	return Promise.all(blocks.map(async (block) => {
		if (block.type === "text") return {
			type: "input_text",
			text: block.text
		};
		if (block.type === "image") return {
			type: "input_image",
			image_url: await resolveImageUrl(block.attachment)
		};
		throw new Error(`codex-plugin-dsh: ${label} contains unsupported ${JSON.stringify(block.type)} content`);
	}));
}
async function toolOutput(block, resolveImageUrl) {
	const label = `tool result ${JSON.stringify(block.toolCallId)}`;
	if (block.content.every((item) => item.type === "text")) return textBlocks(block.content, label).join("\n");
	return inputContent(block.content, label, resolveImageUrl);
}
async function userHistoryItem(message, resolveImageUrl) {
	if (message.source.kind === "tool") {
		if (message.content.length !== 1 || message.content[0]?.type !== "tool-result") throw new Error("codex-plugin-dsh: a DSH tool message has invalid tool-result content");
		const block = message.content[0];
		return [{
			type: "function_call_output",
			call_id: block.toolCallId,
			output: await toolOutput(block, resolveImageUrl)
		}];
	}
	return [{
		type: "message",
		role: message.role,
		content: await inputContent(message.content, "user history", resolveImageUrl)
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
async function responseItems(messages, resolveImageUrl) {
	return (await Promise.all(messages.map(async (message) => {
		if (message.role === "assistant") return assistantHistoryItems(message);
		if (message.role === "user" || message.role === "system") return userHistoryItem(message, resolveImageUrl);
		throw new Error(`codex-plugin-dsh: unsupported history role ${JSON.stringify(message.role)}`);
	}))).flat();
}
/**
* Split a DSH request into a pinned Codex checkpoint, completed history to import, and current user input.
* @param messages - Exact DSH provider message sequence for this request.
* @param provider - Registered Codex provider route.
* @param ignoreCheckpoint - Rebuild from DSH history instead of reusing a persisted Codex thread.
* @returns Work required to construct the matching App Server thread.
*/
async function prepareCodexHistory(messages, provider, resolveImageUrl, ignoreCheckpoint = false) {
	const checkpoint = ignoreCheckpoint ? void 0 : latestCheckpoint(messages, provider);
	const pending = checkpoint === void 0 ? messages : messages.slice(checkpoint.index + 1);
	let inputStart = pending.length;
	while (inputStart > 0 && isCurrentTurnInput(pending[inputStart - 1])) inputStart -= 1;
	const historical = pending.slice(0, inputStart);
	const current = pending.slice(inputStart);
	if (current.length === 0) throw new Error("codex-plugin-dsh: the current Codex turn has no user input");
	const turnInput = (await Promise.all(current.map((message) => Promise.all(message.content.map(async (block) => {
		if (block.type === "text") return {
			type: "text",
			text: block.text,
			text_elements: []
		};
		if (block.type === "image") return {
			type: "image",
			url: await resolveImageUrl(block.attachment)
		};
		throw new Error(`codex-plugin-dsh: current user input contains unsupported ${JSON.stringify(block.type)} content`);
	}))))).flat();
	if (turnInput.every((input) => input.type === "text" && input.text.trim().length === 0)) throw new Error("codex-plugin-dsh: the current Codex turn is empty");
	return {
		...checkpoint === void 0 ? {} : { checkpoint: checkpoint.state },
		injectItems: await responseItems(historical, resolveImageUrl),
		turnInput
	};
}
//#endregion
//#region src/images.ts
/** Convert a verified DSH image reference to an inline App Server image URL. */
async function attachmentDataUrl(attachments, ref, signal) {
	const stored = await attachments.readImage(ref, signal);
	return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`;
}
function decodePngBase64(value) {
	if (typeof value !== "string") throw new Error("codex-plugin-dsh: completed App Server image generation has no base64 result");
	const encoded = value.trim();
	if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(encoded)) throw new Error("codex-plugin-dsh: App Server returned invalid generated-image base64");
	return Uint8Array.from(Buffer.from(encoded, "base64"));
}
/** Persist one completed App Server image-generation item as a DSH image block. */
async function generatedImageBlock(attachments, item) {
	if (item.status !== "completed") return void 0;
	return {
		type: "image",
		attachment: await attachments.saveImage({
			data: decodePngBase64(item.result),
			mediaType: "image/png",
			name: "codex-generated.png"
		})
	};
}
function requiredString(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}`);
	return value;
}
/**
* Map the exact DSH tool schemas assembled for a provider request to one Codex namespace.
* @param tools - Tool schemas after DSH preset, scope, and policy assembly.
* @returns Experimental App Server dynamic-tool declarations.
*/
function codexDynamicTools(tools) {
	if (tools === void 0 || tools.length === 0) return [];
	return [{
		type: "namespace",
		name: "dsh",
		description: "Tools assembled and executed by DeepSeek Harness for this session.",
		tools: tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters
		}))
	}];
}
/**
* Fingerprint the model-visible DSH tool catalog retained by an App Server thread.
* @param tools - Exact DSH tool schemas for the provider request.
* @returns Stable SHA-256 digest used to avoid redundant registrations.
*/
function codexToolSignature(tools) {
	return createHash("sha256").update(JSON.stringify(codexDynamicTools(tools))).digest("hex");
}
/**
* Validate one App Server dynamic-tool request before exposing it to the DSH loop.
* @param params - Raw `item/tool/call` parameters.
* @param availableTools - Exact DSH tool names registered for the active turn.
* @returns Validated dynamic-tool call.
*/
function codexDynamicToolCall(params, availableTools) {
	const namespace = requiredString(params.namespace, "dynamic tool namespace");
	if (namespace !== "dsh") throw new Error(`codex-plugin-dsh: App Server requested unsupported dynamic tool namespace ${JSON.stringify(namespace)}`);
	const tool = requiredString(params.tool, "dynamic tool name");
	if (!availableTools.has(tool)) throw new Error(`codex-plugin-dsh: App Server requested unregistered DSH tool ${JSON.stringify(tool)}`);
	return {
		threadId: requiredString(params.threadId, "dynamic tool thread id"),
		turnId: requiredString(params.turnId, "dynamic tool turn id"),
		callId: requiredString(params.callId, "dynamic tool call id"),
		namespace: "dsh",
		tool,
		arguments: params.arguments
	};
}
function matchingToolResult(messages, callId) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user" || message.source.kind !== "tool" || String(message.source.callId) !== callId) continue;
		if (message.content.length !== 1 || message.content[0]?.type !== "tool-result") throw new Error(`codex-plugin-dsh: DSH tool result ${JSON.stringify(callId)} has invalid content`);
		if (String(message.content[0].toolCallId) !== callId) throw new Error(`codex-plugin-dsh: DSH tool result ${JSON.stringify(callId)} has mismatched correlation`);
		return {
			index,
			block: message.content[0]
		};
	}
	throw new Error(`codex-plugin-dsh: DSH did not return tool result ${JSON.stringify(callId)}`);
}
/**
* Convert the DSH loop's logged tool result into the pending App Server response.
* @param messages - Current DSH provider message sequence after tool execution.
* @param callId - Pending App Server call identity.
* @param resolveImageUrl - Durable-image resolver for nested tool output.
* @returns Dynamic-tool response and later DSH context consumed by the still-running App Server turn.
*/
async function codexDynamicToolResult(messages, callId, resolveImageUrl) {
	const matched = matchingToolResult(messages, String(callId));
	const contentItems = await Promise.all(matched.block.content.map(async (block) => {
		if (block.type === "text") return {
			type: "inputText",
			text: block.text
		};
		if (block.type === "image") return {
			type: "inputImage",
			imageUrl: await resolveImageUrl(block.attachment)
		};
		throw new Error(`codex-plugin-dsh: DSH tool result ${JSON.stringify(String(callId))} contains unsupported ${JSON.stringify(block.type)} content`);
	}));
	const steerInput = (await Promise.all(messages.slice(matched.index + 1).map(async (message) => {
		if (message.role === "assistant" || message.source.kind === "tool") throw new Error(`codex-plugin-dsh: unexpected message followed DSH tool result ${JSON.stringify(String(callId))}`);
		return Promise.all(message.content.map(async (block) => {
			if (block.type === "text") return {
				type: "text",
				text: block.text,
				text_elements: []
			};
			if (block.type === "image") return {
				type: "image",
				url: await resolveImageUrl(block.attachment)
			};
			throw new Error(`codex-plugin-dsh: context after tool result ${JSON.stringify(String(callId))} contains unsupported ${JSON.stringify(block.type)} content`);
		}));
	}))).flat();
	return {
		response: {
			contentItems,
			success: matched.block.isError !== true
		},
		steerInput
	};
}
//#endregion
//#region src/adapter.ts
/** Codex App Server implementation of the DeepSeek Harness LLM adapter API. */
/** Provider route registered in the existing DSH model catalog. */
const CODEX_APP_SERVER_PROVIDER = "codex-app-server";
/** Provider instructions that separate DSH dynamic tools from Codex host capabilities. */
const CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS = [
	"DeepSeek Harness owns tool selection, permission checks, execution, and durable tool logs.",
	"Use only tools in the dsh dynamic-tool namespace for shell, files, web, code changes, and other actions represented in the DSH tool catalog.",
	"Do not use built-in shell, apply_patch, web search, MCP, app, plugin, multi-agent, or view-image tools.",
	"The dsh skill tool loads only names listed in the DSH <available_skills> catalog included in the conversation; never use it to load Codex host skills or capabilities.",
	"For image creation or editing, use Codex host imagegen and native image generation directly; never call the dsh skill tool with the name imagegen."
].join(" ");
const WINDOWS_EXECUTABLE_ENV = "DSH_CODEX_APP_SERVER_EXECUTABLE";
var ActiveTurnQueue = class {
	values = [];
	waiters = [];
	terminal;
	push(event) {
		if (this.terminal !== void 0) {
			if (event.kind === "dynamic-tool") event.response.reject(this.terminal);
			return;
		}
		const waiter = this.waiters.shift();
		if (waiter === void 0) this.values.push(event);
		else waiter.resolve(event);
	}
	fail(error) {
		if (this.terminal !== void 0) return;
		this.terminal = error;
		for (const event of this.values.splice(0)) if (event.kind === "dynamic-tool") event.response.reject(error);
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}
	async next(signal) {
		signal.throwIfAborted();
		const value = this.values.shift();
		if (value !== void 0) return value;
		if (this.terminal !== void 0) throw this.terminal;
		const waiter = Promise.withResolvers();
		this.waiters.push(waiter);
		const onAbort = () => {
			waiter.reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await waiter.promise;
		} finally {
			signal.removeEventListener("abort", onAbort);
			const index = this.waiters.indexOf(waiter);
			if (index >= 0) this.waiters.splice(index, 1);
		}
	}
};
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
function recordValue(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
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
	const inputModalities = Array.isArray(raw.inputModalities) ? raw.inputModalities.filter((item) => item === "text" || item === "image") : ["text"];
	return {
		id: raw.id,
		name: typeof raw.displayName === "string" && raw.displayName.length > 0 ? raw.displayName : raw.id,
		...typeof raw.description === "string" && raw.description.length > 0 ? { description: raw.description } : {},
		...typeof raw.defaultReasoningEffort === "string" && raw.defaultReasoningEffort.length > 0 ? { defaultReasoningEffort: raw.defaultReasoningEffort } : {},
		supportedReasoningEfforts: efforts,
		inputModalities
	};
}
/** Local Codex App Server route with session-aware history, permissions, and process ownership. */
var CodexAppServerAdapter = class extends LlmAdapter {
	ctx;
	config;
	cachedModels;
	pendingModels;
	activeTurns = /* @__PURE__ */ new Map();
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
			inputModalities: model.inputModalities
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
			inputModalities: model.inputModalities,
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
		const unsupported = [
			options.temperature === void 0 ? void 0 : "temperature",
			options.maxTokens === void 0 ? void 0 : "maxTokens",
			options.stop === void 0 ? void 0 : "stop"
		].filter((value) => value !== void 0);
		if (unsupported.length > 0) throw new Error(`codex-plugin-dsh: App Server does not support DSH request field(s): ${unsupported.join(", ")}`);
		const session = this.ctx.sessions.get(options.sessionId);
		if (session === void 0) throw new Error(`codex-plugin-dsh: session ${JSON.stringify(options.sessionId)} is not live`);
		const cwd = session.header.cwd;
		if (cwd === void 0) throw new Error("codex-plugin-dsh: the selected DSH session has no working directory");
		const sessionId = String(options.sessionId);
		const requestedToolSignature = codexToolSignature(options.tools);
		let active = this.activeTurns.get(sessionId);
		if (active === void 0) active = await this.startTurn(options, sessionId, cwd);
		else {
			if (active.model !== options.model) throw new Error("codex-plugin-dsh: the model changed while an App Server dynamic tool call was pending");
			if (active.toolSignature !== requestedToolSignature) throw new Error("codex-plugin-dsh: the DSH tool catalog changed while an App Server dynamic tool call was pending");
			options.signal?.throwIfAborted();
			const pending = active.awaiting;
			if (pending === void 0) throw new Error("codex-plugin-dsh: an App Server turn is already active for this DSH session");
			const continuation = await codexDynamicToolResult(options.messages, pending.call.callId, active.resolveImageUrl);
			if (continuation.steerInput.length > 0) await active.connection.request("turn/steer", {
				threadId: active.threadId,
				expectedTurnId: active.turnId,
				input: continuation.steerInput
			}, active.signal);
			pending.response.resolve(continuation.response);
			delete active.awaiting;
			active.blocks.clear();
			active.nextBlockIndex = 0;
			active.finalOutput = false;
		}
		let keepAlive = false;
		try {
			for (;;) {
				const event = await active.events.next(active.signal);
				if (event.kind === "dynamic-tool") {
					const { call } = event;
					if (call.threadId !== active.threadId || call.turnId !== active.turnId) continue;
					if (active.awaiting !== void 0) throw new Error("codex-plugin-dsh: App Server issued another dynamic tool call before DSH returned the first result");
					if ([...active.blocks.values()].some((block) => !block.ended)) throw new Error("codex-plugin-dsh: App Server requested a dynamic tool with an open agent message");
					const argumentsText = JSON.stringify(call.arguments);
					if (argumentsText === void 0) throw new Error(`codex-plugin-dsh: App Server returned invalid arguments for DSH tool ${JSON.stringify(call.tool)}`);
					const index = active.nextBlockIndex++;
					const id = CallId(call.callId);
					yield {
						type: "block-start",
						index,
						blockType: "tool-call"
					};
					yield {
						type: "tool-call-delta",
						index,
						id,
						name: call.tool,
						argumentsDelta: argumentsText
					};
					yield {
						type: "block-end",
						index,
						block: {
							type: "tool-call",
							id,
							name: call.tool,
							arguments: argumentsText
						}
					};
					active.awaiting = event;
					active.blocks.clear();
					active.nextBlockIndex = 0;
					active.finalOutput = false;
					keepAlive = true;
					yield {
						type: "finish",
						reason: { kind: "tool-calls" }
					};
					return;
				}
				const { method, params } = event.notification;
				if (params.threadId !== active.threadId) continue;
				if ((method === "turn/completed" ? object(params.turn, "turn/completed turn").id : params.turnId) !== active.turnId) continue;
				if (method === "item/started") {
					const item = object(params.item, "started item");
					if (item.type !== "agentMessage") continue;
					const itemId = string(item.id, "agent message item id");
					if (active.blocks.has(itemId)) continue;
					const phase = phaseOf(item.phase);
					const block = {
						index: active.nextBlockIndex++,
						type: blockType(phase),
						phase,
						text: "",
						ended: false
					};
					active.blocks.set(itemId, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: block.type
					};
					continue;
				}
				if (method === "item/agentMessage/delta") {
					const itemId = string(params.itemId, "agent message delta item id");
					let block = active.blocks.get(itemId);
					if (block === void 0) {
						block = {
							index: active.nextBlockIndex++,
							type: "text",
							phase: null,
							text: "",
							ended: false
						};
						active.blocks.set(itemId, block);
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
					if (item.type === "imageGeneration") {
						const itemId = string(item.id, "image generation item id");
						if (active.completedImages.has(itemId)) continue;
						active.completedImages.add(itemId);
						const image = await generatedImageBlock(this.ctx.attachments, item);
						if (image === void 0) continue;
						const index = active.nextBlockIndex++;
						yield {
							type: "block-start",
							index,
							blockType: "image"
						};
						yield {
							type: "block-end",
							index,
							block: image
						};
						active.finalOutput = true;
						continue;
					}
					if (item.type !== "agentMessage") continue;
					const itemId = string(item.id, "completed agent message item id");
					const phase = phaseOf(item.phase);
					let block = active.blocks.get(itemId);
					if (block === void 0) {
						block = {
							index: active.nextBlockIndex++,
							type: blockType(phase),
							phase,
							text: "",
							ended: false
						};
						active.blocks.set(itemId, block);
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
						if (block.phase !== "commentary" && block.text.trim().length > 0) active.finalOutput = true;
					}
					continue;
				}
				if (method === "thread/tokenUsage/updated") {
					active.usage = usageFrom(params.tokenUsage);
					continue;
				}
				if (method === "error" && params.willRetry !== true) throw new LlmError(messageText(params.error), "CODEX_APP_SERVER");
				if (method !== "turn/completed") continue;
				const completedTurn = object(params.turn, "turn/completed turn");
				if (contextWindowExceeded(completedTurn)) {
					if (active.usage !== void 0) yield {
						type: "usage",
						usage: active.usage
					};
					yield {
						type: "finish",
						reason: { kind: "max-tokens" },
						replayState: active.replayState
					};
					return;
				}
				if (completedTurn.status !== "completed") throw turnFailure(completedTurn);
				if ([...active.blocks.values()].some((block) => !block.ended)) throw new Error("codex-plugin-dsh: App Server completed with an open agent message");
				if (!active.finalOutput) throw new Error("codex-plugin-dsh: App Server completed without a final answer or image");
				if (active.usage !== void 0) yield {
					type: "usage",
					usage: active.usage
				};
				yield {
					type: "finish",
					reason: { kind: "stop" },
					replayState: active.replayState
				};
				return;
			}
		} finally {
			if (!keepAlive) await this.closeTurn(active);
		}
	}
	async startTurn(options, sessionId, cwd) {
		const signal = combinedSignal(options.signal, this.config.turnTimeoutMs);
		const imageUrls = /* @__PURE__ */ new Map();
		const resolveImageUrl = (attachment) => {
			const key = String(attachment.attachmentId);
			const existing = imageUrls.get(key);
			if (existing !== void 0) return existing;
			const pending = attachmentDataUrl(this.ctx.attachments, attachment, signal);
			imageUrls.set(key, pending);
			return pending;
		};
		let history = await prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER, resolveImageUrl);
		const toolSignature = codexToolSignature(options.tools);
		if (history.checkpoint !== void 0 && history.checkpoint.toolSignature !== toolSignature) history = await prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER, resolveImageUrl, true);
		const availableTools = new Set((options.tools ?? []).map((tool) => tool.name));
		const events = new ActiveTurnQueue();
		let threadId;
		let turnId;
		let connection;
		const observer = {
			notification: (notification) => {
				events.push({
					kind: "notification",
					notification
				});
			},
			failure: (error) => {
				events.fail(error);
			}
		};
		try {
			connection = await this.openConnection(cwd, signal, (method, params) => {
				if (method !== "item/tool/call") return this.handleServerRequest(method, params);
				const response = Promise.withResolvers();
				events.push({
					kind: "dynamic-tool",
					call: codexDynamicToolCall(params, availableTools),
					response
				});
				return response.promise;
			}, observer);
			await connection.initialize(signal);
			const isolationConfig = await this.isolationConfig(connection, signal);
			const dynamicTools = history.checkpoint?.toolSignature === toolSignature ? void 0 : codexDynamicTools(options.tools);
			threadId = string(object((history.checkpoint === void 0 ? await connection.request("thread/start", this.threadParams(options, cwd, isolationConfig, dynamicTools ?? []), signal) : await connection.request("thread/fork", {
				...this.threadParams(options, cwd, isolationConfig),
				threadId: history.checkpoint.threadId,
				lastTurnId: history.checkpoint.turnId
			}, signal)).thread, "thread result").id, "thread id");
			if (history.injectItems.length > 0) await connection.request("thread/inject_items", {
				threadId,
				items: history.injectItems
			}, signal);
			turnId = string(object((await connection.request("turn/start", {
				threadId,
				input: history.turnInput,
				model: options.model,
				...options.reasoningEffort === void 0 ? {} : { effort: options.reasoningEffort }
			}, signal)).turn, "turn/start turn").id, "turn id");
			let active;
			active = {
				sessionId,
				model: options.model,
				toolSignature,
				connection,
				events,
				signal,
				threadId,
				turnId,
				replayState: {
					kind: "codex-app-server",
					version: 1,
					threadId,
					turnId,
					sessionId,
					toolSignature
				},
				resolveImageUrl,
				onAbort: () => {
					connection?.interrupt(threadId, turnId);
					this.closeTurn(active);
				},
				blocks: /* @__PURE__ */ new Map(),
				completedImages: /* @__PURE__ */ new Set(),
				nextBlockIndex: 0,
				finalOutput: false
			};
			signal.addEventListener("abort", active.onAbort, { once: true });
			this.activeTurns.set(active.sessionId, active);
			return active;
		} catch (error) {
			events.fail(thrown(error));
			await connection?.close();
			throw error;
		}
	}
	async closeTurn(active) {
		if (active.closing !== void 0) return active.closing;
		const closing = this.finishCloseTurn(active);
		active.closing = closing;
		return closing;
	}
	async finishCloseTurn(active) {
		if (this.activeTurns.get(active.sessionId) === active) this.activeTurns.delete(active.sessionId);
		active.signal.removeEventListener("abort", active.onAbort);
		const closed = /* @__PURE__ */ new Error("codex-plugin-dsh: App Server turn closed before a pending DSH tool result was returned");
		active.awaiting?.response.reject(closed);
		active.events.fail(closed);
		await active.connection.close();
	}
	/** Close an unfinished App Server turn after the owning DSH turn ends. */
	closeSession(sessionId) {
		const active = this.activeTurns.get(sessionId);
		if (active !== void 0) this.closeTurn(active);
	}
	/** Dispose every App Server process retained across DSH tool execution. */
	async dispose() {
		await Promise.all([...this.activeTurns.values()].map((active) => this.closeTurn(active)));
	}
	threadParams(options, cwd, isolationConfig, dynamicTools) {
		return {
			cwd,
			model: options.model,
			approvalPolicy: "never",
			sandbox: "read-only",
			config: isolationConfig,
			ephemeral: false,
			...options.system === void 0 ? {} : { baseInstructions: options.system },
			developerInstructions: CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS,
			...dynamicTools === void 0 ? {} : { dynamicTools }
		};
	}
	async isolationConfig(connection, signal) {
		const current = recordValue((await connection.request("config/read", { includeLayers: false }, signal)).config);
		const disabledMcpServers = Object.fromEntries(Object.keys(recordValue(current.mcp_servers)).map((name) => [name, { enabled: false }]));
		return {
			features: {
				shell_tool: false,
				unified_exec: false,
				multi_agent: false,
				plugins: false
			},
			agents: { enabled: false },
			web_search: "disabled",
			tools: { view_image: false },
			apps: {
				_default: { enabled: false },
				...Object.fromEntries(Object.keys(recordValue(current.apps)).filter((name) => name !== "_default").map((name) => [name, { enabled: false }]))
			},
			mcp_servers: disabledMcpServers
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
	async openConnection(cwd, signal, requestHandler, observer) {
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
		}), requestHandler, observer);
	}
	async handleServerRequest(method, params) {
		switch (method) {
			case "item/commandExecution/requestApproval":
			case "item/fileChange/requestApproval": return { decision: deniedDecision(params, false) };
			case "item/permissions/requestApproval": return {
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
	"attachments"
];
const Config = z.object({
	executable: z.string().default("codex"),
	env: z.dict(z.string()).default({}),
	modelCacheMs: z.number().default(3e4),
	catalogTimeoutMs: z.number().default(1e4),
	turnTimeoutMs: z.number().default(6e5),
	disposeGraceMs: z.number().default(3e3),
	stderrMaxBytes: z.number().default(16384),
	modelPageSize: z.number().default(100)
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
		modelPageSize: resolved.modelPageSize
	};
}
/** Register the adapter inside the existing DSH provider and session lifecycles. */
function apply(ctx, config) {
	const adapter = new CodexAppServerAdapter(ctx, resolvedConfig(config));
	ctx.llm.registerAdapter([CODEX_APP_SERVER_PROVIDER], adapter);
	ctx.on("session/event", (session, event) => {
		if (event.type === "turn/end") adapter.closeSession(String(session.header.id));
	});
	ctx.effect(() => () => adapter.dispose(), "codex-plugin-dsh: close active App Server turns");
}
//#endregion
export { CODEX_APP_SERVER_PROVIDER, CodexAppServerAdapter, Config, apply, inject, name };
