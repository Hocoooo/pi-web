# 对话归档与恢复

## F39 统一入口

[统一搜索与筛选面板](sidebar-search-filters.md)取代侧栏常驻 active/archived 下拉，范围在面板子页选择，关闭保留状态/正文结果；归档写失败/retry仍在侧栏可见。此改变不调整 sidecar、会话族或搜索API。`e2e/session-archive.mjs`已迁移到新面板，维持原历史/草稿/hover/cross-tab/主题回归。

## F38 Task 树/检索交点

[可选侧栏任务树](sidebar-task-tree.md)始终先解析完整 owner/子代理祖先，再按本合同的 active/archived 对话范围显示；Task.archived 不隐藏会话、不改 owner，也不能将其会话标为未关联。SessionSearch 可带 UUID/unlinked taskId，在后端扫描限额前交集完整 membership 与归档状态；缺失/坏任务返回错误不放宽全局。任务归属及归档条件变化使同一关键词重读，取消迟到响应；关闭 Task 层仍保留筛选。侧栏折叠、任务检索、目录重读不触发归档/恢复/报告或模型。

## 目的与范围

将不常用的 session 从日常侧栏隐藏，仍能在已归档列表打开原历史并显式恢复。归档状态与[F27 任务归档](task-archive.md)分别保存；[F35 一次性联动](task-session-archive.md)允许 Dashboard 经预览/跨任务确认归档当前关联会话族，但恢复任务不恢复会话，后来关联/fork 不自动归档。侧栏单独归档不修改任务。

## 用户契约

- 侧栏默认“日常会话”；列表上方原生选择框可切到“已归档会话（数量）”。完整刷新默认回到日常范围，但服务器保存的归档状态不丢失。
- 会话根行的归档/恢复图标与原有改名、删除共用同一悬停操作区：默认隐藏，鼠标移入时按“改名 → 归档/恢复 → 删除”一起出现，移出一起隐藏，按钮固定为 32×32px、图标为 14×14px，边框/底色保持一致；归档/恢复使用显式像素尺寸，不随根字体的 rem 换算缩小；仅键盘聚焦会话行不主动显示按钮；纯键盘/纯触屏不新增专用揭示机制，沿用既有改名/删除的悬停限制。按钮显示后可键盘或触控激活。右键 fallback 菜单保留复制 ID，并增加归档/恢复。扩展同步认领右键事件时仍优先处理，不改变扩展协议。
- 只有持久化会话可操作；transient 不显示磁盘动作。成功响应校验 `ok/sessionId/archived` 后才更新显示；请求失败或结果未知保留现有数据，显示错误和显式重试。重试保持原目标布尔值，不根据可能已刷新的状态反向切换；右键菜单同样提交打开时标签对应的明确目标，另一标签页刷新不能使“归档”变成“恢复”。
- 归档当前打开的会话不导航、不关闭聊天、不清 composer 草稿。归档列表点开或通过已有 URL/任务链接打开，仍读同一 session 的原历史；阅读、普通发送和新活动均不自动恢复。
- 不删除、迁移、重写或追加归档条目到 JSONL；路径、ID、原始所有分支/工具结果/媒体/思考/压缩/自定义记录、模型上下文处理和任务归属保持原策略。归档不代表完成，不停止 AI，也不要求会话空闲。
- 侧栏沿用会话族：[主会话](project-session-previews.md)归档时，其多级子代理一起进入该族的归档显示范围。单会话公开 API 拒绝对子代理独立归档/恢复，要求操作主会话；F35 任务批次可经预览将关联子代理扩展到根，跨任务族必须额外确认。fork/复制是独立根，不继承原会话归档标记。子代理直接历史 URL 仍可使用。
- current 模式在当前项目范围切换；all 模式先按归档范围筛选，再按稳定项目 key 分组、会话族排序和五条预览。归档数量按族根计，不按子代理数量计。项目选择器仍保留完整项目目录；运行/未读追踪仍使用完整目录，不把归档当成 Stop。
- 搜索仍可跨项目，但只检索当前日常/已归档范围，在扫描预算/结果数量截断前筛选，包含该范围内子代理历史。范围或归档成员改变时取消旧请求、清除旧响应并重查；普通 session-list 版本变化仍不触发搜索重排。
- Alt+Left 的显式“定位当前对话”会切到其族所在范围、揭示并聚焦根行，不修改归档状态。普通归档后不自动切范围让刚隐藏的行重新出现。
- 删除仍是原有物理删除，不是可恢复归档。删除后元数据中可能保留不再显示的 UUID；它不重建历史、不生成列表幽灵行，也不影响其他会话。

## 持久化与接口

单一文件 `<getAgentDir()>/session-archive.json`（遵循 `PI_CODING_AGENT_DIR`）：

```json
{"version":1,"archivedSessionIds":["11111111-1111-4111-8111-111111111111"]}
```

- 首次读取缺失文件表示无归档，不创建目录或文件；合法旧 session 不需要迁移。
- 写入采用同 key 进程内序列化 + proper-lockfile 跨进程锁，锁内重新读取，独立 UUID 更新不丢失。单会话同目标幂等，相反意图以最后提交为准，无任务 CAS；F35 批次在同一锁内写全部族根和最新任务 receipt，已提交的同批次只确认、不覆盖后来手动恢复。
- 限制 1 MiB、验证 UUID/完整 v1/v2 schema，拒绝损坏/未知版本、额外字段、重复 ID/任务 receipt、symlink、目录/FIFO；不自动修复或重置。0600 独占 sibling 临时文件，sync 后原子 rename；失败清理临时文件，不转储源文件或底层私有路径。
- 归档元数据与 JSONL 存在性不构成跨文件事务；外部删除与归档并发可留下孤立 UUID，但不会删除/复活会话。损坏元数据会使列表/搜索报错并保持已有 UI 数据，直接读取原历史不依赖归档存储。

首次 F35 批次将 sidecar 写为 `{version:2,archivedSessionIds:[…],taskArchiveReceipts:[{taskId,operationId,fingerprint}]}`；效果与 receipt 同一次原子 rename，每任务只留最近批次。既有 v1 无迁移副作用，普通单会话操作在 v1 上仍写 v1；v2 上保留 receipts，不降级。旧版本会拒绝 v2，不能与旧实现混写。固定 board → archive 锁顺序，不宣称与 board 的跨文件事务。

`PUT /api/sessions/[id]/archive` 仅接受 `{ archived: boolean }`，成功 `{ ok: true, sessionId, archived }`。无效 UUID/请求/子代理为 400，缺失/未持久化/非普通 JSONL 为 404；存储错误为安全的 500/503。不创建 AgentSession，不调用 prompt/abort/shutdown。成功后调用 `invalidateSessionListCache()`，由已有可见页轮询同步其他窗口。

`GET /api/sessions`（含 summary）仍返回完整目录，并附上由祖先派生的 `archived` 布尔值；不在权威目录中过滤，避免 URL 恢复、任务关联、活动追踪丢失归档会话。`GET /api/sessions/search?q=…&archive=active|archived` 默认 active，其他值为 400。搜索读取新归档状态，即便会话标题目录使用 allowStale。

## 实现地图

- 存储：[session-archive.ts](../../lib/session-archive.ts)。
- 不可变显示投影：[session-archive-view.ts](../../lib/session-archive-view.ts)、[SessionInfo](../../lib/types.ts)。
- API：[归档](../../app/api/sessions/[id]/archive/route.ts)、[完整目录](../../app/api/sessions/route.ts)、[搜索](../../app/api/sessions/search/route.ts)。
- UI：[SessionSidebar](../../components/SessionSidebar.tsx)、[SessionSearch](../../components/SessionSearch.tsx)；en/zh-CN/zh-TW 文案。

## 验收

```sh
node --experimental-strip-types --test lib/session-archive*.test.mjs app/api/sessions/archive-integration.test.mjs 'app/api/sessions/**/archive/*.test.mjs'
node_modules/.bin/tsc --noEmit --incremental false
E2E_BASE_URL=http://127.0.0.1:30142 node e2e/session-archive.mjs
```

- 存储真实临时目录测试：缺失无副作用、幂等/恢复、重启、进程内与跨进程并发、不合法/超限/链接/权限/锁失败、JSONL 字节及新 fork 独立性。
- 真实路由临时目录集成：归档/恢复前后 JSONL 与关联资料不变，完整历史树/上下文、原 ID/路径/leaf、summary/full 归档状态及轮询版本，读历史不自动恢复，范围搜索与 fork 独立性。
- 投影真实纯函数：多级族、项目/五条边界、独立聊天、transient、孤儿/循环、不修改 scanner cache。
- Chromium 拦截 API fixture：归档/改名/删除在移入/移出时同显同隐，实际 DOM 按钮均为 32×32px、图标为 14×14px（桌面根字体 14px/16px，归档/恢复及 390px 三语言×两主题），写失败/显式重试、日常隐藏、归档打开、当前聊天/草稿/历史保留、键盘恢复、右键入口、跨窗口同步/打开菜单期间另一窗口归档的明确意图、刷新、范围搜索、Alt+Left，以及 390px 三语言×两主题下由指针揭示后的触控归档/恢复与动作不越界（不代表纯触屏可独立揭示）；记录业务写请求，禁止 delete/Stop/prompt/任务写入。这是客户端验证，不冒充真实模型或生产 SSE。
- 手工使用可丢弃会话检查运行中的根归档/恢复、长期离线/丢响应、历史分支/媒体内容和任务关联。不得用真实用户会话做删除验证。

### 本次实现验证

- 上述归档专项及 session API、侧栏、会话族、搜索、键盘/五条、任务归档相关回归共 **119 项通过，0 失败/跳过**。
- 全仓 `tsc --noEmit --incremental false` 与 `npm run lint` 通过。
- 复用当前源码开发服务 `30142`：`session-archive.mjs`（桌面及 390px 三语言×两主题）、既有 `sidebar-view.mjs` 和 `session-keyboard.mjs` 均通过。浏览器使用 API fixture，不操作真实用户会话；服务端测试使用真实 SDK/路由及临时 agent 目录，验证所有分支、图片、thinking、工具结果、压缩、usage、自定义条目和真实任务 board 字节/归属不变。
- 独立只读复核发现的跨标签页旧菜单反向动作已修复并加入浏览器回归；复核确认无该问题的残留。未将这些检查称为全仓测试套件或生产/全平台验收。

### 悬停交互调整验证

- 归档/恢复已移入原有 `hovered && !session.transient` 操作区，与改名/删除同时出现和消失；未改存储、API、右键菜单或归档语义。
- 侧栏测试 17 项通过，新增 JSX 结构检查确保不存在常显归档按钮；类型检查、局部 lint 与 `git diff --check` 通过。
- 更新后的 `session-archive.mjs` 在现有 30142 开发服务通过，明确验证移入/移出同显同隐、显示后的键盘激活及 390px 三语言×两主题的“指针揭示后触控按钮”。此处不再将测试称为纯触屏入口验收；纯触屏/纯键盘的悬停入口限制与既有改名/删除一致。

## 已知边界与维护

除 F35 固定任务批次外，不提供任意批量归档、彻底删除后的恢复、导入归档包、按时间自动归档或 CLI 侧栏隐藏；CLI 仍可正常加载原 JSONL。Windows/NFS/断电耐久、Safari/iOS 16.2 真机及真实 provider/SSE 未自动验证，不执行生产 build/install。恢复保持原 modified，不以归档时间重排；归档视图仅内存状态，完整刷新回到日常。

与[每轮自动标题 F37](automatic-session-titles.md)整合时，确认归档/恢复后的本地族投影须通过 setCatalogSnapshot 更新，保留目录匹配的 sessionListVersion，然后强制回读权威列表；不能恢复旧的独立 setAllSessions 状态或丢失标题事件更新。归档操作本身不触发、关闭或取消自动命名。回归入口包含 components/SessionSidebar.test.mjs、自动标题专项与 e2e/session-archive.mjs，配合类型检查。

修改同轮同步本文件、F34 索引、侧栏/五条/键盘/右键与 sessions topic 的交点和测试。上游整合时保留 sidecar-only 存储、完整权威目录、族范围和确认后更新，不能把归档改成删除或执行准入。
