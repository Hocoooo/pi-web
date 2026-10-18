# 已有对话显式接收共享更新（09，历史功能）

> **当前暂停**：见[任务 session 管理契约](task-session-management.md)。聊天不挂载版本/更新 UI 或其轮询，不接受新选择，不投递旧 pending，也不安装发送观察器。存储历史与原生 JSONL 保留；下文是原执行契约与兼容背景。

当前01–14全部父验收resolved；统一[当前schema/CAS/迁移权威表](task-dashboard.md#当前存储cas与迁移权威表)为v7。09原v6组合、R1/R2/R3恢复与失败日志见[历史附录](task-dashboard-validation-history.md#09-r1--r2--r3依次关闭证据不能互代)，原报告claimed保留当时语义。最终综合/真实平台验证另报。
关联：[08启动](task-start-chat.md)、[06版本](task-shared-context.md)、[11复制](task-session-copy.md)、[10关系](task-session-relation.md)、[归档](task-archive.md)、[删列](task-column-removal.md)、[会话](../agents/sessions.md)、[权限](../agents/tools.md)、[09票据](../../.scratch/task-dashboard/issues/09-accept-context-updates.md)。

## 用户与运行契约

1. 原聊天页面“任务共享重点”只读重读/5秒提醒/focus/online/刷新仅显示更新。没有confirmed版本不伪造更新，没有关系不猜任务，不唤醒sleeping Agent。来源详情按需07 bounded/non-migrating SDK snapshot，不接受路径ID。
2. 独立选择器显示明确UUID/time/source和四节被动预览后“接收此版本供下次发送”。固定打开时update CAS及relation generation，提醒/重读不rebase。失败留选择/原operation UUID；改选是新意图。UUID支持LAN HTTP/randomUUID不可用；跨tab败者取消重开。服务端选择/clear再次权威验证关系/项目/存在，不信徽标。
3. idle/busy接收均只持久pending，不prompt/steer/followUp/Stop/restart/换模型。latercurrent不替pending，可明确选旧confirmed版；当前历史、待用版本、来源与成功发送审计分列。
4. 仅原wrapper用户显式普通prompt、提交及admission均idle、pendingMessageCount=0才投递。既有queue、streamingBehavior、native steer/follow_up、首agent_end、retry、扩展triggerTurn/续跑及slash均不读取新pending。原admission/SDKpreflight/队列/取消/error/model/tools不重写。
5. 提交前同步单进程logical epoch/sequence boundary；等锁/MCP过程中才接收的选择不进已提交prompt。同epoch严格较早选择可用，以前进程持久选择须早于重开后显式提交。不是时间猜测、发送队列或多服务器协调器。
6. SDK `sendCustomMessage(...,{triggerTurn:false})`追加普通user-role来源资料：UUID/source/JSON四节明确非指令/授权；不替exactsystem、不扩Chat-only/tools、不读路径/附件。operationId跨raw历史精确去重（含弃用分支/压缩），不拼写JSONL/readonly state或其他扩展资料。
7. **选择receipt ≠ native append ≠ 成功SDK input/response ≠ provider wire/read/理解。** receipt-only、Stop、handled、拒绝、auth/provider错误都不算已用。SDK projection的sourceEntry.id确认目标entry完整贡献；extension context变换后public convertToLlm仅为合法custom贡献建立request-local text-array引用。SDK stream边界同时核对引用及该贡献按序text blocks中的完整locked material（允许完整包装/分块/concat，不从另一entry凑同文）。成功stop/length/toolUse response后才记 `evidence:sdk-input-successful-response`、entry/hash/response provider/model/time。
8. HTTP200/preflight/agent_end/append/引用存活不能代证；转换后和stream边界都重查正文。converter丢身份或redact/truncate保留pending，不freeze/refill删文，普通prompt继续原converter结果。Provider/扩展可能再改payload，UI不称“模型已读”；实际fake Provider捕获是另层，不等真实收费wire。
9. complete只CAS消费自己的operation，不清运行中新pending；当前owner/scope再次失效拒登记。board成功后SDK appendCustomEntry非context审计，跨文件非原子：audit失败不抹board既有事实，board失败pending仍可重试/native不重复。错误局部观察/日志，不全局rejection忽略、不重发模型。
10. active raw历史显示“当前历史版本”，projection按sourceEntry.id另显示完整/排除/修改。同文另一entry不能代证；branch/compaction/context_edit可去资料但history/audit保留，不追latest或自动补。相同pending另分支retry不重复append，被排除则不伪success，用户可明确同版新意图。
11. 11child只SDK历史，可显示origin/version，不copy source pending/choice/delivery或strictnew tuple，不伪child调用。08 Continue预览/admission识别合法活动native update，即使authfail零delivery也不回更老receipt-only材料；继承≠child成功输入/永久投影/已读。

## 数据、操作与跨功能边界

- 每task sessionUpdates保存独立session revision、pendingOperationId、不可变choices（明确version/base/time/boundary/epoch）及成功input/response delivery。正文引用同task不可变知识，不第二聊天库；operation UUID不能复用另一session或08start ID。
- 公共context-update-state只读、accept-context-update显式选、clear-context-update显式CASclear；内部pending/complete只供wrapper，HTTP白名单在store前拒绝，如08 admit-start。新执行owner+epoch重查，旧client省略expectedRelationGeneration仅0。
- **10已resolved**：同锁clear+唯一owner/generation/双方task revision；不删choices/deliveries/native，不承诺遗忘。pending领取、第二authority（task/operation/epoch）与latecomplete拒ABA未提交回调；已有delivery仅在当前owner合法时确认历史/no-write，不创建旧delivery/清新pending。解除不查旧current，改绑只提醒目标confirmed版。
- **12已resolved**：原最早pendingPromptCount reservation仍在所有await前，09eligible只扣自己的预留、不忽略其他pending/queue/UI/compact/bash。pending领取/再次authority/complete同锁assertTaskActive；select/state/CASclear只持久意图，不restore/abort，archived实际Send拒绝，显式restore后同明确版可用。07auxsummary及closing/deleted wrapper生命周期保持。
- **14已resolved**：完整hidden/archive删列只columnId/task revision/time，原sessionUpdates/start/archive/history保留，不consume/Stop/恢复。摘要只board响应派生，全部board-returning精确retry同锁当前map、不持久。选择/clear/complete与knowledge独立CAS不使旧源集合失效；field/link/copy/10关系revision才让旧digest冲突。10×14联合入口验证pending→改绑→删列/oldcallback ABA。
- 所有legacy/必填/坏数据拒读遵循F21权威表；不能把同version源树格式猜为主格式，不能reset缺/partial域或覆盖其他票据。

## 实现与验证入口

- [task-context-updates](../../lib/task-context-updates.ts)：请求/状态/CAS/branch/native/projection；[task-context-update-send](../../lib/task-context-update-send.ts)：去重/成功input-response/native audit。
- [TaskContextUpdates](../../components/TaskContextUpdates.tsx)：固定base/显式选择/失败原UUID/事实分层；[types](../../lib/task-types.ts)、[store](../../lib/task-store.ts)、[operations](../../lib/task-operations.ts)、[RPC](../../lib/rpc-manager.ts)、[HTTP](../../app/api/tasks/route.ts)：统一语义/原admission。

```sh
# 新短Git树外HOME/TMPDIR/agent/log，预检非Git/无祖先modules；仅测试清3SDK aliases。
node --experimental-strip-types --test lib/task-context-update-conversion.test.mjs lib/task-context-update-review.test.mjs lib/task-context-updates.test.mjs lib/task-context-update-archive.test.mjs lib/task-column-removal-context-updates.test.mjs lib/task-relation-column-removal.test.mjs lib/task-relation-migration-review.test.mjs lib/task-start*.test.mjs lib/task-session-copy*.test.mjs
E2E_BASE_URL=<verified-base> node e2e/task-context-updates.mjs
```

命令不是本轮文档执行证明。实际临时SDK/原wrapper/route/native faux Provider覆盖版本/权限/read工具配对/busy/queue/Stop/auth/handled/branch/context_edit/合成compaction；浏览器全API fixture/SSE模拟。09 R3修后证据 `/tmp/m9f-x4GgSR/REPORT.md`，父conversion9+R1/R2六共15/15 `/tmp/pi-parent-ticket09-review.log` 后resolved；10联合最终独立 `/tmp/t10mr-mus4_2wp/REPORT.md`，其执行范围分列，不继承源green。

人工（真实provider可能计费，另获授权）：发布只提醒→选具体版→接收仅next→busy/queue全结束后独立Send→对照记录与实际请求；失败pending保留、另tab旧预览conflict；分支/压缩后解释raw与实际输入差异，不追current。

## 限制与维护

原wrapper单进程管理边界不拦外部CLI/trusted extension绕入口，不承诺OS锁、多服务器dispatch或board/JSONL事务。32MiB个人store。auth拒绝仍可已有nativeappend，不称success。
真实provider wire/read/费用/取消/质量/网络、production SSE/build/install、Windows/ACL、Safari/iOS16.2真机/软键盘、最低Node、断电/NFS/kill-mid-write未验；Chromium/合成压缩/fake/4Windows skip不代。N1既有external-delete+set_tools与copy未知孤儿详见[08](task-start-chat.md)/[11](task-session-copy.md)。
Rebase逐域保护RPC/ChatWindow/start/store/operations/语言/HTTP内部guard/12最早预留与entry identity+完整正文，不能整文件覆盖。修改同轮同步索引与session/tools/models合同；resolved不是后续无冲突自动验收。
