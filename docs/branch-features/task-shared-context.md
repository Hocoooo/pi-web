# 人工共享重点：审核、不可变版本与确认恢复（06，resolved）

当前01–14父验收resolved，统一[当前schema/CAS/迁移权威表](task-dashboard.md#当前存储cas与迁移权威表)为v7。06主集成、独立review与SSR恢复后接受；[历史附录](task-dashboard-validation-history.md#06-人工知识与ssr恢复)保留原失败/恢复/旧.next，不用green推定缓存唯一责任。关联：[看板](task-dashboard.md)、[06票据](../../.scratch/task-dashboard/issues/06-shared-context-versions.md)、[规格D8](../../.scratch/task-dashboard/spec.md)、[ADR0007](../adr/0007-persistent-task-board.md)、[术语](../../GLOSSARY.md)。最终综合/平台核验另报。

## 2026-10-10 UI 检查

共享重点现在在独立于筛选/拖动卡片的详情抽屉中审核。生成草稿直接显示，不因过滤隐藏；两个整理入口都保护已有草稿。编辑/预览 grid 使用 `minmax(0, 1fr)`，长代码/表格仅自身横滚，不撑宽详情；清单复选框不继承文本框 padding。当前内容、四节编辑/预览/确认、冲突保留、历史/比较/恢复在浅深色、三语言与窄屏矩阵检查，见 [UI记录](../testing/task-dashboard-ui.md)。知识 CAS/不可变版本/被动渲染规则未变。

## 范围与入口

任务详情共享重点独立于说明/完成要求，不是全聊天。四节目标、已做决定、完成情况、下一步，各20,000 JS字符，至少一节非空。人工编辑/预览/历史/比较不读取session/文件、不启动AI或产生发布；三语言原生键盘可用，390px16px。07显式整理另合同，06只是人工审核发布闭环。

## 行为不变量

1. 编写→被动安全Markdown预览→确认发布才持久。返回编辑/取消不改current/history。manual显示用户提供/非AI，服务端UUID、严格递增confirmedAt、原四节文字；确认版不可编辑覆盖，后续新增version。
2. current独立显示，历史可选完整ID/time/source/content、逐节原文字changed/unchanged比较。恢复先预览审核，取消不写，确认新UUID/time与restore.versionId引用同task旧版，保留全部中间history。
3. 草稿按task ID页面内存，固定打开current pointer；refresh/focus/online/移列/过滤/排序重挂载不清输入或rebase。两页同current只一方成功，败者留编辑/预览；明确取消重开才新base。整页刷新/关页不保证草稿，但confirmed current/history持久fresh-open。
4. 失败保留草稿/旧current不伪success；原operationId/base/content或restore引用精确retry。重读看到已提交不等确认关闭，改输入另UUID，不自动rebase。
5. 使用lib/markdown normalize/remark/sanitize/KaTeX被动预览：链接只文字、图片alt、mermaid等代码仅static code，无href/src/文件回调/动作。不读路径/下载/执行HTML/shell/指令或改状态。
6. 发布仅知识，不自动写对话或称“模型采用”。人工确认不保证事实真实性；07服务器真实provenance草稿仍须编辑/预览/确认，不能伪manual或扩范围。

## 唯一API与独立知识CAS

原taskOperation/API认证、no-store、256KiB、400/404/409/503保持。未知字段拒绝，人工不能带source/model/session/status：

- publish-context：id、expectedCurrentVersionId（首null/UUID）、operationId、content{goal,decisions,progress,nextSteps}；07仅另允许generationId，真实source由服务端签发。
- restore-context：id、expectedCurrentVersionId、operationId、versionId；同锁任务/base/引用属于同task校验，返回同锁{task,board}。

knowledge currentVersionId与task资料、order、columns、views、archive、update、relation generation各CAS独立，统一表仅在F21维护。确认updatedAt至少旧+1ms，**不推进task/order revision**、不改state/列/顺序/资料/project/creationFingerprint/moveReceipt；02/03/关联也保持知识。

每不可变version内部operationId/fingerprint绑定action/task/原base/content或引用，canonical四节固定顺序，public剥receipt。已提交精确重试优先确认，即使更晚current也不新增/回拨；同ID改内容conflict。新UUID同base同文字仍新version（保留明确用户确认）；receipt随history不第二操作日志。

知识引入于当时v2，current/history后续统一承载；合法absence-only/坏pointer/重复UUID/operation/time/source/content/receipt与迁移规则见[权威表](task-dashboard.md#当前存储cas与迁移权威表)，present-null/partial损坏不reset，保留原history/receipt/fingerprint与32MiB个人O(n)边界。

## 关联功能的稳定接缝

- 04关系同锁/权威scope/唯一owner，metadata-only不主动读知识。关系推进task revision不推进knowledge CAS；所有board-returning retry当前完整board，草稿固定base。13改列独立CAS，新自定义列内知识照常，done仍稳定身份。
- 05组合筛选/unknown/自动纯投影不写知识；02/06/07草稿隐藏/重挂载仍原base。
- 07明确branch/工具text opt-in/删减/临时model后无工具SDK整理，只draft。发布前再次验generation task/base/owner+epoch/branch，AI真实model/responseModel/inputHash/entry引用保持，手改输出仍AI来源。已提交publish receipt不依赖今日关系/内存generation、不再Provider/current回拨。manual/restore原fingerprint字节不改；AI receipt另绑定generationId。
- 08准备/取消不发布/prompt/改draft；首Send锁confirmed版，而draft不是confirmed。receipt≠native append≠SDK成功input/response≠provider wire/read；Continue不追latest，11只native历史、不copy source tuple/pending/child调用，branch/compaction/context_edit决定输入。
- 09latercurrent只提醒，不替旧明确pending，用户选具体UUID/source才独立CAS。实际sdk-input-successful-response不等已读；选择、append、input、wire分层。10关系变更同锁clear不适用pending，owner+generation防ABA新执行但旧知识/native/history不遗忘。
- 12归档可继续人工发布/确认已有AI草稿/恢复知识形成新version，不自动restore或inject；新的07生成先restore，active slot保护归档竞争。14全hidden/archive删列保knowledge/history/receipt，只移列/revision/time，响应digest不持久；知识CAS不使完整源集合digest失效。

专属：[07](task-ai-summary.md)、[08](task-start-chat.md)、[09](task-context-updates.md)、[10](task-session-relation.md)、[11](task-session-copy.md)、[12](task-archive.md)、[14](task-column-removal.md)，均各自resolved，证据不能互代。

## 实现与验证入口

[task-types](../../lib/task-types.ts)、[task-context](../../lib/task-context.ts)：严格source/content/canonical/receipt/锁内发布；[store](../../lib/task-store.ts)/[operations](../../lib/task-operations.ts)：统一迁移/公共入口；[TaskSharedContext](../../components/TaskSharedContext.tsx)/[TaskContextPreview](../../components/TaskContextPreview.tsx)：编辑审核/被动预览/history/restore；[Dashboard](../../components/TaskDashboard.tsx)/[Details](../../components/TaskDetails.tsx)：独立草稿。

```sh
# 新短Git树外HOME/TMPDIR/agent/log，预检非Git/无祖先modules；仅测试清三SDK aliases。
node --experimental-strip-types --test lib/task-context.test.mjs lib/task-columns.test.mjs lib/task-sessions-integration.test.mjs lib/task-start-migration.test.mjs lib/task-relation-migration-review.test.mjs app/api/tasks/context.test.mjs
E2E_BASE_URL=<verified-base> node e2e/task-dashboard-context.mjs
```

命令不是本轮文档执行声明。实际临时store/fresh进程/锁/POSIX/API与Chromium全API fixture无模型；源 `/tmp/pi-web-ticket06-evidence/REPORT.md` 不代主 `/tmp/pi-web-ticket06-integration-ovsgdjnc/REPORT.md`。SSR失败与父授权恢复 `/tmp/pi-web-ticket06-dev-recovery-ok47x43_/REPORT.md` 后原断言复验通过；13/04/07后续迁移与独立receipt验证分层见[历史附录](task-dashboard-validation-history.md)/[coverage](../../.scratch/task-dashboard/FINAL-COVERAGE.md)。

人工：编辑→预览current不变→取消history不变；确认manual版→二版→比较→恢复取消不写→确认三版且中间在。两页同base败者留输入，刷新不rebase；失败原UUIDretry，路径/图片/shell/mermaid仅展示。不把这些步骤当已执行。

## 限制、rebase与维护

history随完整board，32MiB/O(n)，不无限容量。N1 external-delete+set_tools、copy未知孤儿/非跨文件原子、外部CLI/extension绕wrapper边界见08/11/12。真实provider/计费/wire/理解/质量、production SSE/build/install、Windows/ACL、Safari/iOS16.2真机/软件键盘、最低Node、断电/NFS/kill-mid-write未验，Chromium/4skip不代。
跨types/store/operations/Details/Dashboard/语言/索引须逐域合，保护原creationFingerprint、order/move receipt、source union/旧receipt canonical、独立CAS/被动render与权限/tool/model基线。修改同轮维护专属合同/索引，不把无冲突当验收。
