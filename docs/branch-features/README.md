# 当前分支功能契约与验收索引

## 当前任务范围调整（优先于旧任务执行描述）

**任务面板现阶段仅管理 session 归属。** [F31：任务 session 管理](task-session-management.md)覆盖 F21–F30 中共享重点、AI 整理、任务启动、共享更新及归档执行限制的旧行为：F22/F24/F26/F28 暂停新执行并移除 UI；F27 归档不再限制聊天，F30 关系更新不要求 active/idle。下面旧阶段的 resolved/验收记录不代表这些功能仍启用；v7 存储及历史兼容继续保留。

[F32：聊天任务选择器](task-picker.md)扩展 F31 的入口：`/task` 与归属按钮共用键盘弹窗，支持新会话预选和已有会话关联/改绑/解除，不打开任务面板、不恢复共享或任务执行。详情保留独立按钮。

[F33：任务项目选择与修改](task-projects.md)扩展创建与详情入口：可选 Pi 已有项目或新增目录；跨项目修改经预览确认后原子解除不兼容对话，不修改对话 cwd 或执行状态。

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

## 最新上游整合

- 2026-10-08：个人分支的 27 个提交重放到 `origin/main` 的 `cf3ebfb`（Pi Web 0.10.0 / SDK 1.0.0）；详见 [整合记录](rebase-0.10.0.md)。
- 下文各功能的初始基线用于解释来源，不替代该次整合的验证结果。固定聊天目录、两步设置的忙碌保护属于有意保留的个人行为差异。

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
| F14 | [本地全局安装与个人版本维护](local-global-install.md) | Windows/macOS 隔离构建与直接覆盖，不备份旧包/自动回滚；重启与 no-wait 显式授权，不发布 npm | .pi/skills/pi-web-local-global-install |
| F15 | [开发环境 Service Worker 清理](dev-service-worker-cleanup.md) | 非生产模式注销遗留 worker、清理 pi-web 缓存，同时保留主题恢复与生产 PWA | PwaRegistration、theme 初始化脚本 |
| F16 | [Windows 无窗口启动链](windows-silent-start.md) | 隐藏 Next 与浏览器辅助控制台，保留日志和生命周期；区分无窗口与 no-open | bin/pi-web、安装器 launch |
| F17 | [消息与会话性能统计](message-performance.md) | 服务端首有效输出 TTFT、持久化 tok/s、会话加权速度与平均 TTFT；缺失样本不补零 | request-performance、session-stats、MessageView、AppShell |
| F18 | [输入时草稿补全](draft-completion.md) | 默认关闭；独立模型续写未发送草稿，Tab 只采纳；新/休眠会话不启动 AgentSession | draft-completion API、useDraftCompletion、ChatInput、SettingsPanel |
| F19 | [独立聊天与固定隐藏工作区](independent-chat.md) | 无项目直接对话，入口在“会话项目”选择器内；固定 cwd 保持跨日历史，权限与界面均与项目会话一致，侧栏显示“对话” | default-cwd、NewSessionProjectPicker、AppShell、SessionSidebar、rpc-manager、session-reader |
| F20 | [macOS 服务重启与运行诊断](macos-service-lifecycle.md) | 默认 Terminal 私有交接、显式用户级 LaunchAgent、独立 restart 命令；不转储环境、不自动授予权限，诊断失败不假报 verified | 安装器 mac-terminal/mac-launchagent、service-health API |
| F21 | [任务看板、资料编辑、手动排序、全局列与已有对话关联](task-dashboard.md) | 按钮唤起的 Settings 风格悬浮面板、紧凑卡片（整卡单击详情/拖动、键盘与触屏）/独立详情抽屉（无状态选择器）、主次筛选与条件标签、关闭保留草稿、[全界面UI检查](../testing/task-dashboard-ui.md)、用户确认状态；单任务邻居移动、全局稳定列、原子批量关联、权威项目scope、metadata-only运行提示；统一存储/CAS/迁移权威表 | tasks API/page、TaskDashboard/Details/Sessions/DragTargets/ColumnSettings、task-operations/store/types/sessions、worktree/scanner/RPC、proxy、SessionSidebar |
| F22 | [人工共享重点版本（暂停）](task-shared-context.md) | F31 暂停编辑/审核/发布/历史/恢复 UI 与新操作；保留不可变 current/history、来源、独立 CAS/receipt 的旧数据兼容，下文原06验收仅作历史 | TaskSharedContext/TaskContextPreview、task-context、task-operations/store/types |
| F23 | [任务筛选、自动排序与保存视图](task-views.md) | 六条件/无项目/稳定列ID/unknown运行态；自动排序不写回手动；views独立CAS/精确receipt，过滤移动/固定双草稿，05 resolved | TaskViewControls、TaskDashboard、task-view/task-saved-views、task-types/store/operations |
| F24 | [主动AI整理共享重点（暂停）](task-ai-summary.md) | F31 移除任务/当前对话的整理和草稿入口，所有 summary-* 新操作在存储/模型调用前拒绝；旧 AI 来源数据保留，原07执行测试明确退役 | task-summary/types、TaskSummary、task-context/operations、Dashboard/Sidebar |
| F25 | [复制/fork继承任务](task-session-copy.md) | 11已主集成并验收resolved：原clone/fork/fork_branch新SDK session继承唯一关系、source-owner CAS/权威scope、durable intent/精确receipt；异常2xx保留UUID、未知结果人工检查后显式新tab尝试；不伪造08采用 | rpc-manager、agent-client、task-session-copy、task-operations/store、agent route |
| F26 | [任务准备对话与独立发送（暂停）](task-start-chat.md) | F31 移除开始执行/材料预览；旧 taskStart 在路由 startup/权限变更前及 wrapper 再次拒绝，旧准备 URL 明确提示；普通聊天后关联 session，不再注入任务资料，旧 receipt/native 历史兼容 | TaskStart、ChatWindow/useAgentSession、task-start/types/store/operations、agent/new、rpc-manager |
| F27 | [任务归档与恢复](task-archive.md) | 可发现归档列表/恢复、独立 archive CAS/精确 receipt；F31 归档只改变管理显示，不要求 session 空闲、不阻止聊天/关联/复制，不 Stop/自动恢复/自动完成，保留全部历史 | task-archive/types/store/operations、rpc-manager、agent routes、TaskDashboard/Details |
| F28 | [已有对话显式接收共享更新（暂停）](task-context-updates.md) | F31 移除版本/更新 UI 及其轮询；拒绝新选择/投递，普通 prompt 不消费旧 pending、不安装发送观察器；保留 choices/deliveries/native 历史，暂停不等于遗忘 | TaskContextUpdates/ChatWindow、task-context-updates/update-send、task-start/types/store/operations、RPC/tasks API |
| F29 | [安全删除状态列](task-column-removal.md) | 14 resolved：done/lastunfinished保护、独立完成确认、完整ordered源摘要/有界请求、hidden/archive原子迁移、旧board receipt返回当前派生digest、删todo两create首unfinished；与10联合回归 | TaskColumnSettings、TaskDashboard、task-operations/store/types、tasks API |
| F30 | [解除/改绑任务关系](task-session-relation.md) | F31 关系只管理归属，不要求任务 active 或 session idle；仍保留同锁权威 scope、唯一 owner、generation/CAS/精确 receipt、旧 pending 清理和复制 ABA 保护，不改 cwd/模型/工具/原生历史 | task-relations/operations/store、TaskRelation/TaskSessions/Dashboard、task-summary/start/context-update-send/session-copy |
| F31 | [任务 session 管理](task-session-management.md) | 任务详情以关联对话为主体、当前会话归属与直达入口、卡片数量/运行提示；管理与执行解耦，停用共享/启动/更新路径，旧数据与历史兼容保留 | TaskDashboard/Details/Sessions/Relation、SessionTaskLink/ChatWindow/AppShell、task-operations/relations/archive/session-copy、rpc-manager |
| F32 | [聊天任务选择器 `/task`](task-picker.md) | 紧凑主题选择器、单行归属栏、全键盘/慢保存焦点约束与状态本地化；新会话预选不启动 Agent，正常创建后关联；已有会话关联/改绑/解除；同项目/归档/CAS、失败草稿与 ID 保留、详情独立入口 | TaskPicker/TaskSelectionDialog/SessionTaskLink/ChatInput/ChatWindow、useTaskSelection/useAgentSession、tasks API/task-types/task-operations |
| F33 | [任务项目选择与修改](task-projects.md) | 合并 Pi 对话与任务项目、复用目录新增/选择、同项目保留关联、跨项目预览确认后原子解除；项目 CAS/精确重试、不改聊天执行；真实隔离服务浏览器验收 | TaskProject/Dashboard/Details/Inspector、tasks API、task-operations/store/types |

## 任务功能历史快照（2026-10-09 文档收尾；当前范围见 F31/F32/F33）

- **01–14 全部已由父代理按各票范围验收 resolved**；10 最终独立主复审见 `/tmp/t10mr-mus4_2wp/REPORT.md`，修复证据见 `/tmp/t10fix-l8beyj3o/REPORT.md`。最终独立综合核验及父review已完成，见[最终接受记录](../../.scratch/task-dashboard/FINAL-ACCEPTANCE.md)；仅已执行范围通过，不代表全平台/真实provider验收。
- 当前存储为 **v7**；唯一的[当前 schema、独立 CAS 与迁移表](task-dashboard.md#当前存储cas与迁移权威表)由 F21 维护，其余任务合同引用它。14 `columnRemovalDigests` 同锁派生、不持久；09 选择 ≠ native append ≠ 成功 SDK input/response ≠ provider wire/read。
- [阶段验证历史附录](task-dashboard-validation-history.md)保留失败因果、原 claimed 时点和证据指针；[65 US / 24 T coverage ledger](../../.scratch/task-dashboard/FINAL-COVERAGE.md)按执行层级与未验边界分列，不把计划/静态检查算执行通过。

| F21 | [每轮结束自动更新会话标题](automatic-session-titles.md) | 服务端整轮结束后台命名，保护手动标题；会话级开关、去重/过期保护与 next-cue 兼容 | auto-session-title、session-title、rpc-manager、会话 API、AppShell、useAgentSession |
| F40 | [原视频附件（01–09 已 review / resolved）](video-attachments.md) | 单 MP4/AVI 共用上传/skip、原生引用、精确 tapsvc/SDK auth＋Google、20 MiB/完整32 MiB；失败恢复/未知不自动重发、有效上下文/压缩/分支/复制、原 SDK 队列/Stop/Recall、项目/无项目与 Chat-only | VideoAttachmentPicker、ChatInput/ChatWindow/MessageView、useAgentSession/draft-store、video-transport/input-binding、session-reader、agent routes |

## 视频附件：01–09 全部已独立 review / resolved

[F40](video-attachments.md)记录选择/拖入、上传、原生引用、恢复、重开/追问、压缩、分支/复制、队列/Stop/Recall 与会话模式/模型切换的稳定契约。精确 tapsvc，无别名/fallback、SDK 或全局配置修改。实际 SDK/Google final-fetch、mounted browser、历史真实 Next/AppShell MP4/AVI 各一次200严格分层；571项开发期有界回归不等于全量，任务复制原三项故障注入失败和一次未知根因恢复超时风险保留。[公开验收摘要与可执行命令](video-attachments-acceptance.md)不依赖本地 scratch、临时捕获或会话正文。


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
- 保留上游按浏览器标签页恢复会话、URL 导航、项目/worktree 归属与阅读位置恢复；显式用户导航必须压过陈旧异步恢复。子目录的 worktree 列表不得将其独立项目身份借给仓库顶层会话，避免 benchmark 会话切回旧会话时清空 `?session=`；见[全项目侧边栏](all-projects-sidebar.md#子目录会话导航回归)。
- F19 的无指定目标首页默认进入聊天，空白聊天用 `?chat=1`；聊天使用固定隐藏 cwd 与独立身份，但在权限、界面与列表上都与普通项目一致，侧栏显示“对话”而非内部路径。项目功能的浏览器验收须显式进入项目 URL。
- F21 看板由侧栏按钮打开首页上的持久悬浮面板，默认紧凑卡片、筛选折叠、右侧详情；旧 `/tasks` 重定向首页同一浮层。打开/关闭不导航或卸载聊天，关闭保留任务草稿且取消 modal 标记/后台轮询；显式关联聊天/任务准备经 shell 选择回调而非仅 query 导航。以下原 `/tasks` departure 停放逻辑仅兼容旧离页路径，不是新按钮工作流；任务存储与 session 分开，复用服务端项目身份，但任务目录/文本不授予文件访问，也不启动 Agent。Link 及 history 后退/前进离开的往返复用标签页 cwd/内存停放草稿保留空白 composer 文字和图片，仅真正 `/tasks` layout departure 保存一次最终快照（Link 点击不提前保存，慢路由期间编辑/清空/删图不重复合并），不全局取消草稿弃用清理，不创建 session/发送消息保存；显式 URL、普通新建、项目切换仍优先。后续票据沿用同一个任务操作入口，创建幂等身份使用不可变原创建内容，不依赖目录现状或可变标题等。03 以服务端数组为唯一手动顺序，移动只有单任务+邻居/列边缘锚点，不用可见数组覆盖全量任务；06 使用独立 currentVersionId CAS 发布人工知识，不推进资料/顺序 revision 或破坏 moveReceipt，恢复确认成为新版本且保留中间历史；权威响应/失败同步和精确重试保留 02 草稿的原 base revision；联网恢复/focus/手动重读不等于确认移动，不能清掉未确认移动的错误与原请求重试入口。04来源创建/批量关联同锁验证存在/唯一所有权/当前scope，await既有uncachedworktree身份而非展示cache，source指纹已提交重试优先；迁移遵循F21权威表，不猜未发布源-only v3；metadata与running快照不启动Agent/扫描正文/改变任务状态。13 列配置存于同一 board，新增均未完成，done 身份不随文案/参数改变；columnsRevision 与 task/order revision、知识 currentVersionId CAS 独立，改列不改变任务字段/历史/receipt；列设置草稿重读不自动 rebase，所有操作返回当前同锁配置。

- F24 的07只扩展知识source严格union，不迁移或伪造旧manual/restore来源，旧指纹保持；新AI receipt另绑定generationId。生成结果只有draft，经06确认前不改current；固定task/base的草稿在05过滤隐藏/运行unknown/排序重挂载时仍保留，来源关系/branch变化不得错发布。08主resolved见F26；11主resolved见F25，不改变07父验收。
- F26仅把08首次新启动选择receipt保存为sessionContexts，绝不当作native append/provider已读。11 child不复制source tuple；显式Continue按SDK活动分支raw custom entry显示可追溯原版本/来源，压缩或context_edit可能排除实际输入，不重注入、不追latest。source receipt-only Stop仍只在source Continue补原snapshot。统一迁移按F21权威表保留sessionCopies、views、AI/manual/restore历史与各CAS/receipt；08已resolved，证据见专属合同。
- F25复用F21唯一关系与权威scope，内部sessionCopies跟踪原复制结果，不破坏07严格AI来源、所有旧CAS/receipt。原SDK历史不重拼；06latest不等于fork采用，08接缝不能把source严格new-start receipt复制给child或伪造child provider调用。SDK创建与board提交不是跨文件原子，未知结果拒绝旧intent；人工检查后在无opener空tab明确新尝试可能重复/遗留孤儿，不自动换ID/猜parent链。
- F23 使用同一个board的viewsRevision/savedViews；legacy双字段absence-only与当前必填规则只见F21权威表；不重置partial/invalid。筛选/排序纯投影，03单UUID/邻居移动、02/06草稿固定base、04count/source导航保留；自动同列禁调序、跨列edge后自动呈现。unknown running不匹配idle，14删列完整保留未知ID条件/receipt并fail-closed，不能扩大结果。后续集成须按域保留字段/CAS，不整文件覆盖。

- F27（12）归档scope是F23六条件之外的纯投影，不改savedViews。active/busy guard与F26 admission共用同board锁及原wrapper pendingPromptCount；来源关系/复制向归档目标只接受idle，当前知识/历史/所有CAS与receipt不变，不伪Stop/done/模型已读。09采用/clear复用此guard，14仍可移动归档task；两票迁移按字段语义合并，12/09/14均已分别验收resolved，不互相替代证据；主证据 `/tmp/m12-39pOIJ/REPORT.md`。外部进程/扩展直接绕wrapper不宣称受控，详见F27管理边界。

- F28（09）当前存储/迁移见F21权威表，保留12archive CAS/receipt及05/07/08/11全部事实，缺必填域或损坏拒读。原prompt最早预留仍在所有await前，09只扣本次发送自身预留判断idle，不忽略其他pending/queue/UI；pending领取/再次权威验证/complete同锁拒archived，select/state/CASclear只管理持久意图，不restore/abort/prompt。10已resolved，同锁clear与关系变更原子提交；14已resolved，见F29。选择receipt、原生append、成功input/response与实际Provider捕获分层，拒绝/Stop/authfail不伪used；Continue以native lineage防V2→V1回拨，projection按sourceEntry.id且发送要求request-local贡献引用与SDK stream实际输入完整锁定正文同时成立，另一entry同正文不代证；converter脱敏/截断只保留pending、不补原文（R1/R2独立主复审已关闭，父R3累计15项复核通过，09已resolved，证据/tmp/m9f-x4GgSR）；详见F28主证据与未验边界。

- F29已在当前统一存储集成；columnRemovalDigests只是同锁board派生响应，所有旧board receipt确认返回当前map，不持久或推进09独立session CAS。完整源digest绑定task revision（包括field/link/08/11关系修改）与archiveRevision/ordered set，09选择/投递与知识独立域不失效scope。迁移只改columnId/task revision/updatedAt，归档/pending/历史与所有旧receipt保持；actualSend仍遵守12guard及09entry identity/贡献引用/完整stream输入。10关系修改推进双方task revision并同锁clear旧pending，联合入口 `lib/task-relation-column-removal.test.mjs`；10与14独立主复审各自有效，不互相冒称执行。

- F30（10）按F21权威表保留全部域与receipts，sessionIds仍唯一owner，sessionRelations仅generation/latest receipt。source/target关系revision使14旧全源摘要失效，pendingclear与关系变更同锁原子；07snapshot/authdispatch/response/result/publish、08prepared/start/recovery、09pending/authority/latecomplete与11prepared intent统一校验owner+epoch，拒A→B→A与null-owner ABA新执行。已提交publish/completedcopy/latestrelation receipt仅确认旧事实，不能重绑/清新pending。columnRemovalReceipt保留，所有board-returning精确retry同锁最新digest map且不持久；删列不清采用/epoch，archiveowner不能reassign/newsend绕过恢复。原最早reservation/active/allbusy/权威project及UI旧历史警告保持，10已获最终独立主复审并由父验收resolved；最终综合/平台验证另列，不继承该结论。

### 运行时与外部副作用

- F02 改主会话设置；F10 的建议模型选择不改主会话；F13 的建议不授权执行子代理。
- F01 的 headless 模式不能误删正常 Web 会话的扩展 UI。
- F11 必须经过文件授权，不因“本地部署”而放开任意文件系统路径。
- F18 会上传未发送草稿，必须独立 opt-in，不能继承 F10 开关；仅使用独立推理，不创建主会话运行时。
- F21 的标题请求不延迟 F01 的整轮完成；仅标题元数据移动 leaf 不应使 F10 重生成/丢弃建议，真实分支/对话变化仍须保护。
- F10/F13/F18/F21 可能产生外部推理请求；F11 可启动桌面程序；F14 可影响全局安装与服务。文档验收不能默认授权在用户真实环境执行这些副作用。
- F20 改变 macOS 的 F14 重启方式，不改变 F16 的 Windows 隐藏链；注册 LaunchAgent/登录项、打开真实 Terminal、重启当前服务仍需操作授权。运行诊断不扩大项目文件访问权限，也不继承 Terminal 的 TCC 授权。

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
- Windows / SDK 1.0 的模块身份、换行、MCP fixture 清理及安装器隔离条件见 [Windows 全量测试验证契约](windows-test-portability.md)；平台能力跳过必须明确记录，不能算作通过。
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
