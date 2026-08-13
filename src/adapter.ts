/** Codex App Server implementation of the DeepSeek Harness LLM adapter API. */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  CallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  CodexAppServerConnection,
  type AppServerConnectionObserver,
  type AppServerNotification,
} from './app-server.ts'
import { prepareCodexHistory, type CodexReplayState } from './history.ts'
import { attachmentDataUrl, generatedImageBlock } from './images.ts'
import {
  codexDynamicToolCall,
  codexDynamicToolResult,
  codexDynamicTools,
  codexToolSignature,
  type CodexDynamicToolCall,
  type CodexToolImageUrlResolver,
} from './tools.ts'
import { object, string, thrown } from './validation.ts'

/** Provider route registered in the existing DSH model catalog. */
export const CODEX_APP_SERVER_PROVIDER = 'codex-app-server'

const WINDOWS_EXECUTABLE_ENV = 'DSH_CODEX_APP_SERVER_EXECUTABLE'

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
  readonly inputModalities: readonly ModelModality[]
}

interface ActiveBlock {
  readonly index: number
  type: 'text' | 'reasoning'
  phase: 'commentary' | 'final_answer' | null
  text: string
  ended: boolean
}

interface PendingDynamicToolCall {
  readonly call: CodexDynamicToolCall
  readonly response: PromiseWithResolvers<unknown>
}

type ActiveTurnEvent =
  | { readonly kind: 'notification'; readonly notification: AppServerNotification }
  | ({ readonly kind: 'dynamic-tool' } & PendingDynamicToolCall)

class ActiveTurnQueue {
  private readonly values: ActiveTurnEvent[] = []
  private readonly waiters: Array<PromiseWithResolvers<ActiveTurnEvent>> = []
  private terminal: Error | undefined

  push(event: ActiveTurnEvent): void {
    if (this.terminal !== undefined) {
      if (event.kind === 'dynamic-tool') event.response.reject(this.terminal)
      return
    }
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(event)
    else waiter.resolve(event)
  }

  fail(error: Error): void {
    if (this.terminal !== undefined) return
    this.terminal = error
    for (const event of this.values.splice(0)) {
      if (event.kind === 'dynamic-tool') event.response.reject(error)
    }
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  async next(signal: AbortSignal): Promise<ActiveTurnEvent> {
    signal.throwIfAborted()
    const value = this.values.shift()
    if (value !== undefined) return value
    if (this.terminal !== undefined) throw this.terminal
    const waiter = Promise.withResolvers<ActiveTurnEvent>()
    this.waiters.push(waiter)
    const onAbort = (): void => { waiter.reject(abortError(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await waiter.promise
    } finally {
      signal.removeEventListener('abort', onAbort)
      const index = this.waiters.indexOf(waiter)
      if (index >= 0) this.waiters.splice(index, 1)
    }
  }
}

interface ActiveCodexTurn {
  readonly sessionId: string
  readonly model: string
  readonly toolSignature: string
  readonly connection: CodexAppServerConnection
  readonly events: ActiveTurnQueue
  readonly signal: AbortSignal
  readonly threadId: string
  readonly turnId: string
  readonly replayState: CodexReplayState
  readonly resolveImageUrl: CodexToolImageUrlResolver
  readonly onAbort: () => void
  readonly blocks: Map<string, ActiveBlock>
  readonly completedImages: Set<string>
  nextBlockIndex: number
  finalOutput: boolean
  usage?: TokenUsage
  awaiting?: PendingDynamicToolCall
  closing?: Promise<void>
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

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
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
  const inputModalities = Array.isArray(raw.inputModalities)
    ? raw.inputModalities.filter((item): item is ModelModality => item === 'text' || item === 'image')
    : ['text'] as const
  return {
    id: raw.id,
    name: typeof raw.displayName === 'string' && raw.displayName.length > 0 ? raw.displayName : raw.id,
    ...typeof raw.description === 'string' && raw.description.length > 0 ? { description: raw.description } : {},
    ...typeof raw.defaultReasoningEffort === 'string' && raw.defaultReasoningEffort.length > 0
      ? { defaultReasoningEffort: raw.defaultReasoningEffort }
      : {},
    supportedReasoningEfforts: efforts,
    inputModalities,
  }
}

/** Local Codex App Server route with session-aware history, permissions, and process ownership. */
export class CodexAppServerAdapter extends LlmAdapter {
  private cachedModels: { readonly expiresAt: number; readonly models: readonly CatalogModel[] } | undefined
  private pendingModels: Promise<readonly CatalogModel[]> | undefined
  private readonly activeTurns = new Map<string, ActiveCodexTurn>()

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
      inputModalities: model.inputModalities,
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
      inputModalities: model.inputModalities,
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
    const unsupported = [
      options.temperature === undefined ? undefined : 'temperature',
      options.maxTokens === undefined ? undefined : 'maxTokens',
      options.stop === undefined ? undefined : 'stop',
    ].filter((value): value is string => value !== undefined)
    if (unsupported.length > 0) {
      throw new Error(`codex-plugin-dsh: App Server does not support DSH request field(s): ${unsupported.join(', ')}`)
    }
    const session = this.ctx.sessions.get(options.sessionId)
    if (session === undefined) {
      throw new Error(`codex-plugin-dsh: session ${JSON.stringify(options.sessionId)} is not live`)
    }
    const cwd = session.header.cwd
    if (cwd === undefined) {
      throw new Error('codex-plugin-dsh: the selected DSH session has no working directory')
    }
    const sessionId = String(options.sessionId)
    const requestedToolSignature = codexToolSignature(options.tools)
    let active = this.activeTurns.get(sessionId)
    if (active === undefined) {
      active = await this.startTurn(options, sessionId, cwd)
    } else {
      if (active.model !== options.model) {
        throw new Error('codex-plugin-dsh: the model changed while an App Server dynamic tool call was pending')
      }
      if (active.toolSignature !== requestedToolSignature) {
        throw new Error('codex-plugin-dsh: the DSH tool catalog changed while an App Server dynamic tool call was pending')
      }
      options.signal?.throwIfAborted()
      const pending = active.awaiting
      if (pending === undefined) {
        throw new Error('codex-plugin-dsh: an App Server turn is already active for this DSH session')
      }
      const continuation = await codexDynamicToolResult(
        options.messages,
        pending.call.callId,
        active.resolveImageUrl,
      )
      if (continuation.steerInput.length > 0) {
        await active.connection.request('turn/steer', {
          threadId: active.threadId,
          expectedTurnId: active.turnId,
          input: continuation.steerInput,
        }, active.signal)
      }
      pending.response.resolve(continuation.response)
      delete active.awaiting
      active.blocks.clear()
      active.nextBlockIndex = 0
      active.finalOutput = false
    }
    let keepAlive = false
    try {
      for (;;) {
        const event = await active.events.next(active.signal)
        if (event.kind === 'dynamic-tool') {
          const { call } = event
          if (call.threadId !== active.threadId || call.turnId !== active.turnId) continue
          if (active.awaiting !== undefined) {
            throw new Error('codex-plugin-dsh: App Server issued another dynamic tool call before DSH returned the first result')
          }
          if ([...active.blocks.values()].some(block => !block.ended)) {
            throw new Error('codex-plugin-dsh: App Server requested a dynamic tool with an open agent message')
          }
          const argumentsText = JSON.stringify(call.arguments)
          if (argumentsText === undefined) {
            throw new Error(`codex-plugin-dsh: App Server returned invalid arguments for DSH tool ${JSON.stringify(call.tool)}`)
          }
          const index = active.nextBlockIndex++
          const id = CallId(call.callId)
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: call.tool, argumentsDelta: argumentsText }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.tool, arguments: argumentsText } }
          active.awaiting = event
          active.blocks.clear()
          active.nextBlockIndex = 0
          active.finalOutput = false
          keepAlive = true
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const { method, params } = event.notification
        if (params.threadId !== active.threadId) continue
        const notificationTurnId = method === 'turn/completed'
          ? object(params.turn, 'turn/completed turn').id
          : params.turnId
        if (notificationTurnId !== active.turnId) continue
        if (method === 'item/started') {
          const item = object(params.item, 'started item')
          if (item.type !== 'agentMessage') continue
          const itemId = string(item.id, 'agent message item id')
          if (active.blocks.has(itemId)) continue
          const phase = phaseOf(item.phase)
          const block: ActiveBlock = {
            index: active.nextBlockIndex++,
            type: blockType(phase),
            phase,
            text: '',
            ended: false,
          }
          active.blocks.set(itemId, block)
          yield { type: 'block-start', index: block.index, blockType: block.type }
          continue
        }
        if (method === 'item/agentMessage/delta') {
          const itemId = string(params.itemId, 'agent message delta item id')
          let block = active.blocks.get(itemId)
          if (block === undefined) {
            block = { index: active.nextBlockIndex++, type: 'text', phase: null, text: '', ended: false }
            active.blocks.set(itemId, block)
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
          if (item.type === 'imageGeneration') {
            const itemId = string(item.id, 'image generation item id')
            if (active.completedImages.has(itemId)) continue
            active.completedImages.add(itemId)
            const image = await generatedImageBlock(this.ctx.attachments, item)
            if (image === undefined) continue
            const index = active.nextBlockIndex++
            yield { type: 'block-start', index, blockType: 'image' }
            yield { type: 'block-end', index, block: image }
            active.finalOutput = true
            continue
          }
          if (item.type !== 'agentMessage') continue
          const itemId = string(item.id, 'completed agent message item id')
          const phase = phaseOf(item.phase)
          let block = active.blocks.get(itemId)
          if (block === undefined) {
            block = { index: active.nextBlockIndex++, type: blockType(phase), phase, text: '', ended: false }
            active.blocks.set(itemId, block)
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
            if (block.phase !== 'commentary' && block.text.trim().length > 0) active.finalOutput = true
          }
          continue
        }
        if (method === 'thread/tokenUsage/updated') {
          active.usage = usageFrom(params.tokenUsage)
          continue
        }
        if (method === 'error' && params.willRetry !== true) {
          throw new LlmError(messageText(params.error), 'CODEX_APP_SERVER')
        }
        if (method !== 'turn/completed') continue
        const completedTurn = object(params.turn, 'turn/completed turn')
        if (contextWindowExceeded(completedTurn)) {
          if (active.usage !== undefined) yield { type: 'usage', usage: active.usage }
          yield { type: 'finish', reason: { kind: 'max-tokens' }, replayState: active.replayState }
          return
        }
        if (completedTurn.status !== 'completed') throw turnFailure(completedTurn)
        if ([...active.blocks.values()].some(block => !block.ended)) {
          throw new Error('codex-plugin-dsh: App Server completed with an open agent message')
        }
        if (!active.finalOutput) throw new Error('codex-plugin-dsh: App Server completed without a final answer or image')
        if (active.usage !== undefined) yield { type: 'usage', usage: active.usage }
        yield { type: 'finish', reason: { kind: 'stop' }, replayState: active.replayState }
        return
      }
    } finally {
      if (!keepAlive) await this.closeTurn(active)
    }
  }

  private async startTurn(
    options: GenerateOptions,
    sessionId: string,
    cwd: string,
  ): Promise<ActiveCodexTurn> {
    const signal = combinedSignal(options.signal, this.config.turnTimeoutMs)
    const imageUrls = new Map<string, Promise<string>>()
    const resolveImageUrl = (attachment: ImageAttachmentRef): Promise<string> => {
      const key = String(attachment.attachmentId)
      const existing = imageUrls.get(key)
      if (existing !== undefined) return existing
      const pending = attachmentDataUrl(this.ctx.attachments, attachment, signal)
      imageUrls.set(key, pending)
      return pending
    }
    let history = await prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER, resolveImageUrl)
    const toolSignature = codexToolSignature(options.tools)
    if (history.checkpoint !== undefined && history.checkpoint.toolSignature !== toolSignature) {
      history = await prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER, resolveImageUrl, true)
    }
    const availableTools = new Set((options.tools ?? []).map(tool => tool.name))
    const events = new ActiveTurnQueue()
    let threadId: string | undefined
    let turnId: string | undefined
    let connection: CodexAppServerConnection | undefined
    const observer: AppServerConnectionObserver = {
      notification: notification => { events.push({ kind: 'notification', notification }) },
      failure: error => { events.fail(error) },
    }
    try {
      connection = await this.openConnection(
        cwd,
        signal,
        (method, params) => {
          if (method !== 'item/tool/call') return this.handleServerRequest(method, params)
          const response = Promise.withResolvers<unknown>()
          events.push({
            kind: 'dynamic-tool',
            call: codexDynamicToolCall(params, availableTools),
            response,
          })
          return response.promise
        },
        observer,
      )
      await connection.initialize(signal)
      const isolationConfig = await this.isolationConfig(connection, signal)
      const dynamicTools = history.checkpoint?.toolSignature === toolSignature
        ? undefined
        : codexDynamicTools(options.tools)
      const threadResult = history.checkpoint === undefined
        ? await connection.request(
            'thread/start',
            this.threadParams(options, cwd, isolationConfig, dynamicTools ?? []),
            signal,
          )
        : await connection.request('thread/fork', {
          ...this.threadParams(options, cwd, isolationConfig),
          threadId: history.checkpoint.threadId,
          lastTurnId: history.checkpoint.turnId,
        }, signal)
      const thread = object(threadResult.thread, 'thread result')
      threadId = string(thread.id, 'thread id')
      if (history.injectItems.length > 0) {
        await connection.request('thread/inject_items', {
          threadId,
          items: history.injectItems,
        }, signal)
      }
      const turnResult = await connection.request('turn/start', {
        threadId,
        input: history.turnInput,
        model: options.model,
        ...options.reasoningEffort === undefined ? {} : { effort: options.reasoningEffort },
      }, signal)
      const turn = object(turnResult.turn, 'turn/start turn')
      turnId = string(turn.id, 'turn id')
      let active!: ActiveCodexTurn
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
          kind: 'codex-app-server',
          version: 1,
          threadId,
          turnId,
          sessionId,
          toolSignature,
        },
        resolveImageUrl,
        onAbort: () => {
          connection?.interrupt(threadId as string, turnId as string)
          void this.closeTurn(active)
        },
        blocks: new Map(),
        completedImages: new Set(),
        nextBlockIndex: 0,
        finalOutput: false,
      }
      signal.addEventListener('abort', active.onAbort, { once: true })
      this.activeTurns.set(active.sessionId, active)
      return active
    } catch (error) {
      events.fail(thrown(error))
      await connection?.close()
      throw error
    }
  }

  private async closeTurn(active: ActiveCodexTurn): Promise<void> {
    if (active.closing !== undefined) return active.closing
    const closing = this.finishCloseTurn(active)
    active.closing = closing
    return closing
  }

  private async finishCloseTurn(active: ActiveCodexTurn): Promise<void> {
    if (this.activeTurns.get(active.sessionId) === active) this.activeTurns.delete(active.sessionId)
    active.signal.removeEventListener('abort', active.onAbort)
    const closed = new Error('codex-plugin-dsh: App Server turn closed before a pending DSH tool result was returned')
    active.awaiting?.response.reject(closed)
    active.events.fail(closed)
    await active.connection.close()
  }

  /** Close an unfinished App Server turn after the owning DSH turn ends. */
  closeSession(sessionId: string): void {
    const active = this.activeTurns.get(sessionId)
    if (active !== undefined) void this.closeTurn(active)
  }

  /** Dispose every App Server process retained across DSH tool execution. */
  async dispose(): Promise<void> {
    await Promise.all([...this.activeTurns.values()].map(active => this.closeTurn(active)))
  }

  private threadParams(
    options: GenerateOptions,
    cwd: string,
    isolationConfig: Record<string, unknown>,
    dynamicTools?: readonly unknown[],
  ): Record<string, unknown> {
    return {
      cwd,
      model: options.model,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: isolationConfig,
      ephemeral: false,
      ...options.system === undefined ? {} : { baseInstructions: options.system },
      developerInstructions: [
        'DeepSeek Harness owns tool selection, permission checks, execution, and durable tool logs.',
        'Use only tools in the dsh dynamic-tool namespace for shell, files, web, code changes, and all other actions.',
        'Do not use built-in shell, apply_patch, web search, MCP, app, plugin, multi-agent, or view-image tools.',
        'Codex native image generation is allowed when the user requests an image.',
      ].join(' '),
      ...dynamicTools === undefined ? {} : { dynamicTools },
    }
  }

  private async isolationConfig(
    connection: CodexAppServerConnection,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await connection.request('config/read', { includeLayers: false }, signal)
    const current = recordValue(result.config)
    const disabledMcpServers = Object.fromEntries(
      Object.keys(recordValue(current.mcp_servers)).map(name => [name, { enabled: false }]),
    )
    const disabledApps = Object.fromEntries(
      Object.keys(recordValue(current.apps))
        .filter(name => name !== '_default')
        .map(name => [name, { enabled: false }]),
    )
    return {
      features: {
        shell_tool: false,
        unified_exec: false,
        multi_agent: false,
        plugins: false,
      },
      agents: { enabled: false },
      web_search: 'disabled',
      tools: { view_image: false },
      apps: { _default: { enabled: false }, ...disabledApps },
      mcp_servers: disabledMcpServers,
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
    observer?: AppServerConnectionObserver,
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
    return new CodexAppServerConnection(child, requestHandler, observer)
  }

  private async handleServerRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: deniedDecision(params, false) }
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null }
      case 'item/tool/requestUserInput':
        throw new Error('codex-plugin-dsh: App Server requested interactive user input, which this adapter does not yet bridge')
      default:
        throw new Error(`codex-plugin-dsh: unsupported App Server request ${JSON.stringify(method)}`)
    }
  }
}
