# F39 — 统一侧栏搜索与筛选入口（第一版）

固定开发起点 `444d25e`。用户确认不在 session 侧栏常驻 Task 下拉，也不因未来增加条件而增加工具栏按钮。本合同替代 F38/F34 的旧常驻检索控件呈现，不改变 Task、Session、归档或正文搜索的数据语义。

## 用户确认的行为

1. **一个入口。** 复用原搜索按钮，名称为“搜索与筛选”。移除常驻任务搜索、任务下拉、归档下拉及原展开式正文输入；默认列表不出现筛选摘要，不增加视图或工具栏筛选按钮。项目选择器、worktree 选择器、Task 树设置保留原有职责。
2. **按需面板。** 桌面为按钮下方、允许点击外部关闭的浮层；640px 以下为全宽底部面板。主页面含正文检索、Task 条件行、对话范围条件行、添加条件与清除；不存在一排平铺的下拉框。
3. **Task 列表子页。** 点击 Task 行进入可检索列表，匹配标题/说明/完成标准，与正文关键词分开。提供不限/未关联和具体 Task；all 项目候选注明路径，完整路径可通过title查看，并作为选项的无障碍说明；归档 Task 有独立、不随路径省略的标记。空 Task 仍可搜索选择；选择即时生效并返回面板主页，不切聊天/cwd、不改关系。当前选择即便不在新项目候选或未命中子页关键词也保留在主页，不能静默放宽。
4. **范围子页与扩展。** 对话范围只提供已有 active/archived，选择返回主页、立即生效。“添加条件”在面板内列出当前支持的 Task/对话范围类型并进入相应编辑子页；重复选择不会重复增加同类型条件。未来在这份条件菜单及面板内部扩展，不增加侧栏常驻按钮；本版不实现未来状态/标签/时间字段或通用查询 DSL。
5. **正文语义不变。** 无 Task 时搜索所有项目正文，Task/unlinked 条件限定原后端 scope，面板显示范围提示。正文输入300ms debounce保持；Task 子页文字只是候选检索，不触发正文请求。关闭面板不隐藏正文结果、不改变关键词或筛选，重开回主页显示已生效值。
6. **条件反馈。** 面板主页条件行将已生效值作为按钮的无障碍说明，重开后无需进入子页即可获知Task/对话范围。只有正文非空、Task 非不限或 archived 等非默认条件才显示一个固定32px单行摘要；展示至多两个摘要片段，剩余 `+N` 与清除按钮不随长任务名消失。工具栏角标显示非默认条件数。清除全部回到正文空/Task不限/日常对话，不切聊天；单项清除只在面板内。不因更多条件不断增加摘要行或入口按钮。
7. **关闭、焦点与移动。** Escape、关闭按钮、点击外部只关闭面板，已生效值保留；IME Escape/229不关闭，Task列表箭头不抢IME。Task搜索ArrowDown进入选项，选项Up/Down/Home/End/Enter可操作。Tab在面板内循环，清空后reset按钮disabled也不把焦点送到背景；手机标记modal并约束焦点，返回/选项切页恢复到有效目标；显式打开Task详情先关闭本面板。桌面焦点明确离开或更高弹窗接管时关闭下层浮层，不清条件；Escape仅捕获本面板内事件，不同时关闭上层弹窗。跨640px布局切换关闭浮层并将隐藏侧栏入口的焦点交给可见侧栏开关，已生效值保留。手机默认不开软件键盘，主动进入Task检索/正文输入后使用已有visualViewport高度，面板不落到键盘下方。Alt+Left保持原明确揭示当前会话的语义，可清正文以回树；不能被误作普通关闭。手机sheet只在自己的键盘事件中桥接原AppShell面板快捷键，Alt+Right关闭sheet/侧栏并聚焦composer，仍保留查询；其他弹窗的global modal guard不变。
8. **错误与副作用。** 保留Task完整目录与失败状态，面板内可重读；面板关闭时任务加载失败仍有可见侧栏告警，不把不可用当空/未关联。Session归档失败与retry仍在侧栏可见。所有控件只改变展示，不写 Task/JSONL、不停止或启动 Agent、不自动生成报告/命名。没有API/schema或服务更改。

## 实现地图

- [SidebarSearchControls.tsx](../../components/SidebarSearchControls.tsx)：统一按钮、条件页、Task选择列表、状态摘要、范围提示与焦点/取消。
- [SidebarSearchControls.module.css](../../components/SidebarSearchControls.module.css)：现有调色变量，desktop浮层/移动sheet，单行摘要、滚动高度与安全区。
- [SessionSidebar.tsx](../../components/SessionSidebar.tsx)：接入原query/task/archive状态，正文搜索活动不再依赖面板open；明确reset、旧独立控件移除。F38的SidebarTaskFilter已由新模块替代。
- [AppShell.tsx](../../components/AppShell.tsx)：复用原面板焦点回调给手机sheet，侧栏开关补aria-controls/expanded供隐藏入口的焦点回退；不改变其他modal防护。
- `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`：统一入口、条件、范围提示、清除和返回。
- F38目录/owner/树模型、F34归档、sessions/search服务端、看板与聊天任务选择器不变。

## 用户批准的验收入口

```bash
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/sidebar-search-filters.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/sidebar-task-tree.mjs
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/session-archive.mjs
node --experimental-strip-types --test app/api/tasks/catalog/route.test.mjs app/api/sessions/search/route.test.mjs
```

复用确认cwd是当前源码的健康dev；安装版不是源码验收，不新开dev争锁，不运行生产build。浏览器拦截全部API；旧Task/归档回归迁移到条件页操作，不操作真实数据/模型。CSS模块在原Node源码/纯函数测试中仅作bundler artifact加载，真实浏览器验证实际CSS，不把Node stub当渲染验证。

- 专项：没有常驻搜索/select、默认无摘要；主页条件行的已生效值可访问说明；Task元数据/完成标准检索不触发正文；添加条件、组合Task+archive+body、关闭保留/范围refetch；单项/全部清除、URL不变；Arrow/End/Enter、Escape/IME/外部关闭、焦点恢复；reset后Tab、Alt+Right后/task、Settings叠层、长路径/归档无障碍说明、跨breakpoint回退；三语言390px modal/Tab、visualViewport模拟缩短、浅深截图、无横向溢出。
- 旧回归：Task树/五族、未关联、空任务、归档独立、copy refreshKey、多级跨Task根标记、清筛选后的reveal、折叠空态；Session归档失败/retry/hover targets、完整历史/草稿、跨标签、搜索、键盘恢复及三语言主题。
- F38明确的服务端截断前Task过滤/只读目录保持，HTTP复跑，不新增私有函数测试seam。

## 手工看效果

1. 在当前源码服务点侧栏放大镜。默认侧栏只保留目录/树；打开看到正文与两个条件行。
2. 点Task输入其说明关键词，选择后回主页；关闭浮层，列表已筛选且只有一行摘要。重开值保留，正文范围提示是当前Task。
3. 从添加条件选归档，加正文关键词；关闭后仍可阅读结果。清除一个条件不清其他；全部清除恢复日常列表。
4. 在390px打开底部面板，返回/关闭可用，正文或Task输入时面板适应可见高度；正文结果不会因关面板消失。

## Rebase/限制

- 不恢复常驻Task/archive select或在侧栏另加条件按钮；query活动与popover可见性分离。
- 不重新解释正文全局scope为当前项目，不改变树设置/owner/归档独立，不复活共享或执行入口。
- Portal、Escape capture、焦点恢复、移动modal/viewport和条件页切换一起集成；CSS不添加客户端lookbehind。
- Task候选当前全量列表，不作大规模虚拟化；只实现已有条件，未承诺其他条件的后端支持。Safari/iOS16.2与Windows真机、真实软件键盘、生产安装均未验，visualViewport为Chromium模拟，不等于真机证明。

本轮结果与截图路径见[验收记录](../testing/sidebar-search-filters.md)。修改同步本合同、F38/F34/F06及topic、索引，不把第一版视觉验收描述为生产安装。
