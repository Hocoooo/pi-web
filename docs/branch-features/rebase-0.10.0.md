# 2026-10-08：同步到 Pi Web 0.10.0 / Pi SDK 1.0.0

## 来源与保留点

- 上游来源：用户先在 GitHub 将 `agegr/pi-web` 同步到 `Hocoooo/pi-web`；本次成功 `git fetch origin`，以 `origin/main` 的 `cf3ebfba58b13ebfdc4bb6c8055788e7207266b7` 为基线。
- 整合前个人分支：`d1e43ff`；相对共同祖先，主线独有 132 个提交，个人分支独有 27 个提交。27 个提交全部重放，没有 skip。
- 原个人分支指针：`backup/personal-customizations-before-rebase-20261008`。
- 原先九个未提交文件独立保存在 `backup/personal-customizations-pre-upstream-20261008-204145` 的 `6d1b315`；它们不属于本次重放范围，未 cherry-pick 回个人分支。
- 本地主线 fast-forward 到上述 `origin/main`。个人包版本为 `0.10.0-personal.6`，四个 Pi SDK 依赖沿用上游 `1.0.0`。

## 主要整合决策

1. 保留上游 MCP、会话编辑、显式默认模型/等级、Markdown 中日韩与用户换行、SSE 与安全修复。根 AGENTS 采用上游拆分后的结构，补回独立聊天契约链接，而非恢复旧版整份架构说明。
2. 两步模型选择和显式默认星号并存：普通选择在确认等级后才提交；星号是单独的“使用并保存默认值”动作，不触发额外两步确认。保留项目覆盖保护。手机普通打开不自动弹键盘，`/model` 明确命令仍聚焦搜索；延迟的旧弹层焦点恢复不能抢占新弹层。
3. 有意保留个人差异：固定 `<agent-dir>/chat-workspace` 替代上游按日期 cwd；两步设置仍 idle-only，不采用上游运行中调整 thinking 的交互。实际回合等级展示不变。对应 [独立聊天](independent-chat.md)、[模型选择](model-thinking-picker.md)。
4. 保留上游删除会话的最新 ref 检查，并以该 ref 的 `sessionKind` 决定聊天 URL；修复自动合并残留的旧 `selectedSession` 引用。
5. Markdown 插件同时保留 MDAST 与 HAST，避免重名 `Root` 类型导致编译和运行时转译失败。保留桌面文件链接和 PDF page 语义。
6. `assess_subagent` 适配 SDK 1.0 的 `model-only` 暴露策略；它仍不授权、阻止或自动执行委派。保留上游 subagent skills binding 和 MCP policy。
7. CLI 保留 preview-mode secret 轮换安全修复与 Windows 隐藏窗口配置。启动测试隔离轮换 IO，绝不以真实 checkout 的 manifest 为测试 fixture。
8. 显式新增开发依赖 `esbuild`，因为个人浏览器 fixture 直接使用它，而 SDK 1.0 的依赖树不再间接提供。测试 VM 补齐上游新增的 Enter 发送偏好与 MCP helpers；按新组件边界更新源码断言，不删除功能覆盖。

## 验证结果

环境：macOS arm64，Node 26.0.0。先执行干净依赖安装，再补齐显式 esbuild 开发依赖和匹配 Playwright 版本的 Chromium。

- `npm test`：2600 项，2596 通过、0 失败、4 跳过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `npm run lint`：通过，无错误或告警。
- `git diff --check`：通过；受控源码/文档未残留冲突标记。
- `node e2e/model-flow.mjs`：桌面 1100px、手机 390px 通过；包含搜索、键盘、能力、取消、错误保留、busy、默认星号与手机焦点。
- `node e2e/settings-commands.mjs`：桌面/手机通过，包含 `/model`、`/thinking`、IME 与忙碌命令路由。
- `node e2e/model-first-prompt.mjs`：通过，使用真实 SDK 和隔离测试 provider 验证首次请求有效 thinking。
- `node e2e/draft-completion.mjs`：通过，mock provider/HTTP 验证 opt-in、Tab/Enter/Esc、过期响应和移动端保护。

## 边界与后续

- 本轮没有运行生产 build、启动新的 Next 服务、更新全局 npm 安装、发布包或推送重写后的个人分支。运行中的全局服务仍是原安装版本。
- 浏览器 fixture 不等于真实 provider、桌面应用、Windows Explorer 或完整侧栏/独立聊天服务 E2E；这些没有本轮 live 验收。
- 安装依赖时 npm 报告 19 项审计问题（6 low、4 moderate、9 high）。未运行可能引入破坏性依赖变更的 `npm audit fix`；本任务不宣称消除既有依赖风险。
- Rebase 改写了已发布的 27 个个人提交；未来推送必须复核远端没有新增提交，再使用显式 expected-OID 的 `--force-with-lease`，禁止裸 `--force`。
