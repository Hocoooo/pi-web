# 任务 session 管理：当前回归与历史测试

## 当前测试契约

依据 [F31](../branch-features/task-session-management.md)，任务用于组织 session，归档/关联不控制聊天执行，共享重点的新生成、发布、准备和投递都已暂停。

当前自动回归仍使用 `*.test.mjs`。测试不通过不能通过启用生产后门来解决；需要旧共享数据时直接构造隔离的历史存储 fixture，再从正常读取/管理接口检查兼容性。新的拒绝测试要求在存储迁移、wrapper 启动、模型调用及 native history 写入之前拒绝旧请求。

主要入口：

- `lib/task-management.test.mjs`：旧数据保留、归属 metadata、归档/关联与运行解耦、旧 pending 不投递、taskStart 拒绝、损坏任务库不阻断普通聊天。
- `app/api/agent/task-management.test.mjs`：新建/已有 session 的旧 taskStart 请求在 startup、ensure_session 和权限变更前拒绝。
- `app/api/tasks/{context,summary,sessions}.test.mjs`：共享入口关闭、归属读取与关联接口。
- 其余 `lib/task*.test.mjs`：当前保留的资料、顺序、列、视图、关系、复制、迁移和历史损坏保护。包含旧上下文的 fixture 不代表重新开放共享功能。
- `components/AppShell*.test.mjs`、`components/ChatWindow*.test.mjs`、`components/TaskDashboard.navigation.test.mjs`、`lib/i18n/*.test.mjs`：导航、草稿、删除后新 composer、三语言及其既有回归；任务直达只消费最新读取的结果，失败可重试、缺失目标明确提示、普通 mutation 失败不被自动刷新抹掉。当前合计 79 项通过。
- `e2e/task-dashboard-panel.mjs`：真实浏览器/隔离 task store，session 目录与关系为合成响应；默认多对话列表、任务归属直达（含关闭期间在另一标签页新增的任务）、详情仅“移除”菜单（键盘/IME/Escape/Tab/点外部/隐藏后关闭/失败与丢响应精确重试/窄屏主题）、解除/归档、关联失败提示保留、读取失败为未知、旧 URL 拒绝与重新打开保留草稿、Escape/IME/焦点、关闭停止加载、三语言×浅深色390px、零共享请求/零 Agent 写请求。任务编辑/移动/归档使用真实临时 store；不替代服务端 scope/CAS/SDK 测试。

## 缺失对话移除回归

删除原生 session 后，任务仍保留关系并显示缺失；详情菜单现在允许显式移除，不自动清理或重建 session。缺失行返回真实 generation/updateRevision，只有解除到 null 放宽存在性要求，改绑仍拒绝；owner/CAS/operationId 精确重试和历史保留不变。

- `app/api/tasks/sessions.test.mjs`：真实 HTTP route/store 与隔离 SDK session，非零 generation、缺失行版本、错误 owner/过期版本拒绝、禁止改绑、成功解除、丢响应重试及不重建 JSONL。
- `lib/task-relations.test.mjs`：含旧共享记录的缺失会话，非零 updateRevision 的过期请求拒绝、清理 pending 但保留 choices/deliveries/sessionContexts/sharedContext，fresh-process 精确重试。
- `e2e/task-dashboard-panel.mjs`：缺失行无打开链接、移除菜单可用、nonzero generation/updateRevision 写入与丢响应精确重试；保留原键盘/IME/焦点/草稿/三语言/两主题回归。

本次实际验证：任务/API/客户端 **196/196 通过**（隔离 HOME/TMPDIR/agent）；上述 panel 浏览器回归通过，task-card **8 场景通过**；`tsc --noEmit --incremental false`、7 个改动 TS/TSX/MJS 文件的 ESLint 和 `git diff --check` 通过。HTTP 与菜单均先复现失败再修复；缺失行版本亦先红后绿。浏览器复用健康 checkout 30142 开发服务，全 API fixture/临时 task store，零 Agent 写请求。未执行全仓测试、生产 build/install、真实 provider 或 Windows/Safari/iOS 真机验证；未修改用户 session 数据。

## 详情关联对话菜单回归

当前 `...` 只打开“移除”菜单，直接解除关联，改绑入口留在聊天任务选择器。此次菜单改动验证：`e2e/task-dashboard-panel.mjs` 通过（仅一个选项、取消零写入、键盘/IME/Tab/外部点击/隐藏后关闭、移除保留详情、失败与丢响应精确重试、显式刷新建立新请求、三语言×浅深色390px）；`e2e/task-dashboard-card.mjs` 8 场景通过；关系/迁移/列交点/任务导航/i18n 定向单测 43/43 通过；`tsc --noEmit --incremental false`、改动 TS/TSX/MJS 的 ESLint 与 `git diff --check` 通过。浏览器沿用既有 30142 开发服务、API fixture 和隔离临时 store，零 Agent 写请求，不改用户 session。

回归实现注意：Tab 关闭菜单前先把焦点还给触发按钮，否则移除聚焦的 menuitem 会让焦点掉到 body；合成关系响应必须像真实服务一样推进 task revision，才能验证关联目录重读。未执行全仓测试、生产 build/install、真实 provider 或 Safari/iOS/Windows 真机验收。

## F32 `/task` 回归入口

- `app/api/tasks/picker.test.mjs`：真实 HTTP handler/store 的窄候选查询与现有关联/改绑/解除协议；cwd/session 权威范围、归档、无历史泄漏、严格字段、缺失 session 和 CAS/重试。
- `e2e/task-picker.mjs`：真实 composer/选择器，HTTP 边界外的键盘、IME/Escape、归档、失败重试及运行中不发送消息。
- `e2e/task-session-selection.mjs`：真实 useAgentSession/composer + HTTP/SSE fixture，预选、提前创建、失败草稿恢复和 ID 复用、普通聊天零任务读取、在途初始关联期间改选、失败后换目标（含丢失响应）、bash 重试落实归属。
- `e2e/task-picker-page.mjs`：复用 checkout dev 的完整页面，所有 API 截获，桌面/390px 上 `/task` 与归属按钮、不继承预选的 `/new`、已有 session 改绑、草稿/焦点保留，零任务面板/Agent 写请求。
- `e2e/task-dashboard-panel.mjs`：原详情直达测试改走独立“任务详情”按钮；原面板关联、三语言/两主题与草稿等回归保留。

新增测试遵循用户确认的 UI、HTTP API、生命周期三类公开边界，未添加源码字符串断言。此次 F32 验证：相关 ChatInput/ChatWindow/AppShell/hooks/tasks API/relations/management/i18n 合并 **258/258 通过**；任务生命周期 **11 场景通过**；选择器组件、全页面桌面/390px、原任务面板三语言/两主题、settings-commands/model-flow/model-first-prompt 浏览器脚本通过；`tsc --noEmit`、改动 TS/TSX/MJS 的 ESLint、`git diff --check` 通过。独立复核发现的失败后换目标重放旧请求与 bash 重试绕过关联已 red→green 修复并复核关闭。不沿用下面 F31 历史绿色记录为 F32 证明，也不代表全仓测试或真实 provider/全平台验收。

## F32 简洁 UI 复核

选择器与现有模型选择器统一主题/字号/边框，正常状态移除恢复按钮；归属栏单行化，长预选说明移入弹窗；详情会话列表去掉嵌套卡片和重复摘要，关联政策按需展开，空资料不生成占位段。补充 built-in `statusKey` 的 HTTP/UI 验证，确保内置列可翻译、同名自定义列仍保持原文。

本次相关 ChatInput/ChatWindow/AppShell/TaskDashboard 导航/hooks/tasks API/relations/management/i18n **263/263 通过**；生命周期 **11 场景通过**；选择器、全页面 1200px/390px（触屏模拟）×浅深色、长名称/缩小视口、三语言/两主题任务面板回归通过。独立复核的慢保存焦点逃逸已用“选中 → 点击标题 → Tab/Shift+Tab → Escape”失败测试复现并修复、复核关闭。设置命令/模型选择器回归、`tsc --noEmit`、全部改动 TS/TSX/MJS 的 ESLint、`git diff --check` 通过。页面截图可用 `TASK_UI_ARTIFACT_DIR=/tmp/task-ui node e2e/task-picker-page.mjs` 生成；组件脚本显式加载 CSS module。

未执行生产 build/install、真实 provider 调用、Windows/Safari/iOS 真机或全仓测试；触屏/缩小视口模拟不等于真实软件键盘验收。

## F31 历史验证结果

- 活动任务/API/RPC：**206/206 通过，0 失败、0 取消、0 跳过**。隔离 HOME/TMPDIR/agent，阻断外部网络，`--test-concurrency=4 --test-timeout=60000`；运行 `lib/task*.test.mjs app/api/tasks/*.test.mjs app/api/agent/task-management.test.mjs lib/rpc-manager.test.mjs`。覆盖保留的 50,000-task 有界删列 HTTP 检查，但不宣称 UI 极端容量性能。
- AppShell/ChatWindow/TaskDashboard 导航/i18n：**79/79 通过**。
- `e2e/task-dashboard-panel.mjs`：通过；API fixture 模式、三语言×两主题390px、桌面与焦点/草稿/跨标签页/错误恢复场景。
- `tsc --noEmit`、全部改动/新增 TS/TSX/MJS 文件 ESLint（54 个文件）、`git diff --check`：通过。
- 独立代码复核发现的跨标签页旧 board 直达问题、普通 mutation 错误被刷新清除问题均已修复并补测试；复核确认关闭。
- **未运行全仓 `npm test`**；不将定向通过扩大为整仓、真实 provider 或全平台验收。

## 明确退役的执行测试

下列原 `*.test.mjs` 已改名为 `*.historical.mjs`，保留原文、原相对导入及失败诊断场景，**不属于当前默认回归，也不应在当前暂停模式下宣称运行通过**。它们断言的共享执行流程已被用户要求暂停，不是被忽略的当前功能故障。需要重现旧行为时，应在旧提交 `67571bf` 对照运行原版本，而不是在当前分支加绕过开关。

| 历史文件（`lib/`） | 退役内容 |
| --- | --- |
| `task-start.historical.mjs` | 从任务准备并注入共享材料的执行流程 |
| `task-start-copy.historical.mjs` | 任务准备材料与复制后的采用/注入接缝 |
| `task-context-updates.historical.mjs` | 新共享更新选择、投递及证据登记 |
| `task-context-update-archive.historical.mjs` | 归档禁止更新投递的旧执行策略 |
| `task-context-update-conversion.historical.mjs` | 新投递的 SDK 输入/响应观察器 |
| `task-context-update-review.historical.mjs` | 共享投递的重试/投影/观察逻辑 |
| `task-summary.historical.mjs` | 主动 AI 整理执行 |
| `task-summary-integration.historical.mjs` | AI 整理来源与生成发布链 |
| `task-summary-rejection.historical.mjs` | AI 整理 Promise/失败执行链 |
| `task-summary-review.historical.mjs` | AI 整理输入审核与生成边界 |

仍有效的历史数据、不可变版本/receipt、迁移、损坏拒读、owner/generation 和复制 scope 检查必须保留在当前 `*.test.mjs`，不能因为原 fixture 通过暂停接口创建而整套移走。旧特性文档内的原测试命令是历史记录；本文件和 F31 指明当前验证入口。

## 浏览器记录与限制

本轮复用 checkout 的既有开发服务 `http://127.0.0.1:30142`，不重启 30141 的全局安装版、不启动第二个 checkout dev、不运行 build。所有浏览器 `/api/**` 请求被 fixture 截获。新 panel 回归通过，输出 `/tmp/task-panel-*/` 截图。原 `e2e/task-dashboard-ui.mjs` 及其他共享/启动专项 E2E 仍描述旧产品行为，不列入 F31 当前验收。

每次执行用全新的 Git 树外 HOME/TMPDIR/agent 数据隔离 SDK 自动发现；不加载用户凭据/扩展、不访问真实模型。最终执行数量以交付说明为准，不把历史绿色记录沿用为新模式证据。未覆盖生产打包、真实 provider/SSE、Windows/ACL、Safari/iOS 真机、断电/NFS 和极端容量性能。
