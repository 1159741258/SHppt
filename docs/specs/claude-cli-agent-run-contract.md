# P0 Claude CLI 与 AgentRun 合同

状态：已决定，合同版本 `1`

对应票据：[Claude CLI 能力、权限与 AgentRun 合同](https://github.com/1159741258/SHppt/issues/6)

本合同在 [HTML-first 项目与 Deck 合同](./html-first-project-deck-contract.md) 的物理 `Content Root` 边界内，定义 Claude CLI 的探测、启动、续接、停止、流式事件、写入授权、幂等、side-effect 记录、恢复和错误动作。它落实 [P0 MVP](./p0-mvp-acceptance.md) 对一次受控 AgentRun 的要求。

本合同不改变 Project、File Index、Slide ID、Stable Element ID 或 Project-relative Path 的定义；不把浏览器变成文件访问者或 CLI 启动者；也不提前规定 ArtifactVersion 的存储介质和文件监听的传输协议。ArtifactVersion 的完整持久化与回退规则由后续合同决定，但本合同要求 AgentRun 为其提供完整证据。

## 1. P0 决策摘要

1. Daemon 是唯一可以解析 Content Root、启动 Claude CLI、持有子进程和执行文件写入检查的边界持有者。Browser 只能提交引用 `projectId`、`fileIndexVersion` 和 Project-relative Path 的请求。
2. 启动前必须基于当前可执行文件的 `--version`、`--help`、鉴权状态和无工具协议探针建立能力快照。不能按 CLI 版本号猜测参数能力；运行时只传递已经确认支持的参数。
3. 一个 AgentRun 只处理一条已保存的 Annotation 和一个明确的 ArtifactVersion 基线。P0 不支持批量 Annotation、运行中追加指令或跨 Annotation 复用 Session。
4. 一个 AgentRun 有一个独立的 Project Session。普通执行有一个初始 Turn；进程或 Daemon 中断且没有已确认副作用时，才可以在同一 Session 中创建一个恢复 Turn。
5. Prompt 中的 Hard scope 由 Daemon 生成，并由 CLI 权限、Content Root 物理边界、side-effect ledger 和退出后的差异检查共同约束。Prompt 不是文件权限系统，也不能扩大写入授权。
6. P0 只允许修改预先列出的既有 Project-relative Path；不允许创建、删除、重命名文件，不允许修改其他 Slide、全局主题、受保护目录或 Project 外文件。
7. 流式输出按 JSONL 解析为版本化事件，事件先持久化再广播；重复帧、重复终点和断线重放必须幂等。进程退出码或单个 `result` 帧都不能单独宣布成功。
8. 任何异常退出、取消、Daemon 重启或流截断都必须先做 side-effect reconciliation。没有副作用才允许自动重试；有副作用或副作用未知时只能进入审查、回退或人工恢复路径。
9. 有效修改完成后 Annotation 进入 `needs_review`，而不是 `resolved`。只有用户查看预览和 ArtifactVersion 后明确确认，Annotation 才能进入 `resolved`。

## 2. 边界与生命周期

### 2.1 Project Session、AgentRun、Turn

| 概念 | 身份和生命周期 | P0 责任边界 |
| --- | --- | --- |
| `Project Session` | 一个不透明的 Claude CLI conversation/session identity，绑定一个 `projectId` 和一个 AgentRun；从启动到正常结束或失效。 | 提供同一 AgentRun 的上下文续接；不提供授权，不跨 Project 或 Annotation 复用。 |
| `AgentRun` | 一条 Annotation 在一个 `projectId + fileIndexVersion + ArtifactVersion` 基线上进行的一次受控修改任务。 | 保存 Hard scope、能力快照、权限配置、Turn、side-effect ledger、错误和 ArtifactVersion 关联。 |
| `Turn` | 一条 Daemon 提交的 user frame 及其对应的 assistant、tool、usage、terminal 事件。 | 初始执行一个 Turn；恢复执行最多创建一个新的 recovery Turn。没有 mid-turn steering。 |

`sessionId`、`runId` 和 `turnId` 都是独立的不透明标识。`sessionId` 不是访问令牌，单独拿到它不能绕过 Daemon 的 Project 和写入检查。

AgentRun 的最小受信记录为：

```text
AgentRun = {
  runId,
  annotationId,
  projectId,
  fileIndexVersion,
  baseArtifactVersionId,
  scope,
  sessionId,
  capabilitySnapshotId,
  permissionProfileHash,
  attempts,
  sideEffectLedgerId,
  status,
  outcome,
  createdAt,
  updatedAt
}
```

浏览器请求必须携带 `projectId`、`fileIndexVersion`、Annotation ID 和客户端幂等键；Daemon 从受信 Project 状态取得 `Content Root`，不能接受客户端提交的绝对路径来替换它。

### 2.2 Daemon 最小接口

接口只接受领域 ID、版本值、幂等键和 Project-relative Path；客户端不能提交 `Content Root`、CLI `sessionId`、进程 ID 或可执行文件路径。

```text
StartAgentRun = {
  clientRequestId,
  projectId,
  fileIndexVersion,
  annotationId,
  scopeConfirmationHash: string | null
}

ResumeAgentRun = {
  clientRequestId,
  runId
}

CancelAgentRun = {
  clientRequestId,
  runId,
  reason: user_requested | daemon_recovery
}

ReadAgentRunEvents = {
  runId,
  afterSequence: integer | null
}
```

`StartAgentRun` 的返回值是 `runId`、状态、脱敏 capability summary 和事件游标；`ResumeAgentRun` 和 `CancelAgentRun` 返回现有 AgentRun 的当前状态。相同的 `clientRequestId` 在同一 Project 下重放时返回相同结果，不重复创建 Run、Session、Turn 或 terminal effect。`ReadAgentRunEvents` 可以重放已持久化事件，客户端按 `eventId` 再次去重。

`scopeConfirmationHash` 只有在 Annotation 没有唯一 Stable Element ID，或用户确认了直接布局文件集合时才需要；它是 Daemon 根据展示给用户的 Hard scope 计算的 hash，不是客户端自由扩权的字段。Daemon 会重新计算并比较 scope，hash 不匹配就拒绝启动。

### 2.3 AgentRun 状态

```text
created -> validating -> starting -> running -> reconciling
                                      |             |
                                      |             +-> needs_review
                                      |             +-> failed
                                      |             +-> cancelled
                                      +-> stopping -> reconciling
```

- `validating` 期间检查 Annotation 是否已保存、快照是否仍然存在、锚点是否允许执行、能力是否满足以及写入集合是否可证明。
- `starting` 期间创建 `runId`、Session、基线快照和 ledger；子进程未通过启动确认前不能发送用户 Turn。
- `running` 期间只能处理本 AgentRun 的一个 Turn；重复的启动请求返回同一个 `runId`，不能产生第二个子进程。
- `stopping` 只表示已收到取消意图；真正的结果要等子进程清理和 reconciliation 完成。
- `needs_review` 表示已经产生可见变化或副作用状态无法证明为空，用户必须查看、确认或回退。
- `failed` 表示没有可接受 ArtifactVersion；如果确认没有写入且基线未变，可以重试。
- `cancelled` 只表示用户取消且没有副作用；如果取消时已有写入，结果必须是 `needs_review`，不能用 `cancelled` 隐藏变化。

Annotation 沿用 P0 的 `open`、`applying`、`needs_review`、`resolved`、`failed` 状态。AgentRun 的任何成功执行都不能自动改变为 `resolved`。

## 3. CLI 能力探测

### 3.1 探测时机与缓存

Daemon 在第一次启动 AgentRun 前探测，在每个新进程启动前确认缓存仍然有效；以下任一项改变都必须重新探测：

- 直接解析到的可执行文件身份或文件内容摘要；
- `--version` 输出；
- `--help` 输出的规范化摘要；
- Daemon 的权限、工具或 provider/model 策略；
- Windows 用户、CLI 配置来源或受信运行环境。

能力缓存只能保存解析后的字段、摘要和探测时间，不保存 API key、OAuth token、完整鉴权输出、完整 Prompt 或用户源文件。探测失败的原因需要脱敏后保存为诊断信息，并且不能把上一次的成功结果当作本次可用能力。

### 3.2 四步探测

1. **可执行文件探测**：Daemon 直接解析命令并以参数数组启动，不通过 shell 拼接命令。读取版本和帮助文本，建立逻辑参数映射；同一语义的参数别名必须由探测结果决定。
2. **鉴权探测**：调用 CLI 提供的只读鉴权状态命令，结果只保留 `authenticated`、`unauthenticated` 或 `unknown` 和脱敏原因。鉴权失败在 AgentRun 启动前结束，不启动写入进程。
3. **协议探针**：在隔离的临时工作目录中发起无工具、无写入的最小请求，使用已确认的 stream-json 输入/输出选项。探针必须观察到可解析的初始化、assistant/result 或明确失败事件；它只能验证协议，不能修改 Project。
4. **实际运行元数据**：正式运行时以初始化事件和结果事件返回的 provider、model、session ID 为准。CLI 名称 `claude` 不能被解释为 provider 或 model 的证明；如果配置了 provider/model allowlist，实际值不匹配就拒绝运行。

P0 不把 provider 固定为 Anthropic，也不把 model 固定为某个 Claude 名称。默认运行策略是“使用当前受信 CLI 配置”，但实际 provider/model 必须非空、记录在 AgentRun 并出现在脱敏运行摘要中；部署可以进一步配置 provider/model allowlist，配置后严格执行。只有 `unrecognized_model` 警告而实际值仍可解析时，不自动把运行判为失败；实际值缺失或无法与必需策略比较时，返回 `AGENT_PROVIDER_MODEL_UNAUTHORIZED`。

### 3.3 P0 必需能力

下表中的名称是逻辑能力，不是要求所有 CLI 版本使用相同的参数拼写。

| 逻辑能力 | 用途 | 不支持时 |
| --- | --- | --- |
| `print` | 非交互执行并以 stdin/stdout 交接 | `AGENT_CAPABILITY_UNSUPPORTED` |
| `streamJsonInput` / `streamJsonOutput` | 传输 Turn 和增量事件 | `AGENT_CAPABILITY_UNSUPPORTED` |
| `verboseForStreamJson` | 获得可关联的 stream-json 事件 | `AGENT_CAPABILITY_UNSUPPORTED` |
| `newSessionId` / `resumeSession` | 建立并续接同一 AgentRun 的 Session | 不能启动 P0 AgentRun |
| `restrictedWorkspace` / `addDir` | 把 CLI 工具限制到 Content Root | 不能启动 P0 AgentRun |
| `appendSystemPrompt` | 注入 Daemon 生成的 Hard scope | 不能启动 P0 AgentRun |
| `explicitPermissionMode` / `noPermissionPrompts` | 使用固定的写入授权策略，不等待不可见交互 | 不能启动 P0 AgentRun |
| `explicitToolAllowlist` | 只启用读取和编辑现有文件所需工具 | 不能启动 P0 AgentRun |
| `safeConfiguration` | 禁用项目自定义 hooks、plugins、skills 和非显式 MCP 配置 | 不能启动 P0 AgentRun |

P0 的正式运行使用能力映射后的等价选项：stream-json 输入和输出、`verbose`、restricted workspace、Content Root allowlist、safe configuration、无交互 permission prompt、显式的读取/编辑工具集合以及可恢复 Session。`--no-session-persistence` 只允许用于协议探针，不能用于正式 AgentRun。

P0 禁止传递危险的 bypass permission 选项；即使 CLI 暴露该能力，也不能把它作为 fallback。正式运行不启用 Bash、PowerShell、WebFetch、MCP、插件下载、面向 Project 的网络访问或包安装能力；CLI 与已配置 provider 之间的模型 API 网络传输是运行所必需的，不属于 Agent 工具权限。CLI 未提供足够细粒度的工具控制时，运行必须失败而不是扩大工具集合。

### 3.4 当前环境事实

2026-09-21 的 Windows 10 前置条件核验记录了 Claude Code `2.1.278`、stream-json 探针通过、`--verbose` 必需、实际 provider/model 为 `DeepSeek-V4.1-Flash`，并出现过一次 `unrecognized_model` 警告。该事实只作为当前环境证据；实现仍必须在启动时记录实际 provider、model、能力快照和警告，不能把 `2.1.278` 或 Anthropic model 当成静态默认值。

## 4. 启动、续接与停止

### 4.1 新 AgentRun

Daemon 按以下顺序执行新运行：

1. 验证 Annotation 已保存，`projectId + fileIndexVersion` 与当前受信 File Index 完全匹配，ArtifactVersion 基线仍存在，且锚点没有进入必须人工确认的 `stale`/`lost` 路径。
2. 从 File Index 和 Annotation 计算不可变 Hard scope，列出 `readablePaths`、`writablePaths`、`slideIds`、`stableElementIds` 和允许的操作；没有可证明的写入集合就拒绝启动。
3. 完成能力和鉴权探测，记录 `capabilitySnapshotId`、permission profile 和实际策略摘要。
4. 为本 AgentRun 生成新的 `sessionId`，建立基线文件 hash 和 side-effect ledger。双击或重放同一个客户端幂等键只返回已创建的 AgentRun。
5. 在 Daemon 持有的 canonical Content Root 上以参数数组启动 CLI。`cwd` 和 `addDir` 只能来自受信 Project 状态；它们不进入浏览器事件、错误消息或 Agent-facing 业务合同。
6. 设置固定的 P0 权限策略：restricted workspace、safe configuration、无 permission prompt、显式的读取/编辑工具 allowlist，并附加 Daemon 生成的 Hard scope system prompt。不要把用户文本直接当作 system prompt。
7. 在子进程启动、首个初始化事件、provider/model 校验和 Session ID 记录成功之前，不发送实际用户 Turn。
8. 通过 stdin 发送一个 JSONL user frame，内容按第 5 节组装。Windows 命令行长度不承载用户 Prompt；不能通过字符串拼接 shell 命令。

正式运行至少要表达以下逻辑参数；实际参数名必须来自能力映射：

```text
print
input-format = stream-json
output-format = stream-json
verbose
restricted workspace
safe configuration
permission mode = accept edits for this explicitly submitted run
permission prompts = none
tools = read existing files, edit existing files
add-dir = canonical Content Root
session-id = new opaque UUID
append-system-prompt = generated Hard scope
```

这段列表不是允许客户端自由组装的命令模板。Daemon 必须拒绝未探测的参数、未被当前受信配置确认的 model/provider、额外的工具和额外的目录。

### 4.2 续接 AgentRun

续接只用于同一 AgentRun 的未完成执行，不用于把新 Annotation 追加到旧对话。Daemon 只有在以下条件全部满足时才能使用显式 `resumeSession(sessionId)`：

- 原 Session 属于同一 `projectId`、同一 AgentRun 和同一 Content Root 身份；
- 原进程已退出或 Daemon 已确认连接断开，且不存在仍在运行的同一子进程；
- reconciliation 证明没有文件写入、创建、删除、重命名或无法归因的外部变化；
- 当前 File Index、基线 ArtifactVersion、Hard scope、permission profile、CLI capability fingerprint 和 provider/model policy 与原记录一致；
- 原 Session 仍可恢复，且 `resumeSession` 能力已经在本次启动前重新确认。

续接会在同一 Project Session 中创建一个新的 recovery Turn，发送“检查当前状态并继续原任务”的恢复指令；不能重复盲发原始 user frame。续接失败后再次尝试前必须重新 reconciliation。Session ID 不存在、上下文不一致或已有副作用时，状态进入 `needs_review` 或 `failed`，由用户查看、回退或创建新的 AgentRun。

P0 不把一个已完成、已确认、已回退或已有 ArtifactVersion 的 AgentRun 作为新 Annotation 的 Session 上下文。新 Annotation 必须新建 AgentRun 和新 Session，避免旧 Hard scope、旧用户意图或旧工具上下文污染新任务。

### 4.3 停止与取消

- 取消必须是显式用户动作或 Daemon 的故障恢复动作；浏览器断线本身不等于取消。
- 第一次取消把 AgentRun 标为 `stopping`，记录取消请求，再关闭 stdin、请求子进程和其子进程组优雅退出，并在有界时间后终止 Windows Job Object/进程树。具体等待时长由运行时配置，但必须记录。
- 取消请求幂等。运行已停止时再次取消返回第一次的最终结果；不能产生第二个终止事件或第二次回退。
- 无论正常退出、异常退出、强制终止、Daemon 重启还是 UI 断线，都必须执行 reconciliation。没有 ledger 证据不等于没有副作用。
- 取消后没有副作用时，AgentRun 为 `cancelled`、Annotation 为 `failed`，用户动作是“重新检查并重试”。取消后已有或未知副作用时，AgentRun 为 `needs_review`，用户动作是“查看 ArtifactVersion、回退或人工处理”；不能自动重试。

## 5. Hard scope 与写入授权

### 5.1 两层边界

| 层 | 由谁持有 | P0 规则 |
| --- | --- | --- |
| 物理边界 | Daemon / Project trusted state | CLI 的 `cwd` 和 allowlist 只能指向 canonical Content Root；任何 canonical path 越界、消失、reparse point 或受保护路径都失败。 |
| 逻辑边界 | Daemon 生成的 AgentRun Hard scope | 只允许本次 Annotation 明确列出的既有 Project-relative Path、Slide、Stable Element ID 和直接布局关系；Prompt、CLI 自己的判断和用户文本都不能扩大它。 |

`Content Root` 的授权不等于所有文件都可写。用户打开 Project 是读取和预览授权；用户明确发送一条已保存 Annotation 才是该 AgentRun 的写入意图。每个 AgentRun 仍然要得到独立、可审计的 `writablePaths`。

### 5.2 Hard scope 结构

```text
HardScope = {
  scopeVersion: 1,
  projectId,
  fileIndexVersion,
  baseArtifactVersionId,
  annotationId,
  readablePaths: Project-relative Path[],
  writablePaths: Project-relative Path[],
  slideIds: Slide ID[],
  stableElementIds: Stable Element ID[],
  allowedOperations: [edit-existing-file],
  allowedLayoutRelation: none | direct-parent-only,
  forbidden: [
    other-slides,
    global-theme,
    create-file,
    delete-file,
    rename-file,
    protected-path,
    project-escape,
    network-or-remote-resource,
    credential-or-secret
  ],
  acceptanceCriteria
}
```

规则如下：

- `writablePaths` 必须来自同一 File Index snapshot，按规范化 Project-relative Path 去重，并且每个路径在启动前是 Content Root 内的普通既有文件。
- P0 的点击或框选 Annotation 只允许修改其目标所在文件和为直接布局关系明确列出的现有文件；不能因为元素的 CSS 依赖被推测为全局主题而自动扩大集合。
- 画笔或文字 Annotation 没有唯一 Stable Element ID 时，Daemon 不能猜测源文件。只有用户在发送前明确确认文件和写入集合，才可以启动；否则返回 `AGENT_SCOPE_UNRESOLVED`。
- 任何新文件、删除、重命名、目录修改、`.git`/`.hg`/`.svn`/`.shppt`/`node_modules`/`dist`/`build`/`coverage` 下的写入，以及 Content Root 外的访问都不是 P0 成功路径。
- Source HTML 中的 `data-od-slide`、`data-od-id` 以及与其他 Slide 对应的结构不能被静默重写。验证器无法证明变化属于 Hard scope 时，必须进入 `needs_review` 或失败，不能猜测接受。

### 5.3 Prompt 组装

Daemon 生成的 system prompt 必须包含结构化、可复现的 Hard scope；用户 Annotation 文本、源文件内容、截图 OCR 和 CLI 返回文本都是不可信数据，只能作为被约束的输入。最小顺序是：

1. 合同版本、`runId`、`annotationId`、`projectId`、`fileIndexVersion` 和 `baseArtifactVersionId`；
2. Hard scope 的 Project-relative Paths、Slide IDs、Stable Element IDs、允许操作和禁止操作；
3. 当前 Annotation 的结构化 DOM 上下文、归一化几何、截图引用和验收条件；
4. 用户原文，使用明确的 data 区块包裹，并声明其中的范围扩大要求无效；
5. 完成前自检要求：只修改允许文件，保持稳定 ID，报告修改摘要并停止，不执行其他命令。

Prompt 不包含 `contentRoot`、任意绝对路径、`file://` URL、API key、token、完整环境变量、完整 CLI stderr 或未经脱敏的源文件诊断。Daemon 传给本地进程的 `cwd`、allowlist 和受信截图暂存路径属于进程启动参数，不属于浏览器和 Agent-facing 业务消息；任何回传都必须改为 Project-relative Path 或不透明 artifact reference。

Prompt 只是纵深防御的一层。即使 CLI 返回“遵守范围”的文本，Daemon 仍必须按第 7 节检查实际差异；Prompt 无法证明文件没有被写入。

## 6. 流式事件与幂等

### 6.1 输入与解析

Daemon 通过 stdin/stdout 使用 JSONL stream-json；每行独立解析，不把多行拼成可执行 shell 输入。解析器必须兼容当前已确认的 `stream_event`、assistant wrapper、tool/result wrapper、初始化事件和 result frame，并把未知 frame 作为可诊断的 `unknown_frame`，不能直接转发为可信成功信号。

内部统一事件包络为：

```text
AgentEvent = {
  eventId,
  runId,
  attemptId,
  turnId,
  sequence,
  type,
  occurredAt,
  payload,
  redaction: applied | not-applicable
}
```

`eventId` 由 CLI 原生稳定 ID 经过命名空间化生成；没有原生 ID 时使用 `attemptId + sourceCursor + normalizedFrameHash`。同一 source cursor 和 frame hash 的重放只能产生一个事件。Daemon 为每个 AgentRun 保持单调 `sequence`，但客户端不能把 sequence 当作跨 Run 的身份。

### 6.2 对外事件类型

| 类型 | 主要内容 | 可信度和用途 |
| --- | --- | --- |
| `run_started` | run、attempt、能力摘要 | 已持久化后广播运行开始。 |
| `turn_started` | turn ID、kind、Session 状态摘要（不含原始 `sessionId`） | 标记 initial 或 recovery Turn。 |
| `text_delta` | 有大小上限的增量文本 | 展示进度；不能当作写入证明。 |
| `tool_call` / `tool_result` | 工具名、脱敏摘要、工具 ID | 工具 ID 幂等；不把工具自报路径当作最终路径证据。 |
| `file_effect_observed` | Project-relative Path、操作、before/after hash、来源 | 文件写入以 watcher/reconciliation 为准；绝不发送绝对路径。 |
| `usage` | token/费用等已脱敏用量 | 诊断和预算展示；不是成功条件。 |
| `turn_ended` | 一次且只有一次，含 complete/incomplete/error | 终止 Turn，不必然终止 AgentRun。 |
| `run_reconciling` | 进程结果和检查阶段 | 告知正在检查副作用。 |
| `run_needs_review` / `run_failed` / `run_cancelled` | 脱敏错误和用户动作 | 只在 ledger 和状态已持久化后广播。 |

事件采用持久化后的至少一次交付。客户端断线后按 `runId + sequence` 重放，并按 `eventId` 去重；重复 assistant wrapper、重复 tool use、重复 file watcher 通知和多个 result/exit 终点都不能重复推进状态或生成两份 ArtifactVersion。

### 6.3 终点规则与负载限制

- `turn_ended` 由有效 result frame、明确协议错误或进程关闭后的 reconciliation 触发，但每个 `turnId` 只发一次。result 和 process exit 同时到达时，按 ledger 事务合并。
- 缺少 result frame、JSONL 截断、stdout/stderr 混流、未知 Session ID 或 parser error 都是 incomplete/error 证据，不能被转换为正常成功。
- 单条 text、tool result、stderr 和截图/源内容 payload 必须有预算；超限时持久化摘要、大小和 hash，原文留在受保护的诊断存储或直接丢弃。不能因为事件太大而丢掉 file effect、错误码和 reconciliation 结果。
- 原始 CLI stderr 只进入受信诊断存储并脱敏；浏览器看到的是 `code + phase + sideEffectState + userAction`。

## 7. Side-effect ledger 与结果核对

### 7.1 Ledger 记录

side-effect ledger 是 Daemon 受信状态中的追加记录，不写入用户 Content Root，也不由 Claude CLI 控制。每条记录至少包含：

```text
SideEffectEntry = {
  effectId,
  runId,
  attemptId,
  turnId,
  sequence,
  kind: session | process | tool | file | artifact | preview | terminal,
  operation,
  path: Project-relative Path | null,
  beforeHash: sha256 | null,
  afterHash: sha256 | null,
  source: cli-event | watcher | canonical-reconcile | daemon,
  observedAt,
  metadataRedacted
}
```

`effectId` 必须幂等；重复写入相同 ledger key 是 no-op。文件事件保留 before/after hash、大小和操作类型，不把 token 或未经必要处理的源文件内容写入日志。ArtifactVersion 负责后续合同要求的可查看 before/after 内容和回退证据。

记录优先级如下：

1. Daemon 在创建子进程前写入基线和 `run_started`；
2. CLI 事件、进程状态和文件监听只追加观察证据；
3. 子进程退出、取消或 Daemon 重启后，Daemon 对同一 canonical Content Root 做完整的受边界重扫；
4. reconciliation 的 hash 比较是文件效果的权威来源，不能因为 CLI 没有发 `file_written` 事件就认定没有写入；
5. 所有状态推进、ArtifactVersion 关联和对外 terminal 事件必须在对应 ledger 记录持久化后发生。

### 7.2 Reconciliation

reconciliation 至少检查：

- 基线 `projectId`、`fileIndexVersion` 和每个相关路径的 contentHash 是否仍可读取；
- 所有新增、删除、重命名和内容变化是否都位于 `writablePaths`，并且属于允许的 `edit-existing-file` 操作；
- 每个受影响 canonical path 是否仍在 Content Root 内、没有 reparse point，且其磁盘大小和 contentHash 可记录；
- AgentRun 期间是否有无法归因的外部变化、File Index 版本冲突或目标锚点变化；
- 变化是否能通过 Slide/Stable Element/直接布局关系验证为 Hard scope 内；验证失败即拒绝成功；
- 文件是否稳定，是否产生新的完整 File Index snapshot 和 ArtifactVersion；
- 当前 Slide 预览是否已刷新且为 `preview ready`。预览为 stale/error 时不能把 AgentRun 当作可确认成功。

结果分类：

| 进程/流结果 | 文件和预览证据 | AgentRun 结果 | 用户下一步 |
| --- | --- | --- | --- |
| 正常结束 | 允许路径有稳定变化，scope 通过，ArtifactVersion 建立，预览 ready | `needs_review` | 查看并确认或回退。 |
| 正常结束 | 无变化 | `failed`，`AGENT_NO_EFFECT` | 修改要求后重试；仅在基线未变时安全。 |
| 异常/截断 | 无变化且基线未变 | `failed` | 可重试或检查 CLI。 |
| 异常/截断 | 有允许范围变化 | `needs_review` | 查看部分结果；禁止盲目重试。 |
| 任意结果 | 越界、未授权、外部冲突或无法归因变化 | `needs_review` 或 `failed`，带对应错误码 | 停止自动化，查看、回退或人工处理。 |
| 任意结果 | 变化可接受但预览 stale/error | `needs_review` | 修复/刷新预览后再确认，不能自动解决。 |

回退不是 AgentRun 的隐式清理步骤。除非用户明确选择且没有新的外部冲突，Daemon 才能使用 ArtifactVersion 的精确 before 内容回退；回退后 Annotation 仍需用户重新确认，不能静默变成 `resolved`。

## 8. 重试、恢复与 Daemon 重启

### 8.1 重试

重试是同一个逻辑 AgentRun 的新 attempt，不是重复创建 Annotation，也不是对已有写入再执行一次。只有以下条件全部满足时，Daemon 才能自动提供 Retry：

- 原 attempt 已进入 `failed` 或无副作用的 `cancelled`；
- ledger 和 canonical reconcile 都证明 `sideEffectState = none`；
- `projectId`、File Index、ArtifactVersion 基线和 `writablePaths` 没有变化；
- 错误码标为 `retryable: true`；
- 新 attempt 重新完成能力、鉴权、scope 和权限校验。

安全重试默认创建新的 Project Session，避免把失败 Turn 的部分上下文当作事实。若用户明确选择继续上下文，则只能按 4.2 的 resume 条件恢复同一 Session。

### 8.2 恢复

Daemon 启动时扫描未终止的 AgentRun：

1. 通过受信 run registry 判断原子进程是否仍存活；仍存活则重新绑定 owner，不创建第二个 CLI 进程。
2. 进程已退出或无法取得 owner 时，先写入 `recovery_started`，执行完整 reconciliation；没有证据时状态为 `unknown`，不是 `none`。
3. 无副作用时，允许用户选择 resume 或安全 retry；有副作用时进入 `needs_review`，提供 ArtifactVersion/回退/人工处理动作。
4. Daemon 重启、浏览器重连和事件重放不得改变已落盘的 terminal outcome，也不得再次生成 ArtifactVersion。

恢复不会跨越新的 File Index snapshot、外部冲突、CLI 能力变更、provider/model policy 变更或 permission profile 变更。任何变化都要求用户刷新 Project、检查结果或创建新的 AgentRun。

## 9. 错误与用户动作

错误对象至少包含以下字段，`redactedContext` 不得包含绝对路径、凭证、完整 Prompt 或用户源文件：

```text
AgentError = {
  code,
  runId,
  attemptId,
  turnId: string | null,
  phase: probe | authorize | start | stream | stop | reconcile | preview,
  retryable: true | false | conditional,
  sideEffectState: none | observed | unknown | conflict | out-of-scope,
  userAction,
  redactedContext,
  originalCause: trusted-diagnostic-reference
}
```

| 错误码 | 发生阶段 | 含义 | 用户动作 |
| --- | --- | --- | --- |
| `AGENT_CLI_NOT_FOUND` | probe | 没有可执行 CLI | 安装/配置受支持 CLI 后重新探测。 |
| `AGENT_CLI_VERSION_UNSUPPORTED` | probe | 版本或帮助合同不满足 P0 | 升级或选择受支持版本；不要反复重试同一版本。 |
| `AGENT_CAPABILITY_UNSUPPORTED` | probe/start | 缺少 stream-json、restricted、Hard scope prompt、Session、权限或工具能力 | 调整 CLI/运行策略；不能用更宽权限 fallback。 |
| `AGENT_AUTH_REQUIRED` | authorize | CLI 未鉴权或鉴权状态未知 | 在本机完成鉴权，再重新发送 Annotation；不把密钥交给 Browser。 |
| `AGENT_PROVIDER_MODEL_UNAUTHORIZED` | start/stream | 实际 provider/model 不在配置策略内或无法确认 | 检查运行配置并明确允许值；不能按 CLI 名称猜测。 |
| `AGENT_PROJECT_VERSION_STALE` | authorize | Annotation 的 Project 或 File Index snapshot 已过期/不存在 | 刷新 File Index，重新定位 Annotation；不能静默使用最新版本。 |
| `AGENT_SCOPE_UNRESOLVED` | authorize | 目标没有可证明的 Stable Element 或用户未确认写入文件集合 | 人工确认目标和文件，或放弃本次 AgentRun。 |
| `AGENT_SESSION_INVALID` | start/stream | Session 不存在、属于其他 Project/Run 或上下文不一致 | 查看已有结果后创建新的 AgentRun；不能换 Session 盲重放。 |
| `AGENT_RESUME_UNAVAILABLE` | start | CLI 不支持或本次未能确认 resume | 若无副作用可安全 retry；有副作用则查看/回退。 |
| `AGENT_PROTOCOL_ERROR` | stream | JSONL 无法解析、流截断或终点不一致 | 无副作用时重试；否则进入 needs_review 并查看证据。 |
| `AGENT_PROCESS_FAILED` | start/stream | CLI 非零退出或子进程异常 | 按 sideEffectState 选择重试、查看或回退，不能只看退出码。 |
| `AGENT_CANCELLED` | stop | 用户显式取消且没有副作用 | 检查要求后重新发送或关闭 Annotation。 |
| `AGENT_NO_EFFECT` | reconcile | 运行结束但允许文件没有稳定变化 | 修改指令或目标后重试；不能生成空 ArtifactVersion。 |
| `AGENT_SCOPE_VIOLATION` | reconcile | 修改了未授权路径、Slide、Stable Element 或禁止操作 | 停止运行，查看 before/after，按用户选择回退或人工修复。 |
| `AGENT_EXTERNAL_CONFLICT` | reconcile | 运行期间检测到无法覆盖的外部变化 | 刷新 Project 并人工合并/放弃；不能静默覆盖。 |
| `AGENT_PATH_BOUNDARY` | start/reconcile | canonical path 越界、消失、reparse point 或受保护路径 | 修复 Project/路径授权后重新扫描；不能改变 Content Root 猜测继续。 |
| `AGENT_RECONCILIATION_FAILED` | reconcile | 无法证明文件、ledger 或 ArtifactVersion 状态 | 保留 `unknown` 证据，人工查看；不能宣称成功或自动重试。 |
| `AGENT_PREVIEW_STALE` | preview | 修改后预览没有进入 `preview ready` | 刷新或修复预览，再由用户确认；不能标记 resolved。 |
| `AGENT_TIMEOUT` | start/stream/stop | 在配置的有界时间内未完成 | 先停止并 reconciliation；无副作用可 retry，有副作用需 review。 |

错误消息给用户的是“发生阶段、是否已有修改、是否可重试、下一步动作”，不是一段未经处理的 CLI stderr。相同错误和相同 `runId + attemptId + phase` 的重复报告必须幂等。

## 10. 可重复验收

实现本合同后，至少需要在 Windows 10 固定示例 Project 上证明：

1. CLI 不存在、未鉴权、stream-json/Session/权限能力缺失时，AgentRun 在启动前失败，Annotation 保留且没有成功 ArtifactVersion。
2. 当前 Claude CLI 能力探针记录实际版本、provider、model、stream-json 和 permission 能力；实际 provider/model 不被写死为 Claude 或某个模型。
3. 新 AgentRun 只绑定一条 Annotation、一个 File Index 版本、一个 Session 和一个初始 Turn；重复启动请求不会产生第二个 Run 或第二个子进程。
4. Browser/Agent-facing 事件只出现 `projectId`、File Index 版本、Project-relative Path 和脱敏摘要；Content Root、绝对路径、token 和完整 Prompt 不外泄。
5. 合法修改只触及 `writablePaths` 并产生稳定差异时，ledger、ArtifactVersion 和预览状态都可检查，Annotation 停在 `needs_review` 直到用户确认。
6. CLI 退出异常、stream 截断、取消和 Daemon 重启都先 reconciliation；无副作用可以安全 Retry，有副作用或未知状态不自动重试。
7. Agent 修改其他 Slide、全局主题、受保护目录或 Content Root 外文件时，结果被标为 scope violation/needs review，不能成功或自动解决。
8. 同一个 stream frame、tool ID、file effect、result frame、cancel 请求和 terminal 事件重放后，UI 仍只有一份对应事件和一份 ArtifactVersion。
9. 同一未完成 AgentRun 在基线未变且无副作用时可以显式 resume；Session、权限、能力、provider/model 或 File Index 不一致时 resume 被拒绝。
10. 预览刷新失败、外部冲突、锚点 stale/lost 或无法证明 reconciliation 时，用户得到可操作动作，不能看到伪造的成功状态。

## 11. 与后续合同的边界

- [HTML-first 项目与 Deck 合同](./html-first-project-deck-contract.md) 定义 Content Root、File Index、Project-relative Path、Slide ID 和 Stable Element ID；本合同不得放宽这些物理边界。
- Annotation 和 iframe Bridge 合同（#5）提供本合同使用的 screenshot、DOM context、几何和锚点状态；本合同不重新发现这些数据。
- ArtifactVersion 持久化与回退合同（#7）保存可查看的 before/after 内容、恢复关系和用户确认；本合同提供 run、scope 和 ledger 关联。
- 文件监听、事件与预览刷新合同（#8）定义 watcher 的具体实现和 preview 状态；本合同规定 reconciliation 必须使用其结果并 fail closed。
- 测试、视觉质量与验收证据合同（#10）把本节场景落实为夹具、命令和证据包；诊断输出仍必须遵守本合同的脱敏规则。
