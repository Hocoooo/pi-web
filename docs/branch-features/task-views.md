# 任务筛选、自动排序与保存视图（票据05，resolved）

2026-10-10 界面更新：筛选/排序仍从工具栏按需展开；默认只显示搜索、项目、排序。状态、优先级、标签、活动在原生“更多条件”中，多选语义不变；已选条件显示可移除标签，保留一键清空。失效列/项目/标签继续明确显示，不能默默扩大结果。保存视图放到次级区，仅有视图时显示选择器；选择身份按用户明确选中的 ID 保留，不把条件相同的另一名称替换为第一个匹配项；折叠不卸载保存草稿，原 CAS/重试不变。桌面三个基本字段同一行，小屏搜索占一行、项目与排序并列；更多条件小屏单列，长选项可换行/独立滚动。归档范围仍独立。看板列独立横滚；改变筛选/排序/归档范围重置横向起点，不拖走表单。详情独立于投影，筛掉当前任务仍可继续审核。验收见[UI检查记录](../testing/task-dashboard-ui.md)及 `e2e/task-dashboard-ui.mjs`。

当前01–14全部父resolved，统一[当前schema/CAS/迁移权威表](task-dashboard.md#当前存储cas与迁移权威表)为v7；05主及父定向证据 `/tmp/m05-KrSVnY/REPORT.md`，原v4引入/源主分层见[历史附录](task-dashboard-validation-history.md#13--04--05-的主组合与隔离事故)。最终综合/真实平台核验另报，源green不代主接受。
关联：[看板合同](task-dashboard.md)、[05票据](../../.scratch/task-dashboard/issues/05-filters-and-saved-views.md)、[共享重点](task-shared-context.md)。

## 入口与范围

`/tasks` 的“筛选与排序”原生控件支持文字、项目（默认全部/明确无项目/一个服务端projectKey）、
稳定状态列ID、优先级、标签、AI工作状态，并可组合。文字不区分大小写，在已加载任务标题/说明/
完成要求中匹配；状态/优先级各自任一选中，标签要求全部选中，空选择表示不限制。任务详情和关联
数据仍用同一权威board；不扫描session正文、不创建Agent、不改任务归属/状态。无结果单独提示，
不是读失败或假空板。项目/标签已失效不丢条件；不可用项目仍显示条件并得空结果。

## 行为不变量

1. 手动排序是服务端tasks数组投影；优先级复用`compareTaskPriority`（降序、createdAt升序、UUID
   code-point升序）；最近更新按updatedAt降序、createdAt升序、UUID升序。复制后排序，不写回手动顺序，
   不递增任何revision。知识确认/资料修改/用户移列本来就更新updatedAt，自动排序反映这些已保存时间。
2. 自动排序禁上/下调序，显示原因；同列拖放无请求且反馈同一原因。整张卡片仍允许跨列拖动（单击打开详情，见[F21](task-dashboard.md#拖动顺序与失败03)）；自动模式
   跨列只发单任务列末尾edge意图，呈现重新排序，不把指针位置描述为可固定rank。详情不提供状态选择菜单，只保留同列上/下调序；跨状态仍通过看板拖动。切回手动保持原顺序。
3. 手动筛选调序用相邻可见任务的before/after锚点，不提交可见数组。可见空列（含隐藏任务）用edge:end，
   服务端03同锁guards只移动指定UUID，隐藏任务相对次序/字段不变。移出状态筛选立即消失；全列仍显示，
   可移到另一状态。拖动冻结权威board与可见任务快照；运行投影更新不能在拖动中改锚点。
4. AI条件复用04轻量running快照。linked任务首次未知/请求失败时为unknown，不伪报idle，不匹配working
   或idle；全部条件仍显示卡片的未知提示与全局stale警告，最后详情生命周期信息保留供解释。无关联任务
   可确定idle。可见页2.5秒poll，online/focus/visibility/reopen校准；运行结束/失败不写状态。
5. 02资料、06知识草稿继续分别按任务ID存在Dashboard中；过滤隐藏、排序、跨列重挂载、refresh不清输入/
   rebase。04数量来自持久sessionIds，原来源创建和导航不变；03错误/精确重试不被视图切换或重读清除。
6. “保存视图”冻结打开时的filter、sort、viewsRevision；输入命名后确认才提交。命名trim、非空单行、最多
   100字符，大小写敏感唯一；最多100个视图。此票据只新增并再次打开，不提供覆盖、删除或任意查询语言。
   所有控件及确认/取消可Tab/Enter/触摸，手机输入16px；用户名字/标签均纯文本。
7. 失败/冲突保留名字、固定base和请求ID，不假报保存。未修改名字时重试同一operationId/id/条件；丢响应
   后reload只展示权威视图，精确receipt响应才确认。修改名字生成新operationId，不自动rebase；冲突时
   明确取消、刷新再重开保存。两页旧viewsRevision只有一方成功，唯一名字/id防重复，不覆盖另一页。
8. 状态条件保存稳定ID，不保存显示名。自定义列改名/排序不影响它。未知/未来删除ID保留在savedViews，
   `projectTaskView`返回invalid并**整个结果为空**、可理解alert/显式清除，不默默移除条件扩大结果。
   14[安全删列](task-column-removal.md)消费此行为，完整保留savedViews/receipt中已删ID，不能“修复”为全部列；实际浏览器重开失效条件验证见14主fresh证据 `/tmp/m14-s1bbqjlr/REPORT.md`，14已独立主review并父resolved；10联合另分层验收。损坏schema由store拒读，503不重置。

## 同一个store、公共操作与views CAS

`taskOperation`新增`save-view`：`id,operationId,expectedViewsRevision,name,filter,sort`；返回同锁完整
board，继续原`/api/tasks`认证、no-store、HTTP大小/错误规则。filter固定六字段，拒绝未知字段、稀疏数组、
非法值；写入当前未知列ID拒绝。projectKey只是精确显示条件，不授权文件/会话访问。

views引入于当时v4，当前统一承载，不第二数据库。合法legacy双字段absence-only与当前必填规则只维护F21权威表；partial/null/坏值拒读不改字节，原列/知识历史/receipt/资料/指纹/关系/手动顺序保持。每个视图保存内部最近receipt，
指纹绑定完整canonical请求（含base）；public board剥离receipt。精确重复优先确认，返回最新完整板，
不加视图/回拨独立域。views CAS与columns/task/order/knowledge独立，保存只推进viewsRevision。
视图无更新/删除，receipt有界于100条已保存记录；不引入第二操作日志。

实现：[task-view](../../lib/task-view.ts)纯验证/投影/运行分类；[task-saved-views](../../lib/task-saved-views.ts)
服务端parse/校验/receipt/CAS；[store](../../lib/task-store.ts)同锁迁移；[operations](../../lib/task-operations.ts)
唯一入口；[TaskViewControls](../../components/TaskViewControls.tsx)固定保存草稿/原生控件；
[Dashboard](../../components/TaskDashboard.tsx)投影、冻结拖动和权威响应。

## 验证入口

所有数据/HOME/agentDir/TMPDIR须为Git树外新短/tmp，先git rev-parse确认非仓库。测试进程清SDK aliases；
node_modules只读、不install/build。主浏览器复用metadata指定的健康30142、临时agentDir/offline dev；
全API fixture、Playwright安装缓存只读，不启动/重启服务。源30143和临时双root仅属隔离历史，不带入主配置。

```sh
env -u PI_PACKAGE_DIR -u JITI_ALIAS -u JITI_RESOLVE_ALIAS node --experimental-strip-types --test \
  lib/task-views.test.mjs lib/task-columns.test.mjs lib/task-context.test.mjs lib/task-order.test.mjs \
  lib/task-details.test.mjs lib/task-sessions.test.mjs lib/task-sessions-integration.test.mjs app/api/tasks/route.test.mjs
env -u PI_PACKAGE_DIR -u JITI_ALIAS -u JITI_RESOLVE_ALIAS \
  E2E_BASE_URL=http://127.0.0.1:30142 node e2e/task-dashboard-views.mjs
```

公共操作真实tmpstore覆盖组合/no-project/空/非法条件、确定排序不写、fresh-process保存重开、丢响应精确
确认、两进程竞争/独立域、v4及旧版absence-only迁移/坏值、隐藏任务移动、真实POSIX失败恢复。
新增浏览器覆盖完整组合、键盘保存/刷新再打开、自动调序拒绝/跨列排序、邻居/可见空目标/移出范围、两页
移动/视图冲突、精确丢响应、running错误未知/重开、自定义ID/未知ID和390px触摸，联合02/06双草稿。
必要回归含01草稿12、02details8、03order10/retry6、04sessions7、06context8、13columns7、三语言取消、
基础board/项目/独立聊天/侧栏Git与非Git/键盘。源full/tsc/lint见`/tmp/p05-Yumftb/REPORT.md`；
主fresh结果另见`/tmp/m05-KrSVnY/REPORT.md`，不是继承源或历史pass。父代理已核对增量并验收。

人工：组合筛选→无结果→清除；命名确认→刷新打开；自动同列不能调序，跨列后按自动规则，回手动；筛选
Visible拖到有Hidden任务的可见空列，清除后两任务皆在且Hidden字段/次序不变。两页保存冲突保留输入；
失效列ID不显示越界结果。断线运行提示未知，不能称空闲；这些操作无模型请求。

## 证据层级

命令/人工步骤不是本轮文档执行证明。05源/主全域迁移与双草稿测试见[历史附录](task-dashboard-validation-history.md#13--04--05-的主组合与隔离事故)；父独立主views9/9、B11见 `/tmp/pi-parent-ticket05-views.log`、`/tmp/pi-parent-ticket05-browser.log`，05resolved。U/O/H与Chromium fixture分层，最终coverage不把静态检查/命令计划/skip算执行pass。

## 12归档投影交点（主已父验收resolved）

[归档列表](task-archive.md)的active/archived/all scope是独立页面投影，不扩展或重写本合同六条件/保存视图schema或receipt。日常默认隐藏archive，用户可发现列表后继续原组合筛选；task数组/手动顺序、unknown运行态、未知列IDfail-closed及双草稿固定base不变。归档不改updatedAt、不伪编辑或知识更新；全部列表可用户移列归档task供14使用，不改变原单任务邻居规则。

## 集成与未验边界

05已验收；07主动摘要已逐hunk主集成并由父代理验收resolved，见[07合同](task-ai-summary.md)，08/09/10/11亦已主集成并分别resolved。07扩source严格union而不改版本/旧人工来源，保留views双字段absence-only迁移及所有字段/CAS/receipt。AI与02/06草稿过滤隐藏/unknown运行态/排序重挂载仍固定原base，来源关系变化不可错发布；联合迁移、精确retry最新board和浏览器交叉证据见 `/tmp/m07-zsEOPj/REPORT.md`。后续扩store/types/operations/Dashboard仍须相对冻结baseline语义三方合并，保留各自字段与CAS。
不要整文件覆盖或把版本数字当隔离源格式兼容保证，尤其04 source-only v3拒读；所有mutation/精确retry须返回含views的最新board。
14删列保留未知条件的fail-closed消费者，不写回savedViews或推进viewsRevision。全API fixture字段随公共board同步；04失败poll断言改为明确
unknown而非旧busy（详情最后生命周期仍保留），01draft fixture补views元数据，不弱化草稿断言。

个人O(n)文档32MiB/100views/100columns/20选标签；14主真实HTTP已验证50000任务约25MiB完整集合及固定<512byte请求，3500浏览器全量预览；不是50000 DOM性能benchmark。Chromium桌面/CDP触摸不是
Safari/iOS16.2真机、软件键盘或Windows。最低Node执行、生产打包启动、Windows/ACL、断电/NFS/杀进程、
真实provider费用/网络均未验；不运行nextbuild或自动commit/push。契约、索引、票据评论与实现同步维护。
