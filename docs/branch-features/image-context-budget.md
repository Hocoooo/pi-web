# F41：图片 Base64 上下文预算与旧图片耐久卸载

核对基线：`cdfc330` / Pi SDK 1.0.0；2026-10-24 实施。Pi Web 宿主功能，不修改 SDK、CLI 或 node_modules。

## 目的、入口与默认值

长会话中的历史图片会重复随请求发送。本功能限制 **SDK 最终模型消息中 image content blocks 的 Base64 字符串 UTF-8 字节总和**，默认 **20 MiB（20 × 1024 × 1024 bytes）**。不是解码后的文件大小、图片个数、token 预算或完整 HTTP body 限制。

服务进程可配置环境变量 `PI_WEB_IMAGE_CONTEXT_MAX_BYTES`：严格正十进制安全整数；未设置使用默认值，空串、0、负数、小数、空白、科学计数法及不安全整数明确报错，不静默禁用。每个 wrapper 构造时读取一次；既有 wrapper 不热更新。没有新增 Settings UI、JSON settings key、上传接口或持久化媒体 schema。

普通项目、独立聊天、Chat-only、headless 和使用同一 wrapper 的子会话使用同一策略，不改变工具或文件权限。关联 [F01](headless-rpc.md)、[F19](independent-chat.md)、[F40](video-attachments.md)。

## 行为要求

1. **有效分支是唯一依据。** 使用当前 manager 的 `buildSessionProjection()` 和 `sourceEntry.id`；先前的 context_edit、omission、compaction 已经生效。不从原始历史、兄弟分支或显示分页重新注入图片。
2. **保留最新含图消息的完整图片组。** user、toolResult、custom message 按投影顺序统一排序，不是只保留最后一个 image block，也不是只保护最新 user。没有新的图片时，最近一条旧含图消息仍受保护。
3. **总量超限时逐张卸载最老图片。** 从最老消息的最老图片开始，以明确的文字占位替换，达到预算即停止；允许只卸载较老消息的一部分图片。非图片正文、工具调用/结果配对、toolCallId、toolName、isError、details、签名及视频 metadata 不因卸载改变。不生成虚构视觉摘要。
4. **最新组本身超限则整次请求拒绝。** 先计算完整计划再追加编辑；不为了“成功发送”删掉新组的一部分，也不顺便编辑其他历史。用户 prompt、steer、follow_up 的新图片在 SDK 接受/排队前先验整组大小。普通 idle 无新图追问可提前拒绝历史超大最新组；带新图可替代旧组的保护地位。
5. **每次实际请求重验。** SDK 输入/扩展可在接受后增加内容，工具结果或队列消费也可产生新图片；公共 `prepareRequest` 在原 SDK canonical refresh 之前执行合法耐久卸载，但最新组超限先让原 hook 完成一次 virtual routing/阈值压缩，再根据压缩后的有效投影作最终预算判断，不阻断虚拟模型的自动恢复。若原 hook 返回后需要新卸载，重新取得 canonical projection.messages，保留返回的 model/thinking/tools 等字段，绝不再次调用 router。公共 `prepareNextTurnWithContext` 在 SDK 工具后自动压缩之前尝试同一计划；自身非预算错误（如 append 失败）不在这里抛出，因为 SDK 此时可能已 dequeue、尚未 persist 输入：暂存错误并跳过这次 next-turn 准备，等 `prepareRequest` 时已消费输入完成原生落盘后再拒绝，零额外 provider 调用，无新队列/重排/重投机制。最终 stream guard 在 context hooks / converter 之后拒绝仍超限的消息，零次调用其下游 provider/video transport，不依赖会吞错的 extension context hook。
6. **错误与完成分开。** 新用户组可预接受拒绝；工具/custom/转换后超限可在已经接受的运行中成为 SDK assistant error。一次工具请求已经发生后，拒绝其续轮意味着零次**额外** provider 调用，不是整个运行从未调用模型。`prompt_done` 仍只是结束，不等于成功；不增加重试、队列或自动发送。
7. **原图不删除。** 只向同一宿主持有的 `SessionManager` 追加原生 `context_edit(targetId, {content})`，不写 null、不更换整条消息，不打开第二个写 manager。原始 JSONL 和 UI/history/export 的图片保持可读；这不缩小磁盘文件，未被卸载的较老图片可能出现在 replacement 中。
8. **分支与恢复使用 SDK 原语。** 冷 reopen、当前路径 clone、fork_branch 继承沿路径的编辑与 entry identity；fork 到编辑之前、导航到兄弟或编辑之前会看到那条路径本来的图片，下一次请求重新评估。保留的 compaction 消息继续应用已有编辑，被压缩移出的图片不会由本功能复活。没有全 session 删除表、资产表或新 branch/copy 引擎。
9. **允许压缩恢复。** `/compact` 等 slash/shell 入口不做历史组的提前拒绝；独立 compact command 不受图片准入门禁。工具间准备遇到超大最新组时先允许 SDK 尝试文本压缩/消费新输入，真正 request hook 仍重验。最终 guard 只检查实际请求消息，不因为原始历史有大图而阻止文本摘要请求。失败/取消的压缩不回滚已追加的合法卸载编辑。
10. **不改变视频传输。** 不重建 converter 输入或视频 owner 对象；只让 SDK 根据内容编辑重新投影。包装顺序为 performance relay → image guard → video transport → 原 SDK stream。视频原来的文件20 MiB、完整请求120 MiB、auth/model/owner/取消和 Google payload checks 独立保留。

## 范围边界

- 无 Files API、重编码、缩放、外部媒体存储、自动视觉摘要。SDK 原有输入规范化保持原样，本功能不添加另一套处理。
- 约束的是 **Pi Web wrapper 的最终 SDK image 消息输入**。不承诺所有 provider 的实际 HTTP body、传输编码/协议附加值、网关限制；不是对可信扩展主动联网、替换宿主 hook、provider 自行改写 payload 或在更下游 payload hook 添加媒体的沙箱。
- 不拦截扩展自行创建的独立推理、CLI、其他直接 SDK 使用者；没有给所有 app 独立后台推理增加全局网络代理。
- 占位文字说明原图仍在历史，要求再次附加才能重新查看；不新增 UI 卸载状态徽标。原图展示并不代表本轮模型仍接收它。
- context_edit append 非跨条目事务；写入失败阻止本次调用，已成功写入的部分仍保留，下一次按实际投影重新评估。无回滚伪成功。

## 实现导航

- [image-context-budget.ts](../../lib/image-context-budget.ts)：配置校验、字节计数、纯 offload 计划、原生编辑、两个公共 request hooks、最终 stream guard。
- [rpc-manager.ts](../../lib/rpc-manager.ts)：所有 wrapper 的安装、用户图片预接受校验；不改变原 admission、draining 或 queue owner。
- [pi-types.ts](../../lib/pi-types.ts)：引用 SDK `Agent` 公共 hook 类型，不新增私有字段。
- [image-context-budget.test.mjs](../../lib/image-context-budget.test.mjs)：纯策略、20 MiB 边界、SDK 持久化/分支/复制/压缩和 raw UI reader。
- [image-context-budget.integration.test.mjs](../../lib/image-context-budget.integration.test.mjs)：真实 wrapper → SDK → 注册的 capture provider，拒绝、warm tool loop、队列、custom、冷重开、压缩、context/converter 注入。
- [video-transport.test.mjs](../../lib/video-transport.test.mjs)：新增 image offload + 原生视频 owner/Google final-fetch/performance 回归。

## 自动验收

无需服务、真实凭证或网络；合成 PNG/Base64、临时 session、测试 provider。新图片集成文件禁止真实 fetch。执行结果必须分层记录。

```sh
node --experimental-strip-types --test lib/image-context-budget.test.mjs lib/image-context-budget.integration.test.mjs
node --experimental-strip-types --test lib/video-transport.test.mjs lib/video-queue.test.mjs lib/video-tools.test.mjs lib/subagent-video.integration.test.mjs
node --experimental-strip-types --test lib/session-reader.test.mjs lib/session-reader.pagination.test.mjs lib/session-reader-external-write.test.mjs lib/session-reader-latest-entry.test.mjs lib/rpc-manager-headless.test.mjs lib/rpc-manager-shutdown.test.mjs lib/rpc-manager.test.mjs lib/request-performance.test.mjs lib/independent-chat.test.mjs lib/chat-only.test.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js lib/image-context-budget.ts lib/image-context-budget.test.mjs lib/image-context-budget.integration.test.mjs lib/rpc-manager.ts lib/pi-types.ts lib/video-transport.test.mjs lib/rpc-manager-shutdown.test.mjs
```

### 本次红绿证据与限制

- 第一条真实 SDK 测试先观察旧图仍全部进入请求（预期只保留最新组，失败）；接入公共 request hook + 原生编辑后通过。早期无效合成图片被 SDK 规范化丢弃的夹具已改成实际有效1像素 PNG，不把它算预算证明。
- 第二片提前拒绝测试先失败为“Missing expected rejection”，增加只读 idle prompt 检查后通过；压缩夹具因 history 太小最初不能 compact，补足原生历史/keepRecent 后确认恢复不被门禁阻止。
- 独立 review 两项 P2 已做 tests-first 修复：早期 append 失败测试先复现 steering 原生 owner 为0（要求1），virtual 测试先复现第二次 route 未执行（开启/关闭压缩均失败）；修复后4项针对性测试全绿。另加 post-route canonical refresh/只路由一次，以及合法卸载后取消/写入失败压缩的 edits/queue 保留，共新增7项。steer/follow_up 用真实 SDK 队列断言原生 owner/图片恰好一次、pending 和 executable queue 均清空、显式恢复可继续，不只断言零 fetch。
- 新策略/集成现共23项通过；连同历史/lifecycle/performance/独立聊天的联合最终运行160项，159通过、0失败、1项既有 Windows project symlink 跳过。初版联合首跑发现旧 fake projection 缺 entries 导致9失败，早前已修正夹具为 SDK public shape，不给生产代码添加空投影 fallback。
- 本次重新执行 video/subagent/queue/tools 回归162项，152通过、0失败、10按既有 Windows symlink/权限能力跳过。两组最终合计322项、311通过、0失败、11跳过；Windows / Node v24.19.0。`tsc --noEmit`、上述7个文件 targeted ESLint 和 `git diff --check` 均 exit 0。
- 未跑完整 npm test、浏览器 UI、真实服务/真实 provider、HTTP 大体积网关或非 Windows 平台；未安装、build、重启服务或改用户配置。native copy 测试与现有 RPC copy 回归不冒充新的完整浏览器 fork E2E。

## 人工验收（需独立授权的隔离环境）

1. 配置可丢弃测试服务与 capture provider；用小预算发送两组图片，各组可单独容纳但总和超限。第二次捕获只保留预算允许的旧图和完整新组；history 仍显示两组原图。
2. 发送单条超限多图消息。预期明确未接受、没有新 native user/queue 条目、provider 计数不增加，原 composer 拒绝恢复流程保持；不要为验证自动重发。
3. 在含超限历史组的 session 运行 compact。预期可进行文本压缩；再发普通问题按压缩后的有效分支重验。
4. 冷重开/复制编辑后路径，捕获确认旧图不复活；导航到编辑前路径时历史恢复，实际再发按该路径重新预算。

没有真实 provider 授权时只用测试捕获器，不运行付费验收。

## Rebase / 维护

核对公共 `prepareRequest` 的 canonical refresh/virtual routing/阈值压缩顺序、`prepareNextTurnWithContext` 是否仍包住工具后压缩，以及 SDK dequeue → next-turn → persist pending → prepareRequest 的顺序。早期卸载失败必须等已消费输入落盘后再报错；virtual route 只能执行一次，后置卸载要更新 canonical messages 并保留路由结果。核对最终转换/stream 的顺序与错误传播。不能把保护改成 extension context handler 抛错，不能全量替换消息或剥离 video metadata。升级 SDK 时复验 native edits、sourceEntry.id、compaction、copy IDs 和 wrapper lifecycle；若上游有等价预算，只有保留完整最新消息、耐久分支编辑及最终零调用拒绝后才替换本实现。行为变化同步本文、索引及 sessions/tools/F01/F19/F40 交点说明。
