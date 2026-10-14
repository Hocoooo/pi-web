# 任务面板：按任务组织 session（当前范围）

## 定位与优先级

任务是 session 的组织归属，不是跨 session 共享上下文或执行编排系统。本契约覆盖旧 F21–F30 中有关共享重点、任务启动、共享更新、归档执行限制的产品行为；原文保留为历史实现及存储兼容说明，不代表这些入口仍可使用。存储格式仍以 [F21 权威表](task-dashboard.md#当前存储cas与迁移权威表)为准，不降级、不删除旧数据。

## 用户契约

- 一个任务可关联多段对话；每段对话最多归属一个任务，也可以不关联。继续保留权威项目范围：同项目才可关联，无项目聊天归无项目任务。
- Dashboard“关联已有对话”仅列同范围、未归属任务的主 session；普通独立复制/fork 仍可选，子代理及其递归后代不列入。不能仅凭 `parentSession` 过滤，因为复制/fork 也携带该字段；服务端读取有界关系元数据，并为尚未落盘的 warm wrapper 保留创建身份。无法确认关系的派生会话不进入候选，直接批量 `link` 新增此类会话亦整批拒绝。此规则只收紧 Dashboard 候选/批量关联，不改变当前对话的其他管理入口；既有子代理关联不迁移、不删除、不伪装缺失，仍显示真实运行态、可移除，旧已关联集合的精确重试保持无操作。
- [F33 项目选择与修改](task-projects.md)：创建可选 Pi 已有项目或新增目录；详情单行修改入口，跨项目先预览、确认后原子解除不兼容关联，不移动/删除/停止 session。底部不重复项目路径。
- 保留任务资料、手动状态、筛选、排序、列管理、归档恢复、批量关联、解除/改绑、从当前对话创建任务，以及复制/fork 的任务归属继承。
- 任务卡片始终显示关联对话数量，运行中额外显示运行数量；AI 运行不自动改变任务状态。整张卡片单击打开详情、任意区域可启动拖动，移除专用把手；鼠标6px阈值区分点击与拖动，触屏短按详情/长按250ms拖动/快速滑动滚动。拖动结束不误开详情，拖动时 Escape 只取消拖动；Enter/空格打开详情。详情不显示或操作“移入某状态”（待办/进行中等），只保留同状态内的上移/下移与归档；状态变更通过看板跨列拖动。
- 详情默认显示关联对话的五条预览，放在资料编辑之前；用紧凑分隔行展示名称、运行状态、当前对话标记，点击直接切换聊天。标题行提供关联按钮与刷新图标，行尾 `...` 打开与现有 UI 同主题的菜单（有可访问名称），只提供“移除”，点击直接解除任务关联，不删除/停止 session，也不打开改绑表单。键盘 Enter/方向键可打开，Escape 只关闭菜单并返回触发按钮，IME Escape 不关闭，Tab/点外部/隐藏详情或浮层关闭菜单。失败显示错误并保留原 operationId/generation/updateRevision 精确重试；显式点击刷新对话放弃旧移除请求、重读关系，下次选择使用新请求，自动刷新不静默重置 CAS；改绑继续走聊天归属选择器；关联规则说明仅在候选选择展开时显示。仅路径不同的项目会话补充路径，无项目聊天不展示内部 cwd。只在当前打开的详情加载关联目录，关闭浮层不继续加载。
- 已删除/缺失的关联对话仍显示缺失，不能打开，但详情菜单允许显式“移除”。缺失行携带真实 generation/updateRevision，解除仍校验 owner/CAS 并支持精确重试；不重建 session、不清除历史，不允许把缺失对话改绑到其他任务。
- 不在详情底部重复对话数量/AI 状态。描述和完成要求为空时不渲染“未设置”占位段，编辑入口仍保留。元数据弱化展示，任务卡片数量/运行提示保持不变。
- 聊天上方以共用的单行、可截断归属栏显示任务；点击归属按钮或执行 `/task` 打开[F32 共用任务选择器](task-picker.md)，可关联、改绑和解除，不必打开面板。已关联任务的独立“任务详情”按钮直达面板；面板保留从当前对话创建任务的入口。读取失败显示未知，不把失败当作无归属。
- 浮层不卸载聊天或发送消息，关闭保留草稿；缓存报告组件仅 active 且为所选详情时 GET/轮询，切任务、收详情和关浮层取消读取/计时器，重开重读但保留 retry/regeneration 精确操作 ID/错误，不取消后台生成或收费行为；焦点、Escape/IME、长文本和窄屏行为保持原合同。
- 本阶段不提供“从任务开始执行”入口。F32 允许空白聊天预选任务，不因此创建 Agent；正常流程创建真实 session 后再关联，或直接关联已有 session。没有新 Agent 创建/发送协议，不恢复旧任务启动流程。

归档详情另显示 [F36 报告（01–07）](task-archive-report.md) 的独立状态/来源截止/缺失与空来源档案入口；报告只冻结明确关联对话当前分支文本，不修改来源执行或原历史。已配置来源在归档提交后锁外后台独立生成，长历史完整分段并按单次容量有限分层综合；全部底层/中层真实材料目录可打开，无法容纳或收缩明确失败保留成果；生成中/失败/未知实时展示，待配置/空来源零调用，不恢复共享重点、不启动来源 AgentSession，恢复 task 不取消报告。06由Node服务启动续跑未发送阶段，已保存底层/中层不重做，sending未知不自动重发；失败/未知/待配置可明确使用当前报告设置和原快照重试，提示可能再次收费，同ID精确重试不建立第二次尝试。07在详情提供创建顺序历史与最新成功默认入口，所选报告明确重新生成使用原快照/当前设置，新UUID且同操作去重；失败/在途不遮旧成功，恢复不删历史，删除来源仍可读正文和全部材料，来源标识不伪装原历史回跳链接。

## 关联对话五条预览

- `TaskSessions` 的 `TASK_SESSION_PREVIEW_LIMIT = 5` 只控制详情列表显示：0–5 个关联条目全部显示，无更多按钮；超过五个时默认显示前五个，尾部“展开更多（N 个）”中的 N 为完整关联目录条目数减五，展开后显示全部及“收起更多”。标题与卡片仍显示总关联数，卡片运行数检查完整关联集合。
- 沿用服务端 `linked`（`task.sessionIds`）顺序，不改成最近活跃排序；计数单位是明确关联条目，缺失对话与兼容的既有子代理关联也计入，不复用[项目侧边栏](project-session-previews.md)的会话族归组。当前或运行中对话位于第六条以后时不会自动展开或置顶。
- 展开状态属于每个 task 的缓存 Inspector，任务之间独立；切任务、收详情、关闭/重开浮层及普通数据刷新均不清空，完整页面刷新或组件卸载后恢复五条。减少至五条以内时更多按钮消失，既有展开状态仍保留在内存；之后新增到六条时沿用该状态。不写 localStorage、不跨标签同步。
- 展开/收起不发请求、不改变当前聊天、任务归属、排序、存储、归档或执行状态；关联目录仍完整读取，不是 API 分页。普通关联、刷新、行点击与菜单权限保持原样。
- 被折叠的行保留挂载，以保留失败移除的原 operationId/generation/updateRevision；`hidden` 与专属 CSS 使其不占空间、不进入可访问/Tab 顺序，菜单同时以 inactive 关闭，重展开不恢复旧打开菜单。仅显式刷新对话继续按原契约重置移除请求。
- 更多按钮使用三语言文案及 `aria-expanded`/`aria-controls`，Enter/空格切换后焦点留在按钮；收起不切换或停止隐藏对话。大集合仍保留行组件，这不是虚拟化或 DOM 数量优化。

验证入口：`env -u NODE_OPTIONS node e2e/task-session-previews.mjs`。真实 TaskPanel/Dashboard/TaskSessions 与 CSS 在隔离 Chromium 中运行，仅 Next URL context 和 API 数据由 fixture 提供；不需要 Next 服务，不读取/写入用户数据，不启动 SDK 或模型。覆盖三语言 × 1100/390px 的 0/1/4/5/6/20 边界、完整数量/顺序、键盘/ARIA、零切换请求、任务状态隔离与关闭保留、当前/运行/缺失对话、折叠后移除精确重试、减至五条、关联/刷新/会话切换及页面刷新重置。此浏览器覆盖不代表真实后端/provider、生产服务、Safari/iOS/Windows 真机或极端容量验收。

## 管理不干预执行

- 关联、解除、改绑、完成和归档只改变管理元数据，不改变 cwd、模型、工具权限、系统提示词或聊天历史。
- [F34 对话归档](session-archive.md)不改变任务归属/状态，详情仍可打开归档对话。[F35 一次性联动](task-session-archive.md)：Dashboard 归档任务先预览当前关联会话族，涉及其他任务须额外确认；成功后联动隐藏该固定范围。恢复任务不恢复对话，后来关联/fork 不自动归档；部分失败保留可发现的固定重试意图。
- 归档不要求关联对话空闲，不停止工作，也不阻止普通聊天、继续聊天或复制/fork；继续聊天不自动恢复任务。F36（02）归档会只读采样来源运行态并冻结文本，采样不是 idle/busy gate；整任务保留回归单独断言新增 `reportIds` 与恢复保留，不把报告引用误认作资料/CAS 被改写。
- 关系更新仍保留唯一 owner、generation、CAS/精确重试和项目范围验证。取消任务层归档/忙碌限制不取消 SDK 对实际复制、分支等动作本来的生命周期检查。
- 未显式预选任务的普通 prompt 不因任务读取/存储或旧 pending 共享选择而被任务准入阻断，不新增任务材料，不安装共享发送观察器。F32 的新会话显式预选先落实关联；失败保留真实 ID/草稿，用户重试或选“不关联任务”继续，不重复创建或发送。

## 暂停共享功能与兼容

- 不渲染共享重点编辑/预览/历史/恢复、AI 整理/草稿、启动材料预览、共享更新提醒/轮询、改绑时的目标共享版本。
- API/操作入口拒绝新的共享生成、发布/恢复、准备/采用、更新选择及投递操作；旧客户端也不能继续触发这些功能。读旧 board 数据的兼容能力与新执行权限分开。
- 旧 `taskStart` 请求明确拒绝，不静默转换为普通发送、不注入材料。旧准备 URL 提示重新打开普通聊天；草稿不自动发送。
- 旧 `sharedContext`、`sessionContexts`、`sessionUpdates`、receipt 等字段继续保留和校验。旧 pending 不再执行；已有 JSONL 中的任务材料及审计不回删，原生分支/压缩/上下文编辑仍决定实际输入。停用共享不等于遗忘历史。
- 聊天归属读取使用 `session-task` 元数据查询，只返回任务 id/title/archived，不水合聊天、不暴露共享历史、不唤醒 Agent；按页面切换、focus/online/可见性和本页管理变更刷新，不使用原共享功能的 5 秒轮询。

## 实现入口

- UI：[TaskDashboard](../../components/TaskDashboard.tsx)、[TaskDetails](../../components/TaskDetails.tsx)、[TaskSessions](../../components/TaskSessions.tsx)、[TaskSessionMenu](../../components/TaskSessionMenu.tsx)、[SessionTaskLink](../../components/SessionTaskLink.tsx)、[TaskPanel](../../components/TaskPanel.tsx)、[AppShell](../../components/AppShell.tsx)、[ChatWindow](../../components/ChatWindow.tsx)。
- 执行/兼容：[task-operations](../../lib/task-operations.ts)、[task-archive](../../lib/task-archive.ts)、[task-relations](../../lib/task-relations.ts)、[task-session-copy](../../lib/task-session-copy.ts)、[rpc-manager](../../lib/rpc-manager.ts)、[tasks API](../../app/api/tasks/route.ts)。
- 三语言文案同步 `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`。

## 验收与限制

1. 同任务 0–5 段 session 默认全部列出；超过五段只预览前五段，更多/收起数量及顺序正确，标题/卡片保留总数。当前 session 的可见行标记正确，隐藏当前/运行中对话不自动突破五条；切换会话不发 Agent 请求、不丢 composer 草稿。五条预览的独立状态、移除重试及刷新边界用 `e2e/task-session-previews.mjs` 验证。
2. 未关联 session 可从面板关联已有任务或创建任务；详情菜单移除或聊天选择器解除/改绑后聊天归属刷新，跨项目和抢占已有 owner 仍拒绝。菜单打开/取消不 POST；缺失会话可移除且非零关系版本正确；检查失败/丢响应重试 UUID 与 CAS 不变、移除后详情保留、三语言×两主题390px菜单不越界（`e2e/task-dashboard-panel.mjs`）。
3. 包含旧共享历史的任务正常读取；所有 UI 无共享入口；API 拒绝新共享行为且不写 store、不调用模型。
4. 归档可在聊天运行时执行；联动预览/跨任务确认/失败恢复验收见 [F35](task-session-archive.md)。任务恢复不恢复会话，后来关联/复制不自动归档；普通聊天/复制仍按普通策略运行，任务不自动恢复；旧共享 pending 不会注入，原历史不改写。
5. 悬浮面板开关、草稿、键盘焦点、窄屏、三语言、类型检查与局部 lint 回归。整卡点击/拖动使用 `e2e/task-dashboard-card.mjs`（全 API fixture、临时真实 store）覆盖鼠标/键盘/390px CDP触屏，面板既有回归仍用 `e2e/task-dashboard-panel.mjs`。
6. F32 `/task` 的 UI/API/生命周期三个测试边界及扩展命令发现时机见[专属契约](task-picker.md)；原归属直达详情测试通过新的独立详情按钮继续验收。

[当前测试与历史套件清单](../testing/task-session-management.md)区分有效回归、显式退役的 `*.historical.mjs` 和旧专项 E2E。旧共享/启动/归档阻断测试记录属于原契约，不可直接作为本功能验证通过证明。本轮实际测试命令及结果在交付说明报告；浏览器 fixture 不等同真实 Provider、生产 SSE 或 SDK 全平台验收。Windows Node/SDK 单测已纳入[2026-10-13 平台验证](windows-test-portability.md#任务看板安装前修复2026-10-13)：会话夹具使用 SDK 原生 cwd 编码，HTTP 夹具统一 Jiti 错误模块身份，保留全部历史/项目范围/CAS 断言。这不等于生产 build/install、真实模型计费、用户数据迁移、Windows 浏览器/ACL 或 Safari/iOS 真机验收。

与[每轮自动标题 F37](automatic-session-titles.md)整合后，普通成功聊天可能另有后台命名请求；它不是任务共享生成或 pending 投递。lib/task-management.test.mjs 的主 prompt 次数断言通过公开会话开关显式关闭自动标题，仅隔离测试边界、不改变产品默认值；自动标题收费/完成/取消语义由其专属 SDK 和浏览器测试覆盖。

主 session 候选回归：`node --experimental-strip-types --test app/api/tasks/sessions.test.mjs lib/task-sessions.test.mjs lib/subagent-extension-scope.integration.test.mjs`，覆盖 cold/cache、warm 尚未落盘、子代理重开、递归子代理、普通 fork 保留、混合批次整批拒绝及既有子代理关联仍可管理；隔离临时数据、不调用真实模型。

## 本次主 session 候选验证

- 首先以真实 SDK/隔离临时目录的 tasks HTTP 路由测试复现子代理混入，再修复通过；候选读取不改变 board/native history 字节。
- 扩展 tasks API、task/session/RPC/subagent 回归：721 项通过、5 项平台跳过；`tsc --noEmit`、全仓 lint、`git diff --check` 通过。
- 当前 Node 26 环境中 `lib/task-session-copy.test.mjs` 的三项写入故障注入测试在修改前 HEAD 隔离副本同样失败（HTTP copy structured failure、SDK child relation write failure、runtime clone relation-write failure）。扩展绿色回归显式排除这三项，不宣称未过滤的全量套件通过，未修改无关复制实现/故障注入 fixture。
- 本轮未执行浏览器 UI、Windows/Safari 真机、真实 provider 或安装/服务重启；专项只使用临时数据及 faux provider。

## 维护

修改时同步本合同、F21 索引及受影响的专属合同。共享 UI 与后台入口必须一起停用，不能只隐藏按钮却保留旧 pending 投递。未来恢复共享功能须明确新契约，不因兼容字段或历史 helper 仍存在而自动恢复执行。
