/** DSH message history mapping and durable Codex thread checkpoints. */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Replay data persisted on each successful DSH assistant message. */
export interface CodexReplayState {
  readonly kind: 'codex-app-server'
  readonly version: 1
  readonly threadId: string
  readonly turnId: string
  readonly sessionId: string
}

/** App Server text input for the current turn. */
export interface CodexTextInput {
  readonly type: 'text'
  readonly text: string
  readonly text_elements: readonly []
}

/** History work required before the current App Server turn starts. */
export interface PreparedCodexHistory {
  readonly checkpoint?: CodexReplayState
  readonly injectItems: readonly Record<string, unknown>[]
  readonly turnInput: readonly CodexTextInput[]
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
    && message.content.every(block => block.type === 'text')
}

function toolOutput(block: Extract<ContentBlock, { type: 'tool-result' }>): string {
  const texts = textBlocks(block.content, `tool result ${JSON.stringify(block.toolCallId)}`)
  return texts.join('\n')
}

function userHistoryItem(message: Message): Record<string, unknown>[] {
  if (message.source.kind === 'tool') {
    if (message.content.length !== 1 || message.content[0]?.type !== 'tool-result') {
      throw new Error('codex-plugin-dsh: a DSH tool message has invalid tool-result content')
    }
    const block = message.content[0]
    return [{
      type: 'function_call_output',
      call_id: block.toolCallId,
      output: toolOutput(block),
    }]
  }
  const texts = textBlocks(message.content, 'user history')
  return [{
    type: 'message',
    role: message.role,
    content: texts.map(text => ({ type: 'input_text', text })),
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
export function responseItems(messages: readonly Message[]): readonly Record<string, unknown>[] {
  return messages.flatMap((message) => {
    if (message.role === 'assistant') return assistantHistoryItems(message)
    if (message.role === 'user' || message.role === 'system') return userHistoryItem(message)
    throw new Error(`codex-plugin-dsh: unsupported history role ${JSON.stringify(message.role)}`)
  })
}

/**
 * Split a DSH request into a pinned Codex checkpoint, completed history to import, and current text input.
 * @param messages - Exact DSH provider message sequence for this request.
 * @param provider - Registered Codex provider route.
 * @returns Work required to construct the matching App Server thread.
 */
export function prepareCodexHistory(
  messages: readonly Message[],
  provider: string,
): PreparedCodexHistory {
  const checkpoint = latestCheckpoint(messages, provider)
  const pending = checkpoint === undefined ? messages : messages.slice(checkpoint.index + 1)
  let inputStart = pending.length
  while (inputStart > 0 && isCurrentTurnInput(pending[inputStart - 1] as Message)) inputStart -= 1
  const historical = pending.slice(0, inputStart)
  const current = pending.slice(inputStart)
  if (current.length === 0) {
    throw new Error('codex-plugin-dsh: the current Codex turn has no text user input')
  }
  const turnInput = current.flatMap(message =>
    textBlocks(message.content, 'current user input').map(text => ({
      type: 'text' as const,
      text,
      text_elements: [] as const,
    })))
  if (turnInput.every(input => input.text.trim().length === 0)) {
    throw new Error('codex-plugin-dsh: the current Codex turn is empty')
  }
  return {
    ...checkpoint === undefined ? {} : { checkpoint: checkpoint.state },
    injectItems: responseItems(historical),
    turnInput,
  }
}
