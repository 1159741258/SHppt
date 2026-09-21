# OpenDesign 与 Claude CLI 驱动的 Web 端 PPT 工具

## 调研与产品建议

> 调研对象：nexu-io/open-design  
> 目标产品：Web 端接入 Claude CLI 的 PPT 生成与修改工具  
> 核心关注：预览界面的选择、注释、标记与 Agent 定向修改闭环  
> 日期：2026-09-21

---

## 一、核心结论

最值得借鉴的不是 OpenDesign 的“自动生成 PPT”能力，而是下面这个闭环：

    预览画面
      -> 点击、框选、画笔、文字评论
      -> DOM 上下文、坐标、截图、文件路径
      -> 结构化 Annotation / Comment
      -> 带硬修改范围的 Claude Prompt
      -> Claude CLI 定向修改 HTML / CSS
      -> 文件变化回传、预览刷新
      -> 用户确认、继续标记或回滚

你的产品更接近“基于预览上下文的 Agent 编辑器”，而不是一开始就在浏览器里复刻完整的 PowerPoint 对象编辑器。

### 最重要的产品原则

1. 标记不能只是一张截图，也不能只是一句聊天消息。
2. 每条标记必须同时包含视觉上下文和代码定位上下文。
3. Claude 每次修改都应该有明确的范围限制。
4. 评论、版本、锚点和修改状态都应该持久化。
5. 元素发生变化时，系统不能静默把评论指向错误元素。

---

## 二、OpenDesign 做 PPT 的实际流程

### 2.1 完整工作流

    用户输入 Brief
      -> 加载 Skill / Plugin / Template
      -> Claude 生成 HTML / CSS / JS 幻灯片
      -> iframe 预览 Deck
      -> 用户点击、框选、画笔标记、添加文字评论
      -> 系统采集 DOM 信息、坐标和截图
      -> 生成结构化 Comment
      -> 拼接为 Claude Prompt
      -> Claude CLI 修改项目源文件
      -> 文件变化监听、预览刷新
      -> 用户继续反馈或确认
      -> 导出 PNG / PDF / PPTX

### 2.2 HTML-first 模型

OpenDesign 的主要源文件是 HTML、CSS、JavaScript 和图片等资源：

- 每页通常是一个 .slide 元素；
- 页面可以使用 data-screen-label 标记；
- 主要可交互元素使用 data-od-id 标识；
- iframe 负责隔离、预览和注入交互桥；
- PPTX 更接近最终导出格式，而不是最初的编辑模型。

优点是 Claude 可以直接读写前端源文件，修改结果很快回到浏览器预览。缺点是，如果最终要求 PowerPoint 中的文字和图形都可编辑，还需要额外做 HTML 元素到 PPT Shape 的映射。

### 2.3 修改闭环的关键

用户说“这一页标题小一点、往上移”，系统需要把这句话转换成：

    哪个文件？
    哪个页面？
    哪个 DOM 元素？
    当前文本是什么？
    当前尺寸和样式是什么？
    用户画了哪个区域？
    用户期望的视觉结果是什么？
    这次允许修改哪些范围？

OpenDesign 的核心价值就在于把这些信息自动收集并放进下一次 Agent 调用。

---

## 三、最值得借鉴的交互机制

### 3.1 选择元素时保存视觉信息和结构信息

用户点击标题时，不应只记录 x 和 y。建议至少保存以下字段：

    {
      "elementId": "title-01",
      "selector": "[data-od-id=\"title-01\"]",
      "label": "页面标题",
      "text": "企业数字化转型",
      "position": {
        "x": 420,
        "y": 180,
        "width": 520,
        "height": 80
      },
      "htmlHint": "<h1>企业数字化转型</h1>",
      "computedStyle": {
        "fontSize": "42px",
        "color": "#222222",
        "fontWeight": "700"
      },
      "slideIndex": 2,
      "filePath": "slides/slide-02.html"
    }

结构化信息负责精确定位，截图负责表达视觉关系。两者应一起保存。

### 3.2 区分点击、框选、画笔和文字标注

| 标记方式 | 适合表达的问题 | 进入 Agent 后的典型含义 |
| --- | --- | --- |
| 点击 | 标题、图片、按钮、文字 | 修改某个明确 DOM 元素 |
| 框选 | 一组元素或一个区域 | 处理分组、间距、对齐和局部布局 |
| 画笔 | 视觉重心、线条、空白、错位 | 结合截图理解视觉问题，可能没有唯一 DOM 目标 |
| 文字标注 | 补充要求和验收条件 | 作为直接指令和约束进入 Prompt |

例子：

    框选右侧三个卡片
    评论：三个卡片的顶部必须对齐，间距统一为 24px

系统应保存框选范围、命中的 DOM 成员、截图和文字，而不是只保存一张带蓝框的图片。

### 3.3 截图和结构化数据双通道传给 Claude

建议每条反馈同时包含四类信息：

| 信息通道 | 解决的问题 | 典型内容 |
| --- | --- | --- |
| 截图 | 表达视觉意图 | 页面整体、标记层、箭头、圈选、画笔 |
| DOM 上下文 | 精确定位 | elementId、selector、text、htmlHint、computedStyle |
| 项目上下文 | 找到修改入口 | filePath、slideIndex、version、相关资源 |
| 用户指令 | 明确修改目标 | note、验收标准、是否允许扩大范围 |

只传截图时，模型可能看得见问题，却无法稳定判断应该修改哪个 HTML 文件、哪个元素，以及当前 CSS 的真实来源。

### 3.4 给 Agent 设定硬修改范围

建议把评论整理成如下上下文：

    <attached-preview-comments>
    Hard scope: change ONLY the elements identified below.
    </attached-preview-comments>
+
推荐把修改范围分成三层：

1. 局部元素修改：只改变被选中的元素；
2. 区域布局修改：允许调整选区内元素及其直接父级布局；
3. 全局主题修改：涉及设计 token、全局 CSS 或多页联动，必须单独确认。

这是控制 Claude 副作用的关键机制。

### 3.5 评论应是持久化任务，而不是一次性聊天消息

用户通常会先标记多个问题，再批量让 Agent 处理。因此评论应支持保存、发送、排队、重试和状态追踪。

建议状态机：

    open
      -> attached
      -> applying
      -> needs_review
      -> resolved / failed

建议能力：

- 标记后先保存，不必立即触发 Claude；
- 一次把多个页面的评论组成一个 Agent 任务；
- Agent 运行时，新评论进入队列；
- 失败评论可以单独重试；
- 每条评论关联触发它的版本和 Agent Run；
- 前端展示当前状态和失败原因。

### 3.6 处理标记锚点漂移

Claude 修改后，元素 ID、HTML 结构、文本或位置都可能变化。系统需要重新定位旧评论：

1. 优先精确匹配 elementId 和 selector；
2. 失败后，根据 htmlHint、文本和页面位置做模糊匹配；
3. 匹配不确定时标记为 stale，要求用户确认；
4. 完全找不到时标记为 lost，保留最后位置的 ghost pin。

| 锚点状态 | 含义 | 前端表现 |
| --- | --- | --- |
| anchored | 精确命中原元素 | 正常显示锚点 |
| reanchored | 通过模糊匹配重新定位 | 显示“已重新定位” |
| stale | 可能命中错误元素 | 高亮警告并要求确认 |
| lost | 原元素已消失 | 显示最后位置和恢复/删除操作 |

### 3.7 实时预览修改和源文件提交分离

Manual Edit 的思路值得借鉴：

    用户拖动 / 修改样式
      -> iframe 内实时预览
      -> 用户点击保存
      -> 生成结构化 Patch
      -> 修改原始 HTML / CSS
      -> 记录 beforeSource / afterSource
      -> 写入新版本

初期只建议支持有限字段：

- 文本；
- 图片地址和替代文本；
- 字号、颜色、背景色；
- 宽高、x/y 位置；
- 对齐方式；
- margin / padding。

完整 HTML/CSS 编辑器成本高，也容易和 Claude 的修改产生冲突，可以后置。

---

## 四、推荐的数据模型

### 4.1 Annotation / Comment

    Annotation = {
      id,
      projectId,
      version,
      slideIndex,
      filePath,
      target: {
        elementId,
        selector,
        label,
        text,
        htmlHint,
        style,
        position,
        podMembers
      },
      geometry: {
        normalizedBounds,
        strokes,
        pins
      },
      markKind: click | box | stroke | text | visual,
      screenshotPath,
      note,
      attachments,
      status,
      anchorStatus
    }

normalizedBounds 应使用相对于预览区域的归一化坐标：

    x / previewWidth
    y / previewHeight
    width / previewWidth
    height / previewHeight

同时保留截图原始尺寸。这样窗口缩放或预览尺寸变化后，标记仍然可以恢复。

### 4.2 ArtifactVersion

    ArtifactVersion = {
      id,
      parentVersionId,
      changedFiles,
      beforeSource,
      afterSource,
      triggeredAnnotations,
      agentRunId,
      createdAt
    }

每次 Claude 修改至少应保存：

- 修改前版本；
- 修改后版本；
- 发生变化的文件；
- 触发本次修改的评论；
- Agent 执行记录；
- 用户是否确认或回滚。

## 五、推荐的系统架构

    Browser
      |- DeckViewer：iframe 预览、页面切换、刷新
      |- SelectionBridge：点击、hover、框选、DOM 识别
      |- AnnotationOverlay：框选、画笔、文字、撤销重做
      |- CommentPanel：保存、发送、排队、状态
      |- VersionPanel：版本、diff、回滚
              | HTTP / WebSocket / SSE
              v
    Local Daemon / Electron Sidecar
      |- AgentRunService：启动和管理 Claude CLI
      |- PromptAssembler：评论、截图、DOM 信息组装
      |- ArtifactWatcher：监听 HTML/CSS/资源变化
      |- AnchorResolver：重新定位旧评论目标
      |- PatchService：应用人工修改和结构化 Patch
      |- VersionStore：快照、差异、回滚
      |- ExportService：PNG / PDF / PPTX
              | spawn / execFile
              v
    Claude CLI

### 5.1 前端模块

| 模块 | 责任 |
| --- | --- |
| DeckViewer | iframe 预览、页面切换、文件刷新 |
| SelectionBridge | 点击、hover、框选、DOM 元素识别 |
| AnnotationOverlay | 框选、画笔、文字标记、撤销/重做 |
| CommentPanel | 评论保存、发送、队列和状态 |
| InspectPanel | 查看元素文本、样式、尺寸 |
| VersionPanel | 版本列表、diff、回滚 |

### 5.2 本地 Daemon 模块

| 模块 | 责任 |
| --- | --- |
| AgentRunService | 启动、取消和管理 Claude CLI |
| PromptAssembler | 把评论、截图、DOM 信息整理为 Prompt |
| ArtifactWatcher | 监听 HTML/CSS/资源变化 |
| AnchorResolver | 重新定位旧评论目标 |
| PatchService | 应用人工修改和结构化 Patch |
| VersionStore | 保存快照、差异和回滚信息 |
| ExportService | 导出 PNG、PDF、PPTX |

### 5.3 iframe 和宿主之间的消息协议

建议定义版本化的 postMessage 协议。OpenDesign 的思路是由 srcdoc 注入多种 Bridge：

- commentBridge：评论目标；
- inspectBridge：元素检查；
- selectionBridge：选择和框选；
- editBridge：实时编辑；
- paletteBridge：颜色或主题相关能力。

建议消息包括：

| 方向 | 消息示例 | 作用 |
| --- | --- | --- |
| iframe -> 宿主 | od:comment-target | 用户点击或选中元素 |
| iframe -> 宿主 | od:comment-targets | 多元素框选 |
| iframe -> 宿主 | od:comment-hover | hover 预览目标 |
| iframe -> 宿主 | od:pod-stroke | 画笔笔迹 |
| 宿主 -> iframe | od:comment-mode | 打开或关闭标记模式 |
| 宿主 -> iframe | od:inspect-set | 设置 Inspect 目标 |
| 宿主 -> iframe | od:inspect-extract | 请求元素上下文 |
| 双向 | od:deck-ready / od:slide-state | 同步 Deck 状态 |

## 六、Claude CLI 接入建议

### 6.1 推荐运行形态

浏览器不应该直接启动 Claude CLI。推荐：

    Browser
      -> HTTP / WebSocket / SSE
      -> Local Daemon 或 Electron Sidecar
      -> spawn / execFile
      -> Claude CLI
      -> 修改项目文件
      -> File Watcher
      -> 浏览器刷新预览

### 6.2 CLI 参数模式

    claude
      -p
      --input-format stream-json
      --output-format stream-json
      --verbose
      --add-dir <project-path>
      --resume <session-id>

### 6.3 Windows 实现注意事项

| 事项 | 建议 |
| --- | --- |
| Prompt 传递 | 通过 stdin 传递，避免 Windows 命令行长度限制 |
| 进程启动 | 使用 spawn / execFile，避免拼接 shell 字符串 |
| 输出处理 | 解析 JSONL，展示文本、工具调用、文件写入和错误 |
| 上下文延续 | 使用 --resume 复用同一个项目会话 |
| 文件权限 | 对项目目录做 allowlist，支持取消和写入确认 |
| 安全策略 | 生产环境不建议默认使用 bypassPermissions |

### 6.4 Agent Prompt 的最小组成

    项目路径
    当前版本
    页面索引
    目标文件
    目标元素
    selector / elementId
    当前文本和样式
    选区或笔迹坐标
    截图路径
    用户评论
    硬修改范围
    验收条件

---

## 七、MVP 优先级

### P0：先跑通核心闭环

- HTML-first Deck；
- iframe 预览；
- 页面导航；
- data-od-id 元素标识；
- 点击选择；
- 框选；
- 画笔；
- 文字评论；
- 截图；
- Claude CLI 流式调用；
- 文件变化后自动刷新；
- 基础版本快照。

### P1：让产品真正可用

- 评论持久化；
- 多评论批量发送；
- Agent 运行中排队；
- 评论状态机；
- 锚点漂移处理；
- Claude 修改范围限制；
- 修改前后 diff；
- 撤销和回滚；
- 外部文件冲突检测。

### P2：增强编辑体验

- Inspect 面板；
- 受限样式编辑；
- 拖拽对齐；
- 标尺和测量线；
- 可视化 Patch；
- 多人协作；
- 可编辑 PPTX 导出。

### MVP 验收标准

一个完整的 P0 版本至少应该能做到：

1. 用户打开一个 HTML Deck；
2. 点击或框选某个页面元素；
3. 写下修改要求并生成截图；
4. Claude 只读取并修改指定范围；
5. 文件变化自动刷新预览；
6. 用户可以看到修改后的版本；
7. 修改失败时评论不丢失；
8. 用户可以回到修改前版本。

---

## 八、不建议直接照搬的部分

| 做法 | 问题 | 建议替代 |
| --- | --- | --- |
| 只依赖截图 | 模型能看见问题，但不稳定定位源文件和元素 | 截图 + DOM 上下文 + 文件路径 |
| 只保存绝对坐标 | 预览尺寸变化后失效 | 归一化坐标 + 原始截图尺寸 + 元素锚点 |
| 一开始做完整 HTML 编辑器 | 成本高，容易和 Agent 修改冲突 | 先做有限属性和结构化 Patch |
| 允许 Agent 任意改全局 CSS | 局部需求可能造成全局副作用 | 硬修改范围 + 全局修改确认 |
| 图片型 PPTX 作为唯一导出 | 文字和图形不可编辑 | 视觉优先与可编辑导出分路线 |
| 标记目标丢失后自动猜测 | 可能静默改错元素 | stale / lost 状态 + 用户确认 |

## 九、PPTX 导出路线选择

OpenDesign 的 HTML-first 路径有很好的视觉还原能力，但默认 PPTX 导出更接近：

    每页 HTML 截图 -> 放入 PPTX

### 路线 A：图片型 PPTX

优点：

- 复杂 CSS 还原稳定；
- 页面效果与 Web 预览一致；
- 开发成本较低。

缺点：

- 文字不可编辑；
- 图形不可单独调整；
- 后续二次编辑能力弱。

### 路线 B：可编辑 PPTX

把 HTML 元素映射成 PowerPoint Shape：

- 文本映射为文本框；
- 图片映射为图片；
- 矩形、线条映射为 Shape；
- 简单布局映射为位置和尺寸。

优点是可编辑，缺点是复杂 CSS、滤镜、渐变、嵌套布局和字体差异会带来较大兼容成本。

### 建议

MVP 默认使用图片型 PPTX 或 PDF，先保证视觉质量；后续再为常见元素提供有限的可编辑导出。不要一开始同时追求复杂网页效果和完全可编辑 PPTX。

---

## 十、建议的首个产品闭环

如果只实现一个 OpenDesign 特性，优先实现下面这条链路：

    点击 / 框选 / 画笔标记
      -> 采集 DOM 上下文、坐标、截图和用户文字
      -> 生成结构化 Annotation
      -> 拼接带硬范围的 Claude Prompt
      -> Claude 修改指定 HTML / CSS
      -> 文件监听并刷新 iframe
      -> 展示版本差异
      -> 用户确认、继续标记或回滚

这条链路比单纯增加一个聊天框更能提升 PPT 修改质量，因为它把“用户看到的问题”转成了“Agent 能定位和执行的任务”。

---

## 十一、调研参考

- [OpenDesign README](https://github.com/nexu-io/open-design/blob/main/README.md)
- [Skills Protocol](https://github.com/nexu-io/open-design/blob/main/docs/skills-protocol.md)
- [Plugin Spec](https://github.com/nexu-io/open-design/blob/main/docs/plugins-spec.md)
- [HTML PPT Skill](https://github.com/nexu-io/open-design/blob/main/design-templates/html-ppt/SKILL.md)
- [iframe Bridge / srcdoc](https://github.com/nexu-io/open-design/blob/main/apps/web/src/runtime/srcdoc.ts)
- [标记覆盖层 PreviewDrawOverlay](https://github.com/nexu-io/open-design/blob/main/apps/web/src/components/PreviewDrawOverlay.tsx)
- [评论数据模型 comments.ts](https://github.com/nexu-io/open-design/blob/main/packages/contracts/src/api/comments.ts)
- [Prompt 组装 chat-prompt-inputs.ts](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/chat-prompt-inputs.ts)
- [Claude CLI 定义](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/defs/claude.ts)
- [Claude 流解析](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/claude-stream.ts)
- [Deck 导出](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/deck-export.ts)
- [Electron Deck Capture](https://github.com/nexu-io/open-design/blob/main/apps/desktop/src/main/deck-capture.ts)

---

## 十二、一句话产品定义

> 一个以 HTML 幻灯片为源文件、以 iframe 为预览画布、以视觉标记为输入、以 Claude CLI 为修改引擎、以版本和评论状态为保障的 Agent PPT 编辑器。
+

---

## 十三、多 Agent 源码补充调查说明

本轮采用 6 个独立调查方向，分别覆盖：

1. Daemon、项目、文件树、文件监听和预览运行时；
2. Claude Runtime、流协议、Session、插件和 Skill；
3. 预览壳、导航、缩放和编辑工作台；
4. PNG、PDF、PPTX、媒体和导出资源；
5. 诊断、权限、错误恢复、并发和测试；
6. 模板、设计规范和最终 PPTX 质量验证。

子代理以 OpenDesign 的 main 分支提交 894d55466b4a 为主要证据，仓库版本约为 v0.23.1。本节只纳入能够落到具体源码路径、类型、函数或测试文件的结论。

---

## 十四、值得新增借鉴的系统设计

### 14.1 Daemon 是唯一权威层

源码证据：

- docs/architecture.md；
- apps/daemon/src/server.ts；
- apps/daemon/src/server-context.ts；
- apps/daemon/src/http/adapter.ts。

OpenDesign 的 Web、桌面端和 od CLI 共享 Daemon HTTP API。项目元数据、文件内容、运行记录、事件、预览和 Runtime 依赖都由 ServerContext 统一注入和管理。当前主要通信方式是 HTTP + SSE，而不是让浏览器直接维护一套独立状态。

对你的产品的建议：

- 浏览器只负责 UI 和状态投影；
- 本地 Daemon 负责项目、文件、Agent、版本和权限；
- Electron 只负责原生目录选择、窗口和受信任桌面能力；
- Web、桌面端和命令行都调用同一套 API；
- 不要让“浏览器里的项目状态”和“磁盘上的项目状态”形成两个真相源。

优先级：P0。

### 14.2 项目身份、内容目录和工作区授权分离

源码证据：

- apps/daemon/src/project-locations.ts；
- apps/daemon/src/projects.ts；
- .open-design/project.json；
- docs/architecture.md。

项目既可以位于 Daemon 管理目录，也可以直接指向用户已有的外部文件夹。项目 Manifest 保存项目 ID、名称、时间戳、Skill 和设计系统等元信息。外部文件夹不一定要复制进应用目录。

建议把你的产品身份拆成三层：

| 层级 | 内容 |
| --- | --- |
| 项目身份 | projectId、名称、项目类型、创建时间 |
| 内容根目录 | Daemon 托管目录或用户选择的外部目录 |
| 工作区授权 | 用户、团队、角色、读写权限和 Agent 权限 |

外部目录必须经过 canonical path 校验，并限制符号链接、隐藏目录和越界访问。

优先级：P0。

### 14.3 文件树应是语义化索引

源码证据：

- apps/daemon/src/projects.ts；
- apps/daemon/src/project-file-versions.ts；
- apps/daemon/src/storage/project-storage.ts。

OpenDesign 的文件树不只是路径列表，还会处理：

- 文件类型、MIME、大小和修改时间；
- 入口文件发现，优先识别 index.html；
- dotfiles、生成目录和内部 artifact 文件过滤；
- since 参数驱动的增量文件列表；
- 项目文件版本；
- 项目 ZIP 导出；
- DESIGN-HANDOFF.md 和 DESIGN-MANIFEST.json 等交付元文件；
- LocalProjectStorage 和 S3ProjectStorage 的存储抽象。

你的产品可以把文件树直接设计成 Agent 和预览共同使用的项目索引：

~~~text
FileNode = {
  path,
  kind,
  mime,
  size,
  mtime,
  hash,
  previewable,
  entryCandidate,
  artifactManifest
}
~~~

这样文件树同时服务于：

- 预览入口发现；
- Claude 读取和修改；
- 资源上传；
- 版本 diff；
- 导出；
- 项目交付。

优先级：P0；远端对象存储抽象可放到 P2。

### 14.4 文件监听采用引用计数和真实目录复用

源码证据：

- apps/daemon/src/project-watchers.ts；
- ProjectWatchEvent；
- ProjectWatchKind；
- subscribe()。

OpenDesign 的 watcher registry 按解析后的真实项目目录复用。第一次订阅时创建 chokidar，最后一个订阅者退出时才关闭。事件支持 add、change、unlink；写入完成后等待稳定时间再通知；遇到 ENOSPC 或 EMFILE 时切换 polling。

建议直接借鉴：

- 按真实项目目录作为 watcher key；
- UI 订阅驱动 watcher 生命周期；
- 事件统一转成项目相对路径；
- 写文件时等待稳定，避免半成品刷新；
- Windows 文件系统异常时支持 polling fallback；
- 不要让每个页面或每个浏览器窗口都创建一个 OS watcher。

优先级：P0。

### 14.5 用统一 SSE 事件通道同步 Agent、文件和预览

源码证据：

- packages/contracts/src/sse/common.ts；
- packages/contracts/src/sse/chat.ts；
- apps/web/src/providers/sse.ts；
- apps/web/src/providers/project-events.ts；
- apps/daemon/src/http/adapter.ts；
- ServerContext.http.createSseResponse；
- ProjectWatchEvent。

建议不要为 Agent 输出、文件变化、预览刷新分别设计三套长连接，而是统一事件信封：

~~~text
event: project.file-changed
id: monotonic-sequence
data: { projectId, path, kind, version }
~~~

事件类型可以统一为：

- run.started；
- run.delta；
- run.tool-call；
- run.file-written；
- project.file-changed；
- preview.stale；
- preview.ready；
- export.progress；
- export.failed。

客户端断线后先重新拉取项目快照，再按序处理增量事件。事件是增量通知，不应成为唯一数据源。反向代理还要配置 keepalive、禁用 buffering/compression 和合理超时。

优先级：P0。

### 14.6 预览层要有 URL 与 srcDoc 两种模式

源码证据：

- apps/web/src/components/file-viewer-render-mode.ts；
- apps/web/src/runtime/srcdoc.ts；
- apps/web/src/runtime/deck-protocol.ts；
- packages/contracts/src/runtime/deck-protocol.ts；
- packages/contracts/src/runtime/preview-runtime-state.ts；
- packages/contracts/src/runtime/preview-guards.ts；
- apps/daemon/src/server-context.ts 中的 ProjectPreviewScopeDeps。

两种模式的职责不同：

| 模式 | 适合场景 |
| --- | --- |
| Daemon URL | 接近真实项目运行环境，资源加载稳定 |
| srcDoc | 注入选择、Inspect、标记和编辑 Bridge，便于调试 |

建议预览合同至少包含：

~~~text
ready | loading | error | stale | expired
~~~

同时实现：

- 短期预览访问 scope；
- mint、acquire、renew、validate、resolve；
- 校验 postMessage 的 event.source；
- 校验活动 iframe 和允许协议；
- URL 与 srcDoc frame 同时保持挂载，减少切换闪烁；
- 预览过期后明确显示重新加载，而不是空白页。

优先级：P0。

### 14.7 Electron Main、Daemon、Renderer 三层边界

源码证据：

- apps/packaged/src/sidecars.ts；
- apps/packaged/src/launch.ts；
- tools/dev/src/sidecar-client.ts；
- apps/desktop/src/main/open-path.ts；
- apps/daemon/src/desktop-auth.ts；
- apps/daemon/src/import-export-routes.ts；
- docs/architecture.md。

外部目录导入的关键设计是：Electron 主进程完成原生目录选择，签发短时、单次使用的 HMAC token，Daemon 验证后才允许导入。打包版通过 sidecar IPC 发现 Web URL，不假定固定端口。

你的 Windows 版建议保持：

~~~text
Renderer：只负责 UI
Main：负责原生目录选择、窗口和受信任能力
Daemon：负责文件访问、项目状态、Agent 和事件流
~~~

不要让 Renderer 直接访问文件系统，也不要把用户选择的路径直接当作后端已授权路径。

优先级：P1。
+
---

## 十五、值得新增借鉴的 Agent Runtime 设计

### 15.1 用能力探测，而不是按版本号硬编码

源码证据：

- apps/daemon/src/runtimes/defs/claude.ts；
- apps/daemon/src/runtimes/types.ts；
- apps/daemon/src/runtimes/launch.ts；
- apps/daemon/src/runtimes/invocation.ts。

RuntimeAgentDef 统一描述二进制、认证探测、模型、输入输出格式、参数构建和 Session 能力。Claude 定义会通过 capabilityFlags 探测参数能力，例如 partial messages、subagent text、agents、add-dir 和隐藏 thinking 参数，再决定是否传递。

你的产品建议：

~~~text
AgentProvider = {
  id,
  executable,
  authProbe,
  modelResolver,
  capabilities,
  buildArgs,
  parseStream,
  resumePolicy,
  permissionPolicy
}
~~~

不要假设所有 Claude CLI 版本都支持同一组参数。启动前探测能力，运行中只发送已确认支持的参数。

优先级：P0。

### 15.2 分离 project session、agent run 和 turn

OpenDesign 支持 resumeSessionId 和 newSessionId：

- 有 resumeSessionId 时使用已有 Session；
- 没有时生成新的 session-id；
- 每次具体执行仍应有独立 run-id；
- turn 是一次模型交互或一次用户追加指令。

建议你的数据模型至少分成三层：

| 层级 | 生命周期 | 作用 |
| --- | --- | --- |
| Project Session | 跨多次修改 | 保留项目、模板和设计上下文 |
| Agent Run | 一次完整修改任务 | 关联评论、文件变化、状态和错误 |
| Turn | Run 中的一次交互 | 关联增量文本、工具调用和用量 |

Resume 前检查：

- 项目路径是否一致；
- worktree 或内容版本是否一致；
- Provider 和模型是否一致；
- 权限上下文是否一致；
- MCP 配置是否一致。

优先级：P0。

### 15.3 Stream JSON 必须多终点兼容并幂等去重

源码证据：

- apps/daemon/src/runtimes/claude-stream.ts；
- apps/daemon/src/runtimes/chat-run-lifecycle.ts；
- apps/daemon/src/runtimes/run-event-payload-budget.ts。

createClaudeStreamHandler 同时兼容增量 stream_event、assistant wrapper 和 result frame。emitTurnEndOnce 将不同版本的终点归一为一次 turn_end；emittedToolUseIds 防止工具调用重复发出；perRequestUsageFrom 聚合 token 用量。

建议把流解析拆成独立状态表：

~~~text
text_delta
tool_call
tool_result
task_state
file_written
usage
turn_end
run_terminal
~~~

要求：

- 同一个 frame 重放不会重复产生 UI 事件；
- 缺失某个版本的终点 frame 仍能正确结束 Run；
- 工具调用 ID、文件路径和 Run ID 具备幂等键；
- payload 大小超限时保留摘要和 side-effect 证据，不要让单条大消息拖垮事件流。

优先级：P0。

### 15.4 支持 mid-turn steering

源码证据：

- apps/daemon/src/runtimes/run-steering.ts；
- classifyRunSteering；
- encodeStreamJsonUserMessage；
- writeSteeringUserMessage。

当 Runtime 仍支持追加输入、Run 尚未终止且 stdin 仍开放时，可以写入结构化 user frame。这样用户可以在 Agent 运行过程中补充约束，而无需取消当前任务、丢失上下文后重新开始。

适合 PPT 的场景：

- “保留当前布局，只把标题再缩小一点”；
- “刚才的修改影响了第二页，请回滚第二页”；
- “继续处理剩余 3 条评论，但不要改主题色”。

必须明确三种状态：

- 可追加；
- 只能排队；
- 已终止，只能新建 Run。

优先级：P1。

### 15.5 用 side-effect ledger 判断成功与恢复

源码证据：

- apps/daemon/src/runtimes/chat-run-lifecycle.ts；
- run-restart-recovery.ts；
- run-terminal-reconciliation.ts；
- run-done-key.ts；
- run-produced-files.ts；
- run-lifecycle-analytics.ts。

OpenDesign 的恢复逻辑不只看进程退出码，还会检查实际文件写入、artifact 产生和事件是否截断。runSideEffectsForRun、runFilesWrittenForRun 等函数优先读取 side-effect ledger。

这是 PPT Agent 非常重要的设计：

~~~text
进程退出
  -> 查询 side-effect ledger
  -> 是否写入目标文件？
  -> 是否生成预览或导出 artifact？
  -> 是否已经产生用户可见修改？
  -> 决定 retry / resume / needs_review
~~~

否则 Claude 已经写入文件但进程异常时，系统再次 retry 可能导致重复修改。

优先级：P0。

### 15.6 中途取消必须可重入、可清理

源码证据：

- apps/daemon/src/critique/interrupt-handler.ts；
- apps/daemon/src/critique/run-registry.ts；
- apps/daemon/src/collab/concurrency-gate.ts；
- apps/daemon/src/agent-session-resume.ts。

每个 Run 都应拥有：

- owner；
- cancel handle；
- child process；
- cleanup owner；
- terminal reconciliation；
- recoverable session identity。

取消必须幂等。进程退出、Daemon 重启和 UI 断线都不能留下“仍在运行”的假状态。

优先级：P1。

### 15.7 错误应映射为用户动作

源码证据：

- apps/daemon/src/http/api-failure-journal.ts；
- apps/daemon/src/http/api-errors.ts；
- apps/daemon/src/critique/errors.ts；
- specs/current/run-error-catalog.md；
- specs/current/run-failure-action-mismatch-2026-09-02.md。

错误对象建议至少包含：

~~~text
{
  code,
  runId,
  phase,
  retryable,
  userAction,
  redactedContext,
  originalCause
}
~~~

前端不要只展示 CLI stderr，而应让用户知道：

- 发生在启动、生成、写文件、刷新预览还是导出；
- 是否已经改动文件；
- 是否可以重试；
- 重试会不会重复修改；
- 下一步是授权、修复路径、恢复版本还是重新生成。

优先级：P0。

### 15.8 诊断功能应能导出证据包

源码证据：

- apps/daemon/src/claude-diagnostics.ts；
- apps/daemon/src/diagnostics-client-evidence.ts；
- apps/daemon/src/diagnostics-export.ts；
- apps/daemon/src/agent-protocol/dsh-profile/probe.ts；
- tools/dev/src/diagnostics.ts；
- tools/dev/tests/diagnostics.test.ts。

建议一键导出脱敏诊断包，包含：

- OS 和应用版本；
- Claude CLI 路径和版本；
- 认证状态；
- Runtime 能力探测结果；
- 工作目录和端口；
- 当前 Project Session；
- 最近一次 Run 的阶段和错误码；
- 预览、字体和导出环境；
- 修复建议。

不要把用户源文件、API token、完整 Prompt 或图片内容默认放入诊断包。

优先级：P0。

### 15.9 Daemon 安全边界不能只靠 localhost

源码证据：

- apps/daemon/src/api-token-auth.ts；
- apps/daemon/src/desktop-auth.ts；
- apps/daemon/src/http/origin-guard.ts；
- apps/daemon/src/http/api-errors.ts；
- tools/dev/src/desktop-auth-gate.ts。

即使 Daemon 只监听 localhost，也应分别处理：

- API token；
- 桌面端授权；
- 请求 Origin；
- 外部目录权限；
- Agent 写入权限；
- 错误信息脱敏。

OpenDesign 当前 Claude 定义中出现 bypassPermissions 配置，这不应直接作为你的生产默认策略。至少要补充 canonical path、项目目录 allowlist、文件写入审计、用户确认和可回滚版本。

优先级：P0。
+

---

## 十六、值得新增借鉴的导出与媒体设计

### 16.1 PPTX 应明确分成视觉保真和可编辑两种语义

源码证据：

- apps/daemon/src/deck-export.ts；
- apps/desktop/src/main/deck-capture.ts；
- buildScreenshotPptx；
- renderDeckSlides；
- loadDomToPptxBundle。

OpenDesign 不是只有一种 PPTX：

| 模式 | 实现思路 | 结果 |
| --- | --- | --- |
| 视觉保真 PPTX | 每页一张全幅截图，再放入 PPTX | 视觉稳定，文字不可编辑 |
| 可编辑 PPTX | 使用 dom-to-pptx 把 DOM 转为文本和 Shape | 基础元素可编辑，复杂 CSS 需要折中 |

可编辑导出还会把渐变、伪元素、mask、blend mode、backdrop 和 filter 等难映射区域先栅格化，再保留可编辑前景。这是“部分可编辑”的实用折中。

你的产品建议明确提供：

- 视觉保真导出；
- 可编辑导出；
- 可编辑性报告，说明哪些元素被栅格化；
- 可编辑导出失败时，由用户显式切换到视觉保真导出。

不要把两者包装成同一个不可解释的“导出 PPT”按钮。

优先级：视觉保真 P0，可编辑模式 P1。

### 16.2 截图应等待稳定渲染，并冻结动画

源码证据：

- apps/desktop/src/main/deck-capture.ts；
- renderDeckSlides；
- captureDeckSlide；
- captureUntilPainted；
- prepareDeckStage；
- FROZEN_MOTION_CSS；
- Page.captureScreenshot。

OpenDesign 优先通过 CDP 的 Page.captureScreenshot 获取当前 DOM，Electron capturePage 作为回退；动画会被冻结，避免截图得到上一帧、重复页或不稳定状态。

借鉴设计：

- 预览状态增加 renderStable；
- 截图前等待字体、图片和关键资源；
- 注入冻结动画的 CSS；
- 优先捕获当前 DOM；
- CDP 失败时再使用桌面截图；
- 截图失败时返回明确失败码，不生成错误页图片。

优先级：P0。

### 16.3 资源路径使用显式 baseHref

源码证据：

- apps/daemon/src/deck-export.ts；
- apps/daemon/src/pdf-export.ts；
- buildDeckRenderInput；
- buildDesktopPdfExportInput。

导出时通过项目 API 注入资源基址，并对路径段编码，而不是依赖前端当前 URL 或猜测图片相对路径。

你的产品应统一提供：

~~~text
renderBase = /api/projects/{projectId}/raw/{encodedPath}/
~~~

这样 HTML、CSS、图片、字体和本地导入项目都能走同一套资源解析逻辑。

优先级：P0。

### 16.4 大图通过 outputDir 交接，不优先走 JSON IPC

源码证据：

- apps/desktop/src/main/deck-capture.ts；
- emitImages；
- apps/daemon/src/deck-export.ts；
- readSlideFiles。

高分辨率图片优先写入 outputDir，再由 Daemon 读取；只有没有 outputDir 时才返回 base64。这能避免大图片塞进 JSON IPC，减少内存峰值和消息大小问题。

优先级：P0。

### 16.5 字体和资源加载需要有界等待

源码证据：

- apps/desktop/src/main/deck-capture.ts；
- fetchGoogleFontStylesheets；
- loadDomToPptxBundle；
- waitForPrintableContent。

字体预取有来源限制和超时；资源加载失败不会无限等待，而是在可控边界内继续、回退或失败。

建议导出状态明确区分：

- font.loaded；
- font.timeout；
- font.fallback；
- asset.loaded；
- asset.timeout；
- render.failed。

优先级：P1。

### 16.6 导出错误不能把错误页当成果

源码证据：

- loadArtifactDocument；
- capturePage；
- deck-capture.ts 中的失败码。

至少定义：

- NO_SLIDES；
- SLIDE_INDEX_OUT_OF_RANGE；
- RESOURCE_TIMEOUT；
- FONT_FALLBACK；
- RENDER_FAILED；
- EXPORT_FAILED。

错误应关联 projectId、version、runId 和目标文件，便于重试和回滚。

优先级：P0。

### 16.7 媒体快照应锁定精确字节

源码证据：

- apps/daemon/src/chat-artifacts/capture.ts；
- apps/daemon/src/chat-artifacts/run-capture.ts；
- captureChatArtifactSnapshotFromBytes；
- captureChatArtifactSnapshotFromPath；
- captureRunChatArtifactSnapshots；
- findRunSnapshotForPath。

OpenDesign 对 Agent 生成的图片和媒体不接受“导出时重新读取当前路径”这种不稳定方式：

- 内存中的 provider 输出按 SHA-256 保存；
- 文件路径读取前后校验 size 和 mtime；
- 复制期间发现 source_changed 会失败；
- 同一个 Run 复用已经冻结的媒体字节；
- content 和 thumbnail 分开；
- 结果状态有 ready、failed、skipped；
- failureCodes 区分 source_missing、source_changed、source_unreadable 和 internal_error。

对 PPT 工具的意义：

用户在第一个版本中标记的图片，不能因为 Claude 下一轮覆盖同名文件，就在评论截图里悄悄变成第二个版本的图片。

优先级：P0。

### 16.8 长页面、整套 Deck 和单页应分开处理

源码证据：

- stitchDeckSlides；
- paginatePageViewports；
- capturePage；
- deck-capture.ts 中的内存和尺寸限制。

建议导出任务先判断：

- 当前是单页；
- 当前是整个 Deck；
- 当前是长页面；
- 当前是 PDF 分页；
- 当前是单页 PNG/JPEG。

每一种任务分别计算：

- viewport；
- 尺寸；
- 页数；
- 内存预算；
- 输出命名；
- 失败恢复点。

优先级：P1。

---

## 十七、值得新增借鉴的模板与质量体系

### 17.1 模板不是一个 HTML 文件，而是可验证能力包

源码证据：

- design-templates/guizang-ppt；
- design-templates/html-ppt-pitch-deck；
- design-templates/html-ppt-course-module；
- design-templates/html-ppt-product-launch；
- apps/daemon/src/automation-templates.ts；
- scripts/scaffold-html-ppt-skills.mjs；
- templates/deck-framework.html。

典型模板包包含：

~~~text
manifest / metadata
SKILL.md
assets/template.html
example.html
references/layouts.md
references/components.md
references/styles.md
references/themes.md
references/checklist.md
~~~

这套结构把以下内容绑定在一起：

- 任务意图；
- 生成步骤；
- 版式规则；
- 组件规则；
- 主题 token；
- 可复用资源；
- 样例；
- 验收清单。

建议你建立自己的 TemplatePackage：

~~~text
TemplatePackage = {
  manifest,
  skill,
  layoutRules,
  componentRules,
  themeTokens,
  assets,
  examples,
  checklist,
  validator
}
~~~

优先级：P0。

### 17.2 通用引擎、场景模板和主题三层分离

OpenDesign 把通用能力与视觉模板分开：

| 层 | 内容 |
| --- | --- |
| 引擎层 | HTML 生成、渲染、截图、PPTX、PDF、字体和资源 |
| 场景层 | 路演、产品发布、周报、技术分享、课程、风险通报 |
| 主题层 | 颜色、字体、网格、图表、卡片、背景和品牌规范 |

你的产品不要把一个模板目录同时当作生成器、主题、导出器和验证器。拆层后：

- Claude 可以替换主题而不重写生成流程；
- 同一个场景可以切换不同品牌主题；
- 同一套验证器可以检查所有主题；
- 模板升级不会破坏 Agent Runtime。

优先级：P0。

### 17.3 把“好看”转换成可验证规则

源码证据：

- skills/pptx-html-fidelity-audit/SKILL.md；
- skills/pptx-html-fidelity-audit/references/layout-discipline.md；
- skills/pptx-html-fidelity-audit/references/font-discipline.md；
- skills/pptx-html-fidelity-audit/scripts/extract_pptx.py；
- skills/pptx-html-fidelity-audit/scripts/verify_layout.py。

建议至少自动检查：

- 页面尺寸和比例；
- 元素越界；
- 元素重叠；
- 字体是否缺失或替换；
- 文本是否溢出；
- 图片分辨率；
- 页面间网格和边距一致性；
- 导出前后元素位置；
- HTML 预览与 PPTX 最终产物差异。

验证应分成两层：

~~~text
生成后：检查 HTML / CSS / DOM
导出后：检查 PNG / PDF / PPTX 最终产物
~~~

优先级：P0。

### 17.4 模板注册表和可发现能力

源码证据：

- .claude-plugin/marketplace.json；
- specs/current/skills-and-design-templates.md；
- skills/；
- design-templates/。

借鉴 marketplace 和能力 ID：

~~~text
templateId: html-ppt-product-launch
scene: product-launch
style: business
supports: [html, png, pdf, pptx]
validator: pptx-html-fidelity-audit
status: stable
~~~

Claude 不应依赖记忆目录路径，而应通过 registry 查询：

- 可用模板；
- 适用场景；
- 支持的输出格式；
- 所需字体和资源；
- 验证器；
- 当前版本；
- 是否可信。

优先级：P1。

### 17.5 example.html 应成为视觉回归基线

每个模板的 example.html 不仅是示例，也是视觉回归样本：

1. 生成或修改模板；
2. 截图或导出 PPTX；
3. 与基线进行图像或布局对比；
4. 发现字体、边界、间距和层级变化；
5. 人工确认后更新基线。

不要只复制 example.html 而不复制规则、资源和 checklist，否则会得到不可控的静态样例。

优先级：P1。









