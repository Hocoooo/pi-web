# 下一轮提示词建议（Next Cue）

> 功能基线：`63c6e4e`。这是可关闭、可指定模型的辅助生成；建议不会自动发送。

## 目的与范围

正常完成一轮对话后，在空输入框提供一条用户下一步可能发送的短消息。用户按 Tab 采纳为草稿，再通过独立的发送动作提交。该辅助请求不得修改原会话的消息、工具队列、模型或思考设置。

已有草稿的停顿续写由独立的 [输入时草稿补全](draft-completion.md) 负责：默认关闭、有独立模型和草稿上传说明，不能复用本功能的默认开启状态。两者都在现有补全菜单和 IME 之后处理 Tab，且只填草稿。

不做自动继续对话、不生成多个候选、不执行工具、不为休眠会话创建运行时。即使主任务已完成，也可以建议一个具体的后续工作步骤，不承诺每次都有结果。

## 入口、默认值与持久化

- 设置面板提供开关与建议模型选择；`null` 表示跟随当前对话模型。
- 浏览器存储 key：`pi-web:next-cue`，结构为 `{ enabled, model: null | { provider, modelId } }`。
- **首次默认开启**，模型默认跟随会话；损坏 JSON、无效字段或不可读取存储时 fail closed，禁用建议。
- 同标签页立即生效，跨标签页通过 `storage` 事件同步；写入存储失败仍在本标签页保持选择。
- 指定建议模型不会改变聊天模型。设置候选通过项目范围 `/api/models` 获取，不能绕过可用性判断；HTTP 200 中的模型错误也应作为错误处理。

## 行为要求

### 前端触发与交互

1. 只在已记录的本轮 `settledRun` 与当前 session 匹配、会话不忙且功能开启时请求；不是每次打开历史会话都付费生成。
2. 等待约 200ms，让完成后的 active leaf 刷新先落地，再 POST `/api/sessions/[id]/next-cue`，body 为 `{ model }`。
3. 切换会话、分支、模型偏好、关闭开关或进入新一轮时取消旧请求。结果必须与当前 session、active leaf 匹配，过期结果不展示。
4. 建议用空白 composer 的 placeholder 展示；有文字或附图时不展示，紧凑 composer 不展示，不覆盖用户内容。
5. 只有无修饰键 Tab，且非 IME、非 streaming、非 compact、无文字/附图、无历史/斜杠/文件补全菜单时，才采纳建议。
6. 采纳只填入输入框并清除当前建议，**不发送消息**。Enter/发送按钮仍需另一次用户操作。Tab 不应恢复为旧版“跳消息区”快捷键。
7. 非成功响应、空结果和网络错误静默降级，不影响主对话。

### 服务端与数据边界

8. 路由只使用已经存活的 wrapper，不为提示启动休眠会话。不存在的 session 返回 404；存在但无存活 wrapper 返回 204。
9. 请求必须包含 `model`；可以是 null 或有效 provider/modelId 对象。字符串非空且长度不超过 200；非法请求返回 400。指定不可用模型返回 422，不静默换一个模型收费。
10. 使用请求取消信号与 12 秒超时组合；可选建议的其他 provider 错误返回 204，不泄露上游凭证或异常细节。
11. 只读当前活动分支：最近一个 user/assistant 消息必须是正常 `stop` 的 assistant；最新用户消息必须有文本。失败、截断、用户尚无回复、只有图片的最新用户请求均不退回旧轮次凑建议。
12. 上下文取最近一轮附近的 user/assistant 文本：最近采集最多 6 条，若窗口中缺少发起请求则额外补入最近用户消息；用户尾部最多 500 字符、assistant 尾部最多 1000 字符。工具结果、thinking、图片不作为文本发送。
13. 用 `modelRuntime.completeSimple` 独立请求，`maxTokens: 100`、`toolChoice: "none"`；只生成一条匹配用户语言的短消息，不调用主会话 `prompt`。
14. 输出须为正常 `stop` 的文本；去除首尾引号/反引号后非空、无换行、最多 100 个 Unicode 码点，且包含字母或数字。非法输出直接丢弃。
15. 请求前后都检查 idle；返回前再次检查 active leaf 没变。另一标签页/扩展启动运行后不能把旧建议送回。

## 实现导航

- [next-cue.ts](../../lib/next-cue.ts)：`getNextCueContext`、`generateNextCue`、`parseNextCue`、请求选择验证。
- [next-cue 路由](../../app/api/sessions/[id]/next-cue/route.ts)：已存在 wrapper、HTTP 状态、超时与错误隐藏。
- [next-cue-preference.ts](../../lib/next-cue-preference.ts)、[useNextCuePreference.ts](../../hooks/useNextCuePreference.ts)：默认值、浏览器存储与订阅。
- [next-cue-models.ts](../../lib/next-cue-models.ts)：设置候选加载与错误处理。
- [SettingsPanel.tsx](../../components/SettingsPanel.tsx)：开关、建议模型、项目范围。
- [ChatWindow.tsx](../../components/ChatWindow.tsx)：settled 后请求、abort、leaf 防陈旧校验。
- [ChatInput.tsx](../../components/ChatInput.tsx)：placeholder 和 Tab 采纳。
- [useAgentSession.ts](../../hooks/useAgentSession.ts)：`settledRun` 的产生和清除。

## 自动验收

```bash
node --experimental-strip-types --test lib/next-cue.test.mjs lib/next-cue-preference.test.mjs lib/next-cue-models.test.mjs "app/api/sessions/[id]/next-cue/route.test.mjs" components/ChatInput.test.mjs components/SettingsPanel.test.mjs
```

包含上下文边界、异常/过期结果、模型选择、偏好同步、Tab 不自动发送等纯函数/mock/source-contract 检查。路由测试对真实 route handler 的覆盖目前重点是非法请求先被拒绝；**不能据此宣称所有 204/404/422、timeout 与真实计费流程都有端到端覆盖**。

## 人工验收

前置：可安全调用的测试 provider、已存活会话、可观察网络请求；注意会产生额外模型费用。

1. 正常完成一轮，保持输入框为空。**期望**：出现短建议，网络中是独立 next-cue 请求；主会话历史没有多出消息。
2. 按 Tab。**期望**：只填草稿；直到再次发送前无新主对话请求。
3. 输入文字、附图、开补全菜单或使用 IME。**期望**：Tab 不误采纳，不覆盖草稿。
4. 关闭功能、刷新、打开另一标签页。**期望**：偏好同步且不再自动请求。
5. 指定另一个可用模型并完成一轮。**期望**：建议走指定模型，主会话模型/等级不变。
6. 请求中切换分支/会话或启动新一轮。**期望**：旧请求取消或结果被丢弃。
7. 删除指定模型可用性、模拟超时/失败，或以失败/截断回复结束。**期望**：无错误建议、无自动重发主对话、界面正常可用。

## Rebase 风险与已知边界

- 完成事件、SSE 重连、active leaf 和 session cache 都是敏感交点。保留上游 `prompt_done`/`agent_settled` 生命周期修复，不把第一条 `agent_end` 等同于整轮完成。
- 上下文会发送给所选 provider；这是额外推理请求，不是纯本地计算。没有跨标签页全局去重或绝对一次计费保证，取消也不保证上游免计费。
- 系统提示中的“忽略对话格式指令”与输出验证不是通用提示注入防护证明。
- 真实 provider 费用、取消和网络竞态需人工/专用集成环境验收。

变更默认开启策略、上下文范围、存储 schema、模型选择、成本或 Tab 优先级时，必须更新本文件、[README](README.md) 及相关测试。
