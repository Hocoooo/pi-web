# Task Dashboard 验证历史附录（非当前行为或最终综合验收）

2026-10-09 文档整理。当前合同见[看板](task-dashboard.md)及[索引](README.md)；当前01–14均父resolved，schema v7。这里的v1–v6、claimed、未合/待review和计数只描述**当时**，不是当前状态。原/tmp报告、red/green/中断、票据Comments与恢复记录不修改；以下按失败因果→修复/复验→证据指针整理，不跨轮累计pass或把源green当主green。文档整理前完整原文快照在 `/tmp/task-dashboard-doc-close-20261009-ue5bydmt/before/`（hash见同目录beforehash.json）。

## 01 基础与三轮草稿/幂等修复

- 首轮SDK aliases污染导致119 fail；只测试子进程清PI_PACKAGE_DIR/JITI_ALIAS/JITI_RESOLVE_ALIAS后基线2625pass/4skip，污染失败仍在 `/tmp/pi-web-ticket01-u6G2wi/baseline-tests.log`，不能称通过。最初30141全局生产 `/tasks`404不是checkout dev，也未停止/重启它；旧launcher/listener21036/21044仅历史。
- 独立review发现创建重试依赖今日目录和Link往返草稿丢失。真实red-store目录删失 invalid-input、red-browser项目/无项目文字丢失；前两个fixture字段/locator错误不算有效red。修复不可变创建指纹先确认与身份专属草稿停放。证据 `/tmp/pi-web-ticket01-fixes-yVWxPr/REPORT.md`。该轮2640pass/4skip不是后两轮证明。
- Link返回后再history离开未覆盖；四history路线文字空/图片0。捕获popstate初试未覆盖Next卸载时序亦失败；改为目标/tasks的layout cleanup先停放，普通弃用清理保持。证据 `/tmp/pi-web-ticket01-history-fxzcewjw/REPORT.md`。
- 键盘间歇line53超时曾在first/retry/confirm/diagnostic中交替；诊断URL选中早于composer加载，Alt+Right按合同回退chat container。350ms fixture复现；原产品焦点逻辑不改，测试只等composer前置，不放宽焦点断言。早期失败保留。
- 第三轮独立review发现Link eager rekey与真正departure重复，慢路由期间编辑/删除被合并或复活。八有效red覆盖project/no-project × 改文/清文/删图/全清；仅移除eager callback，真正departure单次最后快照。最终history4+slow8两轮12/12；fresh158、焦点27、full2641pass/4skip和七浏览器配对证据 `/tmp/pi-web-ticket01-late-edits-y1bpqf8u/REPORT.md`。01后由父接受，原writer报告claimed保留。

## 02 资料与稀疏标签/Cancel窄修

- 初始真实store/API/fresh/B8，类型构造、可访问名/原生select/about:blank fixture失败保留于 `/tmp/pi-web-ticket02-ku39rmd2/REPORT.md`；当时优先级比较器不等于05自动排序已交付。
- reviewer发现Array(1)被some跳过，写null导致整板坏；创建Cancel使用不存在common.cancel裸key。有效red后逐槽Array.from检查、换sidebar.cancel；前/中/后稀疏拒绝且bytes/revision/time不变，三语言cancel3/3零Agent，父独立资料9/9+cancel3/3关闭。证据 `/tmp/pi-web-ticket02-review-fixes-y4r0gc02/REPORT.md`；该轮2650pass/4skip。

## 03 顺序、依赖与失败重读

- 经典@dnd-kit/core6.3.1，utilities3.2.2/accessibility3.1.1；核对npm metadata/tarball完整MIT、SHA512、React peer19.2.4和ES2018/Safari目标语法。未用sortable或新代@dnd-kit/react；声明/语法不等于Safari运行。来源/许可资料 `/tmp/pi-web-ticket03-20261009-173230/{packages,dependency-check.log}`。
- 当时DNS证书问题仅官方域下载子进程Cloudflare解析覆盖，TLS/SNI保留；未改全局证书配置。production默认漏dev deps后include=dev恢复，PostCSS触发图重读后原bytes恢复，未重启服务。
- 真实160连续插入/hidden邻居、fresh竞争/receipt/POSIX及CDP touch。review后P2为成功reload丢未确认移动错误/原retry；六组合（unsent/lost-success × online/focus/manual）先全red，reload依赖当前retry后全green，父独立6/6。证据 `/tmp/pi-web-ticket03-retry-fix-23S1QV/REPORT.md`。provider中断后核验16组日志/exit，不补造测试；2659pass/4skip仅该轮。

## 06 人工知识与SSR恢复

- 隔离 `/tmp/pi-web-ticket06-evidence/REPORT.md` 不代主；主 `/tmp/pi-web-ticket06-integration-ovsgdjnc/REPORT.md` focused52/full2670pass/4skip，context两轮8/8，但01draft两次最后pageerror因MermaidBlock/react-syntax-highlighter SSR失败，未洗成全绿。
- 独立诊断fresh浏览器/HTTP连续三轮同失败，父授权仅恢复30142临时dev、备份旧.next。1184源码/依赖hash不变，原loop三轮green及06/01/03/02回归通过，关闭集成阻断但不推定旧缓存/进程具体责任。证据 `/tmp/pi-web-ticket06-dev-recovery-ok47x43_/REPORT.md`；旧.next `/tmp/pi-web-ticket06-next-backup-dt86trq7/.next`。当前执行不能凭旧PID行动。

## 13 / 04 / 05 的主组合与隔离事故

- 13源18文件/3新与主01/02/03/06按域三方合，v2→当时v3保留知识/history/receipt。主 `/tmp/pi-web-ticket13-main-integration-20261009/REPORT.md` full2681pass/4skip、2迁移/跨进程与浏览器独立交叉后父resolved；当时04未合描述是历史。
- 04 uncached权威Git/path校验关闭同路径A→B被sidebar缓存误授权P2；main-v3 columns/context→当时v4，不接受未发布source-only v3。主 `/tmp/m04-MOJzzo/REPORT.md`，独立store12/B7/双草稿2后父resolved；full2693pass/4skip不代表后续09/10。
- **TEST-ISOLATION真实事故**：in-tree TMPDIR/HOME让非Git fixture发现祖先Git/node_modules，创建agent worktree/ref，且socket路径长。父核对事前清单、clean/HEAD/reflog/无进程后仅精确无force remove及expected-old-hash ref删；没有掩饰“从未共享Git写入”。[原记录](../../.scratch/task-dashboard/TEST-ISOLATION.md)，证据 `/tmp/pi-web04-git-incident-vvqf8lyr/`、04隔离树ticket04-evidence/REPORT.md。
- 05当时同v4 additive views双字段absence-only、确定纯投影、unknown与固定双草稿。源 `/tmp/p05-Yumftb/REPORT.md`、主 `/tmp/m05-KrSVnY/REPORT.md` full2702pass/4skip；父views9/B11另验 `/tmp/pi-parent-ticket05-views.log`、`/tmp/pi-parent-ticket05-browser.log`。不继承源或后续容量green。

## 07 鉴权/来源与快速Promise fatal

- 主 `/tmp/m07-zsEOPj/REPORT.md`；独立主关闭鉴权await之后真实同步dispatch、后追加context_edit失效及warm nullleaf三阻断，原review `/tmp/rm07-fHPYhO/` fatal/browser exit1保留。SDK lazy completeSimple Promise创建不是Provider dispatch。
- 新P2快速不可用在async解锁前成为unhandled rejection；默认Node/caller trycatch child exit1有效red。只及时安装局部观察，原Promise仍reject向caller，不全局忽略/吞错；3种fast失败green、父3/3 `/tmp/pi-parent-ticket07-rejection.log`。最终 `/tmp/f07-1YiNtC/REPORT.md` full2719pass/4skip、focused101/B两轮11及联合，07父resolved。源 `/tmp/p07-EtZ11U/REPORT.md` 仅隔离证据。

## 11 copy异常2xx与未知结果

- 源 `/tmp/p11-ATUUwE/REPORT.md` 不代主 `/tmp/m11-84vHSp/REPORT.md`。review R1异常2xx必须envelope+result双验证，不清UUID；R2未知prepared原tab/reload仍拒旧intent，人工检查后风险确认用无opener新空tab显式新意图。后端真实SDK/client red→green，B9和opener拓扑独立复审 `/tmp/rm11iv/` 后父resolved。
- SDK创建与board非两文件原子；unknown可能重复/孤儿，不猜parent链/删receipt。当时08未合的交接不代表现在未合；11child不得复制strictnew tuple/pending/read事实。

## 08 恢复、R1–R5及主08×11适配

- 前agent `/tmp/t08-jG1ARI` 有失败/绿色输出但无最终REPORT/exit配对，不能補造“全绿”；fresh恢复 `/tmp/r08-o5OMrc/REPORT.md`，过期streaming误dispatch和accepted:false漏标有效red→green。expired UI locator错误、dual-root/symlink测试workaround原bytes恢复记录保留。
- 独立源R1–R5见 `/tmp/r08-o5OMrc/REPORT.md` 顶部、`/tmp/r8iv`：Stop receipt-only Continue漏补、prepared set_tools UUID重建、native metadata绕准入、HTTP内部admit暴露、win32 native path。窄修 `/tmp/r8f-CIYhG2/REPORT.md` 7red→green，20SDK/full2713pass/4skip；tool UI首轮错误storage key仅校正fixture，不放宽same-ID/zero-provider/draft断言。源复审 `/tmp/r8rr-1009/REPORT.md` 关闭但不代主。
- 主组合当时v5保留05/07/11所有域；真实child Continue沿活动raw custom事实显示origin，不copy source tuple、不追latest、不重注入被投影排除材料。联合继承预览5red→green及harness/tsc失败保留。主 `/tmp/m08-v3uqlo_0/REPORT.md` full2785pass/4skip、SDK/联合迁移/原probe及B配对；独立 `/tmp/m8iv-1009/REPORT.md` 后父resolved。
- **N1既有P2仍未修**：externally delete持久warm session后set_tools可写headerless片段/500，ordinary/prepared before同机制，不是本轮08新增，不借文档扩SDK重构。

## 12 原准入归档与09组合

- 源 `/tmp/a12-3oGCtb/REPORT.md` 与RECOVERY12不代主；主 `/tmp/m12-39pOIJ/REPORT.md` full2806pass/4skip、archive21与全域迁移、B6，首次focused180s工具中断无exit不伪green，fresh216/216。
- 父另跑 `/tmp/pi-parent-ticket12-archive.log`、`/tmp/pi-parent-ticket12-browser.log` 接受。两次npm notifier registry意图socketguard阻断，不是成功外网/安装；full合法loopback另计，不称整套0socket。仅PiWeb入口控制，外部CLI/trusted extension绕wrapper不沙箱。

## 09 R1 / R2 / R3（依次关闭，证据不能互代）

- 原源40文件/9新与主12组合当时v6；主原 `/tmp/m09-Odiq3z/REPORT.md` focused175/full2824pass/4skip **未覆盖R1/R2**。原中断 `/tmp/t09-YrB2ft`、源 `/tmp/r09-41vNMy/REPORT.md` 与所有failed尝试保留。
- 主writer两次upstream_error后fresh-context `/tmp/m9r-qF38ce/REPORT.md` 确认无旧进程、1236 before/hash和源40 after匹配。R1首V1receipt零append→V2authfail→Continue不能回V1；R2同文A不能代证被删/替换/压缩/context排除的B，新同版C凭自己entry可成功。六真实SDK探针red→green，110SDK/full2830pass/4skip两轮/B22。此时仍claimed，不能自称独立关闭。
- 独立 `/tmp/m9iv-b706/REPORT.md` 关闭R1/R2但发现R3：array引用保留、text原地redact/truncate仍误success/clear。`/tmp/m9f-x4GgSR/REPORT.md` 原四探针2pass/2red→4pass；九转换探针4red/5pass→9pass（晚auth删改、concat/wrap/split/clone）。生产检查entry identity+request-local贡献引用+SDK stream完整锁定正文，绝不恢复converter删文；119SDK/full2839pass/4skip/B22。旧110/browsergreen不能证明R3。
- 父独立conversion9+R1/R2六共15/15 `/tmp/pi-parent-ticket09-review.log`，09父resolved。只能登记sdk-input-successful-response，不是native append/provider wire/read/理解；fake Provider捕获另层。

## 14 数组HTTP413、rename注入与主09/12联合

- 首隔离 `/tmp/d14-flej24l4/REPORT.md` full2815pass/4skip、B7；rename注入未生效1fail、dev symlink-root panic、误用两不存在sidebar脚本exit1保留，实际脚本后通过；早lint6 warnings清理后0，不删早日志。
- review P2容量 `/tmp/r14-wfzmqbiq/probes.log`：合法3500/50k store旧affected数组276724/3950225bytes真实413。父只授权14源续修；`/tmp/c14-6np7qty2/REPORT.md` 固定server digest296/297bytes HTTP200、最大scalar<512、partial409/done无consent400，full2817pass/4skip、B全3500八场景三轮。临时dual-root仅隔离测试，配置/full前恢复、只停自有dev，未带产品patch。
- 独立源 `/tmp/rr14-hsmod9_j` 关闭后，主按当时v6语义组合，不覆盖09/12。`/tmp/m14-s1bbqjlr/REPORT.md` 新14×09 actualSend/archived恢复、完整hidden/archive、所有旧board receipt当前派生digest与关系revision冲突。主3500/50k store1,747,913/25,014,664bytes，均<32MiB；非50k DOM benchmark。独立主 `/tmp/rm14-guxyw6nv/` 后父14resolved；该报告的10未合仅历史。

## 10 canonical主集成与坏数据R1/R2最终复审

- 源 `/tmp/t10-xm6evhd0/REPORT.md` 52完整/48产品文件与父158 baseline含09/12无14；主 `/tmp/t10main-_q_3satd/REPORT.md` 从1226主产品before逐hunk组合v7+14。旧schema断言/新增fixture错误及真实08迁移selection属性插入顺序误conflict保留；固定字段canonical后重验。主256joint/full2887pass/4skip、25initial+canonical4=29 browser运行exit0；不是最终窄修或父验收数字。
- 源独立 `/tmp/t10iv-z9ep0mlr/REPORT.md` 正常167+3racegreen但发现**刻意坏数据P2**：R1copy未来epoch被接受；R2legacy非零epoch首读先写坏v7次读才拒。不是已证实正常公开入口ABA漏洞。父仅主窄修 `/tmp/t10fix-l8beyj3o/REPORT.md`，原diagnostic5pass=3正常+2缺陷诊断，不算5产品pass。
- 新10项要求拒绝回归修前7fail/3pass→最终10/10；完整hydrated target在operation/迁移写前统一start/choice/copy epoch验证，copy较早receipt保留，future/default0不一致拒绝，首次+两fresh-open原bytes不变，不造tombstone/reset。真实09/14/history/current/views/archive/order迁移和authority2下旧0/1receipt保持；prepared新执行CAS、completed只原child事实。
- 修复方joint266/full两最终轮2901tests/2897pass/0fail/4skip、tsc/lint0/B11运行；runner240s中断full-1 exit:null不计green、原7red不抹。npm notifier两registry意图被阻断已披露，非成功外网。
- **最终独立主复审** `/tmp/t10mr-mus4_2wp/REPORT.md`：1263/1263 afterhash、16保护hash，独立75风险+2早迁移全pass、B三运行22场景/updates6实际fake requests；仅看修复方full/joint/tsc/lint日志，不称独立重跑。两P2关闭、无新具体阻断，父在[10票据](../../.scratch/task-dashboard/issues/10-reassign-session.md)接受全部验收并resolved。原报告仍claimed是交付时事实，不改旧报告。

## 长期未验边界与证据使用

全部数字只属各自冻结树/命令-log-exit，source-contract/VM/mocks、实际store/SDK/fake Provider、Chromium fixture SSE、生产/真实平台分开。没有由本附录重跑任何套件。平台skip不是pass；计划/命令/文档扫描不是执行验收。

保留N1、copy孤儿/非跨文件原子、32MiB个人O(n)、外部writer/wrapper边界。真实provider wire/read/计费/取消/质量/网络、production SSE/build/install、Windows实际SDK/ACL/浏览器、Safari/iOS16.2真机/软件键盘、最低Node、断电/NFS/kill-mid-write未验。最终综合核验仍由并行validator与父review另报，本文不宣称最终全平台PASS。
