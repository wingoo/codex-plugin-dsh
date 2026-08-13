import { Context } from '@deepseek-ai/cordis'
import {
  AttachmentId,
  type ImageAttachmentRef,
  type SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  BlockAssembler,
  createToolResultMessage,
  createUserMessage,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'
import {
  CODEX_APP_SERVER_PROVIDER,
  CodexAppServerAdapter,
  type AdapterConfig,
} from '../src/adapter.ts'
import type { CodexImageAttachments } from '../src/images.ts'

const runLive = process.env.RUN_CODEX_LIVE === '1'
const runToolLive = process.env.RUN_CODEX_TOOL_LIVE === '1'
const runImageGenerationLive = process.env.RUN_CODEX_IMAGE_LIVE === '1'
const pixelBytes = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
))
const pixelRef: ImageAttachmentRef = {
  attachmentId: AttachmentId('live-input-pixel'),
  mediaType: 'image/png',
  bytes: pixelBytes.byteLength,
  width: 1,
  height: 1,
  name: 'pixel.png',
}

const config: AdapterConfig = {
  executable: 'codex',
  env: {},
  modelCacheMs: 0,
  catalogTimeoutMs: 20_000,
  turnTimeoutMs: 5 * 60_000,
  disposeGraceMs: 3_000,
  stderrMaxBytes: 16_384,
  modelPageSize: 100,
}

async function liveAdapter(attachments: CodexImageAttachments): Promise<{
  runtime: Context
  adapter: CodexAppServerAdapter
  sessionId: ReturnType<typeof SessionId>
}> {
  const runtime = new Context()
  await runtime.plugin(LocalSubprocessRuntime)
  const sessionId = SessionId('codex-plugin-live')
  const session = {
    header: { id: sessionId, cwd: process.cwd() },
    events: [],
  }
  const ctx = Object.assign(runtime, {
    sessions: { get: (id: string) => id === sessionId ? session : undefined },
    attachments,
  })
  return { runtime, adapter: new CodexAppServerAdapter(ctx, config), sessionId }
}

it.skipIf(!runLive)('discovers local Codex models and completes a real App Server image-input turn', async () => {
  const { runtime, adapter, sessionId } = await liveAdapter({
    readImage: async ref => ({ ref, data: pixelBytes }),
    saveImage: async () => { throw new Error('unexpected generated image') },
  })
  const models = await adapter.listModels(CODEX_APP_SERVER_PROVIDER)
  expect(models.length).toBeGreaterThan(0)
  const model = models.find(candidate => candidate.inputModalities?.includes('image') === true)
  expect(model).toBeDefined()

  const request: GenerateOptions = {
    provider: CODEX_APP_SERVER_PROVIDER,
    model: model!.id,
    messages: [createUserMessage({
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'Reply with exactly DSH_CODEX_APP_SERVER_OK and nothing else. Do not call tools.' },
        { type: 'image', attachment: pixelRef },
      ],
    })],
    system: 'Follow the user output format exactly.',
    sessionId,
  }
  const assembled = new BlockAssembler()
  for await (const chunk of adapter.stream(request)) assembled.push(chunk)
  const text = assembled.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  expect(assembled.finish.kind).toBe('stop')
  expect(text.trim()).toBe('DSH_CODEX_APP_SERVER_OK')
  expect(assembled.replayState).toMatchObject({
    kind: 'codex-app-server',
    version: 1,
    sessionId,
  })
  await runtime.fiber.dispose()
}, 6 * 60_000)

it.skipIf(!runImageGenerationLive)('returns a real App Server image generation as a DSH image block', async () => {
  let generated: SaveImageAttachment | undefined
  const { runtime, adapter, sessionId } = await liveAdapter({
    readImage: async ref => ({ ref, data: pixelBytes }),
    saveImage: async (input) => {
      generated = input
      return {
        attachmentId: AttachmentId('live-generated-image'),
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1024,
        height: 1024,
        ...input.name === undefined ? {} : { name: input.name },
      }
    },
  })
  const models = await adapter.listModels(CODEX_APP_SERVER_PROVIDER)
  const model = models.find(candidate => candidate.inputModalities?.includes('image') === true) ?? models[0]
  expect(model).toBeDefined()

  const assembled = new BlockAssembler()
  for await (const chunk of adapter.stream({
    provider: CODEX_APP_SERVER_PROVIDER,
    model: model!.id,
    messages: [createUserMessage({
      source: { kind: 'user' },
      content: [{
        type: 'text',
        text: 'Use the image generation tool to create a simple solid red square with no text.',
      }],
    })],
    system: 'Follow the user request and use image generation.',
    sessionId,
  })) assembled.push(chunk)

  expect(assembled.finish.kind).toBe('stop')
  expect(assembled.blocks().some(block => block.type === 'image')).toBe(true)
  expect(generated?.mediaType).toBe('image/png')
  expect(generated?.data.slice(0, 8)).toEqual(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))
  await runtime.fiber.dispose()
}, 10 * 60_000)

it.skipIf(!runToolLive)('pauses a real App Server turn while the DSH loop executes a dynamic tool', async () => {
  const { runtime, adapter, sessionId } = await liveAdapter({
    readImage: async ref => ({ ref, data: pixelBytes }),
    saveImage: async () => { throw new Error('unexpected generated image') },
  })
  const models = await adapter.listModels(CODEX_APP_SERVER_PROVIDER)
  const model = models[0]
  expect(model).toBeDefined()
  const input = createUserMessage({
    source: { kind: 'user' },
    content: [{
      type: 'text',
      text: 'Call the echo tool in the dsh namespace exactly once with {"text":"HARNESS_LOOP_OK"}. After it returns, follow any extra DSH context before giving the final answer.',
    }],
  })
  const base: GenerateOptions = {
    provider: CODEX_APP_SERVER_PROVIDER,
    model: model!.id,
    messages: [input],
    system: 'You must use the supplied DSH dynamic tool before answering.',
    tools: [{
      name: 'echo',
      description: 'Returns the supplied text unchanged.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    }],
    sessionId,
  }

  const first = new BlockAssembler()
  for await (const chunk of adapter.stream(base)) first.push(chunk)
  expect(first.finish.kind).toBe('tool-calls')
  const call = first.blocks().find(block => block.type === 'tool-call')
  expect(call).toMatchObject({ type: 'tool-call', name: 'echo', arguments: '{"text":"HARNESS_LOOP_OK"}' })
  if (call?.type !== 'tool-call') throw new Error('real App Server did not request the DSH echo tool')

  const assistant = first.message({
    kind: 'model',
    provider: CODEX_APP_SERVER_PROVIDER,
    model: model!.id,
  })
  const result = createToolResultMessage({
    callId: call.id,
    content: [{ type: 'text', text: 'HARNESS_LOOP_OK' }],
    isError: false,
  })
  const steeredContext = createUserMessage({
    source: { kind: 'plugin', plugin: 'live-test' },
    content: [{ type: 'text', text: 'Reply with exactly DSH_STEER_OK and nothing else.' }],
  })
  const second = new BlockAssembler()
  for await (const chunk of adapter.stream({
    ...base,
    messages: [input, assistant, result, steeredContext],
  })) second.push(chunk)
  expect(second.finish.kind).toBe('stop')
  expect(second.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()).toBe(
    'DSH_STEER_OK',
  )
  expect(second.replayState).toMatchObject({
    kind: 'codex-app-server',
    toolSignature: expect.any(String),
  })

  const firstFinal = second.message({
    kind: 'model',
    provider: CODEX_APP_SERVER_PROVIDER,
    model: model!.id,
    replayState: second.replayState,
  })
  const followUp = createUserMessage({
    source: { kind: 'user' },
    content: [{
      type: 'text',
      text: 'Call the echo tool in the dsh namespace with {"text":"INHERITED"}. Then reply with exactly received:INHERITED.',
    }],
  })
  const inheritedCall = new BlockAssembler()
  for await (const chunk of adapter.stream({
    ...base,
    messages: [input, assistant, result, steeredContext, firstFinal, followUp],
  })) inheritedCall.push(chunk)
  expect(inheritedCall.finish.kind).toBe('tool-calls')
  const inherited = inheritedCall.blocks().find(block => block.type === 'tool-call')
  expect(inherited).toMatchObject({ type: 'tool-call', name: 'echo', arguments: '{"text":"INHERITED"}' })
  if (inherited?.type !== 'tool-call') throw new Error('forked App Server thread did not retain the DSH echo tool')

  const inheritedAssistant = inheritedCall.message({
    kind: 'model',
    provider: CODEX_APP_SERVER_PROVIDER,
    model: model!.id,
  })
  const inheritedResult = createToolResultMessage({
    callId: inherited.id,
    content: [{ type: 'text', text: 'INHERITED' }],
    isError: false,
  })
  const inheritedFinal = new BlockAssembler()
  for await (const chunk of adapter.stream({
    ...base,
    messages: [input, assistant, result, steeredContext, firstFinal, followUp, inheritedAssistant, inheritedResult],
  })) inheritedFinal.push(chunk)
  expect(inheritedFinal.finish.kind).toBe('stop')
  expect(inheritedFinal.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()).toBe(
    'received:INHERITED',
  )
  const inheritedCompleted = inheritedFinal.message({
    kind: 'model',
    provider: CODEX_APP_SERVER_PROVIDER,
    model: model!.id,
    replayState: inheritedFinal.replayState,
  })
  const changedInput = createUserMessage({
    source: { kind: 'user' },
    content: [{
      type: 'text',
      text: 'Call the changed_echo tool in the dsh namespace with {"text":"UPDATED"}. Then reply with exactly received:UPDATED.',
    }],
  })
  const changedBase: GenerateOptions = {
    ...base,
    tools: [{
      name: 'changed_echo',
      description: 'Returns the supplied text unchanged.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    }],
    messages: [
      input,
      assistant,
      result,
      steeredContext,
      firstFinal,
      followUp,
      inheritedAssistant,
      inheritedResult,
      inheritedCompleted,
      changedInput,
    ],
  }
  const changedCall = new BlockAssembler()
  for await (const chunk of adapter.stream(changedBase)) changedCall.push(chunk)
  expect(changedCall.finish.kind).toBe('tool-calls')
  const changed = changedCall.blocks().find(block => block.type === 'tool-call')
  expect(changed).toMatchObject({ type: 'tool-call', name: 'changed_echo', arguments: '{"text":"UPDATED"}' })
  if (changed?.type !== 'tool-call') throw new Error('forked App Server thread did not update its DSH tool catalog')

  const changedAssistant = changedCall.message({
    kind: 'model',
    provider: CODEX_APP_SERVER_PROVIDER,
    model: model!.id,
  })
  const changedResult = createToolResultMessage({
    callId: changed.id,
    content: [{ type: 'text', text: 'UPDATED' }],
    isError: false,
  })
  const changedFinal = new BlockAssembler()
  for await (const chunk of adapter.stream({
    ...changedBase,
    messages: [...changedBase.messages, changedAssistant, changedResult],
  })) changedFinal.push(chunk)
  expect(changedFinal.finish.kind).toBe('stop')
  expect(changedFinal.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()).toBe(
    'received:UPDATED',
  )
  await runtime.fiber.dispose()
}, 10 * 60_000)
