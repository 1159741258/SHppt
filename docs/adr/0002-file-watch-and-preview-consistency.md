---
status: accepted
---

# Use one project watcher and snapshot-backed preview events

文件变化必须经过 Daemon 的单一 watcher registry、稳定检查和完整 `FileIndexSnapshot`，再进入按 Project 排序的事件流。浏览器通过一个可重放的 SSE 通道接收增量通知；事件丢失时重新读取 snapshot，而不是把事件当作第二份文件真相。预览状态按窗口的 PreviewSession 隔离，并以版本绑定的短时 scope 和新 iframe 实例完成刷新。

## 背景

P0 需要在 AgentRun 写入、用户外部编辑和多个浏览器窗口同时存在时保持可诊断的一致性。Windows 文件 watcher 可能重复、乱序或在文件仍被写入时触发；iframe 也可能在刷新期间继续发送来自旧文档的消息。为每个窗口创建 watcher、直接按 OS 事件刷新或只依赖长连接事件都会产生半成品预览和不可解释的版本差异。

## 决策

- 以 canonical Content Root 作为 watcher registry 的复用键，并用 reference-counted lease 管理生命周期；窗口、iframe 和组件不各自创建 OS watcher。
- 把 OS 事件当作提示；经过稳定等待和完整 scan 的 `FileIndexSnapshot` 才能产生 `project.file-changed`。稳定失败保留旧 snapshot，并进入明确的 stale/error 路径。
- 使用一个统一的、版本化的 Project SSE 事件信封。事件带 `streamEpoch`、单调 sequence 和 Project-relative Path；保留窗口内按 cursor 重放，缺口或 daemon 重启则强制 snapshot resync。
- 预览状态属于 PreviewSession。`ready` 必须证明活动 iframe、Bridge、Resource、Entry Document 和 `fileIndexVersion` 全部匹配；scope 过期是 `expired`，旧内容是 `stale`，加载失败是 `error`，不能都表现为空白或成功。
- 每次预览目标版本或 scope 改变都创建新的逻辑 iframe 实例。只有新实例完成握手后才切换 active，并丢弃旧实例的消息。
- AgentRun 以基线版本、Hard scope 和 mutation lease 进行稳定批次检查。基线后的外部或来源不明变化按冲突处理，不采用最后写入者覆盖，也不自动确认 Annotation。

## 后果

事件订阅者需要实现 snapshot resync 和幂等 cursor 处理，PreviewSession 需要维护 iframe 实例与短时 scope；Daemon 需要维护稳定等待、事件保留窗口和每 Project 的序列状态。这些复杂度换来的是可重复的 P0-06 自动刷新、P0-08 回退同步和 P0-10 外部冲突证据，并且与 HTML-first 合同的单一 File Index 事实源一致。

具体的 watcher 库、SSE HTTP 路由、ArtifactVersion 存储和浏览器组件实现仍由后续技术合同决定，但不得削弱上述行为。

详细字段、状态转换、并发顺序和验收场景见[文件监听、事件与预览刷新合同](../specs/file-watching-events-preview-refresh-contract.md)。
