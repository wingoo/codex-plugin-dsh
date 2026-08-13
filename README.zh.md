# codex-plugin-dsh

[English](README.md) | 中文

把本机已经安装并登录的 Codex CLI 作为 DeepSeek Harness 的一等模型提供方使用。插件启动 `codex app-server --stdio`，发现当前 Codex 账户可用的模型，并把它们放进现有的逐会话模型选择器，分组名称为 **Codex App Server (local)**。

插件不会新增 Agent Runtime 设置页，不会改变“模型／API Key”设置流程，也不要求 OpenAI API Key。选择 Codex 模型只会切换普通 DSH 模型路由背后的运行时，外围会话界面保持不变。

## 当前状态

目前已在 macOS 上使用 DeepSeek Harness `0.1.0-rc.5` 源码包、`0.1.0-rc.6` 发布包和 Codex CLI `0.144.6` 完成验证。本地 bundle 安装、模型发现、Web 端现有模型选择器以及真实的多进程 App Server 回合均已通过。Windows 批处理 shim 启动已有单元测试，首个版本发布前仍需在真实 Windows 主机上运行一次。

## 环境要求

- Node.js `^22.19.0` 或 `>=24`
- DeepSeek Harness `>=0.1.0-rc.5 <0.2.0`
- 支持 `codex app-server --stdio` 的本地 Codex CLI
- 已通过 `codex login` 登录的原生 Codex 账户

账户认证和 Codex 产品设置由 Codex CLI 自己管理。插件不读取也不保存 API Key。

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

安装后重启对应 profile。连接工作区，在输入框下方打开现有模型控件，然后在 **Codex App Server (local)** 分组中选择模型。DSH 目前没有单独的“创建会话时选择模型”入口；空白工作区会话先使用当前默认模型，也可以在发送第一条消息前通过原有模型控件切换。

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
    fallbackSandbox: read-only
```

`executable` 由 DSH 在 subprocess provider 的执行环境中解析，因此如果未来使用远程或沙箱 subprocess provider，Codex 也必须安装在同一个执行环境中。`env` 是显式子进程环境覆盖，不要把凭证写进已提交的 profile。

## 运行行为

- DSH 会话的工作区会成为 App Server thread 的工作目录。
- 当前 DSH sandbox 与 approval policy 会转换为 Codex thread 设置。
- Codex 的命令、文件修改和权限请求会先经过 DSH approval，再把决定返回给 App Server。
- 只有选择 Codex 路由时才移除 DSH tool schema。内部 agent／tool loop 由 Codex 自己负责，避免 DSH 与 Codex 出现嵌套工具循环。
- 成功回合会把 App Server thread 和 turn checkpoint 写入 DSH 模型 replay state；后续回合从这个精确 checkpoint 分叉。
- 会话从其他 DSH provider 切换到 Codex 时，已完成的文本和工具历史会通过 App Server 实验性 `thread/inject_items` 方法导入。
- App Server 进程由 DSH subprocess service 管理；模型发现、回合或插件生命周期结束时会按进程树终止。

## 已知限制

- 当前只支持文本输入，尚未把 DSH attachment 引用转换为 App Server 本地图片输入。
- 尚未实现 DSH 交互问题桥接，因此 App Server 的 `item/tool/requestUserInput` 会明确失败。
- 其他 provider 产生的 reasoning block 无法导入 App Server；插件会明确失败，而不是静默丢弃。
- 跨 provider 历史导入依赖 App Server 实验性 API。
- App Server 无法兑现的配置字段（`temperature`、`maxTokens`、`stop`）会被拒绝，不会被静默忽略。

所有权和协议细节见 [docs/architecture.md](docs/architecture.md)。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
RUN_CODEX_LIVE=1 pnpm run test:live
```

live 测试会使用宿主机现有的 Codex 登录，并发起一次真实模型请求。

## License

MIT
