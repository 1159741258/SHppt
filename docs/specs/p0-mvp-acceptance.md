# P0 MVP：视觉标记驱动的 Agent PPT 编辑器

状态：实现基线

本文件落实 [P0 闭环边界与验收合同](https://github.com/1159741258/SHppt/issues/2)。它只定义首个可交付闭环的产品行为；运行时、数据存储和消息协议的具体设计由后续决策票据展开。

## 决策

P0 是一个 Windows 10 本地、单用户、HTML-first 的 Agent PPT 编辑器。它交付下面这条闭环：

```text
打开受支持的 HTML Deck
  -> 预览和页面导航
  -> 点击、框选、画笔或文字标记
  -> 保存带截图和 DOM 上下文的 Annotation
  -> Claude CLI 在硬修改范围内执行一次 AgentRun
  -> 文件变化后刷新预览
  -> 用户检查 ArtifactVersion
  -> 确认修改或回退到修改前版本
```

P0 的交付结果是一个可检查、可失败、可回退的修改闭环，不是浏览器内的 PowerPoint 对象编辑器。

## 领域术语

- **Project**：一个被授权的本地项目目录及其元数据。
- **Deck**：Project 中可预览的一套 HTML 幻灯片。
- **Slide**：Deck 中的一页可导航、可截图的画布。
- **Annotation**：用户对 Slide 的一次标记，包含用户意图、视觉证据和结构定位信息。
- **AgentRun**：一次由 Annotation 触发的 Claude CLI 修改任务。P0 一次只处理一条 Annotation。
- **ArtifactVersion**：一次源文件变化的可检查版本，至少能指向修改前和修改后的内容。
- **锚点状态**：Annotation 目标的 `anchored`、`reanchored`、`stale` 或 `lost` 状态；它不是用户评论状态。

## P0 支持边界

### 输入

- 用户打开一个本地 Project；Project 包含 HTML 入口、CSS/JavaScript 和所需图片或字体资源。
- P0 面向带稳定元素标识的 HTML Deck。需要被精确修改的元素必须能提供 `data-od-id` 或等价的稳定标识。
- Deck 在 iframe 中预览，并能识别 Slide 边界和当前 Slide。
- 入口发现、目录授权、资源解析和 Slide 标记的精确合同由 [HTML-first 项目与 Deck 合同](https://github.com/1159741258/SHppt/issues/3) 决定。
- `.pptx` 不是 P0 的源文件格式；P0 不要求导入 PowerPoint 对象模型。

### 用户交互

- 用户可以浏览 Slide、切换当前页并进入 Annotation 模式。
- 用户可以创建四类 Annotation：点击目标、框选多个目标、画笔区域和文字说明。
- 点击或框选应尽量绑定稳定 DOM 目标；画笔和文字说明至少绑定当前 Slide、区域几何和截图。
- Annotation 在发送给 Agent 前必须先保存，包含用户文字、截图、当前版本和可用的 DOM 上下文。
- P0 一次 AgentRun 处理一条 Annotation；多条 Annotation 批量发送、排队和运行中追加属于后续范围。

### Agent 修改

- AgentRun 必须携带 Project、当前 ArtifactVersion、Slide、目标文件、目标元素、几何信息、截图、用户要求和验收条件。
- 每次运行都有显式的 `Hard scope`。P0 只允许修改当前 Annotation 指定的元素或区域及其必要的直接布局关系，不允许默认修改其他 Slide 或全局主题。
- Project 根目录、允许写入的文件和 Agent 权限必须经过 Daemon 控制；浏览器不得直接启动 Claude CLI 或直接拥有文件写权限。
- Agent 不可用、未鉴权、能力不匹配或拒绝写入时，Annotation 必须保留，不能被标记为已解决。
- 目标无法稳定定位时，系统必须进入人工确认或失败状态，不能静默猜测另一个元素。

### 预览、确认和回退

- Agent 写入完成后，系统等待文件稳定并刷新预览；刷新失败不能伪装成成功。
- 用户看到修改后的预览和本次变化的 ArtifactVersion 后，才能确认 Annotation 已解决。
- 每次被接受的修改都必须保留修改前内容、修改后内容、变更文件和触发 Annotation 的关联。
- 用户可以回到本次 AgentRun 之前的确切内容；回退后预览必须重新同步，且 Annotation 不能被静默标记为已解决。
- 修改失败时，Annotation、AgentRun 的失败原因和已有副作用证据必须保留，支持人工处理或安全重试。

## 最小状态语义

### Annotation 状态

| 状态 | 含义 | 用户可见结果 |
| --- | --- | --- |
| `open` | 标记已保存，尚未执行 | 可以编辑、删除或发送 |
| `applying` | AgentRun 正在执行 | 显示运行状态，不允许重复提交 |
| `needs_review` | 运行结束，等待查看预览和变化 | 可以确认、回退或标记失败 |
| `resolved` | 用户确认本次修改 | 作为已完成反馈保留 |
| `failed` | 运行或验证失败 | 保留评论、错误和证据，可重试或修复 |

回退是 ArtifactVersion/AgentRun 的结果，不得通过删除 Annotation 来表达。锚点的 `stale`/`lost` 只表示定位风险，不能被当作 `resolved`。

## 成功标准

一次 P0 AgentRun 只有同时满足以下条件才算正常成功：

1. Annotation 在运行前已保存，且包含截图、当前版本和可用的目标上下文。
2. Claude CLI 在受控 Project 范围内完成运行，未越过 Hard scope。
3. 允许的源文件发生变化，变化被稳定地观察到并生成新的 ArtifactVersion。
4. 当前 Slide 预览已刷新到修改后的内容并处于 `preview ready`；`preview stale/error` 只能进入待审查或失败路径，不能被算作成功。
5. 用户能查看变化，并选择确认或回退；系统没有自动把未检查的修改标记为 `resolved`。

## 失败和安全规则

| 场景 | P0 行为 |
| --- | --- |
| Project 无法打开或入口无效 | 阻止进入可编辑状态，给出可操作错误 |
| Claude CLI 不存在、未鉴权或参数不支持 | AgentRun 失败，Annotation 不丢失，不产生成功版本 |
| Agent 进程失败且没有写入 | 保留失败原因，可安全重试 |
| Agent 已写入但进程异常 | 先检查副作用和文件变化，禁止盲目重复运行，交给用户查看或回退 |
| 写入超出允许文件/目标范围 | 运行不得被接受为成功，保留 before/after 证据并提供回退 |
| 文件在运行期间被外部修改 | 标记冲突，不覆盖外部变化，不自动确认 Agent 结果 |
| 原目标变成 `stale` 或 `lost` | 要求用户确认、重新定位或放弃，不能静默改写其他元素 |
| 预览刷新失败 | 版本和错误仍可诊断，但 Annotation 保持 `needs_review` 或 `failed` |

## 验收场景

以下场景构成 P0 的最小验收集；测试夹具、测试工具和证据格式由 [P0 测试、视觉质量与验收证据](https://github.com/1159741258/SHppt/issues/10) 决定。

- **P0-01 打开 Deck**：用户打开受支持的本地 Project，看到 Slide 预览并能导航。
- **P0-02 点击标记**：用户点击带稳定标识的元素，看到目标高亮，输入修改要求并保存 Annotation。
- **P0-03 框选标记**：用户框选多个元素，保存选中成员、区域几何、截图和文字要求。
- **P0-04 视觉标记**：用户画笔或文字标记一个视觉区域；即使没有唯一 DOM 目标，标记仍可保存并明确其定位风险。
- **P0-05 定向修改**：发送一条 Annotation，Agent 只修改允许范围内的源文件，并产生可检查的运行记录。
- **P0-06 自动刷新**：文件稳定变化后，预览刷新到新内容；刷新失败显示明确状态。
- **P0-07 失败不丢失**：模拟 CLI 不可用、进程失败或目标丢失，Annotation、错误和已有证据仍可查看。
- **P0-08 确认或回退**：用户确认后状态为 `resolved`；用户回退后源文件恢复到运行前的确切内容，预览同步恢复。
- **P0-09 越界保护**：模拟 Agent 试图修改其他 Slide、全局主题或未授权文件，系统不把结果标记为成功。
- **P0-10 外部冲突**：运行期间修改同一 Project 的文件，系统提示冲突，不静默覆盖外部修改。

P0 验收必须能在 Windows 10 的固定示例 Project 上重复执行。没有可复现的失败证据、版本证据或回退证据，不得宣布 MVP 完成。

## 明确不属于 P0

- PowerPoint/PPTX 作为首要编辑模型、PPTX 导入或完全可编辑 PPTX 导出。
- 多人协作、远程对象存储、团队权限和多租户。
- 完整 HTML/CSS 编辑器、拖拽对齐、标尺、主题面板和任意全局 CSS 修改。
- 多 Annotation 批处理、Agent 运行中追加指令和复杂 Session 编排。
- 自动猜测丢失锚点、静默覆盖外部文件或默认启用 `bypassPermissions`。
- 生产级发布、自动更新和正式安装包；首个闭环先以开发运行和可复现实验为目标。

## 后续票据的输入

- [HTML-first 项目与 Deck 合同](https://github.com/1159741258/SHppt/issues/3)：把输入边界具体化。
- [P0 技术与部署基线](https://github.com/1159741258/SHppt/issues/4)：把 Windows 进程和授权边界具体化。
- [Annotation 与 iframe Bridge 合同](https://github.com/1159741258/SHppt/issues/5)：把四类 Annotation 和消息协议具体化。
- [Claude CLI 能力、权限与 AgentRun 合同](https://github.com/1159741258/SHppt/issues/6)：把 AgentRun 的执行和恢复规则具体化；具体合同见 [Claude CLI 与 AgentRun 合同](./claude-cli-agent-run-contract.md)。
- [项目状态、持久化与 ArtifactVersion 回退合同](https://github.com/1159741258/SHppt/issues/7)：把版本、冲突和回退具体化。
- [文件监听、事件与预览刷新合同](https://github.com/1159741258/SHppt/issues/8)：把刷新和一致性具体化。
- [Windows 10 CLI 与渲染前置条件核验](https://github.com/1159741258/SHppt/issues/9)：核验目标环境事实。
- [P0 测试、视觉质量与验收证据](https://github.com/1159741258/SHppt/issues/10)：把验收场景落成可重复证据。
