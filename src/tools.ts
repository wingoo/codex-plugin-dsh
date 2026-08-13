/** Codex dynamic-tool registration and DSH tool-result mapping. */

import { createHash } from 'node:crypto'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CallId, ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

/** Namespace that keeps DSH-owned tools distinct from Codex built-in tools. */
export const DSH_TOOL_NAMESPACE = 'dsh'

/** App Server dynamic-tool declaration assembled from one DSH request. */
export interface CodexDynamicToolNamespace {
  readonly type: 'namespace'
  readonly name: typeof DSH_TOOL_NAMESPACE
  readonly description: string
  readonly tools: readonly {
    readonly type: 'function'
    readonly name: string
    readonly description: string
    readonly inputSchema: Record<string, unknown>
  }[]
}

/** Validated `item/tool/call` request retained while DSH executes the tool. */
export interface CodexDynamicToolCall {
  readonly threadId: string
  readonly turnId: string
  readonly callId: string
  readonly namespace: typeof DSH_TOOL_NAMESPACE
  readonly tool: string
  readonly arguments: unknown
}

/** App Server response to one completed dynamic-tool call. */
export interface CodexDynamicToolResult {
  readonly contentItems: readonly (
    | { readonly type: 'inputText'; readonly text: string }
    | { readonly type: 'inputImage'; readonly imageUrl: string }
  )[]
  readonly success: boolean
}

/** Extra DSH messages deferred by tool execution and steered into the active Codex turn. */
export type CodexDynamicToolSteerInput =
  | { readonly type: 'text'; readonly text: string; readonly text_elements: readonly [] }
  | { readonly type: 'image'; readonly url: string }

/** Pending tool response plus any DSH next-step context that followed it. */
export interface CodexDynamicToolContinuation {
  readonly response: CodexDynamicToolResult
  readonly steerInput: readonly CodexDynamicToolSteerInput[]
}

/** Resolve one durable DSH image reference to an App Server-safe inline URL. */
export type CodexToolImageUrlResolver = (attachment: ImageAttachmentRef) => Promise<string>

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}`)
  }
  return value
}

/**
 * Map the exact DSH tool schemas assembled for a provider request to one Codex namespace.
 * @param tools - Tool schemas after DSH preset, scope, and policy assembly.
 * @returns Experimental App Server dynamic-tool declarations.
 */
export function codexDynamicTools(tools: readonly ToolSchema[] | undefined): readonly CodexDynamicToolNamespace[] {
  if (tools === undefined || tools.length === 0) return []
  return [{
    type: 'namespace',
    name: DSH_TOOL_NAMESPACE,
    description: 'Tools assembled and executed by DeepSeek Harness for this session.',
    tools: tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
  }]
}

/**
 * Fingerprint the model-visible DSH tool catalog retained by an App Server thread.
 * @param tools - Exact DSH tool schemas for the provider request.
 * @returns Stable SHA-256 digest used to avoid redundant registrations.
 */
export function codexToolSignature(tools: readonly ToolSchema[] | undefined): string {
  return createHash('sha256').update(JSON.stringify(codexDynamicTools(tools))).digest('hex')
}

/**
 * Validate one App Server dynamic-tool request before exposing it to the DSH loop.
 * @param params - Raw `item/tool/call` parameters.
 * @param availableTools - Exact DSH tool names registered for the active turn.
 * @returns Validated dynamic-tool call.
 */
export function codexDynamicToolCall(
  params: Record<string, unknown>,
  availableTools: ReadonlySet<string>,
): CodexDynamicToolCall {
  const namespace = requiredString(params.namespace, 'dynamic tool namespace')
  if (namespace !== DSH_TOOL_NAMESPACE) {
    throw new Error(`codex-plugin-dsh: App Server requested unsupported dynamic tool namespace ${JSON.stringify(namespace)}`)
  }
  const tool = requiredString(params.tool, 'dynamic tool name')
  if (!availableTools.has(tool)) {
    throw new Error(`codex-plugin-dsh: App Server requested unregistered DSH tool ${JSON.stringify(tool)}`)
  }
  return {
    threadId: requiredString(params.threadId, 'dynamic tool thread id'),
    turnId: requiredString(params.turnId, 'dynamic tool turn id'),
    callId: requiredString(params.callId, 'dynamic tool call id'),
    namespace: DSH_TOOL_NAMESPACE,
    tool,
    arguments: params.arguments,
  }
}

function matchingToolResult(
  messages: readonly Message[],
  callId: string,
): { readonly index: number; readonly block: Extract<ContentBlock, { type: 'tool-result' }> } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user' || message.source.kind !== 'tool' || String(message.source.callId) !== callId) continue
    if (message.content.length !== 1 || message.content[0]?.type !== 'tool-result') {
      throw new Error(`codex-plugin-dsh: DSH tool result ${JSON.stringify(callId)} has invalid content`)
    }
    if (String(message.content[0].toolCallId) !== callId) {
      throw new Error(`codex-plugin-dsh: DSH tool result ${JSON.stringify(callId)} has mismatched correlation`)
    }
    return { index, block: message.content[0] }
  }
  throw new Error(`codex-plugin-dsh: DSH did not return tool result ${JSON.stringify(callId)}`)
}

/**
 * Convert the DSH loop's logged tool result into the pending App Server response.
 * @param messages - Current DSH provider message sequence after tool execution.
 * @param callId - Pending App Server call identity.
 * @param resolveImageUrl - Durable-image resolver for nested tool output.
 * @returns Dynamic-tool response and later DSH context consumed by the still-running App Server turn.
 */
export async function codexDynamicToolResult(
  messages: readonly Message[],
  callId: CallId | string,
  resolveImageUrl: CodexToolImageUrlResolver,
): Promise<CodexDynamicToolContinuation> {
  const matched = matchingToolResult(messages, String(callId))
  const contentItems = await Promise.all(matched.block.content.map(async (block) => {
    if (block.type === 'text') return { type: 'inputText' as const, text: block.text }
    if (block.type === 'image') {
      return { type: 'inputImage' as const, imageUrl: await resolveImageUrl(block.attachment) }
    }
    throw new Error(
      `codex-plugin-dsh: DSH tool result ${JSON.stringify(String(callId))} contains unsupported ${JSON.stringify(block.type)} content`,
    )
  }))
  const steerInput = (await Promise.all(messages.slice(matched.index + 1).map(async (message) => {
    if (message.role === 'assistant' || message.source.kind === 'tool') {
      throw new Error(`codex-plugin-dsh: unexpected message followed DSH tool result ${JSON.stringify(String(callId))}`)
    }
    return Promise.all(message.content.map(async (block) => {
      if (block.type === 'text') return { type: 'text' as const, text: block.text, text_elements: [] as const }
      if (block.type === 'image') return { type: 'image' as const, url: await resolveImageUrl(block.attachment) }
      throw new Error(
        `codex-plugin-dsh: context after tool result ${JSON.stringify(String(callId))} contains unsupported ${JSON.stringify(block.type)} content`,
      )
    }))
  }))).flat()
  return {
    response: { contentItems, success: matched.block.isError !== true },
    steerInput,
  }
}
