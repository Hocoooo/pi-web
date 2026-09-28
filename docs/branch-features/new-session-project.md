# 空白新会话的项目选择

## 目的、用户价值与范围

在[全项目侧边栏](all-projects-sidebar.md)隐藏传统项目选择器后，让用户在尚未开始的新会话中确认或更换目标目录，同时携带未发送草稿，避免误恢复该项目的旧会话。

本功能是新会话编辑区顶部的“会话项目”选择器，不是侧边栏项目标题、worktree 管理器或已存在会话 cwd 编辑器。目录浏览/验证、草稿存储与运行时创建沿用既有机制；`/new` 只作为进入新会话的交互边界说明。

## 入口与当前默认值

选择器仅在 `sidebarView.mode === "all"`、`isEmptyNew`、非空 `newSessionCwd`、存在 `onNewSessionProjectChange` 时显示。

- `isNew`：`session === null && newSessionCwd !== null`。
- `isEmptyNew`：`isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy`，其中 busy 包括 agent/bash 运行。
- 初始显示当前 `newSessionCwd`，并非一律项目根。输入框内有未发文字或图片不取消“空白新会话”资格。
- 可从侧边栏“新建”或既有新会话导航进入；默认 current 模式不显示此选择器。

## 行为要求与不变量

1. **候选来源。** 挂载时请求 `/api/sessions`，用 `getRecentProjects` 得到按活动排序且按 project key 去重的最近项目。当前 cwd 始终作为首个 option；其他 option 使用项目 root，排除与 cwd 字符串完全相等的 root。当前 cwd 可以是 worktree 路径，候选不是完整 worktree 列表。
2. **按需浏览。** “选择目录”打开共享 `DirectoryPicker`，从当前 cwd 开始。路径输入先导航到可浏览目录，再由选择动作提交验证；最近列表加载失败/非 2xx/解析失败时不显示列表错误，当前 cwd 与浏览按钮仍可用。
3. **先验证再切换。** 不同 candidate 经 `POST /api/cwd/validate`（`{ cwd: candidate }`）验证。成功必须包含 cwd、projectKey，且 response.ok、无 error；本选择器不要求 projectRoot 字段。使用返回的规范 cwd/key，而非直接信任 option 文本。
4. **验证语义。** 服务端 trim 路径，支持 `~`/`~/`、相对路径解析，检查存在且为目录，计算项目身份并登记可访问文件根。验证目录不是启动模型、保证 Git 仓库或绕过项目信任确认；不存在/文件路径返回 400，其他异常返回 500。
5. **并发与失败。** `pending` ref 阻止并发验证，busy 时 select/浏览按钮禁用，目录对话框不可取消。网络、JSON、非成功响应或缺失字段异常显示错误；浏览中错误交给对话框，否则 `role="alert"` 显示。失败保留原 cwd、URL、草稿，随后可以重试。candidate 与 cwd 完全相同时不发请求并关闭浏览。
6. **开始后的隔离。** 验证回包仅在 picker 仍挂载时调用 `onChange`；发送/运行导致 picker 卸载后，不得用迟到响应更换已启动会话。AppShell 还拒绝 `selectedSession` 非空或 cwd 未变化的回调。验证 POST 本身没有 AbortController；这里只阻止迟到结果应用，不承诺取消服务器工作。
7. **草稿迁移。** `handleNewSessionProjectChange` 先失效工作区恢复请求，用新 UUID 和 cwd 生成 `new:<id>:<cwd>` key，把原活动新草稿 `rekeyDraft` 到新 key；保持草稿文字及图片的数据。`draft-store` 是模块内存 Map，不能据此承诺刷新后草稿仍在。
8. **保持新会话身份。** 在侧边栏同步前写 `activeProjectKeyRef`，更新 active/new cwd 和 draft ID，递增 `sessionKey` 重新挂载聊天；不按目标项目的 last-open 记忆恢复旧 session。URL 替换为 `?cwd=<encoded cwd>`（无 session 参数、不滚动），刷新可据 cwd 回到新会话目标，但不保证草稿持久化。
9. **清理上下文。** 切项目清空文件 tabs、活动文件、系统提示/工具信息，关闭右面板和顶部活动面板，防止展示旧项目内容。此路径不专门关闭侧边栏。选择器隐藏/显示只跟随 sidebar mode，不主动清空已有草稿或改 cwd。
10. **创建边界。** 仅切目录不会创建会话或发送提示；下一次 `ensureNewSession` 请求 `/api/agent/new` 使用新的 `newSessionCwd`。不要强化成“只有第一条消息才能创建”：既有 System/Tools 等非 prompt 初始化路径也可 ensure/promote 新会话。
11. **`/new` 交互区别。** 完整 `/new`（trim 后完全相等）在可用 cwd/回调下导航到当前聊天 cwd 的空白新会话，先清源文字/图片；它不携带当前草稿，且通过 `handleNewSession(..., false)` 不恢复 parked 草稿。更换项目则携带草稿。侧边栏新建默认仍可恢复该 cwd 的 parked 草稿。带参数 `/new ...` 不是此导航入口。

## 实现地图

| 路径 | 关键符号/职责 |
| --- | --- |
| [NewSessionProjectPicker.tsx](../../components/NewSessionProjectPicker.tsx) | `NewSessionProjectPicker`、`select`、`mounted`/`pending`，候选请求、验证及错误 |
| [ChatWindow.tsx](../../components/ChatWindow.tsx) | `isEmptyNew`、picker 挂载条件、新会话 composer 自动聚焦、`cwd={session?.cwd ?? newSessionCwd}` |
| [AppShell.tsx](../../components/AppShell.tsx) | `handleNewSessionProjectChange`、`handleNewSession`，恢复隔离、草稿/URL/面板协调 |
| [draft-store.ts](../../lib/draft-store.ts) | `ChatDraft`、`rekeyDraft`、内存 `drafts`，文字和图片迁移 |
| [DirectoryPicker.tsx](../../components/DirectoryPicker.tsx)、[验证路由](../../app/api/cwd/validate/route.ts) | `navigateTo`、`canSelect`、`POST`；浏览与验证是两步 |
| [useAgentSession.ts](../../hooks/useAgentSession.ts) | `isNew`、`ensureNewSession`、`promoteNewSession`，后续运行时与正式 ID |
| [ChatInput.tsx](../../components/ChatInput.tsx) | `runBuiltinCommand`、`clearInput`，`/new` 与携带草稿的区别 |

## 自动化验收

所有命令从仓库根目录执行；以下是可用覆盖说明，具体运行结果须在各次维护任务中记录。

```sh
node --experimental-strip-types --test components/ChatInput.new-session.test.mjs components/ChatInput.test.mjs
```

[ChatInput.new-session.test.mjs](../../components/ChatInput.new-session.test.mjs)从 TS AST 提取实际回调，在 VM 中注入 mock state/router/rekeyDraft，验证切项目的 URL、身份写入和草稿迁移调用；同时覆盖 `/new` 的严格匹配、streaming/图片路径以及 parked 草稿区别。它不是 React 挂载测试，也没有真实请求 `/api/cwd/validate`。[ChatInput.test.mjs](../../components/ChatInput.test.mjs)中的草稿用例调用真实 `rekeyDraft` 和恢复合并函数，检查临时 key 迁移及文字/图片恢复；不能证明浏览器刷新持久化。

先在另一终端运行 `npm run dev`，确保安装 Chromium（`npx playwright install chromium`）。Git Bash/POSIX shell：

```sh
E2E_BASE_URL=http://127.0.0.1:30141 node e2e/new-session-project.mjs
```

[new-session-project.mjs](../../e2e/new-session-project.mjs)在真实 Chromium、全 API 拦截 fixture 下检查 current 模式隐藏、all 模式显示、A↔B 切换仍为新会话、文字草稿保持、模式来回切换、390px 宽移动布局，以及 `/api/agent/new` 请求的 cwd。最后只断言发出的请求，不证明真实运行时成功。脚本未覆盖图片、验证失败、迟到回包、真实目录/信任流程，且不由 `npm run test:e2e` 自动运行。

## 手工验收

前置：隔离测试目录 A/B（B 已有可恢复的旧会话），一个真实 worktree 路径 W；开启 all 模式，从 A 新建，准备无敏感内容的文字及小图片。发送步骤可能启动 agent，使用测试配置/凭据。

1. 确认选择器显示 A；输入文字并附图片，选 B。成功后 URL 只有 B 的 cwd，无旧 session 参数；草稿文字和图片仍在，不打开 B 的旧聊天，旧文件/系统面板内容被清空。再选 A，结果一致。
2. 通过“选择目录”浏览 W 并确认：应显示服务器返回的 W cwd；最近候选可仍是项目根。取消浏览或重新选择当前 cwd，应保留 URL/草稿。
3. 浏览不存在路径：应显示浏览错误且不能直接选未导航成功的路径。模拟验证接口 400、断网或无效 JSON 后选不同项目：应显示错误，保持旧 cwd/草稿；恢复接口再试应成功。慢请求期间 select 和浏览按钮禁用，快速重复操作不得产生并行验证。
4. 用网络延迟保留一个验证请求，在非模态选择场景先发送原 cwd 的草稿使 picker 卸载，再放行响应：应不把已开始聊天改到候选目录。记录请求顺序以区分“验证先完成再发送”的正常新 cwd 路径。
5. 切换 current/all：选择器隐藏/恢复，但 cwd/草稿保持。刷新后检查 cwd URL 仍可恢复目标；不要要求内存草稿重现。
6. 成功切到 B 后发送，检查 `/api/agent/new` 的 cwd 为 B；已有 session、运行中或有消息的聊天不得出现可改 cwd 的选择器。另试 `/new`：应清源草稿而非迁移到新会话。

## Rebase 保留清单与上游交互

- [ ] 空白新会话资格继续取真实会话/消息/运行状态，而不是 textarea 是否为空。
- [ ] 保留验证后规范 cwd/key、pending 防并发与卸载后回包隔离；复核共享 DirectoryPicker 的 busy/cancel 语义。
- [ ] `activeProjectKeyRef` 与恢复请求失效必须先于侧边栏 cwd 同步；目标项目存在旧会话时仍保持新会话。
- [ ] 草稿文字和图片按 key 迁移；与 `/new` 清源草稿、普通新建恢复 parked 草稿区分。
- [ ] 上游改会话 ensure/promote、信任、System/Tools 初始化或模型设置时，检查 picker 的卸载时点及下一次创建 cwd。
- [ ] 模式切换只影响入口可见性，移动布局及三种语言的标签仍可达。

## 已知限制与未验证区域

候选只在挂载时加载，不实时跟随新项目；最近列表失败静默降级。没有验证超时/POST 取消，也不禁用整个 composer 等待验证；请求竞争依赖卸载检查。草稿只存内存，图片迁移和真实验证失败暂无该浏览器脚本覆盖。此路径调用 `crypto.randomUUID()` 没有侧边栏临时 ID 那样的 fallback，需支持该 API 的浏览器上下文。

## 维护规则与基线

固定基线 **`63c6e4e`**，对照 `origin/main` 的 `96966e5`：新增 picker、ChatWindow 挂载及 AppShell 迁移路径，复用原目录验证、草稿和运行时创建。改变这些路径时同步修订契约、mock/浏览器覆盖边界和相关全项目文档；重新核对后才显式更新基线，不把该值改成无条件“最新”。
