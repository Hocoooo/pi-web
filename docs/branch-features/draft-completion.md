# 输入时草稿补全（Draft Completion）

## 目的与范围

桌面主聊天输入框在用户停顿后，通过独立模型请求生成一条短后缀，以灰字显示。Tab 采纳为草稿；发送仍需独立操作。支持新会话第一条草稿、已存活会话、休眠历史会话，不为补全启动 AgentSession。

与 [下一轮提示词建议](next-prompt-suggestions.md) 不同：Next Cue 在本轮完成后为空框建议下一条消息；本功能根据**尚未发送的草稿**续写。不能继承 Next Cue 的开启状态。独立 [交互原型](draft-completion-prototype.md) 仅为模拟参考，不是生产入口。

第一版不支持移动端、紧凑引用提问框、光标中间插入、选区改写、多个候选、图片理解或主会话运行时补全。

## 入口、偏好与费用

- 设置 → 常规 → 聊天：`输入时补全草稿（桌面端）`，以及独立的 `草稿补全模型`。
- **默认关闭**。开启前可见说明：会把未发送草稿与少量近期对话发送给所选服务商，产生额外推理费用。取消请求不能保证不计费。
- `pi-web:draft-completion` 存储 `{ enabled, model: null | { provider, modelId } }`；null 跟随当前 composer 模型，不修改主模型，不跟随 Next Cue 的模型偏好。
- 损坏或不可读取的偏好 fail closed；同标签页与跨标签页同步。存储写入失败时，用户明确选择仍在当前标签页生效。
- 候选复用项目范围 `/api/models` 加载和错误处理；不可用模型不静默降级收费。尚无 cwd/模型时不请求。

## 前端行为

1. 开启且主输入框聚焦、页面可见、桌面端、无附图、无选区且光标末尾，草稿至少 4 个 Unicode 码点、最多 8,000 UTF-16 单元时，停顿 **600ms** 后请求。
2. IME 组词、主会话生成/bash/压缩、模型切换、内置命令处理、历史/斜杠/文件或设置菜单、扩展弹窗时暂停。`/` 命令和 `!` shell 输入不作为自然语言草稿补全。
3. 灰字是 textarea 旁的只读镜像层，不进入 value、草稿持久化、撤销记录或发送 payload。镜像复制实际字体/内边距/宽度，随滚动移动，并在 200px 内扩展输入框高度。渲染和滚动时校验灰字每一行完整可见；若最大高度或手动滚动裁掉后缀，会取消整条建议及其 Tab 采纳能力，不能接受看不到的尾部。
4. 只有无修饰键 Tab、非 IME 及其 Enter 保护窗口、无优先菜单时，才采纳灰字。只更新草稿和光标，**不发送**；原生 Tab/Shift+Tab 在没有建议时保留焦点顺序。Enter 只发送实际草稿，不隐式采纳。
5. Esc 取消当前草稿的建议/待发请求；不立即重新弹出。采纳后也不自动连续请求；继续编辑后恢复。
6. session、leaf、cwd、模型、草稿、焦点、光标或阻塞条件变化使请求失效。结果同时检查请求 signal、当前 DOM 草稿/选区、leaf 和请求 key，旧结果不能覆盖新草稿。
7. 同一最近完成的请求 key 不自动重试（含 204 和失败），避免聚焦或重复 render 导致重复收费；不是跨标签页去重/永久缓存。
8. 辅助请求失败静默降级；不影响正常发送、Next Cue、文件/命令补全或 [焦点导航](chat-focus-navigation.md)。

## API 与服务端边界

`POST /api/draft-completion`：

```json
{
  "cwd": "/allowed/project",
  "sessionId": null,
  "leafId": null,
  "draft": "Please inspect this endpoint",
  "model": { "provider": "configured-provider", "modelId": "configured-model" }
}
```

- model 必须为显式 provider/modelId，由前端解析独立偏好或当前 composer 模型。新会话 sessionId/leafId 均为 null；历史会话传实际显示 leaf。
- body 最大 **64KiB**；cwd 最大 4096 单元；模型字段、sessionId、leafId 最大 200 单元；最小草稿长度按 Unicode 码点判断。非法结构/字符拒绝。
- 200 返回 `{ text, leafId }`；204 表示忙碌/过期/取消/超时/无有效建议/可选上游错误；400 参数错误；403 cwd 不允许或 session/cwd 不匹配；404 未知 session；422 模型不可用或不在项目范围。
- 先检查 cwd allow-list（含 symlink），规范化路径后限流。读现有会话并验证 cwd/session/leaf 身份；推理前后重复检查 leaf、wrapper 身份和 idle。当前 cwd 的其他运行会话也会使补全暂停。
- 已有 idle wrapper 复用 modelRuntime，但使用新读取的 enabledModels 设置确认范围。新/休眠会话创建 trust-gated SDK services，不创建 AgentSession、不运行 session prompt、不启动休眠 wrapper、不主动刷新远端模型目录。服务准备仍可能加载被信任的扩展，不承诺完全无扩展副作用。
- 休眠文件只读解析为内存 SessionManager，避免 SDK open 的迁移重写；文件大于 **16MiB** 或读取时发生变化则 fail closed。
- 上下文采用当前活动分支投影中最近最多 **6 条 user/assistant 文本消息**，每条 user 尾部最多 500 码点、assistant 最多 1000 码点；不传工具结果、thinking、图片或摘要。
- 独立 `completeSimple`，`tools: []`、`toolChoice: "none"`、`maxTokens: 100`、零自动重试。只生成后缀，不修改聊天消息、队列、主模型或思考等级。
- 输出必须正常 stop，无工具调用、换行/控制字符，最多 100 码点，不能回显整份草稿；保留英文续写所需的前导空格。
- 请求取消信号与 **8 秒 deadline** 组合，包括请求读取与准备阶段。可选错误不返回上游异常或凭证。
- 同一规范化 cwd、同一 session 均只允许一个请求；进程全局最多 **4 个**，不排队。不响应取消的 provider 在真正结束前仍占用名额，防止打字持续堆积收费请求。

## 实现导航

- [draft-completion-server.ts](../../lib/draft-completion-server.ts)、[route.ts](../../app/api/draft-completion/route.ts)：校验、只读上下文、授权、模型 scope、独立推理、并发与取消。
- [draft-completion-preference.ts](../../lib/draft-completion-preference.ts)、[useDraftCompletionPreference.ts](../../hooks/useDraftCompletionPreference.ts)：独立 opt-in 与持久化。
- [useDraftCompletion.ts](../../hooks/useDraftCompletion.ts)：防抖、DOM/IME/焦点保护、取消与过期响应。
- [DraftCompletionGhost.tsx](../../components/DraftCompletionGhost.tsx)、[ChatInput.tsx](../../components/ChatInput.tsx)：灰字呈现、Tab 采纳、原生输入保持。
- [ChatWindow.tsx](../../components/ChatWindow.tsx)：显式 session/leaf 接线，仅主 composer 开启能力。
- [SettingsPanel.tsx](../../components/SettingsPanel.tsx)、`lib/i18n/messages/{en,zh-CN,zh-TW}.ts`：设置与隐私说明。

## 验收

```bash
node --experimental-strip-types --test lib/draft-completion-preference.test.mjs lib/draft-completion-server.test.mjs app/api/draft-completion/route.test.mjs components/ChatInput.test.mjs components/SettingsPanel.test.mjs components/ChatWindow.focus-navigation.test.mjs
node e2e/draft-completion.mjs
node e2e/settings-commands.mjs
node_modules/.bin/tsc --noEmit
```

本轮验证：新增与相关回归共 **98 项通过**；`tsc --noEmit`、改动 TypeScript/TSX 文件的 ESLint、`git diff --check` 通过；两个浏览器脚本通过（设置命令含桌面/移动视口）。未运行生产构建，也未使用真实 provider 计费请求。

- 服务端行为测试与真实 route handler 的 mock IO 检查覆盖新/休眠/活跃会话、信任/授权、叶节点变化、范围、无修改、错误隐藏、超时和并发上限；不调用真实 provider。
- 浏览器测试挂载真实 ChatInput + Hook，mock fetch（刻意忽略取消以测试旧结果），覆盖默认关闭、新草稿、模型选择、Tab/Enter/Esc、IME 事件、选区、命令菜单、busy、切分支、多行镜像、200px 长草稿溢出不可采纳、重新开启不复活旧建议、compact 与移动端。
- 移动布局源码断言位于 `components/MobilePwaLayout.test.mjs`：灰字 wrapper 承担 flex 收缩，textarea 保留 `minWidth: 0` 与 `width: 100%`。接入后全量测试修复了该旧结构断言，不是去掉移动端宽度保护。
- 回归特别保留：不要在 native `input` 监听器里同步写 React 状态/取消新请求；它可能与受控 textarea 的 onChange 顺序冲突，吞掉替换输入或取消刚为新值建立的请求。以 React value key 驱动请求失效，并在返回时检查真实 DOM。
- 真实中文输入法、系统 Tab/撤销行为、各平台字体/缩放与长文本滚动、真实 provider 质量/延迟/费用仍需人工验证，不能用 mock 宣称真实推理验收。

人工流程：开启并选择可用的低延迟模型 → 在新会话输入半句话并停顿 → Tab 采纳后确认无聊天请求 → Enter 发送 → 在历史会话重复 → 在请求期间切模型/分支/会话、关闭开关、输入中文/打开菜单，确认旧灰字不复活。该人工流程会产生额外模型费用。

## 集成限制

- 新/休眠请求的服务准备暂未缓存，受信任扩展发现成本可能影响延迟；超时返回无建议。超大历史文件暂不补全。
- 取消不保证退款；永久不结束的 provider 将占用限流名额直到进程结束。这是防堆积策略，不是可无限恢复的任务队列。
- 当前不提供补全失败通知或手动重试按钮。需要继续编辑或更换模型才能触发新的 key。
- 修改成本、上下文、默认值、Tab 优先级、scope 或生命周期时，同步本文件、相关测试、[索引](README.md) 及 F08/F10 契约；不要改回启动 AgentSession 的推理路径。
