import { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
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

const runLive = process.env.RUN_CODEX_LIVE === '1'

const config: AdapterConfig = {
  executable: 'codex',
  env: {},
  modelCacheMs: 0,
  catalogTimeoutMs: 20_000,
  turnTimeoutMs: 5 * 60_000,
  disposeGraceMs: 3_000,
  stderrMaxBytes: 16_384,
  modelPageSize: 100,
  fallbackSandbox: 'read-only',
}

it.skipIf(!runLive)('discovers local Codex models and completes a real App Server turn', async () => {
  const runtime = new Context()
  await runtime.plugin(LocalSubprocessRuntime)
  const sessionId = SessionId('codex-plugin-live')
  const session = {
    header: { id: sessionId, cwd: process.cwd() },
    events: [],
  }
  const agent = { session }
  const ctx = Object.assign(runtime, {
    sessions: { get: (id: string) => id === sessionId ? session : undefined },
    agents: { get: (id: string) => id === sessionId ? agent : undefined },
    approval: {
      config: { policy: 'never' },
      request: () => Promise.resolve('rejected'),
    },
  })
  const adapter = new CodexAppServerAdapter(ctx, config)
  const models = await adapter.listModels(CODEX_APP_SERVER_PROVIDER)
  expect(models.length).toBeGreaterThan(0)

  const request: GenerateOptions = {
    provider: CODEX_APP_SERVER_PROVIDER,
    model: models[0]!.id,
    messages: [createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Reply with exactly DSH_CODEX_APP_SERVER_OK and nothing else. Do not call tools.' }],
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
