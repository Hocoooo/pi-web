# 任务的一次性关联对话归档

## 目的与范围

Task Dashboard 归档任务时，先预览当前关联对话对应的完整会话族，确认后一次性归档这些族根。任务与对话的归档状态仍分别保存，不建立持续联动：后来关联或 fork 的对话不自动归档，恢复任务不恢复对话。替代 F27/F31/F34 中“任务归档永不改变对话归档”的旧绝对约定；侧栏单独归档仍不改任务归属或状态。

## 用户契约

- 详情归档入口先展开内联预览；预览不归档任务或对话，展示族根/成员数、完整成员 ID、涉及的其他任务及其成员数、跳过项与原因。确认按钮明确归档任务及会话族，而不是仅隐藏卡片。
- 主会话归档的显示范围包含多级子代理；关联子代理时可以扩展到完整族，但不能默默扩大权限。族内任一成员属于其他任务时，必须勾选该预览的跨任务影响确认；初始不勾选，取消/重查/切换任务不继承确认。后端独立检查，不能只靠按钮禁用。
- 已缺失、尚未持久化、非 UUID 或族祖先缺失/循环/标记损坏的关联项明确报告跳过；不解除关系、不重建 JSONL。所有项均跳过或任务无关联时仍可确认仅归档任务，结果明确为 0 个族及跳过数量。
- 两个归档存储不是原子事务。失败可能留下已归档任务及未确认会话批次；只显示待确认/错误，不宣称全部成功。精确重试使用原 UUID、base、token、确认值；刷新/关闭/重新打开仍可通过详情中的待确认入口恢复该请求。没有后台自动重试。
- 预览后关系、关系 epoch、族成员或影响任务名称变化，旧范围不能用于首次应用；必须重新预览。待确认期间范围已变时拒绝继续，用户可显式恢复任务后建立新的归档意图。
- 恢复任务只改任务标记，并取代旧待确认意图；不恢复任何对话，也不回滚已经完成的会话批次。会话仍可在侧栏已归档列表独立恢复。之后手动恢复的对话不会被已完成批次的丢响应重试重新归档。
- 不增加执行准入：不检查空闲、不 Stop、不 prompt、不改变模型/工具/cwd，不修改或追加原始历史；不自动完成任务。正在看的聊天、composer 草稿、运行追踪、任务归属与历史 URL 不变。
- 内联预览 Escape 只取消预览并返回归档按钮焦点；IME Escape 不取消、不关闭浮层；详情/浮层关闭、换任务使迟到预览无效。三语言、两主题、窄屏可用。

## 接口与一致性

`POST /api/tasks` 新增：

- `{ action: "preview-archive", id }` → `TaskArchivePreview`，包含 `taskId/archiveRevision/token/linkedSessionIds/families/skipped`。目录来自当前 agent-dir 的真实普通 JSONL 及有界关系元数据，不依赖侧栏过滤/旧缓存、不水合完整 transcript、不创建 AgentSession。
- 现有 `set-archive` 仅在 `archived:true` 时允许附加 `cascade:{previewToken,confirmCrossTask}`；新的联动必须从 active 切到 archived，以 archiveRevision 的推进栅栏旧意图。已归档任务只允许最近原联动精确重试；新意图须先显式恢复。拒绝恢复携带 cascade、任意客户端目标列表、坏/额外字段。未携带 cascade 的旧请求保持任务单独归档的兼容语义；Dashboard 新归档始终走预览联动。
- 成功 `TaskMutationResult` 增加 `sessionArchive:{rootSessionIds,skipped}`，表示本次原批次已确认，而不是这些会话当前都仍归档。公共任务不暴露内部 receipt；待确认时只返回 `pendingSessionArchive` 固定重试材料。

锁内 token 绑定来源任务 revision、archive base、原关联列表/每个 generation、完整有效族成员/owner/generation、其他任务名称及跳过项。独立 archive CAS 仍只推进归档版本，不推进任务资料/排序/知识版本、updatedAt。

1. 持有 board 锁，检查当前 preview token 与跨任务确认，提交任务归档及固定 pending receipt。
2. 再次持有 board 锁，确认原 intent 仍是最新，再取得 archive 锁。首次应用前重验原范围；取得 archive 锁、异步验证返回及 sidecar rename 前均检查 board 和 archive 锁租约，已知失锁不得提交会话副作用。一次原子写提交全部族根和批次 receipt，然后完成 board receipt。
3. 会话 sidecar receipt 与效果同写，使“会话成功但 board 完成失败”的重启/丢响应重试仅确认，不重放、不改后来手动恢复。已应用时不再要求今日关系等于旧范围；未应用时关系变化拒绝。后续明确任务归档/恢复替换 receipt，使旧意图不能复活。

固定锁顺序为 board → session archive；普通侧栏归档只拿 session archive 锁，不反向拿 board 锁。每任务仅保存最近批次 receipt，不保存无限操作日志。无隐式跨文件回滚，无后台 worker；未知结果必须由可发现 pending 和明确重试处理。原 v7 board 的 `archiveReceipt` 增加严格可选 cascade 子域，旧 receipt 不自动获得新副作用。写入新子域后旧版本会拒绝该 receipt；不能混用旧实现写库。

## 实现地图

- 后端协调/预览：[task-session-archive.ts](../../lib/task-session-archive.ts)、[task-archive.ts](../../lib/task-archive.ts)、[task-store.ts](../../lib/task-store.ts)、[task-operations.ts](../../lib/task-operations.ts)、[tasks route](../../app/api/tasks/route.ts)。
- 会话批量 sidecar：[session-archive.ts](../../lib/session-archive.ts)（v1 兼容、首次联动写 v2）、[session-reader.ts](../../lib/session-reader.ts)（有界 scoped catalogue）、[session-family.ts](../../lib/session-family.ts)。
- UI：[TaskArchivePreview.tsx](../../components/TaskArchivePreview.tsx)、[TaskDashboard.tsx](../../components/TaskDashboard.tsx)、[TaskInspector.tsx](../../components/TaskInspector.tsx)，三语言文案。
- 存储取舍：[ADR0008](../adr/0008-one-shot-task-session-archive.md)；权威任务表仍只在 [F21](task-dashboard.md#当前存储cas与迁移权威表) 维护。

## 验收入口与边界

```sh
node --experimental-strip-types --test lib/task-session-archive.test.mjs lib/session-archive*.test.mjs app/api/tasks/session-archive.test.mjs app/api/sessions/archive-integration.test.mjs 'app/api/sessions/**/archive/*.test.mjs'
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/task-session-archive.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/task-dashboard-panel.mjs
```

真实临时存储/SDK/HTTP 覆盖双向跨任务族确认、多级族去重、owner ABA/迟到新成员/关联、跳过项、原历史字节/关系/版本不变、批次失败及重启恢复、任务恢复/同状态新意图栅栏、单独会话恢复后的精确重试、v1/v2损坏保护和跨进程写入；还覆盖损坏/有界截断的关系标记不提升为独立根，以及 board 失锁后另一个真实进程恢复任务时旧批次无会话副作用。浏览器拦截 API 覆盖取消/IME/焦点、强制确认、预览错误与冲突、未知/异常成功响应、精确重试、reload pending、恢复不携带 cascade、草稿、零 Agent 写请求和 390px 三语言×两主题；不冒充真实 provider/SSE 或跨文件断电事务。

### 本次验证

- 归档专项及任务 CRUD/资料/顺序/列/视图/关系/迁移、HTTP、侧栏、导航、三语言相关回归合并执行 **214 项通过，0 失败/跳过**；不是全仓测试套件。
- `tsc --noEmit --incremental false`、全仓 `npm run lint`、`git diff --check` 通过。
- 复用既有 30142 源码开发服务：`task-session-archive.mjs`、更新后的 `task-dashboard-panel.mjs`、`task-dashboard-card.mjs`（8 场景）、`session-archive.mjs` 均通过；含 390px 三语言×两主题，浏览器全 API fixture，不修改用户会话或调用真实模型。
- 独立只读复核发现同状态新意图回放、已知 board 失锁仍提交副作用、损坏关系标记提升为根三个问题；均先由真实临时数据/独立进程或有界元数据回归复现失败再修复通过，复核确认原问题关闭。关系标记覆盖坏 JSON、截断、缺 type、错误 type 的有效 JSON 包装。

Windows/NFS/断电/真实 Safari/iOS、真实 provider/SSE、生产打包安装未在此专项验收。删除/新 native 活动与文件枚举仍非跨文件事务，后续子代理依现有根归档投影显示；独立 fork 不继承标记。CLI 不提供 Web 归档列表。

修改同轮维护 F21/F27/F31/F34/F35、领域术语、两种 receipt 验证、任务/侧栏浏览器交点；不得把一次性操作改成持续执行限制或无确认跨任务联动。
