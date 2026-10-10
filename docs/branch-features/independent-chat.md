# 独立聊天：固定隐藏工作区

## 09显式共享更新（resolved）

已有关联无项目聊天同样只提醒，不自动追版；用户明确接收只保存pending，原普通Send在完整idle/queue结束后采用，固定cwd与普通权限/工具/exact-system合同不变。跨刷新选择持久，child只继承native历史不copy source pending/read。[09合同](task-context-updates.md)记录v6迁移、成功SDK input/response与actual Provider捕获的事实区别；09源green不替父验收。

## 目的与范围

无需选择项目即可直接对话；跨天、刷新和重启后，所有独立聊天仍属于同一个聊天列表。不为每天建立新目录，不迁移或识别旧 `~/pi-cwd-*` 会话。

独立聊天复用 Pi 的会话存储、模型选择、SSE、分支和导出，不是新的聊天引擎，也不是通用文件系统沙箱。它本质上就是“没有指定项目”的普通会话：权限、工具、扩展、技能与系统提示与项目会话一致，仅 cwd 固定为保留工作区。`demo/` 未同步本功能。

## 入口与默认值

- 首次打开没有 `session`、`cwd` 或标签页记忆的首页，直接打开独立聊天 composer。显式 URL 和标签页记忆仍优先。
- 侧栏不再有独立的“新建聊天”入口。进入独立聊天的方式是在空白新会话顶部的“会话项目”选择器里选“无项目”（见[空白新会话项目选择](new-session-project.md)）：picker 请求 `POST /api/default-cwd`，再以返回的保留 cwd 与 `pi-web:chat` 身份切换。此入口不要求当前项目，打开空白 composer，不恢复停放的旧草稿；项目会话继续在后台运行。
- 空白聊天使用 `?chat=1`，打开已有聊天使用普通 `?session=…`。`/new` 在聊天里保持聊天身份。
- `POST /api/default-cwd` 现在幂等创建 `<agent-dir>/chat-workspace`，默认 `~/.pi/agent/chat-workspace`。尊重 `PI_CODING_AGENT_DIR`；不使用日期或 `process.cwd()` 决定目录。

## 行为要求与不变量

1. **稳定身份。** 服务端仅把与保留工作区完整路径相等的 cwd 识别为聊天，使用既有 `samePath` 平台路径比较；同 basename 的普通项目、子目录和旧日期目录不能误识别。返回 `sessionKind: "chat"` 与稳定 key `pi-web:chat`。
2. **持久化。** 身份依赖原生 JSONL header 的 cwd；空工具选择按现有 `pi-web:tool-selection` entry 持久化。无需另一个易失步的身份文件或浏览器目录名猜测。会话仍保存在 Pi 原有 sessions 目录中，而不是聊天工作区里。
3. **列表统一。** 聊天工作区像普通项目一样参与 `getRecentProjects`、项目分组与搜索，并应用五条会话预览限制；但侧栏、项目 picker 与搜索把它显示为本地化“对话”，不暴露 `<agent-dir>/chat-workspace` 内部路径。current 模式只列当前工作区，all 模式按最近活动排序。
4. **界面一致。** 聊天会话与项目会话共用同一套 UI：Explorer、项目/worktree 控件、项目详情、项目信任提示、空白新会话 picker 与工具预设控件都照常渲染且可编辑；picker 在聊天下以“无项目”为当前项。聊天工作区不是 Git 仓库时，worktree 控件自然按非 Git 规则呈现。
5. **权限一致。** 独立聊天是“没有指定项目”的普通会话：工具、shell、扩展、技能、prompt templates、主题、系统提示以及项目 `.pi/settings.json` 的加载规则与普通会话完全相同，不因聊天工作区而收窄。唯一的差异是 cwd 固定为保留工作区。
6. **服务端不设额外限制。** 创建、重开和 reload 都走普通会话路径；API 不因聊天 cwd 拒绝工具或 shell。身份（`sessionKind: "chat"`、`pi-web:chat`）只用于显示与分组，不改变资源策略。普通会话自身的 Chat-only 预设仍是通用行为。
7. **恢复与失败。** 标签页记忆中的聊天 composer cwd 经服务端验证后重新识别为聊天；`?chat=1` 压过旧标签页会话。工作区创建失败显示错误，不悄悄回退到一个项目。延迟的首页初始化响应必须被显式导航失效。
8. **懒启动。** 创建目录/打开 composer 不创建 AgentSession 或 JSONL；运行时仍在首次需要时启动。全局模型和 thinking 的现有选择/持久化规则不变。

## 实现地图

| 文件 | 职责 |
|---|---|
| [chat-workspace.ts](../../lib/chat-workspace.ts)、[session-kind.ts](../../lib/session-kind.ts) | 固定 cwd、服务端精确识别、浏览器安全 key |
| [default-cwd](../../app/api/default-cwd/route.ts)、[cwd/validate](../../app/api/cwd/validate/route.ts) | 幂等目录创建、已有路径恢复及身份返回 |
| [rpc-manager.ts](../../lib/rpc-manager.ts)、[models route](../../app/api/models/route.ts) | 普通会话资源策略；聊天仅沿用保留 cwd |
| [session-reader.ts](../../lib/session-reader.ts) | summary、详情、持久化会话列表的服务端身份；跳过聊天目录 Git 解析 |
| [AppShell.tsx](../../components/AppShell.tsx)、[initial-navigation.ts](../../lib/initial-navigation.ts) | 首页、chat URL、导航失效、草稿与项目面板切换 |
| [SessionSidebar.tsx](../../components/SessionSidebar.tsx)、[SessionSearch.tsx](../../components/SessionSearch.tsx) | 聊天历史、“对话”显示、标准侧栏控件一致 |
| [ChatWindow.tsx](../../components/ChatWindow.tsx)、[useAgentSession.ts](../../hooks/useAgentSession.ts) | 普通工具预设、临时会话身份、聊天下 picker 选中“无项目” |
| [project-groups.ts](../../lib/project-groups.ts)、[sidebar-project-rows.ts](../../lib/sidebar-project-rows.ts)、[workspace-memory.ts](../../lib/workspace-memory.ts) | 聊天作为普通项目分组、稳定恢复 key、“对话”显示 |

## 自动化验收

```sh
node --experimental-strip-types --test lib/independent-chat.test.mjs lib/chat-only.test.mjs lib/initial-navigation.test.mjs lib/project-groups.test.mjs lib/sidebar-project-rows.test.mjs lib/rpc-manager.test.mjs hooks/useAgentSession.test.mjs components/AppShell.tab-session.test.mjs components/AppShell.workspace-memory.test.mjs components/ChatInput.new-session.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```

`independent-chat.test.mjs` 的纯函数测试覆盖完整路径识别、跨日期统一列表、聊天 URL、“对话”分组，并断言运行时不再包含 Chat-only 限制；真实 SDK 测试在临时 agent-dir 中创建目录、创建会话、写入合成消息形成 JSONL、重开，并验证默认工具存在、自定义工具选择被接受且持久化。**不调用真实 provider**。

使用已运行的本 checkout 开发服务和已安装的 Playwright Chromium（也可 `E2E_BROWSER_CHANNEL=chrome`）：

```sh
E2E_BASE_URL=http://127.0.0.1:30141 node e2e/independent-chat.mjs
E2E_BASE_URL=http://127.0.0.1:30141 node e2e/new-session-project.mjs
E2E_BASE_URL=http://127.0.0.1:30141 node e2e/sidebar-view.mjs
PI_WEB_TEST_URL=http://127.0.0.1:30141 node e2e/session-keyboard.mjs
```

独立聊天脚本用真实浏览器和拦截 API fixture 验证首页、跨日期历史、会话与 composer 刷新、all 模式聊天作为普通项目、“对话”标签、项目往返以及界面一致（Explorer、picker、常规工具控件）。独立脚本未接入 `npm run test:e2e`。

### 原视频模式验证（F40，01–09 已 review / resolved）

`node e2e/video-modes.mjs` 在临时 agentDir/设置与合成媒体中执行实际 default-cwd/new/existing-agent/history/upload handlers → SDK → 原生 Google 最终 fetch，覆盖项目/无项目 × 普通/Chat-only，桌面新发与移动已有续问。无项目仍只使用本功能的固定 `chat-workspace`；普通资源、权限和选定模型不因视频改变。Chat-only 的零工具/精确 context 系统提示保持；越界/链接拒绝、有效视频切不支持模型时保留文字/PNG、切回显式续问与默认/配置字节不变均另有断言。它不是新的目录/权限实现，也不是生产 Next/AppShell 整页或真实网关验收；08已独立resolved。09重跑这些40场景三轮通过，并完成有界压缩/分支/队列Stop组合与项目普通模式的真实MP4/AVI各一次付费200；真实结果不扩展为无项目/Chat-only网络验收。本功能目录/权限/设置行为未改，01–09均已独立review/resolved，详见 [F40](video-attachments.md) 与[公开验收摘要](video-attachments-acceptance.md)，旧claimed为历史时点。

## 手工验收与限制

1. 在全新浏览器标签页访问 `/`，应直接看到输入框和聊天历史，不要求选项目；无需发送就可刷新保持 `?chat=1`。
2. 创建两段独立聊天，隔天或重启服务后，两段仍在同一个“对话”列表；底层目录不变化。
3. 在项目中新建会话，在“会话项目”选择器里选“无项目”，应打开空白对话，且界面与项目会话一致（Explorer/worktree/工具控件都在）。
4. 切到 all 模式，聊天与普通项目一样应用五条预览；侧栏与 picker 显示“对话”而非内部路径；展开后七段全部可达。
5. 打开 System 面板并 reload：聊天的工具、扩展、技能、指令与普通会话一致，不再强制为空或 Chat only。

未做真实 provider 首次发送、真实操作系统跨日/进程重启、移动端触屏专项验收；上述持久化和 reload 已由临时文件系统/SDK 与浏览器 fixture 分层验证。更改 agent-dir 是配置迁移，会改变保留 cwd；本功能不自动搬迁旧 agent-dir 的历史。

## 任务看板往返（票据 01）

空白无项目 composer 经侧栏进入 [任务看板](task-dashboard.md) 后，回到聊天或浏览器后退，
复用原标签页 cwd/聊天身份与内存 parked draft 恢复文字及图片；再次后退/前进离开聊天到
`/tasks` 时，AppShell 的 layout cleanup 重新停放，覆盖 `back tasks → back 原 chat` 和
`back tasks → forward chat`，统一覆盖 Link/history。Link 点击不提前停放，只有真正
layout departure 保存最终快照；路由尚未完成时用户修改文字、清空或删图，不会重复合并
或复活旧内容。不创建 session 或发送消息。
返回标记仅匹配原 cwd，显式 URL、普通新建与 picker 切项目仍优先；刷新后只恢复导航身份，
不承诺草稿存活。浏览器回归：`E2E_BASE_URL=<checkout dev> node e2e/task-dashboard-drafts.mjs`，
全 API fixture、两条 history 离开路线各三轮、最新文字/图片数量与字节/cwd 和零 Agent
请求；普通导航仍按原 hook 弃用清理，不全局保留废弃草稿。

## 已有聊天关联任务（04主claimed，待复审/父验收）

已选聊天通过侧栏原生Link `/tasks?sourceSession=<id>` 创建无项目任务，精确chat-workspace身份
由服务端判断；无项目任务只关联同身份未归属聊天，普通同basename目录不得混入。原session cwd、
JSONL、工具、模型、权限不变，不强制Chat-only；关联/目录/GET running快照不ensure/start/MCP/model。
回聊天使用原 `/?session=<id>`，保持原未发草稿和01departure/history/慢导航合同。空白composer无来源入口。
主fresh SDK/Git/浏览器/联合迁移及平台缺口见[task-dashboard](task-dashboard.md)与/tmp/m04-MOJzzo/REPORT.md。

## 复制已关联独立聊天（11主集成并已父验收resolved）

原fork/clone/引用branch-copy形成新session后继承来源无项目task，仍使用精确保留cwd和普通资源/权限；
普通New与未归属source不推断task，同session树导航不增count。不改变SDK复制的历史或采用06latest，
也不自动prompt或为了保存关系停止source。异常2xx显示error且保留同UUID，未知prepared保持拒绝；所有入口都给出先检查列表、再手动打开无opener空tab显式新尝试的流程及重复/孤儿风险，不自动换ID或删receipt。范围/CAS/失败精确重试及08采用交点见[11合同](task-session-copy.md)。

## 08无项目任务准备（主已验收resolved）

[08合同](task-start-chat.md)沿固定chat-workspace和普通资源权限准备新/继续chat，不ensure/prompt或替换草稿。
原Send才绑定真实UUID/选定snapshot；Chat-only仍为显式通用预设，exact-system不改，未flush预设重建保持prepared UUID。
Continue不追current；11 child仅展示继承原生历史及原版本/来源，不复制source selection/read receipt。
真正busy同cwd先拒，用户确认风险后可并行，不承诺隔离/worktree。保留01departure/history/慢路由末次草稿和普通New优先。

## v0.10.0 整合说明

继续以固定聊天工作区替代上游 `~/pi-cwd/YYYYMMDD` 快捷入口；`POST /api/default-cwd` 创建后直接将该工作区加入文件授权范围。自定义项目路径仍使用原 `/api/cwd/validate` 流程。删除会话的异步回调使用 `selectedSessionRef.current` 的最新会话身份决定是否导航及是否使用 `?chat=1`，不能回读删除开始时捕获的旧会话。

## Rebase 与维护

- 保留服务端识别及原生 cwd 持久化，不按 basename 或日期猜聊天。
- 首页默认变化不能覆盖显式 URL、标签页恢复或新导航；不要恢复成自动打开最近项目。
- UI 或服务端不得重新收窄聊天运行时资源；工具、shell、扩展、设置加载必须与普通会话一致。
- 侧栏/picker/搜索显示本地化“对话”并隐藏 `<agent-dir>/chat-workspace` 内部路径。
- 与[全部项目侧栏](all-projects-sidebar.md)、[项目预览](project-session-previews.md)、[新会话项目选择](new-session-project.md)、[`/new`](new-session-command.md)及 [Chat-only ADR](../adr/0002-chat-only-tool-selection.md)同步维护。
