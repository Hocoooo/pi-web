# Task Dashboard 65 US / 24 T 证据分层 ledger（文档收尾版）

2026-10-09；整理自 `/tmp/task-dashboard-contract-audit-20261009/COVERAGE.md`（当时10claimed的只读准备），补10修复 `/tmp/t10fix-l8beyj3o/REPORT.md`、最终独立主 `/tmp/t10mr-mus4_2wp/REPORT.md` 与[父10接受](issues/10-reassign-session.md)。**01–14现在均父resolved**；文件名FINAL指稳定收尾ledger，不表示最终综合/全平台PASS。并行validator最终执行与父最终review尚待另报，本docs writer没有重跑应用套件或逐报告重新hash认证。

规格[spec.md](spec.md)与原[design-notes](design-notes.md)冻结基线不改；全14票coverage并集含65US/24T，但声明/计划≠执行证明。当前schema/CAS/迁移唯一表见[合同](../../docs/branch-features/task-dashboard.md#当前存储cas与迁移权威表)，长阶段失败因果见[历史附录](../../docs/branch-features/task-dashboard-validation-history.md)。原报告claimed/未合是历史，原/tmp与Comments不覆盖。

## 层级和执行边界

- **U**：纯验证/比较/投影；**O**：公共taskOperation+真实临时文件/fresh进程/锁/CAS/故障注入；**H**：实际route函数+Request/Response，非production网络/proxy E2E。
- **S**：source-contract正则/静态检查；**V**：提取handler VM；**M**：受控wrapper/busy/事件/合成compaction/response。都不能替实际页面/SDK/provider。
- **K**：真实临时SDK SessionManager/AgentSession/原route/wrapper；**P**：SDK stream/native faux Provider捕获。K/P不是收费provider wire/read/计费/取消/理解证明。
- **B**：真实Chromium页面、全API route fixture（部分接H/O/K/P），SSE模拟；**X**：未验真实平台/production/provider/耐久。integration/e2e命名不能自动升级层级，静态检查/命令/人工步骤不计执行pass。

以下每键指对应真实测试文件和既有命令-log-exit报告。旧报告配对结果归其冻结树，最终afterhash以修复报告manifest及独立10hash核对为准，不凭HEAD冒充未提交成果快照。全量2901/2897/0fail/4skip与joint266是修复方执行；最终独立77风险/早迁移与B22是独立执行，**不跨轮相加**。本ledger本身是文档映射，不是额外执行。

## 测试/证据键

| 键 | 实际测试入口/子场景 | 层级与主/独立/父证据 |
|---|---|---|
| E01 基础 | lib/task-operations.test.mjs、app/api/tasks/route.test.mjs、lib/web-auth-proxy.test.mjs、e2e/task-dashboard.mjs | O/H、auth有M/S、B；01父Comments与 `/tmp/pi-web-ticket01-late-edits-y1bpqf8u/REPORT.md`；fresh进程≠production重启 |
| EN 草稿导航 | components/AppShell.workspace-memory.test.mjs（source/VM）、lib/tab-session.test.mjs、e2e/task-dashboard-drafts.mjs | S/V/U+B React实际卸载/阻塞路由，history4+slow8/文字图片cwd零Agent；01父接受 |
| E02 资料 | lib/task-details.test.mjs、e2e/task-dashboard-details.mjs、task-dashboard-create-cancel.mjs | U/O/H+B8编辑/3语言cancel；`/tmp/pi-web-ticket02-review-fixes-y4r0gc02/REPORT.md`/父；稀疏labels拒绝保bytes |
| E03 顺序 | lib/task-order.test.mjs、e2e/task-dashboard-order.mjs、task-dashboard-retry-reload.mjs | O/B10鼠标/键盘/CDP touch+6精确retry；`/tmp/pi-web-ticket03-retry-fix-23S1QV/REPORT.md`/父，非Safari实机 |
| E04 scope/运行 | lib/task-sessions.test.mjs、task-sessions-integration.test.mjs、app/api/tasks/sessions.test.mjs、e2e/task-dashboard-sessions.mjs | O/H/K真实SDK/Git，事件M/win32 U，B7；`/tmp/m04-MOJzzo/REPORT.md`/独立/父 |
| E05 视图 | lib/task-views.test.mjs、e2e/task-dashboard-views.mjs、task-dashboard-summary-views.mjs | U/O/M+B11/双草稿；`/tmp/m05-KrSVnY/REPORT.md`、父views9/browser11日志；删ID由E14消费 |
| E06 知识 | lib/task-context.test.mjs、app/api/tasks/context.test.mjs、e2e/task-dashboard-context.mjs | O/H+B8；`/tmp/pi-web-ticket06-integration-ovsgdjnc/REPORT.md`、SSR恢复/独立/父，零模型 |
| E07 整理 | lib/task-summary*.test.mjs、app/api/tasks/summary.test.mjs、task-summary-fixture.mjs、e2e/task-dashboard-summary.mjs/summary-views | O/H/K/P+M、B11+联合2；`/tmp/f07-1YiNtC/REPORT.md`、父3默认Node子进程；真实费用/质量/取消X |
| E08 准备/发送 | lib/task-start.test.mjs、task-start-copy.test.mjs、task-start-migration.test.mjs、e2e/task-dashboard-start.mjs | K/P(streamFunction捕获，非native/wire)、部分失效token V、win32 U，B8/5SDK requests；`/tmp/m08-v3uqlo_0/REPORT.md`、`/tmp/m8iv-1009/REPORT.md`/父 |
| E09 更新 | lib/task-context-updates.test.mjs、task-context-update-review/conversion/archive.test.mjs、task-context-updates-fixture.mjs、e2e/task-context-updates.mjs | O/H/K/P、queue/context edit M、B9/6fake请求；`/tmp/m9f-x4GgSR/REPORT.md`、父15/15日志；成功SDK输入/响应≠wire/read |
| E10 改绑 | lib/task-relations.test.mjs、task-relation-boundaries.test.mjs、task-relation-migration-review.test.mjs、task-relation-column-removal.test.mjs、e2e/task-session-relation.mjs | O/H/K/P+busy M、B5；修复 `/tmp/t10fix-l8beyj3o/REPORT.md`、最终独立 `/tmp/t10mr-mus4_2wp/REPORT.md`/父10；坏数据10回归独立实际重跑，不依旧green |
| E11 copy | lib/task-session-copy*.test.mjs、lib/agent-client.test.mjs、e2e/task-session-copy.mjs | O/H/K、client M；B9真实SDK file复制+合成wrapper，后端review另实际runtime；`/tmp/m11-84vHSp/REPORT.md`、`/tmp/rm11iv/`/父；unknown孤儿非原子 |
| E12 archive | lib/task-archive.test.mjs、e2e/task-dashboard-archive.mjs | O/H/K/P、9类busy M、B6；`/tmp/m12-39pOIJ/REPORT.md`、父archive21/browser6；仅PiWeb入口 |
| E13 columns | lib/task-columns.test.mjs、e2e/task-dashboard-columns.mjs | O/H+B7；`/tmp/pi-web-ticket13-main-integration-20261009/REPORT.md`/独立/父；稳定done身份 |
| E14 remove | lib/task-column-removal.test.mjs、task-column-removal-context-updates.test.mjs、app/api/tasks/column-removal.test.mjs、e2e/task-dashboard-column-removal.mjs | O/H/K/P+B8/H真实GET/POST；3500 B全量/50k后端非DOM；`/tmp/m14-s1bbqjlr/REPORT.md`、`/tmp/rm14-guxyw6nv/`/父；10最终独立再验容量 |
| EJ 全域迁移/继承 | lib/task-start-copy.test.mjs、task-start-migration.test.mjs、task-session-copy-integration.test.mjs、task-relation-column-removal.test.mjs、task-relation-migration-review.test.mjs | O/K/P+compaction M；各主时点分列；10最终独立77实际包含v1/v2/main-v3/v4→v7早迁移及v6/未来epoch拒绝，较早receipt保留/fresh不写 |

## US1–65逐项映射（父接受范围与X仍分开）

| US | 行为摘要 | 责任票 | 证据键/层级边界 |
|---:|---|---|---|
| 1 | 独立看板不改聊天 | 01 | E01/EN O/H/B |
| 2 | 总览/单项目筛选 | 01/05 | E01/E05 U/O/B |
| 3 | 无项目任务 | 01 | E01 |
| 4 | 最多一个项目 | 01/04 | E01/E04 |
| 5 | 一任务多对话 | 04/11 | E04/E11 |
| 6 | 对话最多一owner/可无关联 | 04/10/11 | E04/E10/E11，owner+epoch ABA，已分别父接受 |
| 7 | 看板创建 | 01 | E01 |
| 8 | 聊天来源创建 | 04 | E04 |
| 9 | 手工整批关联 | 04 | E04 |
| 10 | 拒跨项目 | 04/10 | E04/E10 K真实Git，Windows实机X |
| 11 | 同项目worktree合法 | 04 | E04真实Git/平台X |
| 12 | 无项目scope隔离 | 04/10 | E04/E10 |
| 13 | 打开原聊天 | 04 | E04/EN B |
| 14 | 停止后解除/改绑 | 10 | E10正常race/完整busy/独立主接受 |
| 15 | 旧历史不遗忘警告 | 10 | E10 K/B；native字节保留，不承诺read清除 |
| 16 | copy/fork新session继承 | 11 | E11/EJ |
| 17 | 普通New不关联 | 11 | E11/EN |
| 18 | 初始五列 | 01/13 | E01/E13，删列后不补默认 |
| 19 | 全项目共用列 | 01/13 | E13 |
| 20 | 加/改名/调序列 | 13 | E13 |
| 21 | done改名仍完成 | 13/14 | E13/E14 |
| 22 | done/最后unfinished保护 | 13/14 | E13/E14 H/O |
| 23 | 非空删列明确接收 | 14 | E14全hidden/archive+独立done consent |
| 24 | 跨列/手动顺序 | 03 | E03 |
| 25 | 拖动不启动AI | 03 | E03 B零Agent |
| 26 | 状态完全用户决定 | 01/03/04 | E01/E03/E04，PiWeb入口边界 |
| 27 | Agent停/失败/声称完成不done | 01/04/08 | E04 M/K/E08 |
| 28 | 六条件组合 | 05 | E05 |
| 29 | 保存重开视图 | 05 | E05 O/B |
| 30 | 手动/自动排序 | 05 | E05 U/O/B |
| 31 | 自动同列禁调序/跨列可 | 05 | E05 B/E03 |
| 32 | 筛选不丢hidden任务 | 03/05/14 | E03/E05/E14 |
| 33 | 卡片字段/数量/运行 | 02/04/11 | E02/E04/E11 |
| 34 | 详情资料/对话/知识 | 02/04/06 | E02/E04/E06 |
| 35 | 开始默认new/可continue | 08 | E08 |
| 36 | prepare不发/独立Send | 08 | E08 B/K/P |
| 37 | 多对话并行 | 08 | E08受控真实wrapper，非production长时压力 |
| 38 | 同cwd风险确认 | 08 | E08，无文件隔离/合并保证 |
| 39 | 工作badge独立状态 | 04/08 | E04/E08/E05 unknown |
| 40 | 主动点击才整理 | 07 | E07 |
| 41 | 来源/聊天默认当前 | 07 | E07 K/B |
| 42 | 默认文字/工具结果opt-in | 07 | E07 K/P |
| 43 | 不自动读附件/全文 | 07 | E07 S+K/P/B网络拦截，层级分列 |
| 44 | 删减批准资料 | 07 | E07 P/B |
| 45 | 来源/全局默认模型 | 07 | E07 K/P/B |
| 46 | 显示临时换模型 | 07 | E07 |
| 47 | 临时model不污染设置 | 07 | E07 K/P |
| 48 | 四节摘要手改 | 06/07 | E06/E07 |
| 49 | 确认才共享 | 06/07/09 | E06/E07/E09；confirmed≠已读 |
| 50 | history不可变/恢复新版本 | 06 | E06/EJ |
| 51 | 新task session锁confirmed版 | 08/09 | E08/EJ；laterSend重核不偷偷追新 |
| 52 | 已有对话提醒/显式接收 | 09/10 | E09/E10，同锁改绑不自动接目标版 |
| 53 | busy选择/下次eligible Send | 09/10 | E09/E10 clear/ABA/latecallback |
| 54 | 共享不拼全history | 06/07 | E06/E07 K/P |
| 55 | 来源/版本可追溯 | 06–09 | E06–E09/EJ，raw/input/wire分层 |
| 56 | 归档恢复 | 12 | E12 |
| 57 | archive历史可查 | 12/14 | E12/E14/EJ |
| 58 | busy不能archive | 12 | E12 M/K/P，外部绕wrapper不控制 |
| 59 | archive不Stop/done | 12 | E12 |
| 60 | 刷新/重开/持久 | 01–06/09/11–14 | O/fresh/EJ/B；非production安装重启 |
| 61 | 多页CAS/幂等 | 01–06/09/10/12–14 | 各O/B/E10；各CAS独立/native非跨文件事务 |
| 62 | 失败可见不伪success | 01–14 | O/H/B/E10拒损坏；unknowncopy非自动恢复 |
| 63 | 键盘/手机核心操作 | 多票 | B Chromium/CDP，Safari/软件键盘X |
| 64 | 原权限/model/history | 01/04/07–12 | EN/E04/E07–E12/EJ，Chat-only/exact-system，真传输X |
| 65 | 临时资料/模拟模型 | 01–14 | O/K/P/B fixture；TEST-ISOLATION真实Git事故保留，不称从未越界 |

## T01–T24子场景、执行事实与接受边界

| T | 责任/子场景与测试键 | 已有实际执行/父接受 | 仍未验或不能扩大的边界 |
|---|---|---|---|
| 01 | 01/02/06/12/13/EJ；创建编辑、fresh重开、列/order/关系/knowledge/archive保留 | E01/E02/E06/E12/E13 O/H/B；E10最终独立早迁移2及坏数据10实际执行 | 非production重启/最低Node/断电耐久，不把fresh进程代平台 |
| 02 | 04/10；批次scope/worktree/no-project/唯一owner | E04真实SDK/Git+E10 same-scope/跨scope，均父resolved | win32 normalization U非Windows实机 |
| 03 | 10；busy拒/idle改绑/原子clear/ABA/oldnative/latecallback | E10正常3race、独立75风险中关系/10×14/损坏回归及B5，父全部验收 | 两P2仅刻意坏数据，不称合法入口漏洞；N1既有P2仍未修 |
| 04 | 11；三copy入口/New/树导航、unknown/异常2xx/child历史 | E11/EJ O/H/K/B9、独立opener拓扑/父 | native/board非原子，unknown窗口孤儿/重复；无真实收费 |
| 05 | 01/13/14；默认/add/rename/order/done/lastunfinished | E01/E13/E14 H/O/B，稳定ID后端保护 | 已删默认不重加，旧代码downgrade可拒读 |
| 06 | 14；全hidden/archive/取消/done独立确认/CAS/确定顺序 | E14 O/H容量50k+B3500全量8，独立14与10重验 | 非50k DOM benchmark/NFS/断电 |
| 07 | 03/05/14；同/跨/空列、hidden邻居、失败sync原UUIDretry | E03/E05/E14 B鼠标/键盘/CDP touch，父03六retry复核 | Chromium touch非Safari/iOS传感器验收 |
| 08 | 05/14；六条件保存重开、auto不写、edge、删IDfailclosed | E05 U/O+B11，E14实际打开旧view失败条件 | 100views/个人O(n)，不扩大任意query/规模性能 |
| 09 | 01/02/04/08/11；卡片详情、原source导航、prepare与Send | E01/E02/E04/E08/E11 B、K/P firstrequest | fixtureHTTP/SSE不是production联调 |
| 10 | 01/04/08；pending/queue/UI/compact/shell仅badge不done | E04/E08 M+真实wrapper，原队列guard | 受控事件M、不称外部进程全可观测 |
| 11 | 08；同cwd真实busy、明确风险确认、正常排队、多session | E08 K/P/B | 无文件锁/自动worktree隔离/合并/生产并行写安全 |
| 12 | 12/14/10；archive-before/start-before、原chat/native/关系/copy门禁 | E12 barriers/21与B6、E14全归档、E10同锁active/后scope busy重查，分别父接受 | trusted extension/CLI直接绕wrapper不沙箱 |
| 13 | 07；浏览/结束不生成、显式选择/预览/model确认、取消 | E07 B/K/P，零额外dispatch断言 | fixture零外网不是真实provider计费观察 |
| 14 | 07；branch/已完成text/逐tool opt-in/删减、敏感block排除 | E07真实SDK/P/浏览器；S边界分列 | 工具text可能含文件内容，不保证自动脱敏/默认读路径 |
| 15 | 07；source/global/临时model、unavailable不fallback、auth→dispatch | E07 K/P/B，父fastreject3默认Node；来源model/queue/manager不变 | faux provider/可信extension；真实费用/取消/deferred实机X |
| 16 | 06/07；draft编辑取消/确认/restore历史、失败保current | E06/E07 O/H/B、真实provenance | AI质量/事实真伪/模型理解X，人工确认不是真实性保证 |
| 17 | 多票；fresh并发/两tab固定base、各CAS/旧receipt不回拨 | O/B E01/E03/E05/E06/E09/E10/E12/E14/EJ；独立10旧receipt/ABA/fresh原bytes | 非多serverdispatch协调；各CAS不能泛称同一个revision |
| 18 | 08/09；首锁confirmed/旧continue不追新/pending原明确版 | E08/E09/EJ K/P+B、R1/R2与父15测试 | receipt/append非provider使用；09仅sdk-input-successful-response |
| 19 | 09/10；busy持久next、queue/retry不投、旧success不清新pending | E09 R1/R2/R3、E10 reassign clear/ABA latecallback/新pending，最终独立实际执行/父 | logical boundary非多server协调器，旧delivery须当前owner合法才确认 |
| 20 | 08/09/11；normal read配对、Chat-only exact/model、branch/edit/child | E08/E09/E11/EJ K/P，compaction部分M | raw可存但投影可排除，不伪child读；合成压缩非模型质量 |
| 21 | 多票；持久fresh/CAS失败保bytes、B断线重读/metadata、容量 | O/B/EJ、50k H、v7损坏首次及两fresh拒不写的独立10 | 无大量长session完整benchmark/production重启/断电/NFS，capacity非整个T21通过 |
| 22 | 01/04/06–12；auth/Host/Origin/白名单/scope、被动Markdown/权限 | auth M/S+H、E01/E04/E06–E12 K/P/B，边界层级分列 | fixture通常绕productionproxy网络；无tools不等自动事实审查 |
| 23 | 多票；Chromium键盘/native controls、390px/CDP pan/表单/确认 | E01–E10/E12–E14/EN B、10独立B三运行22场景；票据已接受当前可测范围 | **部分平台验证**：Safari/iOS16.2真机/软键盘/最低浏览器未验 |
| 24 | 01/03/04；host/依赖许可/语法/平台目标 | macOS Node26、MIT/版本/React peer声明、ES2018/Safari目标静态语法与win32 U | **未完整平台验证**：Windows SDK/ACL/browser、Node22.19执行、productionbuild/install、Safari实机；4skip≠pass |

## 10最终状态变化与报告配对

旧审计E10/US14/15/T03“claimed候选”现已由实际主窄修+独立复审+父接受取代，不覆盖旧报告：

- `/tmp/t10fix-l8beyj3o/results.json` / logs/regression-3.log 10/10、normal-1 3/3、joint-2 266/266、full-3 2901/2897/0fail/4skip、tsc-2/lint-2 exit0，browser-results.json11运行exit0。full-1 interrupted exit:null不计green；修前7fail/3pass与original诊断缺口保留。
- `/tmp/t10mr-mus4_2wp/risk-results.json` / logs/risk.log75/75、early-migration-results.json/对应log2/2，browser-results.json relation5/remove8/update9，均exit0。独立afterhash1263/1263、累计52文件/8新patch符合修复方manifest。独立没有重跑全套/joint/tsc/lint，而是核对上述实现方配对日志。
- 独立实际H容量3500store1,747,935/50k25,014,686bytes（<32MiB），旧数组276724/3950225bytes413，新296/297bytes200，partial409/done无consent400，完整hidden/archive与no-persistedmap/receipt当前authority。不同报告storebytes依版本字段不同，不混写为同快照。
- 父已在票据10接受全部验收并resolved；这不是父最终综合验收。并行最终validator新命令/afterhash/log/exit另报，不能预填此ledger为已执行。

## 剩余风险与历史保护

N1既有P2external-delete持久session后set_tools headerless/500未修；copy未知prepared可能孤儿/重复、不自动恢复或猜parent链；board/JSONL非跨文件事务，外部writer/CLI/trusted extension绕wrapper非控制范围。

[TEST-ISOLATION](TEST-ISOLATION.md)事故确实创建Git worktree/ref、父精确clean检查后清理，不能宣称测试从未越界。06SSR失败达到门槛后父恢复30142、源码hash不变、旧.next保留，不由green推定具体根因。07fatal、08R1–R5、09R1/R2/R3、14数组413/rename注入、10canonical/坏数据red/无exit均[历史附录](../../docs/branch-features/task-dashboard-validation-history.md)保留。

真实provider wire/read/理解/计费/取消/网络/质量、productionSSE/build/package/install、Windows实际SDK/ACL/Explorer/UIA/PowerShell/browser、Safari/iOS16.2真机/软键盘、最低Node22.19、断电/NFS/kill-mid-write未验。4Windows-only skip明确是junction、Explorer reveal序列/恢复、PowerShell productionparse、无eligibleExplorer/UIAfallback，不算pass。POSIX注入/CDP/3500B/50kH不代真实平台。
