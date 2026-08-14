# codex-plugin-dsh

English | [中文](README.md)

![Local Codex App Server provider architecture for DeepSeek Harness](docs/assets/codex-dsh-hero.png)

Use the Codex account already signed in on your computer directly from DeepSeek Harness. No OpenAI API key needs to be configured in DSH. After installing the plugin and restarting DSH, select a model from **Codex App Server (local)** in the existing model selector and start chatting.

DSH continues to own the conversation and tool execution, so the existing DSH plugin and tool ecosystem remains available. Model requests reach the current Codex account through the local Codex App Server. The plugin also supports image input and writes native Codex image-generation results back into the DSH conversation.

## Quick install through DSH

In a DSH session with full host permissions, send this prompt:

```text
Install github:wingoo/codex-plugin-dsh into the current DSH web profile without modifying DeepSeek Harness source.

1. Check whether a Codex CLI version that satisfies the plugin requirements is installed. If it is missing or outdated, install or upgrade it using the official OpenAI method.
2. Run codex login status. If Codex is not signed in, ask me to run codex login in a terminal on the DSH host. Wait until I complete the browser flow and reply "signed in" before continuing.
3. Confirm that codex app-server --help succeeds.
4. Install the plugin and use dsh --profile web --dump-config to confirm that codex-app-server-provider is loaded.
5. Restart the current DSH Web service using its original launch method without starting a second instance on the same port. Before restarting, tell me that the connection will be interrupted.
6. When the service returns, tell me to refresh the page and select Codex App Server (local) in the existing model selector.

If the original launch method cannot be determined reliably, do not guess or terminate unrelated processes. Give me the exact restart command instead.
```

This modifies the DSH profile and executes plugin code on the host, so verify the repository source first. The active connection will briefly drop during the restart; refresh the page after the service returns.

## Install from the command line

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

When running DeepSeek Harness from its source checkout:

```sh
pnpm dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

Before a versioned release exists, pin a tested commit for a reproducible installation:

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh#<commit-sha>
```

## Install a local checkout

```sh
dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

From a DeepSeek Harness source checkout:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

## Use it after installation

Restart DSH Web using its original launch method; do not start a second instance on the same port. When the service returns, refresh the browser, open the existing model selector below the composer, and select a model from **Codex App Server (local)**.

A blank workspace initially uses the current default model. You can switch to Codex before sending the first message.

## Requirements

- Node.js `^22.19.0` or `>=24`
- DeepSeek Harness `>=0.1.0-rc.5 <0.2.0`
- A local Codex CLI `>=0.147.0`
- A Codex account signed in through `codex login`

### Prepare the Codex CLI

The plugin uses the Codex CLI installed on the DSH host. It does not download, upgrade, or sign in to Codex for you. Prepare the runtime using the [OpenAI Codex CLI](https://github.com/openai/codex) installation:

```sh
npm install -g @openai/codex
codex login
```

Confirm that Codex is visible in the environment where DSH runs and that App Server is available:

```sh
codex --version
codex app-server --help
```

Codex CLI owns account authentication and product settings. The plugin does not read or store an API key, and no OpenAI API key needs to be entered in DSH.

## Current status

The provider has been exercised on macOS against DeepSeek Harness `0.1.0-rc.5` source packages and `0.1.0-rc.6` published packages with Codex CLI `0.147.0`. A local bundle install, model discovery, the existing Web model selector, real image input, App Server image-generation output, DSH tool execution, continuation, extra context, and tool-catalog changes all pass against a real App Server.

Windows batch-shim startup has unit coverage but still needs a real Windows host run before the first release. Current DSH `0.1.0-rc` packages may print a peer-dependency warning while installing their service packages; the plugin declares its runtime dependencies explicitly, and clean-profile GitHub installation, Web startup, model discovery, and real Codex turns have been verified despite that warning.

## Configuration

Installation activates the provider with safe defaults. A profile can override the inserted plugin row in its own `cordis.patch.yml`:

```yaml
- id: codex-app-server-provider
  config:
    executable: codex
    env: {}
    modelCacheMs: 30000
    catalogTimeoutMs: 10000
    turnTimeoutMs: 600000
    disposeGraceMs: 3000
    stderrMaxBytes: 16384
    modelPageSize: 100
```

`executable` is resolved by DSH in the subprocess provider's execution environment, so a remote or sandbox subprocess provider must make Codex available in that same environment. `env` is an explicit child-process overlay; do not put credentials in a committed profile.

## Runtime behavior

- The DSH Agent Loop does not call a fixed HTTP API. It sends the current Session's selected provider and model through the DSH LLM service; selecting Codex routes the request to this plugin and then over stdio to the local Codex App Server. A DSH default model only affects new Sessions without an explicit selection and is not a second upstream for the Codex route.
- DSH assembles its system prompt and tools normally. The plugin consumes only that request's `options.tools`; it never enumerates the global registry again, so preset, scope, allow/deny, and code-mode decisions are neither bypassed nor duplicated.
- When App Server requests a dynamic tool in the `dsh` namespace, the plugin first emits an ordinary DSH `tool-call`. The DSH Agent Loop owns permission checks, scheduling, execution, and `tool/call` / `tool/result` logs. The next Provider step returns the result to the same still-running App Server turn; the plugin does not execute the tool a second time.
- DSH image tool results return to Codex as dynamic-tool image output. Tool `additionalContexts` enter the active turn through `turn/steer` instead of being folded into the tool result.
- An App Server thread retains its dynamic-tool catalog. Later turns with the same catalog fork from the checkpoint without retransmitting it. A changed catalog starts a new thread and rebuilds all importable history from durable DSH messages.
- The DSH workspace is the App Server thread working directory, but App Server is pinned to a read-only sandbox and `never` approval. Codex-native shell, file mutation, Web, MCP, Apps, Plugins, view-image, and multi-agent capabilities are disabled or denied; those actions must use DSH tools.
- Native Codex image generation is the intentional exception. App Server performs it directly instead of routing it through the DSH tool loop.
- DSH image attachments are verified by the attachment service and sent to App Server as inline data URLs, without relying on a shared local filesystem path.
- Completed App Server image generations are saved as DSH image attachments and displayed as assistant images in the existing conversation. Image-generation availability depends on the selected Codex account, model, and App Server capabilities; no separate OpenAI API key is required in DSH.
- Successful turns persist the App Server thread, turn, and tool-catalog signature in the DSH model replay state. Later turns fork from that exact checkpoint.
- Completed text, user-image, and tool history from another DSH provider is imported through App Server's `thread/inject_items` method when a session switches to Codex.
- The App Server process is owned by DSH's subprocess service. One process may span several tool steps in the same DSH turn, and the process tree is terminated when the turn, Session, or plugin lifecycle ends.

## Known limitations

- App Server `item/tool/requestUserInput` requests fail clearly because DSH interactive-question bridging is not implemented yet.
- Reasoning blocks or assistant images produced by another provider cannot be imported into App Server. If a changed tool catalog requires a thread rebuild, prior Codex reasoning or assistant images also cannot be imported losslessly. The plugin fails clearly and asks for a new Session instead of dropping them.
- Configuration fields that App Server cannot honor (`temperature`, `maxTokens`, and `stop`) are rejected instead of being ignored.

See [docs/architecture.md](docs/architecture.md) for ownership and protocol details.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
RUN_CODEX_LIVE=1 pnpm run test:live
RUN_CODEX_TOOL_LIVE=1 pnpm run test:live
RUN_CODEX_IMAGE_LIVE=1 pnpm run test:live
```

The live commands cover real image input; dynamic DSH tool pause/resume, steering, catalog inheritance, and catalog replacement; and image generation with PNG persistence. They use the host's existing Codex login. Run the image-generation case only when that provider action is intended.

## License

MIT
