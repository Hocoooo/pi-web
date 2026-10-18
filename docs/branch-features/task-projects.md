# F33 — 任务项目选择与修改

## 用户契约

- 任务仍最多属于一个目录型项目，也可以无项目；项目不要求 Git 仓库。不新增独立项目注册表、项目名称实体或任务执行入口。
- 创建任务与详情修改项目共用紧凑选择控件：无项目、已有项目下拉、浏览目录按钮。列表合并当前 Pi 对话与已有任务引用的项目，按服务端 projectKey 去重、按根路径排序；同名目录用路径区分。无 session 的任务项目也可再次选择。
- 浏览目录复用 DirectoryPicker，既可选择已有目录，也可创建新文件夹。创建文件夹的 submit 必须与外层创建任务表单隔离；创建目录不等于提交任务，取消任务不自动删除已创建目录。
- 从对话创建任务继续由来源决定项目，不能在创建时覆盖；创建后可显式修改。
- 详情默认只显示一行项目路径/无项目和“修改项目”，不在底部元数据重复项目。编辑时才显示选择、保存和取消，沿用现有主题、表单与按钮样式；长路径不能撑宽 390px 界面。中英繁三语言同步。
- 列表失败显示错误并可刷新，仍可浏览目录；不能把读取失败当作没有项目。保存失败保留所选目录；网络失败保留同一请求重试；冲突清除旧确认，要求重新预览。

## 对话与项目一致性

- 项目由服务端 validatedCwd + resolveProjectAuthoritatively 解析，不接收客户端 projectRoot/projectKey 作为授权。
- 预览返回将解除关联的 session IDs。目标仍是同一项目（含同仓库 worktree）则保留兼容对话；跨项目或改成无项目时解除不兼容对话。无法找到的对话无法证明兼容，也必须进入明确确认列表。
- 有待解除项时 UI 展示数量与“不会删除或停止对话”的说明，用户再次点击确认才写入。取消不修改任务或关系。
- 项目修改和解除关系在一个 board store 锁中校验并提交；目标身份、task revision、待解除 session IDs/generation/updateRevision 必须与预览一致，否则整体拒绝。
- 每个解除项 generation +1，移除旧 relation receipt、清除旧 pending intent，保留历史 choices/deliveries/sessionContexts/sharedContext。task revision/updatedAt 一次推进，不修改 order/columns/views/archive 状态。
- 不修改 session cwd、原生 JSONL、模型、工具、权限、运行状态，不启动 Agent，不恢复停用的共享功能。目录引用本身不调用 allowFileRoot。

## API 与存储

`POST /api/tasks` 新增三个公开操作，均严格拒绝额外字段：

- `{action:"projects"}` → `{projects:[{cwd,projectRoot,projectKey}]}`；目录候选的 cwd 为项目根路径。仅扫描 metadata，无 transcript 水合。
- `{action:"preview-project",id,cwd}` → `{project,revision,token,detachSessionIds}`；cwd 可以为 null。token 是任务/目标/待解除关系快照摘要，不是权限凭证。
- `{action:"change-project",id,cwd,expectedRevision,previewToken,operationId}` → 原有 `{task,board}`。服务器重新解析项目及关系，校验预览后原子写入。

存储仍 v7，task 增加可选内部 `projectReceipt:{operationId,fingerprint}`，旧记录无需迁移；严格校验合法 receipt，公开响应剥离。成功修改后最近相同 operationId/相同请求指纹只确认当前结果，不重新执行、解析目录或解除关系；同 ID 不同参数拒绝，较早被后续修改替代的请求受 CAS 限制。完全无变化为只读 no-op。不可变 creationFingerprint 不随项目修改变化，原创建请求重试仍有效。完整存储/CAS 表以 [F21](task-dashboard.md#当前存储cas与迁移权威表) 为准。

## 实现与交点

- `components/TaskProject.tsx`：共用目录选择、预览/确认/取消/重试；由 `TaskDashboard`、`TaskDetails` 使用；`TaskInspector` 不重复显示项目。
- `lib/task-{operations,types,store}.ts`、`app/api/tasks/route.ts`：列表、快照 CAS、原子提交、receipt；复用现有 taskSessionCatalogue、项目解析与旧 pending 清理。
- 同步 [F31](task-session-management.md)、[F30](task-session-relation.md)、[F32](task-picker.md)：项目修改后刷新任务元数据，原聊天选择器继续按真实 session 项目过滤，不把任务项目修改解释成移动 session。
- 上游整合保留正常聊天、目录授权、来源创建、fork/copy 的 owner/generation 检查；不能改成前端先解除再修改的多步写操作。

## 已确认的测试边界与验收

用户确认 HTTP API 与 Dashboard 用户交互两个公开边界，要求 red→green 逐行为实施，最终真实浏览器操作验证渲染与交互。

```bash
node --experimental-strip-types --test app/api/tasks/projects.test.mjs
node e2e/task-projects.mjs
node e2e/task-projects-real.mjs
node e2e/task-dashboard-panel.mjs
```

- HTTP：真实 route/store、临时 agent-dir；指定/修改/无项目、合并列表、只读预览、跨项目原子解除、失效/缺失目录、严格字段、并发冲突、worktree 同项目与身份变化、删除 session、原创建重试与丢响应重试。
- Dashboard：复用健康开发页面，全 API 隔离，任务请求接真实 route/store；选择、取消/确认、列表失败、保存响应丢失后的精确重试，无 Agent 写请求。
- 真实浏览器：`task-projects-real.mjs` 复制当前源码与依赖到临时目录，用独立 `.next`、HOME、agent-dir 启动 Turbopack。真实 HTTP 不拦截，实际创建目录与任务、选择已有项目/任务项目、修改与解除、刷新持久化、390px 无横向溢出、浅深主题截图检查，原 session 文件逐字节不变且无 Agent 写请求。结束停止自己的服务并删除源码副本；截图、日志、结果与隔离数据保留在输出的临时 evidence 目录。不操作用户现有任务、生产服务或用户工作区 `.next`。
- 面板回归覆盖草稿、焦点、Escape/IME、三语言与主题；旧专项脚本中的历史内联卡片/手填目录断言不作为当前 UI 验收。

不声称真实 provider 执行、Safari/iOS 真机、Windows 文件系统或生产安装已验证；没有运行生产 build、安装或发布。修改行为时同步本合同、F21 schema/CAS 表与索引。
