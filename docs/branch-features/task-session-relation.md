# 解除或改绑对话（10，resolved）

2026-10-10 UI 检查：确认面板长名称/ID/路径可换行，目标 select 使用显式可访问名称；Escape 保护 `isComposing` 和 `keyCode=229`，取消后焦点留在任务浮层。关联列表在活动读取失败时显示未知，不把旧状态呈现为当前事实。合成响应下的改绑/解除/错误重试/取消已走浏览器流程，见 [UI记录](../testing/task-dashboard-ui.md)；不替代真实关系 CAS/权限验证。

当前01–14全部已父验收resolved，统一存储为v7。10原主集成 `/tmp/t10main-_q_3satd/REPORT.md`、窄修 `/tmp/t10fix-l8beyj3o/REPORT.md` 与最终独立主复审 `/tmp/t10mr-mus4_2wp/REPORT.md` 分层保留；父已接受全部验收项。最终综合/真实平台验证另报，不以本票resolved宣称全平台通过。[阶段历史](task-dashboard-validation-history.md#10-canonical主集成与坏数据r1r2最终复审)保留原claimed时点与red/中断。
关联：[关系/任务](task-dashboard.md)、[09更新](task-context-updates.md)、[08启动](task-start-chat.md)、[07整理](task-ai-summary.md)、[11复制](task-session-copy.md)、[12归档](task-archive.md)、[会话](../agents/sessions.md)、[票据10](../../.scratch/task-dashboard/issues/10-reassign-session.md)。

## 操作与非遗忘契约

1. 任务详情展开“对话”，逐对话明确“解除或改绑对话”。独立确认区域显示session ID、来源任务标题/UUID、目标任务标题/UUID或无任务；目标可用共享version仅提示，不接收、不自动send、不追latest。目标列表包含同持久项目身份的active任务；服务端不信该UI列表或busy徽标。
2. 确认前明确告知：**旧任务文字仍在原生对话历史中，改绑不等于遗忘，需要隔离请新建对话**。不迁移、删除、脱敏、改写JSONL或撤回已进入模型上下文的旧文字。不改变cwd/model/tools/权限/草稿/任务状态。下一次实际SDK/Provider输入仍可能包含旧native历史，这不是旧pending被重新投递。
3. 取消/Escape不POST；Tab/Enter与390px触摸可确认/取消。固定打开时source/generation/update revision，刷新/focus/online不能静默rebase。错误保留目标与原请求UUID，修改目标才是新意图。成功只使用同锁返回board更新双方关系/count/revision；没有prompt/Stop/restore。
4. 服务端实际同锁重查所有原wrapper busy：pending admission/prompt、streaming、queue、UI/customUI等待、compaction、bash、closing和已删file仍未dispose的busy wrapper。metadata不等于busy authority；权威目录查询await后再检查一次，防工作预留期间仅信先前idle采样。缺失session拒绝，不从旧cache复活。
5. 同锁从唯一sessionIds找source owner；target必须存在，source/target均active，不能把旧archived聊天改绑到active任务绕过12。先显式restore才可变更，不自动restore/stop。session项目/worktree/chat通过既有uncached权威catalogue解析；目标使用服务端不可变task项目身份，不接受客户端cwd/projectKey；项目与无项目互斥、同项目不同worktree合法。新task目录选择也使用既有权威解析，不用sidebar SWR cache创建陈旧scope。
6. 关系+旧pending清理+generation+双方task revision/time+精确receipt在**同一board锁/同一原子rename**提交；通过09公共语义`clearContextUpdate`，不私下注入消息。不再适用的08receipt以epoch失效而不是删审计。任何scope/CAS/busy/存储失败保持原关系、pending与原文件。每session永远最多一owner。
7. 解除后`context-update-state`返回无task/current、`pending-context-update`返回null，不再读旧task新版本。改绑后只读新owner状态与可用version，旧task choices/deliveries/selection/native仍保留历史；再次回旧task也不会恢复旧pending或receipt-only启动材料。

## 最小关系身份与v7

仍一个`board.json`、一个`taskOperation`，**sessionIds是唯一owner索引**。新增内部`sessionRelations:[{sessionId,generation,receipt?}]`只保存generation tombstone与最近变更的UUID/fingerprint，没有第二owner列、历史正文数据库、runtime引擎或泛化框架。首次关系epoch为0；每次解除/改绑递增，即使A→B→A或null→A→null也不能回到旧epoch。单纯初次/重新link保留当前epoch，但清掉已不再是最近关系操作的receipt；owner身份与epoch共同校验。

统一[当前schema/CAS/迁移权威表](task-dashboard.md#当前存储cas与迁移权威表)定义v7与合法legacy hydration。必须保留全部历史/CAS/receipt；坏/partial/未来epoch拒读，不reset。历史start可留在非owner task，但必须有真实较晚tombstone；旧schema中孤立start仍拒读。

公共HTTP `change-session-relation`：
`{sessionId,sourceTaskId,targetTaskId:null|UUID,expectedGeneration,expectedUpdateRevision,operationId}`，严格拒多余字段/路径ID/同source-target。返回完整同锁board；双方task revision/time各推进一次，不改order/columns/views/知识CAS或archive域。它们是14现有完整ordered source digest中task revision CAS的真实变更，不能把关系元数据从列迁移中丢掉。
`context-update-state`及关联metadata返回当前relation generation（metadata另含updateRevision）。新08selection含expectedRelationGeneration，09选择/clear含固定expectedRelationGeneration；旧客户端省略只表示**0，不自动采用当前epoch**。所有HTTP内部admission/pending/complete/copy action仍在store前拒绝。

## 写前拒损坏合同（R1/R2已独立复审关闭）

原发现是刻意损坏/不一致数据P2，不是已证实正常合法用户ABA漏洞；失败因果和源/主分层见[历史附录](task-dashboard-validation-history.md#10-canonical主集成与坏数据r1r2最终复审)。

同一decode边界现在对**完整hydration后的目标文档，在返回/写入前**统一校验start/choice/copy跨epoch一致性。copy的sourceRelationGeneration不得大于sourceSessionId当前tombstone/default0；较早prepared/completed epoch均保留历史（prepared新执行仍沿runtimeCAS拒绝，completed只确认事实）。旧v1–v6缺epoch补0，已存在epoch须与default0相容，不重置非零坏字段、不伪造tombstone。失败含第一次legacy读取及freshprocess重复重开均storage-unavailable/原bytes不变，不能先覆盖造不可读v7。14内部deleteReceipt/响应digest与09全域、08fixedcanonical及所有正常guard保持。

新 `lib/task-relation-migration-review.test.mjs` 验证R1 prepared/completed、authority0/2未来值拒绝；R2start/choice/copy非零legacy拒绝；合法missing/present0迁移/两次freshreopen、旧0/1receipt在authority2合法保留与14/09/08/11/views/archive/history/order联合。主red/green、fresh验证与窄增量hash在 `/tmp/t10fix-l8beyj3o/REPORT.md`；最终独立主复审 `/tmp/t10mr-mus4_2wp/REPORT.md` 实际重跑新增10项及原诊断合同，R1/R2关闭，父已验收resolved。

## 跨票据过期边界：事实确认不是新执行

- **07** snapshot绑定来源epoch；生成准备、auth后同步Provider dispatch、response后、重复generation结果取用、未提交publish均同锁重验epoch+owner+branch/scope。旧snapshot/旧AI draft不能ABA复活。已经提交的06/07精确publish receipt只确认已发生版本，不重跑Provider、不回拨current，因此不依赖今日关系或内存generation。
- **08** prepare绑定真实session或new operation/session ID的epoch，admit先拒旧epoch。旧new-start tuple留审计，不删除或搬给target；fresh Continue只可能恢复**当前epoch**自己的receipt-only材料，不回补历史epoch。native旧材料可作为历史事实显示，不承诺当前有效投影或模型阅读。旧new/continue prepare与start receipt不能重新执行，即使回A。
- **09** choices保存epoch；pending只领取当前epoch，第二authority核对task/operation/**epoch**，成功response回调complete再次校验epoch+唯一关系，不补旧delivery或清新pending。公开select/clear的新执行拒旧epoch。旧选择精确retry也拒关系过期（不是重新pending）。已提交delivery在当前owner仍合法时可以确认既有事实/no-write，即使generation后来变化；不能创建此前没有的旧epoch delivery。native/audit原样保留。
- **11** prepared intent绑定source owner（含null）+sourceRelationGeneration；重复prepare与late known-child complete均重验，新epoch拒绝，不重复SDK copy。已completed精确receipt始终只返回原child/cancelled事实，不根据今日source/child owner重新关联。未知prepared旧intent仍failclosed，既有人工检查/无opener空tab新意图流程不变。
- **10**只保留每session最近relation receipt；精确同UUID/同fingerprint确认已有提交，不重检查busy、不重新执行、不回拨owner；更晚变更/link替换后旧请求CAS冲突。同UUID改payload冲突。全generation计数到safe integer限拒绝，不绕保护或重置。

## 实现和自动验收

[task-relations](../../lib/task-relations.ts)提供generation metadata/CAS与同锁关系操作；[operations/store/types](../../lib/task-operations.ts)持久化迁移与唯一语义入口；[TaskRelation](../../components/TaskRelation.tsx)位于Dashboard独立区域，避免过滤/移列/已提交丢响应后卸载导致原确认消失；[TaskSessions](../../components/TaskSessions.tsx)复用既有关联入口。07/08/09/11分别在原实现接缝绑定epoch，不另建队列或owner服务。

```sh
# 新短Git树外/tmp的HOME/TMPDIR/agent/log，预检非Git/无祖先node_modules。
# env-i无真实key；仅测试清3SDK aliases；socketguard拒外部模型域。
node --experimental-strip-types --test lib/task-relations.test.mjs lib/task-relation-boundaries.test.mjs lib/task-relation-migration-review.test.mjs lib/task-relation-column-removal.test.mjs
node --experimental-strip-types --test lib/task-context-updates.test.mjs lib/task-context-update-conversion.test.mjs lib/task-context-update-review.test.mjs lib/task-context-update-archive.test.mjs lib/task-start*.test.mjs lib/task-session-copy*.test.mjs lib/task-summary*.test.mjs lib/task-archive.test.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/task-session-relation.mjs
npm test
node node_modules/typescript/bin/tsc --noEmit --tsBuildInfoFile <树外tmp>
npm run lint
```

真实临时SDK+native fakeProvider覆盖每busy类型、idle/Stop、crossproject、samepath展示cache失效、同project worktree、pending原子清除、旧native保留与下一次actual input无oldpending/targetlatest、09late observer与ABA、07snapshot/auth/response/publish、08prepare/receipt-only恢复、11prepared/knownchild/null-owner ABA/completed事实、archive/start/link race、存储权限失败、fresh迁移及所有HTTP内部guards。浏览器全部API fixture+真实公共store/runtime busy，故意旧idleUI验证server拒queued；警告/取消/错误/两页/丢响应/精确retry/keyboard/mobile及01–09/11/12/13关键回归。

命令只是验证入口，本轮文档整理未执行。修复方最后joint266/266、full2901项/2897pass/0fail/4Windows skip、tsc/lint0以 `/tmp/t10fix-l8beyj3o/REPORT.md` 配对日志为准；独立主复审实际75风险+2早迁移pass、三browser运行22场景pass见 `/tmp/t10mr-mus4_2wp/REPORT.md`，未独立重跑full/joint/tsc/lint。父已接受10，不把跨轮数相加或冒称最终综合验收。

## 限制、人工复核与合并

人工：A聊天先选未送V2→展开关系→检查A/B ID与旧历史警告→取消不写→busy确认拒绝→idle确认B→独立Send仅可见旧原生历史，不自动送V2/目标latest→解除不再读A新current。两页同epoch只一方成功，失败明确取消重开；A→B→A旧准备/摘要草稿/复制intent仍拒绝。
真实provider wire/费用/取消/质量/网络、生产SSE、Windows/ACL、Safari/iOS16.2真机/软件键盘、最低Node、生产build/install、断电/NFS/kill-mid-write未验；Chromium/触摸模拟与4Windows skip不代这些能力。原单进程wrapper管理边界不拦外部CLI/任意扩展绕wrapper执行；native/board仍非跨文件原子事务。

主14接缝：v7必须保留可选内部columnRemovalReceipt及其严格validator/原fingerprint，columnRemovalDigests仍是同锁响应派生map而非持久域。关系变更推进双方task revision，旧源摘要因此失效；删列只改columnId/revision/time，不清采用、历史或关系epoch。pending→改绑→删列与旧callback/ABA拒绝共同成立；archiveowner仍不能reassign/newsend绕过恢复门禁。done接收警告不宣称AI停止，05旧列条件仍failclosed。所有board/精确receipt返回同锁最新digest map，50k合法store的canonical删除请求仍<512bytes；关系generation与资料/columns/views/knowledge/order CAS互不污染。主逐hunk合并而非覆盖source文件，不带源证据、临时恢复、dual-root/AGENTS工具输出、共享依赖或构建产物进产品patch。
