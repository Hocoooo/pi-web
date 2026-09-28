# `/new`：在当前目录打开空白会话

> 功能基线：`63c6e4e`。这是前端导航命令，不是发给模型的提示词，也不是后端清空当前会话。

## 目的与范围

用户在阅读或等待当前会话时，通过输入 `/new` 快速进入同一 cwd 的空白 composer。原会话历史与运行状态保留，不发生 fork、navigate_tree 或原地重置。

与 [新会话项目选择](new-session-project.md) 的区别：本功能沿用当前显示会话的 cwd；项目选择器是在空白 composer 中显式切换目标目录。

## 入口与规则

1. 斜杠菜单应包含 `new`，并声明可在 streaming 时使用。
2. 只匹配 trim 后严格等于 `/new` 的输入。首尾空白允许；`/newfoo`、`/new explain this`、`/new\nexplain this` 不触发导航，而按原有命令/发送流程处理。
3. 优先使用 `ChatWindow` 传入的 `session?.cwd ?? newSessionCwd`，不能偷偷使用侧栏当前选中的另一个项目。
4. 命令分支需要有效 cwd 和 `onNewSession` 回调；复用 composer 未提供这些上下文时，不应凭空建立目录或导航。
5. **先清草稿、后导航**：`clearInput()` 清掉源输入与附图，再调用 `onNewSession(cwd)`；附图不发送、不带到新 composer。
6. 正常发送、运行中的 steer/follow-up 路径都应识别精确 `/new`；不能把命令排进原会话队列。
7. 不调用 `onSend`/模型 prompt，不调用 abort；原会话的运行可继续在后台完成。
8. `AppShell.handleNewSession` 清除已选会话、建立新的 draft key、更新 `?cwd=…`。命令入口传 `restoreParkedDraft=false`，避免恢复同目录先前停放的无关草稿。
9. 打开空白 composer 不等于已创建 `.jsonl` 或 AgentSession；真实运行时按原有首次需要时创建机制处理。
10. 空白会话加载后自动聚焦见 [聊天焦点导航](chat-focus-navigation.md)，不要复制第二套独立聚焦逻辑。

## 实现导航

| 文件 | 定位 |
|---|---|
| [ChatInput.tsx](../../components/ChatInput.tsx) | 内置命令声明、`canRunBuiltinSlashCommandWhileStreaming`、`runBuiltinCommand`、`handleSend`、`sendQueued` |
| [ChatWindow.tsx](../../components/ChatWindow.tsx) | `onNewSession` 与 cwd 传递 |
| [AppShell.tsx](../../components/AppShell.tsx) | `handleNewSession`、命令入口显式禁用 parked draft 恢复、URL 和选中状态 |
| [draft-store.ts](../../lib/draft-store.ts) | 与其他新会话入口共享的草稿持久化和 rekey 机制 |
| [ChatInput.new-session.test.mjs](../../components/ChatInput.new-session.test.mjs) | handler 抽取执行与接线契约 |

## 自动验收

```bash
node --experimental-strip-types --test components/ChatInput.new-session.test.mjs components/AppShell.workspace-memory.test.mjs components/AppShell.file-viewer-state.test.mjs
```

重点检查：精确匹配、trim、附图清理、streaming 的两种队列入口、非匹配输入不导航、cwd 来源、parked draft 不恢复、URL 与会话状态。测试主要抽取 handler/mock 状态并检查源码接线，不替代真实运行中的 UI 验收。

## 人工验收

前置：准备项目 A/B；当前展示项目 A 某 worktree 中的会话，侧栏可切到项目 B。

1. 在当前会话输入 ` /new ` 并提交。**期望**：空白 composer 的 cwd 仍是 A 的具体 worktree，不是 B；URL 不保留旧 `session` 参数。
2. 返回原会话。**期望**：历史未被删除或分叉，源 composer 不残留 `/new`。
3. 附一张测试图片，再执行 `/new`。**期望**：不向原模型发送图片，新 composer 没有附图。
4. 在原会话运行时分别通过普通提交、steer、follow-up 入口执行。**期望**：导航而非排队；原运行不中断。
5. 分别提交 `/newfoo` 和 `/new explain this`。**期望**：不会触发本功能；可能交给原有命令/模型路径，因此仅在可安全发送的测试环境操作。
6. 在同目录保留一份 parked draft 后执行 `/new`。**期望**：新 composer 为空白，不复活那份草稿；其他正常“新建会话”入口原有草稿恢复规则不受影响。
7. 刷新新的空白页。**期望**：cwd 与空白会话导航语义保持，不因上游按标签页记忆机制回到旧会话。

## Rebase 保留清单

- 命令检测须在附图或 streaming 分支把消息发出去之前执行。
- 保留上游 `workspace-memory` / 按浏览器标签页恢复会话逻辑，同时让显式新会话导航使旧恢复失效。
- 不把 `/new` 实现成 `fork`、清空 JSONL、重用旧 wrapper 或自动 abort。
- 不把 `restoreParkedDraft=false` 扩散到所有新建入口；它针对命令要求的空白语义。

当前没有专门证明“真实模型持续运行时 `/new` 不打断”的外部 provider E2E；自动测试覆盖回调与请求分流，真实运行按需验收。

修改命令匹配、cwd、草稿、URL 或后台运行关系时，同步本文件、[README](README.md) 和相关测试。
