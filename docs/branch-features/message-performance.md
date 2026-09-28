# 消息与会话性能统计（TTFT / tok/s）

## 目标与用户口径

在 assistant 消息上显示首 token 延迟与生成速度，完成后、刷新后仍保留；在会话信息面板显示平均生成速度与平均 TTFT。**模型开始输出就算首 token，不要求正文出现**。历史缺失数据不补零，也不反推。

## 不变量

- 每次 SDK `agent.streamFunction` 调用独立计时；从调用原函数之前开始，用服务端单调时钟 `performance.now()` 计算时长，不依赖浏览器到达时间、用户发送时间或 `message_start`。
- 首个非空 `text_delta`、`thinking_delta`、`toolcall_delta` 是首次输出；空字符串不算，空白字符算。开始事件、工具名称、只有签名的隐藏思考、最终完整内容不能代替首次 delta。
- TTFT = 请求开始至首次有效增量；generationMs = 首次有效增量至终止响应（含末尾用量上报）。这不是 provider 内部测量的物理 token 生成时间。
- 消息最终速度 = provider `usage.output / generationMs * 1000`；不额外累加 reasoning token。流式速度用估算输出 token 数和服务端 generationMs，明确显示 `≈`。
- 会话平均速度 = 有效样本的总输出 token / 总生成时间，不是逐消息速度算术平均；平均 TTFT = 有效请求 TTFT 的算术平均。
- 成功终态 `stop` / `toolUse` / `length` 可纳入会话平均；`error` / `aborted` / `deferred` / `pending` 不纳入。失败消息可以保留实际观测到的 TTFT，但不显示成功生成速度。
- TTFT 为 0 是有效值；生成时长为 0、缺失/负数/非有限 output 的样本不计速度，但可计 TTFT。有效零输出计为 0 tok/s，其生成时长仍计入会话速度分母。没有有效 delta 时 TTFT/generationMs 都为 null。
- 聚合整个会话文件的 assistant 消息，包括压缩前历史和其他已执行分支，与现有费用统计范围一致。压缩、分支摘要、cache warming、工具结果里的嵌套用量不是普通 assistant 性能样本。子代理在各自 session 中统计，父会话不重复累计。

## 数据与运行时

- `lib/request-performance.ts` 包装既有 streamFunction，保留 SDK 的认证、请求选项与缓存逻辑。单一 eager relay 消费原流并转发所有事件；不得再开第二个迭代器观察同一 FIFO 流。
- `AgentSessionWrapper.start()` 安装追踪，因此正常 Web、[headless RPC](headless-rpc.md) 与 built-in subagent 都经过同一入口，不改变 draining、完成通知和扩展 UI 行为。
- assistant 上保存版本化 `piWebPerformance: { version: 1, ttftMs, generationMs, totalMs }`。无需追加独立 custom entry：它会改变树叶，且在分支截止点易与目标消息分离。
- SDK 0.87.1 的 SessionManager 将整个 assistant 对象 JSON 序列化，重新加载、上下文映射、分支复制保留该字段。此行为有真实 SDK 回归测试，但字段本身不是 SDK 声明的公共性能字段；升级 SDK 必须复验。
- `message_end` 扩展可能原地替换字段。追踪器以最终消息对象为 WeakMap key 暂存计时，wrapper 在同步订阅器中恢复，再转发 SSE；该回调发生在 SDK 持久化之前。
- 每次 SDK 重试/工具续轮重新计时，不累计上一次失败或工具执行等待。provider 自身内部重试不暴露独立边界，等待包含在本次 SDK 请求中。
- 流式部分消息携带相同 metadata；SSE delta 投影只传小型计时字段、不重传完整 partial。重连 snapshot 保留服务端已累计时长，浏览器不重新开始计时。
- 文件统计和实时消息增量通过 `mergeSessionStats` 合并，加载后的样本不重复累计；`get_session_stats` 同样返回性能汇总。

## 实现地图

- `lib/message-performance.ts`：数据校验、单消息速度、累计量和平均值。
- `lib/request-performance.ts`、`lib/rpc-manager.ts`：请求流边界、扩展替换恢复和 RPC 统计。
- `lib/types.ts`、`lib/pi-types.ts`：消息 metadata 与会话累计类型。
- `lib/agent-event-wire.ts`、`lib/streaming-message.ts`：SSE 精简投影与 reducer。
- `lib/session-stats.ts`：全文件统计和加载基线增量合并。
- `components/MessageView.tsx`：实时/完成后的 TTFT、tok/s。
- `components/AppShell.tsx`、`components/ChatWindow.tsx`：会话平均值、刷新依赖与样本数 tooltip。
- `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`：标签与口径说明。静态 `demo/` 未同步本功能。

## 验收

```bash
node --test lib/request-performance.test.mjs lib/message-performance.test.mjs lib/session-stats.test.mjs lib/streaming-message.test.mjs lib/agent-event-wire.test.mjs lib/agent-event-stream.test.mjs lib/session-reader.pagination.test.mjs components/MessageView.test.mjs "lib/rpc-manager*.test.mjs"
node node_modules/typescript/bin/tsc --noEmit
npm run lint
```

新增自动化验证：

1. text/thinking/tool 参数首增量、空增量、空白、无 delta、异步 provider 初始化、消费延迟、重试/工具间隔。
2. provider 抛错、abort、无终止事件的 `end(result)` 均能结束 relay；恢复被删除的 metadata。
3. 使用隔离临时目录、假 provider 和真实 SDK：wrapper 计时 → message_end → SessionManager 写盘 → 重新打开 → UI 历史/分支复制；RPC 会话统计。
4. SSE 投影与重连 snapshot 的 reducer 保留计时；无完整 partial 泄漏。
5. 加权速度、算术平均 TTFT、未知版本/坏值、历史缺失、零时长、失败过滤、全文件与增量去重。
6. React 静态渲染确认完成后显示、流式估算标记和历史缺失不显示。

本次验证记录：上述定向测试 175/175 通过，TypeScript 检查通过，变更文件 ESLint 无告警。全仓库 ESLint 无错误，`test-results/keyboard/` 中有两条既有 unused-import 告警。全量 `npm test` 为 1471 项：1460 通过、6 失败、5 跳过；在 `git archive HEAD` 的隔离副本中运行对应五个测试文件，复现相同六项失败（directory-browser 符号链接、enabled-models-runtime 项目覆盖、project-command-env PATH、subagent-input 符号链接，以及 terminal-manager 两项 PTY 行为）。这说明未发现新增全量回归，但不代表全量验收已通过。

人工验收：新建请求，先思考再正文/工具；首次有效输出即显示 TTFT，完成后显示最终 tok/s。流式途中刷新/切换回来检查 TTFT 不重算；完成后刷新检查值不变。执行工具循环并检查每次 assistant 请求单独计时；会话面板 tooltip 显示有效样本数。用旧 session 验证无虚假的 0s。

本次未进行真实 provider 的浏览器联调，不把静态组件渲染或假 provider SDK 集成测试称为真实网络 E2E。热更新不会给既有活跃 wrapper 补装追踪；需创建新的运行实例（例如开启新会话或重启服务）。只刷新浏览器或重载扩展不能保证安装追踪；已完成历史无法补算。

## Rebase 与维护

- 高交叉点：rpc-manager 的 start/subscribe、SDK streamFunction、message_end 持久化顺序、MessageView 流式展示、ChatWindow statsKey、session-stats 的增量合并。
- 不用浏览器 timer 或日志 timestamp 替代服务端请求计时；不把总会话活跃时间当生成时间。
- 保留紧凑 SSE 和重连 snapshot 行为；SDK 若提供原生 timing 字段，可在验证其边界、重试和持久化语义等价后替换。
- 新增/修改样本口径时同步本文件、i18n tooltip 和计算测试；修改分支/压缩统计时复验全文件范围不变。
