# 08: 从任务开始新对话或继续旧对话

**What to build:** 用户在任务中点击“开始执行”，选择新建或继续旧对话，检查准备发送的任务信息后再独立发送；新对话使用明确确认的共享重点，运行不会自动改变任务状态。

**Blocked by:** 04（把已有对话归入任务）、06（手动编写、确认和恢复共享重点）。

**Status:** resolved

## Acceptance criteria

- [x] 提供新建与继续已有合法关联对话的选择，默认新建；准备内容后进入现有聊天界面，用户独立点击发送才真正调用模型。
- [x] 打开任务、准备对话和查看预览不发普通 prompt、不更改任务状态，也不覆盖已有草稿；保留现有显式导航和草稿处理合同。
- [x] 新对话带上任务说明和明确选定的最新确认共享版本；没有已确认共享重点时也能预览任务说明并工作，不要求先生成摘要。
- [x] 预览与发送之间共享版本发生变化时不静默换成用户未见内容；明确提示并允许核对，实际发送的任务、版本和来源有可追踪记录。
- [x] 首条消息接受前完成真实 sessionId 的任务关联与版本选择；关联失败不继续发送，重试不会重复创建或错误归属会话。
- [x] 继续旧对话保留其已有历史和已经采用的资料，不自动升级为最新共享版本；显式更新的完整交互由 09 提供。
- [x] 验证现有 SDK 支持的上下文投递方式，以普通来源资料表达任务知识，不替换精确系统提示、不手改 JSONL 或只读状态，不执行共享文字内的指令。
- [x] 同一任务可并行工作，使用相同代码目录时启动前提示风险；不宣称已隔离文件、不自动创建或合并 worktree。
- [x] 实际发送走既有准入、排队、取消和错误处理；失败保留可恢复的草稿及正确关联，运行提示更新但任务状态不自动改变。
- [x] 使用临时真实 SDK 会话及模拟 provider 检查首条实际请求的版本、普通/Chat-only 权限和历史配对；浏览器验证新建、继续、预览取消、真正发送及同目录提示。
- [x] 同步任务启动、会话和导航相关合同；记录 SDK 接入依据与真实模型、平台验证缺口，不默认调用真实付费模型或修改真实工作区。

## Scope and handoff

不依赖 07，手工发布的共享重点足以验收新对话接入。使用已有会话引擎及其发送准入，不新建另一条绕过权限的执行路径。09 在此基础上增加对已有对话的显式版本采用。

12 后续在同一启动入口及原聊天发送入口加入归档检查；本票据不提前实现归档。来自更新/归档等后台事件不能自动触发本票据的发送动作。

## Spec coverage

用户故事：US35、US36、US37、US38、US39、US51、US55、US62、US63、US64、US65。
访谈选择：Q12、Q13、Q14、Q20。
实现决策：D2、D5、D9、D10、D11。
验收计划：T09、T10、T11、T18、T20、T22、T23。

## Comments

2026-10-09（父验收）：08主v5集成独立复审无新阻断，R1–R5未回退；独立30SDK联合、10原probe、
213跨域及4新主probe通过（另确认重跑213），08/11/07–05/01浏览器8/9/2/12场景及tsc/lint通过。
父核对41增量与主full2785pass/0fail/4skip、256focused及18browser报告，按08范围验收resolved。
主证据 `/tmp/m08-v3uqlo_0/REPORT.md`，独立 `/tmp/m8iv-1009/REPORT.md`；07/11历史与v5所有域保持。
选定receipt、原生append、实际provider输入不混同；child不复制source receipt/不补source pending/不追latest。
N1外部删除session后set_tools无header/500机制与before同，作为既有P2后续项保留，不宣称已修复。
真实provider、生产SSE及Windows/Safari真机/最低Node等仍未验证。09/12现解锁，不代表已实现。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

2026-10-09：并发槽3领取08，冻结baseline+HEAD，04/06已resolved。唯一源码写入ticket08；05/07不依赖、不写入。固定gpt-6.1-sol/high，无嵌套Agent。核实SDK 1.0.0文档与声明：sendCustomMessage支持triggerTurn:false/nextTurn，custom资料转为user而非system；沿既有wrapper prompt admission接入，09/12不提前实现。验收仍由父代理决定。

2026-10-09 fresh-context接管：前agent aborted/507后未发现最终REPORT/exit配对，旧 /tmp/t08-jG1ARI 输出和失败完整保留，不补旧exit、不继承“最终全绿”。冻结overlay92文件hash与HEAD85cc4f38已核实；next.config/AGENTS先确认还原且30143–45无监听，再仅本树dev30145完成新隔离验证并停止/恢复原字节。保存恢复计划 RECOVERY08.md。

恢复仅补两处经红测确认的必要守卫：失效task token的steer/follow-up不dispatch且恢复文字/图片；new-route在task校验前记录commandType，直接prompt校验失败明确accepted:false。新增实际model/context/system/tools捕获及首provider入口已durable关联/版本断言、真实store失败后同UUID重试、原生重开+SDK合成branch/compaction历史配对；不重写既有实现、不合主05、不实现09/12。11复制继承的native历史与new-start receipt必须区分（不得直接拷source sessionContexts tuple），集成说明见08功能合同及报告。

fresh SDK12/12、扩大focused174/174、full2709 tests/2705pass/0fail/4Windows-only skip、tsc/lint exit0；14浏览器脚本最终全部exit0，08两轮7/7、每轮5个真实SDK/模拟provider captured request。首次新增expired浏览器locator文案错误timeout/exit1及两处红测保留。完整配对命令/log/exit、捕获、精确baseline增量含新增文件/hash和迁移冲突清单见 /tmp/r08-o5OMrc/REPORT.md。无真实收费provider/用户资料、install/build/commit/push。仍claimed、验收勾选保持空，等待父主集成与独立review；Windows/Safari真机/最低Node/生产打包与真实provider等未验边界不扩大。

2026-10-09 独立review后父授权R1–R5窄修，仍只08树：完整读 /tmp/r08-o5OMrc/REPORT.md 顶部审查及 /tmp/r8iv probes，先新增7条有效红测（含R2三预设）全部失败，再修复并fresh回归。R1 receipt≠native delivery：continue补原pending snapshot，SDK所有native entries已append则不重复；无receipt legacy不自动收current。R2未flush prepared UUID跨Chat-only/configured重建保持，identityguard未放宽且删除持久file不复活。R3含任何taskStart属性的原生steer/follow_up拒绝，改用prompt统一准入，无metadata原生队列保留。R4真实HTTP handler先拒内部admit-start，byte不变；wrapper共享store仍可调用。R5busy/catalogue共享native relative/join/isAbsolute scope，win32纯路径及Mac真实SDK验证，不冒称Windows E2E。

本轮fresh SDK20/20、focused182/182、full2717/2713pass/0fail/4Windows-only skip、tsc/lint0；14浏览器最终exit0，08两轮8场景/各5实际SDK request，原草稿/资料/排序/关联/知识/列/导航回归保留断言。新增工具UI首轮因继承fixture用了错误storage key而非Chat-only初始化失败，保留exit1后只改fixturekey，不放宽identity/queue/provider/draft断言。自己的30145已停、Next config/AGENTS/next-env原字节恢复，dev前后原配置检查均通过。新REPORT/精确原baseline增量/hash在 /tmp/r8f-CIYhG2；旧实施及独立review全文保留。无新schema/框架/09/12/主05或07/11合入；选择、SDK append、provider已读三阶段不混同，11不能copy新建receipt给child。08持续claimed，验收未勾，待独立再审及父决定，未验平台/真实provider边界不扩大。

2026-10-09 主语义集成：源只读、36文件精确delta已核hash，独立再审 `/tmp/r8rr-1009/REPORT.md`关闭R1–R5后逐hunk合主，保护已resolved01/02/03/04/05/06/07/11/13。主before全hash/快照及fresh证据 `/tmp/m08-v3uqlo_0/REPORT.md`；父PARALLEL变更保留并排除产品delta。v5按字段保留sessionCopies/views/AI provenance/history及全部CAS/receipts；child不copy source new-start tuple，显式Continue只显示匹配SDK历史的原版本/来源，不伪child provider已读、不追latest、不补source pending。原11intent/异常2xx/未知空tab重试/生命周期不动。

主fresh：SDK20/20，08+11实际SDK9/9及独立联合迁移1/1，原独立probe主重放10/10，扩大focused256/256；full2789项/2785pass/0fail/4Windows-only skip，tsc/lint0。18独立浏览器脚本+08确认均exit0（08两轮各8场景/5实际SDK request；copy9/summary11/views11/context8/sessions7/draft12/retry6/columns7等）。联合继承预览先5有效red再green；首次fixture fork定位两个错误、tsc unknown收窄、socketguard过严误挡本地fixture导致full失败均留原日志，不伪通过；仅树外guard允许loopback且验证proxy lookup真实本地地址，产品断言未放宽。final SDK/联合/重放12测试进程socket尝试0。已知外删持久file再set_tools无header/500为基线P2，未修整套SDK。只复用健康30142，无服务/build/install/commitpush/真实模型keys动作。09/10/12/14未实施；08仍claimed、不勾验收/resolved，待独立主复审及父验收。
