# 复制 / fork 新对话继承任务

## 当前范围

见[任务 session 管理契约](task-session-management.md)。复制/fork 继续继承唯一任务归属，不因任务归档拒绝，不因此恢复任务。保持 SDK 原有复制生命周期、权威 scope、owner/generation、幂等 receipt 与未知结果处理；不引入共享材料，也不复制旧 pending/start 选择。以下涉及 07/08/09 的新共享行为与归档发送限制已暂停，仅保留兼容背景。

当前01–14全部父resolved，统一[当前schema/CAS/迁移权威表](task-dashboard.md#当前存储cas与迁移权威表)为v7。主 `/tmp/m11-84vHSp/REPORT.md`、独立 `/tmp/rm11iv/` 与[阶段历史](task-dashboard-validation-history.md#11-copy异常2xx与未知结果)分列；当前08/09/10均已接入，不凭源green/原报告claimed替最终综合验证。
[11票据](../../.scratch/task-dashboard/issues/11-inherit-task-on-fork.md)、
[任务关系](task-dashboard.md)、[会话分支](../agents/sessions.md)、
[独立聊天](independent-chat.md)、[共享重点](task-shared-context.md)。实施通过不等于父验收。

## 09历史/pending接缝（resolved）

[09合同](task-context-updates.md)保留11sessionCopies和08严格new-start receipts。原SDK复制仅保留分支实际native材料/audit，可显示原版本/origin；child自身choices/pending/deliveries为空，不能copy source pending或将source successful input/response audit冒称child已读。Continue识别明确native update事实，不追06latest，compaction/context_edit排除依然不补旧资料。主09/12仍保留source-owner CAS、copy intent/receipt和原fork生命周期；archived child实际Send要求先restore，pending读取/complete没有后门。10清除复用同公共CAS；09不实现改绑/第二fork引擎，不改11原父验收。联合主实际SDK/全域迁移证据 `/tmp/m09-Odiq3z/REPORT.md`，不将source green当主或09父验收。

## 入口与不变量

- 复用用户消息“New session” (`fork`)、`/clone`、引用助手消息“Ask in new chat” (`fork_branch`)；
  三者仍通过 `sendAgentCommand` / 原 `/api/agent/[id]` 和 SDK `SessionManager.createBranchedSession`。
  原首消息fork的原生空历史持久化补偿不变；不增加JSONL改写或拼接历史。
- 真正创建成功后只继承来源的唯一task；同锁检查来源所有权未改变，并await04的uncached权威
  source/child项目身份，拒绝跨项目。新关系只推进目标task revision/time，不改状态、顺序/列/视图
  revision、创建身份、移动receipt、知识current/history。普通New、未归属source、同session
  `navigate_tree`/树浏览不推断最近任务、选中卡片或共同cwd；不会新增任务卡。
- task不改变cwd、工具pin/loadout、模型、历史或权限。引用fork只准备未发送问题，不自动prompt。
  fork可在来源运行时复制已完成历史（shell仍拒绝）；clone仍拒绝busy；只有原本允许的成功idle
  fork/clone才执行原shutdown，fork_branch不shutdown。关联失败不为了写关系停止来源，也不启动child。
- 成功才导航到child；沿用AppShell的session列表刷新和任务页面重新读取，详情/count来自已提交关系。
  失败显示原入口错误notice/quote错误；不把已创建但未关联child显示成复制成功。

## 视频引用与原生分支（视频01–09已独立 review / resolved）

[F40 原视频附件](video-attachments.md)复用本功能三入口、SDK 创建以及 task intent/receipt/scope/生命周期，不改变任务复制业务。媒体仅随复制路径中实际继承、SDK 仍有效的 native user `piWebVideo`：`fork` 不含目标 user，`fork_branch` 包含目标 entry，`clone` 只取所选 leaf（包括非当前 leaf），不含兄弟历史。当前 SDK 保留 message entry ID 与嵌套视频 UUID/path/MIME，不按行号或同文问题猜 owner。压缩后 raw inactive 引用可留在副本，但只有有效 owners 出站。

child 不复制/冻结视频文件、不授予路径权限；下次请求仍读取原路径当前 bytes，并重验 canonical/link/regular-file、模型/鉴权与预算。缺失的兄弟文件不影响，继承路径失权整次零出站。视频06的前端导航等待 ACK 与 canonical 历史，代次隔离迟到 history/paging/cache，pending 时不启动旧 leaf 分页；新分支追问完成必须 fresh GET，不另建分支框架或持久浏览位置。

`lib/video-transport.test.mjs` 用真实 SDK/原生 Google final-fetch 与合成 SSE 覆盖三入口、兄弟/非当前 leaf、首视频前 fork、冷开/改文件/symlink 越界及实际压缩 clone；09组合继续验证 clone→模型拒绝/切回→AVI＋PNG Follow-up→Stop→显式消费/冷重开，不错绑兄弟 UUID、不重复或降级文字。`node e2e/video-branch.mjs` 挂载真实 ChatWindow/BranchNavigator，桌面/移动20阶段；实际消息 fork、composer `/clone` 与导航确认/正常分页，`fork_branch` 媒体归属另由 SDK 单测验证。任务复制 intent/CAS/receipt 与原生命周期保持，原 copy16项中的三项故障注入失败单列，不修改/skip，也不以视频绿色组代证。

[公开验收摘要](video-attachments-acceptance.md)给出可执行命令、证据分层和未验边界。历史真实 MP4/AVI 网关首问不包含真实复制/队列付费组合；集成复跑同样是隔离 SDK/browser 验证，不冒称生产 Next/AppShell 或真实网关通过。

## 12归档交点（主已父验收resolved）

主树idle复制不自动运行，child继承来源唯一关系，包括归档task；complete同board锁额外重查归档目标child的原生命周期（pending/UI/queue/compact/bash），忙child拒绝，不静默restore/abort/prompt。SDK已创建child的精确retry及未知结果人工检查合同不变；completed receipt仍确认原结果，不再造child或伪08选择。child首Send必须恢复owner。scope/source-owner CAS/07 provenance/08 native事实保持。共享guard与外部边界见[归档合同](task-archive.md)，不代表11重新验收或12父验收。

## 持久化、CAS与精确重试

同一board内部sessionCopies数组，不另存聊天；合法legacy缺失与当前必填规则只见F21权威表，存在非法/partial/重复intent或child引用拒读不重置，public board不暴露receipt。
每intent保存operation UUID、请求fingerprint、source ID、捕获task ID、prepared/completed和child ID/null。
这只是复制结果追踪，不是第二份聊天、采用记录或任务状态。

1. 浏览器各实际copy入口在发请求前生成UUID；失败/丢响应保持同一请求身份，sessionStorage跨reload
   保留（不可用时当前页面memory fallback）。只有2xx、success===true且data为合法复制结果才清理：cancelled===false必须有合法且不同source的newSessionId；cancelled===true不得带child。空体、JSON解析失败、缺envelope/data或非法data均reject为未确认，UI显示明确error而非静默undefined。精确retry确认同child后，下一次明确复制才是新意图。
   原API仍可省略operationId兼容旧调用，但该调用没有跨请求精确重试身份；自动重试调用者必须传原UUID。
2. 唯一`taskOperation`的内部prepare/complete动作使用同一个board锁；HTTP `/api/tasks`不能直接调用
   内部动作。prepare先持久化来源task快照，再执行原SDK复制；complete比较当前source owner（含null）
   并权威重验source/child范围，再原子写唯一关系与completed receipt。同operationId不同payload冲突。
   原知识/资料变化不是来源关系改绑，不追最新知识；10已接入owner+generation防ABA新执行。
3. SDK创建后scope/关系写入失败返回`session_copy_unconfirmed`、operationId、已知child ID及taskCode。
   同进程/HMR保存已创建child，精确重试不再调用SDK；成功receipt重启后仍能确认原结果、不重复关系。
   completed receipt确认返回原child，不依赖今日source关系来改写旧事实。
4. prepare已提交但进程中断、或创建结果无法确认时，新进程明确报告outcome unknown、不再创建第二child。
   各入口的错误直接给出以下可执行人工流程（不靠reload或自动换UUID）：
   - 先刷新并检查侧栏会话列表及任务关联列表。原尝试可能已创建未关联child，列表标题不证明身份；找到目标child时打开使用，不再复制。
   - 如果检查后仍选择另试，须明确接受可能产生重复/未关联child的风险。用浏览器“+”按钮或Ctrl/Cmd+T打开**新的空白标签页**，无opener；不要用“复制标签页”或链接“新标签页打开”（可能复制sessionStorage）。在同一站点粘贴 `/?session=<source ID>`，找到原复制位置，再明确点击New session、提交/clone或引用Ask in new chat。这次用户动作是新的独立意图，不是旧结果恢复/确认。
   - 原tab reload始终保留旧UUID；旧prepared intent/receipt保留并继续拒绝。不删除board receipt、不猜parent链自动绑定、不承诺能够证明旧child不存在。若无法判断，停止另试并人工核对。
   没有跨SDK与board两文件的原子事务；
   此窗口不自动删除原生child，也不猜parent链恢复/绑定。确定的写入失败且进程仍在可精确恢复；
   重启后未知窗口需人工核对，不宣称断电耐久或自动修复。receipt受原32MiB个人board上限，不无限承诺。

## 08/09联合历史事实（均resolved）

06latest不表示模型采用。只有SDK复制分支内fork点前已有native材料是child继承事实，不把source receipt-only、pending或latercurrent补给child。选择 ≠ native append ≠ 成功SDK input/response ≠ provider wire/read；Stop可仅receipt，source Continue补自己原snapshot一次。原阶段交接已移[历史附录](task-dashboard-validation-history.md#08-恢复r1r5及主0811适配)，不再作“08未合”的当前说法。

08联合适配保留原复制/Stop/Continue生命周期、intent/receipt或异常2xx/未知结果约定及所有域。
child没有source new-start tuple；显式Continue仅复用07 bounded/non-migrating只读SDK snapshot，在活动分支
raw task-context entry与原不可变selection准确匹配时显示原版本、原选择session及“继承历史≠child模型已读”。
不是新admission/read receipt，不持久化第二份继承历史，不从06latest补造内容。活动分支在context前则不继承；
retain-none compaction/context_edit后raw事实仍可显示，但首provider输入按SDK投影可能没有原资料，绝不重复注入。
source receipt-only Stop只在source Continue恢复，child不补source pending material。
实际SDK联合回归 `lib/task-start-copy.test.mjs` 包含fork点前/后、三复制入口、branch/compaction/context-edit、
sourceStop→Continue、child首send、复制和启动精确retry；`lib/task-start-migration.test.mjs`独立保留全部域/receipt。
08主证据 `/tmp/m08-v3uqlo_0/REPORT.md`、独立 `/tmp/m8iv-1009/REPORT.md` 后父resolved；08与11各自证据分层，不互代。

## 10关系epoch接缝（10/11均resolved）

[10合同](task-session-relation.md)：v7 preparedintent捕获sourceRelationGeneration，重复prepare/knownchildlatecomplete校验sourceowner（含null）+epoch，owned/nullowner ABA拒绝新copy/child关联。completedreceipt仅返回原child/cancelled事实，今日source/child改绑不重bind/清新pending；未知prepared原UUID/人工检查/无opener新tab流程不变。native历史保留，不copy08严格tuple/09pending，不为关系停source。decode对完整hydrated目标写前校验copy sourceepoch不得大于当前tombstone/default0，旧prepared/completed较早epoch继续保留；legacy无relation域的非零epoch拒绝且原bytes不变，不先迁移成不可读v7（源review R1/R2仅刻意坏数据，非已证实正常ABA漏洞，主窄修证据 `/tmp/t10fix-l8beyj3o/REPORT.md`）。主14保留copyepoch/receipt，关系revision使旧摘要失效；最终独立主 `/tmp/t10mr-mus4_2wp/REPORT.md` 已关闭两P2并父接受10，原主集成报告是历史。

## 实现与验收入口

- [task-session-copy](../../lib/task-session-copy.ts)：内部receipt验证、per-intent serializer、SDK执行/恢复结果。
- [task-operations](../../lib/task-operations.ts)、[task-store](../../lib/task-store.ts)：唯一locked prepare/complete、
  source owner CAS、权威项目范围、原子关系和additive迁移。
- [rpc-manager](../../lib/rpc-manager.ts)：原三种复制入口与原生命周期；
  [agent-client](../../lib/agent-client.ts)：所有现有调用的精确请求身份；原agent route投射明确失败详情。
- [SDK/runtime测试](../../lib/task-session-copy.test.mjs)、[client测试](../../lib/agent-client.test.mjs)：
  真实临时SDK/file/store/fresh进程，项目/无项目、三入口/首消息、未归属/New/导航、并发重复/改payload、
  来源归属race、真实Git同路径替换、定点 fs EACCES 失败/恢复、未知中断和模拟runtime生命周期。失败注入命中 SDK child 创建后的实际 board 临时文件写入，验证原字节/来源历史不变、child 精确重试且不重复创建；不依赖 chmod，不声称验证 Windows ACL。Windows Jiti 错误模块身份与故障 helper 见[平台验证契约](windows-test-portability.md#任务看板安装前修复2026-10-13)。
  主新增[review红绿](../../lib/task-session-copy-review.test.mjs)：原POST+实际SDK runtime提交后篡改五种2xx响应，error/跨reload同ID/原child和count只+1；三入口未知intent拒旧ID、显式无opener新tab独立attempt保留旧receipt。主[联合迁移](../../lib/task-session-copy-integration.test.mjs)验证真实07 AI provenance/05views/06history/04关系/13列及所有旧CAS/receipt。
- [浏览器](../../e2e/task-session-copy.mjs)：Chromium中实际消息fork、`/clone`及引用branch-copy；
  全API fixture对接真实临时SDK/任务store、丢成功响应及五种异常2xx的visible error/跨reload精确retry、未知结果检查→显式新tab另试保留旧receipt、跳转/任务详情/count/刷新，零模型/child prompt。browser runtime为合成wrapper，review后端另用实际SDK runtime；都不调用真实provider。

```sh
# HOME/TMPDIR/agentDir必须新短Git树外/tmp，先检查非Git且无祖先node_modules；清SDK aliases，仅测试进程。
node --experimental-strip-types --test lib/task-session-copy*.test.mjs lib/agent-client.test.mjs lib/rpc-manager.test.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/task-session-copy.mjs
```

只读源交付与失败历史在 `/tmp/p11-ATUUwE/REPORT.md`，其full2719pass不是主证据。主beforehash、逐hunk迁移合并、R1/R2红绿、fresh主full/tsc/lint/交叉/browser、增量patch/hash在 `/tmp/m11-84vHSp/REPORT.md`。这些是当时主执行证据，本轮文档未重跑；服务核验/数据隔离遵循F21，不能凭历史PID授权动作。独立主复审46/25/43窄测、copy9场景、07/05联合2场景及真实Chromium opener拓扑检查通过，
R1/R2关闭且无新具体阻断；父代理已验收11为resolved。证据 `/tmp/rm11iv/`；08联合已集成并分别接受，当前仍保持copy unknown与非事务边界。
Windows 任务复制/错误路径的 Node/SDK 单测已纳入[2026-10-13 全量验证](windows-test-portability.md#任务看板安装前修复2026-10-13)；Windows ACL、Safari/iOS16.2真机/软件键盘、最低Node、生产打包安装、真实provider、断电/NFS未验；
Chromium/模拟runtime不替代这些平台。修改同时维护任务关系/会话合同及README索引。
