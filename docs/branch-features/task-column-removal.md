# 安全删除状态列（14，resolved）

2026-10-10 UI 检查：删除预览的长任务名/路径可换行；接收列 select 有显式名称；完成同意复选框保持 flex 行且不继承文本框 padding。真实临时 store + 截获浏览器请求覆盖含归档的范围、done 明确同意、失败/重试和删除后 saved view 的失效条件显示；窄屏/三语言列设置渲染见 [UI记录](../testing/task-dashboard-ui.md)。原 digest/CAS/确认语义不变。

当前01–14全部父验收resolved，统一[当前schema/CAS/迁移权威表](task-dashboard.md#当前存储cas与迁移权威表)为v7。14主证据 `/tmp/m14-s1bbqjlr/REPORT.md`、独立主 `/tmp/rm14-guxyw6nv/` 与10最终独立 `/tmp/t10mr-mus4_2wp/REPORT.md` 分列；[历史附录](task-dashboard-validation-history.md#14-数组http413rename注入与主0912联合)保留源/主当时版本、数组413、rename注入和dual-root失败，不凭源green替父接受或最终综合验证。
[14票据](../../.scratch/task-dashboard/issues/14-remove-status-column.md)、[规格D3](../../.scratch/task-dashboard/spec.md)、
[看板/列设置](task-dashboard.md)、[归档](task-archive.md)、[筛选](task-views.md)、[ADR0007](../adr/0007-persistent-task-board.md)。
本票只删列，不删任务、不启动/停止AI、不自动恢复归档；与09/10/12当前接缝见下文。

## 入口与确认

原 `/tasks` › 列设置继续复用 SettingsUi，不新增列模块、设置文件或数据库。
每个非完成、非最后未完成列（含默认todo/in-progress/review/blocked）可删除；done稳定身份不可删除。
名称/顺序草稿未保存或base配置已过期时，删除禁用并显示先保存或取消重开的原因，不默默丢草稿。
删除进入独立确认阶段：来自完整权威board的源任务标题/项目、全量数量与归档数量，不使用当前筛选/归档列表的可见数组。
接收列必须明确选择，不能为源或未知ID；空列亦使用同样确认流程。
选done时显示“全部受影响任务将完成（包括归档），不会停止AI”，必须另勾完成确认，再点击确认转移/删列。
取消阶段不POST、不修改任务/列。列表与名称均纯文本，无链接/文件权限或AI操作。
键盘原生按钮/select/checkbox与触摸等价，手机控件16px；不安装全局聊天快捷键。

成功才关面板并采用同锁权威board；失败保留固定预览/base/接收选择/操作UUID，尝试同步真实板，不伪成功。
刷新/online/focus更新板但不rebase预览。网络/503/丢响应可用“精确重试删除列”发送逐字段同一请求。
conflict/范围失效不能自动扩大范围，须取消并重开核对；精确旧请求不会变成新意图。
取消未知结果只是退出确认，不撤销已提交删除；同步板/刷新可核对状态，不能声称服务端回滚。
整页关闭/刷新不持久未确认草稿，和13的设置草稿边界一致。

## 公共操作、原子性与顺序

唯一 `taskOperation` / POST `/api/tasks` 增加 `remove-column`：
`columnId,targetColumnId,expectedColumnsRevision,expectedOrderRevision,expectedSourceDigest,confirmCompletion,operationId`。
严格字段/UUID/安全整数/64位小写hex摘要校验；done与最后未完成保护、接收存在性及完成确认均由后端执行。
原全任务数组POST已由review P2容量问题修正：HTTP仍256KiB，不能以增加常数/截断集合/分批代替原子确认。
现有同锁权威board响应新增**仅响应** `columnRemovalDigests:{[columnId]:sha256}`；不改columns配置/独立revision或持久schema。
Node服务端 `taskColumnRemovalDigest` 复用task-store的crypto helper：UTF8流式SHA-256，先写固定 `pi-web:column-removal:v1\n` 域和JSON源ID+换行，再按源原数组顺序逐个写 `JSON.stringify([id,revision,archiveRevision])+换行`。
源身份、每个完整tuple、集合数量与顺序均被绑定，空集/partial/subset/重排/改ID或任一revision不能替代全源确认。
UI仍冻结完整board并显示所有任务/归档计数，只回传该board的服务端摘要；不客户端hash、不用secure-context-only crypto.subtle，缺摘要时拒绝并要求取消/刷新/重开。
同board锁重算digest并检查global columns/order revision：
创建/移入/移出/其他页面改列/并发删除推进global guards，编辑/归档变化由全量集合摘要拒绝，不允许漏移或基于旧名称/归档范围确认。
所有有效scalar均有固定宽度（UUID/列ID、64hex、安全整数、boolean）；UI canonical JSON删除请求与task数无关，最大scalar组合亦小于512字节，不受合法32MiB store规模影响。
不新增preview/token服务、内存缓存/TTL/签名权限或第二数据库；digest是CAS摘要，不是授权凭证，原proxy/HTTP授权仍负责权限。
知识current/receipt等独立域变化不会扩大受影响集合，保留其当前权威值而不追新AI或改历史。

移除源全量投影，按源原手动顺序确定追加到目标最后任务之后；目标已有相对顺序、其他任务相对顺序不变。
只对源任务更新columnId、revision+1、严格递增updatedAt；其他资料/项目/创建指纹、sessionIds/08选择、
06全部history/07 provenance、03moveReceipt、archiveflag/archiveRevision/archiveReceipt、11copies及05views均原样保留。
非空迁移只推进orderRevision一次，列删除推进columnsRevision一次；空列删除不推进orderRevision或任务时间/revision。
校验/计数上限检查完成后同锁构建完整文档，由原fsync+rename单次提交；故障拒绝、不留悬空ID/半转移/重复任务。

统一store保存**可选内部** `columnRemovalReceipt:{operationId,fingerprint}`，缺失合法legacy（不需要强制空字段或新版本）。
存在null/partial/非法值拒读、不重置；所有旧版本dispatch、archive absence-only、views/copies/contexts迁移保持。
只保留最近删列receipt，有界为一条，fingerprint绑定完整canonical请求含原guards/源集合digest/完成确认。
最近同UUID/同内容在列存在性/CAS前确认，返回最新同锁board、不写、不再迁移；同UUID改内容conflict。
更晚删除替换receipt后，旧请求必须conflict，不能猜“列已不存在”即成功，不引入无限删除日志/tombstone。
public board剥离内部receipt。03历史精确moveReceipt可确认当时已提交的移动，即便旧目标现在被删，返回最新板而不重新移动；
新的move仍检查当前列存在性，不能复活ID。set-columns仍禁止直接删除，不能绕过专用确认。

## 默认创建与跨域边界

保留既有默认创建偏好：todo仍存在则普通create/createFromSession都创建到todo，改列顺序不改变此偏好；
todo删除后，两入口在同锁使用**保存配置顺序中的第一个未完成列**，永不默认done，不重新增加todo。
已提交创建精确重试仍先确认原不可变身份，返回当前任务，不因今日默认列改变重新创建/移动。
初始/合法早期迁移补原五默认列一次；已有配置只要求唯一done+至少一个未完成，不重新补已删默认，详见F21迁移权威表。
保留05保存视图对被删ID的条件与receipt，不改名/删条件扩大结果；原投影显示失效、全结果空，用户显式调整。
12归档任务可以移列并保持归档；以后恢复到其**当前保存列/位置**，不回拨已删源。busy/启动guard不改变。
07来源/08选择≠nativeappend≠provider读/11继承receipt均不变；主09独立sessionUpdates/choices/pending/deliveries按字段原样保留。P2摘要是TaskBoard公共响应字段/TaskColumnRemovalRequest请求字段，不是TaskDocument或09采用域；所有board/精确retry响应同锁返回当前map。09选择/CASclear/成功SDK投递与知识是独立revision域，不使旧scope摘要失效或被删列consume；关系/field mutation必须推进task revision，digest因此覆盖04link/08admit/11copy与10关系变更。
当前必填域/absence-only迁移遵循F21权威表，12原最早pending reservation/同锁active guards与09entry identity/贡献引用/stream full locked material保持。10已resolved，同锁推进双方task revision并clear不适用pending，保留旧history/native文字与receipt；10联合执行证据单列，不继承14源green。最近receipt形状不变，无强制迁移新字段；已有receipt指纹保持原字节，绝不把旧数组指纹猜成新digest成功。14尚未发布的旧array wire请求不再接受，旧页面必须刷新重开，不做静默payload兼容/重演。
主新增真实SDK/fake联合pending→删列→actualSend原选定版与entry/hash/成功input-response证据；archivedowner→删列→Send仍拒绝→restore保持pending，field/link/实际copy mutation让旧scope摘要冲突；已有delivery与新pending在冻结scope后独立变更、SDK实际工作中删列不Stop仍保留完整choices/deliveries。03/05/06/07/08/11/12旧receipt精确确认不重演、不回拨，board-returning响应为同锁最新含digest板；start/copy专用receipt保持原形状不伪造board或read。主fresh详见 `/tmp/m14-s1bbqjlr/REPORT.md`，不以文本无冲突或源green验收。
旧应用版本若仍要求原五列会拒读删列数据；不声称向旧代码安全downgrade，不能重新加默认“修复”。

## 10关系epoch接缝（10/14均resolved）

[10合同](task-session-relation.md)在当前统一存储中：保留columnRemovalReceipt/validator/原fingerprint与所有sessionUpdates/history/current/AIprovenance/views/archive/start/copy/order域。columnRemovalDigests仍是同board锁响应派生，不持久。source/target关系revision同时推进使旧全源摘要失效；同锁clear旧pending，旧callback/ABA不得补delivery或清新pending，历史已提交receipt只确认事实而不重绑。删列保持relationgeneration/采用审计，targetdone警告不清采用、不Stop，05旧列仍failclosed，archiveowner不能reassign/newsend绕过restore。全部board-returning旧receipt带同锁最新digest map；50k容量/<512请求合同不回退。联合入口 `lib/task-relation-column-removal.test.mjs` 与 `lib/task-relation-migration-review.test.mjs`，最终独立复审 `/tmp/t10mr-mus4_2wp/REPORT.md` 关闭10坏数据P2并由父接受；原集成报告仅历史。

## 验证入口与平台边界

```sh
# 新短Git树外/tmp HOME/TMPDIR/agent/log，预检非Git/无祖先modules；仅测试清3 aliases。
node --experimental-strip-types --test lib/task-column-removal.test.mjs lib/task-column-removal-context-updates.test.mjs app/api/tasks/column-removal.test.mjs lib/task-start-migration.test.mjs lib/task-relation-column-removal.test.mjs lib/task-relation-migration-review.test.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/task-dashboard-column-removal.mjs
# 联合13columns/12archive/08start/11copy/07summary与05views/06context/04sessions/03order+retry/02details/01draft及导航
node node_modules/typescript/bin/tsc --noEmit --tsBuildInfoFile /tmp/<evidence>/tsbuildinfo
npm run lint
npm test
```

真实tmpstore：全量隐藏/归档确定顺序、done/lastunfinished/空列、完成确认、删todo后两种创建、原创建/移动/知识/视图/归档receipt、
两fresh进程delete/delete与create/incoming-move、源编辑/归档/配置/集合CAS、POSIX写拒绝和fresh-process rename EIO注入、
计数上限/坏receipt；真实SDK联合迁移保留08/11/07/05/06所有已确认域。
源容量回归通过真实POST handler：3500任务1,677,893字节store与50000任务24,014,644字节store，旧数组276724/3950225字节仍真实413；摘要请求296/297字节均200，非法partial摘要409/未独立确认done400仍原bytes不变。最大合法scalar请求亦<512；摘要map不持久。
Chromium全API fixture+**真实GET/POST handler**+公共真实store：全范围/取消、键盘单独done确认、05实际保存视图失效/重开、删todo后表单创建、
失败/online/精确重试、空列丢响应/refresh、incoming竞争取消重开、390px触摸/lastunfinished保护。

源/主容量与失败阶段记录移至[历史附录](task-dashboard-validation-history.md#14-数组http413rename注入与主0912联合)。14主真实GET/POST容量（3500/50k store<32MiB，旧数组413、新固定296/297bytes请求200）、全hidden/archive、旧receipt/current digest与09×12联合执行见 `/tmp/m14-s1bbqjlr/REPORT.md`；独立主 `/tmp/rm14-guxyw6nv/` 后父resolved。10最终独立主复审另验3500store1,747,935/50k25,014,686bytes与同固定请求合同；不是50k DOM benchmark。文档整理未重跑任何这些命令，最终综合核验另报。
Windows/ACL、Safari/iOS16.2真机/软件键盘、最低Node执行、生产打包/SSE、真实provider费用/取消、
断电/NFS/kill-mid-write未验；Chromium/CDP、可控EIO和Windows-only skip不代替这些证明。
无nextbuild/install/globalinstall/真实历史/commitpush；测试临时dual-root结束/full/config前恢复原字节并排除patch，只停自有dev。
修改同轮同步本合同、看板/筛选/归档、SettingsUi说明、ADR与索引。
