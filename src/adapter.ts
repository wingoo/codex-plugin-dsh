/** Codex App Server implementation of the DeepSeek Harness LLM adapter API. */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodexAppServerConnection, type AppServerNotification } from './app-server.ts'
import { prepareCodexHistory, type CodexReplayState } from './history.ts'
import { object, optionalString, string, thrown } from './validation.ts'

/** Provider route registered in the existing DSH model catalog. */
export const CODEX_APP_SERVER_PROVIDER = 'codex-app-server'

const WINDOWS_EXECUTABLE_ENV = 'DSH_CODEX_APP_SERVER_EXECUTABLE'

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
type ApprovalPolicy = 'ask' | 'never'

/** Resolved process and timeout configuration owned by the plugin deployment. */
export interface AdapterConfig {
  readonly executable: string
  readonly env: Record<string, string>
  readonly modelCacheMs: number
  readonly catalogTimeoutMs: number
  readonly turnTimeoutMs: number
  readonly disposeGraceMs: number
  readonly stderrMaxBytes: number
  readonly modelPageSize: number
  readonly fallbackSandbox: SandboxMode
}

interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly defaultReasoningEffort?: string
  readonly supportedReasoningEfforts: readonly {
    readonly id: string
    readonly description?: string
  }[]
}

interface ActiveBlock {
  readonly index: number
  type: 'text' | 'reasoning'
  phase: 'commentary' | 'final_answer' | null
  text: string
  ended: boolean
}

/** Process invocation for one resolved Codex executable. */
export interface CodexAppServerInvocation {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * Build the fixed App Server command without allowing configured text into a Windows command tail.
 * @param executable - Absolute executable path resolved by the DSH subprocess provider.
 * @param env - Explicit child environment from plugin configuration.
 * @param platform - Host platform selecting the Windows batch-shim path.
 * @param commandInterpreter - Resolved Windows command interpreter.
 * @returns Child argv and environment for the managed subprocess.
 */
export function codexAppServerInvocation(
  executable: string,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
  commandInterpreter = 'cmd.exe',
): CodexAppServerInvocation {
  const extension = extname(executable).toLowerCase()
  if (platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return { argv: [executable, 'app-server', '--stdio'], env }
  }
  return {
    argv: [
      commandInterpreter,
      '/d',
      '/v:off',
      '/s',
      '/c',
      `%${WINDOWS_EXECUTABLE_ENV}%`,
      'app-server',
      '--stdio',
    ],
    env: { ...env, [WINDOWS_EXECUTABLE_ENV]: `"${executable}"` },
  }
}

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout])
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`codex-plugin-dsh: operation aborted: ${String(signal.reason)}`)
}

async function nextNotification(
  iterator: AsyncIterator<AppServerNotification>,
  signal: AbortSignal,
): Promise<IteratorResult<AppServerNotification>> {
  signal.throwIfAborted()
  const pending = iterator.next()
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function phaseOf(value: unknown): ActiveBlock['phase'] {
  if (value === undefined || value === null) return null
  if (value === 'commentary' || value === 'final_answer') return value
  throw new Error(`codex-plugin-dsh: App Server returned unknown agent message phase ${JSON.stringify(value)}`)
}

function blockType(phase: ActiveBlock['phase']): ActiveBlock['type'] {
  return phase === 'commentary' ? 'reasoning' : 'text'
}

function messageText(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return String(value)
  const message = (value as Record<string, unknown>).message
  return typeof message === 'string' ? message : JSON.stringify(value)
}

function turnFailure(turn: Record<string, unknown>): Error {
  const error = turn.error
  const detail = error === undefined || error === null ? '' : `: ${messageText(error)}`
  return new LlmError(`Codex App Server turn ended with status ${String(turn.status)}${detail}`, 'CODEX_APP_SERVER')
}

function contextWindowExceeded(turn: Record<string, unknown>): boolean {
  if (turn.status !== 'failed' || turn.error === null || typeof turn.error !== 'object' || Array.isArray(turn.error)) return false
  return (turn.error as Record<string, unknown>).codexErrorInfo === 'contextWindowExceeded'
}

function usageFrom(value: unknown): TokenUsage {
  const tokenUsage = object(value, 'token usage')
  const last = object(tokenUsage.last, 'last-turn token usage')
  const integer = (field: string): number => {
    const count = last[field]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`codex-plugin-dsh: App Server returned invalid ${field}`)
    }
    return count
  }
  const input = integer('inputTokens')
  const cached = integer('cachedInputTokens')
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: integer('outputTokens'),
    cacheReadTokens: cached,
    reasoningTokens: integer('reasoningOutputTokens'),
  }
}

function availableDecisions(params: Record<string, unknown>): ReadonlySet<string> | undefined {
  if (!Array.isArray(params.availableDecisions)) return undefined
  return new Set(params.availableDecisions.filter((value): value is string => typeof value === 'string'))
}

function deniedDecision(params: Record<string, unknown>, cancelled: boolean): 'cancel' | 'decline' {
  const available = availableDecisions(params)
  if (cancelled && (available === undefined || available.has('cancel'))) return 'cancel'
  if (available === undefined || available.has('decline')) return 'decline'
  if (available.has('cancel')) return 'cancel'
  throw new Error('codex-plugin-dsh: App Server offered no fail-closed approval decision')
}

function approvalReason(method: string, params: Record<string, unknown>): string {
  const facts = [
    optionalString(params.reason),
    optionalString(params.command),
    optionalString(params.cwd),
  ].filter((value): value is string => value !== undefined && value.length > 0)
  return facts.length === 0 ? `Codex App Server requested ${method}` : facts.join('\n')
}

function catalogModel(value: unknown): CatalogModel | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.hidden === true) return undefined
  const efforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts.flatMap((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
        const effort = item as Record<string, unknown>
        if (typeof effort.reasoningEffort !== 'string' || effort.reasoningEffort.length === 0) return []
        return [{
          id: effort.reasoningEffort,
          ...typeof effort.description === 'string' && effort.description.length > 0
            ? { description: effort.description }
            : {},
        }]
      })
    : []
  return {
    id: raw.id,
    name: typeof raw.displayName === 'string' && raw.displayName.length > 0 ? raw.displayName : raw.id,
    ...typeof raw.description === 'string' && raw.description.length > 0 ? { description: raw.description } : {},
    ...typeof raw.defaultReasoningEffort === 'string' && raw.defaultReasoningEffort.length > 0
      ? { defaultReasoningEffort: raw.defaultReasoningEffort }
      : {},
    supportedReasoningEfforts: efforts,
  }
}

/** Local Codex App Server route with session-aware history, permissions, and process ownership. */
export class CodexAppServerAdapter extends LlmAdapter {
  private cachedModels: { readonly expiresAt: number; readonly models: readonly CatalogModel[] } | undefined
  private pendingModels: Promise<readonly CatalogModel[]> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: AdapterConfig,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Codex App Server (local)' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (await this.models()).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      // The App Server accepts images, but this adapter cannot yet resolve DSH attachment refs to local paths.
      inputModalities: ['text'],
    }))
  }

  override async resolveModel(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const model = (await this.models(signal)).find(candidate => candidate.id === modelId)
    if (model === undefined) return { provider, id: modelId, name: modelId, inputModalities: ['text'] }
    return {
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: ['text'],
      ...model.supportedReasoningEfforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: model.supportedReasoningEfforts.map(effort => ({
                id: ReasoningEffortId(effort.id),
                name: effort.id,
                ...effort.description === undefined ? {} : { description: effort.description },
              })),
              ...model.defaultReasoningEffort === undefined
                ? {}
                : { defaultEffort: ReasoningEffortId(model.defaultReasoningEffort) },
            },
          },
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== CODEX_APP_SERVER_PROVIDER) {
      throw new Error(`codex-plugin-dsh: unexpected provider ${JSON.stringify(options.provider)}`)
    }
    if (options.sessionId === undefined) {
      throw new Error('codex-plugin-dsh: Codex App Server calls require a live DSH session')
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      throw new Error('codex-plugin-dsh: DSH tool schemas reached App Server; the provider isolation listener is not active')
    }
    const unsupported = [
      options.temperature === undefined ? undefined : 'temperature',
      options.maxTokens === undefined ? undefined : 'maxTokens',
      options.stop === undefined ? undefined : 'stop',
    ].filter((value): value is string => value !== undefined)
    if (unsupported.length > 0) {
      throw new Error(`codex-plugin-dsh: App Server does not support DSH request field(s): ${unsupported.join(', ')}`)
    }
    const session = this.ctx.sessions.get(options.sessionId)
    const agent = this.ctx.agents.get(options.sessionId)
    if (session === undefined || agent === undefined) {
      throw new Error(`codex-plugin-dsh: session ${JSON.stringify(options.sessionId)} is not live`)
    }
    const cwd = session.header.cwd
    if (cwd === undefined) {
      throw new Error('codex-plugin-dsh: the selected DSH session has no working directory')
    }
    const history = prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER)
    const signal = combinedSignal(options.signal, this.config.turnTimeoutMs)
    const sandbox = (effectiveSandboxMode(session.events) ?? this.config.fallbackSandbox) as SandboxMode
    const approval = (effectiveApprovalPolicy(session.events) ?? this.ctx.approval.config.policy ?? 'ask') as ApprovalPolicy
    let activeThreadId: string | undefined
    let activeTurnId: string | undefined
    const connection = await this.openConnection(
      cwd,
      signal,
      (method, params) => this.handleServerRequest(agent, signal, method, params),
    )
    const onAbort = (): void => {
      if (activeThreadId !== undefined && activeTurnId !== undefined) {
        connection.interrupt(activeThreadId, activeTurnId)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await connection.initialize(signal)
      const threadResult = history.checkpoint === undefined
        ? await connection.request('thread/start', this.threadParams(options, cwd, sandbox, approval), signal)
        : await connection.request('thread/fork', {
            ...this.threadParams(options, cwd, sandbox, approval),
            threadId: history.checkpoint.threadId,
            lastTurnId: history.checkpoint.turnId,
          }, signal)
      const thread = object(threadResult.thread, 'thread result')
      activeThreadId = string(thread.id, 'thread id')
      if (history.injectItems.length > 0) {
        await connection.request('thread/inject_items', {
          threadId: activeThreadId,
          items: history.injectItems,
        }, signal)
      }
      const turnResult = await connection.request('turn/start', {
        threadId: activeThreadId,
        input: history.turnInput,
        model: options.model,
        ...options.reasoningEffort === undefined ? {} : { effort: options.reasoningEffort },
      }, signal)
      const turn = object(turnResult.turn, 'turn/start turn')
      activeTurnId = string(turn.id, 'turn id')
      const replayState: CodexReplayState = {
        kind: 'codex-app-server',
        version: 1,
        threadId: activeThreadId,
        turnId: activeTurnId,
        sessionId: options.sessionId,
      }
      const blocks = new Map<string, ActiveBlock>()
      let nextBlockIndex = 0
      let finalText = false
      let usage: TokenUsage | undefined
      const iterator = connection.notifications()[Symbol.asyncIterator]()
      for (;;) {
        const next = await nextNotification(iterator, signal)
        if (next.done) throw new Error('codex-plugin-dsh: App Server closed before turn/completed')
        const { method, params } = next.value
        if (params.threadId !== activeThreadId) continue
        const notificationTurnId = method === 'turn/completed'
          ? object(params.turn, 'turn/completed turn').id
          : params.turnId
        if (notificationTurnId !== activeTurnId) continue
        if (method === 'item/started') {
          const item = object(params.item, 'started item')
          if (item.type !== 'agentMessage') continue
          const itemId = string(item.id, 'agent message item id')
          if (blocks.has(itemId)) continue
          const phase = phaseOf(item.phase)
          const block: ActiveBlock = {
            index: nextBlockIndex++,
            type: blockType(phase),
            phase,
            text: '',
            ended: false,
          }
          blocks.set(itemId, block)
          yield { type: 'block-start', index: block.index, blockType: block.type }
          continue
        }
        if (method === 'item/agentMessage/delta') {
          const itemId = string(params.itemId, 'agent message delta item id')
          let block = blocks.get(itemId)
          if (block === undefined) {
            block = { index: nextBlockIndex++, type: 'text', phase: null, text: '', ended: false }
            blocks.set(itemId, block)
            yield { type: 'block-start', index: block.index, blockType: block.type }
          }
          if (block.ended) throw new Error('codex-plugin-dsh: App Server emitted a delta after item/completed')
          const delta = typeof params.delta === 'string' ? params.delta : ''
          block.text += delta
          if (block.type === 'reasoning') yield { type: 'reasoning-delta', index: block.index, text: delta }
          else yield { type: 'text-delta', index: block.index, text: delta }
          continue
        }
        if (method === 'item/completed') {
          const item = object(params.item, 'completed item')
          if (item.type !== 'agentMessage') continue
          const itemId = string(item.id, 'completed agent message item id')
          const phase = phaseOf(item.phase)
          let block = blocks.get(itemId)
          if (block === undefined) {
            block = { index: nextBlockIndex++, type: blockType(phase), phase, text: '', ended: false }
            blocks.set(itemId, block)
            yield { type: 'block-start', index: block.index, blockType: block.type }
          }
          const completedText = typeof item.text === 'string' ? item.text : ''
          if (!completedText.startsWith(block.text)) {
            throw new Error('codex-plugin-dsh: completed agent message did not match its streamed deltas')
          }
          const tail = completedText.slice(block.text.length)
          if (tail.length > 0) {
            if (block.type === 'reasoning') yield { type: 'reasoning-delta', index: block.index, text: tail }
            else yield { type: 'text-delta', index: block.index, text: tail }
            block.text = completedText
          }
          block.ended = true
          if (block.type === 'reasoning') {
            yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
          } else {
            yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
            if (block.phase !== 'commentary' && block.text.trim().length > 0) finalText = true
          }
          continue
        }
        if (method === 'thread/tokenUsage/updated') {
          usage = usageFrom(params.tokenUsage)
          continue
        }
        if (method === 'error' && params.willRetry !== true) {
          throw new LlmError(messageText(params.error), 'CODEX_APP_SERVER')
        }
        if (method !== 'turn/completed') continue
        const completedTurn = object(params.turn, 'turn/completed turn')
        if (contextWindowExceeded(completedTurn)) {
          if (usage !== undefined) yield { type: 'usage', usage }
          yield { type: 'finish', reason: { kind: 'max-tokens' }, replayState }
          return
        }
        if (completedTurn.status !== 'completed') throw turnFailure(completedTurn)
        if ([...blocks.values()].some(block => !block.ended)) {
          throw new Error('codex-plugin-dsh: App Server completed with an open agent message')
        }
        if (!finalText) throw new Error('codex-plugin-dsh: App Server completed without a final answer')
        if (usage !== undefined) yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'stop' }, replayState }
        return
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await connection.close()
    }
  }

  private threadParams(
    options: GenerateOptions,
    cwd: string,
    sandbox: SandboxMode,
    approval: ApprovalPolicy,
  ): Record<string, unknown> {
    return {
      cwd,
      model: options.model,
      approvalPolicy: approval === 'never' ? 'never' : 'on-request',
      sandbox,
      ephemeral: false,
      ...options.system === undefined ? {} : { baseInstructions: options.system },
    }
  }

  private async models(parentSignal?: AbortSignal): Promise<readonly CatalogModel[]> {
    if (this.cachedModels !== undefined && this.cachedModels.expiresAt > Date.now()) return this.cachedModels.models
    if (this.pendingModels !== undefined) return this.pendingModels
    const signal = combinedSignal(parentSignal, this.config.catalogTimeoutMs)
    const pending = this.loadModels(signal)
    this.pendingModels = pending
    try {
      const models = await pending
      this.cachedModels = { expiresAt: Date.now() + this.config.modelCacheMs, models }
      return models
    } finally {
      if (this.pendingModels === pending) this.pendingModels = undefined
    }
  }

  private async loadModels(signal: AbortSignal): Promise<readonly CatalogModel[]> {
    const connection = await this.openConnection(process.cwd(), signal, (method) =>
      Promise.reject(new Error(`codex-plugin-dsh: unexpected App Server request during model discovery: ${method}`)))
    try {
      await connection.initialize(signal)
      const accountResult = await connection.request('account/read', { refreshToken: false }, signal)
      if (accountResult.requiresOpenaiAuth === true && accountResult.account == null) {
        throw new LlmError('Codex login is required; run `codex login` on the DSH host', 'AUTH')
      }
      const models: CatalogModel[] = []
      let cursor: string | null = null
      do {
        const result = await connection.request('model/list', {
          cursor,
          includeHidden: false,
          limit: this.config.modelPageSize,
        }, signal)
        if (!Array.isArray(result.data)) throw new Error('codex-plugin-dsh: App Server returned invalid model list')
        models.push(...result.data.flatMap(value => {
          const parsed = catalogModel(value)
          return parsed === undefined ? [] : [parsed]
        }))
        cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null
      } while (cursor !== null)
      if (models.length === 0) throw new Error('codex-plugin-dsh: App Server returned no available models')
      return models
    } finally {
      await connection.close()
    }
  }

  private async openConnection(
    cwd: string,
    signal: AbortSignal,
    requestHandler: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ): Promise<CodexAppServerConnection> {
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.executable, this.config.env, signal)
    const batchShim = process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase())
    const commandInterpreter = batchShim
      ? await this.ctx.subprocess.resolveExecutable('cmd.exe', this.config.env, signal)
      : undefined
    const invocation = codexAppServerInvocation(executable, this.config.env, process.platform, commandInterpreter)
    const child: SubprocessHandle = this.ctx.subprocess.spawn({
      argv: [...invocation.argv],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: this.config.stderrMaxBytes },
      },
      graceMs: this.config.disposeGraceMs,
      env: invocation.env,
    })
    return new CodexAppServerConnection(child, requestHandler)
  }

  private async handleServerRequest(
    agent: Agent,
    signal: AbortSignal,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': {
        const outcome = await this.ctx.approval.request({
          agent,
          toolName: method === 'item/commandExecution/requestApproval' ? 'codex:command' : 'codex:file-change',
          reason: approvalReason(method, params),
          signal,
        })
        if (outcome === 'allowed-once') {
          const available = availableDecisions(params)
          if (available !== undefined && !available.has('accept')) {
            return { decision: deniedDecision(params, false) }
          }
          return { decision: 'accept' }
        }
        return { decision: deniedDecision(params, outcome === 'cancelled') }
      }
      case 'item/permissions/requestApproval': {
        const outcome = await this.ctx.approval.request({
          agent,
          toolName: 'codex:permissions',
          reason: approvalReason(method, params),
          signal,
        })
        return outcome === 'allowed-once'
          ? { permissions: object(params.permissions, 'requested permissions'), scope: 'turn' }
          : { permissions: {}, scope: 'turn' }
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null }
      case 'item/tool/requestUserInput':
        throw new Error('codex-plugin-dsh: App Server requested interactive user input, which this adapter does not yet bridge')
      default:
        throw new Error(`codex-plugin-dsh: unsupported App Server request ${JSON.stringify(method)}`)
    }
  }
}
