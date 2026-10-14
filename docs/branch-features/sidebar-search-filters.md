# F39 — 统一侧栏搜索与筛选入口

首次开发起点 `444d25e`；本轮调整起点 `1006852`。用户要求 Task 筛选不常驻侧栏，但 **日常／已归档会话保持原 UI 操作方式**。当前合同覆盖第一版将归档范围收入浮层的旧呈现；不改变 Task、Session、归档或正文搜索的数据语义。

## 当前行为

1. **保留会话范围入口。** 列表上方恢复 F34 原生选择框：日常会话／已归档会话（数量），原位置区域、30px高度、样式、文案与数量算法保留。默认日常、完整刷新回到日常；current/all 项目与 Task 范围内的计数继续按会话族根计算。范围切换不导航、不清正文或 Task 条件，不写归档状态。
2. **统一 Task／正文入口。** 原搜索按钮名称为“搜索与筛选”。Task 搜索、Task 下拉和原展开式正文输入不常驻；不增加视图或工具栏筛选按钮。项目/worktree 选择器、Task 树设置职责不变。桌面为允许外部关闭的浮层，640px以下为底部面板，主页含正文检索、Task 条件行、添加条件和清除。面板内不再提供对话范围条件行、子页或重复开关。
3. **Task 列表子页。** 点击 Task 行进入可检索列表，匹配标题/说明/完成标准，与正文关键词分开。提供不限/未关联与具体 Task；all 项目候选注明路径，完整路径通过 title 和选项无障碍说明提供，归档 Task 标记不随长路径省略。空 Task 仍可选择；选择即时生效返回主页，不切聊天/cwd、不改关系。选择不在新项目候选或不匹配子页关键词时仍保留，不静默放宽。
4. **扩展入口。** “添加条件”在面板内部列出当前支持的 Task 类型并进入编辑子页；重复选择不增加重复条件。未来条件从这份菜单和面板内部扩展，不再叠加侧栏按钮。本版不实现状态/标签/时间字段或查询 DSL；日常／归档是独立列表范围，不重新收入条件菜单。
5. **正文语义。** 无 Task 时搜索所有项目的当前日常／归档范围；Task/unlinked 条件继续限定后端 scope。300ms debounce、范围提示、截断前 Task+archive 交集不变。Task 子页文字只检索候选，不触发正文请求。关闭面板保留查询、条件和结果；通过原生选择框切换范围会取消旧响应并重读同一关键词与 Task，重开仍显示已生效值。
6. **条件反馈和清除。** 只有正文非空或 Task 非不限才显示一个固定32px单行摘要；入口角标只计 Task／正文。主页条件按钮的无障碍说明包含当前 Task 值。摘要最多两个片段，长文本省略；已有 `+N` 布局保留为后续条件扩展位置，本版至多两项。仅选择归档不出现摘要/角标，也不启用清除按钮。浮层或摘要的“清除搜索与筛选”只清正文/Task，**不改变日常／归档范围**；Task 单项清除同样不改范围、不清正文。
7. **关闭与焦点。** Escape、关闭按钮、点击外部只关面板；IME Escape/229和Task方向键保持输入优先。Task搜索ArrowDown进入选项，选项Up/Down/Home/End/Enter可操作。Tab循环，reset后disabled控件不把焦点送到背景；手机modal约束焦点，切页恢复有效目标，打开Task详情先关本面板。桌面焦点离开或更高弹窗接管时关闭下层浮层、保留条件，Escape仅捕获本面板事件。跨640px切换关闭浮层，隐藏入口回退可见侧栏开关。手机主页默认不开软件键盘，输入使用已有visualViewport高度。Alt+Left保留明确回树/揭示当前会话及所属日常／归档范围的行为，可清正文；手机sheet局部桥接原AppShell快捷键，Alt+Right关闭sheet/drawer聚焦composer并保留条件，不放宽其他弹窗modal guard。
8. **错误、原会话动作和副作用。** Task目录失败保留完整目录/选择，面板内可重读，关闭时侧栏告警仍可见。归档失败及精确目标重试恢复在原范围选择框下；会话行归档/恢复与改名/删除共用原悬停区，右键、32px目标、历史/草稿/运行行为不变。所有搜索/范围控件只改展示，不写Task/JSONL、不启停Agent、不生成报告/命名；没有API/schema或服务更改。

## 实现地图

- [SidebarSearchControls.tsx](../../components/SidebarSearchControls.tsx)：统一按钮、正文/Task编辑页、候选与摘要、焦点/关闭；不接受archive条件或setter。
- [SidebarSearchControls.module.css](../../components/SidebarSearchControls.module.css)：desktop浮层/mobile sheet、32px单行摘要与安全区；本轮样式无需修改。
- [SessionSidebar.tsx](../../components/SessionSidebar.tsx)：原生Session范围选择、归档错误/retry；query/Task与archive状态分离，reset只清前两者，正文结果不依赖浮层open。
- [AppShell.tsx](../../components/AppShell.tsx)：沿用原手机面板焦点回调与可见侧栏开关回退，本轮无需修改。
- `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`：复用原会话范围文案与新Task/正文文案。
- F38目录/owner/树模型、F34归档、sessions/search服务端、看板与聊天任务选择器不变；F06焦点契约及mobile viewport hook保持。

## 用户批准的验收入口

```bash
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/sidebar-search-filters.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/sidebar-task-tree.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/session-archive.mjs
node --experimental-strip-types --test app/api/tasks/catalog/route.test.mjs app/api/sessions/search/route.test.mjs
```

复用确认cwd是当前源码的健康dev，安装版不是源码验收，不新开/重启服务或运行生产build。浏览器拦截所有API，不操作用户真实数据/模型。原Node测试CSS加载仅作bundler artifact stub，真实CSS由浏览器验证。

- 专项：只有原Session范围select常驻，Task/body搜索不常驻；默认日常/归档数量、无重复范围页，Task资料/完成标准与正文分离，原生范围切换与Task+body搜索保持/重读，URL不变；归档本身无摘要/角标，浮层/摘要reset均保留范围，三语言390px同样成立。
- 保留：即时条件、单项清除、关闭保留、Task值无障碍说明、Arrow/End/Enter、IME/Escape/外部关闭、reset后Tab、Alt+Right后/task与Settings叠层、同名/长路径Task归档说明、breakpoint焦点、手机modal/visualViewport模拟与主题截图。
- 旧回归：Task五族/empty/unlinked/owner/copy/多级跨Task/reveal/归档独立；Session悬停目标、写失败/retry、历史/草稿/跨标签/键盘/三语言主题。旧脚本通过原生Session范围select操作，不移除原断言。

## 手工看效果

1. 默认侧栏列表上方直接显示日常／已归档选择框；Task和正文控件仍不常驻。
2. 不打开搜索面板即可切换归档；此时只有原范围选择的状态和数量，无筛选摘要或搜索角标。
3. 点放大镜，Task列表搜索/选择并输入正文关键词，关闭后结果保留。再直接切换Session范围，关键词与Task不丢、结果按新范围重读。
4. 在归档范围清除搜索与筛选，只清Task/正文，仍留在归档列表；归档/恢复、改名/删除仍在原会话行悬停区。
5. 390px保留同一原生范围入口，正文/Task面板仍为底部sheet，软件键盘高度由已有hook管理。

## Rebase／边界

- 不恢复常驻Task搜索/select，不另加筛选工具栏按钮；但必须保留用户要求的原生Session范围select，不能因“统一入口”再次移入面板。
- query活动与面板open分离；archive不能重新成为reset、摘要或角标的一部分。全文全局项目scope、Task树设置/owner/归档独立、F06显式reveal不变。
- Portal、局部Escape、焦点恢复与mobile viewport一起集成，不增加客户端lookbehind。
- Task候选仍为全量列表，不新增大规模虚拟化。Safari/iOS16.2、Windows真机、真实软件键盘、生产安装未验，Chromium viewport模拟不等于真机证明。

当前执行结果与历史证据见[验收记录](../testing/sidebar-search-filters.md)。修改同轮同步F38/F34、sessions topic及索引；F06/Settings/viewport实现未变仍核对交点。
