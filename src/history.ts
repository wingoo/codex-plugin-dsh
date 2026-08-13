/** DSH message history mapping and durable Codex thread checkpoints. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Replay data persisted on each successful DSH assistant message. */
export interface CodexReplayState {
  readonly kind: 'codex-app-server'
  readonly version: 1
  readonly threadId: string
  readonly turnId: string
  readonly sessionId: string
  /** DSH tool catalog persisted by the App Server thread, absent on older plugin checkpoints. */
  readonly toolSignature?: string
}

/** App Server text input for the current turn. */
export interface CodexTextInput {
  readonly type: 'text'
  readonly text: string
  readonly text_elements: readonly []
}

/** App Server inline image input for the current turn. */
export interface CodexImageInput {
  readonly type: 'image'
  readonly url: string
}

/** Resolve one durable DSH image reference to an App Server-safe inline URL. */
export type CodexImageUrlResolver = (attachment: ImageAttachmentRef) => Promise<string>

/** History work required before the current App Server turn starts. */
export interface PreparedCodexHistory {
  readonly checkpoint?: CodexReplayState
  readonly injectItems: readonly Record<string, unknown>[]
  readonly turnInput: readonly (CodexTextInput | CodexImageInput)[]
}

function replayState(value: unknown): CodexReplayState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.kind !== 'codex-app-server' || candidate.version !== 1) return undefined
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) return undefined
  if (typeof candidate.turnId !== 'string' || candidate.turnId.length === 0) return undefined
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) return undefined
  return {
    kind: 'codex-app-server',
    version: 1,
    threadId: candidate.threadId,
    turnId: candidate.turnId,
    sessionId: candidate.sessionId,
    ...typeof candidate.toolSignature === 'string' && candidate.toolSignature.length > 0
      ? { toolSignature: candidate.toolSignature }
      : {},
  }
}

function latestCheckpoint(
  messages: readonly Message[],
  provider: string,
): { readonly index: number; readonly state: CodexReplayState } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant' || message.source.kind !== 'model' || message.source.provider !== provider) continue
    const state = replayState(message.source.replayState)
    if (state === undefined) {
      if (message.content.some(block => block.type === 'tool-call')) continue
      throw new Error(
        'codex-plugin-dsh: a prior Codex response has no compatible App Server checkpoint; start a new session',
      )
    }
    return { index, state }
  }
  return undefined
}

function textBlocks(blocks: readonly ContentBlock[], label: string): string[] {
  return blocks.map((block) => {
    if (block.type !== 'text') {
      throw new Error(`codex-plugin-dsh: ${label} contains unsupported ${JSON.stringify(block.type)} content`)
    }
    return block.text
  })
}

function isCurrentTurnInput(message: Message): boolean {
  return message.role === 'user'
    && message.source.kind !== 'tool'
    && message.content.length > 0
    && message.content.every(block => block.type === 'text' || block.type === 'image')
}

async function inputContent(
  blocks: readonly ContentBlock[],
  label: string,
  resolveImageUrl: CodexImageUrlResolver,
): Promise<Record<string, unknown>[]> {
  return Promise.all(blocks.map(async (block) => {
    if (block.type === 'text') return { type: 'input_text', text: block.text }
    if (block.type === 'image') {
      return { type: 'input_image', image_url: await resolveImageUrl(block.attachment) }
    }
    throw new Error(`codex-plugin-dsh: ${label} contains unsupported ${JSON.stringify(block.type)} content`)
  }))
}

async function toolOutput(
  block: Extract<ContentBlock, { type: 'tool-result' }>,
  resolveImageUrl: CodexImageUrlResolver,
): Promise<string | Record<string, unknown>[]> {
  const label = `tool result ${JSON.stringify(block.toolCallId)}`
  if (block.content.every(item => item.type === 'text')) {
    return textBlocks(block.content, label).join('\n')
  }
  return inputContent(block.content, label, resolveImageUrl)
}

async function userHistoryItem(
  message: Message,
  resolveImageUrl: CodexImageUrlResolver,
): Promise<Record<string, unknown>[]> {
  if (message.source.kind === 'tool') {
    if (message.content.length !== 1 || message.content[0]?.type !== 'tool-result') {
      throw new Error('codex-plugin-dsh: a DSH tool message has invalid tool-result content')
    }
    const block = message.content[0]
    return [{
      type: 'function_call_output',
      call_id: block.toolCallId,
      output: await toolOutput(block, resolveImageUrl),
    }]
  }
  return [{
    type: 'message',
    role: message.role,
    content: await inputContent(message.content, 'user history', resolveImageUrl),
  }]
}

function assistantHistoryItems(message: Message): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  let text: Array<{ readonly type: 'output_text'; readonly text: string; readonly annotations: readonly [] }> = []
  const flushText = (): void => {
    if (text.length === 0) return
    items.push({ type: 'message', role: 'assistant', status: 'completed', content: text })
    text = []
  }
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        text.push({ type: 'output_text', text: block.text, annotations: [] })
        break
      case 'tool-call':
        flushText()
        items.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: block.arguments,
          status: 'completed',
        })
        break
      case 'reasoning':
        throw new Error(
          'codex-plugin-dsh: another provider\'s reasoning history cannot be imported into Codex App Server; start a new session',
        )
      case 'image':
      case 'tool-result':
        throw new Error(`codex-plugin-dsh: assistant history contains unsupported ${JSON.stringify(block.type)} content`)
      default:
        throw new Error('codex-plugin-dsh: assistant history contains a plugin-defined content block that App Server cannot import')
    }
  }
  flushText()
  return items
}

/** Map completed DSH history to raw Responses items accepted by `thread/inject_items`. */
export async function responseItems(
  messages: readonly Message[],
  resolveImageUrl: CodexImageUrlResolver,
): Promise<readonly Record<string, unknown>[]> {
  const items = await Promise.all(messages.map(async (message) => {
    if (message.role === 'assistant') return assistantHistoryItems(message)
    if (message.role === 'user' || message.role === 'system') return userHistoryItem(message, resolveImageUrl)
    throw new Error(`codex-plugin-dsh: unsupported history role ${JSON.stringify(message.role)}`)
  }))
  return items.flat()
}

/**
 * Split a DSH request into a pinned Codex checkpoint, completed history to import, and current user input.
 * @param messages - Exact DSH provider message sequence for this request.
 * @param provider - Registered Codex provider route.
 * @param ignoreCheckpoint - Rebuild from DSH history instead of reusing a persisted Codex thread.
 * @returns Work required to construct the matching App Server thread.
 */
export async function prepareCodexHistory(
  messages: readonly Message[],
  provider: string,
  resolveImageUrl: CodexImageUrlResolver,
  ignoreCheckpoint = false,
): Promise<PreparedCodexHistory> {
  const checkpoint = ignoreCheckpoint ? undefined : latestCheckpoint(messages, provider)
  const pending = checkpoint === undefined ? messages : messages.slice(checkpoint.index + 1)
  let inputStart = pending.length
  while (inputStart > 0 && isCurrentTurnInput(pending[inputStart - 1] as Message)) inputStart -= 1
  const historical = pending.slice(0, inputStart)
  const current = pending.slice(inputStart)
  if (current.length === 0) {
    throw new Error('codex-plugin-dsh: the current Codex turn has no user input')
  }
  const turnInput = (await Promise.all(current.map(message => Promise.all(message.content.map(async (block) => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text, text_elements: [] as const }
    }
    if (block.type === 'image') {
      return { type: 'image' as const, url: await resolveImageUrl(block.attachment) }
    }
    throw new Error(
      `codex-plugin-dsh: current user input contains unsupported ${JSON.stringify(block.type)} content`,
    )
  }))))).flat()
  if (turnInput.every(input => input.type === 'text' && input.text.trim().length === 0)) {
    throw new Error('codex-plugin-dsh: the current Codex turn is empty')
  }
  return {
    ...checkpoint === undefined ? {} : { checkpoint: checkpoint.state },
    injectItems: await responseItems(historical, resolveImageUrl),
    turnInput,
  }
}
