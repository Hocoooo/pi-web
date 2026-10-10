# 10: 解除关联或把对话改到另一任务

**What to build:** 用户能在对话停止工作后解除任务关系或改到另一个同范围任务，清楚知道旧历史不会被清除，也不会在下次发送时误用旧任务的待接收共享版本。

**Blocked by:** 09（让已有对话接收共享更新）。

**Status:** resolved

## Acceptance criteria

- [x] 在对话或任务详情提供解除、改绑的明确操作；确认前展示来源和目标以及“旧任务内容仍在历史中”的提示，建议需要隔离时新建对话。
- [x] 对话运行、排队、正在压缩或其他现有忙碌状态下拒绝变更；服务端在实际操作时重查，不能仅根据页面旧提示放行。
- [x] 改绑目标符合任务/对话项目范围，不能跨项目或将无项目聊天挂到项目任务；不改变工作目录、模型、工具或原始历史。
- [x] 更新任务关系和不再适用的待采用共享引用作为一致操作完成；失败保留原有关系，不出现同时属于两个任务或关系已改而旧更新仍待投递的状态。
- [x] 解除后不再读取旧任务新版本；改绑后仅提示目标任务的可用版本，不把旧任务待更新内容自动送出。已经进入聊天的旧文字保留并如实说明。
- [x] 正在途中的旧任务更新回调重新验证关系，不能在改绑后补写旧版本；已关联列表、数量和运行提示最终同步。
- [x] 同时启动、关联或两页面改绑有确定性冲突反馈，重复请求不产生重复关系；在归档能力已经接入时也不能通过改绑绕过其运行规则。
- [x] 用真实临时会话和模拟模型验证运行中拒绝、停止后成功、跨项目拒绝、待采用清理、旧回调到达和下一次实际发送的内容；浏览器验证提示、取消、成功及错误恢复。
- [x] 更新关联、共享更新和会话相关合同与测试，明确“改绑不等于遗忘”；不访问真实历史或使用真实付费模型。

## Scope and handoff

之所以依赖 09，是为了能完整验收旧待采用版本的清理，而不是先做只能改一个 taskId 的不完整功能。04 的合法关联能力已由依赖链提供，不重复列出。

不实现迁移对话正文、自动脱敏、跨项目任务或强制重写上下文。若归档等独立分支先落地，沿用其统一操作规则，不增加绕行写入。

## Spec coverage

用户故事：US6、US10、US12、US14、US15、US52、US53、US61、US62、US64、US65。
访谈选择：Q02、Q24、Q25。
实现决策：D1、D2、D5、D9、D10。
验收计划：T02、T03、T17、T19、T22、T23。

## Comments

2026-10-09 父验收：最终主树独立复审 `/tmp/t10mr-mus4_2wp/REPORT.md` 通过，原两项损坏数据 P2 均关闭，无新的具体阻断。独立实际运行75项风险回归+2项早期迁移，全部通过；3次浏览器运行22场景通过，1263/1263文件hash一致。实现方最终全套2901项/2897通过/0失败/4 Windows跳过、joint266/266、tsc/lint退出0；与独立执行分列，不跨轮累计。接受同锁改绑/clear、owner+epoch ABA、10×14、历史receipt事实边界及真实临时SDK/fake-provider验证，全部验收项勾选，状态resolved。未验证真实provider/Windows/iOS/生产构建，不声称改绑能遗忘旧历史；全任务文档整理与最终综合核验仍待收尾。以下历史Comments完整保留。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

2026-10-09 主语义集成领取：01–09/11/12/13/14均已父验收resolved。唯一主writer，gpt-6.1-sol/high；before快照/hash在 `/tmp/t10main-_q_3satd/`。只读10源及已核对implementation.patch，逐hunk保留主14响应派生digest/内部receipt及全部v6域，组合v7关系epoch。源green不当主green；本票保持claimed，验收复选框由父代理处理。

主已完成v6+14→v7语义集成：source52afterhash/158baseline及两patchhash核对；主1226文件before快照；保留14columnRemovalReceipt/validator与响应派生digest（不持久）、全部09/12/08/11/07/05域。新27关系SDK与主6项10×14、真实全域migration/ABA/oldcallback/archivedowner/receipt只确认不重bind/清新pending联合通过。真实v6→v7 migration发现08selection JSON插入顺序导致误冲突，固定字段canonical窄修后复验；旧schema断言及新增fixture两次错误均保留红日志。
主fresh：joint256/256，full2891项/2887pass/0fail/4Windows skip，tsc/lint0；25初始browser运行全exit0（10/09各两轮及全部任务/导航），canonical修复后08/11/14/07另4次确认全exit0。数据/HOME/TMPDIR/agent/log为新短Git树外/tmp、无aliases/socketguard/fakeprovider，复用健康30142，无服务/配置/build/install/commitpush或真实历史/key/provider。精确主before→afterpatch/hash、冲突/schema决定、配对fresh结果及未验平台见 `/tmp/t10main-_q_3satd/REPORT.md`。仍待独立主复审及父验收，不勾Acceptance。

父转交源review `/tmp/t10iv-z9ep0mlr/REPORT.md` 两项P2并授权仅主窄修：R1copyreceipt未来epoch未拒读，R2不一致legacy非零epoch首读迁移覆盖成下一次不可读v7。它们为刻意损坏数据，不是已证实正常用户ABA漏洞；源167+3正常racegreen不代主复审。主 `/tmp/t10fix-l8beyj3o` 冻结1262文件，原diagnostic复现两缺口，新10探针修前7red/3pass。decode现在完整hydratedtarget写前统一start/choice/copy跨epoch校验，copy允许旧epoch<=authority、未来拒；legacy无关系域不伪造tombstone/不重置坏字段，第一次及两freshprocess重复拒绝bytesstable。合法旧prepared/completed0/1在authority2保留，completed只确认原child不重bind，prepared新执行仍CAS拒；14receipt/digest+09pending/delivery/history/current+08start/11copy/archive/views/order迁移保持，08canonical原字节保护。
最终主fresh：新10/10、原3race3/3、joint266/266、full2901项/2897pass/0fail/4Windows skip、tsc/lint0；11browser全exit0，10/09各两轮及14/11/08/12/07/05关键联合。组合runner240s工具截止导致full-1无exit，不作green；独立full-2与最终full-3真实exit0。精确5文件窄产品delta（含1新测试）、累计主delta/hash、配对日志和平台缺口见新REPORT。源树/PARALLEL未改，服务/build/install/真实provider/commit规则保持；本票仍claimed，等待独立主复审及父验收。
