# 07 主动 AI 整理共享重点（历史功能）

> **当前暂停**：见[任务 session 管理契约](task-session-management.md)。任务及当前对话的整理入口、草稿 UI 不再挂载，后台新整理操作拒绝，不调用模型。以下为旧实现/验收背景，旧来源数据仍兼容保存。

2026-10-10 UI 更新：详情与“当前对话”入口共用已有共享重点草稿保护，不能以新生成覆盖人工草稿。生成成功直接打开独立详情审核，即使目标任务被当前筛选隐藏。无可用模型/对话显示下一步说明，错误靠近生成操作并滚入视野；取消回到浮层焦点、IME `isComposing` / `keyCode=229` 都不取消编辑。取消后的迟到合成响应不打开草稿。见 [UI 检查记录](../testing/task-dashboard-ui.md)；合成生成只验证 UI，不替代本合同 provenance/provider 验证。

当前01–14全部父resolved；[当前schema/CAS/迁移权威表](task-dashboard.md#当前存储cas与迁移权威表)统一为v7。依赖[04关系](task-dashboard.md)与[06人工审核](task-shared-context.md)。主证据 `/tmp/m07-zsEOPj/REPORT.md`、快失败窄修 `/tmp/f07-1YiNtC/REPORT.md` 与父3/3复核分列；[历史附录](task-dashboard-validation-history.md#07-鉴权来源与快速promise-fatal)保留原三阻断与fatal/红绿。摘要保存不等于09对话采用，更不等于Provider已读；最终综合/平台验证另报。

## 09关联（resolved）

[09明确接收](task-context-updates.md)仅选择06已经确认的版本，包括服务器签发AI来源；07草稿/生成失败不成为可接收版本，07独立auth/dispatch与来源scope/context-edit/nullleaf保护不改。统一store保留本AI历史、publication receipts及05/11/08域。生成模型provenance与采用对话的实际response model分开，不改原模型设置或强迫对话追newcurrent。主09/12保留07审核draft/AI历史及原auxsummary active/busy guard；新的archived生成仍拒绝，已有draft可确认而不restore，latercurrent不会替换09pending。联合迁移及native fakeprovider实际输入见 `/tmp/m09-Odiq3z/REPORT.md`，不改07父验收resolved。

## 入口与完整流程

- 任务详情原生按钮“整理共享重点”打开独立面板；已选聊天侧栏原生 Link
  `/tasks?summarySession=<id>` 进入看板，只有该聊天已关联任务才打开整理面板。
  未关联显示错误、不扫描正文、不启动AI。聊天入口默认勾当前对话和当前模型；任务入口不预选来源、默认全局模型。
  新/空白composer无来源入口。Link不提前停放草稿，保持01真正layout departure/history/慢导航最终快照规则。
- 明确选同任务对话 → 明确分支leaf → user/assistant已完成文字默认勾选 → 工具结果逐条单独勾选
  → 预览删减（仅删除、不新增/替换） → 查看临时模型、发送对象/费用/脱敏限制 → 确认生成。
  分支选择器列出活动leaf及真实树叶；仅所选leaf到根路径，不混其他分支。
- 工具结果旁明确显示“可能包含文件内容”；只取其text block，不能伪称文件文字不存在。
  不传工具arguments/details、images、system、thinking/signatures、custom/scratchpad、summaries，
  不含pending/error/aborted/deferred助手半条记录。branch-local context_edit的删除/替换得到尊重。
  `length`与`toolUse`是SDK已终结消息，可包含其已经完成的text；新消息绝不追加入原预览。
- 预览按来源/branch/entry显示实际勾选及删减文字；可以返回选择。确认生成时禁用选择和编辑，
  锁定这份输入及显式模型。出现路径/link/附件不会读文件、下载或打开附件。
  临时模型不执行set_model、不写全局默认；显式不可用（包括已配置的默认不可用）明确失败、绝不fallback。
- 生成只产生四节可编辑草稿，复用06编辑 → 被动Markdown预览 → 确认发布。
  返回编辑、取消、失败不改变current/history/task状态；恶意指令、HTML、代码、路径只作资料。
  来源标明真实generation/model/responseModel、session/branch/entry/toolentry，编辑输出不会伪装成人工来源。
  发布和恢复都仍是06不可变版本/current CAS；不会主动注入来源或其他对话。
- 原生按钮、checkbox、select、textarea可Tab/Space/Enter/触摸操作，面板挂载聚焦，局部Escape取消。
  390px控件16px、不水平溢出；不安装聊天全局快捷键，不改变原composer模型/工具/队列/草稿。

## 服务端权限、SDK与失败规则

`taskOperation`仍是唯一语义入口；`/api/tasks`沿用proxy认证/Host/Origin、no-store和现有HTTP限制。
新增 `summary-options/source/generate/cancel`，请求严格拒绝未知字段/路径式ID。
`publish-context`仅新增可选`generationId`；客户端仍不能传入source/model provenance。

- options为metadata-only列表及SDK services模型列表；source显式按需只读chosen SDK history。
  服务端在board锁内再次确认task、04同任务真实关系、当前权威project scope和来源存在；
  任意sessionId不能绕04。使用04的uncached权威项目规则，不用sidebar缓存授权。
- live来源只读manager快照，显式保留null active leaf（resetLeaf），不调用prompt/get_state/ensure，不启动sleepAgent。
  磁盘来源通过bounded read + `parseSessionEntries` + `SessionManager.inMemory`，
  不使用可能迁移写盘的`SessionManager.open`。真实文件上限16MiB，读取期间变动拒绝。
  路径来自合法metadata catalogue，不接受客户端路径，不扩展file allow-list。
- 服务器生成随机snapshotId，绑定agentDir/task/session/cwd/明确leaf/branch hash/活动路径。
  generation前、实际发送前、生成后及06发布锁内重复校验关系和来源；切到另一活动分支、
  已选路径/context_edit发生变化、删除、改项目/关系均拒绝。后追加的同branch context_edit删除/替换预览entry也使snapshot失效，即使旧leaf→root hash不变；仅普通消息append允许且不扩大锁定输入。
- 独立 `createAgentSessionServices({cwd:agentDir,agentDir})` + SDK公开 `modelRuntime.getAuth(model,{signal})` 先解析鉴权，随后board锁内再次验证并同步调用公开 `Provider.streamSimple(...).result()`；
  无第二Agent/engine，无source session.prompt，无session_start/历史追加/queue/loadout/model写入。
  `tools:[]`、`toolChoice:"none"`、`maxRetries:0`；信号和60s deadline传至SDK。
  SDK1.0.0本地声明及实现已核实：completeSimple是lazy stream，返回Promise后才await auth.resolve；不能把Promise创建当真实dispatch。公开Provider接口接收normalizeContext生成的无工具transcript及SDK已解析apiKey/headers/baseUrl/env，不patch私有SDK、不改来源runtime。鉴权挂起期间relation失效会在dispatch前拒绝，provider收到0请求。
  services可能加载受信任的全局provider扩展（与已有辅助调用一致），不承诺恶意扩展无副作用；
  不为了session_start-only provider唤醒来源。不支持/不可用明确失败，不绕权限替代。
- 每个任务最多一个在途生成，全进程最多4个；重复operationId+完全相同输入join同请求，
  成功重复返回同草稿，修改同ID冲突。取消/失败不自动再试；用户明确另发新generation可能再次收费。
  内部generation Promise创建后立即安装局部rejection观察，避免快速模型不可用/鉴权失败在异步解锁前成为未处理rejection；原Promise仍保持rejected，经公共caller正常传播。失败generation仍标记failed，精确旧ID不重试，准入按原finally释放；不安装全局忽略器、不将错误当成功。
  provider忽略Abort仍持有slot直到settle，deadline/cancel立即返回，不让重复点击堆积收费。
  不保证provider已经取消或退款，真实网络/费用未验。
- Snapshot与未发布generation保存在服务器内存，30min过期、最多各64份；重启/过期后重新预览。
  旧snapshot请求不能在重启/过期后重发计费。未知/过期generation无法发布。
  已确认06精确receipt可在重启/过期/更晚版本之后继续确认，不重新生成、不回拨current。
- 分支预览256KiB、发送资料200KiB上限；模型容量用保守UTF8-byte+输出reserve上界检查，
  同时检查model.inputLimits.maxRequestBytes。超过任一限制明确要求删减/选择较早branch point，
  没有silent truncate/自动分块/自动摘要。不承诺精确tokenizer；provider长度失败仍显式报错且不重试。
  正常stop、无toolCall、模型身份一致、严格四节JSON（每节≤20000）才能成为草稿。
  错误不回传上游凭据/完整payload。

## 12归档准入交点（主已父验收resolved）

[归档合同](task-archive.md)在原summary-generate预留及真实同步provider dispatch锁内要求task active（含同ID草稿获取action），没有silent restore或新调用旁路。归档通过原active set重查在途生成，包括cancel/deadline已返回但provider仍未settle的slot；归档本身不cancel。已返回的AI草稿仍可走06人工审核publish，发布新version不restore，原来源关系/branch/鉴权dispatch/局部快失败rejection及精确发布receipt保持。不另建生成状态库或改变来源session，07既有验收不扩大成12父验收。

## 10关系epoch接缝（10/07均resolved）

[10合同](task-session-relation.md) snapshot绑定来源relationgeneration；生成准备、auth后同步Providerdispatch、response后、重复result与未提交publish同锁重验owner+epoch。A→B→A不复活旧snapshot/draft，已提交精确publishreceipt只确认版本事实，不依赖今日关系/内存generation、不重新Provider或回拨current。原scope/branch/contextedit/nullleaf/active-slot与局部快失败Promise观察不退。14关系revision CAS与生成ownerepoch独立，删列不改关系epoch/知识current/provenance；最终主独立证据 `/tmp/t10mr-mus4_2wp/REPORT.md` 与修复证据 `/tmp/t10fix-l8beyj3o/REPORT.md` 分列，原主集成报告为历史。

## 持久化与集成冲突清单

不另建数据库；snapshot/generation内存与统一durable store职责分开。schema及absence-only迁移只维护F21权威表，保留所有旧receipt及05视图独立域。
只扩展 `TaskContextSource` 严格union为服务器签发的 `kind:"ai"` provenance，不新增必填旧字段、不改schema版本、不将旧manual/restore转换为AI；已存在坏AI历史拒读，
manual/restore验证及原fingerprint字节规则保持不变；AI的receipt额外绑定generationId。
知识仍不推进task/order/columns revision、不改资料/状态/关系/creationFingerprint/moveReceipt。
旧应用不认识AI source会fail closed；不伪装manual求兼容。后续如升schema必须保留AI历史及receipt。

交点：`task-types/context/operations`的source union/06 commit、`TaskDashboard/Details/SharedContext`的
独立草稿与按钮、`SessionSidebar`原生Link、三语言和合同README。
05已保留其筛选/unknown运行态与视图CAS/receipt；07生成面板不随过滤卡片卸载，02/06/07草稿按task ID保持原base，来源关系变化不得发布。所有精确retry返回包含当前views/columns/task/order/context的同锁板。08/11已主集成；后续修改仍须逐域语义合并，不整树/整文件覆盖；尤其保持04唯一关系、
13配置独立CAS、03精确移动重试、02固定base草稿和01navigation。新增文件主要为07专属，
没有改共享node_modules/package依赖、没有任务工具或08发送实现。

## 验证入口与已知缺口

```sh
# 测试子进程清三SDK aliases；HOME/agentDir/TMPDIR/日志使用Git树外短/tmp。
node --experimental-strip-types --test lib/task-summary.test.mjs lib/task-summary-review.test.mjs lib/task-summary-rejection.test.mjs lib/task-summary-integration.test.mjs app/api/tasks/summary.test.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/task-dashboard-summary.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/task-dashboard-summary-views.mjs
# 必须联合05views11、旧task store/API、01draft12/02details8/03order10+retry6/04sessions7/06context8/13columns7及导航回归
```

`task-summary-fixture.mjs`明确测试专用：真实临时SDK持久树/分支/context edits、ModelRuntime +
SDK faux native provider；在真实provider dispatch捕获请求文本/model/tools/retry及原transcript，不把completeSimple前置调用计作provider请求。独立review三阻断的真实SDK红→绿回归见task-summary-review：auth悬停关系变化provider0、后追加context_edit生成/发布拒绝、warm nullleaf不复活旧资料。
task-summary-rejection使用默认Node子进程（无unhandledRejection listener/策略flag），验证caller try/catch捕获快速不可用/鉴权失败/同步provider失败、实际fakeprovider0、未发布、失败精确ID拒绝且新ID准入可用。
真实warm AgentSession的model/queue/loadout/manager不变；sleep来源不创建Agent。
浏览器所有API被fixture拦截，操作仍调用同公共入口和真实临时store/SDK/fake；
聊天原Explorer仅允许显式cwd的type=list，禁止正文read/download、未知Agent POST和外网。
不得把fake行为当真实provider通过。fresh完整命令/失败尝试/exit/patch/hash见07报告。

人工复核（如使用真实provider须另获费用授权）：选择同任务branch和部分tool → 删除敏感片段 →
临时换模型 → 检查发送对象/费用 → 生成 → 修改四节 → 预览 → 确认；取消、非法模型、两页旧base、
生成中改关系/分支均应不误发布。打开页面/运行结束不生成；原聊天历史/队列/模型保持。
Windows/ACL、Safari/iOS16.2真机/软件键盘、最低Node、生产打包、真实provider费用/取消/质量/网络、
断电/NFS仍未验证；Chromium触摸和SDK fake不是这些平台/外部服务的证明。

## 证据与维护边界

[历史附录](task-dashboard-validation-history.md#07-鉴权来源与快速promise-fatal)按发现/窄修/独立父接受保留证据指针，原/tmp报告不改。有效快速Promise red→green和父默认Node子进程3/3见 `/tmp/f07-1YiNtC/REPORT.md`、`/tmp/pi-parent-ticket07-rejection.log`，07已resolved。命令与SDK文档核对不是本轮文档执行通过；fake Provider不代表真实provider。测试隔离/服务核验遵循F21验证入口，不安装/build/服务动作或真实数据/模型。

修改同轮维护本合同、task-shared-context、受影响session/model/tools notes及README索引。
