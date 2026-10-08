# 模型与思考等级两步选择

> 功能基线：`63c6e4e`（`personal/customizations`，基于上游 v0.9.3）。本文件描述当前契约，不按早期提交标题推断行为。

## 目的与范围

让用户先选择模型，再选择该模型支持的 thinking level，确认后一起应用。浏览、搜索、返回和取消不应更改会话设置。按钮入口和 `/model` 入口使用同一选择器，避免快捷命令与图形控件行为分叉。

本功能不负责增加 provider、认证、修改 `enabledModels` 的解析规则，也不替代上游的模型默认值、thinking pin 和运行中回合信息展示。

## 入口与默认行为

- 输入区的模型按钮；输入 `/model` 或带搜索文字的 `/model …` 打开模型筛选。
- `ChatInputModelControl` 向 `ModelSelector` 提供 `thinking.onConfirm` 时开启两步流程。其他复用位置没有该配置时仍允许单步选择，不能把所有 `ModelSelector` 强制改成两步。
- 候选以 `provider:modelId` 标识，不能只按模型名或裸 ID 区分不同 provider。
- 第二步优先沿用当前等级（仅当目标模型支持）；否则选 `high`，再否则选目标等级列表的首项。列表为空时显示无可用等级，不擅自发送一个猜测值。

## 行为要求

1. **延迟提交**：第一步选中模型只更新本地候选；第二步确认才调用 `onConfirm(provider, modelId, level)`。取消和返回不得写入运行时。
2. **目标模型能力**：等级来自目标模型的能力映射，不能继续显示原模型的等级。展示名称可通过 level map 映射，但提交的是等级 key。
3. **可搜索键盘导航**：在模型列表按上下键后仍能直接打字筛选；名称、模型 ID、`provider/modelId` 均可匹配，忽略大小写。打开时当前项滚动到可见区域。
4. **按键**：上下键循环移动；模型搜索框中 Ctrl/Meta+Home/End 跳首尾，保留普通 Home/End 编辑语义；第二步 Home/End 跳首尾；Enter/右方向键进入或确认；第二步左方向键返回第一步且保留搜索；Escape 取消。IME 组合输入不触发选择。
5. **单次提交**：保存中禁用重复操作，不能并行切换多个目标；出错时显示错误并保留选择器，不能伪装为成功关闭。
6. **忙碌保护**：前端和 RPC 都拒绝在生成、压缩、bash 执行等忙碌状态切换；RPC 不依赖 UI 禁用来保障正确性。
7. **联合 RPC**：已有会话用一次 `set_model` 请求携带可选 `thinkingLevel`。服务端在改设置前验证目标模型及等级；只在联合选择期间抑制扩展的 TUI select，避免额外弹出第二个 thinking picker，结束后必须恢复。
8. **有效结果**：服务端返回有效等级，前端刷新权威会话状态。网络失败可能发生在服务端写入之后，因此错误后也需回读，不能只把乐观状态当作事实。
9. **空白会话**：尚无运行时的会话先保存 composer 的模型/等级选择，不为单纯浏览列表创建会话；若运行时已经创建或正在创建，则同步已有运行时并处理失败恢复。首次发送等待创建完成后，若 composer 明确选择了模型，先回读权威 `get_state`；模型及显式等级一致时不得重复执行 `set_model`，否则一次联合请求同步模型与显式等级。SDK 即使设置同一个模型也会重新解析默认等级，盲目重设会把 `high` 覆盖成默认 `medium`。未显式指定等级时保留同模型运行时的有效等级（包括已被 SDK 调整的 scope pin），不得重发原始 pin 或发送 `auto`。
10. **保留上游语义**：`auto` 是前端选择语义，不作为具体 thinking 等级发送；保留项目范围候选、默认值和 pin、实际运行回合的等级显示。不要把持久化偏好与当前运行回合状态混为一谈。

## 实现导航

| 位置 | 关注内容 |
|---|---|
| [ModelPicker.tsx](../../components/ModelPicker.tsx) | 本地候选、两步状态、保存互斥、键盘与错误展示 |
| [ModelSelector.tsx](../../components/ModelSelector.tsx) | 弹层、忙碌状态、外部打开请求 |
| [ChatInputModelControl.tsx](../../components/ChatInputModelControl.tsx) | 候选适配、thinking 配置 |
| [ChatInput.tsx](../../components/ChatInput.tsx) | `/model`、`/thinking` 与输入框命令分流 |
| [model-picker.ts](../../lib/model-picker.ts) | `modelKey`、筛选和初始等级规则 |
| [model-command.ts](../../lib/model-command.ts)、[picker-keyboard.ts](../../lib/picker-keyboard.ts) | 设置命令识别、统一返回类型与其他设置 picker 的 DOM 键盘工具；修改共享按键时一起核对 |
| [useAgentSession.ts](../../hooks/useAgentSession.ts) | `handleModelChange`、`handleThinkingLevelChange`、乐观状态与回读；`handleSend` 的首次发送设置核对 |
| [rpc-manager.ts](../../lib/rpc-manager.ts) | `set_model` / `set_thinking_level`、目标能力验证和 select 抑制 |

## 自动验收

在仓库根目录、已安装开发依赖后运行：

```bash
node --experimental-strip-types --test lib/model-picker.test.mjs lib/picker-keyboard.test.mjs lib/rpc-manager-settings.test.mjs hooks/model-switching.test.mjs hooks/useAgentSession.settings.test.mjs components/ChatInput.test.mjs
node e2e/model-flow.mjs
node e2e/settings-commands.mjs
node e2e/model-first-prompt.mjs
```

- 单测包括纯函数、源码结构契约及抽取 handler/mock runtime 执行，不等于真实 provider 联调。
- 浏览器脚本将组件或 hook 打包后在 Playwright Chromium 中运行，不要求启动 Next 服务，也不应调用真实模型。需要浏览器安装和当前依赖中的打包工具可用。
- `model-flow` 覆盖桌面/移动宽度、可见当前项、搜索与键盘、目标能力、取消、延迟提交、错误保留和 busy 状态。
- `model-first-prompt` 挂载真实 `useAgentSession`，通过模拟 HTTP/SSE 传输连接项目 RPC 与真实 SDK；使用内存设置/会话、隔离的资源目录及测试 provider，不读取或改写用户凭证、全局设置或真实会话。断言测试 provider 收到的实际 reasoning effort，覆盖已创建/创建中的运行时、休眠 composer、显式等级、默认 `medium`、scope pin（含 SDK 调整）、显式选择覆盖 pin、后续等级选择及运行时模型/等级不同步时的恢复。该测试不证明真实 provider 联调。

## 人工验收

前置：至少两个能力不同的可用模型；使用测试会话，不修改重要对话。

1. 记下当前模型与等级，打开选择器，选另一个模型进入第二步。**期望**：此时运行时设置不变；等级属于新模型。
2. 按左方向键返回继续筛选，然后 Escape。**期望**：搜索可继续编辑，原模型及等级保持不变。
3. 再次打开并确认目标等级。**期望**：只提交一次联合选择，弹层关闭，刷新后有效模型/等级一致，无额外 TUI 思考等级对话框。
4. 模拟请求失败。**期望**：看到错误、可重试，刷新权威状态，不出现永久“切换中”。
5. 生成中/压缩中/bash 执行中尝试切换，包括直接 RPC。**期望**：被拒绝，不改动当前运行设置。
6. 在 390px 宽度与较长模型列表重复操作，确认当前项可见、无横向溢出、IME 不误确认。
7. 新建测试会话，全局默认等级为 `medium`。先打开命令补全或 System/Tools 面板创建休眠运行时，再通过 `/model` 选择目标模型及 `high`，发送第一条消息。**期望**：实际运行等级与刷新后的状态仍为 `high`；默认设置不因首次发送同步而被改写。再验证未显式选等级时保留默认值/有效 scope pin。

## v0.10.0 / SDK 1.0.0 整合

- 普通两步选择仍是会话级操作；保留上游 `/api/models/default` 的显式保存入口与项目设置覆盖保护。模型行上的星号直接执行“使用并保存为默认”，不同时触发两步确认；thinking 菜单保留默认星号。模型星号位于独立右侧按钮，默认项显示静态标记。
- 手机通过普通按钮打开模型列表不自动唤起软键盘；通过 `/model` 明确打开时保留搜索焦点。旧弹层的延迟焦点恢复不能抢走新弹层的焦点。
- 上游允许运行中调整 thinking；本分支仍按第 6 条的 idle-only 契约拒绝忙碌期间的设置修改，并保留实际回合 thinking 展示。
- 浏览器 fixture 直接依赖 `esbuild`，已显式列入开发依赖；不再依赖 SDK 间接安装它。`model-flow` 同时覆盖显式默认星号与手机打开焦点。

## Rebase 保留清单与局限

- 高频冲突文件是 `ChatInput`、`useAgentSession`、`rpc-manager`；不可只保留某一方整文件。
- 同时保留本地两步确认与上游能力、范围、启动默认值、会话缓存、SSE/Strict Mode 修复。
- 联合选择是一次 RPC，不意味着底层多个设置写入具有数据库事务回滚；不要做超出实现的原子性承诺。
- 模型能力动态变化、真实 provider 写入错误和扩展弹窗必须按需联调，组件浏览器测试不能证明这些外部行为。

修改入口、键位、等级规则、RPC 返回或默认值时，必须同步本文件与相关测试，并在 [README](README.md) 更新索引或交互说明。
