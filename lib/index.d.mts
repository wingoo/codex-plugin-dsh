import z from "@deepseek-ai/schemastery";
import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
//#region src/adapter.d.ts
/** Provider route registered in the existing DSH model catalog. */
declare const CODEX_APP_SERVER_PROVIDER = "codex-app-server";
/** Resolved process and timeout configuration owned by the plugin deployment. */
interface AdapterConfig {
  readonly executable: string;
  readonly env: Record<string, string>;
  readonly modelCacheMs: number;
  readonly catalogTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly disposeGraceMs: number;
  readonly stderrMaxBytes: number;
  readonly modelPageSize: number;
}
/** Local Codex App Server route with session-aware history, permissions, and process ownership. */
declare class CodexAppServerAdapter extends LlmAdapter {
  private readonly ctx;
  private readonly config;
  private cachedModels;
  private pendingModels;
  private readonly activeTurns;
  constructor(ctx: Context, config: AdapterConfig);
  providerInfo(provider: string): LlmProviderInfo;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  private startTurn;
  private closeTurn;
  private finishCloseTurn;
  /** Close an unfinished App Server turn after the owning DSH turn ends. */
  closeSession(sessionId: string): void;
  /** Dispose every App Server process retained across DSH tool execution. */
  dispose(): Promise<void>;
  private threadParams;
  private isolationConfig;
  private models;
  private loadModels;
  private openConnection;
  private handleServerRequest;
}
//#endregion
//#region src/index.d.ts
declare const name = "codex-plugin-dsh";
declare const inject: string[];
/** Deployment configuration for the local Codex CLI process. */
interface Config {
  /** Bare command or absolute path resolved in the DSH subprocess execution world. */
  executable?: string;
  /** Explicit environment layered over DSH's credential-scrubbed child environment. */
  env?: Record<string, string>;
  /** Milliseconds to retain one successful App Server model catalog. */
  modelCacheMs?: number;
  /** Milliseconds allowed for login and model discovery. */
  catalogTimeoutMs?: number;
  /** Milliseconds allowed for one Codex turn. */
  turnTimeoutMs?: number;
  /** Grace between managed subprocess termination tiers. */
  disposeGraceMs?: number;
  /** Maximum App Server stderr bytes retained for a failure diagnostic. */
  stderrMaxBytes?: number;
  /** Number of models requested per App Server catalog page. */
  modelPageSize?: number;
}
declare const Config: z<Config>;
/** Register the adapter inside the existing DSH provider and session lifecycles. */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { CODEX_APP_SERVER_PROVIDER, CodexAppServerAdapter, Config, apply, inject, name };