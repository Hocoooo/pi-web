# 侧边栏键盘导航与面板切换

## 目的、用户价值与范围

让用户不依赖鼠标，在虚拟化会话列表中定位/打开会话，并在侧边栏与输入框间切换焦点。修改全局快捷键、行 key、虚拟窗口、项目/更多行或删除确认时使用本契约。聊天区内部 Alt+Up/Down 与空白会话自动聚焦单独见[输入框与消息区焦点导航](chat-focus-navigation.md)。

覆盖主列表与聊天焦点桥接，不定义搜索结果、文件树、终端或模型选择器的全部键盘协议。继承原有 Esc 中止和 Ctrl+Alt+N 新建行为；新增功能不得借列表导航破坏输入编辑/IME。项目模型见[全项目侧边栏](all-projects-sidebar.md)，五条与自动揭示边界见[项目会话预览](project-session-previews.md)。

## 入口与当前默认值

| 焦点/入口 | 当前动作 |
| --- | --- |
| Alt+Left | 打开侧边栏并聚焦所选会话族根；没有匹配族则第一逻辑行，空列表则列表容器 |
| Alt+Right | 聚焦聊天 composer；没有 composer handle 时回退聊天容器 |
| 主列表 Up/Down、Home/End | 在逻辑可见行中移动/到首尾，移动不等于选中会话 |
| 主行 Enter | 点击该行：会话打开根；项目折叠切换；更多行切换预览 |
| 主列表 Left/Right | 按行类型收起/展开或返回项目标题，详见不变量 |
| 会话根行 Delete | 打开确认，初始聚焦“取消”；不是立即删除 |

没有用户可配键位或焦点 localStorage；项目折叠偏好仍按全项目契约持久化。主行采用 roving tab stop：有效 `keyboardRowKey` 为 Tab 入口，否则第一逻辑行，其他主行 `tabIndex=-1`；空列表容器可 Tab 聚焦。

## 行为要求与不变量

1. **精确全局修饰键。** `getSessionPanelShortcut` 只接受 Alt+Left/Right；Ctrl、Meta、Shift 或 `isComposing` 任一存在即不接管。窗口 capture handler 在 composer/终端局部方向键前运行，若事件已被 preventDefault 或存在 `[aria-modal="true"]` / `dialog[open]` 则不切焦点。处理成功时 preventDefault/stopPropagation，防止浏览器后退/前进；仅当应用收到事件时成立。
2. **面板可见性。** Alt+Left 在 AppShell 打开 sidebar；移动布局下同时关闭右面板/顶部面板。Alt+Right 在移动布局关闭侧边栏及上述覆盖面板，桌面不强制关闭侧边栏。焦点请求通过 requestAnimationFrame 等待布局提交。
3. **目标揭示。** `pi:focus-session-sidebar` 关闭并清空会话搜索，关闭项目/worktree 下拉；将所选子代理映射到父族根。all 模式展开该项目；若根行尚不在行模型，开启该项目更多状态。current 模式只在当前项目过滤集里寻找。此动作不选中另一个 session，也不发送或清除聊天草稿。
4. **逻辑行顺序。** 方向导航使用完整 `listRows`，不是 DOM 中已挂载的子集。Up/Down 到边界钳制而不循环，Home/End 到首/末逻辑行；all 模式中的标题和更多行也算可导航行。折叠隐藏的行不在模型里。
5. **左右键语义。** Right 在折叠标题上展开，在已展开且有子行标题上进入下一行；空项目无动作。Left 在展开标题上折叠。普通会话 Right 无动作，Left 找最近的前置项目标题；current 模式没有标题则无动作。更多行 Right 展开，已展开的更多行 Left 收起，未展开更多行 Left 返回项目标题。
6. **更多行身份。** 用 `more:<projectKey>` 而不是展开前的索引记住焦点，Enter/方向键展开或收起后仍请求该更多行；不要落到旧索引处刚插入的 session。其他 key 为 `project:<projectKey>`、`session:<rootId>`。
7. **虚拟化与编辑安全。** 所有行 54px，overscan 为 8；未测量 viewport 使用 600px。除通常窗口外，保留当前 inline 控件所在族，以及 `keyboardRowKey`/`pendingFocusKey` 对应行。目标挂载后按逻辑 index 调整列表滚动，再 `focus({ preventScroll: true })`；不得为 End 键挂载整个长列表，也不得因滚动卸载正在重命名的输入。
8. **焦点丢失恢复。** 删除/折叠/刷新移除曾聚焦行后，仅在原元素已断开且 `document.activeElement === document.body` 时，尝试原索引附近的现存行；空模型回退容器。若用户已转去其他控件，不主动抢回焦点。此保证针对移除，非承诺所有重排/重命名后都回到原行。
9. **局部事件隔离。** 列表导航忽略任何修饰键、native composition、已处理事件；仅处理容器自身或直接带 `data-sidebar-row` 的主控件，不截获重命名 input、删除确认按钮等后代。Tab 使用原生顺序，Space 没有统一的自定义主行激活协议（项目/more 是原生 button，会话行是 `role="group"`）。
10. **Delete 安全。** 仅普通、非 transient、非重命名/确认/删除中的会话根行处理无修饰 Delete。打开确认后不发 DELETE；Escape 取消并在键盘触发路径归还行焦点，确认才执行请求。鼠标 Shift+点击垃圾桶仍是既有跳过确认路径，不能映射成 Shift+Delete。
11. **删除失败的现实边界。** `performDelete` 对网络异常恢复 `deleting=false`，没有可见错误；对 HTTP 非 2xx 没有检查 `res.ok`，仍会调用删除回调/刷新。这是已知缺口，不可把此文写成“所有删除失败可靠恢复”。只能在可丢弃数据上验收真实删除。
12. **与聊天内部导航隔离。** 本功能只接管面板间的 Alt+Left/Right；Alt+Up/Down 的条件与验收以[聊天焦点契约](chat-focus-navigation.md)为准。Tab 继续遵循补全、next cue 和原生顺序，不由面板切换重新定义。

## 实现地图

| 路径 | 关键符号/职责 |
| --- | --- |
| [panel-focus-shortcuts.ts](../../lib/panel-focus-shortcuts.ts) | `getSessionPanelShortcut`，精确组合键判断 |
| [useKeyboardShortcuts.ts](../../hooks/useKeyboardShortcuts.ts) | `useGlobalKeyboardShortcuts`，capture、modal 防护，与上游 Esc/new 共存 |
| [AppShell.tsx](../../components/AppShell.tsx) | `handleFocusSessionPanel`、`panelFocusRequest`、`chatPanelRef` |
| [sidebar-keyboard.ts](../../lib/sidebar-keyboard.ts) | `sidebarKeyboardAction`、`sidebarRowKey`，纯逻辑动作 |
| [SessionSidebar.tsx](../../components/SessionSidebar.tsx) | `focusSidebar`、`handleListKeyDown`、`requestRowFocus`、`virtualIndices`、焦点 layout effect、`SessionItem.handleRowKeyDown` |
| [ChatInput.tsx](../../components/ChatInput.tsx)、[ChatWindow.tsx](../../components/ChatWindow.tsx) | `focusComposer`、`handleKeyDown`、`onFocusMessages`、消息 region `onKeyDown` |
| [globals.css](../../app/globals.css) | `.chat-message-region:focus-visible`；主列表还使用组件上的 focus outline 类 |

## 自动化验收

从仓库根目录执行；以下说明可用覆盖，具体运行结果须在各次维护任务中记录。

```sh
node --experimental-strip-types --test lib/sidebar-keyboard.test.mjs lib/panel-focus-shortcuts.test.mjs components/SessionSidebar.test.mjs components/ChatWindow.focus-navigation.test.mjs
```

- [sidebar-keyboard.test.mjs](../../lib/sidebar-keyboard.test.mjs)：真实纯函数，首尾/钳制、2000 行目标、标题/更多左右键、Enter、稳定 key 和空模型。
- [panel-focus-shortcuts.test.mjs](../../lib/panel-focus-shortcuts.test.mjs)：精确修饰键与 IME 判断，不证明浏览器能拦住系统快捷键。
- [SessionSidebar.test.mjs](../../components/SessionSidebar.test.mjs)：真实虚拟索引计算，Delete guard/焦点确认等为源码正则契约。
- [ChatWindow.focus-navigation.test.mjs](../../components/ChatWindow.focus-navigation.test.mjs)：TS AST 提取回调后 VM/mock 执行，检查菜单/IME/消息区 guard、preventScroll、后代控件边界；不是浏览器焦点集成测试。

另开终端运行 `npm run dev`，安装 Chromium 后用 Git Bash/POSIX shell：

```sh
PI_WEB_TEST_URL=http://127.0.0.1:30141 node e2e/session-keyboard.mjs
```

[session-keyboard.mjs](../../e2e/session-keyboard.mjs)使用真实 Chromium 和拦截会话/变更 API：隐藏侧栏后 Alt+Left、80 行 End/Home、Enter 打开、Alt+Right、草稿不丢、真实 `<dialog>` 阻断、Delete 尚未发请求、Escape、all 模式标题/更多、刷新后选中末尾根的揭示。注意其变量是 `PI_WEB_TEST_URL`，不是其他脚本的 `E2E_BASE_URL`；浏览器渠道使用 `PLAYWRIGHT_CHANNEL`。未覆盖真实删除成功/失败、inline rename、移动键盘及消息区 Alt+Up/Down 的浏览器联动。该脚本不是 `npm run test:e2e` 的子步骤。

## 手工验收

前置：隔离目录至少 80 个根会话（可用 API fixture），其中一个 transient；桌面窄会话窗确保虚拟化生效，all 模式有至少两个项目。需要验证真实删除时只用可丢弃会话。

1. 隐藏 sidebar，输入草稿后 Alt+Left：应打开 sidebar 并聚焦所选父族。Up/Down 只换焦点；Enter 才打开。End 必须能滚动到逻辑末行，Home 回首行；DOM 不应一次出现全部长列表行。Alt+Right 返回草稿且文字不变。
2. 在 all 模式标题上 Left/Right/Enter 检查折叠与首子行；在更多行 Right 展开，应仍聚焦“收起更多”，再 Left 应仍聚焦更多行。选第五条后的会话，刷新再 Alt+Left 应揭示该族。空列表按 Alt+Left 应可聚焦列表而不抛错。
3. 主会话行 Delete：应先聚焦取消，无 DELETE 请求。Escape 取消回行；再次 Delete 后确认才发请求。输入框中的 Delete 仍删除文字，transient 行/修饰 Delete 不应触发确认。重命名期间滚动离开原窗口，输入不能因虚拟化消失。
4. 移除正在聚焦的测试行并刷新数据：浏览器焦点落 body 时回附近行；先主动点其他控件后刷新不应抢焦点。模拟 DELETE 网络拒绝观察行恢复可用；模拟 HTTP 500 时记录当前缺口，不能判为已处理成功。
5. 打开真实模态对话框，Alt+Left/Right 不得将焦点移到背后；Ctrl+Alt/Shift+Alt/IME 场景不应触发面板切换。移动宽度下检查 sidebar/chat 切换能关闭遮挡面板。
6. 修改公共 keyboard handler 或 composer handle 时，追加执行[聊天焦点导航的人工验收](chat-focus-navigation.md#人工验收)，确认横向面板切换没有破坏聊天内部导航。

## Rebase 保留清单与上游交互

- [ ] 全局 capture、精确修饰键和 modal guard 保留，不能回退成在 textarea 内无条件截获箭头。
- [ ] 新虚拟列表仍支持逻辑行首尾、稳定 key、焦点目标强制挂载、inline rename pinning 和 preventScroll。
- [ ] 保留 Delete 确认与 transient guard；本分支有意替换上游原测试中“不注册行级删除快捷键”的断言，不要在冲突时两者混留。
- [ ] 项目/more 操作改变行数后保持身份；选择子代理时定位根，不新增隐藏子代理树。
- [ ] 工作区恢复、搜索及聊天消息分页/扩展对话框变更后重验焦点，不清草稿、不抢其他控件。
- [ ] 原有 Esc 中止、Ctrl+Alt+N、Tab 补全与新增面板导航分别验收，不以一个 key handler 覆盖全部交互。

## 已知限制与未验证区域

没有 F2 重命名或统一 Space 打开会话的协议；行内 hover 操作按钮仍受原 UI 可见性影响。焦点主行用 group 而非完整 ARIA tree/listbox，屏幕阅读器体验未由现有测试证明。非模态右键菜单不是 global modal guard 的阻断对象。HTTP 删除失败检测、无数据加载时焦点、真实浏览器/操作系统 Alt 快捷键差异仍需实测。

## 维护规则与基线

固定基线 **`63c6e4e`**，本次对照的 `origin/main` 为 `96966e5`。新增键盘状态/桥接建立在上游固定高虚拟列表和 inline 操作之上。改变键位、焦点目的地或窗口模型时同时更新纯函数测试、源码/VM 契约和浏览器脚本覆盖说明；明确重验后才改基线，不让文档隐式代表未来 HEAD。
