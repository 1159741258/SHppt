---
status: accepted
---

# Windows 10 P0 的运行时与部署边界

P0 采用普通 Browser/Renderer 加一个本地 Node Local Daemon 的最小边界。Browser/Renderer 只负责界面、iframe 预览、`shppt-bridge v1` 和状态投影；Local Daemon 是唯一的受信任权威层，持有 Content Root、File Index、应用状态、AgentRun 和 Claude CLI 的访问权限。Electron Main 不是 P0 的前置依赖；如果以后加入 Electron，它只能作为窗口和原生能力适配层，不能改变 Daemon 的权限边界。

## 进程职责

```text
Browser/Renderer
  | HTTP 请求 / SSE 事件
  v
Local Daemon
  | spawn/execFile
  v
Claude CLI
```

| 组件 | P0 职责 | 明确禁止 |
| --- | --- | --- |
| Browser/Renderer | UI、Deck 预览和导航、Annotation 捕获、iframe Bridge、HTTP/SSE 客户端 | 访问 `fs`、启动进程、读取或写入 Content Root、携带绝对路径 |
| Local Daemon | canonical Content Root 校验、File Index、预览资源、Annotation/AgentRun/ArtifactVersion、文件监听、Claude CLI 启动和事件发布 | 把文件真相复制到 Renderer；允许请求绕过 Project 和版本校验 |
| Electron Main | P0 不需要。未来可负责窗口、原生目录选择和启动 Daemon | 直接读写 Project、启动 Claude CLI、成为第二个状态权威 |

P0 的开发入口可以由受信任的本地 launcher/CLI 接收用户选择的目录并启动 Daemon；该进程间交接不属于 Browser API，Browser 永远不提交 `contentRoot`。Daemon 必须自行规范化路径并执行 ADR-0001 与 HTML-first Project 合同中的所有边界检查。未来 Electron 的目录选择也必须通过同一个 Daemon 导入流程，不能把路径直接交给 Renderer。

## 权限与通信

- Daemon 以当前 Windows 用户权限运行，不提升为管理员；它是唯一可以读写 Content Root、写入应用状态和启动 Claude CLI 的进程。
- Claude CLI 由 Daemon 为一次 AgentRun 创建并管理，工作目录和允许写入范围由 Daemon 从 Project、File Index、Annotation 和当前 ArtifactVersion 计算。`bypassPermissions` 不是 P0 默认策略；CLI 能力探测、Session/Turn、取消和恢复由 #6 继续具体化。
- Browser/Renderer 和 Agent-facing 消息只使用 `projectId`、`fileIndexVersion` 和 Project-relative Path，不传递绝对路径或 `file://` URL。
- Daemon 只监听 loopback 的动态或可配置端口。Loopback 不是唯一安全措施：每个 Daemon 实例还必须使用短期 API 会话凭证并校验请求来源；端口、凭证和来源校验失败时拒绝请求。
- HTTP/JSON 用于命令和快照查询；一条 SSE 通道统一承载 Agent、文件和预览事件。SSE 是增量通知，Daemon 快照仍是唯一真相；WebSocket 不属于 P0 必需通信方式。
- iframe 内部消息继续使用 #5 已决定的 `shppt-bridge v1`、握手 nonce、来源校验、序列号和 ack；它与 Daemon 的 HTTP/SSE 协议分层，不用 iframe `postMessage` 代替 Daemon API。

## 状态与持久化

Daemon 在当前用户的应用数据目录维护唯一的应用状态，例如 `%LOCALAPPDATA%\SHppt\`：

- 项目注册表保存 `projectId`、展示名称、canonical Content Root、`entryPath` 和合同版本；Content Root 不写入 External Project，也不在 Renderer 状态中保存为第二份真相。
- FileIndexSnapshot、Annotation、AgentRun、事件诊断和 ArtifactVersion 的元数据保存在 Daemon 的本地持久化存储中；ArtifactVersion 的 before/after 源文件证据和 Annotation 截图保存在同一应用数据目录下的应用管理文件中。
- P0 使用本地 SQLite 元数据存储加应用数据目录中的版本证据文件；具体表结构、快照粒度、原子回退和冲突规则由 #7 决定。
- Renderer 的当前 Slide、选择模式和加载状态只是可丢弃的投影；浏览器 Local Storage、SSE 事件和 Content Root 都不是 Project 状态的权威持久化位置。
- 应用数据目录不得保存 API key、访问令牌或其他凭证；诊断和版本证据使用脱敏信息。

## 开发与打包

开发运行和打包运行从第一天起遵守同一逻辑边界和同一 HTTP/SSE 合同：

- 开发运行可以由 dev server 提供 Renderer 静态资源，但 dev server 不能直接读写 Project 或启动 Claude CLI；Browser 仍只能调用 Daemon。
- 打包运行由同一个 Daemon 负责 Project、文件、Agent 和事件。打包版可以由 launcher 打开系统 Browser；如果未来使用 Electron，Electron Main 只包裹相同的 Renderer 并以 sidecar 方式启动相同的 Daemon。
- 端口发现、会话授权、目录导入和错误状态不能只在 Electron 分支实现。P0 暂不承诺正式安装包，但任何可分发构建都必须通过这条两层边界。

## 取舍与后续边界

选择 Browser/Renderer + Daemon 而不是强制三进程，是因为 P0 的正式安装包和 Electron 集成属于范围外，当前 Windows 预检也没有 Electron 依赖；增加 Electron 不会替代 Daemon 的文件和 Agent 权威职责。选择 HTTP + SSE 而不是 WebSocket，是因为 P0 的命令/查询与单向事件流已经覆盖预览、文件和 Agent 状态同步，并保留了后续替换传输实现的空间。

该决定不宣称当前 Chrome/Edge headless 截图链路已经通过；固定渲染运行时和验收证据仍由 #9/#10 处理。#5、#6、#7、#8 可以分别细化 Bridge、AgentRun、持久化和事件语义，但不得改变本 ADR 的唯一 Daemon 权威层和开发/打包边界。
