# Pi Web 任务看板、Session 聚类与共享上下文：调研及实施建议

- 检索日期：2026-10-09（运行环境 UTC 日期）。
- 本地基线：`85cc4f3`，`@agegr/pi-web 0.10.0-personal.6`。
- 文档性质：研究与方案建议，**不是已实现功能契约**。本次不安装外部项目、不改运行时代码、不启动 Agent、不修改现有 session。
- 方法：多角度网络检索，回读官方 README、用户文档、许可证和部分源码；通过 GitHub API 检查 16 个相关仓库的默认分支、归档状态、最近推送时间与许可证识别结果。没有实际部署竞品，也没有验证其性能、安全性或全部功能。
- 事实、判断和建议分别表述。仓库默认分支会变化；选定复用对象后仍须固定 commit、审查其依赖与文件级许可证。下列许可证概述不是法律意见。

## 1. 结论

推荐在 Pi Web 中原生增加 **Task Workspace**：任务是长期业务实体，session 是围绕任务发生的一段对话，execution 是一次运行，worktree 是代码隔离环境，shared context 是有来源和版本的任务知识。

建议组合：

1. **保留 Next.js / React / TypeScript 和现有 Pi SDK。** 不把现有应用改造成另一个 Agent 调度平台。
2. **看板 UI 使用 dnd-kit；Pragmatic Drag and Drop 为备选。** 复用拖拽能力，不搬入完整 Jira 替代品。
3. **任务元数据与 session 关联独立持久化。** 推荐先验证 SQLite 在现有 Node、npm 分发、Windows/macOS 下的打包方案；不把浏览器 localStorage 或 session 内 todo 当全局数据库。
4. **第一版共享“任务目标、约束、决策、交接摘要和证据链接”。** 保留独立对话历史，不做多 session 原始消息实时混流。
5. **先做手工聚类与可控上下文共享，再做自动建议和调度。** 拖动到 In Progress 不应默认启动 Agent；Agent 停止也不等于任务 Done。

最值得读的项目：

- **pi-kanban**：最贴近 pi 会话生态，但当前是 session 中 todo 的可视化，不等于跨 session 的任务中心。
- **kb**：直接基于 pi，已有任务、看板、SSE、依赖调度与 worktree，但其自动执行和内存 session 路线不能原样带入 Pi Web。
- **SlayZone**：最接近“一个任务下多个 Agent / 终端”的交互模型。
- **Vibe Kanban**：很好的工作区与会话建模参考，但已宣布公司关闭，且明确不共享对话上下文。
- **Letta Context Repositories / shared memory**：最有价值的跨会话知识共享参考，但并不是即装即用的 Pi 插件。

## 2. 需求拆解：不是只有一个看板

| 层次 | 功能 | 推荐定位 |
|---|---|---|
| Dashboard | 各状态数量、阻塞项、活跃 session、待审阅任务、成本 | 看板之外的汇总视图；后置部分统计 |
| Board | 自定义状态列、列内/跨列拖拽、筛选、排序、保存视图 | 第一阶段核心 |
| Task | 描述、验收标准、优先级、标签、依赖、活动记录 | 长期事实来源 |
| Session grouping | 一个任务下规划/实现/审阅等多个 session | 显式关联，不改 session 身份 |
| Shared context | 同一任务跨 session 复用目标、事实、决策、交接 | 版本化、可追溯、按需加载 |
| Execution | 启动/停止 Agent、运行态、worktree、产物 | 复用已有运行时，后续扩展 |

产品上应同时保留“按项目浏览历史 session”和“按任务组织工作”。不是强制把所有历史对话变成任务。

## 3. 市场与 GitHub 方案比较

### 3.1 最相关：Agent / pi 工作区

| 项目 | 已核实内容 | 与目标的差距 | 复用建议及许可 |
|---|---|---|---|
| [NikiforovAll/pi-kanban](https://github.com/NikiforovAll/pi-kanban) | 读取 pi JSONL；项目下 session 列表；选中 session 的 Pending/In Progress/Completed 看板；读取 `rpiv-todo`、展示 `pi-subagents`；支持 `bind_plan` 关联 Markdown | 文档未证明支持跨 session 任务实体、拖拽写回、共享模型 context；不要把界面列等同完整任务系统 | 借鉴 session 观察、计划文档关联及扩展数据适配。package.json 声明 MIT，但本次树检查未见独立 LICENSE，复制前补核版权通知 [S1] |
| [dustinbyrne/kb](https://github.com/dustinbyrne/kb) | pi 驱动；文件型 task store；Triage/Todo/In Progress/In Review/Done；拖拽、SSE；依赖调度；worktree；每步规划/审阅/执行 | README 明确使用 in-memory sessions；默认启动调度，不是 Pi Web 的持久 session 浏览模型；未证明已有所需 context 共享 | 重点学习 task/domain/store 分离、任务规格和调度模型。README 声明 ISC，复用前确认发行包完整授权材料 [S2] |
| [debuglebowski/slayzone](https://github.com/debuglebowski/slayzone) | 每个任务有终端、浏览器、Git/worktree；每任务可多个 Agent；CLI/MCP 更新任务；Electron/React/SQLite/PTY | 自动状态适配器覆盖不一致；README 提醒 100+ 卡片拖拽可能变慢；未核实跨 session 对话共享 | 优先借鉴任务详情与 session 列表 UX，不移植 Electron 外壳。GPL-3.0；Pi Web 为 MIT，直接复制须评估分发义务 [S3] |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | Issue → Workspace → Sessions；worktree、Agent、diff 审阅、预览、PR；Rust + Web 前端 | 官方明确 session 只共享文件，不共享 conversation context；公司已关闭，远程功能过渡有风险 | 架构与交互参考，不依赖其远程服务。Apache-2.0 [S4][S5] |
| [0xKobold/pi-task](https://github.com/0xKobold/0xkobolds/tree/master/packages/pi-task) | 六状态、SQLite、历史、父子任务、评论、session scope；task 工具与命令 | `bun:sqlite` 不能直接放入当前 Node 运行时；session-scoped 数据还不等于跨 session 的 task ownership | 借鉴任务 schema 和工具行为；本次未核实独立包完整许可证，不推荐未经审查复制 [S6] |

#### Vibe Kanban 的两个关键事实

1. 官方 session 文档：**“Sessions share files but not conversation context.”** 因此新 session 不会自动知道之前 session 的指令或讨论。[S4]
2. 官方 shutdown 公告：bloop 公司关闭，项目交给社区；公告称远程服务维持 30 天后转本地架构，移除的远程服务包括 kanban issues、comments、projects、organisations，local workspaces 继续工作。公告页面提取未给出可核验发布日期，故本报告不推断服务实际停止日期。[S5]

结论：它仍值得学习，但不能按过去文章的“持续商业维护、云看板可用”描述直接选型。

#### pi-kanban 为什么不是完整答案

它目前的主组织方式是 `Project → Session → Todos`；本需求需要的是 `Project → Task → Sessions`。这不仅是换一个页面布局，还涉及任务的独立生命周期、共享知识的写入规则，以及一个 session 在多任务之间切换时的隔离规则。[S1]

### 3.2 完整项目管理产品与 UI 基础设施

| 项目 | 适合借鉴什么 | 不建议直接采用的原因 / 许可 |
|---|---|---|
| [Plane](https://github.com/makeplane/plane) | Work Items、Cycles、Modules、保存筛选 Views、Pages、Analytics；完整团队任务模型 | 当前 README 列 React Router / Django / Node；不是轻量 React 看板组件。AGPL-3.0。适合将来通过 API 对接外部团队任务源，不建议嵌入整个系统 [S7] |
| [PLANKA](https://github.com/plankanban/planka) | Trello 式看板与卡片组织 | 当前为 PLANKA Community License / Fair Use，并非可以笼统称为 MIT/AGPL；商业托管等受限制，Pro/Enterprise 文件另有授权。可以研究交互，不能默认自由搬运 [S8] |
| [Focalboard](https://github.com/mattermost-community/focalboard) | 多视图、卡片属性、自托管项目管理 | README 明确声明当前不维护；即使 GitHub 有新推送，也不能据此认定恢复维护。不宜成为新核心依赖 [S9] |
| [next-shadcn-dashboard-starter](https://github.com/Kiranism/next-shadcn-dashboard-starter) | Next.js 看板页面、卡片、布局的起步参考；MIT | 已读 kanban store 是 Zustand 示例数据，持久化 wrapper 被注释。不是任务后端、session 关联或共享 context 实现，复制整个 starter 收益不大 [S10] |
| [dnd-kit](https://github.com/clauderic/dnd-kit) | 多容器排序、指针/触摸/键盘、ARIA 与 live region、可定制渲染；MIT | 推荐首选。注意新 `@dnd-kit/react`/DOM 架构与旧 `@dnd-kit/core`/sortable 教程不同，必须锁版本，不能混用 API [S11] |
| [Pragmatic Drag and Drop](https://github.com/atlassian/pragmatic-drag-and-drop) | Atlassian 用于 Jira/Trello/Confluence 的无头拖拽工具链；框架无关、可虚拟化；Apache-2.0 | 很好的备选。可访问性交互需接入其可选能力或自行实现，并非装核心包即完成。实际移动端与 Safari 16.2 仍需验收 [S12] |

### 3.3 任务记忆与上下文共享

| 项目 | 已核实能力 | 在 Pi Web 中的定位 |
|---|---|---|
| [Beads](https://github.com/gastownhall/beads) | 持久依赖图、原子 claim、ready tasks、关系、长期任务记忆；当前 README 为 Go / Dolt 路线；MIT | 借鉴结构化任务、依赖与可领取工作。不是看板 UI；也不是自动合并聊天历史。暂不引入额外 Dolt 运行栈，未来可做 adapter [S13] |
| [Task Master](https://github.com/eyaltoledano/claude-task-master) | AI 任务拆解、依赖、tags/workstreams、CLI/MCP | 适合任务生成/导入，不是完整 session 层。许可为 MIT **加 Commons Clause**，不能简写为纯 MIT [S14] |
| [Letta Code](https://github.com/letta-ai/letta-code) / [Context Repositories](https://www.letta.com/blog/context-repositories/) | Git 版本化 memory、文件树渐进披露、memory worktree、整理/反思；当前 shared memory 文档支持多个 Agent 挂同一仓库 | 借鉴“共享知识，不共享全部短期历史”。当前文档说明组织级 shared repositories 要求 cloud-hosted agents，本地 agent 用 MemFS / 项目文件；不是无条件可本地嵌入的现成功能。Letta Code 仓库 Apache-2.0，云功能另行评估 [S15] |
| [Mem0](https://github.com/mem0ai/mem0) | 提取和检索跨 user/session/agent 的 memory；Python/JS SDK、自托管/云；Apache-2.0 | 大量任务知识时再评估。会增加模型抽取、embedding、索引与删除策略。README 的最新基准包含云端专有优化，不能视作 OSS 或本项目实测 [S16] |
| [Graphiti](https://github.com/getzep/graphiti) | 时序知识图谱、增量知识更新、图检索；当前仓库许可证识别为 Apache-2.0 | 适合实体关系与时效性复杂的知识系统，不是第一版三列看板所需；增加 Python/图后端等部署成本 [S17] |

**特别注意版本变化：** 不要把旧文章中的“Beads 是简单 JSONL 工具”“Letta 只用共享 memory blocks”“dnd-kit 只有旧 core API”“PLANKA 没有商业限制”当作当前事实。上表按本次访问的一手资料记录。

## 4. Pi Web 当前有什么、缺什么

### 已有能力与具体接入点

| 本地文件 | 核实的行为 | 用途 |
|---|---|---|
| [`package.json`](../../package.json) | Next 16.3.6、React 19、TS；Node >=22.19.0；Safari/iOS 16.2；MIT；没有现成 task DB / DnD 依赖 | 在现有栈内增量做，不必另起全栈应用 |
| [`lib/session-reader.ts`](../../lib/session-reader.ts) | 读 session、处理项目/worktree 归属、增量列表和 context；`attachSessionProjectInfo` 在约 161 行，`buildSessionContext` 在约 674 行 | 看板批量关联 session 元数据；正文按需读 |
| [`lib/types.ts`](../../lib/types.ts) | `SessionInfo` 约 354 行包含项目身份、来源与运行关联；无一等 task 关联模型 | 新增 task summary DTO，不改变 JSONL header |
| [`lib/rpc-manager.ts`](../../lib/rpc-manager.ts) | 持有 AgentSessionWrapper；prompt 准入；`agent_settled`；957 行起 fork/fork_branch/clone；1063 行 navigate_tree | 复用运行时、分支与安全发送路径 |
| [`app/api/agent/new/route.ts`](../../app/api/agent/new/route.ts) | 临时 key 到 realSessionId；可 ensure_session 或直接发首条 prompt | 任务启动入口需在首 prompt 前完成关联和 context 选择 |
| [`app/api/agent/running/route.ts`](../../app/api/agent/running/route.ts) | 返回轻量 running ids 和列表版本 | 卡片上的运行徽标；不为每张卡打开 SSE |
| [`lib/project-identity.ts`](../../lib/project-identity.ts)、[`lib/worktree.ts`](../../lib/worktree.ts) | 服务端项目 key、平台路径语义、worktree 归属 | 同仓库多个 worktree 聚合，不能按 basename 分组 |
| [`lib/exact-system-prompt.ts`](../../lib/exact-system-prompt.ts) | 用 before_agent_start 实现精确 prompt | 共享 context 不得破坏 Chat-only 与 replace prompt 合同 |
| [`lib/subagent-runtime.ts`](../../lib/subagent-runtime.ts)、[`docs/agents/subagents.md`](../agents/subagents.md) | 子 session 元数据、状态、结果与通知；有恢复和中断语义 | 后期关联子执行，不能把子 Agent 的完成直接映射成 Task Done |

本次未在应用 `lib` 中发现独立 task 模块；已有会话运行能力不能视作已拥有跨 session 的 task store。

### 必须维持的本地合同

- 浏览会话/任务列表保持只读，不因为打开卡片而启动 Agent、连接 MCP 或发模型请求。
- JSONL 与 SDK SessionManager 仍是会话历史事实源；不要直接拼接、重排多个 session 的 JSONL。
- 独立聊天继续使用固定 `chat-workspace`；task 分组不能改变工具权限或把聊天强制变成项目。[独立聊天合同](../branch-features/independent-chat.md)
- 继续遵守全项目侧栏、工作目录身份和导航优先级；任务视图是新增维度，不替换现有历史入口。[侧栏合同](../branch-features/all-projects-sidebar.md)
- 不给 `ctx.ui.*` 或 extension UI request 添加 pi-web 私有字段来做看板；Web 展示留在 Web，任务读写通过普通工具/MCP/后端接口。
- 文件读取继续经过已有授权检查。context 中提到一个路径，不代表授予浏览整个目录的权限。[文件访问说明](../agents/files-and-access.md)
- Node 全局 npm 安装、Windows、macOS 和 iOS Safari 16.2 都是选包约束，不能只在开发机验证。

## 5. 推荐领域模型

### 5.1 四个概念分开

- **Task**：用户要达成的目标、验收条件和业务状态。
- **Session**：一次可持续、多轮、有分支的 Agent 对话。
- **Execution**：一次实际运行尝试，可能成功、失败、中断、等待交互。
- **Context revision**：该任务共享知识的某个不可变版本。

关系建议：一个 Task 关联多个 Session；第一版一个 Session 最多一个主 Task，可有只读参考链接。通过关联表预留未来多对多，但不要第一版就让一个 session 同时混入多个任务上下文。

### 5.2 最小持久模型（提议，不是现有 schema）

| 表 / 记录 | 关键字段 |
|---|---|
| `tasks` | id、projectKey、title、description、acceptanceCriteria、statusId、priority、rank、revision、archivedAt、timestamps |
| `workflow_statuses` | id、projectKey、name、category(todo/doing/done/cancelled)、rank |
| `task_sessions` | taskId、sessionId、role(plan/implement/review/research)、isPrimary、linkedAt |
| `task_dependencies` | taskId、dependsOnTaskId；拒绝自依赖与环 |
| `task_labels` | taskId、labelId |
| `task_events` | seq、taskId、actor、type、payload、timestamp、operationId |
| `context_revisions` | taskId、version、baseVersion、content、sourceReferences、author、approvalState、createdAt |
| `session_context_receipts` | sessionId、runId/本地运行标识、taskId、contextVersion、sourceLeafId、contentHash |
| `saved_views` | scope、filter、sort、groupBy、revision |

第一阶段可先实现 tasks/statuses/task_sessions/events；context 和高级依赖分阶段加入。activity log 不等于必须做完整 event sourcing，当前状态与事件可在同一事务落库。

**不要用 task title、文件名、cwd basename 或 session 标题作为关联键。** 项目归属复用 server-computed projectKey；后续跨项目 task 显式增加关联，不自行扩大读取范围。

### 5.3 持久化选择

推荐默认位置：`<getAgentDir()>/pi-web/tasks.sqlite`，尊重 `PI_CODING_AGENT_DIR`。会话正文继续留在原 sessions 目录。任务 export/import 应覆盖任务、关联、context revision；不能假设重扫 JSONL 就能恢复完整任务数据库。

选择 SQLite 的原因是事务性：拖动任务、改 status/rank、写活动、推进 revision 和事件序号可以一次提交。标签、筛选和会话关联也更自然。

但引擎必须先做分发 spike：

- 评估最低 Node 22.19 对 `node:sqlite` 的实际支持、实验性接口及运行参数。
- 如果选择 `better-sqlite3`，核查 native ABI / 预编译包 / Windows/macOS npm 安装，不能只验证本机。
- Next server-only 打包、热重载下连接复用、事务忙等待、迁移、损坏恢复、备份都需验收。
- 初期本地单服务可用 WAL/事务；网络盘、多进程和云端多副本不是自动获得的能力。

替代方案是**带跨进程锁和原子写的文件 store**。它更接近现有项目，但多记录事务、并发排序、崩溃恢复需要额外设计；不应做“所有 task 一个 JSON，直接覆盖写”的简化。数据库选择放在 TaskStore 内，不扩散到组件与 SDK wrapper。

## 6. 看板交互和一致性

### 6.1 页面结构

- 全局 / 当前项目任务入口。
- 顶部：搜索、状态、优先级、标签、项目、是否有活跃 session、是否等待用户；保存筛选视图。
- 中部：Todo / In Progress / Review / Done，可后续增加 Backlog、Blocked、自定义列。
- 卡片：标题、优先级、标签、session 数、最近活动、运行/等待输入徽标。
- 详情：描述与验收、Sessions、Shared Context、Artifacts、Activity。
- 在详情中“新建 session”时可选择规划、实现、审阅等角色；默认不自动启动模型。
- 侧栏增设“按任务”分组模式，保留“未关联任务”的 session 区域。

### 6.2 拖拽不要只改前端数组

建议移动请求表达为 `taskId + targetStatusId + beforeTaskId/afterTaskId + expectedBoardRevision + operationId`。

服务端在事务内验证：任务与列属于允许的范围、邻居仍有效、操作未重复、revision 未过期，然后生成排序 rank、记录事件并返回新 revision。过期返回 409，前端刷新/回滚，不能把成功动画当持久化成功。

- 使用 fractional string rank 等有序键；不是无限插入浮点数。相同 rank 有稳定 tie-breaker，必要时事务内重排。
- manual rank 与 priority / updatedAt 等自动排序分开。自动排序视图禁用手动调序或明确提示切换模式。
- 筛选后的视图不能用局部数组 index 覆盖全量顺序；只移动指定任务，不丢失或重排不可见项。
- 乐观更新失败可恢复，重试有幂等键；两浏览器同时拖动不能静默覆盖。
- 拖拽必须提供“移动到列 / 上移 / 下移”的菜单或键盘等价操作。
- 滚动与触摸拖拽需激活阈值；单独验证空列、大卡片、跨列自动滚动、移动端横向滚动。
- 100/1000 卡片性能作为压测 fixture，不先承诺性能指标；需要时引入虚拟化与卡片 memo。

### 6.3 Task 状态和 Agent 状态分离

业务状态示例：Todo / In Progress / Review / Done / Cancelled。

运行徽标示例：running / idle / needs-input / failed / interrupted。

`agent_end` 不是最终业务完成事件，Pi 可能自动恢复或继续队列；`agent_settled` 更适合更新运行徽标，但也不是验收通过。完成状态由用户确认、明确工具操作或后续可配置验收规则推进。等待输入可优先醒目显示，同时保留运行数量，不强行压成一个互斥状态。

任务归档不删除 session；删除 session 不级联删除任务知识，应将对应证据标为来源不可用并保留必要的 provenance。

## 7. Context 共享：建议做什么，不做什么

### 7.1 把“共享”分成三种

| 机制 | 行为 | 适用情况 |
|---|---|---|
| Fork / Clone | 从某个会话分支点复制已有历史；之后互不自动同步 | 复现同一路线、比较方案；已有能力 |
| Task context pack | 目标、约束、决策、交接、测试和产物引用被多个 session 读取 | **本需求首选** |
| Shared raw transcript | 多 session 原始消息持续混入彼此对话 | 第一版不做：token、污染、竞争、分支语义和工具结果配对风险大 |

共享文件 ≠ 共享模型 context；写入数据库或文件 ≠ 已进入下一次模型请求；fork 继承历史 ≠ 持续共享记忆。

### 7.2 共享内容的层次

1. **Task brief（始终小而明确）**：目标、非目标、验收标准、关键约束。
2. **Approved decisions**：已确认选择、理由、被否决方案、失效或 superseded 状态。
3. **Handoff**：已完成什么、剩余什么、阻塞、下一步建议。
4. **Evidence / artifacts**：文件与行、commit、测试命令和结果、选中的 session entry 链接。
5. **Working context（默认不共享）**：当前 session 临时假设、长日志、未完成工具调用、私有 scratchpad。

不默认共享 raw thinking、全量工具输出、凭据、所有附件，也不跨项目自动检索。模型提取的摘要首先是 proposal，不是比用户要求更高优先级的事实。

### 7.3 最小闭环

1. 用户创建 Task，填写 brief，确认版本 v1。
2. 在 Task 内创建 Session A；首条 prompt 前绑定真实 sessionId 和 v1。
3. A 完成研究后，用户点击“发布交接”；服务端保存摘要 proposal，以及 sessionId、leafId/entryId、模型/时间、相关代码版本。
4. 用户审核或编辑，发布 v2。
5. Session B 启动时选择最新 approved v2 或固定旧版本，看到准确版本和来源。
6. A 再产生 v3，B 显示“共享上下文有更新”；下一次运行前显式采用。运行中不静默改输入。
7. 同时发布使用 baseVersion 检查；冲突给出对比/合并流程，不采用 last-write-wins 覆盖所有决策。

使用不可变的每次运行 snapshot，既便于解释输出，也便于复现。任务改绑不会抹掉 session 已经看过的旧 context；需要彻底隔离时新建 session。

### 7.4 如何接入 Pi SDK

已核对本机 SDK 文档：

- `SessionManager` 对持久历史和 active branch 权威；改 `agent.state.messages` 不替代持久上下文。
- extension 文档将“跨一个 session 的数据”明确归为 external storage。
- `pi.appendEntry()` 是不进模型上下文的持久数据；需要给模型的 custom content 用 `pi.sendMessage()` 等标准能力。
- `context` 可做请求级消息转换；`before_agent_start` 可改变 prompt。修改精确 system prompt 有既有合同，不应擅自拼接覆盖。[S18]

建议第一版采用 **显式、可见、持久化的 task-context custom message**，在安全准入点加入，记录 taskId、version、source references。只把受控的小 brief/handoff 放进消息；其余文档按需读取。

注意：custom message 最终转换为 user-role 内容，要前缀注明“来自任务共享记录、作者/来源/版本”，不能冒充用户刚刚下达的新指令。模板中明确工具输出和外部文档是资料，不是可覆盖用户要求的命令。

后续若使用 `context` hook 做按需检索或去重，必须保证：

- 仅处理自己命名空间的 context pack，不改其他扩展消息。
- 旧 pack 被新版本替代只影响模型投影，审计历史仍在；compaction 后仍有清晰的版本和失效语义。
- 给确切请求记录实际投递的版本，而不是只记录“现在数据库最新版本”。
- Chat-only 不因为关联任务而突然加载扩展、开放工具或改写 exact system prompt；其共享内容仍可通过明确聊天内容提供。
- 正常工具预设、只读语义与用户批准在后端执行，Agent 不能自行扩大 task/project scope。
- 不写入正在运行的其他 wrapper 的 JSONL；需要发送时走正常 SDK 准入/队列。

这些是待做真实 SDK fixture 的接入设计，不声称安装一个 memory 包即可完成。

### 7.5 检索演进

- **V1：无需向量数据库。** 固定 brief + 用户选定的 handoff/decisions + 明确来源。
- **V2：全文搜索。** 在已授权 task 范围内检索批准的摘要、产物索引；中文效果单独验证分词，不能默认英文 FTS 同样适用。
- **V3：语义检索。** 证明确有召回问题后再评估 Mem0/embedding。task/project/用户权限过滤必须在召回和返回两端执行。
- **V4：跨任务知识图谱。** 真有复杂时效关系再考虑 Graphiti。

可配置预算，例如先试 1–3k tokens 的 brief/handoff，再给有限检索额度；这是起始调优参数，不是已验证最优值。超限优先保留原始约束和验收标准，不静默截掉关键内容。

外部 memory 服务需要明确数据流、用户同意、保留/删除策略和费用展示。不要为了摘要自动把所有历史聊天上传第三方。

## 8. 模块与接口建议

在“统一 Task 应用模块”内集中状态转换、权限、排序、关联、事件和上下文版本规则。UI、HTTP、Agent 工具调用同一 Interface，避免三份规则。

拟增文件（仅建议）：

| 位置 | 职责 |
|---|---|
| `lib/tasks/task-service.ts` | create/update/move/linkSession/publishContext，统一校验与事务 |
| `lib/tasks/task-store.ts` | 持久化、迁移、revision/幂等；不泄漏 SQL 到组件 |
| `lib/tasks/task-context.ts` | 生成有预算的 context pack、引用与版本策略 |
| `lib/tasks/task-events.ts` | 事务事件、游标、SSE 通知与断线恢复 |
| `lib/tasks/task-extension.ts` | 标准 pi 工具适配；独立命名，不覆盖用户已有 todo |
| `app/api/tasks/**` | CRUD、move、session links、context revision、events |
| `components/tasks/TaskBoard.tsx` | 看板与拖拽 |
| `components/tasks/TaskDetail.tsx` | Sessions / Context / Artifacts / Activity |
| `hooks/useTaskBoard.ts` | 快照、增量、乐观更新、冲突回滚 |

### 拟议 HTTP 能力

- `GET/POST /api/tasks`
- `GET/PATCH /api/tasks/[id]`
- `POST /api/tasks/[id]/move`
- `POST/DELETE /api/tasks/[id]/sessions`
- `POST /api/tasks/[id]/start-session`
- `GET/POST /api/tasks/[id]/context`
- `GET /api/tasks/events?after=...`

`start-session` 内部复用 startRpcSession；必须先绑定实际 sessionId、选定 context，再接受首条 prompt。外部数据库事务与 session JSONL 不是一个事务，因此需 operationId、pending/linked 状态与失败恢复，不能假设两个写入永远一起成功。

列表只读 task DB 与轻量 session 索引，不能 N 张卡读取 N 份完整 transcript。独立 task SSE 发布轻量变更，使用单调事件序号，支持断线 catch-up；已清理的游标返回重新拉快照。事务后通知可丢，持久事件不可丢。不要为看板改写原 session SSE 协议。

### 现有 todo / 第三方 task 工具

Pi SDK 自带 todo 示例把状态存在 tool-result details、按当前分支重建；这是正确的 session-local 行为，却不适合拿来充当跨 session 的唯一任务源。[S18]

建议：

- 新的长期 task 使用自己的稳定 UUID 与工具命名，例如 `task_get/task_update/task_context_read/task_context_propose`。
- 现有 todo 作为执行 checklist 展示，可“提升为任务”或“关联到任务”。
- `pi-kanban`/rpiv-todo/其他扩展分别做显式、版本化 adapter；没有证据表明同名工具返回相同 schema。
- 默认只读导入或单向同步。后期若双向同步，用事件 origin/operationId 防回环，并规定字段 ownership，避免状态互相覆盖。

## 9. 代码隔离与安全

- **worktree 隔离代码，context store 共享知识。** 不要求同任务所有 session 写同一 worktree。
- 顺序 session 可以复用 task workspace；并发写入 session 建议独立 execution worktree。
- 共享同一工作目录时，应用内写入租约只约束应用管理的执行，不是 OS 沙箱；仍需冲突提示和外部修改检测。
- handoff 标明 branch/commit；B 的 checkout 不包含 A 的变更时，提示需要合并，而不是只注入“A 已完成”的文字。
- 第一版仍是当前 Pi Web 的部署身份模型。真正多人团队需要用户身份、task/project ACL、权限变更与审计，是额外工程，不是增加 assignee 字段即可。
- 任务、context 和 SSE 路由沿用 web auth；拒绝跨范围 taskId、任意路径与越权 session 引用。
- taskId 必须解析为受控存储记录，不能拼到任意文件路径。共享 Markdown 渲染沿用现有 sanitizer。
- context 发布前展示来源、避免密钥和敏感路径；删除来源不自动删除已复制的摘要，需独立撤回/清理机制。
- 删除 worktree 或归档任务不是结束正在运行的 Agent 的替代操作；运行控制必须显式处理。

## 10. 实施阶段与验收

### P0：两项技术验证

- dnd-kit 新版在 React 19、当前构建和 Safari 16.2 的多列、触摸、键盘表现。
- SQLite 选择在 Node 最低版本、Next 打包及 macOS/Windows 全局 npm 安装后的读写/迁移/恢复。

产出：固定版本和选型结论；不改 Agent 行为。

### P1：可用看板与任务聚类

- task/status 持久化、CRUD、排序、筛选、活动记录。
- 手工关联既有 session，从任务创建新 session；卡片显示 session 数和运行徽标。
- 新增任务视图，不破坏原项目/session 视图。
- 本阶段拖动只改业务状态，不调度模型。

验收：重启不丢；并发移动不丢更新；筛选后调序不影响无关卡片；未关联 session 可达；独立聊天/Windows worktree 归属正确。

### P2：最小共享上下文闭环

- brief + versioned handoff + sources。
- 选择消息“发布到任务”；模型摘要可选且需审核。
- 新 session 显式注入；现有 session 可选接收更新。
- context receipt 与历史对比，旧 context 与 branch/commit 过期提示。

验收：A 发布一个明确决策，B 在 fresh session 收到；不注入 A 的全量 transcript；来源和版本准确；并发发布有冲突；未批准 context 不自动扩散。

### P3：Agent 工具与高级任务能力

- task 工具、只读策略、依赖与阻塞、saved views。
- 状态建议而非无条件自动 Done。
- 运行/测试/产物关联；每 execution worktree，保留显式启动控制。
- 按需全文检索与 context 更新提醒。

### P4：可选生态集成

- Jira/Linear/Plane/Beads 的单向导入或字段级同步。
- 多人 ACL、远端 DB、审批策略。
- 有实测需要后再上语义 memory 或知识图谱。

**不建议第一版一起实现：** 完整 Jira dashboard gadget 系统、自由布局、自动多 Agent 调度、全局多租户、知识图谱、多个 task 后端双向同步。

### 测试分层

1. 领域测试：合法状态、移动/排序、幂等、revision 冲突、依赖环、context 版本、任务隔离。
2. 存储测试：事务、两连接竞争、进程中断恢复、schema migration、event catch-up、删除/归档。
3. SDK fixture：临时 agent-dir、合成 session、fork/clone/navigate_tree、compaction、Chat-only、首条 prompt 接收的 pack；默认不调真实 provider。
4. 浏览器：跨列/同列/空列、触摸/键盘、筛选下排序、API 失败回滚、两标签页并发、SSE 断连重连。
5. 性能与平台：大量 card/session 的读放大、长历史正文懒加载、Safari 16.2、Windows 路径、全局安装。
6. 安全：未授权 task/session 引用、路径穿越、敏感内容传播、提示注入、第三方 memory 上传需同意。

实现时先更新/新增 branch-features 合同及 README 索引，再做对应测试与代码。本研究不把未实现能力写入当前功能列表。

## 11. 需要产品确认的少量决策

推荐默认值如下，不需要阻塞研究结论：

1. **用户范围**：先单用户本地部署，预留协作，不承诺多人 ACL。
2. **共享语义**：共享审核后的任务知识，而非自动复制所有聊天。
3. **关联规则**：一任务多 session；一 session 一个主 task；可显式参考别的任务但不自动混入。
4. **自动化程度**：拖拽不启动 Agent，Agent 停止不自动 Done。
5. **存储位置**：agent-dir 全局 task DB，项目文件可导出；同仓库 worktree 共用任务身份。
6. **外部任务系统**：当前不强制接 Jira/Plane，未来按需做连接器。

若这六点成立，推荐落地路径很明确：**原生 Task Workspace + dnd-kit + 独立事务 store + Pi session 关联 + 显式版本化 context pack**。

## 12. 一手来源索引

### Agent / pi

- **[S1] pi-kanban**：[README](https://github.com/NikiforovAll/pi-kanban/blob/main/README.md)、[User guide](https://github.com/NikiforovAll/pi-kanban/blob/main/docs/user-guide.md)、[Extensibility](https://github.com/NikiforovAll/pi-kanban/blob/main/docs/extensibility.md)、[package.json](https://github.com/NikiforovAll/pi-kanban/blob/main/package.json)。
- **[S2] kb**：[README：任务存储、SSE、in-memory sessions、调度与许可声明](https://github.com/dustinbyrne/kb/blob/main/README.md)。
- **[S3] SlayZone**：[README：每任务多个 Agent、技术栈与已知限制](https://github.com/debuglebowski/slayzone/blob/main/README.md)、[LICENSE](https://github.com/debuglebowski/slayzone/blob/main/LICENSE)。
- **[S4] Vibe Kanban**：[README](https://github.com/BloopAI/vibe-kanban/blob/main/README.md)、[Sessions：文件共享不等于 context 共享](https://github.com/BloopAI/vibe-kanban/blob/main/docs/workspaces/sessions.mdx)、[LICENSE](https://github.com/BloopAI/vibe-kanban/blob/main/LICENSE)。
- **[S5] Vibe Kanban shutdown**：[官方公告 Goodbye bloop](https://www.vibekanban.com/blog/shutdown)。
- **[S6] pi-task**：[包 README](https://github.com/0xKobold/0xkobolds/blob/master/packages/pi-task/README.md)。

### 看板与组件

- **[S7] Plane**：[README：产品能力和当前技术栈](https://github.com/makeplane/plane/blob/preview/README.md)、[GitHub repo 元数据（license 等）](https://api.github.com/repos/makeplane/plane)。
- **[S8] PLANKA**：[当前 LICENSE.md](https://github.com/plankanban/planka/blob/master/LICENSE.md)。
- **[S9] Focalboard**：[README 维护状态警告](https://github.com/mattermost-community/focalboard/blob/main/README.md)。
- **[S10] Next shadcn starter**：[仓库](https://github.com/Kiranism/next-shadcn-dashboard-starter)、[Kanban store 示例源码](https://github.com/Kiranism/next-shadcn-dashboard-starter/blob/main/src/features/kanban/utils/store.ts)。
- **[S11] dnd-kit**：[当前 README](https://github.com/clauderic/dnd-kit/blob/main/README.md)、[React quickstart](https://dndkit.com/react/quickstart)。
- **[S12] Pragmatic Drag and Drop**：[README](https://github.com/atlassian/pragmatic-drag-and-drop/blob/main/README.md)、[官方文档](https://atlassian.design/components/pragmatic-drag-and-drop)、[LICENSE](https://github.com/atlassian/pragmatic-drag-and-drop/blob/main/LICENSE)。

### Context 与任务记忆

- **[S13] Beads**：[当前 README](https://github.com/gastownhall/beads/blob/main/README.md)、[LICENSE](https://github.com/gastownhall/beads/blob/main/LICENSE)。
- **[S14] Task Master**：[README](https://github.com/eyaltoledano/claude-task-master/blob/main/README.md)、[MIT + Commons Clause 原文](https://github.com/eyaltoledano/claude-task-master/blob/main/LICENSE)。
- **[S15] Letta**：[Context Repositories 官方文章](https://www.letta.com/blog/context-repositories/)、[当前 shared memory 文档：Git repositories、云范围和 legacy blocks](https://docs.letta.com/concepts/shared-memory/index.md)、[Letta Code](https://github.com/letta-ai/letta-code)。
- **[S16] Mem0**：[README：多层 memory、SDK、部署与基准适用范围](https://github.com/mem0ai/mem0/blob/main/README.md)、[repo 元数据](https://api.github.com/repos/mem0ai/mem0)。
- **[S17] Graphiti**：[README](https://github.com/getzep/graphiti/blob/main/README.md)、[repo 元数据](https://api.github.com/repos/getzep/graphiti)。
- **[S18] Pi SDK**：本机所安装 `@earendil-works/pi-coding-agent` 的 `docs/sdk.md`、`docs/extensions.md`、`docs/session-format.md`、`docs/message-types.md`、`examples/extensions/todo.ts`；对应[上游 SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[todo 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/todo.ts)。本地版本优先于浮动 main。

### 维护状态核对补充

GitHub API 查询到的最近 push：Plane 2026-10-08；Vibe Kanban 2026-09-19；SlayZone 2026-09-03；pi-kanban 2026-05-13；kb 2026-03-29；Focalboard 2026-05-18。以上都不代表发布质量、活跃维护承诺或功能完备度，尤其不得用它们覆盖 Vibe Kanban / Focalboard 官方的维护状态说明。

## 13. 本次边界与未验证项

- 已完成资料检索、官方材料核对、部分竞品源码阅读、当前 Pi Web 接入分析。
- 没有运行竞品或进行横向性能测量；不将 README 的支持声明视作真机测试。
- 没有实现看板、安装 DnD/SQLite、迁移数据库或改动 session。
- 尚需技术验证：SQLite 分发、具体 DnD 版本、Safari 16.2、Pi context 注入/compaction/分支组合行为。
- 本次仅新增研究文档，因此没有运行应用测试、lint、typecheck 或构建；开发期间仍不得运行 `next build`。
