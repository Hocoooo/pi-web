# 全项目侧边栏

## F38 可选 Task 层

[侧栏任务树](sidebar-task-tree.md)在既有 current/all 范围内增加项目→Task→对话，Settings 同区默认关闭；无新视图。开启后 current 保留项目选择器、下方 Task→对话，all 保留项目标题；每 Task 独立五族预览/折叠，未关联组保留。关树时本合同原有结构/项目更多状态恢复，任务检索/筛选仍可使用。所有 owner 先从完整只读目录建立，任务归档不推导对话归档；搜索选择不改变 cwd 或当前对话。无任何任务的项目即使开启设置也不增加 Task/“未关联任务”层：current 直接显示全部会话族，all 继续项目标题、五族预览与原项目更多状态；可与有任务项目混合显示。空/已归档任务仍属于项目，历史明确 owner 投影不丢。以下原有项目规则在未开启 Task 层或项目无任务时保持。

## 子目录会话导航回归

- benchmark 等通过 API 在仓库子目录创建的会话仍保留该子目录的独立项目身份；Git 返回的 worktree 列表不表示这些 worktree 属于子目录项目。
- `SessionSidebar.projectFor` 仅在缓存来源 cwd 的 `isTopLevel` 为 true 时，将其项目身份用于列表中的其他 worktree。精确 cwd 仍使用服务端身份；顶层 worktree 间的无会话目录切换保持原行为。
- 显式从子目录会话点击仓库根目录旧会话时，不得被旧 worktree 缓存触发的 `onCwdChange` 清空选择和 `?session=`。
- 回归：`node --test components/SessionSidebar.project-identity.test.mjs` 覆盖 Windows/POSIX、子目录自身身份与顶层 sibling；`E2E_BASE_URL=<当前源码服务> node e2e/sidebar-subdirectory-navigation.mjs` 用隔离 API fixtures 覆盖点击与刷新，故意延迟新 worktree 响应，不修改真实会话。

## 目的、用户价值与范围

在一个会话列表中查看多个项目及其运行/未读状态，减少反复切换项目选择器。本契约用于修改侧边栏模式、项目分组、偏好存储或 rebase 相关代码时。

个人分支新增的是可选的 `all` 模式及分组 UI；原有项目身份、worktree 归组、会话族、搜索、文件浏览器和工作区恢复仍由既有实现负责。它不是“扫描磁盘上所有目录”，也不是同时打开多个工作区。

- 项目内五条预览见[项目会话预览](project-session-previews.md)。
- 空白新会话中更换 cwd 见[新会话项目选择](new-session-project.md)。项目标题不是该选择器。
- 焦点和展开快捷键见[侧边栏键盘导航](sidebar-keyboard-navigation.md)。
- [对话归档](session-archive.md)是独立的日常/已归档显示范围：all 模式先筛选归档范围再分组；完整目录仍用于项目选择器、任务关联、运行/未读追踪，归档不停止后台活动。

## 独立聊天交点

[独立聊天](independent-chat.md)在权限与界面列表上都与普通项目一致：聊天工作区参与项目分组与五条预览，current 模式显示其会话历史；侧栏、picker 与搜索把它显示为“对话”，不暴露内部路径。无指定会话/目录的首页默认聊天，不再自动选最近项目。进入聊天的入口在“会话项目”选择器内（“无项目”）；聊天照常加载 worktree 状态、Explorer、项目详情、工具与扩展。

## 入口与当前默认值

设置 → 通用 → 侧边栏 → **显示所有项目**（`settings.sidebarAllProjects`）。默认关闭，即 `mode: "current"`、`collapsedProjects: []`。这是浏览器偏好，不是服务器或仓库配置。

`current` 模式保留顶部项目选择器及适用的 worktree 选择器/不可用提示；`all` 模式用列表内项目分组替换这些控件，并在顶部提供“自定义路径…”按钮。已有会话、新建按钮和文件浏览器仍使用有效 cwd。

## 行为要求与不变量

1. **模式只改变列表呈现。** 切换模式关闭项目/worktree 下拉并将列表滚动位置归零；不直接选择会话或更改 cwd。切回 `current` 时显示当前有效项目、所选日常/已归档范围的全部会话族，而不是最后一个手动展开的项目。
2. **稳定身份。** 项目按 `workspaceKeyOf` 分组（优先 `projectKey`，回退 `projectRoot`/`cwd`），显示路径与身份分开。同一项目的 worktree 共组；同 basename、不同 key 的目录保持独立。浏览器不能自行补 Windows 路径归一化来替代服务器身份。
3. **数据范围与排序。** 分组来自已加载的 `allSessions` 经日常/已归档范围投影后的集合，按项目最新 session `modified` 倒序。当前活动项目若尚无会话，在最前补一个空项目标题；不会补出所有历史空项目。失效的折叠 key 不生成幽灵项目。
4. **折叠不是导航。** 项目标题点击只切换该 key 的折叠状态，保持 URL、已选会话及 cwd；标题显示目录末段、路径和项目活动计数。运行/未读计数基于项目内 session ID，不是五条预览的可见行数。
5. **选择与揭示。** 点击会话行走原有 `handleSelectSessionFromList`，更新到该会话 cwd，并回调父级；在 `all` 模式展开其项目。活动项目 key、所选 session ID 或模式改变时也展开活动项目；手动折叠活动项目不会在同一稳定选择下立即反弹。普通选择仅保证项目展开，不保证超过第五位的会话族可见，后者见预览契约的键盘例外。
6. **持久化。** `pi-web:sidebar-view` 保存 `{ mode, collapsedProjects }`。未知 mode 回退 `current`，损坏 JSON 回退默认；折叠数组只保留字符串并去重。设置模式不清空折叠数组。读取失败使用默认，写入失败仍在当前模块内存生效，不显示存储错误。
7. **同步与 SSR。** `useSyncExternalStore` 的服务端快照为默认值；浏览器订阅时重读存储，同页监听器立即通知，其他标签页通过 `storage` 事件更新（含清空存储的 `key === null`）。内存降级不等于刷新后可靠保存。
8. **加载/失败。** 保留 summary 首载、详情补载和运行状态轮询路径。会话列表请求失败显示错误，已有数据不主动清空；空态只在无加载、无错误且无行时显示。自定义目录必须经 `/api/cwd/validate` 返回 cwd/root/key 后才切换；失败在目录对话框显示，保持原选择。验证成功仍沿用上游工作区切换/恢复逻辑，不保证一定打开空白新会话。
9. **与其他面板隔离。** `all` 下连 worktree 的加载中/非 Git 提示也隐藏，文件浏览器仍是当前 cwd 的单一浏览器。新建按钮没有 cwd 时禁用；有 cwd 时仍在当前 cwd 新建，不以被展开的项目标题决定目标。会话搜索继续使用独立 `SessionSearch` 结果展示，不应用五条预览截断。

## 实现地图

| 路径 | 关键符号/职责 |
| --- | --- |
| [SessionSidebar.tsx](../../components/SessionSidebar.tsx) | `SessionSidebar`、`showAllProjects`、`projectRows`、`listRows`、`handleSelectSessionFromList`、`commitCustomPath`、`showProjectActivity` |
| [SettingsPanel.tsx](../../components/SettingsPanel.tsx) | `GeneralSettings` 中的 `ConfigSwitch` |
| [sidebar-view-preference.ts](../../lib/sidebar-view-preference.ts) | `DEFAULT_SIDEBAR_VIEW`、`parseSidebarViewPreference`、`persist`、`subscribeSidebarView` |
| [useSidebarView.ts](../../hooks/useSidebarView.ts) | `useSidebarView`，SSR/浏览器快照 |
| [sidebar-project-rows.ts](../../lib/sidebar-project-rows.ts) | `buildSidebarProjectRows`，扁平行结构及空活动项目 |
| [project-groups.ts](../../lib/project-groups.ts)、[workspace-memory.ts](../../lib/workspace-memory.ts) | `getRecentProjects`、`getProjectActivity`、`sessionsForProject`、`workspaceKeyOf` |
| [AppShell.tsx](../../components/AppShell.tsx) | cwd/所选会话/工作区恢复的父级协调；不要把分组折叠接到工作区切换 |
| [SessionSearch.tsx](../../components/SessionSearch.tsx)、[cwd 验证路由](../../app/api/cwd/validate/route.ts) | 搜索呈现、服务器目录与身份验证 |

## 自动化验收

以下均从仓库根目录执行；这是现有覆盖清单，具体运行结果须在各次维护任务中记录。

```sh
node --experimental-strip-types --test lib/sidebar-view-preference.test.mjs lib/sidebar-project-rows.test.mjs lib/project-groups.test.mjs components/SessionSidebar.test.mjs components/SessionSidebar.project-identity.test.mjs components/SessionSidebar.worktree.test.mjs
```

- [偏好测试](../../lib/sidebar-view-preference.test.mjs)：真实解析/状态函数，模拟 `window`/localStorage，检查默认、去重、通知、跨标签事件和存储写失败；不是浏览器跨标签实测。
- [行模型测试](../../lib/sidebar-project-rows.test.mjs)：真实纯函数，覆盖活动顺序、独立折叠、worktree/子代理、空活动项目和失效 key。
- 组件测试包含源码契约断言；`SessionSidebar.test.mjs` 另调用真实虚拟窗口计算。不能据此宣称渲染、焦点或网络恢复均已验证。

真实浏览器 UI + **拦截 API fixture** 的脚本，使用已运行的本 checkout 服务。在独立终端运行 `npm run dev`；安装依赖及 Chromium 后，在 Git Bash/POSIX shell 执行：

```sh
npx playwright install chromium
E2E_BASE_URL=http://127.0.0.1:30141 node e2e/sidebar-view.mjs
E2E_BASE_URL=http://127.0.0.1:30141 E2E_SIDEBAR_NON_GIT=1 node e2e/sidebar-view.mjs
```

[sidebar-view.mjs](../../e2e/sidebar-view.mjs) 检查默认/切换、Git 与非 Git 控件隐藏、目录对话框可打开取消、独立折叠及刷新保持、跨项目选会话、切回原模式和预览。它不验证真实文件系统、Git 或目录验证失败。该独立脚本没有被 `npm run test:e2e` 的 `e2e/run.mjs` 自动调用。

## 手工验收

前置：使用可丢弃的浏览器配置和测试会话；至少 A、B 两个稳定 project key，其中 A 有 worktree 会话，另备一个存在但无会话的目录 C。清除 `pi-web:sidebar-view` 后刷新。

1. 默认只能看到当前项目会话，项目选择器可用；Git 根目录有 worktree 控件，非 Git 有原有不可用提示。开启开关后应同时见 A/B 标题，以上选择器/提示全部消失。
2. 记录 URL/cwd，折叠 B、再折叠当前 A：两组各自隐藏，URL/cwd 不变。刷新后非活动组仍保持折叠；活动组可能因初始化揭示而展开，不能把它误判为持久化失效。
3. 展开 B 并点击其会话：URL 选中该 session，文件浏览器随其 cwd；A 的折叠状态不因选择 B 而重置。关闭开关后仅有 B 项目会话，顶部选择器恢复。
4. 在 `all` 模式点“自定义路径…”，浏览 C 并选择：目录验证成功后出现 C 空标题；取消操作则选择不变。输入不存在路径并导航应显示浏览错误；对已浏览目录模拟验证接口 400/断网再点选择，应显示验证错误且不切换 cwd。
5. 在第二个同源标签页切换模式/折叠非活动项目，观察另一页同步。将存储内容改为损坏 JSON 并刷新，应回到 `current`；用受限存储环境验证开关仍即时生效，但不要求刷新后保持。

## Rebase 保留清单与上游交互

- [ ] 对照 `origin/main` 的项目身份、worktree、工作区恢复变更，保留服务端 key 和原有单项目路径；不要把项目标题改成选项目动作。
- [ ] 保留 `current` 默认、独立折叠存储、同页/跨页订阅以及 SSR 默认快照。
- [ ] 所有单项目选择器及其 fallback 的条件都包含 `!showAllProjects`，并保留 all 模式自定义路径入口。
- [ ] 会话选择、新建、搜索、文件浏览器、运行/未读聚合仍接原有父级路径；在恢复效果依赖项变化时复核“活动项目可手动折叠”。
- [ ] 联合执行预览及键盘契约；上游改虚拟列表时核对三种行的固定高度与稳定 key。

## 已知限制与未验证区域

没有项目名称过滤、手动排序、固定项目或全局多工作区文件浏览器。折叠 key 没有主动垃圾回收；活动空目录离开后可消失。列表错误后保留旧数据不是离线一致性承诺。现有独立浏览器脚本主要验证 fixture UI；真实多标签存储受限场景、实际 worktree 和目录失败需手工验收。

## 任务看板入口（票据 01）

侧栏头部新增独立 [任务看板](task-dashboard.md) 链接（`/tasks`），不把任务放进项目/session
列表，不改变分组、折叠、历史会话或显式导航规则。该链接走原生 Tab/Enter，不占用会话行的
方向键导航；Link 不注册 eager `onNavigate` 草稿回调，慢路由期间仍允许编辑。
AppShell 仅在真正离开且目标 `/tasks` 的 layout cleanup 保存最终文字/图片一次并记录
匹配 cwd 的返回标记，统一覆盖 Link/history，避免早期快照与末次内容合并。新标签页/
修饰点击不卸载源 composer，其他弃用清理不变。返回由既有
草稿/导航机制恢复，显式 URL/普通新建/项目切换仍优先；不创建 session 或发送消息。
看板的项目键仍复用服务端身份，但其目录不扩大文件访问权限。

## 已有聊天来源任务入口（04主claimed，待复审/父验收）

已选session时新增原生侧栏Link `/tasks?sourceSession=<id>`，空白composer无来源按钮。
不插入任务到session/project列表、不改变分组/折叠/selected cwd或发送prompt；关联详情回原session URL。
服务端await权威项目身份（不使用展示SWR cache作授权），但sidebar原展示cache/性能不变。
无eager draft接线，保留01真正departure/history/慢导航最终草稿。主验证见[task-dashboard](task-dashboard.md)。

## 维护规则与基线

契约基线固定为 **`63c6e4e`**；本次比较的 `origin/main` 为 `96966e5`。以源码及测试为依据，分清新增分组/偏好与继承的项目机制，不以提交标题代替核对。修改本功能时同步更新受影响的不变量、实现链接和验收覆盖；只有完成重新核对后才明确更换基线，不能把此文当作永久代表“最新 HEAD”。
