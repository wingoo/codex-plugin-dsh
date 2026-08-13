# codex-plugin-dsh

English | [中文](README.zh.md)

Use the locally installed Codex CLI as a first-class model provider in DeepSeek Harness. The plugin starts `codex app-server --stdio`, discovers the models available to the signed-in Codex account, and adds them to the existing per-session model selector under **Codex App Server (local)**.

It does not add an Agent Runtime settings page, alter the Models/API-key settings flow, or require an OpenAI API key. Selecting a Codex model changes the runtime behind the ordinary DSH model route; the surrounding conversation UI remains the same.

## Current status

The provider has been exercised against DeepSeek Harness `0.1.0-rc.5` source packages and `0.1.0-rc.6` published packages with Codex CLI `0.144.6` on macOS. A local bundle install, model discovery, the existing Web model selector, and a real multi-process App Server turn all pass. Windows batch-shim startup has unit coverage but still needs a real Windows host run before the first release.

## Requirements

- Node.js `^22.19.0` or `>=24`
- DeepSeek Harness `>=0.1.0-rc.5 <0.2.0`
- A local Codex CLI that supports `codex app-server --stdio`
- A signed-in native Codex account (`codex login`)

The Codex CLI owns account authentication and its own product settings. The plugin does not read or store an API key.

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

Restart the selected profile after installation. Connect a workspace, open the existing model control in the composer, and select a model in the **Codex App Server (local)** group. DSH does not currently expose a separate create-time model picker; a blank workspace session uses the current default until its existing model control is changed.

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
    fallbackSandbox: read-only
```

`executable` is resolved by DSH in the subprocess provider's execution environment, so a remote or sandbox subprocess provider must make Codex available in that same environment. `env` is an explicit child-process overlay; do not put credentials in a committed profile.

## Runtime behavior

- The DSH session workspace becomes the App Server thread working directory.
- The current DSH sandbox and approval policy are translated into Codex thread settings.
- Codex command, file-change, and permission requests pass through DSH approval before App Server receives a decision.
- DSH tool schemas are removed only for the Codex route. Codex owns its internal agent/tool loop, preventing nested DSH and Codex tool loops.
- Successful turns persist the App Server thread and turn checkpoint in the DSH model replay state. Later turns fork from that exact checkpoint.
- Completed text and tool history from another DSH provider is imported through App Server's experimental `thread/inject_items` method when a session switches to Codex.
- The App Server process is owned by DSH's subprocess service and is terminated as a process tree when discovery, a turn, or the plugin lifecycle ends.

## Known limitations

- Input is text-only. DSH attachment references are not yet translated to App Server local image inputs.
- App Server `item/tool/requestUserInput` requests fail clearly because DSH interactive-question bridging is not implemented yet.
- Reasoning blocks produced by another provider cannot be imported into App Server and fail clearly instead of being dropped.
- Cross-provider history import depends on the App Server experimental API.
- Configuration fields that App Server cannot honor (`temperature`, `maxTokens`, and `stop`) are rejected instead of being ignored.

See [docs/architecture.md](docs/architecture.md) for ownership and protocol details.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
RUN_CODEX_LIVE=1 pnpm run test:live
```

The live test uses the host's existing Codex login and makes a real model request.

## License

MIT
