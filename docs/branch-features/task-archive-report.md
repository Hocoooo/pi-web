# 任务归档报告：冻结来源、分层材料、恢复/重试、报告历史与 Agent 只读工具（01–08）

> 核对日期：2026-10-13；开发阶段、单用户。01 配置、02 来源冻结/建档、03 短历史生成、04 完整详细材料及05 有限分层综合已接入；每次请求遵守单次容量，无法分组收缩或连基本输入都不能容纳时明确失败、保留真实材料。06 已接入启动恢复/明确重试；07 已接入报告历史/最新成功入口及显式重新生成。08 已接入全局只读检索及正文/全层级材料分页工具。受控 provider 证据不代替真实模型质量验收。

## 目的与阶段范围

在无项目的设置中也能保存后台可读取的报告模型与思考等级，独立于聊天默认值及来源对话。复用既有全局设置文件锁、可用模型/能力解析、Settings 通用样式和 F02 两步选择器。

**真实任务归档提交后，非空且已配置的固定意图由服务端独立后台生成；归档不等待模型。** 设置保存和报告查询零模型请求，空来源仍零请求；不恢复共享重点，不启动或 prompt 来源 AgentSession，不修改来源历史。

## 入口、配置与公开接口

- 设置 › 通用 › 任务归档报告；固定全局 scope，不要求 cwd 或项目，不提供项目覆盖或逐次生成开关。
- 服务端当前 agent 数据目录的 `settings.json` 增加 `taskArchiveReport: { provider, modelId, thinkingLevel }`。缺省/清除即未配置，不保存浏览器报告偏好，不写聊天 `defaultProvider/defaultModel/defaultThinkingLevel`。
- `getTaskReportSettings(agentDir?)` 返回 `selection`、`availability`、`models`、`thinkingLevels`、`thinkingLevelMaps`；归档意图复制当时的 `selection` 与可用性；只有 ready 才 queued，其余待配置。03 实际 SDK 请求使用固定 selection 的 provider/modelId/thinkingLevel，off 使用关闭思考语义。
- `saveTaskReportSettings(selection | null, agentDir?)` 验证当前全局可用模型及能力后，只读改写报告字段。`null` 删除该字段。
- `GET /api/task-reports/settings` 与 `PUT { selection }` 使用上述同一模块，无项目参数。返回同一 settings 状态；非法输入/不可用模型/无效等级为 400，模型加载及存储错误为 500，带 `code` 和普通错误说明。

## 编号行为要求

1. 未配置返回 `unconfigured`，不使用聊天模型/等级、全局聊天默认值或 scope pin 作隐式报告选择。
2. 模型以 provider/modelId 联合标识。可选模型来自独立全局 SDK services（agentDir 作 cwd）、认证可用性和现有 `enabledModels` resolver；不启动来源 AgentSession，不加入需 `session_start` 才可使用的 deferred provider。
3. 等级来自目标模型 `getSupportedThinkingLevels()` 与 level map。`auto` 不是实际等级，保存时拒绝；无思考能力模型使用 `off`，不猜测其他值。
4. 模型浏览/搜索、返回/取消不写设置。第二步确认联合保存，保存中不可重复提交；失败保留目标模型、等级和打开的 picker，显示三语言可见错误，可明确重试。未传默认星号回调，不改变聊天默认设置。
5. 查询保留已经保存但不再可用的选择，返回 `model-unavailable` 或 `invalid-level`；不替换、不自动修复、不调用模型。损坏设置和模型目录明确报错，不覆写损坏文件。
6. 重新读取/页面刷新从服务端加载，清除选择同样写全局配置。读写复用 `global-settings-file.ts` 与 SDK 同一 `settings.json` 锁，保留其他字段。错误后的重新读取是确认落盘事实，不是报告重试或收费授权。
7. 本票没有迁移、旧格式兼容、累计预算、多用户授权或通用配置框架。SDK 模型目录加载仅复用既有离线目录路径，不刷新上游目录或测试模型推理。

## 实现导航

| 文件 | 职责 |
|---|---|
| [task-report-settings.ts](../../lib/task-report-settings.ts) | 全局公开查询/保存、SDK 模型能力、可用性与错误 |
| [task-report-settings-types.ts](../../lib/task-report-settings-types.ts) | UI/后续票据共享 selection 与响应字段 |
| [settings route](../../app/api/task-reports/settings/route.ts) | 无项目 GET/PUT、错误映射 |
| [TaskReportSettings.tsx](../../components/TaskReportSettings.tsx)、[SettingsPanel.tsx](../../components/SettingsPanel.tsx) | 通用设置区块、两步确认/错误保留、重新读取/清除 |
| [global-settings-file.ts](../../lib/global-settings-file.ts) | 既有 SettingsManager 同锁读改写（未改动） |
| [ModelSelector.tsx](../../components/ModelSelector.tsx)、[ModelPicker.tsx](../../components/ModelPicker.tsx) | 复用 F02 两步选择与局部键盘行为（未改动） |

## 自动验收

仓库根目录，已安装开发依赖及 Playwright Chromium：

```bash
node --experimental-strip-types --test lib/task-report-settings.test.mjs app/api/task-reports/settings/route.test.mjs lib/default-preferences.test.mjs lib/global-settings-file.test.mjs lib/model-picker.test.mjs lib/i18n/registry.test.mjs
node e2e/task-report-settings.mjs
node e2e/model-flow.mjs
node node_modules/typescript/bin/tsc --noEmit
```

- 行为测试用临时 agent 目录、真实 settings.json/SDK 模型目录与零费用本地 provider。验证 provider 同 ID 区分、无思考能力、auto/非法等级拒绝、持久化、不改聊天默认值、SDK 共享锁、不可用查询及普通读写/模型目录错误，provider 请求计数始终为零。
- 浏览器挂载真实 SettingsPanel（cwd/sessionId 均为空），通过模拟浏览器传输调用真实 GET/PUT、全局存储和 SDK 能力，不运行/重启 Next。覆盖 en/zh-CN/zh-TW 的 1100px 与 390px 保存、页面刷新、重读、错误候选保留/重试、能力差异、加载失败、不可用/无效状态与清除；刷新后先滚动报告区块至可见位置再保存截图，输出临时截图路径。浏览器传输拦截其他调用，未触碰真实配置/凭证/session。
- 01 证据仅证明设置与能力；03 的实际请求等级另由下述受控 SDK provider 集成测试覆盖。均不证明真实 provider 内容质量或平台安装。

## 人工验收（无需模型调用）

1. 无项目打开通用设置，选模型后返回/取消：报告配置不变，聊天默认值不变。
2. 选模型与受支持等级并确认：出现已保存选择；刷新/重读仍一致；无思考能力模型只有 off。
3. 在受控临时目录使设置写入/模型加载失败：显示可见错误；保存失败 picker 与候选保持，可修复后明确重试；重读不默默替换旧选择。
4. 在 390px 及三语言重复操作：主控件可见、无横向越界、错误换行可读。

## 02：来源冻结与全局档案

- `setTaskArchive(task, request, agentDir)` 在原 board 锁中仅对真实 active → archived 准备档案并提交 `task.reportIds`（创建顺序引用）；最近 archive receipt 的精确重试、同状态、预览、失败确认、侧栏 session 归档不创建可执行意图。恢复只替换 receipt/标记，不删除 reportIds；重新归档新 UUID、新快照。
- `<agentDir>/task-reports/<reportId>.json` 保存任务资料、明确关联 session 当前分支全部仍存在历史的文本投影、各来源 leaf/cutoff/capturedAt/运行态，以及选择/配置原因/状态。task 只保存 ID 引用，不保存正文或来源。写盘采用普通 fsync/rename，不建设跨文件事务。报告读取/写入文件段按 absolute key 在进程内 FIFO 排队（跨 route/HMR 共用，Windows key 小写），防自身状态轮询的读句柄跨替换；committed 检查不变，读取不建目录/迁移/写盘，I/O 回调不反向获取 board 锁、不调用模型。Windows 替换时的短暂 EPERM/EACCES/EBUSY 通过 `lib/task-file-replacement.ts` 仅重试相同 rename（最多 6 次，10/20/40/80/160ms 计划退避，总计 310ms）；不重发模型、不重复写正文、不删除旧目标，永久/持续占用仍传播错误并清理临时文件。FIFO 不是跨进程锁或事务。准备后 board 写失败可留下未引用文件；公开读取/队列仅消费已提交引用，绝不扫描孤儿执行。
- 来源逐一捕获，不宣称同时刻跨文件快照。复用 scoped metadata 与 warm manager 的只读内存克隆，sleeping 文件 parse/inMemory，不 open/migrate，不启动 AgentSession、不改 JSONL。不按归档会话族扩展输入、不读取其他分支或外部文件。纳入工具调用参数、文本结果、bash 命令/结果、压缩前历史和摘要、custom 文本；最后 branch-local context edit 替换/删除生效；system/隐藏思考/图片二进制排除，图片只留存在标记。
- 缺失/不可读来源明确记录。全部没有对话内容时直接 `generated` 的任务元数据 Markdown 档案，零配置加载/模型请求，不推断完成；非空来源初始 `queued` 或 `awaiting-configuration`；03 仅消费已提交 queued，后来保存设置不改旧意图或启动待配置报告。
- 公开接口位于 `lib/task-reports.ts`：`getTaskReport(id, agentDir?)` 读取已提交档案含 snapshot/body；`listTaskReports(taskId?, agentDir?)` 返回无正文/快照的摘要；`listQueuedTaskReports(agentDir?)` 仅返回已提交 queued 档案；`writeTaskReport(report, agentDir?)` 为后续状态持久化入口。`prepareTaskReport(task, agentDir)` 在归档 board 锁内准备文件并返回 UUID，只有 board 提交后的 `task.reportIds` 才授权读取/入队；`TaskReport` 类型见 `lib/task-report-types.ts`。未提交 ID/not found 普通错误；损坏/缺文件报 storage-unavailable，不改读今日 session。
- `GET /api/task-reports?taskId=...` 摘要，`?id=...` 档案，`?id=...&body=1` 只读纯文本正文。TaskInspector 内 TaskReports 展示状态/截止/缺失/运行提示、重读错误、空档案新标签打开；会话批次 pending 独立展示。03 轮询独立报告状态、显示生成基础阶段、成功链接与失败/未知；失败不隐藏旧成功链接，06 提供明确重试；07 提供独立历史版本/最新成功默认入口和显式重新生成。
- 实现：`lib/task-report-{types,snapshot}.ts`、`lib/task-reports.ts`、task-archive/store/types、TaskReports/TaskInspector、task-reports route。02 来源验收入口（03 已适配后台生命周期）：`node --experimental-strip-types --test lib/task-reports.test.mjs app/api/task-reports/route.test.mjs lib/task-session-archive.test.mjs` 与 `node e2e/task-reports.mjs`（真实组件/API/临时存储，浏览器传输桥，无 dev 启停）。测试证据收尾另记；board 提交失败测试在既有文件锁 seam 注入已知失锁，验证预备文件不可读/不可入队，而非 monkeypatch 原生 fs binding。

Windows 原子替换、错误模块身份、确定性存储故障注入和独立恢复进程清理见[平台验证契约](windows-test-portability.md#任务看板安装前修复2026-10-13)。新增窄集：`node --experimental-strip-types --test lib/task-jiti.test.mjs lib/task-report-write.test.mjs lib/task-store-write.test.mjs lib/task-report-chunks.test.mjs lib/task-report-recovery.test.mjs`；同时保留原多层全覆盖/容量失败/未知结果断言。受控故障注入不代替 ACL 或断电耐久验证。

### 02 回归边界

除本票 19 项与 6 组报告 UI，相关回归运行 `lib/task-archive.test.mjs lib/task-management.test.mjs lib/task-store.test.mjs lib/task-relations.test.mjs app/api/tasks/session-archive.test.mjs app/api/tasks/sessions.test.mjs lib/i18n/registry.test.mjs`。busy 归档必须采样并保存运行态但不 gate；整任务比较排除新引用后，另显式断言归档新增/恢复保留 `reportIds`，其余资料、历史、CAS/receipts 不变。测试不通过不能通过撤销来源采样/建档要求解决。实际最终结果及窄屏截图复核见 [02 handoff](../../.scratch/task-archive-report/handoff-02.md) 和[当前任务回归清单](../testing/task-session-management.md)；上述命令不表示全仓测试、执行器或真实 provider 通过。

## 03：短历史自动后台生成

- `lib/task-report-executor.ts` 的 `wakeTaskReportExecutor(agentDir, { timeoutMs? })` 只在真实新增报告引用的成功归档提交后唤醒；普通路径在 `taskOperation` 的 `withTaskStore` 返回后，cascade 在第一提交后、会话批次前。精确重试、同状态、读取、失败 board 提交不新唤醒。`Symbol.for`/globalThis 持有唯一串行 drain，热重载复用，不受请求 signal、浏览器卸载/刷新或任务恢复控制；队列只取 committed references，非孤儿。`waitForTaskReportExecutor()` 只观察后台生命周期，测试清理临时目录时先等待，避免后台与删除竞态。
- 独立 `createAgentSessionServices({cwd:agentDir,agentDir})`、现有 visibleModels/能力/auth 和公开 Provider.streamSimple；不新增模型 adapter/AgentSession。只解析意图中的模型/等级；不可用或失效等级转待配置，无 fallback。当前设置清除或另选模型不替换已有有效意图；后来修正配置也不消费待配置意图。tools 为 []、toolChoice none、maxRetries 0；不存凭证、provider wire 或隐藏思考。
- 输入是固定 JSON snapshot（含原任务资料、全部来源条目、leaf/cutoff/activity/缺失），不重新扫描今日历史。系统要求详细 agent 档案的八类语义章节，区分观察、主张和未知，不要求人工审核、不推断完成；正文追加确定性的固定截止/覆盖和 session/entry 来源目录。
- `taskReportFits()` 采用保守 UTF-8 字节上界及 1024 单次封装余量（不是精确 tokenizer），预留输出；输出上限为 min(model.maxTokens, contextWindow/4)。03 初始仅支持一次容量；04 已扩展为下述分段路径，仍逐请求检查、不截断、无累计预算。
- 少量持久基础字段 `phase: preparing|sending|completed`、startedAt/sentAt/completedAt/error。进入 provider 前落盘 sending；只有完整 stop、非空文本、无工具调用及正确响应身份的正文成功写盘后才 generated。明确错误/length/空文本 failed，不自动重试；超时/abort/连接未知/发送后无法确认落盘为 unconfirmed，不自动重发。默认请求期限 120 秒；若 provider 忽略 abort，先显示未知，仍等待其 settle 才能发送下一份，迟到输出不覆盖未知结果。存储不可写不能声称成功，保留 sending 边界/公开存储错误；启动解释此边界属 06。
- `TaskReports` 仅在当前浮层 active 且为所选详情时读取，queued/generating 每秒重读状态，轮询不驱动模型。沿 Dashboard → Inspector 传递现有 active 生命周期；切换任务、收起详情或关闭浮层取消在途 GET 与计时器，重开重读。缓存组件及 retry/regeneration 操作 ID/错误保留，隐藏/卸载不取消后台执行器或收费操作；三语言阶段/失败/未知及再次收费说明、现有新标签正文链接在 390px 可见。07 历史列表按创建顺序展示，顶部默认链接最新成功报告；新版本不修改旧成功文件。
- 03阶段本票不在模块导入/服务启动自动恢复旧队列，不提供重试；06现已扩展如下。无分布式框架、兼容层或额外权限；单进程只支持当前用户数据。

### 03 自动验证

```sh
node --experimental-strip-types --test lib/task-report-generation.test.mjs lib/task-reports.test.mjs app/api/task-reports/route.test.mjs lib/task-session-archive.test.mjs
node e2e/task-reports.mjs
node --experimental-strip-types --test lib/task-archive.test.mjs lib/task-management.test.mjs lib/task-store.test.mjs lib/task-relations.test.mjs app/api/tasks/session-archive.test.mjs app/api/tasks/sessions.test.mjs lib/i18n/registry.test.mjs lib/task-report-settings.test.mjs app/api/task-reports/settings/route.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run lint
```

临时真实 task/session/report 文件、真实 HTTP handlers/SDK 与本地 OpenAI-compatible SSE provider，断言实际 reasoning_effort、off、tools 空、请求次数、输入全覆盖、锁外延迟/页面 signal 取消、恢复/设置修改、cascade pending 独立、热重载串行、超容量/失败/超时停止、孤儿不可执行及删除来源仍可打开。浏览器真实 TaskInspector/TaskReports 三语言×1100/390，不启动 Next；同脚本另挂载真实 TaskPanel/TaskDashboard，在三语言390px 验证 A（generating）→B（queued）、收起详情/关闭浮层取消在途 GET 与轮询、重开重读、缓存 Inspector 保留、后台隐藏期间继续生成，以及 retry/regeneration 丢响应后跨隐藏仍保留精确操作 ID；仅提供 Next URL context，报告/任务请求桥接真实 HTTP handlers/临时存储；关闭执行中的 tab 后后台保存，重开成功正文；轮询真实失败、未知和旧成功链接，缺失/读错误/恢复回归。最终结果与窄屏截图见 [03 handoff](../../.scratch/task-archive-report/handoff-03.md)。不宣称 04–08、真实模型质量/计费、服务重启、全仓测试或平台安装通过。

## 04：详细材料与单层综合闭环

- 原 snapshot 一次能容纳时保留03短路径。否则 `lib/task-report-chunks.ts` 确定性按 source/item 原顺序贪心装段，普通条目优先完整；单条超长工具文本用实际 JSON（含转义）容量二分切片，UTF-16 偏移不切断 surrogate pair。有限来源全部分配，无早/中/尾抽样、尾部窗口、累计 token/请求数/费用限制。任务/来源定位加最小正文仍不能容纳时明确 failed、零发送，原快照保留。
- 每段输入携带完整固定任务资料、相关 source 的 leaf/cutoff/activity、entry/kind/timestamp、前后 entry ID 与切片 start/end/totalLength；系统和材料指令要求详细保留决策理由、失败路径、命令/结果、文件与观察/主张/未知，不是只生成短摘要。固定模型/等级、SDK无工具/零重试、唯一串行执行器继续复用。覆盖保证是全部文本进入有限请求，不保证真实模型逐字无遗漏。
- UUID JSON 中 `materials: {id,parts,body,completedAt?}[]` 保存真实计划与结果；`parts` 是 snapshot 的 sourceIndex/itemIndex/start/end，不重复存源文本。`stage:{kind:report|material|synthesis,materialId?}` 与现有 phase/preparing/sending 保存本次真实发送边界；每次结果写盘后才推进。材料正文追加确定性 source/slice/相邻目录。只增加实际阶段需要字段，未建设DAG/workflow、启动恢复或重试。
- 全部详细材料正文（含其来源目录）整体检查一次综合容量；能容纳才发送 synthesis，成功正文追加所有材料真实读取链接。仍超容量明确 failed、stage=synthesis/preparing，全部材料可读，留05处理；不截取材料、不发部分综合。只有全部材料和正文成功持久化才 generated。
- 明确错误/length/空输出停止，不自动重发；已有材料和真实进度保留。结果写入失败不能把内存结果作为成功再写回：只保存已确认的材料；完全不可写时 durable sending 保留、executor报存储错误，读取仍可取得之前结果（06处理启动解释）。超时/未知仍沿03的unconfirmed边界，不自动收费重试。
- 统一 `readTaskReportText(reportId, materialId?, agentDir?)` 读取正文/材料，使用同一 committed ID 检查；`GET /api/task-reports?id=...&material=material-N` 纯文本材料，body=1正文，缺失/未完成材料404。`getTaskReport` 包含完整材料；`listTaskReports` 只返回计划/source refs、hasBody/completedAt，不泄漏材料正文/快照。原 session 删除不影响读取，无今日历史 fallback。
- 真实 TaskReports 三语言阶段与已保存/计划计数、全部材料目录：只有 durable material 才是新标签链接，未完成行明确标识；失败/在途材料仍可打开，非完整报告不出现正文链接。390px 自动检查及截图通过，不增加编辑器或工具；历史默认选择现见07。

### 04 自动验证与边界

```sh
node --experimental-strip-types --test lib/task-report-chunks.test.mjs lib/task-report-generation.test.mjs lib/task-reports.test.mjs app/api/task-reports/route.test.mjs lib/task-session-archive.test.mjs
node e2e/task-reports.mjs
node e2e/task-report-settings.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run lint
```

`task-report-chunks.test.mjs` 真实归档/SDK本地SSE provider记录所有请求，验证两个来源、早/中/尾、Unicode/JSON转义单长工具文本精确拼回原快照、每次容量与固定等级/无工具、逐段落盘、全量一次综合、统一API读取/删除来源、第二段错误/length/空、综合错误/length及分段/综合POSIX目录不可写。仍需分层的材料明确失败且零综合请求。UI 三语言×1100/390 读取真实材料新标签，观察生成进度/部分失败/成功目录。结果、命令、05/06/08交点见 [04 handoff](../../.scratch/task-archive-report/handoff-04.md)。未验真实模型语义质量/费用、服务重启、多层综合、历史操作或agent工具；这些不算04通过内容。

## 05：超大材料有限分层综合

- 延续04短路径/详细分段；详细材料整体无法一次综合时，`planTaskReportSynthesis` 按原顺序贪心装入完整已保存材料（含目录），不截取任何输入。每组容量检查包含系统/任务/来源背景、输出上限和封装余量；固定原selection、无工具、零自动重试、唯一串行executor不变。
- 每层分组数量必须严格少于上一层材料数，所以有限来源决定有限推进，不由模型扩展计划，也没有累计请求/token/费用预算。不能容纳一个完整材料或不能减少数量时在发送前明确failed；后续层同样检查。中层保留决策理由、失败路径、验证和未知区别；详细来源永久保留可读，不把模型摘要质量当逐字无遗漏保证。
- 所有层复用 `materials`：底层 `material-N`/parts定位原snapshot，层级默认0；中层 `synthesis-L-N`、`level:L`、`inputMaterialIds` 引用上一层完整分组，parts为空。中层正文追加真实子材料链接，最终正文追加全部底层和中层链接、层级及输入引用，源entry目录仍完整。`getTaskReport`含真实正文；`listTaskReports`仅hasBody与定位字段；`readTaskReportText`及原material API无新分支即可完整读取中层。TaskReports三语言显示层级、输入引用、保存/计划数量与全部真实链接；未落盘的结果不可点击。
- 每层计划先保存；每次阶段 `{kind:synthesis,level,materialId?}`、phase、sentAt先落盘再调用。各材料新增 `sentAt`，已有 `completedAt`/非null body仅代表durable成果。最终综合阶段无materialId，stage.level记录正文所处层。完成材料写盘才推进，所有底层/中层与正文durable才generated；error/length/空/未知/写入错误不自动重发、不发布半成品、不覆盖旧成功。完全不可写仍保留旧sending边界，不伪造failed/generated确认。
- 05交付时06尚未实现（现见下节06）：以上实际计划、输入引用、发送/完成时间和当前stage供其定位未发送下一阶段、验证durable不重做/sending未知不重发；本票不声称重启恢复通过。08尚未实现：统一ID及读取接口已可读所有层，工具分页/检索交叉回归由08负责。

### 05 验证入口与边界

沿用04自动命令及03相关回归。`task-report-chunks.test.mjs` 将原“需05则失败”用例更新为真实归档两来源、小容量SDK受控provider的多层成功，保留全部Unicode/source slice精确拼回断言；逐请求检查容量、1000输出上限、固定等级/无工具，观察真实L1/L2计划/发送/完成，逐材料API/统一读取、完整层级目录/来源删除。另验证L2 error/length/目录EACCES保留实际成果及旧成功、无重发；初始/后续不能收缩和单材料不能容纳有限失败。

报告UI三语言×1100/390实际多层产物/输入目录/中层popup与底层读取、在途partial/成功/失败目录，以及原后台独立/旧成功/未知回归；设置UI仍零请求。实际结果见 [05 handoff](../../.scratch/task-archive-report/handoff-05.md)。05阶段证据不证明真实模型语义质量/计费、启动恢复、显式重试、版本操作或agent工具；未执行全仓npm test、build/安装或平台耐久性验收。04上节证据为当时单层能力历史，不代表05之后仍对所有超材料失败。

## 06：Node 启动恢复与明确重试

- 服务入口 `instrumentation-node.ts::registerNodeInstrumentation` 调用 `startTaskReportExecutor()`，由 globalThis 唯一串行 executor 每数据目录启动一次；无需网页或 API 请求。归档提交和显式重试仍沿同一 wake/drain；查询/设置保存从不唤醒旧失败/待配置意图。仅消费 board 已提交引用，恢复 task 不取消报告、不改原快照。
- queued 或 generating/preparing 继续固定 selection/snapshot；已有材料计划不重排，底层和每层中层 body+completedAt 是 durable 完成依据，已确认成果不重发。沿 level/inputMaterialIds 的真实已保存分组逐层推进到下一未发送材料或最终正文；完成落盘后当前 stage 尚未推进也能定位下一工作。只有完整正文落盘才 generated。
- generating/sending 无对应 durable 材料确认成果时转 unconfirmed，不调用模型；短报告/最终正文无确认同样停止。反复启动/读取不再请求，不声称识别 provider 实际接收或保证绝对一次计费。发送/完成字段沿用03–05，无租约、跨进程调度、通用日志或自动付费重试。超时 provider 忽略 abort 时仍等待 settle，active 期间拒绝新 retry，不并行、不采纳迟到结果。
- `retryTaskReport(id, operationId, agentDir?)` / `POST /api/task-reports {action:"retry",id,operationId}` 仅接受 failed/unconfirmed/awaiting-configuration；成功/正常 queued/generating 返回409。同 operationId 优先确认历史尝试，不建立新尝试。报告保存少量 `attempt`（初始视为1）、`retryOperationIds`，单进程按报告序列化读当前专用配置与写盘；新尝试清空旧材料/stage/时间/error，用原 snapshot 从头重做，不混旧模型成果。配置仍不可用则保持待配置，不收费。07 regenerate 新建版本，绝不通过本 retry 改写成功报告。
- TaskReports 三语言/390px 显示收费与从头执行提示、真实明确重试按钮；提交失败/丢响应保留 operationId、错误和精确重试，即使重读已显示 generating 仍可确认原请求。普通读取不把网络错误当成收费授权；不可读报告/snapshot 返回普通 storage-unavailable，不采集今日历史。
- 验收：`node --experimental-strip-types --test lib/task-report-recovery.test.mjs` 通过临时真实存储与独立 Node 进程实际执行启动入口，使用03–05真实生成所得底层/L1/L2/最终阶段计划和完成材料模拟发送前/发送未知的持久边界；逐请求断言已完成不重做、当前frontier完整输入、原快照/固定high、只有未完成材料+正文次数。三种失败状态当前off配置明确重试、同ID并发/丢响应/完成后重发、正常生成拒绝，真实多层重试从底层重新开始。受控provider，无真实收费；阶段文件回放不是断电原子性或网络临界窗识别测试。
- 报告UI沿用 `node e2e/task-reports.mjs`，桥接真实 GET/POST/临时存储，三语言×1100/390 验证实际收费提示/按钮、丢成功响应→可见错误→重读生成中→同ID精确重试→成功；每组只新增一次受控调用。相关回归及最终命令结果见 [handoff-06](../../.scratch/task-archive-report/handoff-06.md)。当时版本操作/工具未验；07版本证据见下节。真实质量/计费、全仓npm test、Windows/断电/NFS仍未验。

## 07：历史版本、最新成功入口与显式重新生成

- `regenerateTaskReport(id, operationId, agentDir?)` / `POST /api/task-reports {action:"regenerate",id,operationId}` 从选定已提交报告复制完整 snapshot，读取当前报告专用设置，新 UUID、新 createdAt、新 body/materials；不捕获今日 session，不覆盖原成功正文或任何底层/中层材料。失败新版本仍使用06的原版本 retry/attempt，不另建重试系统；所有生成沿既有唯一串行 executor，board提交后锁外唤醒。
- 新报告仅增加 `regeneratedFromId` 与 `regenerationOperationId`，与原版本/操作绑定；同board锁内检查任务的已提交报告引用，双击/并发同ID/丢响应/完成后重发都确认同一新版本，不新收费。相同操作ID换来源返回409；非法输入400、未提交报告404、不可读快照/文件500。仍无配置则待配置、零请求；空快照仍生成元数据档案、零模型请求。沿02普通文件准备→board引用提交，无跨文件事务，孤儿不执行。
- `getTaskReportHistory(taskId, agentDir?)` 与 `GET /api/task-reports?taskId=...` 返回 `{reports,currentReportId,latestSuccessfulReportId}`。reports沿 `Task.reportIds` 创建顺序，current为最后创建版本；latest为该顺序最后一个 `generated && hasBody`，不是按 completedAt 选。在途/失败/待配置新版本不遮旧成功；无成功为null。全局 `listTaskReports`/无taskId GET、正文/material统一读取不变，供08复用。
- TaskReports 顶部独立最新成功链接、编号历史列表和最后创建版本当前生成状态，每份可显式重新生成；收费/原快照/当前设置/旧材料保留说明三语言齐全。提交错误保留原operationId，明确精确重发按钮，重读不会另授权收费。来源ID/截止仍是冻结快照标识，不伪装为可回跳的原历史链接；删除历史不影响档案读取。
- 恢复任务保留所有reportIds、不取消队列、不恢复session；恢复再归档形成新快照和新版本。报告不加编辑/审核/发布流程、通用版本数据库、兼容层或并行执行器。

### 07 自动验证

```sh
node --experimental-strip-types --test lib/task-report-history.test.mjs lib/task-report-recovery.test.mjs lib/task-report-chunks.test.mjs lib/task-report-generation.test.mjs lib/task-reports.test.mjs app/api/task-reports/route.test.mjs
node e2e/task-reports.mjs
node e2e/task-report-settings.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run lint
```

临时真实存储/HTTP/SDK受控provider短报告→所选原快照版本2→恢复再归档今日快照版本3；同operationId并发/丢响应/成功后确认、当前off设置、旧成功字节不变、失败新版本复用06retry。公开查询配合持久 completedAt 乱序模拟验证创建顺序最新规则，不建立并行executor。真实长历史底层/中层生成→删除来源→重新生成全新材料，原所有成功字节不变、全部材料API可读；空快照零请求及坏文件无今日fallback。报告UI三语言×1100/390真实版本链接/重新生成/收费/丢响应精确重发、恢复新快照与来源删除，既有材料与后台恢复回归保留。最终命令结果/截图及08交点见 [handoff-07](../../.scratch/task-archive-report/handoff-07.md)；08工具、真实模型质量/费用、全仓npm test/全平台仍未验。

## 08：Agent 全局只读检索与分页

- `lib/task-report-tools.ts::createTaskReportToolsExtension(agentDir)` 在正常 RPC session 原有 extensionFactories 中注册 `search_task_reports` / `read_task_report`，`exposure:direct`、`defaultActive:false`，明确 readOnly/idempotent、非 destructive/openWorld annotations；无模型、生成、重试、删除或源 AgentSession。没有新工具框架、额外权限或自动上下文注入。
- 普通/default、read-only、full 预设显式包含两个工具；none/Chat-only 不加工具（Chat-only 不注册）。配置模式不强制开启，遵守 SDK 解析的 `defaultTools`：`+search_task_reports` / `+read_task_report` 开启，`-name` 或无名称保持关闭，`[]` 不开启。复用原 pin/清除/reload/loadout/exposure；Code mode only 下工具仍 active/callable、声明隐藏，脚本使用相同结构化结果；单独 `[read]` 的缩窄选择不携带报告工具。不扩大其他 extension/MCP/写权限。
- `lib/task-reports.ts::searchTaskReports({taskId?,project?,keyword?,offset?,limit?},agentDir?)` 由同一 list/get/committed IDs 派生，只匹配 `generated && hasBody` 的全部历史版本。project 是冻结快照 projectRoot，`null` 表示无项目、省略表示全局；taskId 精确 UUID。keyword 为 trim 后不区分大小写的字面包含匹配，覆盖冻结 task 资料、综合正文及所有 durable 底层/中层正文，不做 embedding/向量库、不持久第二索引、不读当前 session。返回 ID、task 身份/项目、创建/完成时间、sources 截止/运行/缺失覆盖、所有 durable 材料 ID/level/input IDs/时间，任务字段概述上限320、正文概述上限480字符，无完整 snapshot/body/material正文。列表 offset 默认0、limit默认20/最大100；返回 total/next/end。
- `readTaskReportPage(reportId,materialId?,offset=0,limit=8000,agentDir?)` 复用 `readTaskReportText`；材料可为 `material-N` 与 `synthesis-L-N`，省略读取综合正文，失败报告的已保存材料也沿同一读取边界。参数仅ID，不接收路径。返回 `{reportId,materialId,text,offset,next,end,totalLength}`；offset 为 UTF-16 字符位置、limit最大16000，边界跨surrogate pair时多返回1字符，低半字符起点/越界/非法页大小普通错误。逐页拼 text 并传 next 可读完整尾部；结束 `next:null,end:true`，正文末尾空页也明确结束。缺失/未完成普通错误、不换读今日来源。
- 原 GET body/material、get/list/history 同用 committed IDs。报告查询改用 `lib/task-store.ts::readTaskStore`：复用既有完整 decoder 读取原子替换的 board 快照，不创建目录/锁/空board、不落盘迁移；仅查询变化，不改变 task 操作的原锁/CAS、06恢复/重试或07版本写入。工具结果提供 outputSchema/structuredContent，原工具面板使用模型工具描述，无新增 UI 文案或三语言键。

### 08 自动验收与边界

```sh
node --experimental-strip-types --test lib/task-report-tools.test.mjs lib/tool-presets.test.mjs lib/session-tool-selection.test.mjs lib/tool-preset-preference.test.mjs lib/rpc-manager-tool-exposure.test.mjs lib/rpc-manager-tool-exposure.integration.test.mjs lib/task-report-history.test.mjs lib/task-report-recovery.test.mjs lib/task-report-chunks.test.mjs lib/task-report-generation.test.mjs lib/task-reports.test.mjs app/api/task-reports/route.test.mjs lib/task-store.test.mjs
node e2e/task-reports.mjs
node e2e/task-report-settings.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run lint
```

临时受控 SDK provider 生成真实跨项目/无项目短报告、底层/中层报告及07新版本；经真实 startRpcSession 注册/激活并执行工具，验证全部过滤/组合/大小写/冻结项目、材料独有关键词、搜索翻页、每份正文/所有材料完整分页拼接与Unicode尾部、原API一致、缺失/路径/页错误、来源删除后读取。读前后整个临时 agent 文件集合/字节 hash 相等、provider请求数不变，源 wrapper 未启动，空全局查询也不建board。普通/只读/配置±开关/none/Chat-only/缩窄/reload及Code mode only exposure回归；脚本 nested-call 使用受控 transient assistant 父消息，非模型发起请求。报告/设置UI沿用三语言×1100/390，不起Next。真实命令/结果与缺口见 [handoff-08](../../.scratch/task-archive-report/handoff-08.md)；未验真实付费质量、全仓npm test或全平台，不将工具测试当这些通过。

人工零模型验收：受控目录已有成功报告 → 普通/只读工具面板看到两个名称 → 按task/project/null/材料关键词检索 → 逐页读取next直至end，拼接尾部；禁用配置名称或Chat-only后不可调用，不自动出现在聊天历史。来源删除不影响保存内容。

## 最终独立验收（2026-10-13）

01–08 已逐票实现并通过受控集成；独立 Spec review 无实质 finding，Standards review 的隐藏详情仍轮询 P2 已沿既有 active 生命周期最小修复并由原 reviewer 复核关闭。报告 UI 缓存/精确操作状态保留，隐藏停止读取、重开重读，后台生成继续。完整证据及残余验证边界见 [最终交付](../../.scratch/task-archive-report/FINAL-ACCEPTANCE.md)。

- `env -u NODE_OPTIONS npm test`：3008 总计，3004 通过、0 失败、4 Windows/PowerShell 平台跳过；全仓 tsc、lint 和 diff 检查通过。
- 报告浏览器9/9（原六组加实际 Dashboard 三语言390px生命周期三组）、设置浏览器6/6通过；受控 provider/临时数据与浏览器传输桥，不冒充真实 provider/SSE/收费质量。
- harness 相对 NODE_OPTIONS preload 在临时 cwd 引起的测试失败通过清除测试继承变量消除；不修改 MCP/env/stdio guard 生产代码。
- 真实收费模型语义质量 smoke、生产 build/install、真机与全平台验收仍未进行；以上各阶段历史命令记录不代替该边界。

## Rebase 与维护

- 交点是 SettingsPanel 通用区块、三语言目录、F02 picker、SDK model scope 和全局文件锁。不要把报告选择接到聊天默认星号、浏览器 next-cue 偏好或项目设置覆盖上。
- 关联契约：[F02 模型选择](model-thinking-picker.md)、[模型 topic](../agents/models.md)、[设置 UI topic](../agents/settings-ui.md)。每次修改同步本文件及索引。
- 归档现在可产生独立报告推理费用；归档、长历史/恢复/工具契约与本功能均已同步。后续修改继续维护对应行为证据，不把受控测试当真实模型语义质量证明。
