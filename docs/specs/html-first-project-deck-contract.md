# P0 HTML-first Project 与 Deck 合同

状态：已决定，合同版本 `1`

对应票据：[HTML-first 项目与 Deck 合同](https://github.com/1159741258/SHppt/issues/3)

本合同把 [P0 MVP：视觉标记驱动的 Agent PPT 编辑器](./p0-mvp-acceptance.md) 中的输入边界具体化。它决定 Project、Content Root、Entry Document、Slide、Stable Element ID、Resource 和 File Index 的身份与边界；它不提前决定 Daemon 的进程拓扑、AgentRun 的执行协议或 ArtifactVersion 的持久化实现。

## 1. P0 形状

P0 支持一个本地 Project 暴露一个 active Deck。该 Deck 由一个 Entry Document 定义，Entry Document 在同一个 HTML 文档中包含一个或多个 Slide roots；CSS、JavaScript、图片、媒体和字体作为同一 Project 的本地 Resource。

P0 不支持以下输入形状：

- 通过递归搜索自动拼接多个 HTML 文件的 Deck；
- 每页一个独立 HTML 文件且没有单一 Entry Document 的 Deck；
- 以 `.pptx`、PowerPoint 对象模型或远程 URL 作为源文件模型；
- 依赖网络、`file:` URL 或 Content Root 之外文件才能完成预览的 Deck；
- 通过猜测多个候选入口来“尽量打开”的 Project。

后续要支持多 Entry Document 或多 Deck，必须新增版本化合同，不得把它们悄悄解释为当前 P0 的一种变体。

## 2. 身份与持久化边界

### 2.1 Project 身份

每个 Project 有以下身份字段：

| 字段 | 规则 |
| --- | --- |
| `projectId` | 应用生成的不透明 UUID；不由路径、目录名或 HTML 内容推导。Project 被重新打开时必须复用它。 |
| `name` | 仅用于展示；默认可以取目录名，但不能参与身份判断。 |
| `type` | P0 固定为 `html-deck`。 |
| `contentRoot` | 规范化后的本地目录；只在 Daemon 的受信任状态中保存，浏览器和 Agent-facing 消息不携带绝对路径。 |
| `entryPath` | Entry Document 相对于 Content Root 的 Project-relative Path。 |
| `contractVersion` | P0 为 `1`，用于拒绝不兼容的输入合同。 |

Project 元数据保存在应用自己的受信任状态中。打开 External Project 不会为了写入身份标记而改动用户源目录；源目录本身不是应用数据库。

P0 不单独生成 `deckId`：Deck 由 `projectId + entryPath` 识别。未来一个 Project 暴露多个 Deck 时，必须新增明确的 Deck 身份字段和迁移规则。

### 2.2 External Project 的打开条件

用户必须明确选择一个目录作为 Content Root。打开流程只有在以下条件全部满足时才会产生可编辑 Project：

1. 选择项存在且是目录；
2. 目录被规范化为唯一 canonical path；
3. 目录位于本机本地卷上；P0 拒绝 UNC 路径和网络驱动器；
4. 当前用户对目录拥有读取权限；需要修改时还必须拥有后续 AgentRun 要求的写权限；
5. Content Root 本身和所有被索引路径都是普通文件系统节点，不经过 Windows reparse point、junction 或 symlink；P0 即使目标仍在 Content Root 内也拒绝这类节点；无法完成真实路径解析时拒绝；
6. Project manifest、Entry Document 和全部被 Entry Document 引用的本地 Resource 都能在 Content Root 内解析。

打开已有的同一 canonical path 时复用已登记的 `projectId`。路径字符串的大小写、末尾分隔符和 `.` 段不构成新的 Project 身份。

## 3. 路径合同

### 3.1 Project-relative Path

资源引用的原始 URL 与对外传输的规范化 Path 是两个阶段。HTML/CSS 中的原始 URL 可以包含 `./`、`../` 或根相对 `/`；它先相对于引用文件解析，再转换成 Project-relative Path。浏览器、预览 Bridge、Annotation、File Index 和 AgentRun 之间只传转换后的 Project-relative Path：

- 使用 `/` 作为分隔符；
- 不以 `/` 开头，不包含盘符、UNC 前缀、空字节或 `..` 段；
- `.` 段、重复分隔符和反斜杠在进入合同前被拒绝，而不是静默修正；
- 路径按 Windows 不区分大小写的规则比较，但 File Index 保留磁盘上的实际大小写；
- Daemon 在访问前将路径解析为 canonical path，并确认它仍位于 Content Root；
- 任何越界、消失、无法解析或通过 reparse point 的路径都返回失败，不回退到相似路径。

客户端不得提交或依赖 `contentRoot`、任意绝对路径或 `file://` URL。Daemon 是访问本地文件的唯一边界持有者。

### 3.2 受保护路径

以下目录不进入可预览或 Agent-facing 的 File Index：`.git`、`.hg`、`.svn`、`.shppt`、`node_modules`、`dist`、`build` 和 `coverage`。这些目录属于版本控制、应用内部或生成输出，不是 Deck 的源输入；后续 Agent 权限合同另行决定凭据和私钥文件的最小拒绝策略。

如果 Entry Document 或 Resource 引用了受保护路径，Project 无效；不能通过把它从索引中隐藏来继续预览。未被引用的其他文件可以出现在内部扫描结果中，但不能因此获得浏览器或 Agent 的额外权限。

## 4. Manifest 与入口发现

### 4.1 可选 `shppt.json`

Content Root 根部可以放置 `shppt.json`。文件名按 Windows 大小写不敏感匹配，但 File Index 中把它标记为 Project metadata，不把它当作 Slide 内容。

P0 支持的最小格式是：

```json
{
  "schemaVersion": 1,
  "entry": "index.html"
}
```

规则如下：

- `schemaVersion` 必须是整数 `1`；
- `entry` 必须是非空的 `.html` 或 `.htm` Project-relative Path；
- `entry` 必须指向 Content Root 内的普通文件，不能指向目录、受保护路径、symlink 或 junction；
- P0 不接受未知字段；
- Manifest 存在但格式错误时，Project 失败，不能静默退回 `index.html`。

### 4.2 无 Manifest 时的确定性回退

如果根部没有 `shppt.json`，唯一允许的回退是 Content Root 根部的 `index.html`。P0 不递归搜索、不按文件名排序挑选、不根据文件大小或修改时间猜测入口。

因此入口发现结果只有三种：

| 结果 | 行为 |
| --- | --- |
| 合法 Manifest entry | 使用该 Entry Document。 |
| 无 Manifest 且根部存在 `index.html` | 使用 `index.html`。 |
| 其他情况 | Project 无效，并返回可操作的入口错误。 |

Manifest 的 `entry` 优先级高于 `index.html`；Manifest entry 无效时必须失败。

## 5. Entry Document 与 Slide 边界

### 5.1 HTML 文档要求

Entry Document 必须是可解析的 HTML 文档，使用标准文档模式并声明 UTF-8 编码。它可以引用 Content Root 内的 CSS、JavaScript、图片、媒体和字体 Resource。P0 的可重复预览不依赖远程网络资源。

### 5.2 Slide root

每个 Slide 由 Entry Document 中一个带 `data-od-slide` 的 HTMLElement 表示：

```html
<section data-od-slide="cover" data-screen-label="封面">
  <h1 data-od-id="cover-title">产品标题</h1>
</section>
```

规则如下：

- 必须至少有一个 `[data-od-slide]`；没有 Slide 的文档不是合法 Deck；
- `data-od-slide` 的值是非空 ASCII token，格式为 `[A-Za-z][A-Za-z0-9_-]{0,127}`；
- 一个值在整个 Deck 中只能出现一次；Slide root 不能嵌套另一个 Slide root；
- 文档顺序定义当前 `slideIndex`，机器从 `0` 开始；用户界面可显示从 `1` 开始的页码；
- `Slide ID` 是稳定身份，`slideIndex` 只是当前版本的顺序位置；
- `data-screen-label` 可选，只用于展示，不参与定位；缺失时使用 `Slide {slideIndex + 1}`；
- 每个 Slide root 在被激活预览时必须有非零的矩形渲染区域；所有 Slide 的宽高比必须一致，允许的浮点误差为 `0.01`；
- Slide root 必须位于 Entry Document 的 `body` 内，且不能是 `script`、`style`、`template` 或资源预加载节点；
- Slide 内容可以使用任意 HTML/CSS 布局，但源文件定位仍以 Entry Document 和 Project-relative Resource 为准。

P0 的导航、截图和 Annotation 都以 `Slide ID` 作为稳定引用，同时保存当时的 `slideIndex` 作为诊断信息。

## 6. Stable Element ID

需要被点击或精确框选的元素必须由作者提供 `data-od-id`：

- 值是非空 ASCII token，格式为 `[A-Za-z][A-Za-z0-9_-]{0,127}`；
- 值在整个 Deck 中全局唯一，不能只在当前 Slide 内唯一；
- 元素必须位于一个 Slide root 内；同一个 DOM 元素不能拥有多个 `data-od-id`；
- ID 必须由源文件作者稳定维护，不能由渲染顺序、随机数、坐标或当前 CSS 选择器生成；
- 修改元素的样式、文本或直接布局不应改变它的 ID；把同一 ID 复用于另一个语义元素等同于旧 Annotation 失去锚点；
- `data-od-id` 缺失的区域仍可以产生画笔或文字 Annotation，但只能作为视觉区域上下文，不能声称已精确绑定 DOM 元素；
- selector 是由受信任的 Bridge/Daemon 根据 ID 临时生成的定位提示，不是独立身份，也不能覆盖 ID 的唯一性校验。

如果扫描发现重复、非法或跨 Slide 的 Stable Element ID，Project 进入不可编辑状态；不能选择其中一个继续运行 AgentRun。

## 7. Resource 与字体路径

Resource URL 按浏览器标准相对 URL 规则相对于引用它的 HTML/CSS 文件解析，解析结果再转换为 Project-relative Path。P0 只接受可以在扫描时确定的本地 Resource：

- `./img/a.png`、`../fonts/a.woff2` 和根相对 `/assets/a.css` 都可以映射到 Content Root 内的文件；根相对路径 `/` 表示 Content Root，而不是操作系统盘根；
- URL 的 query 和 fragment 不改变 Resource 的文件身份；`#fragment` 只引用同一文档内的内容；
- `data:` 内联资源可以使用，但不产生 File Index 项；运行时 `blob:` 资源不能作为 P0 的持久 Resource；
- `http:`、`https:`、协议相对 URL、`file:`、`javascript:`、`vbscript:` 和任何越过 Content Root 的引用都不是 P0 支持的本地 Resource；Entry Document 依赖它们时 Project 无效；
- HTML 的 `src`/`href`/`poster`/`srcset`、CSS `url()` 与静态 `@import`、字体 `@font-face src`、静态 ESM `import`/`export ... from` 以及字符串字面量的 `new URL(..., import.meta.url)` 都必须遵循同一边界，并递归进入 File Index；
- `fetch()`、动态 `import()`、运行时创建的元素 URL、服务 worker 请求和其他由 JavaScript 运行结果决定的 URL 不属于 P0 的静态 Resource 发现范围；如果 Slide 的可重复预览依赖它们，Project 以 `PROJECT_RESOURCE_DYNAMIC_UNSUPPORTED` 失败；
- 字体文件作为 `kind: font` 的 Resource 进入 File Index，保留其 Project-relative Path；系统字体可以作为 CSS fallback，但不能替代被声明的本地字体文件；
- Resource 在 File Index 中只保留一份规范化身份，即使被多个文件引用。

## 8. File Index

File Index 是预览、Annotation、AgentRun 和后续版本检查共享的输入。至少包含以下字段：

```text
FileIndexEntry = {
  path: Project-relative Path,
  kind: directory | manifest | html | css | script | image | media | font | data | other,
  size: integer,
  mtime: timestamp,
  contentHash: sha256 | null,
  entryCandidate: boolean,
  previewable: boolean,
  protected: boolean
}
```

### 8.1 File Index Snapshot

一次 Project scan 产生一个不可变的 `FileIndexSnapshot`，由受信任的 Project 状态持有；preview、Annotation 和 AgentRun 都引用这个 snapshot，而不是各自扫描或拼接文件。具体由 Browser、Daemon 还是 Electron 持有进程职责由 #4 决定，但不能因此产生第二份文件真相。

Snapshot 至少包含：

```text
FileIndexSnapshot = {
  projectId,
  fileIndexVersion,
  entryPath,
  files: FileIndexEntry[]
}
```

`fileIndexVersion` 是对按 Project-relative Path 排序后的文件身份和 `contentHash` 做规范化计算得到的版本值；文件内容或索引路径集合改变时必须改变，单独改变 `mtime` 不要求改变。一次 scan 完成后，所有消费者只能读取同一个 `fileIndexVersion`，不得混合两个 snapshot 的 entries。

预览状态、保存的 Annotation 和 AgentRun 请求都必须携带它们实际使用的 `projectId + fileIndexVersion`。文件稳定变化后，Project 产生新的完整 snapshot；旧 Annotation 保留旧版本引用，新的预览和 AgentRun 必须显式使用新版本。消费者请求的版本不存在或已经过期时，操作失败并要求重新读取 snapshot，不能静默使用最新版本。

约束：

- File Index 的 `path` 不包含绝对路径；
- Entry Document、Manifest 和所有被解析的本地 Resource 必须能在同一份索引中找到；
- `contentHash` 用于识别内容变化；`mtime` 只作为诊断信息，不能单独作为版本身份；
- 预览、Annotation 和 AgentRun 通过同一 `path + contentHash` 视图建立上下文，不能各自重新猜测源文件；
- 索引更新后，旧的 Annotation/AgentRun 仍保留其创建时的 `path`、`contentHash`、Slide ID 和 Stable Element ID；锚点是否仍有效由后续合同判断；
- 内部过滤目录和受保护文件不能通过 File Index API 暴露给浏览器或 Agent。

一次成功的 Project scan 至少能产生如下不含绝对路径的描述：

```json
{
  "projectId": "9e0f7b25-6bb5-4a4a-9bd2-4f0d1a7a0f3f",
  "type": "html-deck",
  "entryPath": "index.html",
  "slides": [
    { "slideId": "cover", "slideIndex": 0, "label": "封面", "sourcePath": "index.html" }
  ],
  "fileIndexVersion": "sha256:..."
}
```

示例中的 UUID 和 hash 仅说明形状；实现不得把示例值当作固定值。

## 9. 失败条件与最小错误码

扫描或打开失败必须保留明确错误和触发路径，至少区分：

| 错误码 | 含义 |
| --- | --- |
| `PROJECT_ROOT_INVALID` | 选择项不存在、不是目录、是 UNC/网络路径或无法规范化。 |
| `PROJECT_PATH_ESCAPE` | 路径遍历、绝对路径、reparse point 或 canonical path 越过 Content Root。 |
| `PROJECT_PROTECTED_PATH` | 入口或 Resource 命中受保护路径。 |
| `PROJECT_MANIFEST_INVALID` | `shppt.json` 缺失字段、版本不支持、未知字段或 JSON 无法解析。 |
| `PROJECT_ENTRY_NOT_FOUND` | Manifest entry 或无 Manifest 时的根部 `index.html` 不存在。 |
| `PROJECT_ENTRY_INVALID` | 入口不是 HTML 普通文件，或入口无法解析。 |
| `DECK_NO_SLIDES` | Entry Document 没有 `[data-od-slide]`。 |
| `DECK_SLIDE_INVALID` | Slide ID 非法、重复、嵌套或 Slide 没有可渲染矩形。 |
| `DECK_SLIDE_SIZE_MISMATCH` | Slide 宽高比不一致。 |
| `DECK_ELEMENT_ID_INVALID` | `data-od-id` 非法、重复、跨 Slide 或用于不支持的位置。 |
| `PROJECT_RESOURCE_INVALID` | 本地 Resource 缺失、不可解析、远程或越界。 |
| `PROJECT_RESOURCE_DYNAMIC_UNSUPPORTED` | Slide 依赖扫描时无法确定的运行时 Resource URL。 |

这些错误不能通过回退到另一个候选入口或猜测另一个元素来消除。Project 在修复源文件并重新扫描前不得进入可编辑状态。

## 10. 验收场景

P0 至少要能重复证明以下场景：

1. 用户选择含根部 `index.html` 的最小 Project，扫描得到一个 Deck，并按文档顺序导航 Slide。
2. 用户选择含 `shppt.json` 的 Project，Daemon 使用 manifest 指定的入口；将 manifest entry 改为不存在或越界路径时，Project 失败且不回退到 `index.html`。
3. 一个 Slide 中的 `data-od-id` 元素可被索引；重复 ID、ID 跨 Slide 重复和缺少 Slide ID 都被拒绝。
4. HTML、CSS、图片和本地字体都以 Project-relative Path 进入同一 File Index；`../` 越界、symlink/junction 越界和远程资源被拒绝。
5. 同一 canonical Content Root 重新打开时复用 `projectId`，改变目录名展示信息不会改变源文件身份判断规则。
6. 浏览器和 Agent-facing 消息中没有绝对路径，Daemon 能对任何请求执行 Content Root 边界校验。
7. P0 固定示例 Project 的扫描结果包含 `projectId`、`entryPath`、Slide ID/索引、Resource 路径和 File Index 版本，后续 Annotation 可以直接引用而不重新发现入口。

## 11. 与后续合同的边界

- #4 决定 Browser/Renderer、Daemon 和 Electron 的进程边界；本合同只要求 Daemon 持有 Content Root 访问权。
- #5 使用这里定义的 Slide ID、Stable Element ID、Project-relative Path 和 File Index 建立 Annotation/iframe Bridge 消息。
- #6 在本合同的 Content Root 之外继续定义 AgentRun 的逻辑 Hard scope 和允许写入文件；任何逻辑范围都不能突破这里的物理边界。
- #7 为 `projectId`、`entryPath`、contentHash 和后续 ArtifactVersion 规定持久化与回退关联，具体见 [项目状态、持久化与 ArtifactVersion 回退合同](./project-state-artifact-version-contract.md)。
- [#8 文件监听、事件与预览刷新合同](./file-watching-events-preview-refresh-contract.md)使用同一 File Index 的路径和版本信息生成文件事件与预览刷新。
- #10 为上述验收场景提供夹具、测试和诊断证据。
