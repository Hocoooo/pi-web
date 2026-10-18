# 06: 手动编写、确认和恢复共享重点

**What to build:** 用户可以在任务详情手动编写目标、已做决定、完成情况和下一步，确认后发布共享重点，并查看、比较或恢复先前确认的版本；不需要先接入 AI 整理。

**Blocked by:** 01（建立能保存任务的基础看板）。

**Status:** resolved

## Acceptance criteria

- [x] 任务详情提供共享重点编辑、预览、确认和取消流程；内容可覆盖目标、决定、完成情况和下一步，区别于任务原始说明与完整聊天历史。
- [x] 编辑和取消不替换已确认版本；用户确认才创建新的当前版本，手动编写清楚标记为用户提供而非伪造 AI 来源。
- [x] 确认后的版本保留内容、版本身份、确认时间和真实来源信息；可查看历史，不能用编辑操作覆盖过去的确认内容。
- [x] 恢复旧内容需要用户确认，并作为新版本发布，历史上的中间版本仍可查看。
- [x] 两个页面基于同一版本同时确认时识别冲突并保留待处理输入，不静默覆盖；重复确认请求不生成重复版本。
- [x] 发布失败、取消或重开页面不破坏当前已确认内容；真实临时存储重开后当前与历史版本均可读。
- [x] 公共操作入口验证任务范围与写入权限；Markdown 沿用现有安全渲染，不因内容中的路径或指令读文件、调用工具或改变任务状态。
- [x] 当前只发布任务知识，不主动把新版本写进所有对话，不发模型请求；后续消费以明确版本读取，不靠共享可变字符串。
- [x] 测试通过公共操作及浏览器验证手动编辑、取消、确认、历史、恢复、双页面冲突和失败保存，使用临时数据，不访问真实聊天或付费模型。
- [x] 同步任务看板的共享重点合同，记录版本、恢复与错误规则；为 07 的 AI 草稿保留同一审核入口，不新增第二套发布逻辑。

## Scope and handoff

这是独立可用的人工交接流程，不依赖对话关联或摘要生成。07 提供真实对话来源和模型信息；人工内容不得伪造这些字段。08、09 将分别让新对话和已有对话使用确认版本。

本票据不实现自动总结、全量历史同步、语义搜索或云端 memory 服务。发布不能被描述成“模型已采用”，两者由后续接入明确区分。

## Spec coverage

用户故事：US34、US48、US49、US50、US54、US55、US60、US61、US62、US63、US65。
访谈选择：Q03、Q22、Q29。
实现决策：D1、D2、D8、D10。
验收计划：T01、T16、T17、T21、T22、T23；实际模型采用版本由 08、09 验收。

## Comments

2026-10-09（父代理验收）：06已语义集成主工作区；独立review无新增P1/P2，
真实store/API11/11、06浏览器8/8及两份错误草稿共存/迁移兼容等额外检查通过。
聊天SSR阻断经独立诊断fresh browser与server两侧三轮复现，按仓库规则备份.next后仅恢复
30142隔离dev，产品/依赖1184文件hash不变；原loop三轮green，06两轮8/8、01drafts两轮12/12、
03retry6/6、02details8/8全部通过。恢复证据 `/tmp/pi-web-ticket06-dev-recovery-ok47x43_/REPORT.md`；
主集成全套2670pass/0fail/4Windows skip、tsc/lint保持成立，故现标resolved。未将纯隔离通过当主验收。
旧.next保留 `/tmp/pi-web-ticket06-next-backup-dt86trq7/.next`，新dev14934/14937；
30141生产未动。已证明无源码改动的dev状态恢复消除阻断，未进一步归因旧进程与磁盘缓存的贡献。
平台/生产分发等既有缺口保留；04、13仍须独立集成验收，本票据不代表它们完成。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

2026-10-09：并发槽 3 在独立 detached worktree `ticket06` 领取，仅实施 06。01 resolved；冻结 01/02/03 基线不依赖另外工作区未完成行为。保留 claimed 与所有父验收复选框；交付相对冻结 baseline 的增量，待父单写入集成与独立 review。

2026-10-09 实施交付：人工四节编辑/被动安全 Markdown 预览/确认取消、不可变版本与 current pointer、历史查看/逐字段比较、确认恢复为新版本。真实 manual/restore 来源；独立 currentVersionId CAS，版本内精确 receipt；不推进 task/order revision，不破坏创建指纹/03移动 receipt。复用原 board.json v2 同锁迁移，未接入模型/session/文件读取或主动注入；07复用同审核与发布入口。

证据与包含新增文件的冻结 baseline 增量：`/tmp/pi-web-ticket06-evidence/REPORT.md`、`ticket06.patch`、`delta-manifest.json`。最终真实临时 store/API/迁移/跨进程并发/receipt/restore/POSIX失败恢复定向52/52，全套2674 tests /2670 pass /0 fail /4 Windows-only skip，tsc/lint退出0；06 fixture 浏览器8/8两次确认（含两页发布/恢复冲突、失败/丢响应精确重试、重开、键盘与390px触摸），01/02/03六个任务页面脚本均通过。原symlink dev两次panic、首次连接失败、fixture原生details等待失败保留日志；仅测试临时配置两种root为`/`后独立本树30144运行，结束恢复配置且仅停止本次82663/82665。主服务/共享依赖未改，未commit/push。

平台缺口：Windows/ACL、Safari/iOS16.2真机/软件键盘、最低Node、生产打包、断电/NFS、真实provider未运行，skip不当pass。保持claimed、全部验收框未勾；开发完成等待父单写入集成和独立review，不自行resolved。

2026-10-09 主集成恢复：仅按06冻结增量集成，保留主01–03 resolved/验收评论与03 retryMove/reload/六场景browser；04/13树未写入或集成。完整主before快照/hash、含新增文件的主增量/manifest、冲突说明和逐命令fresh证据在 `/tmp/pi-web-ticket06-integration-ovsgdjnc/REPORT.md`。主focused52/52，全套2674tests/2670pass/0fail/4Windows skip，tsc/lint0；主30142原唯一offline临时dev上06browser两轮8/8，03retry-reload6/6、order10/10、02编辑8/8、创建取消三语言3/3、基础看板通过。01草稿/history/慢导航脚本两轮各12场景在最终零pageerror断言失败，聊天SSR报 `Cannot read properties of undefined (reading 'source')`（未改MermaidBlock/react-syntax-highlighter导入栈）；日志/results/截图保留，故障来源未确定，不称既有基线问题或集成全通过。未改聊天代码/依赖/服务或断言，等待父评估与独立review。仍claimed、父验收未勾；不推进其他票据。
