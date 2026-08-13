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
  }
}

describe('prepareCodexHistory', () => {
  it('uses all trailing text user messages as a fresh turn', () => {
    expect(prepareCodexHistory([user('context'), user('task')], provider)).toEqual({
      injectItems: [],
      turnInput: [
        { type: 'text', text: 'context', text_elements: [] },
        { type: 'text', text: 'task', text_elements: [] },
      ],
    })
  })

  it('pins the newest compatible Codex checkpoint', () => {
    const state = checkpoint()
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'prior answer' }],
      source: { provider, model: 'gpt-test', replayState: state },
    })
    expect(prepareCodexHistory([user('old'), assistant, user('next')], provider)).toEqual({
      checkpoint: state,
      injectItems: [],
      turnInput: [{ type: 'text', text: 'next', text_elements: [] }],
    })
  })

  it('imports intervening completed text and tool history', () => {
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
    const prepared = prepareCodexHistory([user('read a'), foreign, result, user('continue')], provider)
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

  it('fails instead of silently dropping foreign reasoning history', () => {
    const foreign = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'private chain' }, { type: 'text', text: 'answer' }],
      source: { provider: 'deepseek', model: 'deepseek-reasoner' },
    })
    expect(() => responseItems([foreign])).toThrow('reasoning history cannot be imported')
  })

  it('fails when an older Codex response cannot identify its App Server thread', () => {
    const old = createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }],
      source: { provider, model: 'gpt-test' },
    })
    expect(() => prepareCodexHistory([old, user('next')], provider)).toThrow('no compatible App Server checkpoint')
  })
})
