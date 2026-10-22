# 会话新建与切换诊断（F09 / F17）

这是可关闭的测量工具，不改变 `/new`、会话缓存、工具选择、扩展 API 或 TTFT 统计口径。与 [new-session-command.md](new-session-command.md)、[message-performance.md](message-performance.md) 配套。

## 开关与采集

- 服务端：启动 Pi Web 前设置 `PI_WEB_PERF=1`。复用健康服务；若原进程已开启，无需重启。未开启的进程需要按正常维护流程重启才能读取环境变量。
- 浏览器：开发者工具 Console 执行 `localStorage.setItem("pi-web:perf", "1")`，开启 Preserve log，然后执行 `/new`、切换已有会话。开关按调用读取，不必刷新。只在当前 origin 生效。
- 关闭浏览器：`localStorage.removeItem("pi-web:perf")`。服务端取消环境变量并在适当时机重启。
- 服务端保存标准输出中的 `"perf":true` JSON；浏览器保存 `[pi-web:perf]` JSON。原有模型请求诊断仍使用 `[pi-web:perf]` 前缀。不要把完整 HAR、请求 body、Cookie 或 Authorization 发到日志归档。
- `X-Pi-Perf-Trace` 串联浏览器与服务端；响应的 `X-Pi-Perf-Request` 对应服务端 requestId；嵌套操作的 `parentRequestId` 指向父操作。仅接受 32 位小写十六进制客户端 trace ID，否则重新生成。这不是身份或授权信息。

## 已实施的阻塞修复

- `/new` 使用 `task-picker(sessionId, ownerOnly:true)`；picker 只解析目标会话 cwd，不再把所有会话项目解析作为读取一个归属的前置条件。磁盘身份查找仍按 header/stat 元数据确认，保持重复 ID/legacy/删除语义。见 [task-picker.md](task-picker.md)。
- `lib/project-resolution-queue.ts` 为只读项目身份解析提供进程级调度：总并发最多 4，显示缓存冷读取/后台刷新最多 2，目标会话 authoritative 读取优先使用剩余容量；启动统一推迟到下一 event-loop turn，避免一次调用同步启动数百个子进程。队列不用于 Git worktree 的新增/删除操作。
- `resolveProject` 的同 cwd 冷读取共享 Promise；失效 generation 阻止旧结果重新填入缓存，Promise 身份检查防止旧 flight 清除新 flight。stale 仍立即返回、后台刷新仍去重；authoritative 读取不缓存、不共享可能陈旧的结果，只做并发调度。
- `launch_project_resolution` 现在主要测量入队成本。`backgroundStarts` 表示刷新任务创建/排队，`gitStarted` 只包含日志输出前真正开始的查询；后台排队后计数可能才增加，不能用当前响应中的零值推断以后不会启动 Git。
- 保留 get_state 的扩展就绪屏障。历史消息应用后前端已经解除 loading，不因性能优化而把尚未绑定完成的模型/命令/状态当作稳定快照。
- 新增测试：`lib/project-resolution-queue.test.mjs`、`lib/project-resolution-perf.test.mjs`、`lib/task-picker-performance.test.mjs`；真实复测材料位于本地 `.scratch/diagnostics/`，不作为通用 CI fixture。

## 服务端数据

实现：`lib/perf.ts`。启用时每个操作输出 start、phase、每 2 秒 waiting、end。阶段日志在完成阶段时输出；waiting 的 lastPhase 是**最后完成**的阶段，不是当前执行函数。每个操作有独立计时器和 AsyncLocalStorage 上下文，成功、错误和提前返回都收尾；关闭时不创建计时器、不增加文件 I/O。

字段：timestamp、pid、route、traceId、requestId、parentRequestId、totalMs、durationMs、phases、counts、maxEventLoopDelayMs、cpuUserMs、cpuSystemMs、eventLoopUtilization、heapUsedMB、heapTotalMB、rssMB。

- durationMs 是距上一个阶段的墙钟时间；嵌套/并行操作不能相加当作请求总时间。
- 事件循环延迟为 250ms 定时器的最大超期值；同步工作在计时器来得及回调前结束也会采样。不是精确的 GC 或 CPU profile。
- CPU、ELU、内存是**整个进程**的区间变化/快照，不是单请求独占资源。并发请求可能共享同一段停顿。
- Server-Timing 保留阶段时长；错误响应也带关联头。日志失败不改变请求结果。

### 新建与运行时

`POST /api/agent/new`：body_parse → validation → runtime_ready → invalidate_caches → get_state → first_command（ensure_session 无此步）。

`runtime.start`：registry_hit / join_start + join_wait / closing_wait_start，或 session_manager → persisted_selection → theme_and_trust → settings → builtin_extensions → sdk_services_and_resources → visible_models → model_selection → sdk_session → wrapper_and_tools → register_wrapper → deferred_model。

`runtime.bind_extensions`：ui_context → bind_extensions。它有自己的结束事件，因为扩展绑定可能与路由其他步骤交错，甚至在父操作结束后完成。这里只计整个 SDK bindExtensions，不能凭它确定某个具体扩展的耗时。

### 会话读取

`GET /api/sessions`：start（force/summary）→ scan+projects（persisted/runtime 数量）→ archive_and_merge → serialize。reader/scanner 内部子操作继续拆缓存决策、文件扫描、关系映射、项目信息及索引保存；不逐文件打印，不增加额外扫描。

`session_reader.attach_projects` 进一步拆 unique_cwds → launch_project_resolution → resolve_projects → map_projects。launch 阶段测量批量调用异步 resolver 在第一次 await 前的同步工作（包括启动后台 Git 子进程），不是 Git 完成等待；计数 freshHits/staleHits/coldMisses/coldJoins/backgroundStarts/backgroundJoins/gitStarted/missingCwd 只聚合输出、不包含 cwd。stale 返回不代表启动后台刷新没有同步成本，gitStarted 也不代表进程已成功或完成。

`GET /api/sessions/[id]`：resolve → open（force/live/wrapperRebuilt）→ tree（entries/summaryTree）→ context → stats → revision_and_project → serialize。

`GET /api/sessions/[id]/state`：lookup（live/found）→ get_state（仅 live）。task-picker 保留 operation / serialize 诊断和响应关联头。

### 删除

`DELETE /api/sessions/[id]`：resolve → metadata_scan → relation_prefix → local_headers → legacy_scan → runtime_relations → family_graph → discover（删除族/需重挂 fork 数量）→ shutdown → reparent → unlink（确认删除数量）。详情见 [session-deletion.md](session-deletion.md)。删除使用关系元数据，不触发完整展示列表的扫描；前端确认后立即应用实际 IDs，只保留一次后台刷新。活跃 runtime 的 shutdown、相关大 fork 的重挂仍可能真实耗时，不应把这些阶段全部算成磁盘 unlink 成本。

`legacy_scan` 增加聚合 `cacheHits/cacheMisses/unstableFiles/bytesRead/lines/candidateLines/parsedLines`；候选数不等于实际重读文件数。`candidateLines` 是字节预筛后解码的行数，`parsedLines` 才是 JSON.parse 尝试数；bytesRead 为实际传入扫描器的块字节数，可能含 marker 所在块的余下字节。`family_graph` 同样记录累计计数，含后续跨目录检查。冷扫描在独立 Worker 运行；phase 耗时包括排队、线程启动/通信等，不是纯磁盘读耗时。错误返回时不承诺完整扫描计数。

关闭链新增 `abort_dispatch` / `abort_wait` / `shutdown_dispatch`，以及子 trace `runtime.shutdown`（extensions_bound、mcp_dispose、extension_shutdown_dispatch、extension_shutdown、destroy）。普通会话的 `runtime.extension.session_start/session_shutdown/resources_discover` 子 trace 记录 handler 序号、固定扩展类别布尔值、同步 dispatch 与异步 wait；不记录扩展路径或参数。索引只在本次加载顺序内有效，不是稳定插件 ID。`memorySampleMs` 记录内存采样本身耗时，帮助排除测量开销。父 shutdown span 在细分后只代表最后一次标记后的剩余等待，分析整个阶段需合并子阶段或看子 trace total。

## 浏览器数据

实现：`lib/latency-trace.ts`、`hooks/useAgentSession.ts`、`components/SessionSidebar.tsx`。

- new_session：已有 `/new` seed 的 runtime_ready、task_ready、seed_ready。
- http_request / new_runtime：实际新建 POST 的 start → response → end。
- session_load：详情 response → json_ready → state_applied → 可选 state response / state_ready → end。
- session_list：列表 response → json_ready（sessions/summary/force）→ state_applied → end。
- response 表示 fetch 得到响应头；json_ready 包含其后的 body 接收及 JSON 解析，**不能只解释为 JSON.parse CPU 时间**。
- state_applied 表示状态更新调用和缓存处理已完成，**不证明 React commit、布局或屏幕绘制完成**。若服务端及这些阶段都快、画面仍慢，需要另采浏览器 Performance profile。
- single-flight 的复用者不会重复发请求或建立第二条 HTTP trace。导航过期/错误分支必须结束 trace；后台标签页节流也可能抬高浏览器事件循环延迟。

## 如何判断

1. new_runtime.response 慢：用对应 trace 查 POST 和 runtime 子操作，确认耗时在资源加载、扩展绑定、get_state 还是命令派发。
2. 列表慢：先区分缓存直接返回、等待共享扫描和真正重建，再看扫描、关系映射、项目信息、序列化阶段。
3. 多个操作同时出现很高的 maxEventLoopDelayMs：优先采服务端 CPU profile，不把每个等待请求分别当作根因。
4. 服务端快、浏览器 response 慢：考虑网络、浏览器调度和响应传输；浏览器 json_ready 慢再区分响应体大小与主线程忙碌。
5. 列表扫描的文件命中不意味着零 I/O；关系前缀/尾部读取以及项目信息仍可能消耗时间。

## 安全、验证与限制

仅固定操作/阶段名、随机关联 ID、时间、数值计数和布尔值。不得记录 cwd、文件路径、会话名/正文、模型 payload、异常对象、凭证或任意用户输入；不改变现有业务错误响应。

验证入口：`node --test lib/perf.test.mjs lib/navigation-perf.test.mjs lib/request-latency.test.mjs`，以及 `lib/session-list-perf.test.mjs`、`lib/project-resolution-perf.test.mjs`、scanner/reader/worktree 回归、TypeScript 和 lint。测试覆盖开关、关联上下文并发隔离、无效头拒绝、错误收尾、日志失败隔离、计时器释放、客户端请求语义和内容不泄露。

日志有成本：仅排查期间开启，不逐文件/每 token 打印，不把诊断记录写入 session JSONL。采集结果必须再分析才能归因；添加测量点本身不是修复卡顿。当前没有自动化证明真实浏览器点击到绘制的端到端延迟。
