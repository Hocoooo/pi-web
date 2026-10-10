# `/task`：聊天中的任务归属选择

## 定位与范围

在聊天输入框执行 `/task`，或点击聊天上方的任务归属按钮，打开同一个轻量选择器；不需要任务面板。支持空白新会话的预选，以及已有 session 的关联、改绑和解除。任务仍只是管理归属，不是执行权限或模型上下文。

本功能扩展 [F31](task-session-management.md) 原先“先普通创建，再到面板关联”的入口限制，不恢复 `taskStart`、任务材料、共享重点或执行编排。不增加 `/new --task`，不在选择器内创建任务。

## 用户行为

- 精确 `/task`（允许首尾空白）是前端命令，打开选择器并清掉命令文字，保留附图，不进入 prompt/steer/follow-up，不停止当前运行。`/task …` 不属于此命令语法。
- 弹窗自动聚焦搜索框；输入名称筛选，↑/↓ 循环选项，Enter 确认，Esc 取消。导航后仍可打字。中文输入法的 composing/229 按键不确认、不取消弹窗；Esc 不冒泡为 Agent 停止。Tab 留在弹窗，保存期间防重复提交。
- 默认列出同项目未归档任务，展示名称和状态，当前归属有标记。可勾选显示归档任务；当前归属已归档时自动显示它。空搜索包含“不关联任务”；搜索无匹配和读取失败有不同提示。
- 选择、取消后返回 composer；原草稿、附件和后台执行不受关联操作影响。失败保留弹窗及错误，可重复相同选择重试，或重新加载任务后选择。
- 点击归属按钮也打开选择器；已关联任务旁的独立“任务详情”按钮仍打开原任务面板。归属读取失败仍显示未知，不能误报为未关联。
- 尚无真实 session 时，仅将预选保存在当前 composer 内存；不为选择任务创建 Agent 或写 JSONL。聊天栏显示单行“预选任务”；切项目/另开会话会清除的说明放在选择器内，不常驻聊天区。新 draft、切目录、页面刷新不承诺保留预选；普通 `/new` 不继承，既有 fork/copy 归属继承不改。

## 简洁 UI 与既有风格

- 选择器沿用 ModelPicker/ModelSelector 的主题变量、10px 圆角、细边框、12px 正文和紧凑行距；手机搜索框保持 16px，避免 iOS 输入放大。列表独立滚动，缩小视口时弹窗不超出页面；长任务名可换行，状态以较淡的小字右对齐。
- 标题栏使用图标关闭按钮，搜索框带提示文字；归档开关和键盘提示合为底栏。“重新加载任务”仅在读取/保存出错时出现，不在正常状态堆放恢复按钮。
- 新会话和已有会话复用 `TaskMembership` 单行归属栏：任务图标、截断的名称、下拉指示。完整名称保留在 accessible label/title，并可打开选择器查看；独立详情入口改为有名称和 tooltip 的图标按钮。
- 新会话说明只在弹窗内显示；关联失败保留可见错误及选择入口，不通过隐藏错误来精简 UI。
- 保存时焦点停留在可聚焦的弹窗容器；即使控件全部 disabled、点击标题后再按 Tab/Shift+Tab，也不能进入底层聊天。更高层的扩展模态框可合法接管焦点。Escape/IME、取消/完成后返回 composer 保持原契约。
- 内置列状态由 `statusKey` 本地化；自定义列名即便恰好是 `todo` 等内部 ID，也必须原样显示。

## 生命周期与失败处理

- 使用正常 `ensureNewSession` 创建流程；取得真实 ID 后再按真实 session 的权威项目范围重新验证并关联。首次 prompt、bash 或会提升空白会话身份的内置命令在复用已创建 ID 时也先落实显式预选。
- 命令发现/System 面板等提前初始化 session 时同样落实预选。没有预选的普通发送不访问任务存储，不因其损坏/不可用而被阻断。
- 创建和任务存储不是跨文件原子事务。关联失败保留真实 session ID、预选和草稿，显示“会话已创建但关联失败”；重试复用原 ID，不重复发送 prompt。用户可重新选择“不关联任务”继续普通聊天。
- 正在落实初始关联时又改变选择，先等待该写入结果再回读归属，避免迟到的初始写入覆盖新选择。
- 已有 session 的操作只修改管理元数据，运行/归档不构成禁用条件，不改变 cwd、模型、权限、系统提示词、任务状态或 native 历史。
- 同一失败选择保留原请求用于重试；改选目标不能重放旧请求，须先回读可能已经提交但丢失响应的结果。关闭/重新加载后使用新快照；旧快照的写操作仍受服务端 CAS 保护。

## API 与实现

`POST /api/tasks` 新增只读 `task-picker`，严格二选一：

```json
{"action":"task-picker","cwd":"/project"}
```

或 `{ "action": "task-picker", "sessionId": "真实 session ID" }`。`cwd:null` 对应无项目。禁止额外字段、客户端 projectKey、同时指定 cwd/sessionId。

响应仅含 `tasks: [{id,title,archived,revision,status,statusKey?}]` 及 `relation`（cwd 查询为 null；session 查询含 sessionId/sourceTaskId/generation/updateRevision）。status 使用已保存的列名或内置列 ID；仅未自定义名称的内置列附带 statusKey，供客户端本地化，旧客户端仍可使用 status。不返回描述、共享历史、原生聊天内容；不启动 Agent。session 不存在返回 404，不伪装未关联；候选与关系版本在同一 store 锁下读取。

写操作复用现有接口，不改存储版本：

- 未归属 session：`link`，目标任务 revision CAS、唯一 owner、同项目校验及已关联 no-op 重试。**这是状态幂等，不是 operationId/generation receipt 型初次绑定。**
- 已归属 session：`change-session-relation`，保留 owner/generation/updateRevision、operationId 精确重试和旧 pending 清理。
- UUID 用 `crypto.getRandomValues`，兼容非 HTTPS 的局域网 Web 入口。

实现地图：

- `components/ChatInput.tsx`：命令、普通及 streaming 分流、扩展命令延迟发现。
- `components/{TaskPicker,TaskSelectionDialog,TaskMembership,SessionTaskLink,ChatWindow}.tsx` 与 `TaskSelection.module.css`：共用弹窗、键盘/焦点、单行归属及详情入口。
- `hooks/useTaskSelection.ts`：选择快照、失败重试与初始关联协调；`hooks/useAgentSession.ts`：原生命周期接入。
- `lib/task-{types,operations}.ts`、`app/api/tasks/route.ts`：窄 metadata API；原 `task-relations.ts` 写规则不变。

**命令发现交点**：提供任务入口的 composer 在输入 `/` 或内置命令前缀时先显示内置/已缓存命令，不调用可能初始化运行时的扩展命令发现；输入不再匹配内置前缀时按原方式发现扩展。这样键盘输入 `/task` 或 `/new` 不会提前创建 Agent。非任务 composer 保留原发现时机。

## 已确认的测试边界与验收

用户确认 UI、HTTP API、创建/关联生命周期三个公开边界，新增测试不抽取私有函数或断言源码字符串。按逐行为 red→green 实施。

```bash
node e2e/task-picker.mjs
node e2e/task-session-selection.mjs
node --experimental-strip-types --test app/api/tasks/picker.test.mjs app/api/tasks/sessions.test.mjs lib/task-relations.test.mjs
# 复用健康 checkout dev；所有 /api/** 被 fixture 截获，不访问用户数据
node e2e/task-picker-page.mjs
node e2e/task-dashboard-panel.mjs
```

- UI：运行中 `/task` 的键盘选择、取消/IME、当前项、归档、错误重试、内置/自定义状态区分及慢保存焦点约束；全页面桌面/390px（触屏模拟）×浅深主题的命令、按钮改绑、草稿/焦点、新建清预选、长名称/缩小视口、零任务面板请求/零 Agent 写请求。正常弹窗无恢复按钮，聊天栏不显示长预选说明。组件 fixture 显式打包并加载 CSS module；可用 `TASK_UI_ARTIFACT_DIR=/tmp/task-ui node e2e/task-picker-page.mjs` 输出完整页面截图。
- HTTP：真实 route/store、隔离 agent-dir，cwd/session 权威范围、归档、严格字段、缺失 session、窄响应、关联/冲突/改绑/解除/精确重试。
- 生命周期：真实 hook/composer + 模拟 HTTP/SSE，新建预选、提前创建、关联失败恢复与 ID 复用、普通聊天与任务库解耦、初始化期间改选、失败后改选（含响应丢失）、bash 重试。
- 同时回归模型/思考选择器、首次 prompt 设置、原任务面板详情入口、三语言文案、类型检查和局部 lint。

这些浏览器测试不证明真实 provider、生产 SSE、Windows/Safari/iOS 真机、极端任务数量或生产打包行为；没有 build/install、真实模型计费或用户数据迁移。

## 上游整合与维护

保留 ChatInput 原图片/队列/设置分流、useAgentSession 的创建互斥与 prompt 失败恢复、AppShell 的 draft key/remount 语义。不得让 `/task` 调用 `ensureNewSession` 来获取候选，不得复活旧 `taskStart` 或绕过 owner/scope/CAS。修改这些行为时同步 F31、F05、F09、F30、此文及索引；不要将旧面板直达的点击测试直接删除，改为独立“任务详情”入口的回归。
