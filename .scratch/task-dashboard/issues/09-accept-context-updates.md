# 09: 让已有对话接收共享更新

**What to build:** 已有任务对话能看到共享重点更新提醒，用户选择接收后明确知道当前和下次采用的版本；正在工作的对话不会被打断或自动继续。

**Blocked by:** 08（从任务开始新对话或继续旧对话）。

**Status:** resolved

## Acceptance criteria

- [x] 任务发布新确认版本后，已有对话显示更新提醒；未点击接收时仍保持原版本，不因刷新、重连或切换页面自动追新。
- [x] 用户接收一个明确版本，界面区分已采用版本和待采用版本，展示对应来源；无确认版本时不伪造更新。
- [x] 对话运行中接收只登记意图，显示“下次使用新版本”；不发 steer、follow-up，不停止、重启当前运行，不触发新的模型请求。
- [x] 等当前工作及其已有队列结束，再在下一次用户实际发送时使用待采用版本；低层结束事件、自动重试或队列续跑不能提前应用。
- [x] 之后发布了更晚版本，不自动替换用户已经选择的待采用版本；界面仍可提醒另有更新，需用户另选。
- [x] 以实际发送结果登记采用记录。准备或发送被拒绝不能被显示为模型已使用；失败后重试不重复插入同一共享内容。
- [x] 共享版本和待采用选择跨页面重开保持一致，多标签页竞争有明确结果，不静默覆盖其他用户操作；过期 task/session 关系必须重新校验。
- [x] 原始历史与审计保留，新的共享资料有版本及来源，不混入另一分支消息；压缩、分支切换后版本与有效上下文仍可解释，不随意改写其他扩展消息。
- [x] 普通、Chat-only 与模型变化场景保持原权限、精确系统提示和有效工具配对，更新不成为 system prompt 覆盖或权限扩大手段。
- [x] 用真实临时 SDK 会话、可控运行/排队事件和模拟模型验证请求实际使用的版本；浏览器验证提醒、主动接收、忙碌时待采用、刷新及发送失败，默认不调用付费模型。
- [x] 同步共享更新、会话生命周期与分支相关合同，记录 SDK 版本验证和未测场景。

## Scope and handoff

08 已带来合法任务对话与实际版本投递，06 通过 08 间接提供版本存储，因此不重复列间接依赖。手动编辑发布版本即可测试本票据，不需要等待 07 的 AI 整理。

10 将在解除/改绑时清除不再适用的待采用引用；本票据必须提供通过统一操作入口管理这些状态的明确语义，不能只在组件内存中保存等待标记。未来票据接入时不得另写直接注入消息的后门。

## Spec coverage

用户故事：US49、US51、US52、US53、US55、US60、US61、US62、US64、US65。
访谈选择：Q12、Q23。
实现决策：D2、D5、D9、D10。
验收计划：T17、T18、T19、T20、T21、T22、T23。

## Comments

2026-10-09（父验收）：09主v6语义集成及12/08/11联合通过独立复审，R1/R2已由reviewer重放关闭。
R3转换后缺正文却误记成功经主窄修；父核对entry身份+request-local引用+stream边界完整material三条件，
不重填扩展脱敏文本，并独立重跑转换9项及原R1/R2六项共15/15通过，日志 `/tmp/pi-parent-ticket09-review.log`。
结合最终119SDK联合、full2839pass/0fail/4Windows skip、tsc/lint及22关键browser通过，当前无未关闭阻断，
按09范围验收resolved。最终报告 `/tmp/m9f-x4GgSR/REPORT.md`；真实Provider wire/理解等不扩大声明。
10现解锁；14源review已通过但仍待主集成，不能继承09验收。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

2026-10-10：08已父验收resolved后领取09。唯一源码树 `/tmp/pi-web-parallel-0912-8c00mma6/ticket09`，冻结同级136文件baseline及HEAD85cc4f3；固定gpt-6.1-sol/high，无嵌套agent。证据与恢复说明 `/tmp/t09-YrB2ft`。只实现显式pending与原prompt接缝；12归档守卫交点交父集成，不写12/10。保持claimed且不勾父验收。

恢复续作（原调用被abort，非只缺报告）：先核验落盘代码/原恢复记录/18旧浏览器log-exit配对/残留PID，确认原dev已无监听、config/AGENTS原字节已还原；补LAN UUID/ref warning/选择ID冲突及并发观察窄修，真实fresh SDK进程捕获pending原版本。最新证据 `/tmp/r09-41vNMy/REPORT.md` 和本树 `RECOVERY09.md`：SDK13/13、focused167/167、full2802tests/2798pass/0fail/4Windows skip、tsc/lint0无warning、09浏览器9场景/6actual fake Provider请求、18fresh必要回归全部exit0。恢复full-first8失败为harness目录遗漏/loopback proxy lookup guard误拒，原失败日志保留，修正harness后真实rerun通过；不伪旧pass或删失败。

自己30143 listener58598/CLI58571已按cwd核实停止，端口空；临时config和AGENTS恢复原字节，增量不带双root。无真实provider/用户资料/keys、外网TCP、安装/build/commitpush或共享依赖写入。用户同步12已父验收/14独立开发，09仍按原冻结基线不合别树。交付含v6 additive migration、10公共CAS clear、pending/admission/authority/complete接口与12父联合guard冲突清单；精确patch含新文件/hash见REPORT。源独立通过不是主集成/独立review或父验收，保持claimed且所有checkbox留空。

2026-10-10主恢复：前主writer两次upstream_error停止；唯一主writer01a121cc-42e5-74b5-882f-3af18233a629固定gpt-6.1-sol/high。先核验无旧09测试进程、1236主before快照/hash与只读源40after hash完整；旧main全绿并未覆盖独立R1/R2，实际代码仍有阻断，未把旧exit当修复通过。新 `/tmp/m9r-qF38ce` 真实SDK六探针先red后green：首V1receipt零append→V2authfail→Continue不得V2→V1；同版A/B的context_edit删除/替换、retain-nonecompaction/nullleaf/context-handler排除时V2确实通过A/其它entry入实际Provider，但B不能伪projected/delivery或清pending，新同版C可凭自己的entry成功。窄修按合法active native lineage、SDKsourceEntry.id及post-context公共convertToLlm→stream request-localtextarray引用，不改正文/JSONL/provider字段或12gate。
主freshSDK联合110pass、跨域focused181pass，两轮full2834tests/2830pass/0fail/4Windowsskip、tsc/lint0、22浏览器全exit0（09两轮各9场景/6fake Provider及12/08/11全部关键旧回归）。精确main相对 `/tmp/m09-Odiq3z/beforehash.json` 增量含新/hash、hunk决定、失败历史与恢复checkpoint见新REPORT；旧main REPORT仅指针。只复用30142健康14937，无服务/build/install/真实资料keys/付费provider/commitpush；14别树不写/不合。09仍claimed、checkbox全部空，交独立主复审与父验收后再解锁10；Windows/真机Safari/真实provider wire及耐久等仍未验。

2026-10-10独立主 `/tmp/m9iv-b706/REPORT.md` 已关闭R1/R2，但新增R3P2：converter保留array引用且原地脱敏/截断时SDK stream和fake Provider没有完整V2却伪success/清pending。父授权主唯一writer窄修：保留entry/reference身份，同时转换后和stream实际input边界校验同贡献完整锁定material，不从A同文代B、不冻结/重填扩展脱敏文字。主仅send模块+新转换回归及合同/恢复状态；schema/12gate/其它域不改，14源review关闭但未主合，不访问。
新证据 `/tmp/m9f-x4GgSR/REPORT.md`：保留原review断言重放2pass/2red→4pass；新真实SDK9转换探针4red/5pass→9pass（redact/truncate、getApiKey晚删减保pending/零delivery/SDK+Provider无V2，明确retry同nativeentry一次；pass/concat/wrap/split全文及clone丢identity边界）。Fresh默认SDK/六R1R2/09×12+08/11联合119pass、full2843tests/2839pass/0fail/4skip、tsc/lint0、22关键browserexit0，09两轮各9/6fake、archive6。前轮110与browsergreen不算R3覆盖。精确R3increment与累计main原beforehashpatch/hash、新captures/checkpoint及失败日志另附；无服务/build/install/真实provider或用户资料/commitpush。保持claimed/checkbox空、10仍blocked，交父复核不擅resolve。
