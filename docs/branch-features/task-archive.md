# 任务归档与恢复

## 当前契约：管理显示与一次性联动

见[任务 session 管理契约](task-session-management.md)及[F35 一次性关联对话归档](task-session-archive.md)。Dashboard 归档先预览固定会话族范围，跨任务族须额外确认；独立 archive CAS/receipt 保留，恢复任务不恢复会话，后来关联/复制不自动归档。会话批次与任务写入不是跨文件原子事务；未确认结果保留 pending 和原请求精确重试，不假报完成。

不要求关联 session 空闲，不阻止普通发送或复制，不自动 Stop/恢复/完成，保留原资料/关系/历史。归档任务仍可管理关联关系。未带 cascade 的旧任务归档请求保持只隐藏任务卡片的兼容语义。下文 12 阶段的 active/fullbusy 发送、复制和关系守卫描述已被替代，只作历史记录。

当前01–14全部父验收resolved，统一[当前schema/CAS/迁移权威表](task-dashboard.md#当前存储cas与迁移权威表)为v7。主12 `/tmp/m12-39pOIJ/REPORT.md` 与父独立archive/browser证据分层；[历史附录](task-dashboard-validation-history.md#12-原准入归档与09组合)保留原超时无exit/源dual-root/当时v5，不把旧未合09/10/14当当前事实。最终综合/平台核验另报。
[12票据](../../.scratch/task-dashboard/issues/12-archive-and-restore.md)、[规格D6](../../.scratch/task-dashboard/spec.md)、
[看板/关系](task-dashboard.md)、[准备与发送](task-start-chat.md)、[复制](task-session-copy.md)、[筛选](task-views.md)、[共享重点](task-shared-context.md)。

## 入口与行为

- `/tasks` 的“任务列表”默认日常任务；可显式选“已归档（数量）”或全部。归档列表仍能使用原文字/项目/状态/优先级/标签/运行筛选查找，卡片有归档标记及“恢复”。没有彻底删除。
- 未完成任务也能归档；任务域只隐藏卡片，Dashboard 经 F35 预览确认另联动归档当前会话族；不改变完成含义、列、资料、手动数组、关联、当前知识/全部历史、08选择或11复制receipt，不删除native session、不调用abort/prompt。恢复回到当前保存列与位置（包括用户后来显式移动/14删列迁移的结果，不复活已删源列），不称任务已完成或模型已停止。
- 归档范围是独立的页面投影，不写进05保存的六条件；打开旧保存视图仍保留全部stable conditions，包括未来删除列ID的fail-closed，不静默删条件扩大结果。02/06/07草稿仍按task ID停放；隐藏/恢复不自动rebase。
- 详情可继续只读历史、编辑资料及确认知识；发布后来版本不会自动恢复。归档任务的准备/开始与新的AI整理要求先恢复。用户仍可显式移列/调序归档任务；14[安全删列](task-column-removal.md)全量包含归档任务，原样保持archiveflag/revision/receipt与09pending，不自动restore/检查busy或调用Stop/AI。14已分别父resolved，不与12互代执行证据。
- 成功响应后才反馈归档/恢复；后端busy、冲突、存储/网络错误可见。不因失败自动恢复、停止或发送。未知网络/存储结果保留原UUID/base/目标值及“精确重试”；online/focus/手动refresh只同步权威板，不能抹去未确认错误或假报成功。两页旧CAS冲突需重读并显式选择新意图。
- 原生按钮/select支持键盘及触摸，390px无水平溢出；三语言文案齐全。归档按钮不依据可能陈旧的UI busy徽标提前宣布成功，后端重新裁决。

## 同一个store与独立archive CAS

每任务增加 `archived:boolean`、`archiveRevision:nonnegative safe integer`，内部最近 `archiveReceipt:{operationId,fingerprint}`。
引入于当时v5的additive archive域；合法legacy整个域缺失才hydrate，当前必填/坏值与统一迁移见F21权威表。部分、null、非法计数或receipt拒读、不重置。不第二数据库，保留views、AI/manual/restore provenance、start、copies与所有旧CAS/receipt。

公共 `taskOperation` / POST `/api/tasks`：
`{action:"set-archive",id,archived,expectedArchiveRevision,operationId}`，未知字段/坏ID/base拒绝。F35 允许归档附加严格 `cascade:{previewToken,confirmCrossTask}`，增加 `preview-archive` 及耐久 pending/completed 子回执；恢复拒绝 cascade，旧 receipt 不自动获得会话副作用。
同锁验证task和独立CAS；真正切换只增加archiveRevision，**不增加task/order/columns/views revision或知识pointer、不改updatedAt**，避免归档把最近更新排序、资料/知识草稿或08预览伪装成新内容。
同base同目标no-op仍保存精确receipt、不增加计数。最近同UUID/同fingerprint重试优先确认，返回同锁最新完整board，不重新执行或回拨其它域；同UUID改payload冲突。
更晚归档/恢复替换最近receipt后，旧请求不能猜当前状态重放；不无限保存操作日志。
存储仍原proper-lockfile/keyed serializer/fsync+rename，失败不改原字节；公共record剥离archiveReceipt。

## 同一准入规则与真实busy

`task-archive.assertTaskActive` 是稳定共享guard；`assertTaskSessionsIdle(agentDir, sessionIds)` 在**已有board锁**中调用现有runtime投影 `getTaskSessionActivity`。
后者按原sessionFile scope隔离agent-dir，读取原wrapper生命周期而非浏览器badge/JSONL猜测：pendingPrompt、streaming、queue续跑、等待UI/custom UI、compaction、bash；closing或已删除文件的wrapper仍忙直到dispose，不能被browse metadata的排除误判idle。
07的独立生成复用其原 `hasActiveTaskSummary`/active admission（包括忽略取消仍未settle），不新增运行状态库；归档不会cancel生成。

工作入口：

1. 原wrapper `send` 对prompt、native steer/follow_up、compact、bash及extension_ui_input先沿**原pendingPromptCount**预留准入，再await现有规则，结束移除该预留。prompt本身原计数继续覆盖SDK preflight/整个队列；没有全程持有board锁、粗暴全局运行锁或第二Agent引擎。
2. 普通工作通过 `taskOperation({action:"admit-session-work",sessionId,taskId?})` 同board锁查唯一owner（及显式目标）并要求active。带08准备的prompt仍走原 `admit-start`，同锁检查归档在receipt重试前；失败绝不append/prompt/queue。`prepare-start`及agent/new的taskStart/ensure路径也拒绝归档目标。
3. sleeping chat HTTP在加载运行时/扩展资源前检查，wrapper预留后再重查，不能通过原agent route绕过。公开tasks HTTP在访问store前拒绝内部admit-session-work/admit-start；它们只是in-process SDK接缝，不是可伪造的HTTP发送旁路。
4. archive执行同锁重新检查全部已关联busy；若start已经预留，则archive拒绝；若archive先完成或其idle snapshot已经采样，则之后start必须等同锁后看到archived并拒绝。不能两边用旧state都成功。临时准入失败可能保守拒绝并发archive，用户等idle显式重试，不自动停其他操作。
5. link整批原存在/scope/唯一所有权/CAS不变；向归档目标添加时同锁检查所选session全部idle。若link先提交，之后send看到归档owner；若send先预留，link拒绝。source-create不能偷走原归档owner；普通source-create形成新active任务不需禁止合法运行关联。
6. 11复制仍可浏览/复制idle native历史，不自动prompt；归档source的idle child继承同一归档task关系。complete同锁检查child idle；正在工作或队列中的child不塞进archive，已知child精确retry恢复原结果、不重复创建。source-owner CAS、scope、未知结果手工检查/新空tab合同不变。child不复制08 source tuple，不伪造采用/模型已读。
7. 07生成在原预留与实际provider同步dispatch锁处检查active；已有审核草稿/已生成结果仍可确认成新版本而不restore。归档busy检查同时保护生成竞争，不改变来源session或07鉴权/局部rejection保护。

### 管理边界（不能宣称OS隔离）

上述保证针对**通过Pi Web原HTTP/wrapper/taskOperation入口发起的工作**，包含slash/native扩展命令经prompt、状态按钮的prompt、SDK原生队列及Web custom UI输入。Stop、clear_queue、UI响应/取消、只读历史/状态、模型/工具配置和复制不冒充新普通prompt；原SDK队列不会被archive偷偷清除。

不改Pi扩展API或SDK，不拦任意外部CLI/进程、直接写JSONL、扩展自行绕wrapper调用 `ctx.sendUserMessage` / triggerTurn 或detached provider请求。trusted extension任意代码、资源加载/生命周期hook可能自发执行，并非可被Pi Web archive强制沙箱的用户操作；正在wrapper生命周期或原UI/队列中可观察的工作仍拒绝archive。外部进程权限/文件/模型请求不受本规则控制。不能把归档成功当作任意后台代码已经停止的证明。

## 实现与验证入口

- [task-archive](../../lib/task-archive.ts)：parse、active/busy guard、独立CAS/receipt。
- [types/store/operations](../../lib/task-operations.ts)：统一absence-only迁移域、公共/内部入口、关系和复制检查。
- [rpc-manager](../../lib/rpc-manager.ts)：原生命周期预留、scope-aware含closing投影；原agent/new/[id] HTTP重查。
- [TaskDashboard](../../components/TaskDashboard.tsx)、[TaskDetails](../../components/TaskDetails.tsx)：独立列表scope、发现/恢复/精确重试、start提示；三语言。
- [真实SDK/受控runtime测试](../../lib/task-archive.test.mjs)：临时store/native SDK文件、真实route/provider输入捕获、9类busy（含closing/deleted）、Stop后归档、启动/归档两先后及snapshot屏障、link/启动竞争、native队列/compact/bash准入、SDK fork busy child→同UUIDretry、历史/独立CAS保留、fresh process/权限失败、partial migration/内部HTTP拒绝、07生成guard。busy类型的受控wrapper不是实际外部provider取消证明。
- [浏览器](../../e2e/task-dashboard-archive.mjs)：6场景，真实Chromium/全部API fixture+公共store；键盘未完成归档/列表查找恢复、失败/丢响应精确重试、busy/queue拒绝、两页面恢复CAS/重开、05stable条件/归档移列、390px触摸。原chat和task首Send拒绝另由实际SDK/原HTTP测试证明；没有真实收费provider或生产SSE联调。

```sh
# 新短Git树外/tmp的HOME/TMPDIR/agent/log；先确认非Git、祖先无node_modules。
# env-i最小环境或仅测试子进程清PI_PACKAGE_DIR/JITI_ALIAS/JITI_RESOLVE_ALIAS。
node --experimental-strip-types --test lib/task-archive.test.mjs lib/task-start*.test.mjs lib/task-session-copy*.test.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/task-dashboard-archive.mjs
node node_modules/typescript/bin/tsc --noEmit --tsBuildInfoFile /tmp/<new-evidence>/tsbuildinfo
npm run lint
npm test
```

上述命令是入口，不是本轮文档执行声明。真实SDK全域迁移/旧receipt、归档21/21与B6见 `/tmp/m12-39pOIJ/REPORT.md`；父独立21/21及6浏览器见 `/tmp/pi-parent-ticket12-archive.log`、`/tmp/pi-parent-ticket12-browser.log` 后resolved。[历史附录](task-dashboard-validation-history.md#12-原准入归档与09组合)保留中断/源与主/socketguard边界，不跨轮累计。

## 10关系epoch接缝（10/12均resolved）

[10合同](task-session-relation.md)沿同board锁/fullbusy/uncachedscope；source/target均active，archiveowner→reassign或newsend不能绕restore，无自动Stop/restore/cwd/model/tools/native变更。pendingclear+唯一owner+双方revision+generation同锁原子，失败保持原bytes/pending。当前store保留archiveCAS/receipt与所有14删列/09/08/11/07域；删列可移归档task但不恢复epoch/consumepending。最早pendingreservation保持，archive/start/link/reassign竞争及最终独立主见 `/tmp/t10mr-mus4_2wp/REPORT.md`，10已父接受，不改变12原证据范围。

## 集成与未验

09已主集成并父resolved，保持12管理边界。原最早pendingPromptCount reservation、active/busy guard及07auxsummary全生命周期不回退；09只扣本次发送自己的预留判断eligible，不忽略其他work/UI/queue。pending准备/再次authority/complete同board锁拒archived，select/state/CASclear只管理可持久意图；不自动restore/abort，恢复后同明确版本才可Send。统一legacy/当前必填规则见F21权威表，不reset损坏域；本域CAS/receipt及所有旧域保留。联合真实SDK/fakeprovider、queue/archive两先后、pending→archive→reject→restore→Stop/authfail/retry/cancel和全域迁移见 [09合同](task-context-updates.md) 与 `/tmp/m09-Odiq3z/REPORT.md`，09独立/父接受见09合同；不能用12证据替代或整文件覆盖。
14[安全删列](task-column-removal.md)已父resolved，移列归档任务（本票move从不因archived拒绝），同锁保留archiveflag/revision/receipt与09pending/delivery；实际Send仍拒绝，恢复后保持原明确pending版本。保存视图未知ID仍fail-closed；不把archive状态保护错误解释为永久锁列。14主交叉证据 `/tmp/m14-s1bbqjlr/REPORT.md`、独立 `/tmp/rm14-guxyw6nv/` 后父resolved；10联合最终独立另列。

人工：未完成task归档→日常隐藏→已归档列表搜索→原状态/历史→恢复；busy chat发送/队列/等待交互时归档拒绝且无Stop；任务归档后旧chat Send明确失败、draft保留，恢复后才独立Send；两页旧restore冲突，不伪完成。

未验：真实provider收费/取消wire/质量、外部CLI或任意扩展绕wrapper执行、Windows/ACL、Safari/iOS16.2真机/软件键盘、最低Node执行、生产SSE/打包安装、断电/NFS/kill-mid-write耐久。Chromium/受控runtime或4 Windows skip不代替这些验证。
修改同轮同步本合同及索引、原start/copy/关系合同和票据评论；不得由workerresolve或代父勾验收。
