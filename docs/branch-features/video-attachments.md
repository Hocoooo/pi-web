# 原视频附件：选择、恢复、上下文、分支与队列

核对基线：2026-10-15，SDK 1.0.0。视频 tickets 01–09 已独立 review / resolved。本文保留稳定行为；历史验收、命令与未验边界见[公开验收摘要](video-attachments-acceptance.md)，不依赖本地 scratch 或临时捕获。

## 目的与范围

当前对话的原生 user 路径引用 → SDK 有效投影 → SDK 已解析鉴权 → 原生 Google adapter → TapSVC。没有独立分析会话、视频工具、SDK 补丁、转码/抽帧/转写、Files API 或媒体资产平台。仅 MP4/AVI、每条新用户消息一个视频；多轮有效 owner 可累计。普通路径/@mention/摘要不代表原视频已发送。

## 入口与原生引用

现有 `POST /api/agent/new` 的 prompt 和 `POST /api/agent/[id]` 接受与 message 同层的可选 `video: {version:1,path,mimeType}`。path 为服务端绝对路径；MP4 为 video/mp4，AVI 为 video/avi，后缀大小写不敏感。不是数组，不能冒充 images。

- 已有会话 prompt 可指定 streamingBehavior steer/followUp；独立 steer/follow_up 也支持。均须非空普通问题。新建路由只允许 prompt 带视频，不允许独立排队命令。
- ensure_session 不带视频，只创建运行时，随后实际问题才带引用。其他命令、shell、slash、compact、导航/复制和历史编辑携带新 video 均明确拒绝。两路由在 startup/set_tools 快路径前检查，wrapper 再检查，不能忽略视频后报成功。
- 普通 prompt 要求 idle；运行中必须显式 Steer/Follow-up，SDK 决定实际准入/消费。沿用原 preflight、HTTP accepted:false、prompt_done、assistant error 与 Stop；接受后失败可保留 native user 和 error，prompt_done 只表示结束。
- SDK message entry 的原生 user 保存 `piWebVideo: {version:1,id,path,mimeType}`，服务端 UUID 随所属消息持久化，不是上传资产 ID。正文没有指令标记，JSONL 无视频 Base64。
- 普通首问在该次 started preflight 后的首个 native user message_end、SDK appendMessage 前绑定；队列在公开 enqueue 边界绑定实际 user 对象，消费后再次从独立 tuple 确认。不能按文字/时间猜 owner，也不另写 JSONL/custom_message。UUID 穿过 SDK 请求投影 clone。

## 01–03：选择、拖入、发送与恢复

1. 非 compact composer 提供选择 MP4/AVI 按钮；ChatWindow DOM drop 只经 ChatInput.addVideos 转给同一个 VideoAttachmentPicker.select。共用 MIME/数量/20 MiB 校验和 uploadFiles(cwd,files,"skip")，不建新上传路由，前端不读取视频 Base64。
2. 空 MIME 按后缀；非空 MP4 必须 video/mp4，AVI 为 video/avi 或 video/x-msvideo，引用统一 video/avi。错误后缀/MIME 零上传。视频候选（MP4/AVI 后缀或 video/*）优先于图片/普通文件分类；一次多个、或已有 ready/uploading/error 选择时拒绝整批新视频，不覆盖/选第一个。混合图片、普通文件 skip/@mention、文件夹拒绝保持原行为。
3. 显示名称、进度、错误或就绪。skip 明确“未覆盖、引用已有文件”；恢复/重挂载只表示引用就绪，不伪称刚上传。上传中或失败未移除时，按钮/键盘不能提交。移除仅解除本次引用、不删除文件；移除、重新选择、keyed unmount 失效旧 attempt，迟到结果不能复活附件或解锁新上传。
4. 视频要求普通非空问题和精确目标模型；压缩/模型切换中拒绝。运行中 chooser/drop 可上传，但只有原 Steer/Follow-up 按钮/快捷键显式发送。带视频的命令（含 /new，以及存在时的 /task）、shell、编辑、粘贴明确拒绝并保留输入；compact 辅助 composer 不提供视频入口。原图片/纯文字行为保持。
5. 明确未接受（含创建/设置失败）经既有内存 draft/rekey 恢复文字、图片 bytes、就绪路径；上传失败保留错误，用户移除后重选，不做 File 后台重试。源会话迟到拒绝只恢复原 draft key，不污染目标；未提升新 draft 仍遵守原弃用清理，不承诺切走/刷新后恢复。
6. ChatInput 本地 Send ref 在异步命令分流前互斥；队列 callback 同样防重复清空/发送。hook running、picker occupied/attempt、恢复 guard 各自保留，不增加服务端幂等平台。
7. 普通 Send 保留单次独立 ChatDraft 快照（文字/图片/引用）。响应未知时可查看但不自动放回可发送草稿、不自动重发，也不能被新 prompt 覆盖。native SSE 或 raw 权威历史的新 entry 以原 userMessageKey＋完整 video tuple 确认接收，排除旧 entry/cache/乐观气泡；原生 metadata 替换同文乐观 user。
8. 用户显式“核对并恢复”重新读取权威历史/运行态；无新 owner 且可确认 idle、composer 空白才恢复 draft，恢复本身零 prompt。迟到 owner 胜出，失败/忙/不完整保留快照。未知快照仅当前 hook/页面内存，未发 draft 仅模块内存，无跨刷新/切走重开保证；不是事务/恢复队列。恢复后的 Send 仍检查当前模型/权限/文件/大小，接受后的 provider error/Stop 不自动恢复已发 user。

## 04–05：重开、连续追问与压缩

1. 已发引用仅靠 native JSONL；SessionManager.open、历史 GET 和 MessageView 保留 metadata/entry ID，刷新/新页重开不上传、不创建引用或把它恢复为 draft。普通追问无需新 video 字段。
2. 每个实际模型请求（含工具后续轮）只携带 SDK 当前有效 native user owners，各在自己的 Google contents 位置。不同 owner 即使同文字/同文件也分别保留；不去重、不统一塞最后一个 user，不扫完整历史/兄弟分支/摘要路径。
3. 每次重新读取当前文件。修改后下一请求用当前 bytes，包括工具修改后；缺失/无权限/类型错误的任一有效旧视频整次失败，不能只发较新视频/文字。修复后仅显式追问重试；不冻结、哈希、变更检测或后台重发。
4. 每文件20 MiB；所有有效视频累计 Base64，完整 UTF-8 adapter params（文字/图片/system/tools/results）加64 KiB封装余量必须≤32 MiB。超限整次零 fetch/零删减/零原 SDK 文字 fallback，不自动摘要、压缩或转 Files API。这是应用预算，不是网关极限。
5. 手动/自动压缩沿 SDK 有效投影，保留近期 owner，移出者停止发送；失败/取消或仅 compaction event 不清空视频。compaction_start/end 只隔离 SDK 的序列化文本摘要请求：零原视频，不要求本轮新 owner，也不按摘要路径重注入。
6. 工具后自动压缩可能在当前视频 prompt 内移出新 owner。只有 canonical buildSessionProjection 确认排除后才允许普通续轮不含它；该 UUID 此后必须零次出现（原 tuple/改写/复制复活都拒绝）。仍有效的提交 owner 必须恰好一次且完整 tuple 一致，扩展 context/converter 丢失仍 fail-closed。
7. session-reader 在返回的 user 副本加只读 piWebVideoInContext，基于 SDK source entry identity。分页 before 只是展示游标，effectiveLeafId 用完整所查看分支；不写回 JSONL、不用 UI 状态发媒体。MessageView 三语言显示 active/inactive/pending，inactive 说明“不再自动携带／新问题重新附加／摘要不是原视频”。这是最近成功读取的上下文快照，不是 provider 接收/理解证明。
8. 原 picker/拖入再次附加并显式 Send 生成新 user/UUID；旧 owner 仍 inactive，不建历史媒体库或压缩引擎。

## 06：分支导航与原生复制

- 导航先等待 navigate_tree ACK，再读 canonical 历史/leaf；SDK user 目标回到其父节点，assistant 目标保留本 entry。取消/拒绝不切假视图。局部 pending 阻止重复导航/普通 Send（经原 draft 恢复，零 prompt），持续到 canonical GET 完成。
- pending 期间不能按旧 UI leaf/cursor 新启分页；此前历史/分页的 navigation generation 过期不能改消息、上下文状态或 view cache。普通历史 single-flight 以 session ID＋generation 索引，新分支追问完成须 fresh GET；显式 options bypass 与 force 的磁盘探测语义保持。
- fork 复制到目标 user 之前（不含该视频）；fork_branch 包含目标 entry；clone 只取所选 leaf 路径（可非当前 leaf），不带兄弟历史。当前 SDK 保留 entry ID 与嵌套 UUID/路径/MIME，无 ID 重建/兼容映射。任务分支存在时继续原 copy intent/receipt/scope/生命周期，不把任务模块引入视频基础能力。
- 只导航未 append 的 leaf 仍为 SDK 内存状态，冷销毁后打开原最后持久路径；不新增持久浏览位置。分支续问写盘、fork/clone 冷开按实际路径。复制含压缩时 raw inactive 引用可保留但不复活媒体。
- child 不复制/移动视频文件、不冻结 bytes、不授权新根。继承路径逐次 canonical/link/regular-file/model/budget 检查，越界整次零出站；无关兄弟文件缺失不影响。

## 07：运行中队列、Stop 与完整 Recall

1. 现有 prompt＋streamingBehavior、独立 steer/follow_up 接受一个视频；上传不等于排队/发送。video-input-binding 仅在公开 SDK prompt/enqueue/consume/clear 边界与 AsyncLocalStorage scope 绑定实际 user；嵌套 extension 公开发送退出 host scope。Map 仅是只读显示/Recall 投影，无调度/drain/重试/持久化能力，SDK 是唯一队列。
2. state queuedMessages.inputs / SSE queue_update.inputs 保留每行文字/图片 bytes/video，旧文字数组保持，UI 显示文件名并以完整 path/MIME 为 title。实际消费后才写 native user，不错绑当前正在回答的问题。消费时所有 canonical owners 与请求 owner 必须数量/UUID/完整 tuple 一致，再按当前 model/auth/file/budget 重验，失败不删媒体/降级文字。
3. Stop 按 SDK abort；新的显式视频 steer/follow_up 在所有 await 前建立新取消 scope，避免复用已取消 signal，之后的 Stop 仍可取消本次提交。已消费 user 保留历史，未消费队列留当前 wrapper，不变 draft、不自动启动/重发。下一次显式提问才依 SDK 策略消费并重验。wrapper 销毁/服务重启后未消费队列不持久化。
4. Recall 仍一次 full clear，不做单条 dequeue 或 clear+requeue。带视频须 idle（服务端同步用既有 isRunning，不能用 extension await 后的公开 message_start 推断未 dequeue）、恰好一个视频、composer 空白（含无上传/图片读取中输入）、无保留快照，否则明确拒绝保留队列。普通文字/图片 busy Recall 不新增 idle/空 composer 限制。
5. 所有浏览器 Recall（含仅见普通文字/PNG）必须携带完整 recallInputs 两队列投影；缺失零 clear，只刷新等再次明确操作。服务端在删除前逐 kind/顺序比较文字、图片 bytes/MIME、视频 UUID/tuple，队列变化先拒绝；stale plain 视图不能删未知视频/PNG，拒绝 ACK 丢失也保留原 SDK 队列。
6. 视频 clear 前先把整份输入/已知 UUID 放03同一快照槽。成功按实际 result.inputs 恢复文字/PNG/video，不按旧摘要分类；纯文字仍 prepend，普通 PNG 经原 draft merge。图片总数/有效性与 composer canRestoreImages（已附＋读取中保留位）在 clear 前检查，不能完整恢复先拒绝；await 后容量变化保留实际完整输入到同一槽，绝不截断。返回视频遇输入冲突同样保留两份。
7. 未知 clear 与未知 send 区分：不自动重复 clear/prompt，已知 UUID 仍排队不恢复副本，native UUID 胜出且不依赖旧 run/text。idle 且队列不存在后再 fresh history/state 检查，覆盖 history→消费→state 的窗口；读取失败/仍忙/不完整保留。未知 queued send 可由新的权威 queue/native owner 确认，排除原有 UUID；变换文字的匹配视频 owner 不足以证明未收到，不恢复重复。
8. pending 视频 Recall 复用 restoringSubmission，门控 fieldset/chooser/imperative drop/文字图片/提交，await 后复查实际 composer，迟到 ACK 不覆盖后来的 queue_update。不建操作 ID/receipt/事务/投递队列；直接不带 recall 的 clear_queue 保留原显式整队丢弃语义。

## 08：模式、当前模型与权限

项目沿所选 cwd，无项目沿固定 chat-workspace；普通/Chat-only 共用 wrapper 安装，不依赖 extension factory。Chat-only 原 context-only 精确 system 与零工具不变，普通 active tools 不变，不因视频 set_tools/授予 shell/MCP。

能力精确为 `tapsvc / google/gemini-3.8-flash`、origin `https://llm-proxy.tapsvc.com`，源 API 仅 anthropic-messages 或 google-generative-ai。UI provider/ID 只是早期提示，服务端核对具体组合。只含有效视频的请求局部用原生 Google streamSimple，URL 保留 google/ 前缀与 /v1beta；无视频仍原 SDK stream，不整体改模型配置或独立 cache warmer。

SDK ModelRuntime.getAuth 先解析 key；缺 key、解析到其他 origin 则零出站，不能手读凭证/借其他 provider key。Bearer 用解析后的 key，原生 Google 同时保留其 API-key header。保留 reasoning、tool 编码、流式 delta、usage、取消和 payload/stream 观察器。

有效上下文有视频的普通无新附件追问，在 SDK 接受前验证当前具体组合，不支持时原 prompt_rejected/accepted:false 并恢复文字/PNG。切换模型本身允许，命令不被堵住；显式切回再 Send 可继续同 owner。不扫 inactive/兄弟历史。接受后扩展改模型仍在实际出口终止并保留 accepted-error 历史。首次发送设置同步、两步 picker、thinking、默认/全局 models.json 均不改。

读取复用原 allowed roots（含当前已授权未 flush cwd）、词法/realpath/link 检查，canonical regular file 有界读；不借 session 文本预览例外授权外传。拒绝缺失/目录/FIFO/越界，MP4 检查 ftyp，AVI 检查 RIFF/AVI；签名不是 codec 解码保证，不声称消除恶意并发文件修改的 TOCTOU。

## 请求出口的失败闭合

- 用 adapter 自身 convertMessages 确定所属 user 的 contents 位置，不能假设消息下标＝Google 下标。converter 换掉/原地剥除/改写 owner 都拒绝；独立完整 tuple 快照不能被扩展改 path 借壳。
- 媒体注入与核对在原生 adapter onPayload，并在 SDK payload hook 之后再检查 owner 内容、视频总数、模型/HTTP override 与完整预算。SDK extension hook 吞错不能作为终止边界。移位/删除/复制/重定向/超限均在 fetch 前 terminal error，不调原 SDK 文字 fallback。
- 性能 relay 收敛包装层失败为 terminal assistant error，不挂起。不是对恶意扩展主动联网的沙箱保证，也未覆盖所有第三方 provider-header/cache 扩展。

## 实现地图与维护

- [video-attachments](../../lib/video-attachments.ts)：client-safe schema/MIME/能力/命令/共享限制；[video-transport](../../lib/video-transport.ts)：owner/SDK conversion/auth/read/Google fail-closed；[video-input-binding](../../lib/video-input-binding.ts)：公开队列边界绑定/投影。
- [RPC](../../lib/rpc-manager.ts)、[pi-types](../../lib/pi-types.ts)、[types](../../lib/types.ts)、[new route](../../app/api/agent/new/route.ts)、[existing route](../../app/api/agent/[id]/route.ts)：薄接线/共享结构类型/启动前拒绝，normal/Chat-only 不漏校验。
- [Picker](../../components/VideoAttachmentPicker.tsx)、[file-upload-client](../../lib/file-upload-client.ts)、[ChatInput](../../components/ChatInput.tsx)、[ChatWindow](../../components/ChatWindow.tsx)：共用上传/分类、门禁、draft/恢复与引用。
- [hook](../../hooks/useAgentSession.ts)、[draft-store](../../lib/draft-store.ts)、[MessageView](../../components/MessageView.tsx)、[reader](../../lib/session-reader.ts)、[context route](../../app/api/sessions/[id]/context/route.ts)：原生展示、有效状态、分支读取隔离与内存恢复。三语言同步。
- [合成夹具](../../lib/fixtures/video-attachments/README.md)及[自动/人工验收入口](video-attachments-acceptance.md)。修改同时维护[文件边界](../agents/files-and-access.md)、[模型契约](model-thinking-picker.md)、[会话说明](../agents/sessions.md)、[独立聊天](independent-chat.md)、[Headless](headless-rpc.md)与[索引](README.md)。

Rebase/SDK 升级必须复验 message_end 先于 appendMessage、请求投影 clone、native metadata、公开 enqueue/consume/clear、canonical projection 和 adapter onPayload 的可靠终止，以及最终 URL/鉴权/完整体积。不能整文件覆盖高交叉 hook/composer/RPC，不能把视频放普通 extension factory 漏掉 Chat-only。保留原 admission/Stop/整轮完成/草稿/设置与分支复制语义；不引入任务依赖。

已知限制：路径可修改/丢失，未发草稿/未知快照仅内存；无播放器/剪辑、跨刷新未发恢复、不可变资产、转码或全 provider 支持。真实网关仅验证具体4秒无音轨样本，长视频/音轨/任意 codec/复杂付费组合/全平台未验，详见[验收边界](video-attachments-acceptance.md#限制与保留风险)。
