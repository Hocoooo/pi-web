# `/new`：在当前目录打开空白会话

> 功能基线：`63c6e4e`。这是前端导航命令，不是发给模型的提示词，也不是后端清空当前会话。

## 目的与范围

用户在阅读或等待当前会话时，通过输入 `/new` 快速进入同一 cwd 的空白 composer，**自动沿用当前已确认的 provider/model、具体 thinking level 和同一任务归属**，无需再次指定。新会话不复制历史或附件；原会话历史与运行状态保留，不发生 fork、navigate_tree 或原地重置。

与 [新会话项目选择](new-session-project.md) 的区别：本功能沿用当前显示会话的 cwd；项目选择器是在空白 composer 中显式切换目标目录。

## 入口与规则

1. 斜杠菜单应包含 `new`，并声明可在 streaming 时使用。
2. 只匹配 trim 后严格等于 `/new` 的输入。首尾空白允许；`/newfoo`、`/new explain this`、`/new\nexplain this` 不触发导航，而按原有命令/发送流程处理。
3. 优先使用 `ChatWindow` 传入的 `session?.cwd ?? newSessionCwd`，不能偷偷使用侧栏当前选中的另一个项目。
4. 命令分支需要有效 cwd 和 `onNewSession` 回调；复用 composer 未提供这些上下文时，不应凭空建立目录或导航。
5. **先清草稿、后导航**：`clearInput()` 清掉源输入与附图，再调用 `onNewSession(cwd)`；附图不发送、不带到新 composer。
6. 正常发送、运行中的 steer/follow-up 路径都应识别精确 `/new`；不能把命令排进原会话队列。[F40 视频附件](video-attachments.md) 是显式例外：选择/上传中的视频不支持任何命令发送（含 `/new`），先明确拒绝并保留问题/附件，移除视频后再执行；原图片行为不变。
7. 不调用 `onSend`/模型 prompt，不调用 abort；原会话的运行可继续在后台完成。
8. `AppShell.handleNewSession` 清除已选会话、建立新的 draft key；项目更新 `?cwd=…`，[独立聊天](independent-chat.md)保持固定隐藏 cwd 并更新 `?chat=1`。命令入口传 `restoreParkedDraft=false`，避免恢复同目录先前停放的无关草稿。
9. 打开空白 composer 不等于已创建 `.jsonl` 或 AgentSession；真实运行时按原有首次需要时创建机制处理。
10. 空白会话加载后自动聚焦见 [聊天焦点导航](chat-focus-navigation.md)，不要复制第二套独立聚焦逻辑。
11. 继承是一份当前 draft 专属的一次性 seed，不是全局默认值或对来源 session 的持续同步。其他新建入口不继承；更换项目清除 seed，仍按 F05 迁移草稿。未创建真实 session 的 seed 仅在页面内存中，刷新不承诺保留。
12. 解析来源归属期间 composer 暂时禁用并防重复提交；读取失败停留在来源会话并显示错误，不悄悄导航为无任务。命令在开始读取前登记显式聊天导航意图，与 workspace 恢复 token 分开；来源首次发送成功后从 draft 自动提升为真实 session 不属于更新导航，不能因此吞掉已请求的 `/new`。用户通过其他入口离开或发起更新的异步任务面板导航后，迟到读取不能触发导航或使更新目标失效。模型设置尚在加载或切换时不复制乐观值，提示重试。

## 任务选择交点

[F32 `/task`](task-picker.md)仍是独立的显式管理命令，不增加 `/new --task` 语法。`/new` 从已有 session 的权威 `task-picker` 查询取得当前归属；来源是空白 composer 时沿用其任务预选，没有任务就保持无任务。提前初始化已取得真实 ID 时，真实 owner 优先于残留的失败预选；仅尚未绑定的 composer 保留该预选。即使在途初始关联失败，也在等待结束后按同一规则取快照，不因提交时间不同丢失继承。等待在途归属写入，读取期间发生新选择则重读；不复用旧 picker 的 owner 快照。

新 composer 直接显示继承任务；正常创建取得真实 session ID 后，复用 `syncPending` 的权威项目校验与 `link` CAS，首次 prompt/bash 前落实关联。关联失败保留真实 ID、继承选择和待发送草稿，重试不重复创建或发送；用户仍可通过 `/task` 解除/改选。归档任务也可继承，不恢复、不改状态或归档标记。归属只改管理元数据，**不注入任务文字、旧对话或共享上下文**。

提供任务入口的 composer 在 `/` 和内置命令前缀期间延迟扩展命令发现，避免输入 `/new` 时为补全意外创建 Agent；输入非内置前缀再按原流程加载扩展。

## 实现导航

| 文件 | 定位 |
|---|---|
| [ChatInput.tsx](../../components/ChatInput.tsx) | 内置命令声明、`canRunBuiltinSlashCommandWhileStreaming`、`runBuiltinCommand`、`handleSend`、`sendQueued` |
| [ChatWindow.tsx](../../components/ChatWindow.tsx) | `handleNewSession` 获取 seed、失败提示、cwd 传递 |
| [AppShell.tsx](../../components/AppShell.tsx) | `handleNewSessionCommand` 按 draft key 传 seed，`handleNewSession` 保留普通入口语义、URL 和选中状态 |
| [useAgentSession.ts](../../hooks/useAgentSession.ts) | `getNewSessionSeed`、启动模型/等级的 state 与 ref 一起初始化、失效来源保护 |
| [useTaskSelection.ts](../../hooks/useTaskSelection.ts) | `taskForNewSession`、预选初始化、复用创建后关联 |
| [draft-store.ts](../../lib/draft-store.ts) | 与其他新会话入口共享的草稿持久化和 rekey 机制 |
| [ChatInput.new-session.test.mjs](../../components/ChatInput.new-session.test.mjs) | handler 抽取执行与接线契约 |

## 自动验收

```bash
node --experimental-strip-types --test components/ChatInput.new-session.test.mjs components/AppShell.workspace-memory.test.mjs components/AppShell.file-viewer-state.test.mjs
# 复用当前 checkout 的健康 dev，不是全局安装的服务；所有 API 被 fixture 截获
node e2e/new-session-inheritance.mjs
node e2e/task-picker-page.mjs
node e2e/task-session-selection.mjs
node e2e/model-first-prompt.mjs
```

既有单测检查精确匹配、trim、附图清理、streaming 队列入口、非匹配输入不导航、cwd、parked draft、URL，部分仍抽取 handler/检查源码。新增继承测试在真实整页 UI 与首次发送 HTTP 边界覆盖同模型/等级/任务、运行中来源、`off`、归档/无任务、读取失败重试、关联失败草稿/ID 复用、项目切换、其他新建入口、更新的任务面板导航、来源自动提升不取消命令和迟到导航；task-picker-page 覆盖桌面/手机×浅深主题空白预选沿用。model-first-prompt 用真实 hook/RPC/SDK 和内存设置/测试 provider 验证继承 `high` 的实际请求以及提前初始化后仍为 `high`，不调用外部 provider、不改用户数据。

## 人工验收

前置：准备项目 A/B；当前展示项目 A 某 worktree 中的会话，侧栏可切到项目 B。

1. 在当前会话输入 ` /new ` 并提交。**期望**：空白 composer 的 cwd 仍是 A 的具体 worktree，不是 B；URL 不保留旧 `session` 参数。
2. 返回原会话。**期望**：历史未被删除或分叉，源 composer 不残留 `/new`。
3. 附一张测试图片，再执行 `/new`。**期望**：不向原模型发送图片，新 composer 没有附图。
4. 在原会话运行时分别通过普通提交、steer、follow-up 入口执行。**期望**：导航而非排队；原运行不中断。
5. 分别提交 `/newfoo` 和 `/new explain this`。**期望**：不会触发本功能；可能交给原有命令/模型路径，因此仅在可安全发送的测试环境操作。
6. 在同目录保留一份 parked draft 后执行 `/new`。**期望**：新 composer 为空白，不复活那份草稿；其他正常“新建会话”入口原有草稿恢复规则不受影响。
7. 刷新新的空白页。**期望**：cwd 与空白会话导航语义保持，不因上游按标签页记忆机制回到旧会话；未创建的继承 seed 不承诺跨刷新保留。
8. 当前会话为任务 A、非默认模型、`high`，执行 `/new` 后直接发送。**期望**：新 session 属于 A，实际使用同 provider/model 和 `high`；旧历史不在新上下文中，全局默认不变。重复验证空白预选任务、无任务、`off`、归档任务及运行中来源。
9. 模拟来源任务读取失败，以及新 session 创建成功但任务关联失败。**期望**：前者不导航且可重试，后者保留草稿/ID 并在成功关联前不发 prompt；其他新建入口或切项目不继承。

## Rebase 保留清单

- 命令检测须在附图或 streaming 分支把消息发出去之前执行。
- 保留上游 `workspace-memory` / 按浏览器标签页恢复会话逻辑，同时让显式新会话导航使旧恢复失效。
- 不把 `/new` 实现成 `fork`、清空 JSONL、重用旧 wrapper 或自动 abort。
- 不把 `restoreParkedDraft=false` 扩散到所有新建入口；它针对命令要求的空白语义。

当前没有专门证明“真实模型持续运行时 `/new` 不打断”的外部 provider E2E；自动测试覆盖回调与请求分流，真实运行按需验收。

修改命令匹配、cwd、草稿、URL 或后台运行关系时，同步本文件、[README](README.md) 和相关测试。
