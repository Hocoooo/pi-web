# 子代理委派建议：可选评估而非执行门禁

> 维护基线：`63c6e4e`，对应上游 `96966e5`。以下测试入口不构成真实 Jev 服务可用性或策略效果的证明。

## SDK 1.0.0 整合

`assess_subagent` 与上游的委派控制工具一样声明 `exposure: "model-only"`，不暴露给 JavaScript 执行工具。它仍只是可选建议，不能授权或自动启动委派；注册测试单独验证建议工具与三项控制工具。

## 目的与阅读分流

修改内置子代理工具注册、委派策略、外部评估请求、缓存或 rebase 整合时读本文。目的：在真正存在权衡的规划节点，为一个**有边界、可独立交付**的候选子任务提供 `direct` / `delegate` / `unknown` 建议；父代理和用户仍控制执行。

详细协议与使用政策以现有 [subagent-delegation-advice.md](../subagent-delegation-advice.md) 为维护入口；改请求字段、长度限制、环境配置、返回值或缓存协议前必须阅读它，并对照实现。本页记录分支功能契约和验收方法，不另抄完整 JSON schema，也不维护第二份远端协议示例。

非目标：自动每轮路由、强制审批门槛、根据 confidence 自动创建子会话、Jev 准确率证明、通用 `jev_evaluate` 扩展替代品。独立安装的通用评估扩展不参与此集成，也不要求读取它的路径/密钥文件。

## 入口、默认值与源码导航

| 入口 | 契约位置 |
| --- | --- |
| 内置扩展注册 | [subagent-extension.ts](../../lib/subagent-extension.ts) `createSubagentExtension`：启用时注册 `assess_subagent` 与 `Agent`，委派使用时机写入 description / promptGuidelines。 |
| 评估工具 | [subagent-advice-tool.ts](../../lib/subagent-advice-tool.ts) `createSubagentAdviceTool`：参数校验、执行时启用检查、host context 与会话阶段标识、文字结果和 details。 |
| 请求与缓存 | [subagent-advice.ts](../../lib/subagent-advice.ts) `createSubagentAdvisor`、`unavailableSubagentAdvice`、`parseAdvice`、`readBoundedJson`。 |
| 会话加载/子级隔离 | [rpc-manager.ts](../../lib/rpc-manager.ts) `startRpcSession`；[subagents.ts](../../lib/subagents.ts) `SUBAGENT_CONTROL_TOOL_NAMES`；启用设置见 [subagent-settings.ts](../../lib/subagent-settings.ts)。 |

启用内置 subagents 后工具才可能注册；Chat-only 不加载这套内置扩展。真实评估使用服务进程环境的 `TAPSVC_API_KEY`，不是模型供应商认证或 models.json。更改环境后重启服务；应用升级后刷新/重载已有会话的工具描述。工具可在无 key 时存在，但调用返回 fallback，不自动向用户索要密钥或尝试其他凭证来源。

基线 advisor 的默认总时限为 3000 ms，`PI_SUBAGENT_ADVICE_TIMEOUT_MS` 在 250–10000 ms 范围有效，非法值回落默认；缓存成功结果 5 分钟，每个 advisor 最多 32 项。配置细节和输入限制的单一说明见上面的详细协议文档。

## 必须保持的具体不变量

1. **建议不能启动或阻止 Agent。** `assess_subagent` 只评估，不创建子会话、不写权限、不调用 runtime.start。`Agent` 路径也不隐式查询 advisor；即使上次建议 direct 或 unknown，已获授权的 Agent 仍可执行。confidence 是展示信息，不是启动阈值或正确率承诺。
2. **用户指示优先，简单任务留在父代理。** 明确要求使用/避免子代理时，依既有权限和可用性执行，不让 Jev 覆盖用户选择。简单、快速、紧耦合顺序任务不需要评估；复杂、长对话、失败次数、上下文占用率单独都不是委派理由。这些是模型遵循的 prompt policy，而非确定性防调用规则。
3. **仅在真实权衡节点使用。** 例如独立重探索、独立验证假设、有父任务可并行推进的工作；摘要需同时描述隔离收益、交接成本、等待和共享文件写入风险。`inherit_context:false` 配已核实事实/约束是新上下文调查的优先建议，不是强改所有 Agent 参数默认值。并行写者需隔离，不能把同一任务再次分派给正在工作的子代理。
4. **关闭后旧工具也失效。** 扩展 factory 入口先检查 enabled，工具 execute 再检查，防止会话保留旧工具对象后继续外发。Chat-only 不注册；子会话的 `excludeTools` 包含 `SUBAGENT_CONTROL_TOOL_NAMES` 中的 `assess_subagent`，阻止递归评估编排。不能只删 UI 开关而留下后台调用能力。
5. **只发送有界显式摘要和粗粒度使用率。** 工具只接受协议规定的任务、候选交付、利弊摘要；advisor 只选取这些字段与 10% 档位的 context usage 构造 state。host 不自动读文件内容、完整 transcript、system prompt 或 reasoning。sessionId 与当前分支最近 user/compaction entry ID 只参与本地缓存键；不得外发。host 读取 branch 找阶段标识不等于上传分支内容。
6. **摘要内容本身仍须获准外传。** 固定 HTTPS 端点与固定模型见详细协议及 `ENDPOINT` / `MODEL`；使用 Bearer key，`redirect: "error"`，不改用任意用户输入 URL。没有每次调用的人类确认框，也没有自动秘密脱敏器：即使 host 不主动收集秘密，代理填入摘要的秘密仍会被传出。敏感材料无法安全概括时跳过评估，继续正常判断。
7. **延迟和失败必须有界。** 总时限覆盖请求和读取响应 body；AbortController 加 Promise.race 约束不合作的 transport/卡住的读取。无自动重试；缺 key、非法输入、预取消不发请求，网络/HTTP/畸形或超大响应返回有限 fallback。取消与服务不可用有区分；主任务继续，而不是为获得建议循环调用。
8. **远端输出仅取白名单。** `readBoundedJson` 限制响应体 32000 bytes；`parseAdvice` 校验 recommendation、confidence、概率范围与集合/总和，仅返回已知字段。HTTP 错误体、任意 debug/metadata/远端文本不注入对话。固定 rubric 明确把 state 当证据而非指令，但这不是对摘要语义攻击的绝对保证。
9. **缓存依赖证据和阶段，不依赖整段历史。** key 为规范化摘要、粗档位和本地 scope 的哈希；同阶段/同档位可复用，新用户条目、compaction、另一个 session、档位或摘要改变需新评估。成功解析的 unknown 也可能是有效成功结果并被缓存；网络等 fallback 不缓存。达到上限逐出旧项，不是永久数据库，也不宣称严格 LRU。
10. **持久性与平台边界明确。** advisor cache 在内存，扩展重载丢弃；正常 Pi 会话日志仍可记录工具参数/结果，不能声称摘要「绝不落盘」。没有专用全局评估历史或设置库。该模块没有 Windows 分支；实际网络、证书、代理与 server 环境影响服务可达性。不要把 Windows 安装器成功保留环境等同于 API key 已实测有效。

## 自动化验收（仓库根目录）

前置：项目所需 Node 与依赖已具备。以下命令不需要真实 TAPSVC_API_KEY；测试使用注入 transport，不访问 Jev。不要为跑单测添加真实密钥。

```bash
node --experimental-strip-types --test lib/subagent-advice.test.mjs lib/subagent-extension.test.mjs lib/subagents.test.mjs
```

覆盖边界：

- [subagent-advice.test.mjs](../../lib/subagent-advice.test.mjs)：固定端点/模型、发送白名单、粗档位、错误净化、超时、取消、缓存失效/上限、旧工具关闭后行为；用 mock runtime 证明评估不启动子任务，且 direct/unknown 不阻断之后 Agent。
- [subagent-extension.test.mjs](../../lib/subagent-extension.test.mjs)：内置注册、描述和政策，以及已有 Agent 功能回归；描述断言不是模型一定遵守策略的证明。
- [subagents.test.mjs](../../lib/subagents.test.mjs)：子工具控制集合的排除规则；仍须确认启动流程继续使用该集合，不能只保留常量。
- 测试不是 Jev 真实协议/鉴权/延迟/路由准确率验收。详细协议文档记载的一次历史 smoke 不是本次运行结果，也不是持续 SLA。

## 手工验收：先离线，真实服务另行授权

前置：隔离会话、已知 enabled/Chat-only 状态、可以重新加载的测试服务；允许调用工具的测试模型或宿主测试夹具。关闭任何真实远端 key 或使用注入 transport 时可完全离线检查机制。

1. 打开内置 subagents，在普通会话查看工具表：预期 assess_subagent 和 Agent 同时可用；切换关闭并重载后均不应再注册。保留旧工具的受控夹具里关闭开关再 execute，预期 disabled、transport 计数为 0。Chat-only 与子会话工具表不得出现 assess_subagent。
2. 无 key 时向 assess_subagent 提交符合详细协议的无敏感摘要，预期 unknown / not_configured；不产生子会话、不重试。无须为了正向测试配置真实 key；已有测试覆盖注入的成功返回。
3. 在注入 transport 的夹具里分别返回 direct/delegate/unknown，统计 runtime.start 次数始终为 0；随后显式执行已授权 Agent，预期依其原本规则启动，与建议类别无关。对建议的「advisoryOnly」文字和 details 都作检查，不能只看 UI label。
4. 重复同一输入/阶段，预期 cache 命中；变更利弊证据、切换档位、增加用户消息或 compaction，预期新请求；重载 advisor 后也重新请求。负例为网络失败、429、畸形/超大 body、卡住 transport、取消：均有界返回，不泄漏上游错误体，失败不污染缓存。使用假时钟测试 TTL，不让真人等待充当唯一证据。
5. 如另获**外部传输许可**，才配置进程 key、重启并用一个合成无秘密摘要做 live smoke。预期响应可解析为建议且不自动产生子任务；记录总耗时、超时设置、cache 状态和最终 fallback/成功，不记录 key。401/429/超时应继续正常规划，不更换凭证来源或反复重试。该步骤不是本页编写任务的一部分。
6. 策略体验另行抽样：简单修正、明确「不要委派」、独立调查、需要共享文件写入四类任务，观察是否不必要评估/委派、交接时间和返工。一次模型偏离不说明网络层坏了；prompt policy 的统计效果与机械断言分别报告。

## Rebase / 上游整合清单

- [ ] 对照本分支新增 advisor/tool 与上游 `Agent` 注册改动；保留建议的可选属性，不把它接成每轮 hook 或 runtime.start 前置门禁。
- [ ] 三处一起审查：extension factory、execute 的 enabled 检查、子会话 excludeTools；不能仅合并工具名字符串。
- [ ] 上游扩展 API/会话 branch/context usage 有变化时，核实本地阶段定位仍取最近 user/compaction，且不外发内容或 ID。
- [ ] 若上游已有类似 advisor，先对齐数据外传、超时、失败和缓存边界，再决定合并/去重，避免双重请求和互相矛盾的 Agent promptGuidelines。
- [ ] 修改协议先更新 [详细协议文档](../subagent-delegation-advice.md) 与测试；本页只同步行为边界，不增加竞争性 schema。
- [ ] 验证 Agent 原有前台/后台/取消路径仍可独立工作；保留远端失败不阻塞主任务的负例。

## 限制与维护完成标准

这套集成不保证模型每次都理性委派，也不提供任意任务的准确率、校准 confidence 或生产延迟承诺。进程内缓存不是权限记忆；不经评估执行 Agent 仍必须遵守现有授权。

维护完成需同时具备：更新后的基线；每项协议变化已反映到详细协议唯一入口；安全/失败/注册边界的测试结果及平台；明确列出未做的 live smoke 与策略效果评估。仅阅读源码时报告「未运行」，不要复用历史 smoke 作为当前验证。
