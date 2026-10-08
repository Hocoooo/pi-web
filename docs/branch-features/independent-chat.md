# 独立聊天：固定隐藏工作区

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

## 手工验收与限制

1. 在全新浏览器标签页访问 `/`，应直接看到输入框和聊天历史，不要求选项目；无需发送就可刷新保持 `?chat=1`。
2. 创建两段独立聊天，隔天或重启服务后，两段仍在同一个“对话”列表；底层目录不变化。
3. 在项目中新建会话，在“会话项目”选择器里选“无项目”，应打开空白对话，且界面与项目会话一致（Explorer/worktree/工具控件都在）。
4. 切到 all 模式，聊天与普通项目一样应用五条预览；侧栏与 picker 显示“对话”而非内部路径；展开后七段全部可达。
5. 打开 System 面板并 reload：聊天的工具、扩展、技能、指令与普通会话一致，不再强制为空或 Chat only。

未做真实 provider 首次发送、真实操作系统跨日/进程重启、移动端触屏专项验收；上述持久化和 reload 已由临时文件系统/SDK 与浏览器 fixture 分层验证。更改 agent-dir 是配置迁移，会改变保留 cwd；本功能不自动搬迁旧 agent-dir 的历史。

## v0.10.0 整合说明

继续以固定聊天工作区替代上游 `~/pi-cwd/YYYYMMDD` 快捷入口；`POST /api/default-cwd` 创建后直接将该工作区加入文件授权范围。自定义项目路径仍使用原 `/api/cwd/validate` 流程。删除会话的异步回调使用 `selectedSessionRef.current` 的最新会话身份决定是否导航及是否使用 `?chat=1`，不能回读删除开始时捕获的旧会话。

## Rebase 与维护

- 保留服务端识别及原生 cwd 持久化，不按 basename 或日期猜聊天。
- 首页默认变化不能覆盖显式 URL、标签页恢复或新导航；不要恢复成自动打开最近项目。
- UI 或服务端不得重新收窄聊天运行时资源；工具、shell、扩展、设置加载必须与普通会话一致。
- 侧栏/picker/搜索显示本地化“对话”并隐藏 `<agent-dir>/chat-workspace` 内部路径。
- 与[全部项目侧栏](all-projects-sidebar.md)、[项目预览](project-session-previews.md)、[新会话项目选择](new-session-project.md)、[`/new`](new-session-command.md)及 [Chat-only ADR](../adr/0002-chat-only-tool-selection.md)同步维护。
