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
- `e2e/task-dashboard-panel.mjs`：真实浏览器/隔离 task store，session 目录与关系为合成响应；默认多对话列表、任务归属直达（含关闭期间在另一标签页新增的任务）、解除/改绑/归档、关联失败提示保留、读取失败为未知、旧 URL 拒绝与重新打开保留草稿、Escape/IME/焦点、关闭停止加载、三语言×浅深色390px、零共享请求/零 Agent 写请求。任务编辑/移动/归档使用真实临时 store；不替代服务端 scope/CAS/SDK 测试。

## 本轮验证结果

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
