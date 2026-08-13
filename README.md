# codex-plugin-dsh

[English](README.en.md) | 中文

![Codex App Server 与 DeepSeek Harness 的本地 provider 架构](docs/assets/codex-dsh-hero.png)

把本机已经安装并登录的 Codex CLI 作为 DeepSeek Harness 的一等模型提供方使用。插件启动 `codex app-server --stdio`，发现当前 Codex 账户可用的模型，并把它们放进现有的逐会话模型选择器，分组名称为 **Codex App Server (local)**。

插件不会新增 Agent Runtime 设置页，不会改变“模型／API Key”设置流程，也不要求 OpenAI API Key。选择 Codex 模型只会切换普通 DSH 模型路由背后的运行时，外围会话界面保持不变。

## 当前状态

目前已在 macOS 上使用 DeepSeek Harness `0.1.0-rc.5` 源码包、`0.1.0-rc.6` 发布包和 Codex CLI `0.147.0` 完成验证。本地 bundle 安装、模型发现、Web 端现有模型选择器、真实图片输入、App Server 图片生成回写，以及 DSH 工具调用、结果续跑、附加上下文和工具目录更新均已通过真实 App Server 测试。Windows 批处理 shim 启动已有单元测试，首个版本发布前仍需在真实 Windows 主机上运行一次。

## 环境要求

- Node.js `^22.19.0` 或 `>=24`
- DeepSeek Harness `>=0.1.0-rc.5 <0.2.0`
- 本地 Codex CLI `>=0.147.0`
- 已通过 `codex login` 登录的原生 Codex 账户

账户认证和 Codex 产品设置由 Codex CLI 自己管理。插件不读取也不保存 API Key。

## 先安装 Codex CLI

本插件调用宿主机上的 Codex CLI，不会代为下载、升级或登录 Codex。按照 [OpenAI Codex CLI](https://github.com/openai/codex) 的安装方式准备本机运行时：

```sh
npm install -g @openai/codex
codex login
```

安装后确认当前 DSH 运行环境可以找到 Codex，版本不低于 `0.147.0`，并且包含 App Server：

```sh
codex --version
codex app-server --help
```

使用 `codex login` 登录即可；本插件不要求把 OpenAI API Key 填入 DSH。

## 从 GitHub 安装

仓库会提交构建后的运行文件，因此从 GitHub 安装时不需要执行安装期构建脚本：

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

如果从 DSH 源码仓库运行，请使用仓库的启动命令：

```sh
pnpm dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

在正式版本发布前，建议锁定已验证的 commit，确保安装结果可复现：

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh#<commit-sha>
```

当前 DSH `0.1.0-rc` 包在安装其 service package 时可能让 pnpm 输出 peer-dependency warning。插件已经显式拥有它在运行时导入的 package；即使出现这条 warning，全新 profile 的 GitHub 安装、Web 启动、模型发现和真实 Codex 回合都已验证通过。

## 安装本地 checkout

```sh
dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

从 DSH 源码仓库运行时：

```sh
pnpm dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

## 安装后重启和刷新

新安装的 bundle 会在 `web` profile 下次启动时进入运行配置。安装命令完成后，沿用原来的启动方式重启当前 DSH Web 服务，不要在同一端口并行启动第二个实例。服务恢复后刷新浏览器，连接工作区，在输入框下方打开现有模型控件，然后在 **Codex App Server (local)** 分组中选择模型。

如果安装由具备完整权限的 DSH Agent 执行，并且它能够确认当前服务的启动方式，也可以让它完成重启。重启会中断正在进行的对话连接，这是预期行为；用户只需在服务恢复后刷新页面。DSH 目前没有单独的“创建会话时选择模型”入口；空白工作区会话先使用当前默认模型，也可以在发送第一条消息前通过原有模型控件切换。

## 通过 DSH 对话安装

当前 DSH 会话具有完整权限时，可以把下面这段话直接发给它：

```text
请把 github:wingoo/codex-plugin-dsh 安装到当前 DSH 的 web profile，不要修改 DeepSeek Harness 源码。

1. 先确认 dsh、pnpm 和 codex 都可用，确认 codex --version 不低于 0.147.0，并确认 codex app-server --help 成功。
2. 执行 dsh plugin --profile web add github:wingoo/codex-plugin-dsh。
3. 执行 dsh --profile web --dump-config，确认 codex-app-server-provider 已进入配置。
4. 识别当前 DSH Web 服务原来的启动方式；如果可以安全复用该方式，就重启当前服务，不要在同一端口启动第二个实例。
5. 重启前提醒我：连接会暂时中断，服务恢复后刷新浏览器即可。
6. 如果无法可靠确认原启动方式，不要猜测或误杀其他进程；告诉我准确的重启命令。
```

这仍然是一次宿主机插件安装，会修改 DSH profile 并执行所安装的代码；请先确认仓库来源。

## 配置

安装后会使用安全默认值自动启用。profile 可以在自己的 `cordis.patch.yml` 中覆盖已插入的插件行：

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

`executable` 由 DSH 在 subprocess provider 的执行环境中解析，因此如果未来使用远程或沙箱 subprocess provider，Codex 也必须安装在同一个执行环境中。`env` 是显式子进程环境覆盖，不要把凭证写进已提交的 profile。

## 运行行为

- DSH Agent Loop 不会固定调用某个 HTTP API。它使用当前会话选中的 provider／model 调用 DSH LLM service；选择 Codex 后，请求路由到本插件，再通过 stdio 交给本地 Codex App Server。DSH 默认模型只影响尚未显式选择模型的新会话，不是 Codex 路由的第二个上游。
- DSH 会照常完成系统提示和工具组装。插件只接收本次请求的 `options.tools`，不会再次枚举全局工具，因此 preset、scope、allow／deny 和 code mode 的结果不会被绕过或重复。
- App Server 请求 `dsh` namespace 中的动态工具时，插件先返回普通 DSH `tool-call`。DSH Agent Loop 负责权限、调度、执行和 `tool/call`／`tool/result` 日志；下一步 Provider 调用再把结果送回仍在运行的同一个 App Server turn。插件不会自己再执行一遍工具。
- DSH 工具产生的图片结果会作为动态工具图片输出返回给 Codex；`additionalContexts` 会通过 `turn/steer` 进入同一个 turn，而不是被错误拼进工具结果。
- App Server thread 保留动态工具目录。同一目录的后续回合直接从 checkpoint fork，不重复发送；目录变化时会创建新 thread 并从 DSH 持久消息重建可导入历史。
- DSH 会话的工作区会成为 App Server thread 的工作目录，但 App Server 固定使用只读 sandbox 和 `never` approval。Codex 自带 shell、文件修改、Web、MCP、Apps、Plugins、view-image 和 multi-agent 能力会被关闭或拒绝；这些动作只能走 DSH 工具生态。
- Codex 原生 imagegen 是有意保留的例外，它由 App Server 直接完成，不进入 DSH 工具循环。
- DSH 图片附件会先由 attachment service 校验，再以内联 data URL 传给 App Server；不依赖双方共享本地文件路径。
- App Server 完成的图片生成结果会保存为 DSH 图片附件，并作为 assistant 图片显示在原有对话中。能否调用图片生成工具取决于当前 Codex 账户、模型和 App Server 能力，不要求在 DSH 中另配 OpenAI API Key。
- 成功回合会把 App Server thread、turn 和工具目录签名写入 DSH 模型 replay state；后续回合从这个精确 checkpoint 分叉。
- 会话从其他 DSH provider 切换到 Codex 时，已完成的文本、用户图片和工具历史会通过 App Server `thread/inject_items` 方法导入。
- App Server 进程由 DSH subprocess service 管理；一个进程可以跨越同一 DSH turn 的多个工具 step，回合、会话或插件生命周期结束时会按进程树终止。

## 已知限制

- 尚未实现 DSH 交互问题桥接，因此 App Server 的 `item/tool/requestUserInput` 会明确失败。
- 其他 provider 产生的 reasoning block 或 assistant 图片无法导入 App Server；工具目录变化而必须重建 thread 时，已有 Codex reasoning／assistant 图片也无法无损导入。插件会明确失败并要求新建会话，而不是静默丢弃。
- App Server 无法兑现的配置字段（`temperature`、`maxTokens`、`stop`）会被拒绝，不会被静默忽略。

所有权和协议细节见 [docs/architecture.md](docs/architecture.md)。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
RUN_CODEX_LIVE=1 pnpm run test:live
RUN_CODEX_TOOL_LIVE=1 pnpm run test:live
RUN_CODEX_IMAGE_LIVE=1 pnpm run test:live
```

三条 live 测试分别验证真实图片输入、DSH 动态工具的暂停／续跑／steer／目录继承与更新，以及图片生成和 PNG 回写。它们都会使用宿主机现有的 Codex 登录；图片生成测试只应在确实需要验证该能力时执行。

## License

MIT
