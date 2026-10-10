# 01: 建立能保存任务的基础看板

**What to build:** 用户可以进入独立看板，创建属于一个项目或无项目的任务，填写标题、说明和完成要求，在默认五列中通过菜单改变状态；刷新、重启后记录仍在，原聊天入口保持不变。

**Blocked by:** None (can start immediately).

**Status:** resolved

## Acceptance criteria

- [x] 独立看板与原聊天页面可切换，不改原首页、历史会话或显式导航的优先级，不引入并排布局。
- [x] 创建任务时保存标题、说明、完成要求及项目身份；一个任务最多一个项目，也可无项目。项目身份复用现有服务端规则，不用标题或目录 basename 作键。
- [x] 默认按待办、进行中、待检查、受阻、已完成排列，所有项目和无项目任务共用；列使用稳定身份，只有一个完成列。
- [x] 本票据提供菜单改状态和基础详情，用户选择移入完成列才表示完成；浏览、创建、保存、移列均不启动 AI，不注册让 Agent 改任务状态的工具。
- [x] 创建、读取和改状态通过一个统一任务操作入口，页面与后台遵循相同校验；任务不依赖浏览器内存，也不把 session 内 todo 当任务数据库。
- [x] 首次选择存储方案前验证最低运行环境、生产分发和许可约束；采用真实临时存储验证初始化、重复打开、重启、版本迁移入口及失败恢复，记录选型依据。SQLite 等仅为候选，不默认已经选定。
- [x] 并发创建或修改有明确冲突/幂等处理；失败不伪装成功，不出现半条任务；另一页面刷新或断线重连后能读取已保存状态。
- [x] 新请求沿用现有 Web 认证、项目验证和安全渲染；任意 ID、文本内路径不能扩大文件访问范围。
- [x] 看板基本读取不启动休眠 Agent，不扫描所有对话正文；任务记录与原生 session 历史分开，不修改真实会话。
- [x] 从公共操作入口和真实浏览器验证创建、菜单移列、重新打开和故障反馈；基础操作可键盘访问且适合小屏。使用临时 agent 数据，不调用真实付费模型。
- [x] 新增任务看板功能合同并登记到分支功能索引，准确标明本次只交付基础范围；记录实际测试、平台验证和未验证项。

## Scope and handoff

本票据只交付基础任务闭环，不提前实现后续票据的可选属性、拖拽、关联对话、共享重点、归档和列编辑，也不展示可点击但无作用的占位操作。持久化校验与统一操作入口必须从一开始真实可用，不做演示用内存后端。必要的小范围预备重构在本票据功能改动前完成并保持现有测试通过，不进行无关大重构。

后续票据扩展同一任务操作入口，沿用其身份、错误与并发规则，不各建一套存储。全局安装或真实系统修改测试需独立授权，不能以票据验收条目作为授权。

## Spec coverage

用户故事：US1、US2、US3、US4、US7、US18、US19、US26、US27、US34、US60、US61、US62、US63、US64、US65。
访谈选择：Q01、Q05、Q06、Q07、Q08、Q14、Q17。
实现决策：D1、D2、D3、D4、D10、D11。
验收计划：T01、T05、T09、T10、T17、T21、T22、T23、T24；只声明本票据实际覆盖的子场景，其他部分由后续票据补齐。

## Comments

2026-10-09：已由 worker 开始实施，当前有未提交代码及阶段性测试证据。用户要求暂停全部子代理，调度与 worker 已停止；保留 claimed，不代表仍有活动写入者。独立审查和父代理验收尚未完成，验收勾选保持未完成。

最后一轮完整测试命令在暂停时被中断，旧退出码不能作为当前完整套件通过的证据。新 session 先阅读本功能的暂停交接记录、核对实际 diff 并补跑验证，再继续本票据；不得跳过验收推进依赖票据。完成须附实际验证证据，失败或部分完成不得标记 resolved。

2026-10-09：唯一 worker 按独立审查的两个阻断继续实施，仅票据 01，未启动 02–14。
原未提交代码/文档均保留；开始快照 `/tmp/pi-web-dashboard-resume-j2ccjwwz`。
新增有效红测复现项目/无项目文字+图片看板往返丢失，及目录删除后原 UUID 创建重试
invalid-input。通过既有 parked draft、标签页导航标记与 Link onNavigate 保留/恢复；不创建
session 或发送消息保存，显式 URL/普通新建/项目切换仍优先。任务存储锁内先确认已有 UUID，
保存内部不可变原创建指纹（兼容早期无编辑的 v1），确认不依赖当前目录或项目解析，也不混用
将来可变标题等。新 UUID 仍按当前目录/项目规则校验、不授予文件权限。
真实临时文件/fresh process 测试覆盖移列、cwd 改为不同项目 worktree、删除目录、重开、
同原请求同任务/revision及不同内容冲突；合成未来编辑文件仅测试身份，不实施编辑 API。
独立日志 `/tmp/pi-web-ticket01-fixes-yVWxPr`：后端 focused 23/23，扩大 focused 157/157，
全套 2644 tests / 2640 pass / 0 fail / 4 Windows-only skip，tsc/lint 退出 0。
最终七个浏览器脚本通过（新增草稿+原看板/项目/独立聊天/侧栏 Git 与非 Git/键盘）；键盘首轮
及再次确认会话切换后焦点等待超时，独立重跑、诊断副本和最终完整浏览器运行通过；保留
间歇失败原日志，未擅自扩大产品
修复范围。没有 next build、重启/安装、真实 provider/用户资料、commit/push。
本条只是实现说明，不勾父验收，不改 claimed/resolved；仍须父代理独立审查并处理验证风险。

2026-10-09（复审后追加）：用户确认 P2 已独立验证关闭；本轮仅修 P1 history 离开残留，
P2 操作/存储/校验/测试逐文件哈希验证未改。中断的继续调用此前只有阅读/检查，无修改或
新测试；模型再次核实 `sub2api_access/gpt-6.1-sol/high`，未切换。新证据目录及开始快照：
`/tmp/pi-web-ticket01-history-fxzcewjw`。
先新增有效红测：项目/无项目 `Link tasks → Link chat → back tasks → back 原 chat`，以及
`back tasks → forward chat`，四条均文字空、图片 0。最终采用目标限定 `/tasks` 的 AppShell
layout cleanup，复用原停放回调，在 hook passive 弃用清理前保存；不取消通用清理、不启动
Agent。扩展真实浏览器各路线三轮（还含 forward 离开原 chat 到 tasks），逐轮编辑后验证
最新文字、图片数量 1/字节、cwd、零 Agent 请求及不重复合并，普通 New/picker/显式不同 cwd
仍优先；/new 清理与 parked 隔离的既有 focused 回归保留。无 02 或后续实现。
键盘 line53 已核实是 URL 先更新、composer 尚未挂载时的脚本竞态：350ms 临时 history
fixture 延迟稳定复现 textarea=0、Alt+Right 回退容器，随后 textarea=1 但焦点留容器。
焦点产品代码与 HEAD 相同，诊断路径无 tasks；补脚本等待 composer 可见的前置，不修改
焦点产品行为或放宽断言。相同断言在延迟/等待版本通过，完整脚本本轮及确认均 PASS。
最终 fresh：扩大 focused 158/158、键盘/焦点 focused 27/27；全套 2645 tests / 2641 pass /
0 fail / 4 Windows-only skip；tsc/lint 0；七个浏览器脚本 PASS，新增草稿与键盘再确认 PASS。
红测、未成功的 popstate listener 尝试和键盘诊断失败日志均保留；最终无 history listener
或 override。详细命令/时间/退出码、风险、增量与含全部新增文件的 review patch 见该目录
REPORT.md。仍 claimed、不勾父验收、不擅自 resolved；未 build/重启/安装、未触碰 30141、
未用真实 provider/用户 session/task、未 commit/push。

2026-10-09（第三轮复审后追加）：用户确认原 P1/history 与原 P2/create-idempotency 关闭，
本轮仅修新增的慢路由末次编辑回归，不做 02，不再调查已获确认的键盘等待修复。
先读契约/reviewer 证据并核实指定模型 high；开始快照与 fresh 证据目录：
`/tmp/pi-web-ticket01-late-edits-y1bpqf8u`。真实 Chromium 阻塞 `/tasks` 路由响应，项目/无项目
各验证改字、清文字、删图、全部清空；红测八场景均重复或复活旧内容，原四条 history 回归
仍通过。移除 SessionSidebar/AppShell 的 `onNavigateTasks` prop 和 Link eager `onNavigate`；
只保留真正目标 `/tasks` 的 layout departure 停放最终草稿，未改通用 rekey 合并/弃用清理，
没有跳过最后编辑保存。DOM/tab-memory 时间线核验：阻塞期间仍在 `/` 且可编辑，无停放
标记；真正离开后登记，返回精确等于最后编辑/删除状态。
最终主跑与独立确认各 12/12 草稿浏览器场景通过（四条原 history + 八条慢导航，各继续
三轮往返、图片数量/字节/cwd/零 Agent 请求和 New/picker/显式 URL 优先）。扩大 focused
158/158、焦点/键盘 27/27，全套 2645 tests / 2641 pass / 0 fail / 4 Windows-only skip，
tsc/lint 0；七个浏览器脚本及草稿/键盘再次确认 PASS。原关闭存储修复与键盘代码哈希未变。
日志/报告/增量及含所有新增文件的完整 review patch 见上述目录；全部原未提交成果保留。
本条只追加实现说明，claimed/父验收不改；无服务动作/真实数据/provider/build/安装/commit。

2026-10-09（父代理最终验收）：已核对实际源码、fresh 验证及独立 reviewer 的多轮复审。
原创建幂等、history 丢草稿和慢导航重复合并三项发现均已关闭，最后一轮无可复现阻断。
独立 Chromium 证据 `/tmp/pi-web-task-drafts-QZpPmY/results.json`：八种慢导航和四种 history
场景通过，另有 15/15 定向测试通过；实现者最终证据见上方 late-edits REPORT（2641 pass、
0 fail、4 Windows-only skip，tsc/lint 和七浏览器通过）。父代理确认键盘等待修正保留原断言。
本票据基础范围验收通过，现标 resolved 并解锁依赖；不代表后续 02–14 已实现。
选型的最低运行环境/分发/许可约束已检查，最低 Node 实机、生产打包、Windows/Safari 真机、
断电/网络文件系统仍未执行；草稿仍为页面内存。这些明确的平台边界不宣称通过。
以上历史评论中的“用户确认”实际指独立 reviewer 报告与父代理调度确认，并非用户新发验收指令。
