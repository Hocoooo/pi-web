# 原视频附件 01–09：公开验收摘要

状态：视频01–09已于2026-10-15分别独立 review / resolved。实现契约见 [F40](video-attachments.md)。这是从本地票据/验收记录提炼的持久摘要，不保存私有路径、会话正文/ID、凭证、真实 payload、捕获 JSON、临时探针或调度日志。原本地 scratch 不属于提交内容；下列命令可在仓库中直接定位。

## 2026-10-16：原生 Google 与真实 Pi Web 会话实测

用户授权后，在当前源码开发服务中创建独立 Pi Web 会话，经真实 HTTP API、SDK 和 TapSVC 请求完成以下检查（没有mock模型响应）：

- 全局 models.json 中目标 Gemini 的 api 保持 google-generative-ai，补齐模型级 /v1beta baseUrl；不改provider其他模型、凭证或全局思考等级。
- 无视频文本请求成功，原生assistant记录 api=google-generative-ai、provider=tapsvc。
- 两个中性文件名、各4秒的合成无音轨H.264 MP4作为同消息附件，正确识别红色/蓝色与静止画面。
- 新普通会话只给 samples 目录，实际执行 find 发现嵌套目录，再执行一次 read_video(paths含两个文件)，正确描述原视频；下一次追问无需重调工具也成功。
- 真实浏览器打开这两个会话，附件会话显示两张视频卡片，目录会话显示正确结果。
- 实测发现并最小修正：以 functionResponse+视频混合contents结束时，TapSVC返回“Requests ending with a model turn are not supported”；改为保留完整工具响应，视频置于紧随其后的独立user contents，目录实测通过。回归测试先红后绿，覆盖合并工具结果、媒体顺序/归属和冷重开。
- minimal思考等级被上游明确拒绝；测试会话改用low后成功。没有修改全局默认等级或自动降级。

本轮没有生产build、全局安装或服务重启。仅验证上述小样本与当前网关；120 MiB、大文件、50 MiB单文件、音轨/任意codec仍未真实验证。测试会话及隔离样本保留供本机查看，公开文档不保存具体会话ID/私有路径/凭证/完整请求。

## 多视频 / read_video 开发迭代

当前实现以 [F40](video-attachments.md) 为准：`videos` / `piWebVideos` 数组（不兼容旧单对象），每次最多4个，每文件20 MiB，完整请求应用预算120 MiB。下文01–09是扩展前的历史验收；新真实小样本验收见上节，不代表大请求网关容量已验。

- 定向单测269项全部通过。SDK + 截获最终 fetch：同一问题的多视频、连续工具结果合并、真实 `read_video` 工具调用后的原媒体续轮、冷重开、文件当前bytes与缺失失败、权限/格式/模型/数量拒绝；工具结果owner额外覆盖压缩保留/移出、不复活摘要路径，以及非当前分支clone后的引用/兄弟隔离/冷重开。
- 浏览器：`node e2e/video-multiple.mjs`，桌面和移动视口均通过。覆盖多文件拖入、追加顺序、单项移除、4个上限、上传中/失败禁止提交、明确拒绝恢复、原生数组展示、多行Recall及全部UUID确认；HTTP/SSE使用夹具，不是付费模型验收。
- 旧 `video-attachments/drop/retry/reopen/compaction/branch/queue/modes` 浏览器脚本同步迁移至数组，8个隔离脚本均通过（186个PASS检查点）；未进行真实provider请求。
- `tsc --noEmit`、`npm run lint`（零warning）和 `git diff --check` 通过。全量单测一次完成：3235项，3223通过、9跳过、3失败；失败均在 `task-session-copy.test.mjs` 的权限故障注入，干净HEAD导出也复现相同3项，未在本次视频迭代修改它们。
- 全量测试启动需将环境中的相对 `NODE_OPTIONS=--require=./bin/stdio-guard.js` 改为同文件的绝对路径，否则切换cwd的子进程找不到preload（仅调整测试命令环境，不改项目实现）。
- 此开发回归轮未发真实付费请求、未做生产build/install/restart；后续用户授权的真实请求见上节。120 MiB仅是容纳多视频Base64与其他上下文的应用预算，网关容量、长视频/音轨/任意codec仍待验收。

## 票据覆盖

| 票据 | 交付与保留的关键回归 |
|---|---|
| 01 首问 | 单 MP4/AVI chooser、原上传/skip、native user 引用、SDK auth/Google 原 bytes、owner/full tuple/视频总数失败闭合；精确小写 tapsvc，无旧-ID别名；未知 Send 单槽快照/显式权威核对 |
| 02 拖入 | 真 ChatWindow DOM drop 与 chooser 共用 select/upload；MIME/数量/已有上传失败选择冲突；同名 skip 发旧文件当前 bytes，混合 PNG/普通文件/文件夹保持 |
| 03 恢复 | 上传失败移除重选、明确拒绝 draft/rekey、迟到结果按来源隔离、Send 本地互斥、未知/迟到 native owner 不重复恢复，恢复后仍检查当前文件/模型/大小 |
| 04 重开/追问 | native 写盘/销毁→历史 GET→刷新/新页重开→冷 SDK 普通追问；不同 owner/同文字/PNG/工具续轮、当前 bytes、旧文件缺失/无权限及累计/全文预算 |
| 05 压缩 | 实际手动/默认自动 threshold 摘要、逐 owner active/inactive、分页完整 leaf、失败不清空；工具后压缩排除的新 UUID 不得被 context 复活/改写/复制，原 picker 重附新 UUID |
| 06 分支/复制 | canonical ACK 与 before-user 语义、迟到历史/paging/view-cache 代次隔离、ACK→canonical 窗口滚动不启动旧 leaf 分页、新分支结束 fresh flight；fork/fork_branch/clone 的继承与冷开/权限 |
| 07 队列/Stop | SDK 真 enqueue/consume/extension await、steer/follow-up owner、消费时重验、Stop 保留；idle 单视频 full Recall/完整 recallInputs、未知 clear 单槽与第二次 fresh authority、stale plain 不删未知 PNG/video、成功 PNG bytes 恢复/容量变化不截断 |
| 08 模式/模型 | 项目/固定无项目 × 普通/Chat-only，真实所选模型/首次设置同步、exact system/零工具/权限不变；有效视频追问不支持具体组合在接受前拒绝，显式切回继续 |
| 09 综合 | chooser MP4＋DOM drop AVI→上传问答→刷新/冷追问→手动/自动压缩→重附；实际 SDK 兄弟分支 clone→模型拒绝/切回→AVI＋PNG Follow-up→Stop→模型切换→显式消费/冷重开 |

所有自动测试使用临时 agentDir/工作目录、合成媒体与内存或隔离设置，不读取生产凭证、真实对话或修改全局配置。实际 SDK 与原生 Google 最终 URL/header/body 构造执行，最终模型响应为合成 SSE；不能把 final-fetch 捕获算真实网关通过。

## 可执行自动验收

从仓库根目录运行（已有开发依赖与 Playwright Chromium）。下列公共套件不依赖 task 模块：

```sh
PI_OFFLINE=1 node --experimental-strip-types --test \
  lib/video-transport.test.mjs lib/video-queue.test.mjs lib/video-draft.test.mjs \
  lib/session-reader*.test.mjs lib/rpc-manager*.test.mjs lib/rpc-session-info.test.mjs \
  lib/request-performance.test.mjs lib/image-attachments.test.mjs lib/file-access.test.mjs \
  lib/independent-chat.test.mjs lib/chat-only.test.mjs lib/file-upload*.test.mjs \
  app/api/files/upload-route.test.mjs lib/prompt-recovery.test.mjs \
  components/ChatInput*.test.mjs components/MessageView.test.mjs components/BranchNavigator.test.mjs \
  components/ChatWindow.quoted-branch.test.mjs hooks/useAgentSession*.test.mjs hooks/model-switching.test.mjs \
  app/api/sessions/context-route.test.mjs app/api/sessions/detail-route.test.mjs lib/agent-client.test.mjs
for script in video-attachments video-drop video-retry video-reopen video-compaction \
  video-branch video-queue video-modes model-first-prompt settings-commands; do
  PI_OFFLINE=1 node "e2e/$script.mjs"
done
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
git diff --check
```

在带任务功能的分支额外运行（personal 不引入这些模块）：

```sh
PI_OFFLINE=1 node --experimental-strip-types --test \
  lib/task-session-copy-integration.test.mjs lib/task-session-copy-review.test.mjs
PI_OFFLINE=1 node --experimental-strip-types --test lib/task-session-copy.test.mjs
```

开发期最终 task 分支有界相关组为 **571/571**（公共组与上述 integration/review 合并执行），tsc/lint/diff-check通过。这是历史验收，不是合并后或全量 npm test 的替代；分支集成后必须记录实际结果，不按旧数字推定通过。

集成时 `video-drop` 的 mobile mixed-drop 曾重复暴露 notice 遮挡 Send：该独立 harness 未加载 ChatWindow 使用的布局 utilities，history 高度塌为零，composer 被错误放在顶部；task 控件占位曾掩盖此缺口。补齐与其他视频 harness 一致的 flex/relative/overflow 布局，并在 notice 仍可见时断言底部 Send 的实际 hit-test 可达，继续普通 pointer click；未改业务 notice 行为、force-click、隐藏提示或削弱 owner/bytes/skip 断言。`video-branch` 集成首轮曾在事件桥接遇到页面已关闭异常，原样复跑通过；首失败仍保留在集成记录，不能据复跑宣称根因已修复。

最新开发期浏览器结果：video-attachments 14、drop 10、retry 30、reopen 8、compaction 16阶段、branch 20、queue 48、modes 40、model-first-prompt 12、settings 桌面/移动2。compaction 与 modes 最终各连续三轮通过，重复轮次不累加为独立场景。它们挂载真实 ChatWindow/composer/hook/MessageView/BranchNavigator，通过真实上传/history/agent handlers 与 SDK，HTTP/SSE/Next shell桥接和最终答案为夹具；不是生产 Next/AppShell 整页或 OS 原生拖拽验收，不启动/重启健康开发服务，不需要 next build。

## 历史真实 UI→TapSVC 证据（本次集成不重跑付费请求）

2026-10-15 最终业务源码的独立 Next/Turbopack、独立 .next/agentDir 正常 AppShell UI，以已有授权的精确 tapsvc（源 anthropic-messages，无旧 TapSVC ID映射）完成 MP4 chooser 与 AVI DOM drop 各一次真实付费首问：

| 合成文件（均4秒/320×240/10fps/yuv420p/无音轨） | 原文件 / 最终 wire | 结果 |
|---|---:|---|
| 红色 H.264 MP4 | 2,755 / 13,114 bytes | HTTP200，未提示答案时颜色回答正确，刷新原引用保持 |
| 蓝色 MPEG-4 Part 2 AVI | 13,562 / 27,522 bytes | HTTP200，未提示答案时颜色回答正确，刷新原引用保持 |

两次均 native Google `/v1beta/models/google/gemini-3.8-flash:streamGenerateContent?alt=sse`、HIGH、所属 user/原 bytes/MIME 匹配；SDK auth/Bearer/API-key header仅核对布尔，不记录密钥。观察器只记录脱敏元数据并调用原 fetch/原样返回真实响应，无 API mock/直接模型探针；临时观察行扣除后与当时923个最终应用文件逐字节匹配。两请求无重试/辅助自动标题调用，原生 JSONL 仅路径引用，页面无 error。独立 reviewer 核实源码/入口证据与清理，临时服务/凭证删除，用户配置字节不变，原健康服务未重启。

早期01曾用旧-ID临时映射成功，不作为当前入口证明；0.4秒32×32小型单测夹具在 OFF/HIGH 均真实400，未确定网关最小尺寸/时长门槛、不归咎 OFF。小型提交夹具只证明原字节传输，不承诺真实网关解码。

## 人工验收入口

需要真实模型时先单独取得费用授权，使用无敏感内容测试会话：

1. 精确目标模型选择/拖入单视频→上传状态/skip提示→问题 Send→native引用/回答；上传中、多视频、非法 MIME、命令/粘贴明确拒绝且不丢输入。
2. 上传失败移除重选，发送明确拒绝恢复文字/PNG/video，再显式重试；未知响应核对历史/idle 后只恢复一次，不自动发送，已有 native owner 不恢复副本。
3. 两轮各视频后刷新/新页重开，普通追问仍携带两 owner；修改较旧文件使用当前 bytes，删除/失权整次失败，修复后仅显式追问。
4. 实际压缩后 inactive 引用保留且不再自动携带，分页/冷开一致；重新附加建立新 UUID，不复活旧 owner。分支来回导航/前后 fork/clone 不带兄弟媒体，待 canonical 期间分页/Send不污染新分支。
5. 运行中显式 Steer/Follow-up 后 Stop，未消费输入留 SDK；idle 空 composer 单视频 Recall完整恢复，运行中/多视频/满图片容量先拒绝；丢 clear ACK 不自动重复清空/恢复副本。
6. 项目/无项目与普通/Chat-only 检查同样能力/权限；切不支持模型的有效视频追问先拒绝并恢复输入，显式切回继续，默认/工具不变。

## 限制与保留风险

- 20 MiB/file、完整32 MiB/request＋64 KiB余量是应用预算，不是网关极限。超限不删媒体/文字降级/自动压缩；无压力/全排列测试。
- 路径不是不可变资产，可修改、丢失、失权；复制 session 不复制文件。未发 draft/未知快照仅页面/模块内存，刷新/切走重开可丢；已发引用冷开不等于未发恢复保证。
- 真实网关仅上述两个具体编码/尺寸/无音轨首问；长视频、音轨/同步、字幕/多轨、任意 codec/高分辨率、真实多轮/多视频/压缩/分支/复制/模型切换/队列/Stop/工具续轮/失败极限矩阵未验。Google源协议、无项目/Chat-only仅隔离验证。
- 开发期 task-copy原16项为13 pass/3 fail，06 worker/reviewer已在未修改 HEAD 隔离快照复现：原agent POST structured relation failure、SDK创建后存储权限失败、runtime clone relation-write failure。不是通过、未修改/skip断言，也不由视频绿色组代证。
- 08曾一次等待恢复文字超时，后续多轮未复现但根因仍未知；未宣称修复或纯环境。保留严格 draft/PNG断言。
- 无本次新增付费网络、全量 npm test、生产 build/install、服务重启、最低 Node/跨平台/旧浏览器/OS原生文件对话框验收。SDK/final-fetch与Chromium/触屏模拟不替代这些边界。
