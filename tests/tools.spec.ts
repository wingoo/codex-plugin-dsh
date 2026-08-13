import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId, createToolResultMessage, createUserMessage, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  codexDynamicToolCall,
  codexDynamicToolResult,
  codexDynamicTools,
  codexToolSignature,
} from '../src/tools.ts'

const echo: ToolSchema = {
  name: 'echo',
  description: 'Return the supplied text.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
}

describe('Codex dynamic DSH tools', () => {
  it('registers the exact assembled schemas under the DSH namespace', () => {
    expect(codexDynamicTools([echo])).toEqual([{
      type: 'namespace',
      name: 'dsh',
      description: 'Tools assembled and executed by DeepSeek Harness for this session.',
      tools: [{
        type: 'function',
        name: 'echo',
        description: 'Return the supplied text.',
        inputSchema: echo.parameters,
      }],
    }])
    expect(codexDynamicTools([])).toEqual([])
    expect(codexToolSignature([echo])).toBe(codexToolSignature([echo]))
    expect(codexToolSignature([echo])).not.toBe(codexToolSignature([]))
  })

  it('accepts only calls from the registered DSH namespace and catalog', () => {
    const call = codexDynamicToolCall({
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: 'dsh',
      tool: 'echo',
      arguments: { text: 'hello' },
    }, new Set(['echo']))
    expect(call).toMatchObject({ namespace: 'dsh', tool: 'echo', arguments: { text: 'hello' } })

    expect(() => codexDynamicToolCall({
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: 'codex',
      tool: 'echo',
      arguments: {},
    }, new Set(['echo']))).toThrow('unsupported dynamic tool namespace')
    expect(() => codexDynamicToolCall({
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: 'dsh',
      tool: 'missing',
      arguments: {},
    }, new Set(['echo']))).toThrow('unregistered DSH tool')
  })

  it('returns DSH text and image tool output to the pending App Server call', async () => {
    const callId = CallId('call-1')
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId('image-1'),
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
    }
    const message = createToolResultMessage({
      callId,
      content: [
        { type: 'text', text: 'done' },
        { type: 'image', attachment: image },
      ],
      isError: false,
    })
    const context = createUserMessage({
      source: { kind: 'plugin', plugin: 'test' },
      content: [{ type: 'text', text: 'next-step context' }, { type: 'image', attachment: image }],
    })
    await expect(codexDynamicToolResult([message, context], callId, async attachment => (
      `data:${attachment.mediaType};base64,AAAA`
    ))).resolves.toEqual({
      response: {
        success: true,
        contentItems: [
          { type: 'inputText', text: 'done' },
          { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
        ],
      },
      steerInput: [
        { type: 'text', text: 'next-step context', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,AAAA' },
      ],
    })
  })

  it('preserves DSH tool failure and rejects missing correlation', async () => {
    const callId = CallId('call-error')
    const message = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'failed' }],
      isError: true,
    })
    await expect(codexDynamicToolResult([message], callId, async () => 'unused')).resolves.toEqual({
      response: {
        success: false,
        contentItems: [{ type: 'inputText', text: 'failed' }],
      },
      steerInput: [],
    })
    await expect(codexDynamicToolResult([], callId, async () => 'unused')).rejects.toThrow(
      'DSH did not return tool result',
    )
  })
})
