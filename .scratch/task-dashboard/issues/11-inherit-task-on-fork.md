# 11: 复制或另开分支时沿用任务

**What to build:** 用户从已关联任务的对话复制或另开分支形成新对话时，新对话自动沿用原任务；普通空白聊天和原对话内部的分支切换不会产生意外关联。

**Blocked by:** 04（把已有对话归入任务）。

**Status:** resolved

## Acceptance criteria

- [x] 复用现有复制、fork 和分支复制操作，新 session 创建成功后只继承一个合法任务关系，并在任务详情列表和数量中出现。
- [x] 源对话未关联任务时，新对话也不关联；普通新建空白聊天不会依据最近任务、浏览器选中卡片或共同 cwd 自动归属。
- [x] 原 session 内切换分支不新建任务关系，不复制任务卡、不让列表数量增长。
- [x] 新对话与原任务的项目范围重新校验，项目判断沿用现有规则；不重写原历史、工作目录或工具预设。
- [x] 复制失败、关系持久化失败、重试或源关系同时改变时有可追踪结果，不显示成功但挂错任务，不把用户重试变成重复关系。
- [x] 不改变原会话现有继续运行/停止约定；不能为了写关系擅自停止源 Agent，复制后的新对话也不自动开始工作。
- [x] 关系重启后仍在，来源历史中的上下文仍按现有复制行为处理；不因复制而自动采用用户未确认的新共享版本。
- [x] 用真实临时 SDK 会话验证各复制入口、未关联源、同会话切换分支、失败与重复操作；浏览器确认跳转和任务列表更新，不发真实模型请求。
- [x] 同步任务关联及会话分支合同，保持已有 fork/clone 回归通过；不借本票据重构整个分支系统。

## Scope and handoff

只需要 04 的关系存储与现有原生复制能力，不人为依赖 AI 整理或新版本接收。解除/改绑由 10 提供；当它已存在时，新对话正常使用同一入口。

如果 08、09 的采用记录能力也已落地，应保持其实际投递与来源语义，不伪造新对话已执行一次模型调用的记录。验证使用事实上的历史继承，而不是重新拼接多个对话。

## Spec coverage

用户故事：US5、US6、US16、US17、US33、US60、US62、US64、US65。
访谈选择：Q02、Q26。
实现决策：D1、D2、D5、D9、D10。
验收计划：T04、T09、T20、T21、T22。

## Comments

2026-10-09（父验收）：11主集成独立复审关闭R1异常200丢UUID和R2未知结果恢复说明，
三入口×五异常响应真实SDK重放只产生同一个child；Chromium实测reload/opener克隆旧identity、
手动新顶层opener=null空tab才开始明确新意图，旧prepared仍拒绝。独立46/25/43窄测、copy9场景、
07/05联合2场景及warm source model/queue/history额外探针通过，证据 `/tmp/rm11iv/`。
父核对19增量与主full2755pass/0fail/4skip、154focused、tsc/lint/浏览器报告，按11范围验收resolved。
跨SDK/board非原子和未知窗口遗留child风险不消失，人工另试是接受风险的新意图；08尚未集成，
receipt/nativeappend/provider阅读三个事实的联合验收留08执行，不扩大当前结论。

主集成交付（2026-10-09，仍claimed）：唯一主写根 `/Users/noname/GitProjects/pi-web`，全beforehash `/tmp/m11-84vHSp/beforehash.json`；核验只读11交付16文件及patch SHA `8f20626effc0682ef81ea6cc3de97b950c7ac6803484f6ae3a7fcbce8bb22f5e`，baseline-relative逐hunk合并，保留主07 authdispatch/context_edit/nullleaf/快失败Promise及全部旧CAS/receipt/父验收。08仍别树未合、未写，不复制其source strict new-start receipt给child，不伪采用。
独立review R1/P1主修：仅2xx+成功envelope+有效copy result才清UUID；空体/坏JSON/缺data/坏data/缺success均明确reject，原POST+实际SDK runtime已提交child后三入口篡改五响应的retry跨reload仍同ID/原child/count仅+1。R2/P2主修：未知prepared保持拒旧intent；三入口共享error精确说明先刷新检查列表、找到child直接打开，只有明确接受重复/孤儿风险才用浏览器+打开无opener空tab、粘贴source URL并显式另试；原tabreload不是恢复，旧receipt保留，不自动换ID/删receipt/猜parent链。原8case有效red→8green，扩展后18/18，联合07原三阻断/Promise/AI来源+05/06/04/13真实迁移及旧retry25/25。SDK/baseline46/46，扩大focused最终154/154，fresh full2759tests/2755pass/0fail/4Windows-only skip，tsc/lint0。copybrowser两轮9场景（5异常2xx visible error/原ID/reload、3复制入口、未知检查后显式新tab另试）通过；17其它browser配置通过，含07summary11+views联合2、05views11、06context8、04sessions7、13columns7、01draft12、02details8、03order10/retry6、三语言cancel/基础board/导航/侧栏Git与nonGit。只复用健康30142，无服务/build/install/commitpush动作；真实SDK创建与board提交非跨文件原子、未知结果及Windows/ACL/Safari真机/最低Node/真实provider/断电NFS仍限制。完整fresh命令/log/exit、失败历史、迁移证据、主增量patch/hash见 `/tmp/m11-84vHSp/REPORT.md`。验收框留父；待独立主复审及父验收，不resolve。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

开发槽1领取（2026-10-09）：04已resolved；冻结HEAD85cc4f3 + 同级baseline-manifest，唯一源码写根ticket11。仅实施现有clone/fork/fork_branch新session继承与可追踪失败/精确重试，普通New/同session导航不绑定。07/08隔离成果不在本基线；不伪造采用/模型调用，不提前10改绑。验收框留父代理，保持claimed。

隔离实施交付（2026-10-09）：复用原clone/fork/fork_branch SDK入口，同v4内部sessionCopies prepared/completed intent与receipt；source-owner CAS、await04权威项目scope、成功后唯一关系与count，普通New/未归属三入口/同session导航不绑定。已创建但关系失败返回明确child/op/taskCode，原请求同进程重试复用child；completed重启可确认，prepared中断未知结果明确拒重复制，不宣称两文件原子或自动恢复。保持原idle fork/clone shutdown与running source继续，fork_branch不停止source，child不自动prompt，不重拼历史或修改cwd/loadout。06latest不代表采用；仅阅读08报告/tmp/r08-o5OMrc/REPORT.md接口说明，未合07/08，父后续集成不能复制source new-start receipt给child，不能把原生继承旧版本当child新provider采用。

fresh证据 `/tmp/p11-ATUUwE/REPORT.md`：真实临时SDK/原agent POST/存储/模拟runtime与client19/19，扩大focused86/86，最终full2723tests/2719pass/0fail/4Windows-only skip，tsc/lint0；实际fork/clone/引用branch浏览器3场景（丢响应原UUID重试/跳转/任务列表count/零prompt），04sessions7、01draft12、05views11、06context8及project/chat/keyboard回归通过。临时树外HOME/TMPDIR/agentDir，最小无keys；初始fixture失败、offline全局4plugin断言失败及browser缓存/locator失败日志均保留，不当通过。仅自己30143dev，原config symlink panic后临时dual-root '/'，已停21924/21926并还原config/AGENTS原字节，全套/config最终原配置验证。完整日志/exit/命令、冻结baseline精确增量含新文件patch/hash及迁移/08冲突说明见报告。Windows/ACL、Safari/iOS16.2真机、最低Node、生产安装、真实provider/断电NFS未验。仍claimed，不勾验收或resolve；主集成及独立review/父验收待完成。
