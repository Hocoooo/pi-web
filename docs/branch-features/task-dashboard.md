# 任务看板：持久任务、资料编辑、手动排序、全局列与已有对话关联

## 当前范围：session 管理

当前行为以[任务 session 管理契约](task-session-management.md)为准：详情默认展开关联对话、聊天显示任务归属；共享重点/AI 整理/任务执行准备/共享更新退出 UI 与新执行路径。归档仅管理显示，不阻止聊天。以下共享功能及执行限制的原验收说明是历史记录；存储 v7、迁移校验、独立 CAS、排序/列/筛选和唯一关系仍保留。

## 当前简洁 UI

关联对话采用分隔列表，标题行提供关联与刷新；行尾 `...` 仅弹出“移除”菜单，直接解除任务关联、不删除或停止对话，改绑通过聊天归属选择器；关联政策按需显示，不重复对话数量/运行摘要，不为未填写的描述/完成要求生成占位段。聊天归属使用[F32 紧凑任务选择器](task-picker.md)和共用单行入口，详情保持独立按钮。当前浏览器验证使用 `e2e/task-dashboard-panel.mjs` 与 `e2e/task-picker-page.mjs`；不以以下旧共享界面测试证明新行为。整卡交互见下文：单击详情、整卡拖动；不改变存储、排序意图、CAS、归档或会话关联规则。

## 筛选简化与全界面检查（2026-10-10）

默认筛选仅搜索/项目/排序，更多条件按需展开，已选条件可移除；归档卡片标记和归档数量清晰。`TaskInspector` 独立于卡片投影，只缓存查看过的详情；关闭详情保留关联选择/准备预览等局部状态。移列、归档、过滤不会卸载当前详情；任务操作错误/重试在抽屉内，滚动时关闭栏保持可见。二级流程及子组件局部取消后焦点恢复到浮层；隐藏期间整理完成不抢聊天焦点，也不把聊天记录为详情的返回目标；各 Escape 同时保护 IME 两种信号。共享重点长代码/表格、长名称/路径、复选框/选择框及独立横滚边界已检查；活动失败对话行显示未知。

新增 [完整 UI 检查记录](../testing/task-dashboard-ui.md) 与 `e2e/task-dashboard-ui.mjs`：104 个流程/渲染场景（含鼠标/CDP触摸、320/360/390/平板/横屏/桌面、浅深色和三语言）；原 panel 浏览器回归及 97 项定向测试通过。关联/整理/准备使用合成响应；不代替真实 provider、平台、权限/发送整合验收。旧独立页 E2E 尚未全面迁移。

## 范围与当前状态

由侧栏按钮唤起、覆盖当前聊天的任务看板悬浮面板；旧 `/tasks` 重定向到首页的同一面板。任务不是 session 内 todo、聊天正文或 Agent 运行状态。每任务可无项目或只属于一个服务端解析的项目；每 session 最多一个任务 owner。**01–14 全部已由父代理按各票范围验收 resolved**（2026-10-09）。当前成果包含未提交文件，HEAD `85cc4f38b563053b4e473e50257cde3c9cb6d931` 只是固定基线，不代表当前文件快照。

本合同维护基础01、资料02、移动03、关联04、列设置13及统一存储边界。专属合同：[视图05](task-views.md)、[人工知识06](task-shared-context.md)、[AI整理07](task-ai-summary.md)、[准备发送08](task-start-chat.md)、[显式更新09](task-context-updates.md)、[改绑10](task-session-relation.md)、[复制11](task-session-copy.md)、[归档12](task-archive.md)、[删列14](task-column-removal.md)。浏览/创建/保存/菜单移列不启动模型或休眠 Agent，不注册任务工具。完成仅由用户移入稳定 `done` 列决定，运行结束/失败/声称完成/摘要/归档不自动完成。

[验证历史附录](task-dashboard-validation-history.md)记录阶段失败、恢复与原报告指针；[65 US / 24 T coverage](../../.scratch/task-dashboard/FINAL-COVERAGE.md)分层列证据。各票 resolved 不代表最终综合核验或所有平台通过；最终综合核验仍在独立收尾。

## 入口、默认值与交互

### 导航与草稿

- 侧栏单一“任务看板”图标按钮打开 Settings 风格居中浮层，不改变 URL、不卸载聊天、不创建或发送会话。关闭按钮、背景或 Escape 关闭；任务不进入 session 列表。
- 首次打开后 TaskPanel 保持挂载；关闭只隐藏，任务编辑/新建/筛选/保存视图等页面内草稿保留。隐藏时停止看板 refresh/activity listeners，以及缓存 Inspector 的报告 GET/轮询（仅 active 且所选详情读取，切任务/收详情同样取消，重开重读；精确操作 ID/错误保留，不取消后台报告生成），不留下 `aria-modal` 标记阻断聊天快捷键。重新打开重读权威状态，不重置固定草稿 base。整页刷新/离开页面仍不保证任务草稿。
- 旧 `/tasks?sourceSession=…` / `summarySession=…` 重定向 `/?tasks=1&…`，消费首次参数时保留原创建/整理入口；后台初始化 cwd/URL 不关闭面板。
- 对话链接/准备后进入聊天通过 TaskPanelNavigation 调用 AppShell 的既有选择/新建逻辑，而不是只改 query。跳转序号与 workspace intent 拒绝迟到响应；关闭面板/后续选择使旧请求失效。同 cwd 准备把当前 composer 直接转移到准备身份，不经可能已有旧草稿的公共 parking slot 合并。准备 token 由 shell 持有，普通 New/选择同步清除，不依赖 URL 完成；native promotion 不覆盖重核材料。不自动发送，修改键打开对话链接仍使用原生新标签页行为。
- 焦点进入面板，Tab 在面板（详情打开时在详情）内循环；关闭恢复触发按钮。IME Escape 不关闭；详情 Escape 先收详情，目录选择器 Escape 只关闭上层。目录选择器在面板之上，隐藏父面板不留下 portal。
- 显式不同 cwd/session、普通 New、picker 切项目与 `/new` 优先；不创建session/发送消息来保存。草稿仅页面 JS 内存，不承诺刷新/关tab保留。关联合同：[独立聊天](independent-chat.md)、[项目选择](new-session-project.md)、[全部项目侧栏](all-projects-sidebar.md)。

### 全局列设置（13；删除另见14）

- 初始稳定ID顺序 `todo`、`in-progress`、`review`、`blocked`、`done`；所有项目/无项目共用，只有 `done` 完成。首次初始化及合法早期迁移加默认一次；删列后不能重新补五列。
- 列设置复用 SettingsUi detail header/stack、scope tag、button、footer/status；不是项目覆盖或第二 settings.json。新增 UUID 列总是未完成；改名“已完成”不能变完成，done改名“待办”仍完成。
- 名称trim、非空单行、最多100 JS字符，最多100列；原默认label为null保留本地化，用户名称纯文本。新增/改名/重排保留所有现有列；删除只能走14专用确认，不能借set-columns删列。
- 名称/顺序草稿固定初次打开 columnsRevision；refresh/focus/online不rebase。冲突须明确刷新、取消重开；取消不POST，失败留输入/旧板。丢响应可能已提交，旧revision严格conflict，不猜幂等或另造设置receipt。Tab/Enter/触摸按钮调序，手机输入16px。
- 14确认完整ordered源范围（含全部hidden/archive），done与lastunfinished受后端保护，targetdone另勾完成确认。`columnRemovalDigests`仅响应派生；固定请求<512bytes而HTTP仍256KiB。详细顺序/receipt/容量见[删列合同](task-column-removal.md)。

### 创建、详情与资料（01/02）

- 创建保存标题（必填、trim、200字符）、说明/完成要求（各20,000字符）、可选一个cwd；复用DirectoryPicker并可输入/清空。取消复用三语言有效 `sidebar.cancel`，只关闭、不写任务或Agent请求。
- 默认卡片仅显示标题、优先级、最多两个标签及余量、项目简称/明确无项目、对话数或工作提示，不再提供独立拖动把手。整张卡片（包括标题、项目、标签、数量及空白）单击打开右侧详情抽屉；卡片是单一可聚焦按钮语义，Enter/空格同样打开详情，提供可访问名称、展开状态及焦点边框。完整资料、全部标签/项目路径、更新时间（time完整ISO、本地显示）、归档与键盘上/下调序进入详情，边界禁用不变。详情不显示当前状态选择器或“移入某状态”操作；状态变更通过看板跨列拖动，上/下按钮只调整同状态内的顺序。详情对话菜单移除在原详情内完成，不收起详情；改绑通过聊天归属选择器，不恢复旧详情确认表单。
- 普通资料编辑仅标题、说明、完成要求、优先级、标签，不隐式修改项目/状态。项目使用 [F33](task-projects.md) 独立选择/预览/确认入口；底部不重复项目路径。成功后卡片与详情同记录；说明/要求保留原文字。
- 优先级整数0低、1普通默认、2高、3紧急；共用compareTaskPriority降序，同值createdAt升序、UUID code-point升序，全同键0。最近更新排序独立updatedAt降序/createdAt升序/UUID升序；05均纯投影，不写手动顺序。
- 标签默认[]，最多20项、每项50 JS字符、非空单行；API trim、大小写敏感去重保首次顺序，限额在规范化前校验。公共JS入口逐槽检查稀疏数组，空槽拒绝而非写null。编辑器每行一个、逗号可作普通文字。
- 资料/知识/AI草稿按task ID分别停放，固定首次revision/current base。refresh/focus/online、过滤隐藏或移列重挂载不清输入/rebase；失败alert留输入，取消重开才采用新base；多任务草稿互相独立。

### 拖动、顺序与失败（03）

- 整张卡片激活拖动，不必命中特定按钮；表单/详情/菜单不在激活区。卡片上半before、下半after、列空白edge:end。鼠标移动超过6px激活，小幅移动仍为点击详情；触摸短按详情、长按250ms拖动，之前移动超5px取消并交回滚动；已激活可边缘自动滚动。拖动结束或取消不再触发详情点击，overlay纯文本，无第二编辑器。
- Escape/touchCancel/目标外/自身放置取消，不写receipt/启动AI。激活拖动期间 Escape 只取消拖动、不关闭看板，事件继续交给 dnd-kit 取消传感器；无拖动时面板/详情 Escape 行为不变。拖动冻结任务/顺序快照并暂停重读/冲突写入，原草稿保留。键盘可用详情上/下按钮调整同状态内的顺序；详情不提供跨状态菜单，不承诺Space/箭头拖动传感器。
- 只在成功响应后采用同锁完整权威board。失败留alert并重读，重读也失败保留旧板/两个错误；网络/存储/丢响应提供逐字段原UUID/revision/锚点的精确重试，不自动rebase。重读可展示已保存结果，不等于确认成功。
- online/focus/手动刷新不清未确认移动错误/原请求；精确确认或明确新写意图后才结束旧处理。conflict/非法锚点/任务不存在不重演，须重读后另发新意图。读失败不假空板；初载/focus/online重读，无跨页实时推送承诺。
- 原生Link/button/form/details/select键盘可用，小屏在面板内容区横向滚动列、详情覆盖面板宽度，16px输入/长路径不撑文档宽度。三语言，资料React纯文本，共享重点仅被动安全Markdown。筛选默认折叠，已启用条件有标记，列设置按需打开。

### 来源创建、批量关联与运行提示（04）

- 已选session时浮层工具栏“当前对话”菜单提供从对话创建/整理；空白composer无来源入口。来源表单不替cwd，按服务端来源创建并关联；成功原地清来源状态、不跳转、不丢其他任务草稿，普通New不复用。旧 sourceSession URL 仍兼容。任务详情显式展开对话区才读metadata catalogue，checkbox多选同范围未归属session，Link `/?session=<id>`经当前 shell 选择聊天。
- “关联已有对话”候选仅含同范围未归属的主 session；独立复制/fork 可选，子代理及递归后代排除，关系元数据无法确认的派生会话也不可新选。服务端批量 `link` 同样验证主 session 资格，混合批次整批拒绝；不修改既有子代理关联，其详情/运行态/移除和已关联集合无操作重试保持兼容。当前对话其他管理入口不在此候选规则范围，见[F31](task-session-management.md)。
- 整批存在/唯一owner/当前scope与task CAS在同锁检验；越界/缺失/他owner整批拒绝，无部分写入。合法重复集合不重复关系。删除session保留关系并明确missing，不暗中unlink/rebind；missing行返回实际generation/updateRevision并允许详情菜单显式解除，仍受owner/CAS/精确重试保护，不允许改绑缺失session。
- await `resolveProjectAuthoritatively` 的uncached Git/path规则；worktree顶层共享root/key，子目录/移除路径/Windows沿既有规则。sidebar TTL/SWR仅展示，不能授权。无项目只接受保留chat-workspace身份。
- metadata只bounded header/stat及匹配cache标题；派生会话额外复用 `readSessionRelationMetadata` 读取前两行（最多256KiB）区分子代理/fork，不读尾部或完整历史。warm registry仅header/name与创建/重开时缓存的子代理身份，不getEntries/get_state/ensure，warm合并不覆盖磁盘已确认的非主身份。board list/count不扫JSONL，观察到持久文件删除不旧cache复活，未flush真实warm主 session ID可关联。
- `GET /api/agent/running`的sessionActivity布尔快照保留原IDs/listVersion/completion suppression；pendingPrompt/queue/UI/压缩/shell/closing仍busy，首agent_end不等于整轮idle。可见页2.5秒poll，online/focus/visibility/reopen校准；失败linked卡片/筛选unknown、不匹配idle，详情留最近hint标stale；无关系任务可确定idle。不唤醒Agent/MCP或写任务状态。

## 当前存储、CAS与迁移权威表

**任务系列只在本节维护当前 schema/CAS/迁移表，其他合同引用，不复制历史版本链作为当前格式。** 选型见[ADR0007](../adr/0007-persistent-task-board.md)。`<agent-dir>/tasks/board.json`与native JSONL分开，一个taskOperation/一个store，无第二数据库/Agent引擎。进程内keyed serializer、跨进程proper-lockfile（约3秒有界重试、30秒stale），同目录mode0600临时文件fsync+rename；32MiB写前上限、个人O(n)。读取也同锁，合法迁移只写一次；未知/坏/partial/锁/读/写失败拒绝，不reset或假空板。

### 当前 schema（v7）

| 位置 | 当前持久事实 | 对外/边界 |
|---|---|---|
| board | version:7、tasks、columns/columnsRevision、orderRevision、savedViews/viewsRevision、sessionCopies、sessionRelations；可选columnRemovalReceipt | public board剥离内部receipt/创建指纹，不含第二owner索引 |
| task | UUID、五种资料、project或null、columnId、revision、createdAt/updatedAt、creationFingerprint、sessionIds、sharedContext、sessionContexts、sessionUpdates、archived/archiveRevision；可选moveReceipt/archiveReceipt/projectReceipt（F33，旧记录可缺省）及 reportIds（F36，只有曾建档才有） | sessionIds唯一owner；tasks数组唯一手动顺序 |
| knowledge | currentVersionId、不可变versions（manual/restore/AI真实来源与内部publish receipt） | restore形成新version；知识不是全聊天或自动采用 |
| start/update/copy | 严格new-start tuple、每session choices/pending/deliveries、prepared/completed copy intent；各原epoch | 选择≠append≠SDK成功input/response≠provider wire/read；child不复制source tuple/pending/read |
| relation | sessionRelations仅sessionId/generation/最近receipt，未列出身份epoch为0 | owner+generation防owned/null-owner ABA；旧合法receipt仅事实确认 |
| 派生响应（不持久） | columnRemovalDigests完整ordered源摘要，运行提示；F35 pendingSessionArchive 固定重试材料 | 同锁摘要绑定源ID及每个[id,task revision,archiveRevision]；全hidden/archive，所有board-returning精确retry返回当前map；start/copy专用响应不伪board/read |

F35 在任务 `archiveReceipt` 内增加严格可选 `cascade:{status,expectedArchiveRevision,previewToken,confirmCrossTask,rootSessionIds,skipped}`；v7 无该子域的旧记录原样兼容，不能将旧 receipt 重试升级为联动。公共任务剥离 receipt，仅 pending 时派生固定重试材料。已有归档字段缺失/损坏规则不变，坏/部分子域拒读，旧版本因严格 receipt 验证拒绝新格式。一次性联动协议及独立 session sidecar v2 见 [F35](task-session-archive.md) 和 [ADR0008](../adr/0008-one-shot-task-session-archive.md)。

F36 02 增加可选 `task.reportIds:string[]`（唯一 UUID、创建顺序）；没有报告时不持久化空字段，不引入迁移/第二索引。真实归档 hook 准备全局档案并在 board 提交引用，精确重试/同状态不重复；恢复保留引用、重新归档追加新身份。报告正文/快照/模型配置不写 board 或 archive receipt，查询/队列只接受已提交 ID；03 真实新增引用提交后锁外唤醒后台独立串行执行器，正文/阶段不回写 board；04详细材料及05有限分层综合的计划/输入引用/真实结果/阶段继续只写UUID档案，task目录读统一报告接口，会话批次/任务恢复与报告分离；见 [F36](task-archive-report.md)。

### 独立 CAS 与 receipt

| 意图 | CAS/身份 | 成功影响与精确重试边界 |
|---|---|---|
| 创建 | UUID + 不可变creationFingerprint（原规范化cwd/原文字或source ID） | 已提交先确认身份再查目录/source；返回当前记录，不重复创建 |
| 编辑/已有对话关联 | task.revision | 真实字段/关联变化推进task revision/time；不改order/columns/views/knowledge/archive |
| 修改项目（F33） | task.revision + 服务端目标/待解除关系快照摘要 + operationId | 同锁修改项目与解除不兼容/缺失关系；task revision/time一次、解除项generation推进并清旧pending；最近projectReceipt精确确认，不改创建指纹/排序/archive/原生session |
| 解除/改绑关系 | source owner + generation + session update revision（不以task.revision作为请求CAS） | 成功后推进来源/目标双方task revision/time，并同锁clear旧pending；不改order/columns/views/knowledge/archive |
| 移动 | task.revision + orderRevision + 单UUID邻居/edge | 创建/真实移动推进order；最近moveReceipt同UUID/fingerprint仅确认，no-op写receipt不改revision/time；更晚move替换后旧请求conflict |
| 列设置/删列 | columnsRevision；删列另orderRevision + 完整source digest + 独立done consent | 设置仅columns；非空删列order一次、受影响task revision/time一次；最近删除receipt仅确认，不重演/复活列 |
| 保存视图 | viewsRevision + 固定filter/sort/base/UUID | 只推进views；每已保存记录receipt，不覆盖/删除/扩大未知列条件 |
| 发布/恢复知识 | currentVersionId + operationId/canonical内容或恢复引用 | updatedAt递增，不推进task/order；不可变版本receipt可在更晚current后确认，不回拨/重新Provider |
| 归档/恢复任务 | archiveRevision + operationId/目标值；F35 联动另绑定 preview token/跨任务确认 | 只archive CAS/receipt，不改updatedAt/task/order/知识，不Stop/done；最近receipt确认当前board。联动保留固定pending/completed子域，批次效果与session侧回执同写；恢复不恢复会话 |
| 更新选择/clear/complete | 独立session update revision、operationId、owner+epoch | 只选择明确版本；complete只消费自己不清新pending；未提交旧epoch拒绝，已有delivery仅在当前owner合法时确认事实 |
| 准备/发送/复制 | 原start selection或copy intent、owner+epoch、权威scope/active/busy | 新执行不得ABA复活；completed copy返回原child不按今日owner重绑；未知prepared failclosed、人工检查后显式新意图 |

### 合法旧版本迁移至 v7

| 输入版本/域 | 仅合法absence补齐 | 必须保留/拒绝 |
|---|---|---|
| v1 | 原创建身份、priority=1/labels=[]、orderRevision=0，早期缺知识/关系补空；默认列一次 | 原文字/顺序/revision/time；已存在非法字段拒绝，不发明v0 |
| v2 | 缺列配置加原五默认/columnsRevision=0，早期缺知识/关系补空 | 原02字段/指纹、order/move receipt、已有06历史/receipt |
| main-v3 | 仅缺关系补sessionIds=[]，按后续域规则hydrate | 必须合法columns/columnsRevision；**04未发布source-only v3无列拒读**，不按数字猜格式 |
| v4 | 缺sessionContexts补[] | 关系与知识必填；AI/manual/restore、所有旧receipt保持 |
| v5 | 缺sessionUpdates补[]；整个archive域都缺才补false/0 | strict start域必填；partial/坏archive拒绝，不静默修复 |
| v1–v5的additive views/copies | views两个字段都缺才0/[]；copies缺才[] | partial/present-invalid拒绝；v6及以上两域必填 |
| v6 | 缺新relation域补[]；合法旧start/choice/copy缺epoch补0 | archive/update/start/views/copies等必填；已有非零不一致epoch拒绝，不先迁移写坏v7 |
| v7 | 无legacy必填域补齐 | relation/epoch必填；完整hydrated目标在operation/写入前统一校验start/choice/copy，未来epoch拒读、原bytes不变；较早合法prepared/completed receipt保留历史 |
| 可选columnRemovalReceipt | 缺失合法；不创建强制空字段 | present-null/partial/非法拒读；保留原fingerprint，不猜旧array wire请求为digest成功 |

跨域验证须保留所有旧CAS/receipt/历史；旧应用可能拒读AI来源或删列数据，不承诺downgrade安全。08selection固定字段canonical比较，不受迁移追加epoch属性顺序影响。

## 公共操作、授权与原子性

Windows 原子替换共用 `lib/task-file-replacement.ts` 的有界 rename 重试：不重放 mutation，不删除旧目标，每次尝试前重新检查原 board 锁；失锁或持续不可写仍拒绝提交并保留原字节。`lib/task-store-write.test.mjs` 验证同 temp/单次 revision、永久失败后的精确恢复及退避期间失锁。平台证据与限制见[2026-10-13 验证契约](windows-test-portability.md#任务看板安装前修复2026-10-13)，不改变下述 CAS、receipt、迁移或文件授权。

- 唯一 `taskOperation(input,{agentDir})`；GET `/api/tasks` list、POST同一入口、no-store。公共HTTP白名单拒内部admit/pending/complete/copy及伪receipt/额外字段。严格UUID/原生session ID/列/文字/安全整数，ID不拼路径；256KiB，400非法/404不存在/409冲突/503存储或版本失败。
- create/createFromSession使用不可变原创建指纹，不拿可变标题或今日项目key猜重试；旧UUID先确认，即使目录/source删失。真正新UUID才验当前目录/服务端项目；不收client projectKey。todo存在优先，否则同锁配置首unfinished，永不默认done/复活todo。
- move只单UUID+before/after另一目标列邻居或edge:start/end，不接受可见数组。检验task/order CAS；同任务最近receipt在旧目标已删时仍只确认历史。真实移动严格updatedAt至少旧+1ms，no-op不改时间，计数上限拒绝。
- edit只五种资料，陈旧base即使同内容也conflict；同base规范化后全同为no-op不写。保留项目/createdAt/指纹/状态/知识；丢响应留输入，不能猜revision+1为确认。
- link为1–100原生IDs整批验证；source-create先已提交指纹确认，关系变化只task revision/time，不改其他域。set-columns不接受isCompletion/project/任务数组或删除，陈旧base即使同配置也conflict，同base无变更no-op。
- proxy保护 `/tasks` 和既有API，沿用Web cookie/Basic、Host/Origin、限流和登录目标。任务目录校验**不调用allowFileRoot**；任务ID/文本/项目不扩大 `/api/files` 权限。既有显式cwd选择授权规则不变。
- 原wrapper最早pending reservation仍在await前；active/fullbusy与await权威scope后重查同锁。archive owner不能借reassign/newsend绕restore，任务操作不重写native历史。单进程入口不沙箱外部CLI/任意trusted extension绕wrapper。

## 悬浮面板改版验证（2026-10-10）

新增 `E2E_BASE_URL=<verified-dev> node e2e/task-dashboard-panel.mjs`：所有 API 截获，临时真实 task store + 合成会话/prepare 响应，不启动 Agent/provider。覆盖桌面/390px、默认紧凑板、编辑/移列、新建/编辑/聊天草稿关闭重开、IME/Escape/焦点、目录选择器层级、手机整理流程、准备新聊天/打开关联聊天、隐藏模态标记与旧路由。`components/AppShell.workspace-memory.test.mjs` 增加显式面板导航/准备 token/失败保持当前聊天验证。

本轮最终验证：TypeScript 与所改 TS/TSX/MJS 的 ESLint 通过；任务资料/顺序/视图/共享重点/列/归档、AppShell 草稿导航及 stacked-dialog 共 97 项测试通过；上述新 Chromium 浏览器用例通过（桌面与390px、无 Agent 写请求）。

旧 `e2e/task-dashboard*.mjs` 中依赖独立页 Link、卡片内 summary/combobox、默认展开筛选的选择器属于改版前测试，尚未全面迁移，不能声称本轮全套浏览器回归通过。数据层测试与新面板用例分开报结果；真实 Safari/iOS/Windows、真实 provider 发送未由本轮验证。

## 实现导航

- [task-types](../../lib/task-types.ts)：共享类型/稳定列/限制/错误；[task-store](../../lib/task-store.ts)：版本分派、完整hydrated目标验证、锁/fsync/rename；[task-operations](../../lib/task-operations.ts)：统一操作/同锁board/派生digest。
- [TaskDashboard](../../components/TaskDashboard.tsx)、[TaskInspector](../../components/TaskInspector.tsx)、[TaskDetails](../../components/TaskDetails.tsx)：权威响应/独立草稿/紧凑卡片/独立于投影的详情；[TaskDragTargets](../../components/TaskDragTargets.tsx)：整卡点击/拖动/键盘激活与邻居意图；[TaskColumnSettings](../../components/TaskColumnSettings.tsx)：SettingsUi草稿/确认；[样式](../../components/TaskDashboard.module.css)、[/tasks](../../app/tasks/page.tsx)。
- [TaskSessions](../../components/TaskSessions.tsx)、[task-sessions](../../lib/task-sessions.ts)、[scanner](../../lib/session-list-scanner.ts)、[worktree](../../lib/worktree.ts)：metadata/权威scope；[RPC](../../lib/rpc-manager.ts)：原活动投影/准入；[tasks API](../../app/api/tasks/route.ts)、[running API](../../app/api/agent/running/route.ts)。
- [AppShell](../../components/AppShell.tsx)、[tab-session](../../lib/tab-session.ts)、[SessionSidebar](../../components/SessionSidebar.tsx)：[TaskPanel](../../components/TaskPanel.tsx) 持久浮层、[task-panel-navigation](../../components/task-panel-navigation.ts) 显式聊天选择与草稿恢复；[validated-cwd](../../lib/validated-cwd.ts)：与cwd路由共用校验。

## 整卡交互回归入口

`E2E_BASE_URL=<verified-dev> node e2e/task-dashboard-card.mjs` 使用真实面板、全 API 截获和临时 task store：标题/项目/数量/标签/空白单击、小幅移动、Enter/空格、同列/跨列拖动及刷新持久化、松手不打开详情、Escape/目标外/自身取消、详情无状态选择器且同列上下调序保留、390px 触屏短按/长按/touchCancel/快速滑动滚动；断言零 Agent 写请求。原 `e2e/task-dashboard-panel.mjs` 继续覆盖草稿/焦点/三语言/主题。实际运行结果另报，不代替 Safari/iOS 真机或全平台验证。

## 验证入口（命令不是执行通过声明）

数据/HOME/TMPDIR/agent/log须新短Git树外tmp，预检非Git、祖先无node_modules；只测试子进程清三SDK aliases，不改全局环境/凭据。tsbuildinfo树外。浏览器仅复用授权健康服务，先读 `/tmp/pi-web-dashboard-dev-zppw3zx1/server.json` 并核对监听/cwd/健康，不凭历史PID授权；不启动/重启/build/install/真实模型或用户数据。30141是全局生产，不能动。

```sh
env -u PI_PACKAGE_DIR -u JITI_ALIAS -u JITI_RESOLVE_ALIAS node --experimental-strip-types --test \
  lib/task-operations.test.mjs lib/task-details.test.mjs lib/task-order.test.mjs \
  lib/task-columns.test.mjs lib/task-sessions.test.mjs lib/task-sessions-integration.test.mjs \
  app/api/tasks/route.test.mjs app/api/tasks/sessions.test.mjs lib/web-auth-proxy.test.mjs
# 全API fixture；E2E_BASE_URL由已核验的授权服务指定，不自建服务。
E2E_BASE_URL=<verified-base> node e2e/task-dashboard.mjs
E2E_BASE_URL=<verified-base> node e2e/task-dashboard-drafts.mjs
E2E_BASE_URL=<verified-base> node e2e/task-dashboard-details.mjs
E2E_BASE_URL=<verified-base> node e2e/task-dashboard-create-cancel.mjs
E2E_BASE_URL=<verified-base> node e2e/task-dashboard-order.mjs
E2E_BASE_URL=<verified-base> node e2e/task-dashboard-retry-reload.mjs
E2E_BASE_URL=<verified-base> node e2e/task-dashboard-columns.mjs
E2E_BASE_URL=<verified-base> node e2e/task-dashboard-sessions.mjs
```

同锁真实临时store/fresh进程/故障注入、实际route函数、SDK/fake provider、source-contract/VM、Chromium全API fixture、真实平台是不同层级；具体执行看coverage/历史报告，不能把命令、静态扫描或fixture SSE当生产通过。关联能力还需各专属合同窄集/联合入口，尤其10迁移与10×14联合回归。

人工：创建→编辑五字段→取消不写→保存刷新一致；两页旧base败者留输入；打开草稿后移列仍保留；拖同列/跨列/空列→Escape取消→失败重读仍留原请求；全局done改名仍完成、新列同名仍未完成；同scope批量关联/跨scope整批拒绝；检查隐含任务、归档和旧receipt不丢。人工步骤不是已执行证据。

## 限制与 rebase

- N1既有P2：外部删除持久session后set_tools可写headerless片段/500；普通/prepared before同机制，未修复，详见[08合同](task-start-chat.md)。11未知copy仍可能重复/孤儿，SDK与board不是跨文件事务。
- 真实provider wire/read/费用/质量/取消/网络、生产SSE、Windows实际SDK/ACL/浏览器、Safari/iOS16.2真机/软件键盘、最低Node22.19执行、生产build/package/install、断电/NFS/kill-mid-write未验。Chromium/CDP/合成压缩、POSIX故障注入、3500浏览器与50k后端容量、4 Windows skip不代证明。
- TEST-ISOLATION事故与06 SSR恢复/旧.next证据保留于[历史附录](task-dashboard-validation-history.md)，不能称测试从未越界或推定缓存唯一根因。
- 高交叉store/types/operations/RPC/Dashboard/语言/导航/proxy须逐域语义合并，不整文件覆盖、不按version数字猜源隔离格式。保护独立CAS/receipt、最终草稿、权限/exact-system/tools/models基线与无自动AI副作用。修改同轮同步专属合同和索引；替换存储须明确迁移/回归，无冲突不等于验收。
