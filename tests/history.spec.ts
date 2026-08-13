import {
  AttachmentId,
  type ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import {
  CallId,
  createAssistantMessage,
  createUserMessage,
  type Message,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  prepareCodexHistory,
  responseItems,
  type CodexReplayState,
} from '../src/history.ts'

const provider = 'codex-app-server'
const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId('image-1'),
  mediaType: 'image/png',
  bytes: 68,
  width: 1,
  height: 1,
  name: 'pixel.png',
}
const resolveImageUrl = async (attachment: ImageAttachmentRef): Promise<string> =>
  `data:${attachment.mediaType};base64,${attachment.attachmentId}`

function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function checkpoint(threadId = 'thread-1', turnId = 'turn-1'): CodexReplayState {
  return {
    kind: 'codex-app-server',
    version: 1,
    threadId,
    turnId,
    sessionId: 'session-1',
    toolSignature: 'tools-1',
  }
}

describe('prepareCodexHistory', () => {
  it('uses all trailing user messages as a fresh turn', async () => {
    await expect(prepareCodexHistory([user('context'), user('task')], provider, resolveImageUrl)).resolves.toEqual({
      injectItems: [],
      turnInput: [
        { type: 'text', text: 'context', text_elements: [] },
        { type: 'text', text: 'task', text_elements: [] },
      ],
    })
  })

  it('passes current images to App Server as inline turn input', async () => {
    const input = createUserMessage({
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', attachment: imageRef },
      ],
      source: { kind: 'user' },
    })
    await expect(prepareCodexHistory([input], provider, resolveImageUrl)).resolves.toEqual({
      injectItems: [],
      turnInput: [
        { type: 'text', text: 'describe this', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,image-1' },
      ],
    })
  })

  it('pins the newest compatible Codex checkpoint', async () => {
    const state = checkpoint()
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'prior answer' }],
      source: { provider, model: 'gpt-test', replayState: state },
    })
    await expect(prepareCodexHistory(
      [user('old'), assistant, user('next')],
      provider,
      resolveImageUrl,
    )).resolves.toEqual({
      checkpoint: state,
      injectItems: [],
      turnInput: [{ type: 'text', text: 'next', text_elements: [] }],
    })
  })

  it('imports intervening completed text and tool history', async () => {
    const foreignCall = CallId('call-1')
    const foreign = createAssistantMessage({
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool-call', id: foreignCall, name: 'read_file', arguments: '{"path":"a"}' },
      ],
      source: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    const result = createUserMessage({
      source: { kind: 'tool', callId: foreignCall },
      content: [{
        type: 'tool-result',
        toolCallId: foreignCall,
        content: [{ type: 'text', text: 'contents' }],
      }],
    })
    const prepared = await prepareCodexHistory(
      [user('read a'), foreign, result, user('continue')],
      provider,
      resolveImageUrl,
    )
    expect(prepared.turnInput).toEqual([{ type: 'text', text: 'continue', text_elements: [] }])
    expect(prepared.injectItems).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a' }] },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'checking', annotations: [] }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"a"}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
    ])
  })

  it('continues from the last checkpoint across an intermediate Codex tool step', async () => {
    const state = checkpoint()
    const completed = createAssistantMessage({
      content: [{ type: 'text', text: 'prior answer' }],
      source: { provider, model: 'gpt-test', replayState: state },
    })
    const callId = CallId('call-pending')
    const call = createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"x"}' }],
      source: { provider, model: 'gpt-test' },
    })
    const result = createUserMessage({
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'x' }],
      }],
    })
    await expect(prepareCodexHistory(
      [user('old'), completed, call, result, user('next')],
      provider,
      resolveImageUrl,
    )).resolves.toEqual({
      checkpoint: state,
      injectItems: [
        {
          type: 'function_call',
          call_id: 'call-pending',
          name: 'echo',
          arguments: '{"text":"x"}',
          status: 'completed',
        },
        { type: 'function_call_output', call_id: 'call-pending', output: 'x' },
      ],
      turnInput: [{ type: 'text', text: 'next', text_elements: [] }],
    })
  })

  it('rebuilds importable DSH history when a caller discards the checkpoint', async () => {
    const completed = createAssistantMessage({
      content: [{ type: 'text', text: 'prior answer' }],
      source: { provider, model: 'gpt-test', replayState: checkpoint() },
    })
    await expect(prepareCodexHistory(
      [user('old'), completed, user('next')],
      provider,
      resolveImageUrl,
      true,
    )).resolves.toEqual({
      injectItems: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'prior answer', annotations: [] }],
        },
      ],
      turnInput: [{ type: 'text', text: 'next', text_elements: [] }],
    })
  })

  it('imports historical user and tool-result images as inline Responses items', async () => {
    const callId = CallId('call-image')
    const historicalImage = createUserMessage({
      content: [{ type: 'image', attachment: imageRef }],
      source: { kind: 'user' },
    })
    const call = createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'inspect_image', arguments: '{}' }],
      source: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    const result = createUserMessage({
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'result' }, { type: 'image', attachment: imageRef }],
      }],
    })
    const prepared = await prepareCodexHistory(
      [historicalImage, call, result, user('continue')],
      provider,
      resolveImageUrl,
    )
    expect(prepared.injectItems).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,image-1' }],
      },
      {
        type: 'function_call',
        call_id: 'call-image',
        name: 'inspect_image',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call-image',
        output: [
          { type: 'input_text', text: 'result' },
          { type: 'input_image', image_url: 'data:image/png;base64,image-1' },
        ],
      },
    ])
  })

  it('fails instead of silently dropping foreign reasoning history', async () => {
    const foreign = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'private chain' }, { type: 'text', text: 'answer' }],
      source: { provider: 'deepseek', model: 'deepseek-reasoner' },
    })
    await expect(responseItems([foreign], resolveImageUrl)).rejects.toThrow('reasoning history cannot be imported')
  })

  it('fails when an older Codex response cannot identify its App Server thread', async () => {
    const old = createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }],
      source: { provider, model: 'gpt-test' },
    })
    await expect(prepareCodexHistory(
      [old, user('next')],
      provider,
      resolveImageUrl,
    )).rejects.toThrow('no compatible App Server checkpoint')
  })
})
