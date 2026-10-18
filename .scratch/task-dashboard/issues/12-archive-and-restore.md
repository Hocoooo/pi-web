# 12: 归档与恢复任务

**What to build:** 用户可以将不再需要的任务从日常看板隐藏，之后查找并恢复；所有历史保留，但有关联 AI 正在工作时不能归档，也不能从另一个入口绕过运行限制。

**Blocked by:** 08（从任务开始新对话或继续旧对话）。

**Status:** resolved

## Acceptance criteria

- [x] 归档从日常看板隐藏，提供可发现的归档列表或筛选入口并支持恢复；不要求未完成任务先被标记完成。
- [x] 归档与恢复保留任务状态、资料、手动顺序、对话关联、共享当前版本和历史，不删除原生会话，不提供彻底删除操作。
- [x] 有关联 AI 正在工作、等待交互或处于既有未结束队列时，后端拒绝归档并说明原因；只能等结束或用户另行主动停止。
- [x] 归档不调用 abort、prompt 或其他运行控制，也不改业务状态，不把归档成功描述成完成。
- [x] 实际归档时重查所有关联运行状态；任务启动和归档竞争通过统一操作规则得到一致结果，不能两边基于过期状态都成功。
- [x] 已归档任务从任务入口启动前要求恢复；原聊天发送入口也遵循该约束，不能只在看板禁用按钮而让任务隐藏后继续启动。
- [x] 关联和改绑等已存在入口不能把运行中的对话悄悄放进已归档任务以绕开约束；所有冲突有明确提示，不自动恢复或停止其他工作。
- [x] 存储重开、页面断线恢复和两页面归档/恢复竞争保持一致，失败不丢资料、不假报成功；后来共享更新不会自动恢复任务。
- [x] 临时存储和真实临时 SDK 生命周期测试覆盖保留历史、停止后归档、忙碌拒绝、启动竞争及原聊天入口；浏览器验证归档列表、查找、恢复和错误提示，不调用真实付费模型。
- [x] 同步归档、启动及关联合同，明确规则只控制 Pi Web 管理的操作，不宣称能阻止任意外部进程写文件或发模型请求。

## Scope and handoff

08 提供实际启动入口并间接带来 04 的关联与 06 的共享历史，所以能够验收“不隐藏仍在工作的任务”，不只是隐藏卡片。对于本分支尚未实现的其他入口无需造占位模块，后续接入必须使用同一运行检查。

14 删除状态列时须包含本票据的归档任务；对归档状态的保护不意味着其原任务列永远不能调整。

## Spec coverage

用户故事：US56、US57、US58、US59、US60、US61、US62、US63、US64、US65。
访谈选择：Q19、Q28。
实现决策：D2、D5、D6、D10。
验收计划：T01、T12、T17、T21、T22、T23。

## Comments

2026-10-09（父验收）：源独立review21SDK/212扩大/4API及unknown/corrupt probes通过，无具体阻断。
父核对主所有生产文件与该已独立审查源字节相同，检查原pending预留和同锁guard，并独立重跑
主archive21/21与归档浏览器6场景通过（/tmp/pi-parent-ticket12-archive.log、/tmp/pi-parent-ticket12-browser.log）。
结合主两轮full2806pass/0fail/4skip、216focused、tsc/lint与22浏览器证据，按12范围验收resolved。
09仍别树开发，其pending/采用路径需要后续联合，不继承本结论；14现解锁。
只保证PiWeb管理入口，外部CLI/绕wrapper trusted extension/真实平台及provider边界仍未验证。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

2026-10-10 主唯一写入者领取并语义集成12：固定gpt-6.1-sol/high，08与01–07/11/13均保持父resolved。源只读 `/tmp/pi-web-parallel-0912-8c00mma6/ticket12`，精确31文件/6新增patch SHA256 `f9dfef069da533dd7193642672ce45e3063ccbc161f4f7cf75ed5ed7b2f3b410` 核验；主beforehash确认所有修改文件与baseline136+HEAD一致，逐hunk合入，不覆盖PARALLEL/HANDOFF/原父评论/receipt/draft。09未主、不读写别树、不猜pending字段；保留共同guard供后续合入，10/14未实现。

同v5 archive absence-only迁移及独立archiveRevision/latest receipt，同board锁重查完整原runtime busy与07active；原pendingPromptCount在所有await前预留工作，原chat/task-start/native queue/compact/bash/Web custom UI输入均要求active。归档不Stop/restore/prompt/改业务状态；link/copy不能将busy塞归档；scope外部CLI/进程/任意扩展自行绕wrapper不宣称受控。默认隐藏+可发现列表/查找/恢复、错误/CAS/精确重试；归档task仍可移列供14，05六条件不改。主新增08/11/07/05/13/03全域旧v5迁移与归档/恢复/旧精确receipt联合真实SDK断言，保护选择≠native append≠provider读。

主新Git树外短/tmp证据 `/tmp/m12-39pOIJ/REPORT.md`，含before/afterhash、主增量含新增patch/hash、fresh命令/log/exit/provider捕获和平台边界。源2806pass不是主通过。只复用metadata健康30142，无服务/配置/build/install/commitpush动作；测试HOME/TMPDIR/agent/tsbuildinfo隔离、env-i清三aliases、显式fakeprovider/socketguard、无真实资料/keys。保持claimed/所有验收未勾，待独立主复审与父验收。

父转交源独立review：无具体阻断；21实际SDK、212扩大、4API及unknown-activity/corrupt-store两probe通过、0socket。复核确认await前pending reservation+同board锁active/CAS/busy重验成立；主保留此时序。此为源复审，不算独立主复审或并行09兼容验收，09须后续联合。

主fresh最终：full两轮各2810tests/2806pass/0fail/4Windows-only skip（final包含新增联合archive断言）；focused216/216、archive21/21、联合迁移1/1、真实SDK窄集两轮56/56/确认11进程0socket，tsc/lint0无警告。22次浏览器运行全部exit0：新归档6场景两轮及delivery确认；08start8+5实际请求、11copy9、07summary11、05views11、01draft12、06context8、04sessions7、13columns7、03order10/retry6及必要导航。首次focused工具180秒超时原log/command/start保留，不补造exit、不算pass，fresh重跑通过。socketguard另阻断npm notifier两次registry意图，零实际外连/安装；full合法loopback另计，不宣称全量0socket。当前仅12主验证，保持claimed待独立主复审/父验收，09后续联合。
