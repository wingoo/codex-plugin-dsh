# codex-plugin-dsh

English | [中文](README.md)

![Local Codex App Server provider architecture for DeepSeek Harness](docs/assets/codex-dsh-hero.png)

Use the locally installed Codex CLI as a first-class model provider in DeepSeek Harness. The plugin starts `codex app-server --stdio`, discovers the models available to the signed-in Codex account, and adds them to the existing per-session model selector under **Codex App Server (local)**.

It does not add an Agent Runtime settings page, alter the Models/API-key settings flow, or require an OpenAI API key. Selecting a Codex model changes the runtime behind the ordinary DSH model route; the surrounding conversation UI remains the same.

## Current status

The provider has been exercised against DeepSeek Harness `0.1.0-rc.5` source packages and `0.1.0-rc.6` published packages with Codex CLI `0.147.0` on macOS. A local bundle install, model discovery, the existing Web model selector, real image input, App Server image-generation output, DSH tool execution, continuation, extra context, and tool-catalog changes all pass against a real App Server. Windows batch-shim startup has unit coverage but still needs a real Windows host run before the first release.

## Requirements

- Node.js `^22.19.0` or `>=24`
- DeepSeek Harness `>=0.1.0-rc.5 <0.2.0`
- A local Codex CLI `>=0.147.0`
- A signed-in native Codex account (`codex login`)

The Codex CLI owns account authentication and its own product settings. The plugin does not read or store an API key.

## Install Codex CLI first

This plugin invokes the Codex CLI on the DSH host. It does not download, upgrade, or sign in to Codex for you. Prepare the local runtime using the [OpenAI Codex CLI](https://github.com/openai/codex) installation:

```sh
npm install -g @openai/codex
codex login
```

Confirm that Codex is visible in the environment where DSH runs, is at least version `0.147.0`, and includes App Server:

```sh
codex --version
codex app-server --help
```

Signing in with `codex login` is sufficient; the plugin does not require an OpenAI API key in DSH.

## Install from GitHub

The repository includes built runtime files, so a GitHub installation does not need to run an install-time build script:

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

When running DSH from its source checkout, use its launcher instead:

```sh
pnpm dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

Until a versioned release exists, pin a tested commit for a reproducible installation:

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh#<commit-sha>
```

Current DSH `0.1.0-rc` packages can make pnpm print a peer-dependency warning while installing their service packages. The plugin owns the runtime packages it imports; a clean-profile GitHub install, Web startup, model discovery, and real Codex turn have been verified despite that warning.

## Install a local checkout

```sh
dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

From a DSH source checkout:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

## Restart and refresh

The newly installed bundle enters the runtime configuration the next time the `web` profile starts. After installation, restart the current DSH Web service using its original launch method; do not start a second instance on the same port. When the service is available again, refresh the browser, connect a workspace, open the existing model control in the composer, and select a model in the **Codex App Server (local)** group.

When a fully privileged DSH Agent performs the installation and can identify the service's launch method, it can also complete the restart. The active conversation connection will be interrupted, which is expected; the user only needs to refresh after the service returns. DSH does not currently expose a separate create-time model picker; a blank workspace session uses the current default until its existing model control is changed.

## Install through a DSH conversation

In a DSH session with full host permissions, send it this prompt:

```text
Install github:wingoo/codex-plugin-dsh into the current DSH web profile without modifying DeepSeek Harness source.

1. Confirm that dsh, pnpm, and codex are available, that codex --version is at least 0.147.0, and that codex app-server --help succeeds.
2. Run dsh plugin --profile web add github:wingoo/codex-plugin-dsh.
3. Run dsh --profile web --dump-config and confirm that codex-app-server-provider is present.
4. Identify how the current DSH Web service was originally launched. If that method can be reused safely, restart the current service without starting a second instance on the same port.
5. Before restarting, tell me that the connection will be interrupted and that I should refresh the browser after the service returns.
6. If the original launch method cannot be determined reliably, do not guess or kill unrelated processes; give me the exact restart command instead.
```

This is still a host-level plugin installation that modifies the DSH profile and executes installed code. Verify the repository source first.

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
