# P0 测试、视觉质量与验收证据

状态：已决定，验收合同版本 `1`

对应票据：[P0 测试、视觉质量与验收证据](https://github.com/1159741258/SHppt/issues/10)

上游合同：[P0 MVP：视觉标记驱动的 Agent PPT 编辑器](./p0-mvp-acceptance.md)、[P0 HTML-first Project 与 Deck 合同](./html-first-project-deck-contract.md)、[Windows 10 CLI 与渲染前置条件核验](../diagnostics/windows-10-preflight-2026-09-21.md)。Claude CLI、ArtifactVersion 和文件事件合同分别由 [#6](https://github.com/1159741258/SHppt/issues/6)、[#7](https://github.com/1159741258/SHppt/issues/7) 和 [#8](https://github.com/1159741258/SHppt/issues/8) 决定。

本文件把 P0-01 至 P0-10 落成可重复的测试和证据要求。它决定验收门槛、最小夹具、测试替身和失败产物；不引入新的产品能力，也不把当前尚未存在的测试框架或浏览器实现假定为已完成。

## 1. 决策摘要

P0 只能在固定 HTML Project 上用四层证据判定完成：

1. **合同测试**证明 HTML、DOM、Project-relative Path、File Index、Annotation 上下文和版本引用符合既有合同。
2. **Daemon 集成测试**证明 Claude CLI 的能力探测、AgentRun、side-effect ledger、ArtifactVersion、文件事件、预览状态和失败恢复在真实进程边界内协作。
3. **Windows 10 端到端测试**证明 Browser/Renderer、Local Daemon、浏览器预览和用户操作可以完成 P0 闭环。Electron 不是该门槛的前置依赖。
4. **截图和视觉回归**证明固定 Slide 在稳定渲染后没有未经审查的布局、字体、资源或溢出回归。

四层的必要测试都必须为 `passed`。`skipped`、`blocked`、`quarantined` 或只有日志没有断言的测试都不能算作通过；失败时仍必须生成本文件规定的证据包。真实 Claude CLI 的网络/鉴权 smoke test 可以不进入每次提交的快速测试，但在声明 P0 可用的 Windows 环境验收时必须有新鲜证据。

P0 的成功条件是证据条件，不是“测试命令返回 0”这一单一条件。以下事实必须同时成立：

- P0-01 至 P0-10 每个场景都有测试结果和可追溯的证据条目；
- 正常修改经过稳定扫描、ArtifactVersion 生成和 `preview ready` 后只能进入 `needs_review`，不能自动进入 `resolved`；
- 失败、越界、副作用不确定、外部冲突和回退中断都保留可诊断状态，不能被清理成成功；
- 视觉回归使用固定渲染环境和已审查基线；浏览器安装存在但无法完成 DOM/截图链路时，视觉门槛为阻塞；
- 证据中没有凭证、绝对 Content Root、完整用户 Prompt 或未经用户明确导出的完整源文件。

## 2. 测试层和运行入口

实现可以选择测试框架，但必须提供四个彼此独立、可单独运行的 suite 入口。命令名称不属于本合同；每次运行的 Evidence Manifest 必须记录实际命令模板（敏感参数脱敏）、工作目录标识、筛选参数和退出码。

| Suite | 运行内容 | 外部依赖 | P0 门槛 |
| --- | --- | --- | --- |
| `contract` | HTML/DOM、路径、File Index、Annotation/Bridge 消息和版本引用 | 固定夹具；不得访问网络或真实凭证 | 每次变更必须通过 |
| `integration` | Local Daemon、真实子进程边界、fake CLI、fake watcher、ArtifactVersion 和事件流 | 临时 Project；不需要真实模型 | 每次变更必须通过 |
| `windows-e2e` | Browser/Renderer + Local Daemon + 固定浏览器运行时的 P0-01 至 P0-10 | Windows 10、固定夹具；CLI 行为使用可控 provider seam | 发布验收必须通过 |
| `visual` | 稳定渲染截图、结构检查和视觉差异 | 固定浏览器、字体、viewport、DPR | 发布验收必须通过 |

快速测试可以并行运行，但 `windows-e2e` 和 `visual` 的最终证据必须来自同一份固定夹具和同一份实现构建。测试 runner 必须支持单独重跑失败场景，并把测试输入版本写入 Evidence Manifest；不能依靠测试顺序、机器当前目录或上一次运行留下的应用状态。

### 2.1 测试替身的边界

- `FakeAgentProvider` 只替代 CLI 的外部模型决策，不替代 Daemon 的 spawn、stdin、stdout、退出、文件扫描、权限和回退路径。集成测试应启动一个受控 fake CLI 子进程，发送与 `stream-json` 相同边界的 JSONL frame。
- `FakeWatcher` 和可注入时钟只用于确定性地触发 add/change/unlink、watcher error、稳定等待和 polling tick。至少要有一次 Windows smoke test 使用真实 `System.IO.FileSystemWatcher` 或最终选定的 watcher 实现。
- 测试替身不能让被测模块直接获得绝对 Content Root、真实 API key 或完整用户源文件。测试向浏览器和 Agent-facing 层传递的仍是 `projectId`、`fileIndexVersion` 和 Project-relative Path。
- 真实 Claude CLI 只用于能力/协议 smoke test，不用不可重复的模型内容生成作为视觉 golden 或文本精确断言。实际 AgentRun 的范围、版本、文件事件和恢复行为必须由 fake CLI 场景覆盖。

## 3. 最小固定 HTML Project 夹具

合同测试和 Windows 端到端测试共同使用 `tests/fixtures/p0-deck/`。runner 每次把它复制到新的临时 Content Root；测试不得原地修改版本库中的夹具。

```text
tests/fixtures/p0-deck/
  shppt.json
  index.html
  styles/deck.css
  assets/fixture-mark.svg
  assets/fixture-font.woff2
```

夹具的最小内容如下：

- `shppt.json` 使用 `schemaVersion: 1`，入口为 `index.html`；单独复制一份去掉 manifest 的变体，用于证明无 manifest 时只回退到根部 `index.html`。
- `index.html` 有两个 16:9 Slide root，`data-od-slide` 分别为 `cover` 和 `detail`，文档顺序固定；每个 Slide 都有非零矩形和稳定的 `data-od-id`。
- `cover` 至少包含 `cover-title`；`detail` 至少包含 `detail-title`、`detail-card` 和 `detail-mark`。这些 ID 在整个 Deck 中全局唯一，且 `detail-mark` 使用本地图片 Resource。
- `deck.css` 是本地 CSS Resource，包含字体声明、固定网格、文本、图片和直接布局关系，足以覆盖点击、框选、视觉区域、字体加载和样式修改路径。不得引用网络字体、CDN 或 Content Root 外文件。
- `fixture-mark.svg` 是固定字节的本地图片；`fixture-font.woff2` 是固定字节、可合法再分发的测试字体。字体实际 hash、浏览器版本和字体加载结果必须进入截图元数据。
- 夹具不得依赖当前时间、随机数、网络、系统用户目录、系统主题或未声明的 Windows 字体。资源加载失败时测试应失败，不能静默使用另一份同名资源。

夹具不需要为每个错误创建一份永久目录。路径越界、重复 Slide ID、重复 Stable Element ID、远程 URL、受保护目录和 reparse point 等无效变体由 runner 在临时 Content Root 中从固定夹具生成，并在测试后清理；生成的变体名称和内容 hash 要进入测试结果。

视觉基线至少包含：`cover` 和 `detail` 的初始截图、一次只修改 `detail-title` 的确定性 AgentRun 截图，以及该 Run 回退后的截图。正常、越界、预览错误和字体失败的诊断截图按需产生，不得用错误页截图冒充正常基线。

## 4. HTML/DOM 和合同测试

合同测试必须断言结构化结果和错误码，而不是只断言页面“看起来能打开”。至少包含以下用例：

| ID | 用例 | 必须证明的结果 |
| --- | --- | --- |
| `HTML-01` | 合法 manifest + 固定夹具 | 产生一个 `html-deck` Project、一个 Entry Document、两个按文档顺序排列的 Slide 和完整 File Index；`projectId` 不由路径或 HTML 内容推导 |
| `HTML-02` | 无 manifest、根部 `index.html` | 只使用根部 `index.html`；不递归寻找其他 HTML、不按文件名或时间猜测入口 |
| `HTML-03` | manifest entry 不存在、越界、非 HTML、受保护或 reparse point | 返回明确的 `PROJECT_ENTRY_*`/`PROJECT_PATH_ESCAPE` 错误；不回退到 `index.html`，不进入可编辑状态 |
| `HTML-04` | Slide 缺失、非法、重复、嵌套、位于错误节点或尺寸不一致 | 拒绝 Project 或 Deck，并保留旧的成功 snapshot；不猜测另一个 Slide |
| `HTML-05` | Stable Element ID 缺失、重复、非法、跨 Slide 或移出 Slide | 精确绑定只接受合法全局唯一 ID；视觉区域仍能保存但明确是 Slide/几何上下文，不能声称精确绑定 |
| `HTML-06` | 相对、根相对、`../`、远程、`file:`、动态 Resource 和静态 CSS/字体/脚本引用 | 合法引用转换为 Project-relative Path；越界、远程、动态不支持和受保护路径返回合同错误，不提供相似路径回退 |
| `HTML-07` | Windows 大小写、分隔符、`.` 段、canonical path、junction/symlink/reparse point | 只接受合同允许的规范化路径；对外消息无盘符、UNC、绝对路径和 `..` 段 |
| `HTML-08` | File Index snapshot 传给预览、Annotation 和 AgentRun | 三者引用同一 `projectId + fileIndexVersion`、`path + contentHash` 视图；旧版本不存在或过期时显式失败 |
| `HTML-09` | `shppt-bridge v1` 握手、来源、nonce、序列号、ack 和旧 iframe 消息 | 只接受活动 iframe 和正确版本的消息；重复消息幂等，旧实例或未知来源被丢弃 |
| `HTML-10` | 点击、框选、画笔和文字 Annotation 捕获 | 保存 Slide ID、捕获时的 slideIndex、截图/几何、可用 Stable Element ID、源文件和版本；截图或 DOM 复核失败不伪造精确锚点 |

每个用例至少输出：测试 ID、输入夹具 hash、结果错误码或状态、`projectId`（可脱敏为稳定测试标识）、`fileIndexVersion`、Project-relative Path 列表和断言摘要。HTML/DOM 测试不得把绝对 Content Root 写入 JSON、浏览器消息或失败文本。

## 5. Claude CLI 和 AgentRun 集成测试

### 5.1 必须覆盖的 fake CLI 场景

fake CLI 以真实子进程运行，并能按场景脚本控制 frame 顺序、退出码、延迟、写入和重复输出。至少包含：

| ID | 场景 | 必须保留的判定 |
| --- | --- | --- |
| `CLI-01` | CLI 不存在、未鉴权、缺少 stream-json/verbose/add-dir/非 bypass 能力 | Run 在启动前失败，Annotation 保留，不创建成功 ArtifactVersion |
| `CLI-02` | 两个版本字符串不同但 help/握手能力相同 | 参数由 capability snapshot 决定，而不是由版本号猜测；实际 provider/model 从 frame 记录 |
| `CLI-03` | 新 Session、合法 resume、基线/provider/model/权限/MCP 不匹配的 resume | 合法条件才发送 `--resume`；不匹配返回可操作错误，不静默改成新 Session |
| `CLI-04` | 恶意 Annotation 文本、超范围 source path 或要求改其他 Slide/全局主题 | Prompt 中用户文字不能扩大 Hard Scope；启动前拒绝或运行后以 scope violation 失败 |
| `CLI-05` | 正常 stream、重复 frame、重复 `toolUseId`、多个 terminal frame、EOF | 规范化事件和 `turn.ended`/`run.terminal` 幂等；不同 source cursor 的相同文本不被错误去重 |
| `CLI-06` | 正常退出但无变化、允许范围内单文件变化、多文件变化 | 分别得到 `NO_EFFECT` 或一个可审查 candidate ArtifactVersion；实际文件事实来自稳定 snapshot，不来自 CLI 声称 |
| `CLI-07` | 非零退出前已写入、取消前已写入、Daemon 重启后存在未终态 Run | 进入失败/`needs_review`/恢复路径，保留 side-effect ledger，禁止盲目重试 |
| `CLI-08` | 写入其他 Slide、全局 CSS、未授权文件、删除/重命名或 Content Root 外路径 | 不可 confirm；before/after、路径和错误码保留，能进入回退或人工处理 |
| `CLI-09` | 取消重复调用、重试和事件重连 | 取消幂等；重试创建新的 AgentRun/Turn 并关联 `retryOf`；重连先取 snapshot 再按序应用事件 |
| `CLI-10` | 超大文本、工具结果和含敏感值的 stderr | 只保留摘要、ID、路径、hash、状态和 terminal 证据；凭证、完整 Prompt、完整源文件和图片不进入导出的诊断包 |

集成断言还要检查 Daemon 的实际进程边界：浏览器没有启动 CLI；cwd、`--add-dir` 和 writePaths 由 Daemon 计算；正常 AgentRun 不使用 `bypassPermissions` 或仅用于探测的 `--no-session-persistence`；绝对路径只存在于受信任的 spawn 状态，不出现在 Agent-facing 事件和浏览器响应中。

### 5.2 真实 Claude CLI smoke test

Windows 10 验收环境必须用实际配置的 Claude CLI 做一次无写入 smoke test。测试使用新的临时目录和无工具、非 bypass 权限模式，要求 `--verbose` 与 `stream-json` 输入/输出协议；不得把 smoke test 指向用户 Content Root，也不得把 API key 或完整环境变量写入证据。

smoke test 只断言：可执行文件可启动、能力探测结果、认证状态分类、协议终点、实际 `provider`/`model`/能力标志和无文件副作用。它不对模型回复文本、费用或供应商名称做固定断言。若 CLI 缺失、未鉴权、协议失败或当前进程不能安全完成测试，结果必须为 `blocked` 或 `failed` 并保留诊断；不能以 fake CLI 的通过结果替代真实环境证据，也不能把“CLI 已安装”当作预览/截图通过。

## 6. 文件事件、预览和回退测试

这些测试使用 fake watcher、注入时钟和临时 Content Root 进行确定性验证，并用真实 Windows watcher 做一次最小 smoke test。不能用固定 sleep 或 OS 事件到达次数作为唯一断言。

| ID | 场景 | 必须证明的结果 |
| --- | --- | --- |
| `WATCH-01` | 多窗口、多 PreviewSession acquire/release | 同一 canonical Content Root 复用一个 watcher；最后一个 lease 释放后才关闭；关闭期间的变化由下一次完整 snapshot 发现 |
| `WATCH-02` | 分块写 HTML/CSS、临时文件 rename-save、重复 change | 稳定检查前不刷新、不产生半份 File Index；相邻检查的存在性、size、mtime、contentHash 稳定后只发布一个完整版本 |
| `WATCH-03` | add/change/unlink、受保护路径和扫描失败 | 事件只携带 Project-relative Path；完整 scan 失败保留旧 snapshot，发布 `project.scan-failed` 并使预览至少为 `stale` |
| `WATCH-04` | watcher 创建失败、`ENOSPC`/`EMFILE`/overflow、polling tick | 切换到 polling fallback，沿用同一 registry、稳定检查、事件 envelope 和诊断字段；不得为每个窗口重复创建 watcher |
| `WATCH-05` | watcher 与 polling 都不可用 | 返回 `WATCHER_UNAVAILABLE`，预览不伪装为 `ready`，当前版本和失败原因可查看 |
| `WATCH-06` | SSE 新连接、连续重放、epoch 变化、cursor gap | 新连接先获得 snapshot；同 epoch 连续游标按序重放；epoch 不同、缺口或过期时要求 `resync` |
| `WATCH-07` | Agent 多文件写入、失败后写入、外部编辑同一文件 | 稳定 scan 前不宣布完成；来源不明、基线后外部修改和范围外变化进入 conflict/recovery，不覆盖外部变化 |
| `WATCH-08` | preview loading/stale/error/expired 和 iframe 切换 | 旧实例先为 `stale`，新实例只有完成版本、Bridge、Resource、Slide 检查后才为 `ready`；旧消息、过期 scope 和失败加载不改变活动实例 |
| `WATCH-09` | confirm、rollback、回退中断和重启恢复 | confirm 需要当前版本和 `preview ready`；rollback 先检查全部 after 前置条件，恢复精确 before 字节并产生新的 ArtifactVersion；冲突或 journal 未完成时不报告成功 |

事件测试要检查 `streamEpoch`/sequence、`fileIndexVersion`、`artifactVersionId`、`runId`、preview session/iframe 身份和 origin。完整源文件字节只放在受保护的 ArtifactVersion 证据存储中；事件、日志和导出包使用 hash、size 和相对路径。

## 7. Windows 10 端到端验收

端到端 runner 在 Windows 10 交互式用户会话中启动 Local Daemon 和固定浏览器运行时，通过 HTTP/SSE 完成真实 Browser/Renderer 流程。Electron 不得作为隐式替代。每次运行记录 OS build、PowerShell/Node、Daemon 构建标识、浏览器可执行文件版本、渲染模式、viewport、DPR、字体 hash、端口发现结果和测试夹具 hash。

P0-01 至 P0-10 的最小映射如下：

| 场景 | E2E 操作和证据 |
| --- | --- |
| `P0-01` 打开 Deck | 导入固定 Project；证明 `loading -> ready`、Entry Document、两个 Slide 的导航和对应 Slide ID；保存 DOM/状态摘要与两页截图 |
| `P0-02` 点击标记 | 点击 `cover-title` 或 `detail-title`；证明高亮、Annotation 保存、Stable Element ID、截图和版本引用 |
| `P0-03` 框选标记 | 框选 `detail-card` 内的多个目标；证明成员 ID、Slide-local 几何、截图、文字要求和 capture File Index |
| `P0-04` 视觉标记 | 在没有唯一 Stable Element ID 的区域画笔或添加文字；证明 Annotation 保存为视觉/Slide 上下文并标明定位风险 |
| `P0-05` 定向修改 | 通过 fake CLI 只修改 `detail-title`；证明 Hard Scope、允许 writePaths、side-effect ledger、candidate ArtifactVersion 和 `needs_review` |
| `P0-06` 自动刷新 | 对 HTML/CSS 做分块稳定写入；证明稳定前 preview 不刷新，稳定后获得新 `fileIndexVersion` 并进入 `ready`；刷新错误保留 `stale/error` |
| `P0-07` 失败不丢失 | 分别模拟 CLI 不可用、进程失败、目标丢失和预览刷新失败；证明 Annotation、错误、版本输入和副作用证据仍可查看 |
| `P0-08` 确认或回退 | 在 `preview ready` 后 confirm；另一次运行执行 rollback；证明 `resolved` 只由 confirm 产生，回退恢复确切源字节、刷新预览并保留原 Annotation |
| `P0-09` 越界保护 | fake CLI 尝试修改其他 Slide、全局主题或未授权文件；证明运行不可确认成功，保存 scope evidence 并可回退/人工处理 |
| `P0-10` 外部冲突 | AgentRun 期间从外部修改同一 Project 文件；证明冲突、before/after 和两方版本保留，不静默覆盖或确认 |

P0-05、P0-07 至 P0-10 的 Agent 行为必须可通过 fake provider 重放；真实 Claude smoke test 单独验证 CLI 环境和协议。这样不会把不可控的模型输出混入文件、回退和视觉回归的确定性验收。

浏览器 headless 启动成功不等于 E2E 通过。必须至少完成一次 Bridge 握手、读取到正确的 `FileIndexSnapshot`、绘制出非空 Slide 矩形并取得有效截图。若当前环境重复出现既有诊断中记录的 Chrome/Edge 非零退出且无 DOM/截图产物，E2E/visual 结果为 `blocked`，不得宣布 P0 完成，且必须保留进程命令摘要、退出码、stderr/crash 诊断（如有）和环境元数据。

## 8. 截图和视觉回归

### 8.1 固定渲染条件

截图只在 `preview ready` 且目标 `fileIndexVersion` 与活动 iframe 实例一致时执行。最小固定条件为：

- 两个 Slide 均以 16:9、`1600x900` CSS viewport、DPR `1` 捕获；截图只包含 Slide，不包含浏览器 chrome；
- 等待 Entry Document、CSS、图片和字体完成，记录每个必要 Resource 的 loaded/failed 状态；
- 捕获前冻结 CSS animation/transition 和时间相关状态；动态内容、随机数、网络请求和当前时间都不能影响截图；
- 记录浏览器 executable/version、渲染模式、操作系统 build、viewport、DPR、字体文件 hash、夹具 hash、应用构建标识和目标 `fileIndexVersion`；
- 每页固定输出尺寸和 PNG 编码；截图失败返回明确错误，不生成占位错误页作为基线。

### 8.2 最小视觉断言

视觉回归同时包含自动差异和人工审查：

1. Slide 根矩形、宽高比、viewport、字体加载和关键 Resource 必须满足 DOM/布局断言；文本溢出、越界、非预期空白或遮挡属于失败，即使像素差低于阈值也不能通过。
2. 对相同浏览器构建、viewport、DPR 和字体 hash，按通道容差 `8/255` 计算像素差；超过容差的像素比例默认不得超过 `0.5%`。阈值配置和实际指标必须写入 Evidence Manifest，不能只保存一个“视觉通过”布尔值。
3. 任何有意的视觉变化必须同时提交新的基线、差异图、变化说明和人工批准记录；测试不能在发现差异后自动更新基线。
4. 不同浏览器、不同字体或不同渲染模式的截图不能直接互相比较。它们必须使用各自标识的基线，或者只运行结构化布局测试并将视觉结果标记为 `blocked`。

最小视觉证据包含初始 `cover`/`detail`、确定性修改后的 `detail` 和回退后的 `detail`。回退后的源文件、File Index、ArtifactVersion 关系和截图应与运行前状态相符；证据仍必须显示这是一次新的 rollback ArtifactVersion，而不是删除运行记录。

## 9. 失败时必须保留的证据

每次 suite 生成一个相对路径根目录下的 Evidence Bundle，并以 `manifest.json` 作为入口。最小形状如下；所有 `path` 都是证据包内相对路径，不是 Windows 绝对路径。

```json
{
  "schemaVersion": 1,
  "suite": "windows-e2e",
  "outcome": "passed|failed|blocked",
  "testRunId": "opaque-id",
  "fixtureId": "p0-deck",
  "fixtureHash": "sha256:...",
  "command": "actual command template with sensitive arguments redacted",
  "tests": [{ "id": "P0-07", "status": "failed", "evidence": [".../failure.json"] }],
  "environment": { "osBuild": "...", "browserVersion": "...", "viewport": "1600x900", "dpr": 1 },
  "artifacts": [{ "kind": "screenshot", "path": "screenshots/detail.png", "sha256": "..." }],
  "redactions": ["absolute paths", "credentials", "full prompts", "user source bytes"]
}
```

### 9.1 所有失败至少保留

- `manifest.json`、测试 ID、输入夹具 hash、实际命令摘要、构建/环境版本、时间、随机种子或注入时钟配置、稳定等待/polling 配置和退出码；
- Daemon 生命周期、AgentRun 状态、Turn/Session 标识、`fileIndexVersion`/`artifactVersionId`、preview 状态、iframe 实例、事件 sequence/epoch 和错误码；
- 能力探测结果，包括实际 provider/model 和支持的能力；认证只保留 `authenticated`/`unauthenticated`/`unknown` 分类；
- before/after File Index 摘要、Project-relative Path、存在性、size、mtime（如合同需要）、contentHash、允许集合和 scope violation；
- side-effect ledger、terminal reconciliation 结果、进程退出/取消/超时信息、watcher 与 polling 状态、SSE 重连或 resync 记录；
- 预览失败的浏览器 console/网络/Bridge 摘要、有效截图或截图失败原因；视觉失败的 baseline/current/diff 图片和实际像素指标；
- ArtifactVersion 的 changeSet 和 rollback journal 摘要。需要精确回退的 before/after 字节必须在受保护的应用数据证据存储中保留，导出包默认只带 hash、size 和引用。

### 9.2 按失败类型追加

| 失败 | 额外必须保留 | 禁止的替代结论 |
| --- | --- | --- |
| CLI 启动/能力失败 | 脱敏 help/探测结果、命令形状、阶段、退出码和用户动作 | 不得以 CLI 已安装或 fake CLI 通过宣布 AgentRun 可用 |
| CLI 已写入后崩溃/取消 | 精确 side-effect ledger、before/after hash/字节引用、恢复状态和禁止重试原因 | 不得只记录非零退出码或删除临时 Project |
| watcher/polling 失败 | 原始错误类别、fallback 转换、稳定检查批次、最后成功 snapshot | 不得把旧预览标为新版本 `ready` |
| HTML/DOM/Bridge 失败 | 夹具变体、错误码、snapshot 版本、消息来源/实例摘要、DOM/console 诊断 | 不得选择“最接近”的 Slide/元素继续 AgentRun |
| 浏览器启动/截图失败 | executable/version、渲染参数、退出码、stderr/crash 产物（如有）、是否取得 DOM/像素 | 不得用空白页、错误页或浏览器安装事实冒充视觉通过 |
| scope violation/外部冲突 | 竞争路径、before/after、来源分类、冲突版本和用户动作 | 不得覆盖外部变化、自动合并或把 Annotation 标为 `resolved` |
| rollback 失败/中断 | 前置条件结果、journal、已应用步骤、恢复状态和可执行人工动作 | 不得报告部分回退成功 |

证据包可以在上传或交接前脱敏，但脱敏动作、被移除的字段和原包 hash 必须记录。默认禁止写入或导出 API key、访问令牌、环境变量原文、完整 Prompt、Content Root 绝对路径、用户未授权的完整源文件和图片内容。测试夹具截图属于固定测试资源；真实用户项目截图仍需按相同规则处理。

## 10. 判定和交付规则

宣布 P0 完成前，验收记录必须包含：

1. 四个 suite 的实际命令和结果；所有必需测试为 `passed`，没有未解释的 `blocked` 或 `skipped`。
2. `HTML-01` 至 `HTML-10`、`CLI-01` 至 `CLI-10` 和 `WATCH-01` 至 `WATCH-09` 的结果，或明确列出不适用的理由。P0-01 至 P0-10 必须各有一条 E2E/等价证据引用。
3. 一次 Windows 10 验收环境的真实 Claude CLI smoke test 记录，以及当前浏览器 DOM/截图链路的实证结果。只要截图链路没有通过，视觉门槛仍未完成。
4. 初始、修改后、回退后的截图和差异指标；所有基线更新都有人工批准记录。
5. 一份失败场景重放证据，证明 Annotation、错误、side-effect ledger、ArtifactVersion 和回退/恢复信息不会因失败被丢弃。
6. Evidence Bundle 的脱敏检查和 hash；调用方可以只收集预期代码、测试和规范文件，不需要收集用户凭证或绝对路径。

当前仓库没有应用源码、`package.json`、测试 runner、固定 HTML 夹具或可运行的浏览器/Daemon，因此本文件本身不声称上述 suite 已通过。后续实现必须按本规范补齐 runner、夹具和证据导出；在此之前只能报告规范完成，不能报告 P0 MVP 完成。

## 11. 明确不属于本合同

- 跨 Windows 版本、所有浏览器/显卡驱动和所有字体组合的像素完全一致；这些环境需要各自基线或后续兼容性项目。
- 以真实模型的随机文本、费用、延迟或审美判断作为自动 golden；模型行为由 fake CLI 场景和人工审查之外的合同断言覆盖。
- 生产级负载、并行 AgentRun、多人协作、远程对象存储、Electron 专属能力、PPTX 导出和完整 HTML/CSS 编辑器。
- 把浏览器启动、CLI 鉴权或环境探测的失败隐藏为测试重试；失败环境必须显式标记并保留证据。
- 将原始凭证、完整用户源文件、完整 Prompt 或未脱敏图片复制到版本库、CI 日志、测试夹具或诊断包。
