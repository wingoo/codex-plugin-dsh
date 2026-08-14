# Architecture

`codex-plugin-dsh` is an external DSH bundle and Host plugin. It registers a single `LlmAdapter` route named `codex-app-server`; the existing DSH model directory and browser model-selection plugin discover the route without a Client plugin or a source patch.

## Ownership

DSH owns the persisted Session, selected route, prompt and tool assembly, outer Agent Loop, tool permissions and execution, transcript, and managed subprocess lifecycle. Codex App Server owns model discovery, native account authentication, thread context, model inference, and native image generation. The adapter translates provider messages and bridges App Server dynamic-tool requests back into the DSH loop.

The built-in DSH `subagent-codex` package is a separate capability: it exposes Codex as a delegated one-shot subagent tool. This plugin exposes Codex App Server as the primary LLM route for an ordinary DSH Session.

## Model routing

The DSH Agent Loop constructs each generation request from the Session's selected provider and model, then sends it through `ctx.llm`. The LLM service selects the registered adapter; the loop does not contain a fixed DeepSeek or OpenAI HTTP call. With provider `codex-app-server`, this adapter sends local JSON-RPC over stdio to `codex app-server`. The App Server uses the Codex account managed by the CLI and performs its own backend requests.

A DSH default model only supplies the initial Session selection. It is not a second upstream provider for a Session that has explicitly selected a Codex model.

## Model discovery

For a catalog read, the adapter resolves the configured Codex executable through `ctx.subprocess`, starts a managed App Server process, performs `initialize`, checks `account/read`, and reads every `model/list` page. Provider and model metadata then flow through the ordinary `ctx.llm` catalog used by the existing composer selector.

The successful catalog is cached for `modelCacheMs`. Discovery failures remain provider-local catalog errors, so another DSH provider stays usable.

## Turn lifecycle

For a new DSH model turn, the adapter resolves the live Session from `sessionId`, reads its working directory, and starts one managed App Server connection. The connection remains alive when App Server requests a DSH tool, so several DSH model steps can continue one App Server turn. A completed or aborted DSH turn, Session closure, plugin disposal, or timeout closes the process tree.

A request without an App Server replay checkpoint starts a persistent thread and registers the exact DSH `options.tools` catalog as an experimental `dsh` dynamic-tool namespace. A request with a checkpoint and the same tool signature calls `thread/fork` using the prior thread and turn IDs; the persisted App Server catalog is inherited without retransmission. Codex CLI `0.147.0` cannot replace dynamic tools during `thread/fork` or `thread/resume`, so a changed signature starts a new thread and reimports the complete DSH history that App Server can represent.

Completed history after the checkpoint is converted to Responses input items and inserted before the new turn. The current trailing user text and images become the `turn/start` input. Image references are verified through the DSH attachment service and encoded as inline data URLs, so App Server never depends on a DSH-local attachment path. Unsupported durable content fails before the turn starts, including a full rebuild that encounters reasoning or assistant images that cannot be imported losslessly.

App Server agent-message notifications become DSH streaming text or reasoning blocks. Completed `imageGeneration` items are decoded, validated, and persisted through the DSH attachment service before becoming assistant image blocks. A successful `turn/completed` notification produces a DSH stop finish plus replay state. Token-usage notifications are converted to DSH usage fields, including cached input and reasoning tokens.

## DSH tool-loop bridge

The adapter accepts the exact `GenerateOptions.tools` list produced by DSH. It does not inspect `ctx.tools` or rebuild the catalog, so the model sees the same preset, scope, policy, and code-mode result that another DSH provider would receive.

An App Server `item/tool/call` request is held open. The adapter emits the call as a normal DSH tool-call block and finishes that provider step with `tool-calls`. The ordinary DSH Agent Loop logs the assistant message, validates and schedules the call through its Tool Runtime, applies permissions and hooks, and appends the correlated tool result. On the next provider step, the adapter locates that result, answers the pending JSON-RPC request, and continues consuming notifications from the same App Server turn.

DSH tool-result text and images map to App Server dynamic-tool output. Messages added by DSH after the tool result, including Tool Runtime `additionalContexts`, are sent with `turn/steer`. Multiple simultaneous App Server dynamic calls are serialized across DSH steps; no call is executed inside the adapter, and standard DSH tool events remain the only durable execution log.

## App Server capability isolation

App Server runs with a read-only sandbox and `never` approval because environment actions belong to DSH Tool Runtime. Per-thread configuration disables shell, unified exec, Web search, multi-agent, Apps, Plugins, view-image, and every MCP server visible in the effective Codex configuration. Developer instructions restrict remaining action requests to the `dsh` namespace and distinguish the DSH Skill loader from Codex host skills. A DSH `skill` call may use only names advertised by the DSH skill catalog; native Codex image generation is invoked directly instead of attempting to load `imagegen` from DSH. Command, file-change, and permission approval requests fail closed if App Server still emits one.

Native image generation remains enabled intentionally. Its completed image item is persisted through the DSH attachment service and exposed as an assistant image without entering the DSH tool loop. MCP elicitation is declined, and unimplemented interactive user input fails explicitly.

## Process portability

The configured executable is resolved in the subprocess provider's execution environment. POSIX binaries and native Windows executables run directly. A Windows `.cmd` or `.bat` npm shim runs through a resolved `cmd.exe`; the quoted shim path travels in a per-process environment variable, while the command tail remains fixed.

The implementation does not assume the DSH Host and App Server share the local machine. A future remote subprocess provider can serve the same plugin when it supplies the executable, workspace, environment, streams, and process-tree semantics in its execution world.
