# Windows 10 P0 前置条件核验

日期：2026-09-21

对应票据：[Windows 10 CLI 与渲染前置条件核验](https://github.com/1159741258/SHppt/issues/9)

## 结论

本机已经具备 P0 AgentRun 的 CLI 基础条件，但浏览器 headless 渲染仍未通过，需要在实现预览/导出前处理。Claude CLI 的 stream-json 能力可用，不过当前配置实际选择的是 `DeepSeek-V4.1-Flash`，不能把 CLI 名称当作固定模型或固定供应商的证明。

## 已确认

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 操作系统 | 通过 | Windows 10 专业版，版本 `10.0.19045`，x64 |
| PowerShell | 通过 | PowerShell `7.6.6`，Core |
| Claude CLI | 通过 | Claude Code `2.1.278`，路径为 `C:\Users\WIN\AppData\Roaming\npm\claude.ps1` |
| Claude 鉴权 | 通过 | `claude auth status` 显示 `loggedIn: true`，使用 API key；报告不保存密钥值 |
| stream-json | 通过 | 最小无工具请求返回 `OK`，`--verbose` 是 stream-json 所需参数 |
| Agent 权限模式 | 可用 | CLI 支持 `dontAsk`、`manual`、`acceptEdits`、`plan` 等模式；P0 不默认使用 bypass 权限 |
| Node.js | 通过 | Node `v24.15.0` |
| npm/npx | 通过 | npm `11.11.0`，npx 已安装 |
| 浏览器可执行文件 | 部分通过 | Chrome `153.0.8010.52`，Edge `146.0.3856.84` |
| 文件监听类型 | 通过 | `System.IO.FileSystemWatcher` 可构造 |
| 项目目录权限 | 通过 | 当前用户对仓库目录具备 FullControl |
| 常用端口 | 通过 | 观测时 `3000`、`5173`、`8787`、`9222` 均无监听 |
| Windows 字体目录 | 通过 | `C:\Windows\Fonts` 存在并可读取 |
| Electron | 未安装 | P0 不应把 Electron 作为已满足的前置条件；是否采用由运行时票据决定 |

## Stream JSON 实证

使用无工具、无会话持久化和 `dontAsk` 权限模式执行一次最小请求：

```powershell
'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly OK and do not use tools."}]}}' |
  claude -p --bare --verbose `
    --input-format stream-json `
    --output-format stream-json `
    --permission-mode dontAsk `
    --permission-prompt-tool none `
    --no-session-persistence `
    --tools ''
```

结果：返回 `assistant` 文本 `OK` 和正常 `result` 事件，工具列表为空，未写入项目文件。该次请求的 CLI 输出报告费用为 `0.001435 USD`。

需要注意：初始化事件报告模型为 `DeepSeek-V4.1-Flash`，并出现一次 `unrecognized_model` 警告，随后请求仍成功完成。AgentRun 实现必须记录实际 provider/model/capabilities，并允许能力探测结果覆盖静态默认值。

## 浏览器实证

Chrome 和 Edge 的可执行文件都存在。使用独立临时 profile、`--headless`、`--dump-dom` 和 `--screenshot` 访问内联 HTML 时，两者均以非零状态退出且没有诊断输出；本次创建的临时 profile 和截图路径已清理。

因此当前结论是：浏览器安装已确认，headless DOM/截图链路尚未确认。不能把“浏览器存在”当作 P0 预览或截图验收通过。

## 后续人工步骤

1. 在交互式 Windows 用户会话中重跑 Chrome/Edge headless DOM 和截图测试，并记录实际 stderr 或 crash 日志。
2. 如果当前运行环境禁止 headless 浏览器，选择并固定 Playwright/Puppeteer 管理的浏览器运行时，或明确使用 Electron capture 方案。
3. 为实现配置确定允许的 provider/model 集合；启动时展示并记录 CLI 实际返回的 model、provider 和能力标志。
4. 为 P0 准备一个带 Slide 边界和稳定 `data-od-id` 的最小 HTML Deck 夹具，包含本地 CSS、图片和字体资源。
5. 鉴权已在当前用户环境生效，但开发文档和 CI 仍需说明如何安全提供 API key；不得把密钥写入项目或诊断包。
6. 端口当前空闲只是一次观测结果，Daemon 应使用可探测/可配置端口并处理冲突。

## 对后续票据的输入

- [P0 技术与部署基线](https://github.com/1159741258/SHppt/issues/4)：可先按 Node + 浏览器路径设计，Electron 不是已安装依赖。
- [Claude CLI 能力、权限与 AgentRun 合同](https://github.com/1159741258/SHppt/issues/6)：必须要求 `--verbose` 配合 stream-json，并记录实际模型/供应商。
- [P0 测试、视觉质量与验收证据](https://github.com/1159741258/SHppt/issues/10)：浏览器 headless 失败是当前环境风险，不能跳过截图证据。
