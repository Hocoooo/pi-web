# 当前分支功能契约与验收索引

## 必须先读：Agent 工作规则

**每次开发迭代开始前，必须先阅读本 README，再阅读本次涉及的功能文档及其关联功能文档。** 适用于新增、修改、修复、重构、测试调整，以及 merge/rebase 冲突处理；不能等修改完成后才补读。

**每次修改功能，都必须在同一次变更中更新对应文档。** 修改行为、入口、默认值、配置/API、错误处理、依赖关系、实现位置或验收方法时，同步对应章节；新增功能必须新增文档并加入本索引。即使对外行为不变，也要检查实现地图和测试命令是否过期，并在任务总结说明文档是否需要调整及原因。

这里是本分支的**行为契约、代码导航和验收入口**，不是发布日志，也不是只记录“有哪些文件”的清单。Agent 不应从旧提交标题猜测当前行为，更不能把一次自动合并成功当作功能仍然完整的证明。

## 范围与基线

- 初始盘点分支：`personal/customizations`。
- 初始实现基线：`63c6e4e`，上游基线 `origin/main` 的 `96966e5`（v0.9.3）。这两个 hash 是本轮盘点的固定依据，**不是永远指向最新实现的别名**。
- 当时版本：`0.9.3-personal.6`；18 个个人提交重放后，另有一笔整合修复。
- 本目录按**独立能力**而非按 commit 拆分：相关后续修复、版本维护和工作流说明归入对应功能。一次提交可能涉及多个功能，一项功能也可能跨多个提交。
- 首批覆盖当前分支相对上游的定制能力；不重复为上游几百个已有功能建档。上游交互边界写入每份功能文档，整体架构仍见根 [AGENTS.md](../../AGENTS.md) 和 [项目 README](../../README.md)。
- 后续在本分支引入的新能力也应登记；定制被上游等价吸收时，更新实现与验收依据，不可仅因 diff 消失便删除保护性说明。
- `demo/` 是上游静态演示实现，本轮文档描述主应用，不承诺定制功能已同步到演示站点。

## 功能索引

| ID | 功能文档 | 解决的问题 / 核心约束 | 主要改动入口 |
|---|---|---|---|
| F01 | [Headless RPC 会话](headless-rpc.md) | 无 UI 场景使用 SDK 的后台工作 draining；不改变正常 Web 会话 UI | agent/new、rpc-manager |
| F02 | [模型与思考等级两步选择](model-thinking-picker.md) | 浏览不写设置，确认后联合提交；首次发送保留有效模型/等级，不重复重置默认值 | ChatInput、ModelPicker、useAgentSession、RPC |
| F03 | [全部项目侧栏视图](all-projects-sidebar.md) | 可选聚合、独立折叠、持久化与项目身份一致 | SessionSidebar、SettingsPanel、sidebar-view-preference |
| F04 | [项目会话预览数量](project-session-previews.md) | 全部项目视图默认显示有限根会话，可展开更多，不破坏层级 | sidebar-project-rows、SessionSidebar |
| F05 | [空白会话项目选择](new-session-project.md) | 显式选择新会话 cwd，同时保留草稿和空白导航语义 | NewSessionProjectPicker、AppShell |
| F06 | [侧栏键盘导航与面板切换](sidebar-keyboard-navigation.md) | Alt+左右切换面板，虚拟化列表可键盘到达，删除需确认 | useKeyboardShortcuts、sidebar-keyboard、SessionSidebar |
| F07 | [复制会话 ID](session-id-copy.md) | 从会话菜单获得真实 ID，而非标题、文件路径或 entry ID | SessionSidebar |
| F08 | [输入框与消息区焦点导航](chat-focus-navigation.md) | Alt+上下切换且不跳阅读位置；空白会话加载后聚焦 | ChatInput、ChatWindow、CSS |
| F09 | [`/new` 空白会话命令](new-session-command.md) | 当前 cwd 新建空白 composer，不发送命令、不带附图、不打断原会话 | ChatInput、ChatWindow、AppShell |
| F10 | [下一轮提示词建议](next-prompt-suggestions.md) | 可配置独立建议请求；Tab 只采纳草稿，绝不自动发送 | next-cue 路由、ChatWindow、ChatInput、SettingsPanel |
| F11 | [桌面文件操作与 Explorer 复用](desktop-file-actions.md) | 浏览/复制/系统打开文件，授权边界与 Windows 标签页复用 | LocalFileLink、desktop-files、windows-explorer、desktop API |
| F12 | [开发服务输出断管保护](dev-stdio-guard.md) | 仅忽略 stdout/stderr EPIPE，避免日志递归，不吞其他错误 | bin/stdio-guard、package scripts |
| F13 | [按需 Jev 委派建议](delegation-advice.md) | 有真实取舍时提供 advisory-only 建议，不替用户授权或自动启动子代理 | subagent-advice、subagent-extension |
| F14 | [本地全局安装与个人版本维护](local-global-install.md) | 安全构建 tarball、核验、全局安装与可选服务切换；不发布 npm | .pi/skills/pi-web-local-global-install |
| F15 | [开发环境 Service Worker 清理](dev-service-worker-cleanup.md) | 非生产模式注销遗留 worker、清理 pi-web 缓存，同时保留主题恢复与生产 PWA | PwaRegistration、theme 初始化脚本 |
| F16 | [Windows 无窗口启动链](windows-silent-start.md) | 隐藏 Next 与浏览器辅助控制台，保留日志和生命周期；区分无窗口与 no-open | bin/pi-web、安装器 launch |
| F17 | [消息与会话性能统计](message-performance.md) | 服务端首有效输出 TTFT、持久化 tok/s、会话加权速度与平均 TTFT；缺失样本不补零 | request-performance、session-stats、MessageView、AppShell |
| F18 | [输入时草稿补全](draft-completion.md) | 默认关闭；独立模型续写未发送草稿，Tab 只采纳；新/休眠会话不启动 AgentSession | draft-completion API、useDraftCompletion、ChatInput、SettingsPanel |

## 交互原型（不代表生产功能）

| 文档 | 验证问题 | 入口 |
|---|---|---|
| [输入时补全原型](draft-completion-prototype.md) | 末尾灰字续写、Tab 仅采纳、IME 与过期响应；仅本地模拟，不接入聊天或真实模型 | components/prototypes/draft-completion.prototype.html |

## 跨功能的约束：先核对这些交点

### 键盘优先级

- `Alt+← / Alt+→`：侧栏与 composer；见 F06。
- `Alt+↑ / Alt+↓`：composer 与消息容器；见 F08。
- `Tab`：保留输入补全和可采纳建议语义，不能恢复成旧的聊天区跳转键；见 F02/F08/F10/F18。
- 模型选择器的上下左右与 Enter/Escape 是自己的局部交互。IME、弹窗、输入补全和子控件优先级必须逐场景验证，不能用一个全局 handler 吞掉所有按键。

### 会话、项目与草稿

- F03/F04 是浏览视图；F05 是新会话的运行目录选择。当前显示会话、侧栏选中项目和空白 composer 的 cwd 不一定相同。
- F09 的 `/new` 沿用当前显示会话 cwd，并刻意不恢复 parked draft；F05 切换空白会话目录时要迁移已有草稿。两者不能复用一个“全部清空”的捷径。
- 保留上游按浏览器标签页恢复会话、URL 导航、项目/worktree 归属与阅读位置恢复；显式用户导航必须压过陈旧异步恢复。

### 运行时与外部副作用

- F02 改主会话设置；F10 的建议模型选择不改主会话；F13 的建议不授权执行子代理。
- F01 的 headless 模式不能误删正常 Web 会话的扩展 UI。
- F11 必须经过文件授权，不因“本地部署”而放开任意文件系统路径。
- F18 会上传未发送草稿，必须独立 opt-in，不能继承 F10 开关；仅使用独立推理，不创建主会话运行时。
- F10/F13/F18 可能产生外部推理请求；F11 可启动桌面程序；F14 可影响全局安装与服务。文档验收不能默认授权在用户真实环境执行这些副作用。

## 开发与文档同步流程

1. **开始前**：读本 README，根据索引选功能文档；跨上述交点时读双方。确认当前分支、工作区改动与真实实现，不能假定基线 hash 仍是当前 HEAD。
2. **明确变化**：区分要保持的现状、用户明确要求的新行为、发现的 bug。用户新要求可以改变旧契约，但要显式更新文档，不能用旧文档阻止合理产品变化。
3. **定位证据**：沿文档到实现与测试，核对默认值、边界、配置、安全条件。文档与代码冲突时记录差异，结合用户目标修正；不要悄悄选一方并把矛盾留给下一位 Agent。
4. **实现和验收**：改代码与相应测试，执行适用验收。把 source-contract、mock 单测、浏览器组件测试、服务 E2E、真实系统/外部 provider 联调分开报告。
5. **同步文档**：更新功能要求、实现地图、命令、人工用例、已知限制和 rebase 清单；入口或跨功能行为变化时也更新本 README。删除/合并功能须写清替代关系，并修复所有链接。
6. **收尾检查**：文档与行为一致、相对链接存在、命令可定位到真实测试、无过期默认值。报告验证结果和未验证部分；不能将没跑的命令写成“通过”。

文档优先记录稳定的行为和符号名，避免用易漂移的行号定位。保留足以说明“为什么不能删”的上下文，但不要复制整段实现代码、整个 API schema 或整个安装脚本作为第二份源码。

## Rebase / Merge 专用检查

### 合并前

- 保护未提交/未跟踪内容并建立分支备份，确认新的上游提交范围。
- 对照功能索引建立受影响清单；用 `git log`、`git diff`、`git range-diff` 辅助追踪，不能以当前 `origin/main..HEAD` 的提交标题替代文档。
- 高交叉文件：`ChatInput.tsx`、`ChatWindow.tsx`、`SessionSidebar.tsx`、`SettingsPanel.tsx`、`useAgentSession.ts`、`rpc-manager.ts`、消息/Markdown 展示和 package manifests。

### 解决冲突时

- 保留双方意图，特别是上游安全修复、SSE 生命周期、SDK 能力/默认值、虚拟列表性能、文件链接 PDF page 语义。
- 不为减少冲突整文件覆盖；自动合并成功的 runtime/键盘/状态逻辑也要检查语义。
- 版本、依赖和 lockfile 一起更新；个人版本后缀属于 F14，不能直接把旧上游依赖覆盖回去。

### 合并后

- 逐项核对文档的 rebase 清单；按风险运行测试，而不仅是 typecheck。
- 更新发生变化的功能文档与验收命令。若上游实现了等价功能，记录替换依据和仍需保留的回归。
- 已有失败可在 pristine 上游对照复现，但这只说明并非本次新增回归，**不等于测试已通过或功能安全可用**。

## 公共验证入口与边界

从仓库根目录执行（完整开发依赖已安装）：

```bash
node node_modules/typescript/bin/tsc --noEmit
npm run lint
npm test
```

- 各功能文档列出更小范围的单测和浏览器命令，先运行受影响部分，再扩大范围。
- `npm run test:e2e` 自建临时 agent 数据和独立 dev 服务。只在没有同 checkout dev 服务的工作区执行，详见 [e2e/README.md](../../e2e/README.md)。需安装 Playwright 浏览器。
- 不要在正在开发的 checkout 运行 `next build`，不要为同一 checkout 换端口绕开 `.next/dev/lock`；遵循根 AGENTS 的服务排查规则。
- 桌面操作、真实模型、Windows Explorer、全局安装的验收必须先检查环境和用户授权；测试提示不构成执行授权。

### 基线历史验证记录（不是本次或未来验证结果）

在 `63c6e4e` 整合任务中曾完成类型检查、重点回归和桌面/移动浏览器检查。全量单测当时为 **1,446 项：1,435 通过、6 失败、5 跳过**；6 项在相同 Windows 环境的 pristine 上游也能复现（符号链接权限、路径预期、native PTY）。

这些数字仅帮助理解遗留验证边界，不是跳过未来测试的许可。已知失败的环境、复现步骤和是否已修复应按后续任务更新，不能永久把所有 Windows 失败归为“环境原因”。

## 新功能文档模板

新增文档至少包含以下结构：

1. **标题与核对基线**：功能名、固定提交/版本或更新日期；不要把旧基线称为当前最新。
2. **目的与范围**：用户价值、负责什么、不负责什么。
3. **入口与默认值**：UI/命令/API、开关、配置位置、持久化 schema 和默认行为。
4. **编号行为要求**：成功路径、错误/忙碌/取消、权限、数据不变量、平台差异和交互优先级。
5. **实现导航**：相对文件链接、关键符号与职责，避免整份源码粘贴。
6. **自动验收**：从仓库根目录可执行的命令、环境前置、实际覆盖及没覆盖的边界。
7. **人工验收**：前置条件 → 操作 → 可观察预期，包含至少一条负面/边界场景；标明会产生费用或外部副作用的步骤。
8. **Rebase 清单**：易冲突文件、上游交点、不能丢的行为及替换条件。
9. **已知限制/待验收项**：明确区分事实、待实现目标与尚未验证的能力。
10. **维护要求**：修改功能时同步文档、测试与本索引；链接关联功能。

本目录不保存 API key、用户会话正文、真实凭证、私有路径数据或完整运行日志。需要说明安全行为时使用测试数据和脱敏示例。
