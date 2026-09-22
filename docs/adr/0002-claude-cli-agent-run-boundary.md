---
status: accepted
---

# Claude CLI 通过受控 AgentRun 修改 Project

## Context

P0 要把用户保存的 Annotation 交给本机 Claude CLI，观察文件变化，并让用户在预览中确认或回退。Claude CLI 的版本、实际 provider/model、参数和 stream-json 细节可能变化；进程退出码也不能证明没有写入文件。与此同时，Project 的 Content Root 和 AgentRun 的 Hard Scope 是不同层次的边界：前者限制物理文件范围，后者限制一次修改任务的目标。

如果把 CLI 进程当作 Session、按版本号拼接参数、只看退出码，以下情况会变得不可判定：会话续接到了错误的 Project、CLI 已经写入后进程异常、重复 terminal frame、取消后残留进程，以及用户无法知道错误应该执行什么动作。

## Decision

采用 [P0 Claude CLI 与 AgentRun 合同](../specs/claude-cli-agent-run-contract.md)，关键决定如下：

1. Daemon 是 Project、Content Root、权限、AgentRun、事件和副作用记录的唯一权威层。浏览器不启动 CLI，也不持有绝对路径或文件写权限。
2. 启动前按实际 CLI 能力探测决定参数；不按版本号猜测能力。正常 AgentRun 使用 `stream-json`、必要的 `--verbose`、受控的 Content Root 和非 bypass 权限模式。
3. `Project Session`、`AgentRun` 和 `Turn` 分离。P0 一次 AgentRun 只处理一条 Annotation 且只包含一个 Turn；续接是 AgentRun 边界上的 `--resume`，不是把一个进程当作长期 Session。运行中 steering、批量 Annotation 和排队属于 P1。
4. Prompt 中的 Hard Scope 是模型约束，不是授权本身。Daemon 生成显式的 Project-relative 写入集合，并在启动前、运行中和稳定后核验文件变化；越界变化不能被接受为成功。
5. 成功由流终点、进程状态、side-effect ledger、File Index 变化和预览状态共同决定。退出码为零不能跳过副作用核对；有副作用的失败不能盲目重试。
6. 取消是幂等的；取消、Daemon 重启或 UI 断线都要经过 terminal reconciliation。重试总是新建 AgentRun/Turn，并根据副作用和版本状态决定是否允许。
7. 错误必须携带阶段、是否可重试和用户动作。诊断信息脱敏，不记录凭证、完整 Prompt、源文件或图片内容。

## Consequences

- 每次运行都有可审计的 `runId`、`turnId`、`sessionId`、输入版本、Hard Scope、事件和副作用证据。
- 用户会在 `needs_review` 阶段明确确认或回退；运行结束不会自动把 Annotation 标记为 `resolved`。
- 某些 CLI 版本会被拒绝，而不是降级到无法证明安全边界的调用方式。
- P0 需要 File Index 快照、文件稳定观察、ArtifactVersion 记录和预览状态协作；这些模块的持久化细节由后续合同实现，但不得改变这里的判定顺序。
- 续接失败时不会静默创建新 Session。用户必须选择重新开始，避免把上下文丢失伪装成成功续接。

## Rejected alternatives

- **按 CLI 版本号硬编码参数**：版本号不能证明某个安装的实际能力，且当前环境已经证明 CLI 名称不等于实际 provider/model。
- **把 Session 等同于长驻进程**：进程会退出、崩溃或被取消；对话身份和一次执行的审计生命周期不同。
- **只以退出码判断成功**：CLI 可能在异常退出前已经改写文件。
- **默认 `bypassPermissions` 或让浏览器直接写文件**：这会绕过 Content Root、Hard Scope 和用户可回退的审计边界。
