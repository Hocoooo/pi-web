# F38 — 项目 → Task → 对话的可选侧栏层级与任务检索

当前Task／正文检索呈现由 [F39 统一入口](sidebar-search-filters.md) 接管：Task下拉不常驻，面板关闭仍保持条件与结果；日常／归档按用户后续要求保留原生Session范围选择框，清除Task/正文不改范围。本合同的树、归属、归档计数与搜索交集不变。

固定开发起点：`4e7e720`（feature/task-dashboard）。本合同记录用户确认的产品行为；任务仍是 [GLOSSARY](../../GLOSSARY.md) 定义的管理归属，不是执行或共享上下文。

## 目的、入口与默认值

在既有侧栏中按任务组织会话，不新增视图或任务数据库。Settings → General → Sidebar 的 **Group conversations by task / 按任务组织对话** 默认关闭；开启即时生效。与 F03 一样使用 `pi-web:sidebar-view` 浏览器偏好，可选 `taskTree:true`；缺失、false 或未知值均关闭。同源标签页同步，存储不可写时本页仍可切换。项目范围 `current` / `all` 不变。

- all：项目 → Task（包括“未关联任务”）→ 对话。
- current：保留顶部项目选择器，下面显示 Task → 对话；不增加重复项目标题。
- 关闭 Task 层恢复 F03/F04 既有列表结构；任务检索与筛选仍可使用，不改变已打开对话或 cwd。

## 编号行为要求

1. **读取与归属。** 读取完整轻量任务目录再解析 owner；唯一显式归属仍是 `task.sessionIds`。不逐条 POST session-task/sessions，不创建/迁移 board、不取锁、不读取正文、不授予目录访问或启动 Agent。旧版本只在内存解码。缺失目录返回空集合，坏存储明确 503，不能伪装为空任务。
2. **分组身份。** 用 task UUID、服务端 projectKey 和结构化组合 key，不以标题或路径 basename 去重。未归属会话进入“未关联任务”；Task 归档不移除其仍在日常范围的会话。空 Task 平时不占满树，但可通过搜索选择，显示任务节点、零对话说明和详情入口；all 范围补出其没有 session 的项目。
3. **会话族。** 持续隐藏 subagent 独立行。没有显式归属的 subagent 跟随最近显式拥有者的祖先，fork 不通过父来源继承显示归属；显式 child owner 优先。这仅是显示/搜索投影，不写 owner。历史跨任务族可在多个 Task 下显示同一上下文根行；非本组拥有的根明确标注“为关联的子代理显示主对话”，活动/选中标记仅聚合本组成员。点击仍打开原根对话，全文结果可直接打开真正匹配的后代。孤儿/循环不会被提升为树根。
4. **折叠与预览。** Task 默认折叠，当前选择所属 Task 在初次就绪、切换选择、owner 改变或开启树时揭示一次；普通数据刷新不反复展开手动折叠的 Task。展开后默认五个会话族根，更多/收起独立于 Task 折叠；未关联组相同。按组成员最新活动排序，Task 组按最近族活动排序、未关联组最后。Task 折叠/更多状态只在组件内存，刷新重置；项目折叠仍沿用 F03 持久偏好。Task 展开不能修改旧项目更多状态，关闭树恢复原项目预览。
5. **任务搜索与选择。** 搜索标题、说明、完成标准（trim、大小写不敏感字面包含），复用 F23 `taskMatchesText`；不搜索原始对话、标签、归档报告。面板的任务列表候选按当前项目范围，all 标注项目路径；已归档 Task 带标记但仍可选。选择仅筛选左侧，不切换聊天、不修改关系/状态，不写 savedViews。选中 Task 或未关联组连同包含的项目自动展开，有明确清除入口；空态按折叠前的匹配族集合判断，不能把折叠误报为空。已有选择即使不匹配新的关键词/项目仍保留可见，不能静默放宽。
6. **正文搜索。** 已选择 Task 时添加 `taskId`，选择未关联时添加 `taskId=unlinked`；清除后恢复原全局检索。服务端先解析完整 owner/祖先，再交集对话归档 scope，再执行原 500 文件/30 结果/3 秒扫描限制。任务不存在 404、task store 无法读 503，均不退回全局。相同关键词切换任务、归属变化或归档变化会重搜；迟到/取消结果不得覆盖当前条件。不把全局截断结果拿到客户端后过滤。
7. **归档与错误。** Task 与 Session 归档独立。归档范围控制会话可见性，不推导 Task owner；计数使用当前项目/Task 会话族集合。读取失败保留旧完整目录、选择和结果，并提示可能过期及 Reload；初次目录失败时回退既有项目列表并提示错误，任务选择不可用。session refreshKey（含复制/fork）/focus/online/visibility/tasks-changed 校准不自动重绑、恢复、归档或重试报告。不存在跨文件事务快照承诺。
8. **键盘与虚拟化。** 项目、Task、session、各自更多行进入同一固定 54px 行模型，逻辑导航不限挂载窗口。Right 展开/进入下一层，Left 收起/回父 Task/项目；Home/End/Enter 继续工作，局部输入/IME/菜单优先。Alt+Left 揭示选中族及其 Task/更多，必要时清除不兼容的任务筛选，不改变当前聊天。非树的旧键盘/预览行为保持。
9. **副作用边界。** 只有任务详情按钮显式打开既有 TaskPanel。搜索/设置/树折叠不写任务、发送 prompt、生成报告、自动分类或修改 JSONL。默认关树不是关任务搜索；`demo/` 不在本次同步范围。

## 接口与实现导航

- [tasks/catalog route](../../app/api/tasks/catalog/route.ts)：`GET /api/tasks/catalog` → `{tasks:[id,title,description,completionCriteria,project,archived,updatedAt,sessionIds]}`，no-store；allowlist 排除兼容历史、receipt 和私有指纹。
- [catalog types](../../lib/task-catalog-types.ts)、[task membership](../../lib/task-membership.ts)：浏览器安全类型和 `taskOwnersForSessions` 完整祖先投影。
- [sessions/search route](../../app/api/sessions/search/route.ts)：可选 UUID / `unlinked` taskId；缺省保持 F34 全局正文语义。
- [task-view](../../lib/task-view.ts)：任务文本匹配与看板共用，不新增另一套字段规则。
- [useSidebarTasks](../../hooks/useSidebarTasks.ts)：一个目录快照、取消过期请求、错误保留和显式重读；不是 N+1 归属查询。
- [sidebar-task-rows](../../lib/sidebar-task-rows.ts)、[sidebar-project-rows](../../lib/sidebar-project-rows.ts)、[sidebar-keyboard](../../lib/sidebar-keyboard.ts)：分组/稳定 key/preview/导航。
- [SessionSidebar](../../components/SessionSidebar.tsx)、[SidebarSearchControls](../../components/SidebarSearchControls.tsx)、[SidebarTaskGroup](../../components/SidebarTaskGroup.tsx)、[SessionSearch](../../components/SessionSearch.tsx)：过滤、节点、选择揭示及正文范围。
- [SettingsPanel](../../components/SettingsPanel.tsx)、[sidebar-view-preference](../../lib/sidebar-view-preference.ts)：已有设置区扩展与跨标签偏好。
- [en](../../lib/i18n/messages/en.ts)、[zh-CN](../../lib/i18n/messages/zh-CN.ts)、[zh-TW](../../lib/i18n/messages/zh-TW.ts)：三语言一致。

## 自动验收：用户确认的两个入口

```bash
node --experimental-strip-types --test app/api/tasks/catalog/route.test.mjs app/api/sessions/search/route.test.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/sidebar-task-tree.mjs
```

端口仅示例，先按 AGENTS 检查监听进程 cwd，复用含当前源码的健康服务；安装版不代表未发布源码，不因锁另起 dev。HTTP 使用真实 handlers 与临时 agent/session/store 数据；浏览器运行真实应用和 CSS，拦截全部 API fixture，拒绝真实任务/Agent 副作用；仅 `/clone` 成功响应与继承由 fixture 模拟以验证 refreshKey，不运行 SDK。不会操作用户真实 Task 或调用 provider。

- HTTP：完整目录/空目录/合法 legacy 内存解码/锁存在/坏数据无写盘，私有和历史字段排除；UUID/未关联/缺失/坏 store/空 query；subagent 最近 owner、显式 override、fork、循环；archive 交集；500-file 和 30-result 截断前过滤。
- Chromium：默认关闭/开关即时/持久/跨标签；Task 五族/更多/收起；Right/Left/选中揭示；搜索资料/空任务/不导航/未关联；目录失败恢复；同关键词 taskId 更新；关树恢复单项目全量与 all 项目五条；同名 task/归档独立/子代理与历史跨任务上下文根/运行提示；多级跨Task族的关树标记/上下文根、清筛选后的第六根揭示、折叠不误报空、复制继承后立即刷新；390px 三语言无横向溢出，保存浅/深色截图。
- 旧回归：`E2E_BASE_URL=... node e2e/sidebar-view.mjs`、`PI_WEB_TEST_URL=... node e2e/session-keyboard.mjs`；已给目录添加空 fixture，不向真实 Task 数据发新读取。
- 现有源码断言只检查调用存在，不代替浏览器证明；不新增私有函数测试 seam。

本轮执行证据与全量环境校准见 [验收记录](../testing/sidebar-task-tree.md)。

## 手工验收

在隔离数据中建项目 A/B、各两个 Task，A 的 T1 有 7 个对话、T2 为空，并有一个未关联对话与子代理；不需调用模型。

1. 默认关树布局如旧。开启 all 项目与 Task 树，项目折叠独立，Task 默认折叠；展开 T1 显示五族及更多，展开更多后收起，不切换聊天。
2. 搜索 T2 的说明/完成标准，选择后显示零对话与详情；清除后恢复。关树保持 Task 筛选；再次开树恢复任务层。
3. 选择 T1 正文搜索关键词，切换另一个 Task，同一关键词只返回各自范围；删除/损坏任务数据时显示错误，不返回全局结果。
4. 将 Task 归档但保留一个日常对话，仍显示所属归档 Task；切换 Session archived/active 不改 owner。断网/503 保留目录并提示过期，恢复后 Reload。
5. 选择第七根，刷新后 Alt+Left 揭示并聚焦它；方向键返回 Task 再返回项目，不触发聊天导航或重新发消息。

## Rebase 与已知限制

- 保留 Settings 同区、taskTree opt-in、旧 localStorage 格式兼容、项目 scope/worktree/subdirectory/无项目身份，不强制 all。
- row union/稳定 key/固定高度/聚焦 pinning 必须一起集成，不改成非虚拟三套滚动容器。
- 保留完整 owner map、祖先显式 override、archive 交集、严格只读与 fail-closed；不能改回 per-session POST 或用筛后 Task 判断未关联。
- 任务目录不分页，会携带检索资料；native catalogue 与 board 分开读取，focus/事件刷新可校准但不承诺实时跨进程一致性。本文不授权自动恢复/模型/报告副作用。
- 仅 Chromium fixture 与临时 HTTP 测试；Safari/iOS16.2、Windows 真机、生产打包/安装、真实 provider 均未验。无 lookbehind、新语法仍须遵守旧 Safari 约束。全量测试结果与基点失败对照由本轮交付记录另列，不宣称全绿。

修改时同轮同步 F03/F04/F06/F23/F31/F34 与设置/sessions topic 和本索引；不能因为旧投影未冲突而跳过验收。
