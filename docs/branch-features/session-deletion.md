# 会话删除：范围、性能与确认反馈

## 不变量

- 删除根会话及其递归子代理（含跨目录的持久化子代理、尚未首次落盘的 live 子代理）；先停止后代/根的运行时，再删除文件。独立 fork 不当作子代理删除；同目录直接 fork 保留并重挂到被删会话的父会话。
- 删除不是任务归档、任务完成或 task-store 改绑。已有任务中的 missing-session 语义不变。
- 用户在 DELETE 等待期间切到其他会话，成功回调不能清空新的选中项；若当前选中的是实际被级联删除的子会话，也要退回该会话 cwd 的空白 composer。
- 不因为性能优化跳过删除确认、子代理关系或 runtime shutdown；失败不能冒充成功。

## 后端

实现：`app/api/sessions/[id]/route.ts`、`lib/session-deletion.ts`、`lib/session-legacy-worker.ts`、`bin/session-legacy-worker.cjs`、`bin/session-legacy-scan.cjs`，复用 `lib/session-list-scanner.ts` 的 header/stat 目录及 `lib/session-reader.ts` 的 bounded relation prefix。

1. 删除不调用全量展示 `listAllSessions(force)`、项目解析或历史 hydration，也不读取每个子代理的结果尾部。
2. 全局元数据 + 同目录 bounded header + live runtime 形成删除图。同目录没有 parentSession 的 native 首条子代理 marker 也可识别；`probeParentless` 仅供此用途，既有 archive/目录调用默认行为不变。
3. 对本地前缀未识别的兼容候选，以及跨目录 header 指向删除 family 的候选，单次流式寻找旧格式后置 subagent marker；保留无 parent header 或 header/marker 不一致的旧本地级联范围。预筛 marker 字面量（含 Unicode 转义回退）后才解析 JSON，不解析普通无关消息，也不把所有兄弟全文同时载入内存。无 marker 的合法 fork 保留；损坏 marker 拒绝删除，而非静默误分类。兼容扫描仍会读取本地候选的字节，并非零历史 I/O。候选按最多 4 个并行读取，失败时等待检查任务收尾；元数据结果按 id/dev/ino/size/mtime/ctime 指纹缓存（最多 2048 个路径），扫描前后指纹一致才缓存。文件追加/替换使缓存失效，删除时清理对应项；缓存不存正文。
   - 兼容扫描在独立 Worker 的 V8 堆中运行，避免大型长驻服务堆承担逐行解码/缓冲分配。全进程最多一个扫描 Worker，其他冷扫描计划排队；全缓存命中的计划不启动线程。Worker 仅只读文件，返回最小关系校验字段及计数，主线程仍复用 `readSubagentRun` 校验。
   - 字节级预筛只在可能含 customType 或 Unicode 转义的行上构造字符串，再执行与旧实现一致的精确 regex/JSON 校验；保留跨块 UTF-8/marker、CRLF/CR、无末尾换行及后置 marker。内存为每个在读文件最长行量级，不是整个文件；不截断大行。
   - Worker 的 V8 old-generation 上限 256 MiB（不是整个进程/Buffer 的硬内存上限），启动后扫描预算 120 秒；错误、异常退出、超时均使删除计划失败，先终止 Worker 再返回，不退回主线程全量扫描或提前报告删除成功。
   - **不是增量索引**：文件追加仍重新检查整个失效文件，不能仅凭文件变大就假定旧前缀没有改写。优化的是读取时的分配/解析开销和堆隔离，而非省略安全检查。
   - Worker 与扫描核心随 npm 的 `bin/` 发布，Next route tracing 显式包含它们；开发服务和已安装 launcher 均从应用包根目录启动。修改 Next 配置会触发开发服务自动重启，性能报告需区分重启前后的内存状态。
4. 只有确定需要重挂的同目录直接 fork 才同步读取全文，校验 type/id/parent，并在同一个无 await 的 JS 执行段中原子替换文件，避免同进程仍在运行的 fork append 被旧快照覆盖。正文保持不变（如需要兼容旧自定义父 metadata，仅更新对应 parent 字段）。重挂失败返回错误，不继续假报根删除成功。
5. 后代先 unlink、根最后 unlink；每次已确认删除/ENOENT 都使 path/manager cache 失效。实际文件 header ID 与预期不一致时拒绝删除。部分删除或重挂后失败仍使列表缓存失效。
6. 普通 runtime 进入 shutdown 后，`lib/extension-lifecycle-perf.ts` 的实例级关闭门禁不再派发尚未开始的 `session_start` / `resources_discover` handler，避免删除期间继续新建索引/连接。已经开始的 handler 仍等待结束，所有 `session_shutdown` handler 仍执行，再 dispose/unlink；不是用超时提前报告删除成功。门禁不影响其他 runtime，也不跳过正常启动。当前保证限于普通会话首次扩展绑定与有序 shutdown；并发 SDK reload、直接 destroy 的既有同步/竞态边界没有在本次改写，专用 subagent/chat-only loader 不改变。
7. 保留 perf trace，阶段 `resolve → metadata_scan → relation_prefix → local_headers → legacy_scan → runtime_relations → family_graph → discover → shutdown → reparent → unlink`，只记录时长与数量，不记录路径、正文或错误对象。后台完整列表的关系映射每 16 项让出一次事件循环，保持顺序和 generation 语义，避免一次同步占用服务线程数秒。

成功响应：`{ok:true, deletedSessionIds:string[], sessionListVersion:number}`。IDs 是实际移除的整个集合，根在其中；无文件的 unflushed runtime 经过 shutdown 后也算已移除。

错误响应为非 2xx，`{error, deletedSessionIds: string[], sessionListVersion}` 中 IDs 仅是错误发生前已确认删除的部分。404 表示找不到根路径，不返回成功。不是跨文件事务：成功删除的后代不会在后续失败时恢复；根最后删除以便修复错误后重试。

## 前端

实现：`components/SessionSidebar.tsx`、`components/AppShell.tsx`。

- 现有行内删除、Shift-click 和键盘 Delete 复用一条路径，不新增右键菜单能力；Escape/取消及焦点行为保留。
- 同时检查 HTTP 状态与成功响应结构，包括实际 IDs 和列表版本。只有服务器确认成功才立即从本地 catalogue 移除这些 IDs；失效删除前的列表请求，取消延后的 hydration，避免旧结果使行复活。
- 删除后的权威后台刷新由侧栏单独负责；父 shell 不再用 refreshKey 再触发一次刷新。这是侧栏删除刷新链的去重，不禁止切换到新 composer 后项目选择器等既有组件的独立读取。保留 `invalidateWorkspaceRestore()` 及基于最新 selectedSessionRef 的导航保护。
- 版本 poll 不能用删除前的旧响应倒退版本，删除后的单次刷新期间也不重复安排同一刷新。
- HTTP/网络/异常 2xx 失败显示可见的可重试错误，不调用成功导航。部分失败做权威刷新反映真实磁盘状态，但不把失败当作整族成功。

## 验证

- `lib/session-legacy-scan.test.mjs`：实际扫描核心的分块/Unicode/换行/大行/错误与最小化传输字段；`lib/session-legacy-worker.test.mjs`：真实工作线程并发读取、全局排队、错误传播、收尾、源文件不变及发布资源声明。
- `lib/extension-lifecycle-perf.test.mjs`：关闭等待已开始的初始化、跳过后续初始化/资源发现、仍执行 shutdown、先收尾后 dispose，以及返回值/异常/日志隐私。
- `app/api/sessions/delete-route.test.mjs`：无关 JSONL 不同步整文件读取/普通大消息不解析、零项目 Git；跨目录/parentless/late/conflicting-header 级联；独立 fork 保留与无 await 的重挂边界；unflushed child shutdown 后落盘仍删除；文件身份改变和损坏 marker 拒绝；shutdown 失败和部分 unlink 失败重试。
- `app/api/sessions/runtime-route.test.mjs`：既有运行时删除、列表版本、持久化子代理后代。
- `components/SessionSidebar.delete.test.mjs`、`components/AppShell.session-delete.test.mjs`：确认结果、版本/请求 fence、单次刷新、导航范围。
- `e2e/session-delete.mjs`：API fixture 下的慢刷新/失败/导航/级联反馈，绝不删除真实用户数据。
- 本机真实 UI 对照使用 `.scratch/diagnostics/delete-capture.mjs`：只创建并删除明确标记的临时 session，采集接口返回与行消失耗时；不发送模型请求。

## 限制

目录发现仍需要全局 header/stat 元数据，不是 O(1) 删除。关闭门禁不能中断已经执行的扩展初始化或同步 native 调用；SDK 的关闭 hook deadline 也不能抢占阻塞事件循环的函数。目标项目复测确认过数秒的扩展启动等待，但历史单次 110 秒 DELETE 中的 98.7 秒 shutdown 停顿仍未精确归因，不能视为已完全修复。

真正相关的大 fork 重挂、legacy 流式检查以及活跃运行时 shutdown 仍可能耗时；不承诺所有删除在固定毫秒内结束。

不引入跨进程文件锁，不保证与外部 CLI/文件编辑器同时重写同一 session 的事务隔离；既有 size/mtime 元数据缓存边界仍适用。本地 parentless late marker 保留兼容扫描；跨目录且无父 header 的非 native 隐藏关系不在旧全局关系发现保证内。

变更删除协议、关系发现、刷新或导航时，同步本文件、README、sessions topic note、侧栏键盘契约及对应测试。
