# Architecture

`codex-plugin-dsh` is an external DSH bundle and Host plugin. It registers a single `LlmAdapter` route named `codex-app-server`; the existing DSH model directory and browser model-selection plugin discover the route without a Client plugin or a source patch.

## Ownership

DSH owns the persisted Session, selected route, workspace, approval surface, sandbox state, transcript, and managed subprocess lifecycle. Codex App Server owns model discovery, native account authentication, thread execution, and the internal coding-agent tool loop. The adapter translates only the data required to connect those two owners.

The built-in DSH `subagent-codex` package is a separate capability: it exposes Codex as a delegated one-shot subagent tool. This plugin exposes Codex App Server as the primary LLM route for an ordinary DSH Session.

## Model discovery

For a catalog read, the adapter resolves the configured Codex executable through `ctx.subprocess`, starts a managed App Server process, performs `initialize`, checks `account/read`, and reads every `model/list` page. Provider and model metadata then flow through the ordinary `ctx.llm` catalog used by the existing composer selector.

The successful catalog is cached for `modelCacheMs`. Discovery failures remain provider-local catalog errors, so another DSH provider stays usable.

## Turn lifecycle

For every DSH request, the adapter resolves the live Session and Agent from `sessionId`, reads the Session working directory, and derives sandbox and approval settings from logged Session state. It starts one managed App Server connection for the operation and closes the entire process tree in `finally`.

A request without an App Server replay checkpoint starts a persistent thread. A request with a checkpoint calls `thread/fork` using the exact prior thread and turn IDs. This gives DSH forks and retries independent App Server branches while preserving Codex context reuse.

Completed history after the checkpoint is converted to Responses input items and inserted before the new turn. The current trailing user text becomes the `turn/start` input. Unsupported durable content fails before the turn starts so the model never receives an incomplete history.

App Server agent-message notifications become DSH streaming text or reasoning blocks. A successful `turn/completed` notification produces a DSH stop finish plus replay state. Token-usage notifications are converted to DSH usage fields, including cached input and reasoning tokens.

## Tool-loop isolation

A global prepended `system-prompt/assemble` waterfall listener first delegates to the remaining assembly chain. When the resolved provider is `codex-app-server`, it returns the completed assembly with an empty tool list. The adapter also rejects any request that still contains DSH tool schemas.

This preserves ordinary DSH prompt assembly and model-visible logging while making Codex App Server the only tool-loop owner for that route. Other providers receive the unmodified DSH tool catalog.

## Permissions

The DSH sandbox mode maps directly to the App Server thread sandbox. DSH `never` approval maps to App Server `never`; an interactive DSH policy maps to `on-request`.

App Server command, file-change, and permission approval requests call `ctx.approval.request` with the live DSH Agent. One-shot approval accepts the App Server action. Rejection and cancellation select a fail-closed decision supported by the request. MCP elicitation is declined, and unimplemented interactive user input fails explicitly.

## Process portability

The configured executable is resolved in the subprocess provider's execution environment. POSIX binaries and native Windows executables run directly. A Windows `.cmd` or `.bat` npm shim runs through a resolved `cmd.exe`; the quoted shim path travels in a per-process environment variable, while the command tail remains fixed.

The implementation does not assume the DSH Host and App Server share the local machine. A future remote subprocess provider can serve the same plugin when it supplies the executable, workspace, environment, streams, and process-tree semantics in its execution world.
