# Headless RPC：无扩展 UI 的会话交互契约

> 维护基线：`63c6e4e`，对应上游 `96966e5`。以下是复验入口与覆盖边界，不应把测试命令的存在当作已通过验收。

## 何时读、做什么

修改新会话 API、扩展绑定、后台任务完成信号，或 rebase 涉及 `rpc-manager` 时读本文。目标是让调用者明确选择**无扩展 UI** 的运行方式，使 SDK 能在 headless 模式下等待扩展后台工作及其触发的父会话续写，再宣布本次 prompt 完成。

范围限于「创建参数 → 扩展上下文 → 接收确认 → 运行完成 → 重建」边界。它不是所有 RPC 命令的规格，也不是浏览器隐藏模式、CLI `--no-open`、Chat-only、工具沙箱或新的子代理调度器。`custom-ui-terminal` 中用于渲染的固定终端 facade 与这里的 `headless` 选项不是同一功能。

相对上游，本分支新增 `headless` 参数、状态回显及无 UI 绑定；prompt admission、SSE、已有扩展生命周期仍由现有实现承担。不要把这些共享机制全部改写成分支专用实现。

## 入口和默认值

| 入口 | 应观察的符号与行为 |
| --- | --- |
| [新会话路由](../../app/api/agent/new/route.ts) `POST` | JSON 中与 `cwd`、`type` 同层传入 `headless: true`；仅允许 boolean。`ensure_session` 只建立运行时，`prompt` 建立后提交首条指令。两种成功响应均回显 `headless`。 |
| [RPC 管理器](../../lib/rpc-manager.ts) `RpcSessionStartOptions`、`startRpcSession`、`AgentSessionWrapper` | 内部创建参数 `headless?: boolean`；构造器使用 `options.headless ?? false`。默认仍提供 Web 扩展 UI。 |
| [已有会话路由](../../app/api/agent/[id]/route.ts) `GET` / `POST` | 活着的 wrapper 可通过 `get_state` 读取模式；本入口不提供修改模式命令，也不在重建时传入 `headless`。 |
| [事件路由](../../app/api/agent/[id]/events/route.ts) `GET` | 复用活着的 wrapper，或从会话文件以默认选项重建。事件传输委托给 [createAgentEventStream](../../lib/agent-event-stream.ts)。 |

## 必须保持的具体不变量

1. **显式启用，不改变默认。** 缺省或 `false` 走现有 Web UI；只有 `true` 使 `createExtensionUiContext()` 返回 `undefined`。`"true"`、`1`、`null` 不是合法替代值。当前新会话路由对此抛错后返回 HTTP 500，不要在文档里误写为所有参数错误都返回 400；缺失/不存在的 `cwd` 则有显式 400 分支。
2. **无 UI 仍绑定扩展。** `ensureExtensionsBound()` 继续调用 SDK `bindExtensions`，保持 `mode: "rpc"`、command actions、错误回报等绑定。改变的是 `uiContext`，不是 `noExtensions`。SDK 扩展应观察到 `ctx.hasUI === false`，并采用其无 UI 路径。旧 SDK 兼容分支 `extensionRunner.setUIContext` 也必须传入同样的上下文值。
3. **先 ready，再承诺可用。** 新会话读取 `get_state` 时等待扩展绑定；`beginExtensionBinding` 的日志不是成功确认。绑定失败继续沿既有错误路径暴露，不能假装已经建立一个可交互会话。
4. **接收不等于完成。** `send({type:"prompt"})` 在 SDK preflight 接受后返回；它不是等待所有生成结束的同步接口。等待过程中 `pendingPromptCount > 0` 使 `isRunning()` 为真，即使某一轮 `isStreaming` 已经变成 false。HTTP success、单次 `agent_end`、流式文本暂时停止均不足以认定全部工作结束。
5. **完成包含父会话续写。** 对普通、非 streamingBehavior prompt，wrapper 等待 SDK `inner.prompt()` 的 promise settle 后才发 `prompt_done`。真实 SDK 回归夹具覆盖：第一轮 `agent_end` 等待后台 promise → 扩展发 `triggerTurn: true` 消息 → 父会话生成第二轮 → 仅一次 `prompt_done`，最终 `isRunning() === false`。headless 本身没有额外轮询器；能否 drain 依赖 SDK 与扩展合作，不能泛化为等待任意未注册异步任务。
6. **失败与结束分开。** preflight 拒绝由提交请求返回；新会话 `prompt` 未被接受时还包含 `code: "prompt_rejected"`、`accepted: false`。接受后才发生的运行异常通过 `prompt_error` 回报，普通 prompt 随后仍会发 `prompt_done`。因此 `prompt_done` 表示结束边界，不保证业务成功；`steer`/`followUp` 队列路径也不能套用「每次提交都有独立 prompt_done」的规则。
7. **Stop 和通知沿用原契约。** `abort` 取消扩展 UI 等待并调用 SDK abort；`notifyAgentRunCompleteIfIdle` 只在真正 idle 时发完成通知。headless 不绕过停止/关闭流程，也不自动开启或关闭通知。它不是服务重启后的任务恢复承诺。
8. **模式属于运行时，不持久化。** 基线代码没有把 `headless` 写进 session JSONL、设置或工具选择元数据。活着的同一 wrapper 会保留值；`startRpcSession` 命中已有 registry 项时直接复用，新的 options 不会切换它。会话驱逐、重启、工具更换导致重建等路径若未重新显式传入，会回到 `false`。已有会话 API/SSE 重建目前正是默认路径。
9. **权限和资源边界不变。** headless 不是允许自动批准确认框的授权。`startRpcSession` 的 project trust、Chat-only、子代理资源加载及工具选择仍生效；依赖 UI 的扩展需自行处理无 UI，不应被文档描述成一律批准或一律执行。可加载的扩展和模型仍可能读文件、调用工具或联网，验收应使用受控夹具。
10. **平台无特例，但 SDK 有依赖。** 选项自身无 Windows 专属行为。实际 SDK、模型和扩展可受平台影响；当前依赖版本见 [package.json](../../package.json)。没有 UI context 不等于事件流绝不会出现 `extension_ui_request`：例如绑定中的 shutdown handler 仍可能产生通知事件。应检查「扩展能否请求交互」而不是笼统要求此事件类型绝迹。

## 自动化验收（仓库根目录）

前置：已具备项目要求的 Node 与依赖；这里列出命令，不自动安装依赖、不请求模型服务。执行者必须记录通过、失败、跳过和环境，不得用源码阅读替代运行结果。

```bash
node --experimental-strip-types --test lib/rpc-manager-headless.test.mjs lib/rpc-manager-shutdown.test.mjs lib/rpc-manager.test.mjs
node --experimental-strip-types --test lib/rpc-manager-extension-ui.test.mjs lib/rpc-manager-idle-timeout.test.mjs
```

覆盖解释：

- [rpc-manager-headless.test.mjs](../../lib/rpc-manager-headless.test.mjs)：真实 SDK session，临时目录、内存设置、注入 streamFunction 和背景 promise；验证 drain/续写顺序，不调用真实模型或真实子代理服务。
- [rpc-manager-shutdown.test.mjs](../../lib/rpc-manager-shutdown.test.mjs)：部分使用假 inner；覆盖有/无 UI 绑定、状态、preflight、停止和完成通知边界。
- [rpc-manager.test.mjs](../../lib/rpc-manager.test.mjs) 中新路由参数与两处回显断言是**源码契约测试**，不是实际 HTTP 端到端测试；其他已有 RPC 回归不是 headless 的新增语义。
- [extension-ui](../../lib/rpc-manager-extension-ui.test.mjs) 与 [idle-timeout](../../lib/rpc-manager-idle-timeout.test.mjs) 用于防止默认交互/清理路径退化，不能据此声称所有第三方扩展都支持 headless。

## 手工验收：步骤、预期和负例

前置：独立测试服务、可丢弃项目目录、已知扩展加载/信任设置；通过应用正常认证。在隔离环境中进行，避免把真实项目默认模型/工具配置当夹具。无外部调用授权时仅做 `ensure_session`、状态和参数检查；完整生成场景使用受控测试模型/扩展，或另行取得模型调用授权。

1. 向 `POST /api/agent/new` 提交真实测试目录和 `type: "ensure_session", headless: true`。保存返回 sessionId；预期 success 且 `headless: true`。随后 `POST /api/agent/<id>` 提交 `type: "get_state"`，预期 `data.headless === true`。另建缺省选项会话，预期 false。完成条件是两种模式均核实，而非只看首次创建成功。
2. 分别提交 `headless: "true"` 和不存在的 cwd。前者预期当前 500 且包含 boolean 错误，后者 400；若命令为 prompt，检查未接受标记。不得因负例失败再发一条真实 prompt 来「确认」。
3. 用受控扩展记录 `ctx.hasUI`，只在无 UI 时等候可手动释放的后台工作，并通过 `sendMessage(..., {triggerTurn:true})` 请求续写。先连上 `/api/agent/<id>/events`，再提交 prompt。预期提交先被接受；等待后台工作时仍处于运行中、没有 prompt_done；释放后观察父会话最终答复，再出现一次 prompt_done。参考自动化夹具的事件序列，不把对话文本猜测当完成证据。
4. 用受控失败/取消场景分别验证 preflight 拒绝、接受后的异常与 Stop。预期未接受的请求不宣称运行成功；接受后的错误可见，运行状态最终收敛。所有观测都要区分业务失败和传输结束。
5. 在可丢弃服务重启后，从同一已持久化会话通过已有会话路由重新建立运行时。预期回到默认 `headless: false`；同一活 wrapper 上追加 `headless` 字段则不应成为切换模式手段。若测试会话尚未写入 JSONL，先核实文件存在，不能把「找不到会话」归因于模式恢复。

## Rebase / 上游整合清单

- [ ] 分别对照 `git diff origin/main HEAD -- app/api/agent/new/route.ts lib/rpc-manager.ts` 与上游新 SDK API；保留本分支参数、默认值、两个创建成功回显和 get_state 回显。
- [ ] 检查 `bindExtensions`、旧 runner 回退、reload/rebind 全路径；所有上下文创建都通过同一 headless 判定。
- [ ] 若上游已有无 UI 模式，映射到其正式入口，避免两个布尔开关或重复后台 drain。先确认 `hasUI` 与 prompt promise 的实际生命周期等价。
- [ ] 合并 preflight、`agent_end`/`agent_settled`、`prompt_done` 变动时运行真实 SDK 夹具，不仅保留正则测试字样。
- [ ] 核实重建/恢复是否开始持久化模式；若上游改变该行为，同步更新第 8 条与手工验收，不能悄悄假定会话文件能恢复它。
- [ ] 运行默认 UI 的回归和错误/停止回归，记录 SDK 版本及未覆盖的扩展。

## 限制与维护完成标准

当前没有 HTTP 级完整 headless 自动化、没有跨服务重启的模式持久化、没有任意第三方后台工作的完成保证。无 UI 是交互能力选择，不是无人值守安全策略。

维护者在触及上述入口或升级 SDK 时，必须逐条核对不变量；为语义变化补充或调整测试，再更新本文的基线、命令、覆盖边界和已知限制。完成标准：每个改变的交互边界都有源码入口、可观察结果和验收证据；若只有静态阅读，就明确记录「未运行」，不要继承他人的测试结论。
