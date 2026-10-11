# 任务面板：按任务组织 session（当前范围）

## 定位与优先级

任务是 session 的组织归属，不是跨 session 共享上下文或执行编排系统。本契约覆盖旧 F21–F30 中有关共享重点、任务启动、共享更新、归档执行限制的产品行为；原文保留为历史实现及存储兼容说明，不代表这些入口仍可使用。存储格式仍以 [F21 权威表](task-dashboard.md#当前存储cas与迁移权威表)为准，不降级、不删除旧数据。

## 用户契约

- 一个任务可关联多段对话；每段对话最多归属一个任务，也可以不关联。继续保留权威项目范围：同项目才可关联，无项目聊天归无项目任务。
- [F33 项目选择与修改](task-projects.md)：创建可选 Pi 已有项目或新增目录；详情单行修改入口，跨项目先预览、确认后原子解除不兼容关联，不移动/删除/停止 session。底部不重复项目路径。
- 保留任务资料、手动状态、筛选、排序、列管理、归档恢复、批量关联、解除/改绑、从当前对话创建任务，以及复制/fork 的任务归属继承。
- 任务卡片始终显示关联对话数量，运行中额外显示运行数量；AI 运行不自动改变任务状态。
- 详情默认展开关联对话，放在资料编辑之前；用紧凑分隔行展示名称、运行状态、当前对话标记，点击直接切换聊天。标题行提供关联按钮与刷新图标，行尾菜单管理改绑/解除（有可访问名称）；关联规则说明仅在候选选择展开时显示。仅路径不同的项目会话补充路径，无项目聊天不展示内部 cwd。只在当前打开的详情加载关联目录，关闭浮层不继续加载。
- 不在详情底部重复对话数量/AI 状态。描述和完成要求为空时不渲染“未设置”占位段，编辑入口仍保留。元数据弱化展示，任务卡片数量/运行提示保持不变。
- 聊天上方以共用的单行、可截断归属栏显示任务；点击归属按钮或执行 `/task` 打开[F32 共用任务选择器](task-picker.md)，可关联、改绑和解除，不必打开面板。已关联任务的独立“任务详情”按钮直达面板；面板保留从当前对话创建任务的入口。读取失败显示未知，不把失败当作无归属。
- 浮层不卸载聊天或发送消息，关闭保留草稿；焦点、Escape/IME、长文本和窄屏行为保持原合同。
- 本阶段不提供“从任务开始执行”入口。F32 允许空白聊天预选任务，不因此创建 Agent；正常流程创建真实 session 后再关联，或直接关联已有 session。没有新 Agent 创建/发送协议，不恢复旧任务启动流程。

## 管理不干预执行

- 关联、解除、改绑、完成和归档只改变管理元数据，不改变 cwd、模型、工具权限、系统提示词或聊天历史。
- 归档不要求关联对话空闲，不停止工作，也不阻止普通聊天、继续聊天或复制/fork；继续聊天不自动恢复任务。
- 关系更新仍保留唯一 owner、generation、CAS/精确重试和项目范围验证。取消任务层归档/忙碌限制不取消 SDK 对实际复制、分支等动作本来的生命周期检查。
- 未显式预选任务的普通 prompt 不因任务读取/存储或旧 pending 共享选择而被任务准入阻断，不新增任务材料，不安装共享发送观察器。F32 的新会话显式预选先落实关联；失败保留真实 ID/草稿，用户重试或选“不关联任务”继续，不重复创建或发送。

## 暂停共享功能与兼容

- 不渲染共享重点编辑/预览/历史/恢复、AI 整理/草稿、启动材料预览、共享更新提醒/轮询、改绑时的目标共享版本。
- API/操作入口拒绝新的共享生成、发布/恢复、准备/采用、更新选择及投递操作；旧客户端也不能继续触发这些功能。读旧 board 数据的兼容能力与新执行权限分开。
- 旧 `taskStart` 请求明确拒绝，不静默转换为普通发送、不注入材料。旧准备 URL 提示重新打开普通聊天；草稿不自动发送。
- 旧 `sharedContext`、`sessionContexts`、`sessionUpdates`、receipt 等字段继续保留和校验。旧 pending 不再执行；已有 JSONL 中的任务材料及审计不回删，原生分支/压缩/上下文编辑仍决定实际输入。停用共享不等于遗忘历史。
- 聊天归属读取使用 `session-task` 元数据查询，只返回任务 id/title/archived，不水合聊天、不暴露共享历史、不唤醒 Agent；按页面切换、focus/online/可见性和本页管理变更刷新，不使用原共享功能的 5 秒轮询。

## 实现入口

- UI：[TaskDashboard](../../components/TaskDashboard.tsx)、[TaskDetails](../../components/TaskDetails.tsx)、[TaskSessions](../../components/TaskSessions.tsx)、[TaskRelation](../../components/TaskRelation.tsx)、[SessionTaskLink](../../components/SessionTaskLink.tsx)、[TaskPanel](../../components/TaskPanel.tsx)、[AppShell](../../components/AppShell.tsx)、[ChatWindow](../../components/ChatWindow.tsx)。
- 执行/兼容：[task-operations](../../lib/task-operations.ts)、[task-archive](../../lib/task-archive.ts)、[task-relations](../../lib/task-relations.ts)、[task-session-copy](../../lib/task-session-copy.ts)、[rpc-manager](../../lib/rpc-manager.ts)、[tasks API](../../app/api/tasks/route.ts)。
- 三语言文案同步 `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`。

## 验收与限制

1. 同任务至少两段 session 默认列出，当前 session 标记正确；切换会话不发 Agent 请求、不丢 composer 草稿。
2. 未关联 session 可从面板关联已有任务或创建任务；解除/改绑后聊天归属刷新，跨项目和抢占已有 owner 仍拒绝。
3. 包含旧共享历史的任务正常读取；所有 UI 无共享入口；API 拒绝新共享行为且不写 store、不调用模型。
4. 归档可在聊天运行时执行；归档后普通聊天/复制仍按普通策略运行，任务不自动恢复；旧 pending 不会注入，原历史不改写。
5. 悬浮面板开关、草稿、键盘焦点、窄屏、三语言、类型检查与局部 lint 回归。
6. F32 `/task` 的 UI/API/生命周期三个测试边界及扩展命令发现时机见[专属契约](task-picker.md)；原归属直达详情测试通过新的独立详情按钮继续验收。

[当前测试与历史套件清单](../testing/task-session-management.md)区分有效回归、显式退役的 `*.historical.mjs` 和旧专项 E2E。旧共享/启动/归档阻断测试记录属于原契约，不可直接作为本功能验证通过证明。本轮实际测试命令及结果在交付说明报告；浏览器 fixture 不等同真实 Provider、生产 SSE 或 SDK 全平台验收。未执行生产 build/install、真实模型计费、用户数据迁移、Safari/iOS 真机或 Windows 验收。

## 维护

修改时同步本合同、F21 索引及受影响的专属合同。共享 UI 与后台入口必须一起停用，不能只隐藏按钮却保留旧 pending 投递。未来恢复共享功能须明确新契约，不因兼容字段或历史 helper 仍存在而自动恢复执行。
