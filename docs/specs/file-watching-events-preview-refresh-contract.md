# 文件监听、事件与预览刷新合同

状态：已决定，合同版本 `1`

对应票据：[文件监听、事件与预览刷新合同](https://github.com/1159741258/SHppt/issues/8)

本合同定义文件变化如何从一个受信任的 Project 目录进入统一事件流，并最终成为一个可验证的预览刷新。它建立在 [HTML-first 项目与 Deck 合同](./html-first-project-deck-contract.md) 的 `Project`、`Content Root`、`Entry Document`、`Resource`、`Project-relative Path` 和 `FileIndexSnapshot` 之上，也落实 P0 要求的稳定等待、冲突保留和预览失败可见性。

本合同不重新定义 Daemon 的进程拓扑、AgentRun 的权限范围或 ArtifactVersion 的持久化格式。它只规定这些模块之间必须观察到的行为和边界。

## 1. 不变量与权威边界

1. Daemon 是文件、File Index、事件顺序和预览访问 scope 的唯一权威层。浏览器只保存状态投影，不直接读取 Content Root、创建 OS watcher 或启动 Agent。
2. OS 文件事件只是变化提示，不是文件内容事实源。只有稳定检查成功后的完整 `FileIndexSnapshot` 才能被发布为新的 Project 状态。
3. 事件是增量通知和恢复游标，不是数据源。消费者丢失事件、发现游标断档或不认识 `streamEpoch` 时，必须重新读取完整 snapshot；不得根据最后一个事件猜测文件内容。
4. 所有浏览器、iframe、Annotation 和 Agent-facing 字段都使用 Project-relative Path、`projectId` 和 `fileIndexVersion`。事件、预览 URL 和错误中不得出现 `Content Root`、盘符、UNC 路径或 `file://` URL。
5. 一个稳定变化产生的 snapshot 必须是整体可读的。入口、Resource、Slide 和 Stable Element ID 的检查失败时，保留上一个成功 snapshot，并报告失败；不得把半份索引提供给预览或 AgentRun。
6. `fileIndexVersion` 相同的变化（例如只有 `mtime` 变化）不触发 iframe 刷新。`mtime` 可以进入诊断信息，但不能作为版本身份。

## 2. Watcher registry 与生命周期

### 2.1 复用键和持有者

Daemon 维护进程内的 `WatcherRegistry`。registry 的复用键是经过 canonical path 解析的 Content Root；Windows 路径比较遵循 HTML-first 合同的不区分大小写规则。Content Root 的 canonical path 只存在于受信任的 Daemon 状态，不能下发给浏览器。

同一个 canonical Content Root 只能有一个逻辑 watcher。不同浏览器窗口、同一窗口的多个组件、预览 iframe 和相同 Project 的 API 请求都共享它，不得各自创建 `FileSystemWatcher`、chokidar 或 polling 实例。Project 重新打开时按既有 ADR 复用同一个 `projectId`；如果 canonical root 映射不一致，打开流程失败而不是建立第二个 Project 身份。

需要实时变化的消费者先取得一个 lease，再订阅事件：

- 浏览器 Project 事件流持有一个 lease；
- 每个活动 PreviewSession 通过所属事件订阅间接持有 lease；
- AgentRun、回退和其他 Daemon 受信任写入在没有浏览器订阅时，也必须取得 mutation lease，以便完成冲突检查和稳定扫描。

lease 只影响 watcher 的引用计数，不改变 Project 的身份或 File Index 的版本。

### 2.2 acquire/release 规则

- 第一个 lease 创建 watcher，加载受保护路径过滤规则，并从当前完整 snapshot 建立基线。
- 后续 lease 复用相同记录，并得到同一条 Project 事件序列。
- release 只减少引用计数。引用计数为零时，Daemon 先完成或取消待处理的稳定批次，再关闭 OS watcher；关闭时不能把未完成批次伪装成稳定变化。
- watcher 关闭期间发生的磁盘变化不会被假定为已收到。下一个 lease 必须先读取新的完整 snapshot，并以该 snapshot 的游标开始事件流。
- watcher 创建失败、收到 `ENOSPC`/`EMFILE` 或 Windows watcher 溢出时，可以切换到 polling fallback。fallback 必须继续使用相同的 registry 记录和事件合同，并把降级状态写入诊断；不能为每个窗口各自重试创建 watcher。

## 3. 文件变化的稳定检查

### 3.1 OS 事件只是提示

Daemon 可以接收 `add`、`change`、`unlink`、`rename` 和 watcher `error`。事件先按已有受保护路径规则过滤，再按 Project-relative Path 合并为待处理批次；受保护路径不得产生浏览器或 Agent-facing 事件。同一路径的重复通知、临时文件写入和编辑器的 rename-save 序列不得直接触发预览刷新。

每个批次必须经过显式的稳定检查配置：

```text
stabilityWindowMs: 两次检查之间要求保持不变的静默时间
maxStabilityWaitMs: 单个批次允许等待的上限
```

实现必须记录实际使用的配置；测试可以注入较短值。一个普通文件只有在以下条件在相邻两次检查中一致，并且文件可读时才算稳定：存在性、大小、最后修改时间和 `contentHash`。删除的路径只有在确认不存在且父路径可扫描时才算稳定。写入重命名得到的最终路径必须重新走 Content Root、受保护路径和 reparse point 校验。

### 3.2 稳定批次到 snapshot

稳定检查成功后，Daemon 对受影响的 Project 执行一次完整 scan，而不是只拼接局部事件。scan 必须遵守 HTML-first 项目与 Deck 合同，并产生一个不可变的 `FileIndexSnapshot`。

- 如果规范化后的路径集合或内容改变，产生新的 `fileIndexVersion`，并发布一个 `project.file-changed` 事件。
- 如果只有 `mtime` 改变，保留原 `fileIndexVersion`，可以记录诊断事件，但不发布要求刷新预览的变化。
- 如果入口、Resource、Slide、稳定标识或 Content Root 边界检查失败，保留上一个成功 snapshot，发布 `project.scan-failed`，并令关联 PreviewSession 至少处于 `stale`；不能发布不完整 snapshot。
- 在 `maxStabilityWaitMs` 内仍无法稳定时，发布 `project.file-stability-timeout`。预览必须保持 `stale` 或进入 `error`，直到下一次稳定 scan 或用户明确重试；不能把超时批次当作成功写入。

一个 `project.file-changed` 事件至少包含 `fromFileIndexVersion`、`toFileIndexVersion`、变化的 Project-relative Paths 和变化归因。事件中的路径只用于定位要重新读取的 snapshot，不携带绝对路径或完整文件内容。

### 3.3 AgentRun 写入批次

AgentRun 的多文件写入不能因为文件之间存在短暂间隔而产生半成品预览。AgentRun 开始前，Daemon 记录 `baseFileIndexVersion` 和当前 Project sequence，并登记 Hard scope、预期路径集合和 `runId`。从 Agent 进程启动到进程结束后的稳定等待期间，相关 OS 事件进入同一个 mutation batch。

进程结束后，Daemon 等待预期路径稳定并执行完整 scan：

- 只在最终 snapshot 与允许的预期变化一致时，才把该批次归因到 `runId`；
- Agent 进程失败但已经写入时，仍扫描并保留副作用，运行结果不能因此变成成功；
- 预期范围外、基线之后无法归因的变化或同一路径的来源不明竞争都构成冲突；
- 冲突不能通过覆盖外部结果、重跑 Agent 或选择“最后写入者”来消除。Daemon 必须保留冲突证据，并要求用户查看、回退或人工处理。

## 4. 统一事件信封

P0 的服务器到浏览器事件通道采用一条按 Project 复用的 SSE 流。HTTP 请求/响应用于读取 snapshot 和提交命令；Agent 输出、文件变化、运行结果和预览生命周期都使用同一事件信封格式，不为每种状态建立独立长连接。

### 4.1 信封格式

```json
{
  "schemaVersion": 1,
  "eventId": "epoch-uuid:42",
  "streamEpoch": "epoch-uuid",
  "sequence": 42,
  "eventType": "project.file-changed",
  "scope": "project",
  "projectId": "project-uuid",
  "occurredAt": "2026-09-22T04:00:00.000Z",
  "fileIndexVersion": "sha256:...",
  "artifactVersionId": null,
  "origin": "agent",
  "runId": "run-uuid",
  "previewSessionId": null,
  "payload": {}
}
```

字段规则如下：

- `schemaVersion` 用于拒绝不兼容的信封；未知版本不能被当作已理解的事件处理。
- `streamEpoch` 标识一次连续的 Project 事件流。Daemon 重启或事件历史不可用时必须生成新的 epoch；不能复用旧游标。
- `sequence` 在一个 `projectId + streamEpoch` 内严格递增。`eventId` 是 SSE `id`，客户端可以把它作为 `Last-Event-ID`。
- `scope` 为 `project` 时，所有窗口都能看到同一事件；为 `preview-session` 时必须带 `previewSessionId`，其他窗口忽略它。
- `fileIndexVersion` 是事件实际使用或产生的 snapshot 版本；没有版本的诊断事件使用 `null`，不能填“当前最新”来掩盖未知状态。
- `artifactVersionId` 由 ArtifactVersion 合同提供；本合同不要求事件自行生成它。
- `origin` 只能取 `agent`、`external`、`system` 或 `unknown`。OS watcher 无法证明进程来源时使用 `unknown`；它不是允许忽略冲突的凭证。
- `runId`、`previewSessionId` 没有关联时使用 `null`。`payload` 中的所有路径仍必须是 Project-relative Path。

最小事件集合为：

| 事件 | 作用 | 是否为事实源 |
| --- | --- | --- |
| `subscription.snapshot` | 为新连接或断线恢复提供完整 snapshot 和游标边界 | 是，唯一文件事实源 |
| `subscription.resync-required` | 游标断档、epoch 不匹配或历史已被回收 | 否，要求重新读取 snapshot |
| `project.file-change-pending` | watcher 已观察到变化，稳定检查尚未完成 | 否 |
| `project.file-changed` | 稳定 scan 产生了新 `FileIndexSnapshot` | 引用 snapshot，但事件本身不是事实源 |
| `project.scan-failed` | 新状态无法通过入口、Resource 或 Deck 合同 | 否，保留旧 snapshot |
| `project.file-stability-timeout` | 在等待上限内无法得到稳定内容 | 否 |
| `run.started` / `run.file-written` / `run.completed` / `run.conflict` | AgentRun 的生命周期和写入证据 | 否 |
| `preview.loading` / `preview.ready` / `preview.error` / `preview.stale` / `preview.expired` | 某个 PreviewSession 的状态投影 | 否，断线后由状态查询重建 |

`run.file-written` 可以作为进度提示，但只有后续稳定 scan 产生的 `project.file-changed` 才能改变 Project 的文件版本。`run.completed` 只表示 Agent 进程和稳定批次已经结束，不表示 AgentRun 已被用户接受，也不表示 Annotation 可以进入 `resolved`。`preview.*` 事件必须带 PreviewSession 的目标版本和 iframe 实例身份，不能让一个窗口的 iframe 状态覆盖另一个窗口。

## 5. 断线、重连与重放

### 5.1 订阅握手

客户端保存最后应用的 `eventId`，重新连接时发送它。Daemon 在同一 Project 的锁定边界内确定当前 `streamEpoch`、当前 sequence 和 snapshot 边界：

1. 没有游标的新连接收到一份 `subscription.snapshot`，其中带完整 `FileIndexSnapshot` 和边界游标；边界之后产生的事件再按序推送。
2. 游标属于当前 epoch 且仍在保留的连续事件范围内时，Daemon 只重放游标之后到当前边界之间的事件，然后继续推送实时事件。
3. 游标不属于当前 epoch、超出保留窗口或中间存在缺口时，Daemon 发送 `subscription.resync-required`，附带当前 snapshot 的读取版本和最新游标。客户端先读取完整 snapshot，再用新游标重连；不得跳过缺口继续应用增量。

事件重放使用半开区间 `(lastAppliedSequence, boundarySequence]`。客户端对重复事件幂等处理；发现 sequence 跳跃、Project 不匹配、版本倒退或信封版本未知时，立即进入 resync 流程。

事件可以只保留有限窗口，因为完整 snapshot 才是事实源。Daemon 重启后即使文件没有变化，也不能声称旧 SSE 游标仍可重放；新的 `streamEpoch` 会强制一次 snapshot 同步。SSE 心跳、断开检测、禁用代理 buffering 和合理超时属于部署要求，但不能改变上述恢复语义。

### 5.2 多窗口订阅

多个浏览器窗口订阅同一个 Project 时：

- 它们看到完全相同的 Project sequence、`fileIndexVersion` 和 `project.file-changed` 事件；
- 每个窗口拥有独立的 PreviewSession、预览 scope 和 iframe 生命周期，可以暂时显示不同的 `previewState`；
- 事件流不会为每个窗口复制 OS watcher，窗口关闭只释放自己的 lease；
- 窗口发出的确认、回退或其他改变状态的命令必须携带预期的 `projectId + fileIndexVersion`，Daemon 发现版本已变化时返回版本冲突；不能执行隐式的“以最新版本重试”；
- 一个窗口在另一个窗口完成变更后会收到同一 Project 事件并进入 `stale`，不能继续以旧预览声称 `ready`。

## 6. Preview 状态与刷新语义

`previewState` 属于一个 PreviewSession，不是 Project 的全局状态。它至少包含：

```text
PreviewState = {
  status: ready | loading | error | stale | expired,
  projectId,
  previewSessionId,
  iframeInstanceId,
  entryPath,
  fileIndexVersion,
  frameMode: daemon-url | srcdoc,
  reason: string | null,
  errorCode: string | null,
  lastReadyFileIndexVersion: string | null
}
```

状态含义和转换：

| 状态 | 合同含义 | 允许的下一步 |
| --- | --- | --- |
| `loading` | 正在为目标 snapshot 创建或加载 iframe | 成功握手为 `ready`，加载/校验失败为 `error` |
| `ready` | 活动 iframe 已握手，资源和 Deck 校验完成，显示版本等于目标 `fileIndexVersion` | 新变化为 `stale`，scope 失效为 `expired` |
| `stale` | 磁盘已有未反映到活动 iframe 的变化，或稳定 scan/连接恢复尚未完成 | 开始新加载为 `loading`，无法得到新 snapshot 为 `error` |
| `error` | 目标 snapshot 或 iframe 加载失败，错误证据仍可诊断 | 用户或系统显式重试为 `loading`；不得伪装为 `ready` |
| `expired` | 预览访问 scope 已过期或被撤销，iframe 不再有权读取资源 | 重新 mint scope 后为 `loading` |

初次打开从 `loading` 开始。收到 `project.file-change-pending` 时，`ready` 至少变为 `stale`；稳定 scan 产生新版本后，只有为该版本启动加载才可进入 `loading`。如果 scan 失败，旧 iframe 可以暂时保留为诊断画面，但状态仍是 `stale` 或 `error`，不可用于成功确认。

`preview.ready` 的必要条件是：活动 iframe 与事件的 `iframeInstanceId` 和 `previewSessionId` 相同；其 `projectId`、`entryPath`、`fileIndexVersion` 与目标一致；Bridge 握手成功；所有必要的本地 Resource 可解析；Entry Document 的 Slide 和渲染尺寸检查通过。仅收到 iframe 的 `load` 事件不足以宣布 `ready`。

## 7. Resource 路径和 iframe 生命周期

### 7.1 预览目标与 Resource 访问

预览目标至少由以下值组成：

```text
PreviewTarget = {
  projectId,
  fileIndexVersion,
  entryPath,
  previewSessionId,
  frameMode,
  previewScopeId
}
```

`entryPath` 和所有 Resource 请求都按 HTML-first 项目的 URL 解析规则转换为 Project-relative Path，并绑定到目标 `fileIndexVersion`：

- `daemon-url` 模式使用 Daemon 的受保护、短时 preview scope 提供 Entry Document 和 Resource；浏览器只得到不透明 scope 和相对路径，不得到 Content Root；
- `srcdoc` 模式由同一个 snapshot 生成注入 Bridge 的文档。所有本地 HTML/CSS/脚本/图片/字体引用必须改写为同一 preview scope 下的相对资源 URL，或明确内联；不能回退为 `file://` 或操作系统绝对路径；
- query 和 fragment 不改变 Resource 的文件身份；scope 解析前仍必须校验规范化后的 Project-relative Path、snapshot 版本、受保护路径和 Content Root 边界；
- 请求不存在、越界、命中受保护路径、属于旧 snapshot 或 scope 过期时必须失败。Daemon 不得静默从最新 snapshot 或“相似路径”提供资源；
- `daemon-url` 和 `srcdoc` 是同一预览合同的两个 frame mode，不是两份源文件或两份 File Index。

preview scope 必须绑定 `projectId`、`fileIndexVersion`、`previewSessionId`、允许的 `entryPath`/Resource 集合和过期时间。Daemon 可以提供 `mint`、`acquire`、`renew`、`validate` 和 `resolve` 操作；版本变化后必须 mint 新 scope，不能用旧 scope 读取新 snapshot。scope 过期产生 `expired`，而不是空白 iframe 或自动切换到最新版本。

### 7.2 iframe 实例

每个 PreviewSession 维护一个逻辑活动 iframe。每次切换 Entry Document、frame mode、preview scope 或 `fileIndexVersion` 都生成新的 `iframeInstanceId`，即使实现复用了同一个 DOM 节点，也必须把它视为新的逻辑实例。

刷新按以下顺序进行：

1. 先令旧活动实例为 `stale`，创建带新实例身份和新 scope 的 staging iframe。
2. staging iframe 完成 Bridge 握手、Resource 解析、Slide 检查并发送带实例身份的 `deck.ready` 后，Daemon 才把它原子地提升为 active。
3. 新实例准备好之前可以保留旧画面以避免闪烁，但旧画面不能被标记为新版本的 `ready`；新实例失败时显示 `error` 并保留失败证据。
4. 切换后移除旧 iframe、解除其 message listener 并释放旧 scope。卸载 PreviewSession 时也必须执行同样的清理并释放事件 lease。

宿主处理 `postMessage` 时同时验证 `event.source` 是当前 staging/active iframe、允许的协议和 origin、`previewSessionId`、`iframeInstanceId`、协议版本和 scope。旧 iframe、其他窗口或未经验证的 origin 的消息全部丢弃；不得仅凭消息中的 `projectId` 接受它们。Slide 的恢复按稳定 `Slide ID`，不能因为 iframe 重载而按旧 `slideIndex` 静默指向另一页。

## 8. Agent、外部编辑与并发顺序

每个 Project 有一条由 Daemon 分配的全序 sequence。它表示“稳定状态被 Daemon 接受”的顺序，不表示不同 OS 事件到达的毫秒顺序。所有浏览器窗口消费这同一顺序。

AgentRun 的最小顺序为：

```text
读取并锁定基线 S0 / sequence N
  -> run.started
  -> 注册 mutation lease、Hard scope 和预期写入
  -> Agent 进程读写文件
  -> 进程结束，等待写入稳定
  -> 完整 scan 并分类变化
  -> project.file-changed 或 project.scan-failed
  -> run.completed 或 run.conflict
  -> 预览针对目标版本 loading -> ready
  -> 用户在版本匹配时确认或回退
```

并发规则如下：

| 时机/来源 | 处理 |
| --- | --- |
| AgentRun 基线 `S0` 之前的外部编辑 | 已进入 `S0`，不单独构成该运行的冲突 |
| `S0` 之后、Agent 完成之前的外部编辑 | 与 Agent 批次合并扫描，但标记 `run.conflict`；不自动覆盖或确认 |
| Agent 和外部编辑同时写同一路径，来源无法可靠区分 | 按冲突处理，即使最终内容碰巧等于 Agent 预期结果 |
| Agent 进程失败但磁盘已有写入 | 生成可诊断的 snapshot/变化证据，运行保持失败或需要审查，不宣布成功 |
| Agent 结果已刷新后、用户确认前的外部编辑 | 新 sequence 令所有相关预览 `stale`；原确认命令因版本不匹配而被拒绝 |
| Agent 写入 Hard scope 之外的路径 | 运行不接受为成功，保留 before/after 和路径证据，并进入冲突/失败路径 |
| 回退或系统修复写入 | 作为新的受信任 mutation batch 进入同一 sequence；其他窗口收到变化并重新加载 |

Daemon 可以把相邻且属于同一 mutation lease 的多个文件合并成一次逻辑变化，但必须在完整 scan 后再发布。它不能把一个窗口先收到的 `run.file-written` 当成另一个窗口可以确认的 ArtifactVersion。用户确认、回退和其他状态变更都要求调用方提供预期版本；服务器是最后的版本检查者。

## 9. 最小错误码与诊断证据

除 HTML-first 合同已有错误码外，至少区分：

| 错误码 | 含义 |
| --- | --- |
| `WATCHER_UNAVAILABLE` | OS watcher 和 polling fallback 都无法建立 |
| `FILE_STABILITY_TIMEOUT` | 文件在等待上限内没有稳定 |
| `PROJECT_SCAN_FAILED` | 稳定后完整 scan 失败，旧 snapshot 被保留 |
| `EVENT_CURSOR_GAP` | SSE 游标不连续、过期或 epoch 不匹配 |
| `PREVIEW_SCOPE_EXPIRED` | 预览 scope 过期或被撤销 |
| `PREVIEW_FRAME_STALE` | 消息来自非活动 iframe 或旧 snapshot |
| `PREVIEW_VERSION_MISMATCH` | 命令/预览使用的版本不是 Project 当前要求的版本 |
| `PROJECT_WRITE_CONFLICT` | AgentRun 与外部或来源不明的变化发生竞争 |

诊断记录至少包含 `projectId`、`runId`（如有）、`previewSessionId`（如有）、`streamEpoch`、sequence、相关 `fileIndexVersion`、Project-relative Paths、稳定等待配置、旧/新 hash（如可用）和错误码。禁止记录 Content Root、绝对路径、凭证或文件的完整私密内容。

## 10. 验收场景

实现必须能在 Windows 10 固定示例 Project 上重复证明以下行为：

1. 两个浏览器窗口和多个 PreviewSession 订阅同一个 canonical Content Root 时，registry 只有一个 OS watcher；最后一个 lease 释放后才关闭。
2. 将 HTML 或 CSS 分多次写入、保存为临时文件再 rename 时，客户端在稳定检查前不会刷新，也不会收到半份 File Index；稳定后只得到可验证的完整 snapshot。
3. 事件只携带 Project-relative Path，并能通过 `Last-Event-ID` 在保留窗口内按序重放；制造缺口或重启 epoch 后会要求 snapshot resync。
4. 新 snapshot 到达后，旧 iframe 先进入 `stale`，新 iframe 完成版本匹配的 Bridge/Resource/Slide 握手后才进入 `ready`；加载失败、scope 过期和旧 frame 消息分别显示 `error`、`expired` 和诊断信息。
5. `daemon-url` 与 `srcdoc` 都不使用 `file://` 或绝对路径；旧版本 scope 不能读取新 Resource，越界和受保护路径请求被拒绝。
6. AgentRun 的多文件写入在完整稳定 scan 前不会宣布成功；基线后的外部编辑、来源不明竞争和范围外写入都保留证据并进入冲突路径。
7. 多窗口同时确认一个变更时，只有携带当前 `projectId + fileIndexVersion` 的操作可以成功；旧窗口的确认被拒绝并要求刷新，不会发生最后写入者覆盖。
8. 预览达到 `ready` 只能发生在 `fileIndexVersion`、Entry Document、Slide ID 和 Resource 检查全部匹配时；`stale`/`error`/`expired` 不能被 AgentRun 或 Annotation 当作成功。

## 11. 后续合同的边界

- #4 决定 Browser/Renderer、Daemon 和 Electron 的进程边界；本合同只要求 Daemon 持有 watcher、Content Root 和 preview scope 的权威状态。
- #5 使用这里的事件游标、PreviewSession、iframe 身份和 Project-relative Path 建立 Annotation/iframe Bridge 消息。
- #6 决定 AgentRun 的 Hard scope、CLI 生命周期和写入权限；本合同决定其写入如何进入稳定批次和冲突判定。
- #7 决定 ArtifactVersion 的持久化、before/after 内容和回退 ID；本合同只在事件中引用 `artifactVersionId`。
- #10 为上述验收场景提供夹具、测试和视觉诊断证据。

明确不属于本合同：跨 Project 的实时协作、远程对象存储、任意 HTML/CSS 编辑、自动合并外部修改、PPTX 导出，以及把 OS watcher 的偶然到达顺序当作用户可见版本顺序。
