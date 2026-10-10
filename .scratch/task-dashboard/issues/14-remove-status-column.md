# 14: 安全删除状态列

**What to build:** 用户删除允许删除的状态列时，先选择其中任务的接收列，再完整转移并删除；隐藏和归档任务也被正确处理，不会因只看当前页面而遗漏。

**Blocked by:** 12（归档与恢复任务）、13（增加、改名和调整状态列）。

**Status:** resolved

## Acceptance criteria

- [x] 完成列禁止删除，最后一个未完成列禁止删除；后端同样执行保护，不能只靠页面隐藏按钮。
- [x] 删除有任务的可删列前，显示受影响范围并要求选择合法接收列，取消不写入；接收列不能是源列或已不存在的列。
- [x] 选择完成列为接收列时明确提示将使相应任务变为完成，必须由用户确认，不能藏在一般列设置操作中。
- [x] 转移覆盖源列全部任务，包括筛选隐藏和已归档任务；不要求恢复归档任务，不丢关联、共享版本或其他属性。
- [x] 任务转移与列删除作为一致操作保存，故障时不留半完成状态、悬空状态引用或重复任务；转移后的顺序确定且不破坏目标列既有任务。
- [x] 确认后重新验证列与受影响任务集合；新增任务、其他页面改列或并发删除不能造成漏移、双重迁移或突破至少一个未完成列的限制。
- [x] 完成后所有相关视图重新同步；如果保存的筛选仍引用被删列，应显示条件失效或要求调整，不能悄悄改成其他列或全量范围。该处理与 05 已建立的失效条件规则一致。
- [x] 删列不启动或停止 AI；归档标志保持原值，历史及共享信息仍可查，不新增任务彻底删除功能。
- [x] 用真实临时存储注入保存失败与并发变更，验证全量迁移及保护规则；浏览器覆盖可见/隐藏/归档任务、完成提示、取消、错误恢复和键盘操作。
- [x] 更新列设置、归档及筛选交点的合同和测试，区分本票据已验证组合与尚未落地的可选分支，不使用真实会话或付费模型。

## Scope and handoff

13 提供列配置，12 提供真实归档行为，两者都完成后才有完整的安全删列演示。05 的筛选失效处理已是其自身合同，本票据必须发出正确配置变化并保留可判断的稳定身份，不因此增加一个冗余的功能依赖。

若 05 已落地，执行实际保存筛选的浏览器回归；若尚未落地，先验证失效引用和配置读取的公共行为，由 05 接入时完成相同组合验收。各票据的局部绿色不替代所有批准切片整合后的完整规格验收。

## Spec coverage

用户故事：US21、US22、US23、US32、US57、US60、US61、US62、US63、US65。
访谈选择：Q18、Q19、Q27。
实现决策：D2、D3、D4、D6、D10。
验收计划：T05、T06、T07、T08、T12、T17、T21、T23；后几项为删列与已有能力的交叉回归。

## Comments

2026-10-09（父验收）：14主v6独立复审无阻断，容量P2保持关闭；独立32窄/4归档/5SDK/25HTTP/14内部拒绝、
删列8与09更新9场景通过，50k主store25MiB用297bytes请求全量原子迁移，09/12事实和守卫不回退。
父核对27增量、1227保护文件及主full2854pass/0fail/4skip、223focused/23browser等证据，按14范围验收resolved。
主报告 `/tmp/m14-s1bbqjlr/REPORT.md`，独立 `/tmp/rm14-guxyw6nv/`。10仍独立树未主合，
须后续验证reassign与摘要失效/同事务清pending，不将本验收扩大到10。真实平台/外部provider/耐久缺口保留。

2026-10-10 主领取14语义集成：12/13与01–09/11均父验收resolved，主schema v6。固定gpt-6.1-sol/high，主 `/Users/noname/GitProjects/pi-web` 唯一写入，10独立树不碰。主beforehash/快照先冻结 `/tmp/m14-s1bbqjlr`；父最新PARALLEL/HANDOFF保留且不进入产品delta。

只读源 `/tmp/pi-web-parallel-14-pvwtc050/ticket14`，交付 `/tmp/c14-6np7qty2/REPORT.md`，23文件/5新增patch SHA256 `d9705a4a2fa048438476c67a256e0bcbe4455894d0f3d9a417c8fe8fec326551` 已核对全部afterhash。源review容量P2关闭 `/tmp/rr14-hsmod9_j`（12窄/25独立HTTP探针及50k容量），不是主green或父验收。源初轮rename注入未生效、symlink-root panic、sidebar脚本错误与review真实413记录保留，主不继承旧通过数字。

按hunk保护v6强制域与absence-only旧迁移、09独立sessionUpdates/pending/delivery及entry identity/array reference/stream完整material、12最早pending reservation/同锁guard。响应-only摘要绑定全ordered id/revision/archiveRevision，固定<512byte请求；不持久、不新增preview/token服务或客户端crypto.subtle。done/lastunfinished/targetdone独立confirm、全hidden/archive同锁原子迁移、确定顺序、05未知IDfailclosed、删todo后两create首unfinished与所有旧receipt保护。主新增真实SDK/fake联合pending→删列→实际原版输入/成功证据、archivedowner→删列→Send拒绝→restore保持pending，以及field/link/copy revision使旧摘要conflict。

主fresh命令/log/start/end/exit、容量、迁移决策、交叉测试与精确主增量见 `/tmp/m14-s1bbqjlr/REPORT.md`。14保持claimed，验收框不勾，不自行resolve；10尚未主合，后续关系变更须推进task revision并同锁清不适用pending。无install/build/服务启停/真实key/provider/commitpush；仅复用健康30142与Git树外短tmp隔离数据。平台风险按报告列明。
