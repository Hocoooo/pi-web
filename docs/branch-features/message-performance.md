# 消息与会话性能统计（TTFT / tok/s）

## 新建与切换诊断补充

`PI_WEB_PERF=1` 现在覆盖新建路由、runtime 初始化/扩展绑定、会话列表和详情/state；浏览器 opt-in 通过 trace/request ID 关联响应头、JSON 读取和状态更新。服务端输出阶段、等待心跳、事件循环延迟及进程 CPU/内存；不记录正文/路径/凭证，不改变 TTFT。开关、字段口径、采集方法、测试及限制见 [navigation-diagnostics.md](navigation-diagnostics.md)。

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

## 可选延迟诊断（不是性能根因判定）

服务启动前设置 `PI_WEB_PERF=1`，重启到包含此实现的版本。关闭时移除该变量并重启。复用已有 `lib/perf.ts` 开关；模型请求额外输出带 `[pi-web:perf]` 前缀的 JSON 到服务标准输出，不创建独立日志文件。尚未首输出的请求也会每约 10 秒报告 `waiting`（目前生成期间同样报告）；请求结束清理定时器。默认无日志、无采样 timer，原 options 对象直接传给 SDK。

每次模型请求使用独立随机 `traceId`、UTC `timestamp`，`elapsedMs` 是从请求诊断开始的累计单调时钟时间；相邻阶段相减才是分段耗时。日志不包含会话/任务 ID、provider/model 名、cwd、请求 URL、payload、headers、正文、工具参数或原始错误。并发请求按 traceId 分组，以时间窗口与 UI/网关记录人工对照；traceId 不发送给上游，因此不是 sub2api 的 request ID。

| stage | 观测边界与限制 |
|---|---|
| `start` | 进入已有 streamFunction 包装器，不包含 HTTP prompt 路由、会话创建或浏览器排队 |
| `stream_ready` | 原函数返回流对象；**不代表连接建立或收到 HTTP 响应** |
| `payload` | SDK 的 `onPayload` 回调入口；可能早于鉴权、调用者 payload hook、实际发送和内部重试 |
| `response` | SDK 的 `onResponse` 回调入口，仅记录 HTTP status，不读取 body/headers；不是所有扩展/provider 都调用 |
| `provider_event` | 首次 `onProviderStreamEvent` 回调，可能是元数据而非文本；不是原始 socket 首字节 |
| `first_event` | SDK 首个标准化事件，start/空 delta 也算，不能用来替代 TTFT |
| `first_output` | 和 TTFT 相同的首个非空 text/thinking/toolcall delta |
| `end` | 完成/失败/中止，固定 outcome 枚举；无 delta 时不会虚构首输出 |

回调保留原参数、返回值/Promise、错误传播；不覆盖 fetch、不改变认证、headers、重试、超时或流的消费次数。payload/response 可能重复（provider 内部重试等），没有对应回调的阶段保持缺失而不是推算零。

`maxEventLoopDelayMs` 是该次诊断期间每 250ms timer 的最大迟到量，也在阶段到达时检查未执行的到期 timer。它是**粗粒度阻塞/调度延迟信号**，不是 CPU 占用、DNS/TCP/TLS 耗时或精确事件循环 profiler；系统休眠、负载、浏览器后台限速也能使值升高，低值不能排除短暂阻塞。只有开启诊断且请求/seed 准备在途时采样，不是全局卡顿监控。

判读方法：

- start→payload 慢：优先检查 SDK/provider 本地准备（仍需确认该 provider 的回调位置）。
- payload→response 慢且事件循环延迟小：定位到发送前 hook、网络、网关、上游或内部重试这组候选，**不能只凭客户端日志区分 sub2api 与模型上游**。
- response→provider_event/first_output 慢：响应流等待、网关缓冲、模型首输出或本机解析/回调仍都是候选；结合事件循环信号。
- first_output 很早但 UI 很晚：检查 SSE 传输和浏览器渲染，本次日志不覆盖该链路。
- 最终拆分网络/sub2api/模型上游，需对照 sub2api 的请求接收、转发、上游响应/首块时间；本次不增加全局 fetch monkey patch 或透传诊断头。

`/new` 浏览器日志和任务接口计时见 [F09](new-session-command.md#可选延迟诊断)。本次没有复现用户现场的偶发卡顿，不将诊断能力当成卡顿已修复。

诊断增量验证：request-latency/request-performance/message-performance/agent-event-wire/streaming-message、task-picker API 和 ChatInput.new-session 共 68 项通过；另在 `PI_WEB_PERF=1` 下 task-picker API 6 项通过；tsc、变更代码 ESLint、diff whitespace 检查通过。测试覆盖合成延迟、回调保留、失败收尾、随机 trace 隔离、字段脱敏、浏览器开关/禁用存储、timer 清理和接口响应头。未跑本次真实浏览器 `/new` 计时 E2E 或真实 sub2api 联调；检查到 30141 为全局安装服务而非 checkout dev，未替换、重启或在该服务上冒充验证新代码。

## 验收

```bash
node --test lib/request-latency.test.mjs lib/request-performance.test.mjs lib/message-performance.test.mjs lib/session-stats.test.mjs lib/streaming-message.test.mjs lib/agent-event-wire.test.mjs lib/agent-event-stream.test.mjs lib/session-reader.pagination.test.mjs components/MessageView.test.mjs "lib/rpc-manager*.test.mjs"
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
