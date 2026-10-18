# 07: 选资料，让 AI 整理共享重点

**What to build:** 用户主动选择任务内的对话和工具结果，预览删减并确认模型后，生成可编辑的共享重点草稿；只有经用户确认才发布为共享版本，来源对话不受干扰。

**Blocked by:** 04（把已有对话归入任务）、06（手动编写、确认和恢复共享重点）。

**Status:** resolved

## Acceptance criteria

- [x] 从任务或关联聊天主动点击才进入整理流程；聊天入口默认选中当前对话，用户可改选其他同任务对话。浏览、运行结束、切换页面或查历史不会自动调用模型。
- [x] 默认收集用户选中对话明确分支的已完成文字交流，工具结果必须额外勾选；不包括未选对话、隐藏分支、流式半条输出、系统提示、raw thinking 或 scratchpad。
- [x] 发送前展示可预览和删减的资料，用户能区分工具结果与普通文字；工具结果已经包含的文件文字不得伪称为“没有文件内容”。
- [x] 不因路径、链接或附件引用自动读取文件全文、下载链接或读取附件；服务端再次验证任务和来源范围，不能靠客户端传入任意 sessionId 绕过检查。
- [x] 聊天入口默认当前对话模型，看板入口默认全局模型；发送前显示并允许临时替换，不更改原对话和全局设置。指定模型不可用时明确失败，不偷换模型或 provider。
- [x] 预览确认后锁定实际输入和模型，新增消息不自动扩充输入；超限要求缩减或明确展示处理，不静默截掉关键限制。显式提示资料发送对象和可能的费用，不承诺完全自动脱敏。
- [x] 使用独立、无工具的辅助模型调用，来源对话不接收普通 prompt、工具调用或额外历史消息，模型、权限、队列和运行过程保持不变。
- [x] 生成目标、决定、完成情况和下一步的可编辑草稿，记录真实来源、分支与模型信息；复用 06 的确认流程，取消或失败不替换当前确认版本。
- [x] 切换任务、来源关系变化或返回过期结果时不能把草稿发布到错误任务；重复操作、超时和失败有反馈，不自行无限重试计费。
- [x] 用可捕获请求的模拟模型验证实际发送文本、模型选择与无工具策略，结合真实临时 SDK 历史检查来源隔离；浏览器验证选择、删减、生成、修改、取消和确认的完整流程。
- [x] 将生成内容中的恶意指令作为资料处理，不能因此修改任务状态、扩大读取范围或跳过用户确认；覆盖未授权和跨项目请求的拒绝。
- [x] 同步共享重点与辅助模型调用相关合同，报告真实 provider 的费用、取消和网络行为尚未验证的部分；默认测试不调用付费模型、不使用真实资料。

## Scope and handoff

依赖 04 的合法对话集合与 06 的版本发布。无需等待“从任务启动 AI”的 08；人工关联旧对话即可完整演示本票据。对话为休眠状态也不能仅为收集资料而启动其 Agent，所需模型能力按现有资源和可用性规则获得。

不做自动摘要、背景知识抓取或全量消息混流。07 只生成与发布，08、09 负责对话实际采用；不得用“摘要已保存”冒充已注入模型。

## Spec coverage

用户故事：US40、US41、US42、US43、US44、US45、US46、US47、US48、US49、US54、US55、US62、US64、US65。
访谈选择：Q03、Q11、Q21、Q30、Q31。
实现决策：D7、D8、D10、D11。
验收计划：T13、T14、T15、T16、T22、T23。

## Comments

2026-10-09（父验收）：07主集成独立review已关闭auth dispatch时点、context_edit失效和warm nullleaf三项，
另验证公开SDK鉴权/选项等价。新增快失败未处理Promise P2经唯一主写入者窄修，父核对生产仅及时局部
观察原rejected Promise，错误仍传caller；独立重跑默认Node子进程3/3通过，无全局忽略器、失败provider0次，
日志 `/tmp/pi-parent-ticket07-rejection.log`。结合最终full2719pass/0fail/4skip、101focused、tsc/lint、
07两轮11/11及05/06/04联合回归，当前无未关闭阻断，按07范围验收resolved。
完整最终证据 `/tmp/f07-1YiNtC/REPORT.md`；原review首次fatal/browser失败保留，不抹去。
08/11尚未主集成，真实provider费用/取消/网络与既有平台缺口未验证；fake/SDK验收不冒充外部行为。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

2026-10-09 slot2领取07：冻结baseline+HEAD，唯一源码树ticket07；04/06已resolved。只实施主动整理和06确认发布，不开启08、不嵌套Agent、不改共享依赖。测试显式fake模型及Git树外临时SDK资料，交付独立增量/证据，保持claimed待主集成和父验收。

2026-10-09 实施和中断后交付核对：独立taskOperation summary-options/source/generate/cancel、明确branch/完成文字/工具opt-in/删减预览/临时模型、独立SDK completeSimple无tools/零自动重试、服务器provenance及06确认发布已实施。真实临时SDK树、warm AgentSession隔离与SDK faux捕获实际请求；fake显式注入，未调用真实provider。原配置最终完整full2为2706tests/2702pass/0fail/4Windows skip，focused2为84/84，日志均有结束统计与独立exit=0，不引用中断旧exit或旧失败为通过。旧14浏览器脚本均exit0；恢复后对最终源码重验07两轮11/11、06八场景和04七场景，tsc/lint/diff-check退出0。07 dev30144仅自身进程已停止，临时dual-root恢复原hash；package/依赖/AGENTS无07增量。源码未合05或11，父需基于冻结baseline+HEAD逐hunk语义集成。

完整源交付（不是主green）：`/tmp/p07-EtZ11U/REPORT.md`、`ticket07.patch`、`ticket07-manifest.json`、`SHA256SUMS`；恢复证据`/tmp/r07-ZTaNdq/`。专属精简合同`docs/branch-features/task-ai-summary.md`。保留失败历史：offline全套触发旧plugin mock四失败、测试网络guard最初误判loopback proxy、取消短deadline/服务prepare前mutation测试时序及早期浏览器fixture问题，均详列报告。真实provider费用/取消/质量/网络、Windows/Safari真机/最低Node/生产打包与耐久性未验。保持claimed，父acceptance全部不勾、不resolved。

2026-10-09 主07接管：主beforehash `/tmp/m07-zsEOPj/beforehash.json`；核验源patch SHA256 `4e858c8c921e52455972d624bd4b945aaf95f0da4b56d77f0c8c9eb37c36a02b`，逐hunk合05而非整文件覆盖。主保护01/02/03/04/05/06/13 resolved及全部域CAS/receipt，08/11仍别树未集成。父转独立源review三阻断后授权只在主修：SDK公开getAuth先解析鉴权，最后board锁内同步Provider.streamSimple dispatch；后追加同branch context_edit使预览语义失效，普通append不扩input；warm clone显式保留nullleaf。真实SDK/faux新增red三项失败→green，auth失效provider0、生成后edit/nullleaf publish0，未冒充真实provider验证。主fresh最终full2720tests/2716pass/0fail/4Windows skip，任务/SDK扩大focused98/98（07+联合/窄修14/14），tsc/lint0且无lint警告；17浏览器脚本均exit0，07summary11/05联合2/06context8/04sessions7/05views11/13cols7/02details8/03order10+retry6/01draft12及必要导航。完整失败历史、逐命令env/时间/log/exit、主增量含新增patch/hash及冲突说明在 `/tmp/m07-zsEOPj/REPORT.md`。无源树写入、服务/依赖/nextbuild/安装/commitpush或真实用户资料/凭据/provider网络；平台/费用缺口仍保留。07主保持claimed，验收框不勾，待独立主复审/父验收。

2026-10-09 主复审后局部P2：父确认原三阻断及公开SDK鉴权/选项等价已关闭；新增g.promise在异步解锁前快速reject造成默认Node退出1，review首次fatal/browser失败 `/tmp/rm07-fHPYhO/` 原样保留（浏览器重跑green不消除）。仅主在创建后立即附加局部rejection观察，保留原rejected Promise向caller传播、failed状态/精确旧ID拒绝和准入finally；不全局忽略、不改原三修复/05/06/其他域。新增默认Node子进程/callertrycatch真实SDK/faux红→绿三类回归，实际provider0/未发布/新ID准入正常，原fatal脚本重验caller捕获exit0。主fresh full2723tests/2719pass/0fail/4Windows skip、focused101/101、07及联合17/17、tsc/lint0无警告；07browser两轮各11/11、05views11/06context8/04sessions7/07联合2均exit0。before/afterhash、局部增量含新测试patch/hash、命令/env/时间/log/exit与失败证据 `/tmp/f07-1YiNtC/REPORT.md`。无源码其他域/源树/08/11/服务动作/真实用户资料或provider。保持07claimed、不勾，待本P2独立复核/父验收；既有平台/费用缺口不扩大。
