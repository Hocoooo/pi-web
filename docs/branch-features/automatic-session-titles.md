# 每轮结束自动更新会话标题

核对日期：2026-10-13；实现起点 `00e5e5d`，Pi SDK 1.0.0。关联 [Headless RPC](headless-rpc.md)、[下一轮提示词建议](next-prompt-suggestions.md) 与 [会话维护说明](../agents/sessions.md)。

## 目的与范围

一轮用户请求真正结束并空闲后，用独立模型请求重新评估会话标题；不向主会话添加消息、调用工具、自动继续对话或延迟 `prompt_done`。这是服务端行为，浏览器切换会话/关闭页面不取消后台工作，但服务关闭会取消；不保证服务重启后补做未完成的命名。

## 默认值、入口与持久化

- 没有命名记录的未命名会话默认开启；已有名称或已有 `session_info` 的历史会话默认关闭，避免覆盖手动命名。无标题来源记录的旧 AI 标题也按已有名称保留，不猜测来源。
- 顶栏“会话信息”面板有 **每轮结束后自动更新标题** 开关及额外模型请求说明；策略保存在会话 JSONL，而非浏览器 localStorage。未落盘时控件禁用并说明原因；子代理会话不显示此控件。
- 子代理运行时不启用自动标题，即使其元数据含有开启记录也不额外命名；任务名称保持原策略。普通项目、独立聊天与 headless 主会话使用相同规则。
- 手动改名（侧栏 PATCH 或 `/name` 的 `set_session_name`）关闭自动更新。重新勾选开关只影响后续正常完成的轮次，不立即请求模型。
- 现有“生成标题”按钮保留为一次性操作；它不切换自动更新开关，且也受并发/过期结果保护。
- 元数据类型为 `custom` / `customType: "pi-web:auto-title"`，data 为 `{ version: 1, enabled: boolean, title: string, source: "manual" | "generated" | "legacy" }`。策略是会话级而非分支级；读取所有 entries 中最新记录，并核对名称及后续命名 entry。损坏记录 fail closed。
- 自动请求跟随会话当前模型；无独立模型选择、无全局开关。现有文本预算约 6,000 字符、输出上限 256 tokens、最低受支持思考等级不变。自动请求最多等 15 秒；显式按钮保留 90 秒。

## 行为要求

1. 必须观察实际 `agent_start`，并复用 wrapper 的“整轮完成且空闲”判定；不能挂在内部 `turn_end` 或第一条 `agent_end` 上。handled 扩展命令、打开历史、刷新、SSE 重连不因旧答复触发收费请求。
2. 只为当前活动分支最新的、正常 `stop` 且含非空文本的 assistant 答复生成；它必须属于本次新运行，并在分支中有 user 请求。错误、截断、取消、Stop、旧答复均不回退生成。多次低层结束/重试/续写收敛为一次整轮命名；排队输入随整个运行一起收敛，不承诺每个 queued submission 独立请求。
3. 同 wrapper 对同一答复最多尝试一次；失败不自动重试。生成错误静默保留原标题，不能把上游异常或凭证放进主对话。
4. 自动请求传入当前标题，要求主题未实质变化时原样保留。相同候选不写新 entry、不发刷新事件；模型输出必须正常结束并经过标题清理/长度检查。
5. 新请求、Stop、导航/压缩/模型变更/替换和关闭会话取消旧标题任务。写入前再检查 signal、wrapper 存活、session id、active leaf、名称、开关及空闲状态；即使 provider 忽略 signal，旧结果也不能写回。
6. 手动改名/开关修改与自动命名通过相同 controller 协调。存活会话只用其 SessionManager；启动中等待已有 start lock；关闭中拒绝写入；休眠会话直接写新鲜 manager，不创建 AgentSession 或加载扩展。
7. wrapper 发出精简的 `session_title_updated`（sessionId、title、autoTitleEnabled、sessionListVersion）；前端只改标题元数据，不重载/重锚历史、不触发第二轮 next-cue。完成时已经发出的较旧 GET 不得覆盖更晚的标题事件；详情使用事件序号保护，列表和单独 hydration 按服务端 session-list version 仅保护标题/开关字段，不阻止其他元数据合并。侧栏通过既有 session-list version 轮询更新非当前会话。
8. [Next Cue](next-prompt-suggestions.md) 允许相同对话分支末尾仅追加 `session_info` 与本标题元数据；其他消息、compaction、model change、自定义条目或分支变化仍丢弃建议。请求携带客户端 leaf，可避免标题移动 SDK leaf 导致额外重生成或丢失建议。
9. 自动命名不是主任务的一部分：不增加 wrapper busy 状态，不延长 prompt promise，不依赖完成通知开关。不创建第三方后台任务 draining 的新保证。

## API

- `GET /api/sessions/[id]` 的 `info.autoTitleEnabled` 回显策略，响应中的 `sessionListVersion` 与名称快照一起捕获；会话列表仍保留原轻量扫描，不为了开关重读所有 JSONL。
- `PATCH /api/sessions/[id]` 接受且仅接受其中一种：`{ name: string }` 或 `{ autoTitleEnabled: boolean }`。成功返回 `{ ok: true, title, autoTitleEnabled, sessionListVersion }`；非法/同时提供两种参数为 400，不存在为 404，关闭/替换中的写入为 409。
- `POST /api/sessions/[id]/auto-name` 通过同一 controller 生成；取消或会话已变化返回 409，不能覆盖用户的新标题。原有 title/usage 响应保持。
- `POST /api/sessions/[id]/next-cue` 在已有 `{ model }` 上增加可选 `leafId`（非空且不超过 200 字符；null/缺省沿用服务端 leaf），对同一语义分支返回该 leaf。

## 实现导航

- [auto-session-title.ts](../../lib/auto-session-title.ts)：策略、持久化、完成筛选、去重、取消、compare-before-write 和仅标题 leaf 判断。
- [session-title.ts](../../lib/session-title.ts)：独立推理、现有标题稳定提示、外部 signal 与有界超时。
- [rpc-manager.ts](../../lib/rpc-manager.ts)：生产主会话启用、真实运行/整轮完成接入、修改/关闭取消与唯一写入路径。
- [会话路由](../../app/api/sessions/[id]/route.ts)、[auto-name 路由](../../app/api/sessions/[id]/auto-name/route.ts)：读取、命名和开关。
- [useAgentSession.ts](../../hooks/useAgentSession.ts)、[ChatWindow.tsx](../../components/ChatWindow.tsx)、[AppShell.tsx](../../components/AppShell.tsx)：元数据事件、旧 GET 保护、当前标题与会话信息控件。
- [next-cue.ts](../../lib/next-cue.ts)、[next-cue 路由](../../app/api/sessions/[id]/next-cue/route.ts)：仅标题变化兼容。

## 自动验收

```bash
node --experimental-strip-types --test lib/auto-session-title.test.mjs lib/session-title.test.mjs lib/session-title-cancellation.test.mjs lib/rpc-manager-auto-title.integration.test.mjs lib/rpc-manager-headless.test.mjs lib/rpc-manager-shutdown.test.mjs lib/next-cue.test.mjs lib/next-cue-auto-title.test.mjs "app/api/sessions/**/route-title.test.mjs" "app/api/sessions/**/auto-name/route.test.mjs" "app/api/sessions/**/next-cue/route.test.mjs" hooks/useAgentSession.auto-title.test.mjs hooks/useAgentSession.test.mjs components/AppShell.auto-name.test.mjs components/session-catalog-helpers.test.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run lint
npm test
```

浏览器验收（全部 API 与 EventSource mock，覆盖真实 AppShell/useAgentSession，桌面 1280px 与手机 390px；不调用模型）：

```bash
# 当前 checkout 没有 dev 服务时，临时隔离启动 Turbopack，退出后停止；不 build、不碰全局安装。
node e2e/automatic-session-titles-run.mjs
# 若已有运行当前源码的服务，复用它；不要指向尚未更新的全局安装。
E2E_BASE_URL=http://127.0.0.1:30141 node e2e/automatic-session-titles.mjs
```

覆盖界面开关保存/错误/重载、手动锁定、SSE 更新不重载历史/丢草稿/重复收费请求、延迟旧列表不能回滚标题、子代理不显示开关。隔离运行器只在无 checkout dev lock 时运行；真实 provider/端到端计费仍须另验。

Windows / Node 24 命令使用 glob，避免字面 `[id]` 被 Node 当成字符匹配而执行零个测试。测试中使用临时目录、mock provider 或真实 SDK 的受控 stream，不调用真实模型。

覆盖：策略与 JSONL reopen、锁定/解锁、正常/失败/Stop/过期结果、每轮去重、无主对话污染、provider 不遵守取消/超时、真实 SDK headless draining、显式 route handler、启动/关闭 manager 所有权、next-cue 竞态。前端 source-contract 不是浏览器交互验收；运行结果与浏览器覆盖需单独报告。

## 本次验证记录（2026-10-13）

- Windows / Node 24.19.0：全量 `npm test` **2,653 项，2,616 通过、0 失败、37 跳过、0 取消**。平台跳过不计为功能通过。
- `tsc --noEmit` 通过；全仓库 ESLint 0 errors，只有既有 `test-results/keyboard/baseline-file-viewer*.test.mjs` 两处 unused-import 告警；`git diff --check` 通过。
- `node e2e/automatic-session-titles-run.mjs`：1280px / 390px 均通过，上述 API/EventSource mock 浏览器覆盖零 pageerror、零付费/主 prompt 请求。临时源码服务已停止，未改动现有全局服务。
- 独立只读审查发现并复核修复“较旧 catalog/hydration 返回覆盖新标题”的竞态；行为单测与浏览器延迟响应夹具覆盖该修复。
- 提交前同步远端 `85cc4f3`（macOS 服务管理），仅 README 契约索引发生冲突并保留双方条目/约束；自动标题实现无行为变化。同步后全量 **2,672 项，2,629 通过、0 失败、43 平台跳过**，类型检查通过，ESLint 仍为上述两处既有告警；新增平台跳过来自 macOS 集成用例。
- 未调用真实 provider；尚未做真实计费与网络取消验收，也未升级全局安装。

## 人工验收

前置：启动包含本改动的服务，使用可丢弃会话与明确允许计费的 provider。不要为了验收默认使用真实项目或凭证。

1. 未命名主会话正常完成两轮：标题每轮评估，独立推理不出现为聊天消息；按钮/输入框在主任务完成后即恢复，后台标题完成不跳阅读位置。
2. 标题生成中切换会话/关闭页面：服务继续运行时标题可落盘，返回或打开侧栏能看到；服务关闭则取消，不补做旧请求。
3. 手动改名，完成下一轮：名称保留、开关关闭。重新开启后完成新一轮：恢复自动评估；仅勾选开关无模型请求。
4. 标题请求中开始新轮、手动改名、切分支或停止：旧结果不覆盖最新状态。生成超时或错误时主对话可正常继续，原标题不丢失。
5. 同时开启 next-cue：标题先于/晚于建议完成均不重发建议或无故丢弃；真正的新请求和分支变化仍丢弃旧建议。
6. 打开旧已命名会话、刷新/重连、执行 handled 扩展命令、打开子代理：没有额外自动命名请求。桌面与手机“会话信息”面板开关可操作且说明可见。

## 已知限制、Rebase 与维护

- 每个成功轮次最多多一次请求，使用当前模型，不承诺廉价；取消不保证 provider 免计费。辅助标题费用仍不计入主对话消息统计，延续显式命名行为。
- 不提供全局关闭或独立标题模型；用户通过会话开关控制。没有跨进程绝对一次计费或服务重启任务恢复。两个 Pi 进程同时写同一 JSONL 仍不受支持。
- 开发 HMR 前已经建立的旧 wrapper 不自动升级功能；部署后应使用新进程/新 wrapper，不能把模块编译成功视作现有运行时已经接入。
- 高交叉入口为 rpc-manager、标题路由、AppShell、useAgentSession、next-cue。Rebase 必须保留 admission/settlement、Stop/shutdown、手动命名所有权与本功能取消/过期保护；不能只保留触发回调。
- 与[任务选择器](task-picker.md)、[会话归档](session-archive.md)整合时，保留 ChatWindow → useAgentSession → AppShell 的标题事件回调及 RPC 的取消/Stop 生命周期。归档确认只更新完整目录中的会话投影，保留同一 catalogSnapshot 的 sessionListVersion，再强制回读权威列表；关联/归档本身不启用、关闭或触发命名，不放宽手动标题与过期保护。本分支索引使用 F37，避免与任务看板 F21 重号。
- 修改默认值、收费模型、文本范围、元数据/API、持久化、事件或 next-cue 例外时，同步本文、[README](README.md)、相关会话说明与回归测试。
