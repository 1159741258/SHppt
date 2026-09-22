---
status: accepted
---

# Project 状态与 ArtifactVersion 回退边界

## Context

P0 的 Project 是 Daemon 管理的本地 HTML Project。Annotation、AgentRun、文件变化和用户确认必须在同一个 Project 状态序列中可追溯；Agent 进程退出、浏览器断线或文件 watcher 重复投递都不能让系统丢失 before/after 证据或把未检查的修改当成已解决。

ArtifactVersion 还必须覆盖多文件修改、外部编辑和 Windows 上无法对多个普通文件执行单一操作系统事务的现实。只保存一个当前文件 hash，或把回退实现成逐文件的 best effort，都会产生无法判断的半回退状态。

## Decision

1. Local Daemon 是 Project 状态的唯一权威层。应用数据目录中的 SQLite 保存元数据、关系、状态转换和回退日志；内容寻址的证据文件保存需要恢复的文件字节。Content Root 仍属于受信任的 Project 注册表，不写入 External Project。
2. ArtifactVersion 表示一个 Project 的可审查源状态；每个 AgentRun 以一个不可变的 base ArtifactVersion 开始，并最多产生一个待审查 candidate ArtifactVersion。变更集以 Project-relative Path 为粒度，跨多个文件的 AgentRun 只形成一个版本边界。
3. before/after 的权威事实来自 AgentRun 前后的稳定文件快照和 contentHash，不来自 CLI 文本或 watcher 单个事件。所有发生变化的路径都进入 side-effect ledger；被回退所需的路径必须保存精确字节证据。
4. 用户确认是持久化的幂等动作。AgentRun 结束最多把 Annotation 置为 `needs_review`；只有用户确认并且预览 ready 后才置为 `resolved`。成功回退会生成新的回退 ArtifactVersion，保留原 AgentRun、候选版本、Annotation 和确认历史。
5. 回退在领域上是一个事务：先验证所有 after 前置条件，再准备全部 before 证据，最后按持久化 journal 应用文件变化并重新扫描。冲突发生在写入前时零文件变化；进程在应用期间崩溃时由 Daemon 恢复 journal，期间不报告成功。
6. 外部变化不会被覆盖或自动合并。旧的 Annotation 捕获、Stable Element ID、Project Session 和 ArtifactVersion 都不被原地改写；新版本只通过显式确认、回退或新 Session 建立关系。

## Consequences

- P0 需要本地 SQLite、应用数据目录中的证据 blob 和 Project 级 mutation lock，但不需要 Electron 或远程存储。
- 回退后的源字节可能与更早版本完全相同，但回退动作仍有自己的 ArtifactVersion 和 `fileIndexVersion`，所以事件、预览和 Session 不会被伪装成没有发生过变化。
- 同一 Project 在同一时间只允许一个写入型 AgentRun 或回退事务；批量 Annotation、并行 AgentRun、任意历史分支合并和部分文件回退留给后续合同。
- 预览刷新和文件事件仍由 #8 决定；它们只能提供事件和稳定扫描结果，不能替代本 ADR 的版本与回退判定。

## Rejected alternatives

- **把 ArtifactVersion 做成单文件版本**：无法把一次多文件 AgentRun 作为一个可回退的用户动作，也无法保证跨文件的一致性。
- **只保存 before/after hash**：hash 能检测变化但不能恢复确切内容；回退必须保存受保护的字节证据。
- **逐文件立即写回并忽略中途失败**：会把 Project 留在用户无法判断的部分回退状态；journal 和启动恢复是 P0 的最低可审计方案。
- **确认 Agent 退出即视为成功**：退出码、CLI 的 `file_written` 事件和模型文本都不能替代稳定扫描、ArtifactVersion 和预览检查。
- **回退后复用旧 Project Session 或自动重定位 Annotation**：源状态和对话上下文可能不再匹配；必须重新验证锚点，并在 Session 不满足基线条件时由用户显式创建新 Session。
