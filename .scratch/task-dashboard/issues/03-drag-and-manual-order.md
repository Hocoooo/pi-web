# 03: 拖拽移动与手动排序

**What to build:** 用户可以在看板内拖动任务改变列内顺序或任务状态，包括拖入空列；保存失败时得到明确反馈，键盘和菜单也能完成等价操作。

**Blocked by:** 01（建立能保存任务的基础看板）。

**Status:** resolved

## Acceptance criteria

- [x] 列内拖动保存手动顺序，跨列拖动同时保存目标状态和位置，空列可接收任务，刷新及服务重启后顺序不变。
- [x] 移动通过统一任务入口处理，服务端验证任务、目标列与邻居有效性；只移动指定任务，不用可见数组覆盖全量任务。
- [x] 用户移入完成列才改变完成状态；拖动、取消拖动和失败重试均不发模型请求、不自动执行工作。
- [x] 提供键盘或菜单的移动到列、上移和下移等价操作，操作后有可理解的状态反馈；触摸滚动与拖动不互相抢夺。
- [x] 网络失败或服务端拒绝时回滚或重新同步，保留真实保存结果；重复提交不重复移动，多标签页竞争有可见冲突，不能静默覆盖。
- [x] 排序规则具有确定性并能连续插入，不依赖会失去精度的无限浮点切分；任何重排都不丢失或重复任务。
- [x] 拖拽库在采用前验证 React、现有构建和最低 Safari/iOS 支持，并记录许可与固定版本；不混用不同代际 API。不能仅用桌面鼠标成功证明触摸兼容。
- [x] 用临时存储从公共操作入口验证排序与竞争，用浏览器验证跨列、同列、空列、撤销拖动、失败和键盘/移动端；不改真实会话、不调用付费模型。
- [x] 更新任务看板功能合同的操作、排序、错误反馈与平台验收；记录未实测的平台，不把跳过当作通过。

## Scope and handoff

基础菜单继续可用，不以拖拽取代无障碍入口。当前只完成手动排序；05 将增加自动排序和筛选，但本票据的移动接口不能依赖“当前页面就是全量任务”这一假设。

列自定义由 13、14 负责。无需等待标签、对话关联或共享重点；不要为后续筛选提前新建另一套顺序存储。

## Spec coverage

用户故事：US24、US25、US32、US60、US61、US62、US63、US65。
访谈选择：Q04、Q16。
实现决策：D2、D4、D10、D11。
验收计划：T07、T17、T21、T23、T24；筛选后的完整页面组合由 05 补齐。

## Comments

2026-10-09（父代理验收，优先于历史记录）：独立 review 确认存储迁移、权威顺序、
receipt/并发/依赖证据及触摸行为，定向后端29/29与03浏览器10/10通过；唯一P2恢复网络
后隐藏精确重试入口已窄修。父代理检查实际reload闭包及两处UI关系，并独立运行
`e2e/task-dashboard-retry-reload.mjs`，未提交/丢响应×online/focus/手动刷新六场景全通过，
逐字段精确请求与receipt不重复写入已核实（`/tmp/pi-parent-ticket03-retry.log`）。
结合最终完整2659 pass/0 fail/4 Windows skip、tsc/lint和十一浏览器证据，无剩余阻断，
现标resolved。Safari/iOS真机、Windows、最低Node、生产打包/断电等边界仍未验证。
用户已授权最多3并发开发任务；04/06正在隔离worktree实施，不能把本验收当成它们已集成。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

2026-10-09：唯一 worker 已核对 01、02 resolved 后领取 03，模型 gpt-6.1-sol/high。
开始快照 `/tmp/pi-web-ticket03-20261009-173230`；保护全部继承未提交内容。
本轮只实施 03，不自行勾验收或 resolved，不推进 04。先真实核对候选依赖发布资料，
复用 30142 唯一源码 dev；不 build/重启/全局安装/真实数据/provider/commit/push。

2026-10-09 实施交付（仍 claimed，未勾父验收）：

- 核对真实 npm metadata、tarball SHA-512、完整 MIT LICENSE 和发布 ESM；core6.3.1 与
  utilities3.2.2/accessibility3.1.1 固定于 manifest/lock，React19.2.4 满足声明 peer。
  候选 sortable10.0.0 已核对但未采用：核心 draggable/droppable 足够，未混用新代际 API。
  原始 ESM 按 ES2018 解析、Safari16.2 目标语法检查通过；TouchSensor 明确包含 iOS
  非 passive touchmove，激活前移动取消、激活后 preventDefault。不是 Safari 真机/生产打包证明。
- 数组为唯一权威顺序；单任务 before/after 或 start/end 位置意图，服务端同锁验证邻居与
  两种 revision；真实变更状态+顺序联合提交。内部最近精确 moveReceipt 与公共记录分离，
  不再按 revision+1/同列猜重试；逻辑 no-op 只持久 receipt，不改变任务 revision/时间/顺序。
  v1→v2 显式迁移保存 02 属性、原创建指纹和原数组，未虚构 legacy，也无 rank/第二数据库。
- 独立把手、纯展示 overlay、鼠标6px/触摸250ms+5px tolerance；取消不提交。键盘原生
  菜单/上移下移等价；失败重读权威板但保持错误，未知结果可用原 UUID/锚点/revision 精确
  重试；冲突显示及同步，不静默 rebase。02 编辑草稿保持原 base revision，01导航/create保护。
- 真实临时 store 从公共入口测试 160 次插入、隐藏兄弟保留、fresh-process 重开、跨进程
  竞争、lost-response/no-op、非法邻居/可见数组拒绝、并发 v1迁移、POSIX拒写恢复、安全整数
  上限；API 检查 receipt 剥离。所有浏览器 API fixture、独立临时 store、零 Agent 请求。
  鼠标跨列/同列/空列，Escape/outside/touchCancel，键盘三操作，拒写/网络abort/lost-response
  精确重试，两页竞争和 02 草稿；390px CDP 真正触摸输入验证短按/正文 pan 不激活、长按
  列内调序及边缘自动滚动到空列，未用 dispatchEvent 替代触摸传感器。
- 最终 fresh 2026-10-09T10:02:57Z–10:06:25Z：focused64/64；全套2663 tests / 2659 pass /
  0 fail / 4 Windows-only skip；tsc/lint退出0。十个浏览器脚本全部通过，03十场景再次独立
  确认通过，02八场景/三语言Cancel3场景/01十二草稿场景与原聊天/侧栏/键盘回归通过。
  skip 是 Windows junction、Explorer reveal序列、PowerShell生产脚本解析、无窗口/UIA fallback；
  不当作通过。fresh原始命令/时间/日志/退出码与增量含新增文件patch见
  `/tmp/pi-web-ticket03-20261009-173230/REPORT.md`。
- 早期失败均保留：registry 默认DNS证书错误；production默认安装省略dev包，随后恢复并
  临时触发PostCSS图重读（配置原字节恢复、无重启）；首轮tsc类型问题；浏览器初次空列目标
  滚出屏、live-region选择器歧义、传感器50ms点击抑制/Next空announcer定位及滚动后的目标
  测量前置；扩大focused竞争胜者假定和触摸滚动最终目标竞态。测试修正不放宽用户结果断言，
  最终两次03十场景均通过；详细诊断在REPORT，不把首次失败称为通过。
- 30142仍PID21044/cwd源码，30141生产PID95436未触碰。继承修改全保护，01票据/02票据/
  04–14/聊天草稿实现/AGENTS等未改；24个本轮增量文件含4个新增文件。仅正常精确本地依赖
  安装，无新Next/build/重启/全局安装/真实用户任务或session/provider/commit/push。
- 未验证：Safari/iOS16.2真机及软件键盘、Windows/ACL/Explorer、最低Node实机、生产打包
  启动、断电/杀进程/网络文件系统、真实provider。下一步独立review与父验收；不得worker resolved。

2026-10-09 独立 review 唯一 P2 窄修（仍 claimed）：

- 父转交证据 `/tmp/pi-web-ticket03-independent-P73fwM/results.json`，review已确认核心操作/
  依赖/迁移/锁/receipt/触摸语法，29后端和10浏览器通过。本轮不重做选型或后端，不改其他票。
- 原 reload 成功无条件 setError(null)，导致 online/focus/手动重读隐藏未确认移动精确重试。
  仅改成功分支：更新权威board，有 retryMove 时保留当前错误；callback显式依赖 retryMove，
  让事件回调使用最新未确认状态。沿用原成功提交/新写入意图清理，不增加状态框架或ref副本。
- 新 `e2e/task-dashboard-retry-reload.mjs`：未提交且同步GET失败/已提交丢响应，各验证
  online、focus、手动刷新。六条红测全部复现0个retry按钮；绿测、最终fresh与独立再跑均6/6。
  重读须更新另一任务的权威属性且保留原error/retry；原action/id/columnId/operationId/
  expectedRevision/expectedOrderRevision/position逐字段不变，覆盖before/after/end锚点。
  丢响应精确receipt确认不增加revision/orderRevision，文件字节不变；全部API fixture及
  独立真实临时store，零Agent请求、无页面错误。
- 本轮fresh 2026-10-09T10:26:18Z–10:29:14Z：focused64/64、全套2663tests/2659pass/0fail/
  4Windows-only skip、tsc/lint0；十一浏览器脚本均通过，新六条再确认通过。旧exit不复用。
  四skip仍为Windows junction、Explorer reveal序列、PowerShell脚本解析、无窗口/UIA fallback。
- provider507中断后仅核对16组fresh命令/日志/exit及时间匹配、补报告/增量patch，未重复实施，
  未换模型。根目录快照、红绿日志、fresh精确命令与日志、含新增文件窄修patch、哈希核验见
  `/tmp/pi-web-ticket03-retry-fix-23S1QV/REPORT.md`。
- 30142/PID21044源码dev原样复用；30141生产不触碰。无新Next/build/重启/安装/真实数据/
  provider调用/commit/push。本worker只写主工作区03，不访问其他worktree或启动子代理。
  未验平台/生产/最低Node/断电边界不变，待父复验P2并验收；不由worker勾选或resolved。
