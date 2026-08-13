/** External DSH plugin that registers local Codex App Server as a native model provider. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  CODEX_APP_SERVER_PROVIDER,
  CodexAppServerAdapter,
  type AdapterConfig,
} from './adapter.ts'

export const name = 'codex-plugin-dsh'
export const inject = ['llm', 'subprocess', 'sessions', 'attachments']

/** Deployment configuration for the local Codex CLI process. */
export interface Config {
  /** Bare command or absolute path resolved in the DSH subprocess execution world. */
  executable?: string
  /** Explicit environment layered over DSH's credential-scrubbed child environment. */
  env?: Record<string, string>
  /** Milliseconds to retain one successful App Server model catalog. */
  modelCacheMs?: number
  /** Milliseconds allowed for login and model discovery. */
  catalogTimeoutMs?: number
  /** Milliseconds allowed for one Codex turn. */
  turnTimeoutMs?: number
  /** Grace between managed subprocess termination tiers. */
  disposeGraceMs?: number
  /** Maximum App Server stderr bytes retained for a failure diagnostic. */
  stderrMaxBytes?: number
  /** Number of models requested per App Server catalog page. */
  modelPageSize?: number
}

export const Config: z<Config> = z.object({
  executable: z.string().default('codex'),
  env: z.dict(z.string()).default({}),
  modelCacheMs: z.number().default(30_000),
  catalogTimeoutMs: z.number().default(10_000),
  turnTimeoutMs: z.number().default(10 * 60_000),
  disposeGraceMs: z.number().default(3_000),
  stderrMaxBytes: z.number().default(16_384),
  modelPageSize: z.number().default(100),
})

function resolvedConfig(config: Config): AdapterConfig {
  const resolved = config as Required<Config>
  if (resolved.executable.trim().length === 0) throw new Error('codex-plugin-dsh: executable must be non-empty')
  const positive = [
    ['catalogTimeoutMs', resolved.catalogTimeoutMs],
    ['turnTimeoutMs', resolved.turnTimeoutMs],
    ['disposeGraceMs', resolved.disposeGraceMs],
    ['stderrMaxBytes', resolved.stderrMaxBytes],
  ] as const
  for (const [field, value] of positive) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`codex-plugin-dsh: ${field} must be positive and finite`)
  }
  if (!Number.isFinite(resolved.modelCacheMs) || resolved.modelCacheMs < 0) {
    throw new Error('codex-plugin-dsh: modelCacheMs must be non-negative and finite')
  }
  if (!Number.isSafeInteger(resolved.modelPageSize) || resolved.modelPageSize <= 0) {
    throw new Error('codex-plugin-dsh: modelPageSize must be a positive safe integer')
  }
  return {
    executable: resolved.executable,
    env: resolved.env,
    modelCacheMs: resolved.modelCacheMs,
    catalogTimeoutMs: resolved.catalogTimeoutMs,
    turnTimeoutMs: resolved.turnTimeoutMs,
    disposeGraceMs: resolved.disposeGraceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
    modelPageSize: resolved.modelPageSize,
  }
}

/** Register the adapter inside the existing DSH provider and session lifecycles. */
export function apply(ctx: Context, config: Config): void {
  const adapter = new CodexAppServerAdapter(ctx, resolvedConfig(config))
  ctx.llm.registerAdapter([CODEX_APP_SERVER_PROVIDER], adapter)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') adapter.closeSession(String(session.header.id))
  })
  ctx.effect(() => () => adapter.dispose(), 'codex-plugin-dsh: close active App Server turns')
}

export { CODEX_APP_SERVER_PROVIDER, CodexAppServerAdapter }
