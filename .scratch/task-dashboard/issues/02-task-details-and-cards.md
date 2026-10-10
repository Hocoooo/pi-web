# 02: 编辑任务资料与完善卡片

**What to build:** 用户可以在任务详情修改标题、说明、完成要求、优先级和标签，卡片同步显示最新资料及更新时间，保存后重开仍正确。

**Blocked by:** 01（建立能保存任务的基础看板）。

**Status:** resolved

## Acceptance criteria

- [x] 任务详情支持编辑标题、详细说明、完成要求、优先级和标签；保存后看板与详情读取同一份持久记录。
- [x] 卡片显示标题、优先级、标签、项目和最近更新时间；无项目有明确显示，不暴露保留工作区内部路径。
- [x] 优先级采用明确、有序且可稳定比较的值，记录默认与同值处理规则；后续自动排序可复用，不能只保存颜色或展示文案。
- [x] 取消编辑不修改已保存内容；非法值有反馈；保存失败保留可重试的输入，不假报已保存。
- [x] 两页面编辑同一任务时拒绝静默覆盖，用户能刷新或处理冲突；修改标签等属性不隐式改状态、项目归属或启动 AI。
- [x] 通过公共任务操作入口校验字段和范围，保留现有认证、安全 Markdown 渲染与数据访问约束。
- [x] 刷新、重开存储后属性和更新时间正确；先前由基础看板创建的任务仍可正常显示和编辑。
- [x] 公共操作测试使用真实临时存储；浏览器验证编辑、取消、失败重试和两页面冲突，覆盖键盘及手机表单操作，不使用真实聊天或模型。
- [x] 同步任务看板功能合同与相关测试，说明本票据属性的默认值、更新规则和验证缺口。

## Scope and handoff

依赖 01 的任务身份和持久化规则，不为卡片单独保存另一份任务。对话数量和 AI 工作提示由 04 提供；如果它们尚未实现，不伪造运行数据。完整共享重点内容由 06 提供，筛选及自动排序由 05 消费本票据的字段。

不增加多人负责人、截止时间、工时或自定义卡片字段配置，不改用户已确认的范围。

## Spec coverage

用户故事：US33、US34、US60、US61、US62、US63、US65。
访谈选择：Q29。
实现决策：D2、D3、D4、D10。
验收计划：T01、T09、T17、T21、T23；完整卡片的会话字段由 04 验收。

## Comments

2026-10-09（父代理验收，优先于以下历史实现记录）：02 已通过独立核心 review，
P2 稀疏标签数组和 P3 取消文案已窄修。父代理核对两处生产变更并独立重跑
`lib/task-details.test.mjs` 9/9、三语言 Cancel 浏览器 3/3（零写入/Agent请求）通过；
日志 `/tmp/pi-parent-ticket02-details.log`、`/tmp/pi-parent-ticket02-cancel.log`。
结合独立 reviewer 原 30/30 操作/API/auth及 8/8 编辑浏览器、最终实现全套
2650 pass/0 fail/4 Windows-only skip、tsc/lint与九浏览器证据，当前无未关闭阻断，
现标 resolved、解锁后续依赖。Windows/Safari真机/最低Node/生产打包等仍未验证。
本验收不代表03或其他后续票据实现；所有未提交成果继续保留。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

2026-10-09：唯一 worker 核对 01 已 resolved 后领取 02；只实施资料编辑和卡片，不推进 03。
本轮前完整未提交成果快照 `/tmp/pi-web-ticket02-ku39rmd2/before`（57 文件及 manifest/tracked patch）。
复用 30142 现有隔离源码 dev，30141 生产不动；不 build/重启/安装/真实任务、session 或 provider/
commit/push。实现完成后仍保留 claimed、父验收勾选为空，等待父代理独立 review。

2026-10-09（worker 实施结果，不是父验收）：扩展同一 taskOperation 的 strict revision edit，
保存标题/说明/要求/priority/labels；不改项目、列、原创建身份，不启动 AI。priority 固定
0低/1普通默认/2高/3紧急，比较器降序；同值创建时间升序、UUID code-point升序，02不启用
自动排序。标签默认[]，20项/每项50字符单行，trim+区分大小写去重保留首次顺序。卡片显示
属性/明确无项目/ISO最近更新时间；取消不写，非法/失败/冲突输入保留，显式刷新后取消重开
可采用新记录。草稿放dashboard页面内存，跨列重挂载仍保留原base revision，不静默重基。
既有v1缺字段补默认，第一次编辑前补原创建指纹；编辑后原create重试返回当前同任务。

fresh focused **166/166**、焦点键盘 **27/27**；full **2653 tests / 2649 pass / 0 fail /
4 Windows-only skip**；tsc/lint退出0（增量文件仅/tmp）。八浏览器脚本全部通过：02八场景、
01看板create-retry、草稿十二场景（history+慢导航）、项目、无项目、侧栏Git/非Git、键盘。
02浏览器覆盖编辑、键盘全字段、取消、非法、失败重试、两个页面冲突、响应丢失后严格冲突、
外部移列后草稿保留、390px触摸保存；全API fixture+真实临时store，零Agent请求。
初轮tsc和三轮早期浏览器失败（可访问名称/键盘选择、textarea label、about:blank fixture）
均保留，不用最终pass抹去。完整日志/命令/时间/报告、增量含新文件patch在上述目录。

尚待父独立review/验收，故仍claimed、验收框不勾选；未推进03。Windows/Safari16.2真机/
软件键盘、最低Node实机、生产打包、断电/网络文件系统、真实provider未执行。草稿不跨刷新
持久化；响应丢失的已提交edit不能直接旧revision重复提交，需刷新确认再显式处理。
源码安全边界、01resolved票据、AGENTS和所有继承未提交成果均保留。

2026-10-09（独立 review 后授权窄修）：reviewer 核心通过（原窄30/30、02 browser8/8），
仅修 P2 公共JS入口稀疏labels跳槽及继承P3创建Cancel裸key。先新增有效红测：Array(1)
未拒绝、三语言找不到实际取消按钮；再将校验改为Array.from逐槽检查，创建Cancel复用
sidebar.cancel。新真实store测试覆盖全空/前中后空槽，invalid-input且文件字节/revision/
时间不变、fresh-process重读正常；新浏览器在en/zh-CN/zh-TW填表取消，确认真实文案、
无任务写入/Agent请求、刷新无新增。未改既有编辑规则/存储/create身份/草稿/排序规则。

本轮证据 `/tmp/pi-web-ticket02-review-fixes-y4r0gc02`：开始60文件完整快照，fresh focused
167/167、键盘焦点27/27，全套2654 tests / 2650 pass / 0 fail / 4 Windows-only skip，
tsc/lint0；九浏览器脚本均通过，含新增三语言3/3、02编辑8/8、01草稿12/12/create-retry
及项目/无项目/侧栏Git+非Git/键盘。红测、全部日志、命令时间退出码、增量含新文件patch和
REPORT均独立保存，不复用前轮退出码。仍claimed、不勾父验收、不推进03，等待父复核。
唯一写入、复用30142/PID21044，30141不动；无Next/build/重启/安装/真实数据或provider/
commit/push。既有未提交成果完整保留，原平台/断电/生产打包验证缺口仍未执行。
