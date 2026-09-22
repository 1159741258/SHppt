# P0 Claude CLI 与 AgentRun 合同

状态：已决定，合同版本 `1`

对应票据：[Claude CLI 能力、权限与 AgentRun 合同](https://github.com/1159741258/SHppt/issues/6)

上游合同：[P0 MVP：视觉标记驱动的 Agent PPT 编辑器](./p0-mvp-acceptance.md)、[P0 HTML-first Project 与 Deck 合同](./html-first-project-deck-contract.md)

本文件把 Claude CLI 在 P0 中的探测、启动、续接、停止、授权、Prompt、流事件、副作用、取消、重试、恢复和错误动作具体化。它定义 Daemon 对外可观察的行为，不把某一个 CLI 版本的内部实现当作产品合同。

## 1. 决策摘要

P0 采用以下执行模型：

```text
已保存 Annotation + 当前 File Index
  -> Daemon 预检和能力探测
  -> 新建或安全续接 Project Session
  -> 新建一个 AgentRun / Turn
  -> 受控 Claude CLI 进程读取一条 stream-json 输入
  -> 解析规范化事件并记录 side-effect ledger
  -> 等待文件稳定，重建 File Index 和 ArtifactVersion
  -> 刷新预览
  -> needs_review，用户确认或回退
```

以下规则是硬约束：

- 浏览器只能请求 Daemon；浏览器不得启动 CLI、传递绝对路径或直接写文件。
- 一次 P0 AgentRun 只绑定一条已保存 Annotation、当前 `baseArtifactVersionId`、一个 `baseFileIndexVersion` 和一个 Turn。
- Prompt 的 Hard Scope 不能由用户文字、CLI 输出或模型工具调用扩大。
- 正常 AgentRun 不使用 `bypassPermissions`，也不使用只适合探测的 `--no-session-persistence`。
- 进程退出、流终点和文件变化必须一起经过 terminal reconciliation；退出码不是成功条件。
- 有副作用但状态不确定时进入 `needs_review`/恢复路径，不自动重复修改。
- 运行完成后 Annotation 最多进入 `needs_review`；只有用户查看并确认后才能进入 `resolved`。

## 2. 领域边界

### 2.1 Project Session

`Project Session` 是一个 Project 与一个 Agent provider 之间可跨多个 AgentRun 复用的对话上下文。它不是子进程，也不是 ArtifactVersion。

```text
ProjectSession = {
  sessionId,
  projectId,
  providerId,
  cliSessionId,
  model,
  contentRootBinding,
  lastArtifactVersionId,
  lastFileIndexVersion,
  permissionFingerprint,
  mcpFingerprint,
  status,
  createdAt,
  updatedAt
}
```

`contentRootBinding` 由 Daemon 保存在受信任状态中；浏览器和 Agent-facing 消息只使用 `projectId` 和 Project-relative Path。`cliSessionId` 是 CLI 返回的 opaque ID，不能由路径、Prompt 或用户输入推导。

Session 状态只有以下语义：

| 状态 | 含义 |
| --- | --- |
| `new` | 尚未获得可续接的 CLI session ID。 |
| `ready` | 有可续接 ID，且最近一次 terminal reconciliation 已完成。 |
| `blocked` | 续接前置条件不满足，必须重新探测或由用户选择新 Session。 |
| `expired` | CLI 明确拒绝该 session ID；不能静默替换。 |

P0 默认在所有续接条件满足时复用 `ready` Session；不满足时返回可操作错误，由用户明确选择 `start_new_session` 或先修复冲突。新 Session 会保留旧 Session 的审计记录，但不共享其 CLI 对话身份。

### 2.2 AgentRun

`AgentRun` 是一次受控修改任务，关联一条 Annotation、当前 `ArtifactVersion`、一个 File Index 输入版本、一个 Project Session 和一个可审计的副作用集合。它是重试和回退的边界。首次运行也必须有可识别的初始版本基线；具体持久化形状由 ArtifactVersion 合同决定。

```text
AgentRun = {
  runId,
  projectId,
  annotationId,
  sessionId,
  retryOf,
  baseArtifactVersionId,
  baseFileIndexVersion,
  hardScope,
  permissionLease,
  turnId,
  capabilitySnapshot,
  requestedMode: new | resume,
  observedProvider,
  observedModel,
  state,
  error,
  sideEffectSummary,
  artifactVersionId,
  createdAt,
  startedAt,
  terminalAt
}
```

P0 一次只处理一条 Annotation。重复提交同一 `annotationId` 时，若已有非终态 AgentRun，Daemon 返回已有 `runId`，不再启动第二个进程。

### 2.3 Turn

`Turn` 是一次模型交互。它拥有自己的输入、stream frame cursor、规范化事件、用量和 terminal 标记。P0 中：

- 一个 AgentRun 恰好创建一个 Turn；
- 一次 Turn 只发送一个用户输入 frame，然后关闭 stdin；
- 中途追加指令、多个用户输入 frame 和继续当前 Turn 均为 P1；
- 重试不会复用旧 Turn，而是创建新的 AgentRun 和新的 Turn，并通过 `retryOf` 关联。

`--resume` 只表示在新的 Turn 中复用 CLI 对话上下文，不表示从进程中间的字节位置继续执行。

### 2.4 Hard Scope

Hard Scope 是 AgentRun 的逻辑修改边界，至少包括：

```text
HardScope = {
  slideIds,
  stableElementIds,
  geometry,
  sourcePaths,
  allowedChangeKinds,
  directLayoutPaths,
  acceptanceCriteria
}
```

P0 允许的 `allowedChangeKinds` 由 Annotation 决定，通常是文本、样式或选区内直接布局。除非在创建 Annotation 时已经明确授权，否则以下操作始终越界：

- 修改其他 Slide 或其他 Stable Element ID；
- 修改全局主题、全局 CSS token 或未列入 `sourcePaths` 的文件；
- 删除、重命名、移动文件；
- 安装依赖、改动 Project metadata、写入 `.git`、`.shppt`、`node_modules`、`dist`、`build` 或 `coverage`；
- 访问或写入 Content Root 之外的路径；
- 以用户文字为理由扩大上述范围。

没有稳定 DOM 目标的画笔/文字 Annotation 仍可执行，但必须有明确的 Slide、区域几何和 `sourcePaths`。无法得到有限写入集合时，预检失败并返回 `WRITE_SCOPE_UNRESOLVED`，不让模型自行猜测文件。

## 3. CLI 能力探测

### 3.1 Provider 接口

Daemon 通过 provider seam 隔离 CLI 版本差异。实现至少提供以下能力：

```text
AgentProvider = {
  id,
  probe,
  buildInvocation,
  encodeTurn,
  parseFrame,
  reconcileTerminal,
  resumePolicy,
  permissionPolicy
}
```

`probe` 的结果而不是 CLI 版本号决定 `buildInvocation` 可以使用哪些参数。P0 不允许仅因为版本字符串“看起来足够新”就传递未探测的 flag。

### 3.2 P0 探测顺序

Daemon 对配置的 executable 做有界探测，所有命令都通过 `spawn`/`execFile` 调用，不拼接 shell 字符串：

1. 解析 executable，确认文件存在且可启动；记录版本的脱敏文本和探测时间。
2. 读取与实际子命令相关的 help，识别 `-p`、`--input-format stream-json`、`--output-format stream-json`、`--verbose`、`--resume`、`--add-dir`、permission mode 和工具限制能力。
3. 运行认证探测，结果只归类为 `authenticated`、`unauthenticated` 或 `unknown`；不得保存原始环境变量、token 或未经脱敏的 stderr。
4. 在 Daemon 创建的临时、无用户文件探测目录执行一次有界的 stream-json smoke test。探测使用无工具、无写入权限的模式；它只能证明协议握手，不得修改 Content Root。
5. 从初始化/结果 frame 读取实际 `provider`、`model` 和 session 能力。CLI 名称 `claude` 不代表实际 provider/model，运行记录以 CLI 返回值为准。

探测结果的最小形状如下：

```text
CapabilitySnapshot = {
  providerId,
  executableLabel,
  version,
  detectedAt,
  authState,
  actualProvider,
  actualModel,
  supports: {
    inputStreamJson,
    outputStreamJson,
    verboseForStreamJson,
    resume,
    addDir,
    nonBypassPermissionMode,
    toolRestriction
  },
  probeState: passed | failed,
  failureCode
}
```

P0 正常写入至少要求 `inputStreamJson`、`outputStreamJson`、`verboseForStreamJson`、`addDir` 和 `nonBypassPermissionMode` 为 true。只有用户明确选择续接时才额外要求 `resume`。`toolRestriction` 不可用本身不是立即失败；但如果 Daemon 不能仅依靠 Content Root 边界和运行后核验建立安全合同，就必须拒绝写入型 AgentRun。

探测缓存必须在 executable、认证配置、provider 配置或应用合同版本变化时失效。探测命令超时、协议无效或能力不完整时，AgentRun 停在 `preflight`，不创建 ArtifactVersion。

### 3.3 启动参数

正常 P0 AgentRun 的参数由探测结果筛选，形状等价于：

```text
claude -p
  --input-format stream-json
  --output-format stream-json
  --verbose
  --add-dir <canonical Content Root>
  <permission flags proven by probe>
  [--resume <cliSessionId>]
```

具体 flag 顺序不是合同的一部分。以下规则是合同的一部分：

- Prompt 通过 stdin 的 JSON frame 传递，不通过命令行参数传递长文本。
- `cwd` 固定为已 canonicalize 且通过 HTML-first 合同校验的 Content Root。
- `--resume` 只在 `requestedMode=resume` 且所有续接条件通过时传递。
- `--no-session-persistence` 只用于无副作用探测或诊断，不用于正常 AgentRun。
- `bypassPermissions` 永远不是 P0 默认或回退选项。
- Daemon 不把原始 CLI 参数、环境变量、认证输出或完整 Prompt 写进面向用户的错误和诊断包。

## 4. Session 启动与续接

### 4.1 新 Session

新 Session 的预检必须确认：Project 可编辑、Annotation 已保存、`baseArtifactVersionId` 与当前项目状态一致、Hard Scope 有限、当前 File Index 未过期、Content Root 仍为同一 canonical binding、能力探测通过、用户已触发本次写入动作。

Daemon 启动 CLI 后从初始化或结果 frame 提取 `cliSessionId`。如果 CLI 没有返回 session ID，AgentRun 仍可以在其他条件满足时进入审查，但 Project Session 保持 `new`，后续续接必须由用户选择新 Session 或重新配置 provider。

### 4.2 Resume Session

传递 `--resume` 前必须同时满足：

1. `ProjectSession.projectId` 与 AgentRun 的 Project 相同；
2. Content Root canonical binding 相同；浏览器请求不能提供替代路径；
3. 当前 `ArtifactVersion` 与 Session 的 `lastArtifactVersionId` 相同，且当前 `FileIndexVersion` 与 Session 的 `lastFileIndexVersion` 相同，或已有用户确认的 ArtifactVersion 明确成为新的基线；
4. provider、实际模型约束和 permission fingerprint 相同；
5. MCP 配置 fingerprint 相同；
6. `cliSessionId` 非空，且 capability snapshot 支持 resume；
7. 没有未完成 AgentRun、外部文件冲突或未处理的 scope violation。

任一条件不满足都返回 `SESSION_CONTEXT_MISMATCH`、`SESSION_RESUME_UNSUPPORTED` 或对应的具体错误。Daemon 不静默把 resume 改成 new；用户可以执行 `start_new_session`，这会创建新的 `sessionId` 并在审计记录中保留 `replacedSessionId`。

### 4.3 进程停止与断线

CLI 进程不是 Session 的生命周期持有者。正常 Turn 结束后关闭 stdin、等待进程退出并执行 reconciliation。UI 断线不取消运行；Daemon 重启后扫描未终态 AgentRun，重新取得文件事实并把它们交给 terminal reconciliation，不自动重跑。

## 5. Project 与文件写入授权

### 5.1 两层边界

AgentRun 同时受到两层边界约束：

1. **物理边界**：Content Root 是 CLI 的工作目录和 `--add-dir` 范围。Daemon 在启动前重新 canonicalize，并拒绝 UNC、网络驱动器、reparse point、越界路径和 HTML-first 合同中的受保护路径。
2. **逻辑边界**：`permissionLease.writePaths` 是本次 Run 允许变化的 Project-relative Path 集合，必须是 Hard Scope 的有限投影。

```text
PermissionLease = {
  leaseId,
  projectId,
  baseFileIndexVersion,
  readPaths,
  writePaths,
  expiresAt,
  userActionId,
  permissionMode,
  status: active | expired | revoked
}
```

绝对路径只存在于 Daemon 的受信任进程状态和 CLI spawn 参数中；事件、Prompt 结构化上下文、错误、ArtifactVersion 关联和浏览器消息只使用 Project-relative Path。

`readPaths` 是当前 File Index 中为该 Run 提供的非受保护输入集合；受保护目录和未被授权的文件不因位于 Content Root 内就自动进入 Agent-facing 上下文。`PermissionLease` 过期或被撤销时，Daemon 停止接受新的授权写入，按取消流程终止进程并执行 reconciliation；任何实际变化仍必须标记并保留在 ledger 中。

### 5.2 写入集合

`writePaths` 在启动前冻结，至少包含 Annotation 指向的目标源文件；直接布局文件只能在 Annotation/DOM 上下文明确提供且通过预检时加入。运行中发现需要新文件或新路径时不能自动扩大集合，而是进入 `WRITE_SCOPE_UNRESOLVED`。

Daemon 在启动前保存 `writePaths` 的存在状态、size、mtime 和 contentHash，并保留用于 ArtifactVersion/回退的精确 before 内容。运行中通过 watcher 和周期性快照记录变化；进程稳定后对整个 File Index 做一次比较。CLI 输出的 `file_written` 事件只是线索，不能替代真实文件事实。

P0 的成功判定要求：

- 所有实际变化都在 `writePaths` 内；
- 没有删除、重命名、移动或 Content Root 外副作用；
- before/after 证据完整；
- 当前 File Index 由稳定文件状态重新生成；
- ArtifactVersion 和预览刷新都成功。

如果 CLI 版本无法提供 Content Root 边界或只能通过 bypass 权限运行，写入型 AgentRun 在启动前失败。若 CLI 仍在运行中产生未授权变化，Daemon 必须记录 scope violation，禁止成功，保留证据并进入回退/人工处理；不能用“Prompt 已经写了限制”替代授权判断。

### 5.3 Prompt 不是授权

Prompt 由 Daemon 组装，用户文字作为不可信数据插入独立区块。推荐的逻辑结构是：

```text
<shppt-agent-contract version="1">
Hard scope: ...
Allowed Project-relative write paths: ...
Allowed change kinds: ...
Do not modify other slides, files, global tokens, metadata, or dependencies.
</shppt-agent-contract>
<project-context>...
</project-context>
<user-request>untrusted annotation note</user-request>
<acceptance-criteria>...</acceptance-criteria>
```

上下文至少包含 `projectId`、`baseArtifactVersionId`、`baseFileIndexVersion`、`slideId`、当时的 `slideIndex`、目标 `sourcePath`、Stable Element ID/几何信息、当前文本或样式摘要、截图/evidence 引用、Hard Scope 和验收条件。不得把绝对路径、凭证或无关源文件内容放入 Agent-facing Prompt。

若用户要求超出 Hard Scope，PromptAssembler 返回 `PROMPT_SCOPE_CONFLICT`，要求创建新的 Annotation 或明确扩大范围；它不能替用户偷偷扩大 `writePaths`。

## 6. Stream JSON 与规范化事件

### 6.1 统一事件信封

Provider 解析原始 JSONL frame，并输出 Daemon 的统一事件。原始 frame 的具体 schema 不直接暴露给浏览器。

```text
AgentEvent = {
  eventId,
  eventSeq,
  runId,
  turnId,
  kind,
  sourceCursor,
  observedAt,
  dedupeKey,
  payload
}
```

P0 的 `kind` 至少包括：

| kind | 语义 | 关键 payload |
| --- | --- | --- |
| `run.started` | Daemon 已创建运行上下文 | `sessionId`, `baseArtifactVersionId`, `baseFileIndexVersion` |
| `turn.started` | CLI Turn 已启动 | `requestedMode`, `cliSessionId?` |
| `run.text-delta` | 可展示的增量文本 | `text`, `isSummary` |
| `run.tool-call` | CLI 请求/执行工具 | `toolUseId`, `toolName`, `path?`, `redactedInput` |
| `run.tool-result` | 工具结果摘要 | `toolUseId`, `status`, `redactedSummary` |
| `run.file-written` | CLI 声称发生文件写入 | `path`, `contentHash?`, `observed=false` |
| `run.usage` | 用量或成本摘要 | `inputTokens?`, `outputTokens?`, `provider`, `model` |
| `turn.ended` | Turn 终点已归一化 | `reason`, `cliResult?` |
| `run.terminal` | AgentRun 已完成 reconciliation | `state`, `sideEffectSummary`, `error?` |

文件事件在 reconciliation 前标记 `observed=false`；只有 watcher/快照确认后才会写入 side-effect ledger 的 confirmed 事实。

### 6.2 幂等与终点规则

- Daemon 为每个 Turn 持久化 `sourceCursor`。优先使用 CLI 提供的 frame/event ID；没有时使用稳定的读取序号加 frame hash。相同 cursor 的重放只能产生一次规范化事件；不同序号的相同文本仍是两次有效 delta。
- `toolUseId` 是工具调用的去重键；同一 `toolUseId` 的重复 frame 只能更新诊断信息，不能创建第二次工具调用。
- 文件副作用以 `runId + path + afterContentHash + operation` 建立幂等键；同一文件不同内容的连续变化必须保留为不同事实，不能只按路径去重。
- `turn.ended` 和 `run.terminal` 都使用 `emitOnce` 语义。`result` frame、EOF、进程退出或错误 frame 中任意多个终点只能归一为一次终点；额外终点进入诊断计数。
- 事件流重连时，客户端先拉取当前 AgentRun/Project 快照，再按 `eventSeq` 应用可用增量。事件是增量通知，不是唯一数据源；缺失历史事件不能让客户端把运行猜成成功。
- 单条 payload 超过预算时保留事件类型、ID、路径、hash、状态和副作用摘要，截断文本/工具输出并设置 `isSummary=true`。不能为了压缩而丢弃 scope violation、文件变化或 terminal 证据。

`eventSeq` 在 Daemon 的 Project 事件流中单调递增，SSE/其他流式传输可以用它作为重连游标；`eventId` 必须在同一个 Run/Turn 内稳定。

## 7. AgentRun 生命周期

### 7.1 状态

```text
created
  -> preflight
  -> starting
  -> running
  -> cancelling
  -> reconciling
  -> needs_review | failed | cancelled
```

`needs_review` 是一个终态运行结果，不等于用户确认。只有预览和 ArtifactVersion 可检查且用户确认后，关联 Annotation 才进入 `resolved`。AgentRun 自身保留 terminal 状态和审计记录。

状态转移约束：

- `created`/`preflight` 失败不会启动 CLI；
- `starting`/`running` 只能由同一 owner 取消；重复取消是幂等 no-op；
- 所有进程退出路径都必须经过 `reconciling`，包括异常、超时、Daemon 重启和取消；
- `reconciling` 发现任何未确认的文件变化时不能直接进入成功；
- 已进入终态的 Run 不再接受新的 stdin 或 steering frame。

### 7.2 终点判定

| 事实组合 | AgentRun 结果 | 用户动作 |
| --- | --- | --- |
| stream 正常结束、退出码为零、仅允许文件变化、ArtifactVersion 和预览 ready | `needs_review` | 查看后确认或回退 |
| 退出码为零但没有允许文件变化 | `failed` / `NO_EFFECT` | 修改要求后安全重试 |
| 进程失败且没有任何副作用 | `failed` | 查看错误后安全重试 |
| 进程失败但有已确认或不确定副作用 | `needs_review` / `RECOVERY_REQUIRED` | 查看变化，回退或人工处理后再决定 |
| 发现未授权路径、删除、重命名或越界变化 | `failed` / `SCOPE_VIOLATION` | 禁止确认，回退或人工修复 |
| 运行期间有外部修改与 Run 变化冲突 | `failed` / `EXTERNAL_CONFLICT` | 重新加载、对比并人工选择 |
| 取消前没有副作用 | `cancelled` | 可创建新的 AgentRun |
| 取消前有副作用 | `needs_review` / `CANCELLED_WITH_SIDE_EFFECTS` | 先审查或回退，禁止盲目重试 |
| 预览刷新失败但源文件证据完整 | `needs_review` / `PREVIEW_REFRESH_FAILED` | 修复/重载预览后再确认 |

## 8. Side-effect ledger

side-effect ledger 是每个 AgentRun 的 append-only 事实记录。它不能只记录“模型说写了什么”，也不能只记录最终退出码。

```text
SideEffect = {
  sideEffectId,
  runId,
  operation: create | write | delete | rename | tool | artifact,
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

规则如下：

1. `before` 来自 AgentRun 启动前、与 `baseFileIndexVersion` 对齐的快照；启动前 hash 不一致时不启动。
2. `stream` 只能产生 `confirmed=false` 的线索；`watcher` 和稳定后 snapshot/reconciliation 才能确认真实变化。
3. 记录 Project-relative Path、hash、size 和状态，不在事件中记录绝对路径或完整源文件内容。完整 before/after 内容由 ArtifactVersion 合同按需保存。
4. 允许集合之外的变化、外部并发变化和无法判断的中间状态都必须保留，不能被过滤掉。
5. 进程退出后先查询 ledger，再决定 `failed`、`needs_review`、可安全重试或需要回退。

## 9. 取消、重试与恢复

### 9.1 Cancel

取消请求写入 `cancelRequestedAt` 并把 Run 置为 `cancelling`。Daemon 先关闭 stdin/请求优雅结束，在有界等待后终止整个子进程树，随后必经文件稳定等待和 reconciliation。取消接口必须可重入：第一次请求执行取消，后续相同请求返回同一个 Run 状态。

取消不会删除 Annotation、Session、事件或 before evidence。UI 断线不等于取消；Daemon 关闭或崩溃也不等于取消。

### 9.2 Retry

重试总是创建新的 `runId` 和 `turnId`，保留 `retryOf`。以下条件全部满足时可安全重试：

- 原 Run 没有任何已确认或不确定的写入副作用；
- 当前 File Index 仍等于原 Run 的基线，且没有外部冲突；
- 原 Run 的 Session/权限/能力错误已经修复或已选择新的 Session；
- 新 Run 重新执行完整 preflight。

如果已有副作用，必须先让用户审查并回退到精确的 before ArtifactVersion，或人工解决冲突。回退完成后仍要生成新的 File Index，再创建新 Run；不能用同一个 Run 覆盖历史。

### 9.3 Daemon 重启

Daemon 启动恢复时：

1. 找到所有非终态 AgentRun 和其最后持久化的 frame cursor；
2. 重新扫描 Content Root，建立当前文件事实；
3. 将进程是否存在、文件变化、最后事件和 session ID 交给 reconciliation；
4. 选择 `needs_review`、`failed` 或 `cancelled`，不自动发送重复 Prompt；
5. 只有用户明确创建新 AgentRun 时才继续执行。

恢复不保证从 CLI stream 的中间字节位置继续；它保证不把不确定状态伪装成无副作用失败。

## 10. 错误到用户动作

错误统一形状如下：

```text
AgentRunError = {
  code,
  runId,
  phase: preflight | start | stream | write | reconcile | preview,
  retryable,
  sideEffects: none | allowed | unknown | unauthorized | conflict,
  userAction,
  redactedContext,
  causeId
}
```

`redactedContext` 只能包含脱敏的阶段、能力名、Project-relative Path、退出分类、hash 和摘要；不得包含 token、认证环境变量、完整 Prompt、完整 stderr、源文件或图片内容。

| code | 发生阶段 | retryable | userAction |
| --- | --- | --- | --- |
| `CLI_NOT_FOUND` | preflight | 否，修复后可重试 | `install_or_configure_cli` |
| `CLI_AUTH_REQUIRED` | preflight | 否，鉴权后可重试 | `authenticate_cli` |
| `CLI_CAPABILITY_UNSUPPORTED` | preflight | 否，换兼容配置/版本 | `inspect_diagnostics` |
| `CLI_PROBE_FAILED` | preflight | 是 | `inspect_diagnostics` |
| `PROJECT_NOT_EDITABLE` | preflight | 否，修复 Project | `fix_project` |
| `WRITE_SCOPE_UNRESOLVED` | preflight | 是，需重建 Annotation | `recreate_annotation` |
| `PROMPT_SCOPE_CONFLICT` | preflight | 是 | `recreate_annotation` |
| `INPUT_VERSION_STALE` | preflight | 是 | `reload_project` |
| `SESSION_CONTEXT_MISMATCH` | preflight | 否，需选择 | `start_new_session` |
| `SESSION_RESUME_UNSUPPORTED` | preflight | 否，需选择 | `start_new_session` |
| `CLI_START_FAILED` | start | 是，副作用为 none 时 | `retry_safe` |
| `STREAM_INVALID` | stream | 依副作用而定 | `review_changes_or_retry` |
| `STREAM_TRUNCATED` | stream | 依副作用而定 | `review_changes_or_recover` |
| `WRITE_DENIED` | write | 是，副作用为 none 时 | `fix_permissions` |
| `SCOPE_VIOLATION` | reconcile | 否 | `rollback_or_manual_resolve` |
| `EXTERNAL_CONFLICT` | reconcile | 否，解决后可重试 | `review_conflict` |
| `NO_EFFECT` | reconcile | 是 | `edit_request_and_retry` |
| `CANCELLED_WITH_SIDE_EFFECTS` | reconcile | 否，先审查 | `review_changes_or_rollback` |
| `PROCESS_FAILED` | reconcile | 仅副作用为 none 时 | `retry_safe_or_review` |
| `PREVIEW_REFRESH_FAILED` | preview | 是 | `reload_preview` |

用户界面应展示发生阶段、是否已经改动文件、是否可安全重试和下一步动作；不应只展示 CLI stderr。

## 11. P0 验收证据

实现本合同至少需要用固定测试夹具或 fake provider 重复证明：

1. 缺少 CLI、未鉴权、stream-json/verbose/add-dir/非 bypass 能力不足时，Run 在启动前失败，Annotation 保留且没有 ArtifactVersion。
2. 版本不同但 help/握手能力相同的 CLI 使用相同参数；实际 provider/model 从 frame 记录，不从 executable 名称猜测。
3. 新 Session 成功产生 `cliSessionId`；同 Project、同基线、同 provider/model/权限/MCP 才能 resume；任一不一致都需要用户选择新 Session。
4. Prompt 含 Hard Scope、Project-relative Path、目标上下文和验收条件；用户 note 不能扩大 scope。
5. 重放同一 frame、toolUseId 或 terminal frame 不产生重复事件；相同文本但不同 source cursor 不被错误去重。
6. 正常退出但无文件变化、异常退出前已写文件、取消前已写文件和 Daemon 重启后的未终态 Run 都按第 7 节分类。
7. 写入允许集合外、删除/重命名文件、修改其他 Slide 或外部冲突时，Run 不能进入可确认成功，且 ledger 保留证据。
8. 取消重复调用不重复终止或创建终点；安全重试创建新的 Run/Turn，不覆盖旧审计记录。
9. 事件重连先获得快照，再按 `eventSeq` 应用增量；过大的文本被摘要化，但文件、副作用和终点证据保留。
10. 错误对象不包含凭证、完整 Prompt、完整源文件或图片，并提供与场景匹配的 `userAction`。

## 12. 明确不属于 P0

- Turn 中途 steering、批量 Annotation、运行中排队和多 Annotation 原子提交；
- 自动猜测失效 Session、自动从冲突版本继续或无用户确认的 retry；
- 默认 `bypassPermissions`、浏览器直接访问文件系统或把 Content Root 之外路径交给 CLI；
- 仅凭退出码、模型文本或 CLI `file_written` frame 宣布成功；
- 不受限的全局主题修改、任意依赖安装和远程资源写入；
- 把完整 Prompt、源文件、图片或认证信息放入默认诊断包。
