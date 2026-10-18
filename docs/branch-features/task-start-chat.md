# 从任务准备对话并独立发送（08，历史功能）

> **当前暂停**：见[任务 session 管理契约](task-session-management.md)。不再显示“开始执行”及准备材料，不新增任务上下文；旧 taskStart 请求明确拒绝、旧准备 URL 要求重新打开普通聊天。使用普通聊天后关联已有 session。原 receipt/原生历史不删除，下面是原行为背景。

当前01–14均父验收resolved，统一[当前schema/CAS/迁移权威表](task-dashboard.md#当前存储cas与迁移权威表)为v7。主08证据 `/tmp/m08-v3uqlo_0/REPORT.md`、独立 `/tmp/m8iv-1009/REPORT.md`；恢复、R1–R5、child联合red与N1见[历史附录](task-dashboard-validation-history.md#08-恢复r1r5及主0811适配)，原claimed和无exit输出不改称最终pass。
关联：[看板](task-dashboard.md)、[知识](task-shared-context.md)、[独立聊天](independent-chat.md)、[草稿](new-session-project.md)、[09更新](task-context-updates.md)、[10关系](task-session-relation.md)、[11复制](task-session-copy.md)、[归档](task-archive.md)、[删列](task-column-removal.md)、[08票据](../../.scratch/task-dashboard/issues/08-start-task-session.md)。

## 悬浮看板的聊天选择（2026-10-10）

看板改为 AppShell 上的持久浮层后，`TaskStart` 通过 `TaskPanelNavigation` 调用 shell 的现有 new/select 流程，再关闭面板；不能只 `router.push` 改 query 而让原聊天继续显示。同 cwd 新任务准备直接转移当前 composer 身份，不与旧公共停放草稿合并；同一已选聊天 Continue 也显式采用新 token。token 由 shell 持有，普通 New/项目切换/显式选择同步清空，不因延迟 URL 更新继承旧准备。异步关联聊天导航只接受最新 intent，关闭面板或其他 workspace 选择取消旧跳转。ChatWindow 只在新的非空准备 token 到达且目标匹配时更新预览；普通 native promotion 清 token 不重置重核后的材料/风险确认。独立发送与服务端所有准入不变量不变。改版浏览器用例见 `e2e/task-dashboard-panel.mjs`（API 合成 prepare，不代表真实发送验收）。

## 入口与用户行为

- 详情“开始执行”默认new，也可continue真实合法关联session；prepare重查存在/权威scope、active。new可无知识，锁任务说明/完成要求与confirmed版；continue只展示原选定资料，不追latest。没有new-start receipt的旧session不借继续升级；receipt-only未append的原source仅独立Send补原snapshot一次。
- 预览→“进入聊天（暂不发送）”用原页面/独立被动材料栏，不写textarea或替文字/图片。准备/取消/导航不prompt/ensure/改变关系或任务状态；原composer独立Send才发送，原model/tools/admission/queue/cancel/error回填不变。
- 固定task revision/current pointer与关系epoch；实际Send同锁再验。资料/版本变动明确拒绝并要求重核，不偷偷选新。失败恢复draft，重核保留原operationId/真实sessionId；已提交关系/选择精确retry保原资料，不借latercurrent回拨或升级。
- preparation仅浏览器JS内存，URL非敏感UUID token/session/cwd；刷新丢未确认token提示重新预览，普通Send/steer/follow-up客户端拒绝并恢复草稿，不能拿失效token发。普通New/picker/显式不同URL不继承，01layout departure/history/慢导航最后快照保持。
- 真正启动前warm registry重查同cwd所有busy，不仅同任务或UIbadge。其他Agent工作先拒，用户明确勾风险后可再次Send。提示覆盖文件风险，不自动worktree/文件锁/隔离/合并；允许多session不等生产并行写安全。状态仍用户决定。

## SDK接缝与权限

- SDK1.0.0 SessionManager.create(cwd,sessionDir,{id})明确UUID，task operationId是实际sessionId；原startup lock/registry复用，丢ensure/关系失败不造另一ID。已持久路径按既有解析重开，不改JSONL。
- prepared未flush wrapper跨Chat-only/恢复configured时以原preparedSessionId重建；普通非prepared仍原规则，观察到持久file删除不能复活。SDK isPersisted表示启用持久化，不代表已经flush。
- 原prompt admission同锁提交唯一关系与不可变selection后才可prompt。SDK sendCustomMessage(...,{triggerTurn:false})普通user-role材料明确非授权/指令、JSON来源，不命令/模板展开、shell执行/路径读取；不替exactsystem/提升Chat-only/tools/写readonly state或另建Agent。易失nextTurn队列不用于精确持久重试。
- **selection receipt ≠ native append ≠ 成功SDK input/response ≠ provider wire/read。** 同operationId native task-context entry证明append，getEntries含压缩/弃用raw历史去重；未append才补自己的原snapshot，不从current重拼。branch/compaction/context_edit决定实际输入，不能将raw永久视为有效投影/已读。
- Stop检查原extension UI abort signal，锁等待后Stop拒unsent但已选关联可保留重试。原preflightResult普通prompt和streamingBehavior队列规则保留；agent/new在taskStart校验前记录commandType，直接prompt拒绝含校验失败均accepted:false。
- native steer/follow_up带任何own taskStart（null/undefined/合法selection）拒绝，要求prompt+streamingBehavior准入；无metadata原队列不变。公开POST tasks内部admit-start在store前拒400/不写；新HTTP旁路不存在。
- 独立聊天只是固定cwd身份，不强制Chat-only；精确before_agent_start prompt与Chat-only资源禁用不变。normal read工具call/result配对由SDK维护，不能重拼history。

## 数据与各票接缝

prepare-start/admit-start仍唯一taskOperation（后者仅wrapper/隔离测试）。严格new-start tuple要求sessionId===operationId、selection.mode=new，保存immutable selection/snapshot和epoch；关系+选择同锁，真正新关联只task revision/time，不改state/order/columns/knowledge。08selection固定字段canonical，不受迁移补epoch属性顺序影响；统一legacy规则见F21权威表。

- **11**：child不copy source tuple/pending/read，只SDK实际分支历史和copy receipt。显式Continue在合法metadata后复用07 bounded/non-migrating snapshot，活动raw task-context与原selection/version/text准确匹配，显示原选择session/origin/“继承历史”。fork点在context前version=null，之后保原版不追latest；context_edit/compaction可排除输入，不重注入、不伪child新receipt或调用。source receipt-only Stop仅source Continue恢复，child不补source。
- **09**：明确pending只有下一eligible普通Send使用，busy选择不steer/followup/abort/restart。合法活动native update（含authfail/Stop零delivery）阻止Continue回拨更老receipt-only材料，预览/admission同native lineage。entry identity+request-local贡献引用+完整SDK stream正文成功response才记input-response，不freeze/refill删文、不等wire/read。
- **12**：原最早pending reservation/同board active/fullbusy守卫覆盖prepare/actualSend/complete与原chat/native工作，archived必须显式restore，不Stop/done/自动追current。选择tuple/native事实与归档CAS独立。
- **14**：全hidden/archive删列不改start snapshot/operation/native，旧start精确重试原材料；归档owner移列仍拒Send，restore在当前列。所有board-returning receipt当前派生digest，start/copy专用响应原形状、不伪board/read；删列不改epoch，关系revision失效旧digest。
- **10**：prepare固定owner+epoch、admit先拒旧epoch；A→B→A不复活旧new/continue准备或receipt-only恢复。旧tuple保审计，freshContinue仅当前epoch自己的未append材料；旧native如实保留≠遗忘。不copy tuple给child、绕归档restore或变model/tools/cwd。

## 实现与验证入口

[task-start](../../lib/task-start.ts)、[types/store/operations](../../lib/task-operations.ts)、[TaskStart](../../components/TaskStart.tsx)、[task-start-client](../../lib/task-start-client.ts)、[ChatWindow](../../components/ChatWindow.tsx)、[useAgentSession](../../hooks/useAgentSession.ts)、[agent/new](../../app/api/agent/new/route.ts)、[RPC](../../lib/rpc-manager.ts)。

```sh
# 新短Git树外HOME/TMPDIR/agent/log；预检非Git/无祖先modules；测试清三SDK aliases。
node --experimental-strip-types --test lib/task-start.test.mjs lib/task-start-copy.test.mjs lib/task-start-migration.test.mjs lib/task-relation-migration-review.test.mjs lib/task-relation-column-removal.test.mjs
E2E_BASE_URL=<verified-base> node e2e/task-dashboard-start.mjs
E2E_BASE_URL=<verified-base> node e2e/task-session-copy.mjs
```

入口不是本轮文档执行声明。真实临时SDK/原route/wrapper/store与streamFunction/fake Provider捕获覆盖firstrequest model/system/tools/已提交关系、Stop→Continue、same-ID政策重建、native/HTTP负测、copy前后branch/context_edit/合成compaction、全域迁移/receipt。浏览器真实Chromium但API/SSE fixture，8场景/5captured SDK requests不是production SSE或收费provider证明。SDK文档/声明核对不代运行测试；完整执行层级见[coverage](../../.scratch/task-dashboard/FINAL-COVERAGE.md)。

人工：任务开始→默认new→取消零请求→重新准备进入chat原draft仍在→另页发布新current后Send拒绝且回填→重核独立Send原UUID；continue不追latest，busy同cwd先拒后显式风险确认。真实Provider可能计费需另授权。

## 限制与维护

**N1既有P2未修**：外部删除已持久warm session后set_tools可追加headerless片段并500；独立08review在ordinary/prepared before均复现，未扩大为成功删除保证/新阻断，不借本票重构SDK路径。
未知copy可能孤儿/重复，board/native非跨文件原子；prepare不跨刷新持久，已确认选择/历史持久。原单进程wrapper管理不拦外部CLI/trusted extension绕入口，无OS文件隔离/多server协调。
真实provider wire/read/费用/取消/质量/网络、production SSE/build/install、Windows实际SDK/ACL/浏览器、Safari/iOS16.2真机/软件键盘、最低Node/断电/NFS未验；CDP与4Windows skip不代。最终综合核验另报。
修改同轮维护索引/session/tools/model/导航合同，保留04权威scope、06不可变history/CAS/receipt、01最后草稿与原prompt admission/queue/cancel/error/exact-system策略，逐域语义集成不整文件覆盖。
