# P0 项目状态、持久化与 ArtifactVersion 回退合同

状态：已决定，合同版本 `1`

对应票据：[项目状态、持久化与 ArtifactVersion 回退合同](https://github.com/1159741258/SHppt/issues/7)

决策记录：[ADR-0003：Project 状态与 ArtifactVersion 回退边界](../adr/0003-project-state-and-artifact-version.md)

上游合同：[P0 MVP：视觉标记驱动的 Agent PPT 编辑器](./p0-mvp-acceptance.md)、[P0 HTML-first Project 与 Deck 合同](./html-first-project-deck-contract.md)

本文件具体化 Project、Annotation、AgentRun、ArtifactVersion、用户确认、外部文件变化和回退之间的持久化关系。它服从运行时与 AgentRun 的边界决定：Daemon 是唯一权威层，Browser/Renderer 不读写 Content Root，AgentRun 的 Hard Scope 不能被本文件扩大。

## 1. 决策摘要

P0 的状态链如下：

```text
Project scan
  -> initial ArtifactVersion
  -> 保存 Annotation（固定 capture 版本）
  -> AgentRun（固定 base 版本和 File Index）
  -> 稳定扫描 + before/after evidence
  -> candidate ArtifactVersion / conflict
  -> preview ready
  -> 用户确认
       |-- confirm  -> resolved，candidate 成为确认状态
       |-- rollback -> 新的 rollback ArtifactVersion，Annotation 回到 open
       |-- mark_failed -> failed，保留全部证据
```

以下规则是硬约束：

- 一个 Project 只有一个当前物理源状态；P0 同时只允许一个写入型 AgentRun 或回退事务。
- `FileIndexSnapshot` 不可变；preview、Annotation、AgentRun 和 ArtifactVersion 使用同一个 `projectId + fileIndexVersion`，不能静默换成最新版本。
- ArtifactVersion 是 Project 级状态，变更集是其中的多文件 before/after 证据；AgentRun 的所有允许变化必须归属于同一个版本边界。
- `contentHash` 和稳定扫描结果是真实文件事实；CLI frame、模型文本和单个 watcher 事件只能作为线索。
- `resolved` 只能由用户确认产生。回退、冲突、预览失败和锚点风险都不能自动产生 `resolved`。
- 回退不删除历史，也不把当前文件逐个 best effort 地写回。它要么在所有前置条件满足后完成整个变更集，要么保持未完成并进入恢复/人工处理状态。

## 2. 持久化边界

### 2.1 Daemon 应用状态

应用状态位于当前用户的应用数据目录，例如 `%LOCALAPPDATA%\SHppt\`，而不是 Content Root。P0 采用 SQLite 元数据加应用管理的内容寻址证据文件；具体数据库引擎文件名不是浏览器或 Agent-facing 合同的一部分。

至少需要以下逻辑记录：

| 记录 | 权威内容 |
| --- | --- |
| `ProjectRecord` | `projectId`、展示名称、`type`、受信任的 canonical Content Root、`entryPath`、合同版本、当前版本和 Project 状态 |
| `FileIndexSnapshot` | 不可变的完整 File Index、`fileIndexVersion` 和扫描诊断 |
| `ArtifactVersion` | Project 源状态、父版本、状态、变更集、版本 manifest 和证据引用 |
| `Annotation` | 用户意图、截图/DOM 证据引用、捕获版本、锚点状态、用户可见状态 |
| `AgentRun` / `Turn` | 一条 Annotation 的一次执行、base/candidate 版本、Hard Scope、Session、事件游标和终点结果 |
| `SideEffect` | 运行期间每个路径的 before/after hash、来源、允许性、确认状态和冲突标记 |
| `ProjectSession` | Agent provider 的对话身份及其最后已核对的 Project/ArtifactVersion/File Index 绑定 |
| `UserAction` | confirm、rollback、mark_failed、retry 等幂等用户动作及其前置状态 |
| `MutationJournal` | 回退或恢复事务的阶段、路径计划和每个文件操作的完成情况 |

SQLite 事务负责关系和状态转换；证据文件先以 contentHash 校验并登记，再由元数据事务引用。应用启动时发现没有完成的 `MutationJournal`，必须先完成恢复或标记 `rollback_recovery_required`，不能把 Project 显示为 ready。

### 2.2 路径、内容和敏感信息

- 受信任的 Daemon 可以保存 canonical Content Root；浏览器、SSE、Annotation、AgentRun、事件和错误只传 `projectId` 与 Project-relative Path。
- 版本 manifest 只覆盖当前 File Index 中对 Deck 有效的源文件，以及本次 PermissionLease 明确允许的路径；`.git`、`.shppt`、`node_modules`、`dist`、`build`、`coverage` 和 Content Root 外路径不进入证据。
- 证据引用使用 `contentHash`、大小和 Project-relative Path。需要回退的变化文件必须保存精确字节；没有完整字节证据的版本不能宣称可回退。
- 日志、SSE 和错误不得包含 API key、访问令牌、认证环境变量、完整 Prompt、完整 CLI stderr 或不必要的源文件/图片内容。版本查看器通过 Daemon 的受控读取按需读取证据。

## 3. 版本和实体关联

### 3.1 ProjectRecord

```text
ProjectRecord = {
  projectId,
  name,
  type: html-deck,
  contentRootBinding,       // 仅受信任 Daemon 状态
  entryPath,
  contractVersion,
  currentArtifactVersionId,
  confirmedArtifactVersionId,
  currentFileIndexVersion,
  state: ready | review_pending | conflict | rollback_recovery_required | invalid,
  createdAt,
  updatedAt
}
```

`currentArtifactVersionId` 表示磁盘已稳定观察到的当前源状态。`confirmedArtifactVersionId` 表示用户最近明确接受的状态；待审查的 Agent 结果可以是 current，但不能是 confirmed。初次合法扫描创建 `kind: initial` 的 ArtifactVersion，使 AgentRun 永远有可识别的 base，而不是使用空版本。

### 3.2 ArtifactVersion

ArtifactVersion 是一个 Project 源状态，不是单个文件的版本号，也不是 Claude CLI 的 Session。

```text
ArtifactVersion = {
  artifactVersionId,
  projectId,
  parentArtifactVersionId,
  kind: initial | agent_candidate | agent_observed_failure |
        external_observation | rollback,
  state: candidate | confirmed | conflicted | observed |
        superseded | recovery_required,
  fileIndexVersion,
  sourceStateHash,
  snapshotManifest,
  changeSet,
  origin: {
    annotationId?,
    agentRunId?,
    rollbackOfArtifactVersionId?,
    restoreTargetArtifactVersionId?
  },
  createdAt
}
```

`snapshotManifest` 是按 Project-relative Path 排序的状态清单，至少包含 `path`、`exists`、`contentHash`、`size` 和可用的 `blobRef`。未变化路径可以复用已有 blob；本版本变更路径的 before/after blob 不能只保留 hash。

`sourceStateHash` 由规范化 manifest 和内容 hash 计算，不由 mtime 单独决定。`fileIndexVersion` 仍是预览和输入快照的版本身份；两个字段不能互相替代。

`initial` 没有 AgentRun；`agent_candidate` 是稳定观察到的 Agent 结果；进程失败但有副作用时使用 `agent_observed_failure` 或 `conflicted` 状态保存证据；`rollback` 是一次新的状态，不能删除或重写被回退的版本。P0 不允许把一个非当前 head 的历史版本直接覆盖到磁盘；任意历史合并和部分文件回退属于后续范围。

### 3.3 ChangeSet 与 diff

`changeSet` 按路径保存一个版本相对于其 parent 的变化：

```text
ChangeEntry = {
  path,
  operation: create | write | delete | rename,
  before: { exists, contentHash?, size?, blobRef? },
  after:  { exists, contentHash?, size?, blobRef? },
  diffRef?,
  evidence: complete | partial | unknown,
  source: agent | external | rollback | recovery
}
```

重命名至少要让旧路径和新路径都可审查；实现可以用同一个 rename group 表示，但不能只记录一个新路径。`before` 和 `after` 从稳定文件内容读取。对 UTF-8 HTML/CSS/JavaScript 等文本，`diffRef` 可以指向可重建的统一 diff；对图片、字体、媒体和过大文本，diff 至少显示操作、大小和 before/after hash，不把二进制内容塞入事件流。diff 是可缓存的投影视图，manifest、hash 和 blob 才是权威证据。

### 3.4 Annotation、AgentRun 和 UserAction

P0 中 Issue 所称的“评论”由持久化 Annotation 表示，不另设一个脱离 Annotation 的聊天状态。Annotation 在创建时固定以下引用，后续只能追加新的锚点观察：

```text
Annotation = {
  annotationId,
  projectId,
  capturedArtifactVersionId,
  capturedFileIndexVersion,
  sourcePath,
  contentHash,
  slideId,
  slideIndex,
  stableElementIds?,
  evidenceRefs,
  hardScope,
  status: open | applying | needs_review | resolved | failed,
  anchorStatus: anchored | reanchored | stale | lost,
  latestAgentRunId?,
  lastOutcome?,
  createdAt,
  updatedAt
}
```

Annotation 的截图、归一化几何、DOM 上下文和四类标记的具体格式由 Annotation/iframe Bridge 合同决定；本合同只要求它们指向不可变 capture 版本，并且能回查 `path + contentHash + Slide ID + Stable Element ID`。

```text
AgentRun = {
  runId,
  projectId,
  annotationId,
  sessionId,
  turnId,
  retryOf?,
  baseArtifactVersionId,
  baseFileIndexVersion,
  hardScope,
  permissionLease,
  state,
  candidateArtifactVersionId?,
  sideEffectSummary,
  error?,
  createdAt,
  terminalAt?
}
```

一个 AgentRun 只处理一条 Annotation、一个 base ArtifactVersion 和一个 Turn。重试创建新的 `runId`/`turnId`，通过 `retryOf` 关联；旧 Run、事件和证据不可覆盖。重复提交同一 Annotation 时，非终态 Run 必须以幂等方式返回既有 Run。

```text
UserAction = {
  actionId,
  projectId,
  annotationId?,
  agentRunId?,
  artifactVersionId?,
  action: confirm | rollback | mark_failed | retry,
  observedFileIndexVersion,
  previewState,
  createdAt
}
```

`actionId` 在数据库中唯一。相同动作重放返回第一次动作的结果；如果当前 Project 状态已不满足动作的前置版本，则返回冲突而不是再次写入。

关系约束如下：

- 一个 Project 拥有多个 FileIndexSnapshot、Annotation、ProjectSession 和 ArtifactVersion。
- 一个 Annotation 可以有多个串行 AgentRun；一个 AgentRun 只能有一个 Annotation。
- 一个 AgentRun 以一个 base 版本开始，最多产生一个 candidate 版本；一个 candidate 的证据必须能反查 AgentRun、Annotation 和 UserAction。
- 一个 UserAction 只确认一个 candidate 或回退一个当前 candidate；确认记录是 append-only。
- ArtifactVersion、AgentRun、Annotation 和 Session 不能因回退而删除。

## 4. 快照粒度和生命周期

### 4.1 创建 Annotation

保存 Annotation 前，Daemon 必须确认请求中的 `projectId + fileIndexVersion` 仍存在且对应当前预览。Annotation 保存其 capture 版本、当时的 `contentHash`、Slide/Stable Element 引用、截图和 Hard Scope。浏览器不能只提交一个当前路径让 Daemon 重新猜测入口或元素。

### 4.2 启动 AgentRun

启动前在 Project mutation lock 下执行以下检查：

1. `Project.currentArtifactVersionId` 等于请求的 `baseArtifactVersionId`，且 `currentFileIndexVersion` 等于 `baseFileIndexVersion`。
2. Content Root binding、Project 合同、Annotation 状态和锚点仍有效。
3. `writePaths` 的存在、大小和 contentHash 与 base 快照一致；before bytes 已保存并校验。
4. 当前没有其他写入型 AgentRun、回退 journal 或未处理的外部冲突。
5. Project Session 满足 AgentRun 合同的 resume 条件；不满足时只能由用户显式创建新 Session。

任一检查失败都不会启动 CLI，返回 `INPUT_VERSION_STALE`、`PROJECT_STATE_LOCKED`、`ANCHOR_REVALIDATION_REQUIRED` 或具体错误。不能把当前最新扫描结果静默代替请求版本。

### 4.3 运行后稳定扫描

AgentRun 终点必须经过以下顺序：关闭/回收进程、等待写入稳定、重新建立完整 FileIndexSnapshot、比较 base 与 current、确认 side-effect ledger，再创建 candidate 或失败证据版本。

- 变化路径必须有 before/after hash 和大小；需要回退的变化路径必须有精确 before/after blob。
- CLI 声称写入但稳定扫描没有变化时，不产生成功 candidate，Run 使用 `NO_EFFECT`。
- 进程异常但检测到变化时，保存 `agent_observed_failure` 或 `conflicted` ArtifactVersion；不能把它伪装为无副作用失败，也不能自动重试。
- 没有任何变化且没有副作用时，可以不创建新 ArtifactVersion，但 AgentRun 的失败原因仍持久化。
- 预览刷新失败时，candidate 仍可保留作为待审查证据，但 Project/Annotation 不能进入确认成功路径。

## 5. Annotation 状态和用户确认

### 5.1 状态转换

| 当前状态 | 动作/条件 | 下一状态 | 约束 |
| --- | --- | --- | --- |
| `open` | 保存并发送 | `applying` | 创建新的 AgentRun；不允许重复运行 |
| `applying` | 有稳定 candidate 且预览 ready | `needs_review` | 必须能查看 diff 和 before/after |
| `applying` | 无副作用的 preflight/进程/验证失败 | `failed` | 保留错误，可显式 retry |
| `applying` | 有副作用但结果不确定 | `needs_review` 或 `failed` | 必须保留证据，禁止盲目 retry |
| `needs_review` | 用户确认 candidate | `resolved` | 必须检查 candidate 仍是当前 head 且预览 ready |
| `needs_review` | 用户成功回退 | `open` | `lastOutcome=rolled_back`，不得变为 resolved |
| `needs_review` | 用户标记失败或冲突无法处理 | `failed` | 错误和证据保留 |
| `failed` | 用户显式 retry | `applying` | 新建 AgentRun；不复用旧 Turn |
| `resolved` | 任何旧 Run 重放 | `resolved` | 旧 Annotation 不被重新执行；新需求创建新 Annotation |

`anchorStatus` 是独立状态。`stale` 或 `lost` 不能被当作 `resolved`；它们也不能通过状态机自动变回 `anchored`。

### 5.2 Confirm

`confirm` 只接受同时满足以下条件的 UserAction：

- Annotation 为 `needs_review`，AgentRun 已进入终态；
- candidate ArtifactVersion 仍是 Project current head，所有变化在 Hard Scope 内；
- before/after evidence 完整，diff 可读；
- 当前 `fileIndexVersion` 与 candidate 一致，预览状态为 `ready`；
- 没有外部冲突、scope violation 或未完成的 rollback journal。

Daemon 在一个 SQLite 事务中写入确认记录、将 candidate 标为 `confirmed`、更新 Project 的 current/confirmed version、将 Annotation 标为 `resolved`，并记录确认时的 preview/file index 引用。重复 confirm 是幂等的；candidate 已被其他动作改变时返回 `ARTIFACT_NOT_CURRENT`。

### 5.3 Rollback

P0 的回退入口是当前待审查 AgentRun 的 candidate 到其 `baseArtifactVersionId`；任意历史版本恢复、分支合并和选择性文件回退不属于 P0。回退是用户动作，不是删除 Annotation 或修改旧 ArtifactVersion。

回退成功后：

1. 磁盘内容恢复到 base 版本在本次 Run 前的确切字节，且重新扫描得到新的 `fileIndexVersion`。
2. 创建 `kind: rollback` 的新 ArtifactVersion，`parentArtifactVersionId` 是被回退的 current candidate，`restoreTargetArtifactVersionId` 指向原 base。
3. candidate、原 AgentRun 和原 Annotation 历史保持不变；candidate 标记为 `superseded`，被拒绝的用户意图由 UserAction 表示，不能删除。
4. Project current/confirmed version 指向新的 rollback 版本；Annotation 进入 `open`，保留 `lastOutcome=rolled_back`，用户可以编辑后重新发送。
5. 预览必须重新同步；刷新失败时 Project 保留诊断，不能让下一次 AgentRun 读取未确认的预览。
6. 关联的旧 Project Session 标记为 `blocked`，原因是上下文最后看到的 ArtifactVersion 已被回退；后续 AgentRun 要求用户显式 `start_new_session`，不能把 rollback 改写成旧 Session 的连续上下文。

回退失败时 Annotation 不进入 `resolved` 或 `open` 的成功路径。若任何文件当前 hash 不等于 candidate after hash，返回 `ROLLBACK_CONFLICT`，不写入任何文件；若应用中断，Project 为 `rollback_recovery_required`，直到 journal 恢复或人工处理完成。

## 6. 回退原子性和证据协议

### 6.1 前置条件

回退开始前 Daemon 必须在 Project mutation lock 下验证：

- 请求的 candidate 仍是 Project current head，且没有其他运行、外部冲突或未完成 journal；
- Content Root canonical binding 没有变化；
- candidate changeSet 中每个路径的当前内容、存在性和操作仍等于记录的 after 证据；
- 所有需要写回的 before blob 存在、hash 正确，目标路径仍在 Content Root 内；
- 目标状态的 File Index 和 Hard scope 不要求额外文件。

任一 precondition 失败时只写入 UserAction/诊断，不触碰 Content Root。这是“冲突时零写入”的合同保证。

### 6.2 Journal 化应用

Windows 普通文件系统不能为多个源文件提供这里所需的单一应用事务，因此 P0 使用可恢复的领域事务：

```text
validate all after state
  -> stage and hash all before bytes
  -> persist journal=prepared
  -> apply each path with per-file atomic replacement
  -> persist each operation result
  -> stable scan and compare rollback target
  -> persist journal=committed and ArtifactVersion
```

`MutationJournal` 在 `prepared` 之后必须足以让 Daemon 重启时继续恢复或明确停在 `rollback_recovery_required`。应用过程中可以短暂出现混合文件状态，但不能被 SSE、preview 或 UserAction 报告为完成；preview 应处于 stale/loading/error，直到稳定扫描确认整个目标状态。

如果某个文件替换失败，Daemon 不跳过该文件继续宣布成功。它重新检查所有路径：能够安全完成的恢复操作由 journal 继续；存在外部变化、证据缺失或无法确定状态时锁定 Project 并要求人工处理。回退结果只有在完整目标状态与 target manifest 一致后才创建 `rollback` ArtifactVersion。

### 6.3 Side-effect ledger

每个 AgentRun 的 side-effect ledger 是 append-only：

```text
SideEffect = {
  sideEffectId,
  runId,
  operation,
  path,
  before: { exists, contentHash, size },
  after: { exists, contentHash, size },
  source: stream | watcher | snapshot | reconciliation,
  allowed,
  confirmed,
  externalConflict,
  observedAt,
  idempotencyKey
}
```

`stream` 事件只能说明 CLI 声称发生了什么，不能把 `confirmed` 设为 true。稳定 watcher/快照/reconciliation 才能确认文件事实。即使变化越界、进程异常或回退失败，ledger 也必须保留对应路径和证据状态。

## 7. 外部文件变化和冲突

### 7.1 AgentRun 期间

Daemon 以 base FileIndex 和 writePaths 做三方事实比较：

| 稳定结果 | 判定 | 行为 |
| --- | --- | --- |
| 允许路径从 base 变为 Agent 预期 after，其他相关路径不变 | Agent 变化 | 可创建 candidate，继续等待预览审查 |
| 任意允许路径既不是 base 也不是预期 after | 外部冲突 | 不覆盖；Run 为 `EXTERNAL_CONFLICT`，保留两侧证据 |
| 未列入 writePaths 的 Project 源路径发生变化 | 范围/外部冲突 | 不把结果确认成功；保留变化并要求 reload/review |
| 文件被删除、重命名或出现 Content Root 外副作用 | scope violation | 禁止确认，保留 ledger，回退或人工处理 |
| watcher 报告变化但最终字节等于预期 after | 内容无冲突但来源不确定 | 以 hash 为事实，保留 provenance=indeterminate 诊断，不重复写入 |

AgentRun 运行期间的外部修改不得被 Agent 的 after 写回覆盖。若变化发生在 AgentRun 启动前，preflight 直接以 `INPUT_VERSION_STALE` 拒绝启动；若发生在运行后但确认前，candidate 不能 confirm。

### 7.2 确认后和重新打开 Project

用户确认后发生的稳定外部变化不改写历史 ArtifactVersion。Daemon 先产生新的 FileIndexSnapshot，并以 `external_observation` 记录 hash/路径变化；Project 进入 `conflict` 或待重新加载状态，直到用户明确接受外部状态成为新的基线。后续 AgentRun 不能基于旧 confirmed version 静默继续。

文件事件和刷新事件的 envelope、稳定等待、重连和 replay 由 #8 决定；本合同只要求这些事件最终以完整 snapshot 进入上述比较，不能用事件顺序猜测版本。

## 8. 回退后的锚点和 Project Session

### 8.1 旧 Annotation 和锚点

回退恢复的是源字节，不是 Annotation 的历史捕获。Annotation 保留创建时的 `capturedArtifactVersionId`、`capturedFileIndexVersion`、`contentHash`、Slide ID、Stable Element ID、截图和原始几何；这些字段不得被回退操作覆盖。

回退生成新 ArtifactVersion 后，Daemon 为仍可见的 Annotation 追加一次 anchor observation：

- Stable Element ID、Slide ID、sourcePath 和 contentHash 在当前版本全部精确匹配时，标记为 `reanchored`，因为它是新版本上的重新验证，不是假装仍在旧版本；
- 元素身份缺失或结构不一致时标记为 `stale` 或 `lost`，要求用户确认/重新定位；
- 不能用坐标、文本相似度或 selector 猜测另一个元素来自动恢复；
- `anchored`/`reanchored` 只表示可通过精确身份验证的锚点。`stale`/`lost` 不能直接创建新的 AgentRun。

Annotation 的业务状态独立于 anchorStatus：回退后的原 Annotation 为 `open`，已 `resolved` 的历史 Annotation 不因为后续回退而被重新打开；用户要提出新修改时创建新的 Annotation。

### 8.2 Project Session

Project Session 不是 CLI 进程，也不是 ArtifactVersion。它只能在以下绑定仍成立时 resume：Project、canonical Content Root、provider/model、权限/MCP fingerprint、`lastArtifactVersionId`、`lastFileIndexVersion` 和 CLI opaque session ID 都通过 AgentRun 合同校验。

状态处理如下：

| 事件 | Session 行为 |
| --- | --- |
| candidate 被用户 confirm | 若所有 resume 条件仍满足，更新同一 Session 的 last ArtifactVersion/File Index；否则标记 `blocked` |
| candidate 被 rollback | 旧 Session 一律 `blocked`，记录 rollback 原因，不静默调整 last version |
| 外部冲突或未完成恢复 | `blocked`，先完成 reload/recovery |
| CLI 明确拒绝 opaque session ID | `expired`，用户选择 `start_new_session` |
| 用户显式创建新 Session | 新建 `sessionId`，保留 `replacedSessionId` 审计关系，不复制旧对话身份 |

新 Session 不会抹掉旧 Session 的 Turn、AgentRun 或 ArtifactVersion。回退后“继续对话”必须是用户可见的 `start_new_session` 决策，而不是 Daemon 为了方便自动 resume。

## 9. 错误和可操作动作

版本/回退层至少使用以下错误语义：

| code | 阶段 | 含义 | 用户动作 |
| --- | --- | --- | --- |
| `INPUT_VERSION_STALE` | preflight | 请求的 Project/File Index 已不是当前状态 | `reload_project` |
| `PROJECT_STATE_LOCKED` | preflight | 另一个 Run、回退或恢复正在进行 | `wait_or_review` |
| `ARTIFACT_EVIDENCE_INCOMPLETE` | reconcile | 缺少稳定 before/after 证据 | `review_changes_or_recover` |
| `ARTIFACT_NOT_CURRENT` | confirm/rollback | candidate 不再是当前 head | `review_conflict` |
| `NO_EFFECT` | reconcile | Run 没有产生允许的文件变化 | `edit_request_and_retry` |
| `EXTERNAL_CONFLICT` | reconcile | 外部变化与 Run 变化不能安全区分/合并 | `review_conflict` |
| `SCOPE_VIOLATION` | reconcile | 发生未授权路径、删除或重命名 | `rollback_or_manual_resolve` |
| `ROLLBACK_CONFLICT` | rollback | 当前内容不再等于 candidate after | `review_current_files` |
| `ROLLBACK_RECOVERY_REQUIRED` | rollback/restart | journal 应用被中断或结果不确定 | `recover_or_manual_resolve` |
| `ANCHOR_REVALIDATION_REQUIRED` | preflight | 旧 Annotation 不能精确绑定当前版本 | `reanchor_annotation` |
| `PREVIEW_REFRESH_FAILED` | preview | 源文件证据有但预览未 ready | `reload_preview` |

错误必须携带 `projectId`、相关 opaque ID、Project-relative Path、hash/状态摘要和用户动作，不携带绝对路径、凭证、完整 Prompt、源文件或图片内容。

## 10. P0 验收场景

实现本合同至少需要能在固定 HTML Project 上重复证明：

1. 同一 canonical Content Root 重新打开复用 `projectId`，初次 scan 创建可识别的 initial ArtifactVersion。
2. Annotation 保存时固定 capture ArtifactVersion/File Index、截图、DOM 上下文、Slide ID 和 Stable Element ID；过期输入不能静默改用最新版本。
3. 一次修改多个允许文件时只产生一个 candidate ArtifactVersion，changeSet 对每个文件都有完整 before/after hash，必要时可以读取确切字节和 diff。
4. Agent 正常结束但未产生变化、异常退出前已写入、取消前已写入时，Run/Annotation 分类正确且证据不丢失。
5. 用户在 preview ready 前不能 confirm；confirm 后 Annotation 才变为 `resolved`，确认记录可重放且幂等。
6. 用户 rollback 后所有变化文件恢复为 base 的确切内容，产生新的 rollback ArtifactVersion，预览重新同步，Annotation 不变为 `resolved`。
7. 回退前任一文件被外部修改时零文件写入；回退中断后重启能依据 journal 恢复或明确阻塞，不能宣称部分回退成功。
8. AgentRun 期间修改未授权文件或 Project 其他源路径时，不覆盖外部变化、不允许 confirm，并保留 conflict/scope evidence。
9. 回退后的旧 Annotation 使用新版本追加 anchor observation；无法精确匹配时为 `stale`/`lost`，旧 Project Session 不能被静默 resume。
10. 诊断、事件和版本查看接口不暴露 Content Root 绝对路径或凭证；失败版本仍可显示下一步用户动作。

## 11. 明确不属于 P0

- 多 Annotation 的原子 AgentRun、运行中追加指令、并行写入和复杂 Session 编排；
- 任意历史 ArtifactVersion 的分支合并、三方 merge、部分文件回退和自动 rebase；
- 自动猜测失效锚点、自动把 rollback 改写成旧 Session 的连续对话；
- 静默覆盖外部编辑、默认接受冲突版本或只按 mtime 判定版本；
- 远程/多人/云端持久化、正式发布和跨 Project 的证据共享。
