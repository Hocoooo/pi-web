# 输入框与消息区焦点导航

> 功能基线：`63c6e4e`。当前键位是 **Alt+↑ / Alt+↓**，不是早期提交标题中的 Tab 切换。

## 目的与边界

无需鼠标即可在 composer 与消息阅读区域间移动，并在打开空白会话后直接输入。焦点切换不能跳动阅读位置、覆盖草稿或抢走弹窗与子控件的键盘操作。

本文件负责聊天区内的上下切换和空白会话自动聚焦；侧栏与 composer 间的 Alt+← / Alt+→ 见 [侧栏键盘导航](sidebar-keyboard-navigation.md)。Tab 采纳空框建议见 [下一轮提示词建议](next-prompt-suggestions.md)，采纳非空草稿的灰字后缀见 [输入时草稿补全](draft-completion.md)。两者均不得发送消息或恢复旧版 Tab 跳消息区行为。

## 入口、按键和要求

| 场景 | 按键/触发 | 当前行为 |
|---|---|---|
| composer 内，没有补全菜单和 IME | Alt+↑ | 尝试聚焦消息区；成功才阻止默认行为 |
| 消息区容器本身具有焦点 | Alt+↓ | 聚焦 composer，避免页面滚动 |
| 消息区的按钮、链接等子控件 | Alt+↓ | 不拦截，保留子控件/浏览器行为 |
| 空白会话已完成加载 | effect + animation frame | 调用 `focusComposer()` |
| 普通 Tab / Shift+Tab | 原生焦点顺序 | 不再承担聊天区切换；建议/补全有自己的 Tab 规则 |

### 必须保留的行为

1. 输入框侧只有精确的 Alt+↑ 生效；Ctrl、Meta、Shift 额外修饰键不触发该功能。
2. 历史输入菜单、斜杠菜单、`@` 文件补全开启时，不抢占导航；IME 正在组合输入时不触发。
3. 找不到消息容器、正在恢复阅读位置、存在扩展对话框或扩展自定义 UI 时，不从 composer 跳到消息区。
4. 消息区必须可聚焦：`role="region"`、`tabIndex={0}`、本地化的可访问名称；键盘焦点有可见轮廓。
5. 使用 `focus({ preventScroll: true })`，不因切换焦点滚到页面顶部、底部或最新消息；上游的阅读位置恢复逻辑保留优先权。
6. 从消息区返回的 handler 检查 `event.target === event.currentTarget`，不能在外层捕获所有子元素键盘事件。
7. 紧凑 composer 不因缺少消息区回调而报错；该回调应可选。
8. 打开空白会话后，在 `isNew && !loading` 时安排聚焦，并在 effect 清理时取消 animation frame。已加载的历史会话不由此 effect 强制聚焦。
9. 这些操作不发送消息、不清空输入、不改变模型、不创建新会话。不要为了焦点切换走消息发送路径。

## 实现导航

- [ChatInput.tsx](../../components/ChatInput.tsx)：`ChatInputHandle.focusComposer`、`handleKeyDown`、`onFocusMessages` 可选回调。
- [ChatWindow.tsx](../../components/ChatWindow.tsx)：空白会话聚焦 effect、消息区 DOM 属性和 `onKeyDown`、`onFocusMessages` 的阻塞条件。
- [globals.css](../../app/globals.css)：`.chat-message-region:focus-visible`。
- [ChatWindow.focus-navigation.test.mjs](../../components/ChatWindow.focus-navigation.test.mjs)：抽取真实 handler 在 VM 中验证键位和状态组合。
- [ChatInput.new-session.test.mjs](../../components/ChatInput.new-session.test.mjs)：新会话聚焦接线的源码契约。

## 自动验收

```bash
node --experimental-strip-types --test components/ChatWindow.focus-navigation.test.mjs components/ChatInput.new-session.test.mjs components/ChatInput.test.mjs
```

这些测试验证 handler 行为、接线和 CSS 契约，**不证明真实浏览器的滚动位置、操作系统键位冲突或所有 IME 行为**。`e2e/session-keyboard.mjs` 主要验收侧栏横向切换，不应被描述为上下切换的完整 E2E。

## 人工验收

前置：桌面浏览器，测试会话有长历史，composer 有尚未发送的草稿。

1. 将历史滚到中部，聚焦 composer，按 Alt+↑。**期望**：消息区出现焦点轮廓，阅读位置不跳，草稿不变。
2. 按 Alt+↓。**期望**：回到输入框；继续打字进入原草稿。
3. 对消息区里的按钮/链接聚焦，再按 Alt+↓。**期望**：不会被外层强制拉回 composer。
4. 分别打开斜杠、文件、历史补全，或启用中文 IME，按 Alt+↑。**期望**：不离开当前编辑交互。
5. 打开扩展对话框、触发阅读位置恢复期间尝试切换。**期望**：不抢占这些流程。
6. 打开一个空白会话，包括通过 `/new`。**期望**：加载完成后可直接输入；打开已有历史会话不因本功能强制移动焦点。
7. 用 Tab/Shift+Tab 遍历消息内控件。**期望**：仍使用正常 Tab 顺序；有可采纳建议时，按其专属规则处理。

## Rebase 注意与已知边界

- `c9fcc76`/重放后的 Tab 功能提交不是最终规格：后续提交已将聊天区切换迁移到 Alt+方向键。不能仅凭旧测试名或提交说明恢复 Tab 切换。
- 合并 `ChatWindow` 时保留上游阅读位置恢复、scroll-to-latest、滚动条和扩展 UI；不能为了减少冲突删除 `pendingScrollRestore` 检查。
- 浏览器/系统可能占用 Alt 组合键；真实环境需人工验证。
- 当前空白会话聚焦 effect 的条件是 `isNew`/`loading`，并非一个通用的“任何弹窗打开时都不会聚焦”的全局焦点策略；不要扩大承诺。

任何键位、聚焦条件、消息区结构或 Tab 优先级变化，都要同步本文件、关联功能文档与 [README](README.md)。
