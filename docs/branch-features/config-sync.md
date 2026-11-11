# Git 配置同步

> 实现基线：`4f7d81a` 工作区，Pi Web `0.10.0-personal.6` / Pi SDK `1.0.0`。

## 目的与范围

在设置的 MCP 后增加“配置同步”页签。用户绑定可信 Git 仓库后，手动 Push 本机共享配置，或 Pull 仓库配置并应用到本机。

这是全局配置同步，不是备份或会话同步。不建立云账号，不后台同步，不自动解决冲突，不强推。静态 `demo/` 不在本次范围。

## 入口与本机状态

- 桌面设置页签、手机设置下拉菜单，均位于 MCP 后；无项目也可打开。
- 首次填写 HTTPS / SSH 仓库和分支，勾选信任确认后保存。空分支由界面补为 `main`。
- 常驻界面仅保留两个字段、保存/推送/拉取和同步结果。信任确认只在新建或修改绑定时显示，同时说明配置替换、插件执行和资源清理责任；不重复标题、全局标签、操作说明或空状态。时间与短 commit 合并展示。
- 使用服务所在机器的 Git 凭证。仓库地址不接受内嵌 HTTPS 凭证、查询参数、片段或本地文件路径。
- 本机绑定、最近成功操作、配置摘要和已管理文件清单存于 `<agent-dir>/config-sync.json`。该文件不上传。
- 打开页签只读本机状态，不拉取仓库、安装插件或发起模型请求。

API 为 `/api/config-sync`：GET 读状态，PUT 保存 `{ repository, branch, trusted: true }`，POST 执行 `{ action: "push" | "pull" }`。不接受浏览器提供本机目标路径或强制覆盖参数。所有方法检查请求来源，写请求要求 JSON。

## 仓库约定

根目录必须有 `models.json` 和 `settings.json`。其他资源可选。未知根目录文件不会导入；Push 保留远端 README 等非同步内容。

| 仓库路径 | 本机来源 / 去向 |
| --- | --- |
| `models.json` | `<agent-dir>/models.json` 的可共享模型定义 |
| `settings.json` | 全局设置允许清单，见下文 |
| `skills/` | `<agent-dir>/skills/` |
| `agent-skills/` | `~/.agents/skills/` |
| `agents/` | `<agent-dir>/agents/`；`settings.json` 只共享 `builtInEnabled` 和 `disabledBuiltIns` |
| `extensions/`、`prompts/`、`themes/` | agent 目录下的同名资源目录 |
| `AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md` | agent 目录下的同名文件 |

最小模型定义示例：

```json
{
  "providers": {
    "example": {
      "baseUrl": "https://example.invalid/v1",
      "api": "openai-completions",
      "apiKey": "${EXAMPLE_API_KEY}",
      "models": [{ "id": "example-chat" }]
    }
  }
}
```

`settings.json` 的允许清单以 `lib/config-sync-data.ts` 的 `SHARED_SETTINGS` 为唯一实现来源。目前包括：模型默认值及等级映射、`enabledModels`、思考预算、压缩/分支摘要/重试/图片设置、技能命令开关、Code mode 参数、归档报告模型选择和远端插件清单。

`defaultTools`、shell/代理/编辑器路径、资源路径列表、项目设置、MCP 配置、浏览器偏好、信任和认证记录、会话与任务数据均不共享。子代理 `maxConcurrent` 保留本机值。

## 行为要求

1. **显式操作。** 保存绑定不访问远端。Push/Pull 只使用已保存的绑定。草稿未保存时禁用操作；服务端同一绑定加文件锁，并发请求返回 busy。
2. **凭证留在本机。** 不遍历 `auth.json` 等运行目录。模型明文密钥、凭证字符串和字面量 headers 不导出；只保留环境变量引用，不共享 `!command`。模型端点必须是无内嵌凭证/片段的 HTTP(S) URL。导入同一 provider / model 时，本机私有凭证优先于仓库引用。若仓库删除的 provider / model 仍含本机私有凭证，预检拒绝 Pull，先由用户整理凭证；不静默删除凭证，也不保留隐藏的旧定义。独立 `auth.json` 不变。
3. **资源按原样上传。** 不声称可检测任意脚本、Markdown 或二进制中的秘密。保存绑定时要求用户确认上传资源不含秘密。跳过 `.git`、`node_modules`、`.env` / `.env.*`、`auth.json`、`mcp-auth.json` 和常见缓存项。目录链接可导出其资源内容，内部越界链接/循环拒绝；文件链接拒绝。导入不接受链接或 submodule，也不跟随本机目标链接/junction。
4. **插件固定版本。** 远端插件使用 npm 精确版本或 Git 完整 commit。未固定的本机声明可从已安装版本生成固定声明，不为 Push 安装插件。保留资源过滤和启用状态。本机路径插件不上传，Pull 保留它们。Pull 通过 SDK 安装/解析，再验证实际版本；离线跳过安装不能视为成功。失败不应用配置，但安装产物可能已落盘。
5. **Push 不覆盖新历史。** 首次可发布到空分支或仅含 README 等非同步文件的分支。远端已有共享配置但本机未 Pull，或远端 commit 不等于最近同步版本时拒绝。普通 push 再次防止网络期间的并发更新，绝不 force push。
6. **Pull 检查本机修改。** 首次 Pull 应用共享字段，缺省共享字段从全局设置中删除；本机专属字段保留。后续 Pull 若检测到上次成功同步后未上传的共享修改则拒绝。拉取/安装期间的修改也检查；不把旧快照标成已同步。
7. **只删除已管理资源。** 仓库删除的文件只在本绑定先前管理过时删除。不删除未管理文件；同路径、不同内容的未管理资源拒绝覆盖。大小写冲突及跨版本仅大小写重命名拒绝，避免 Windows 删除刚导入的同一文件。
8. **先校验，再安装，再应用。** Git 使用独立临时仓库，通过 tree/blob 读取内容，不 checkout，不运行仓库 attributes/filter/hook。目标预检在插件安装前执行。最多 3,000 文件，每文件 10 MiB，总计 50 MiB；拒绝路径穿越、Windows ADS/保留名、大小写冲突。Git 子进程不继承 `PI_WEB_PASSWORD` 等 Web 宿主变量，不弹交互式认证，不向浏览器返回原始 stderr。
9. **应用与失败。** 复用全局设置文件锁和原子写入；资源支持二进制和执行位。正常写入失败时恢复本次写入前的资源，不能恢复时明确 `applied: true`。远端传输或本机应用已完成、但回执保存失败时不报成功，要求检查两端状态。临时仓库在操作后清理。
10. **不打断会话。** Pull 清理服务端模型缓存，返回重载提示，不主动 reload/stop AgentSession。用户可点“重新加载当前会话”，或新建会话；重载失败保留提示。已打开的其他设置面板可能需要关闭重开以重新读取资源。

## 实现导航

- [config-sync.ts](../../lib/config-sync.ts)：绑定、文件锁、Push/Pull 顺序、摘要与回执。
- [config-sync-data.ts](../../lib/config-sync-data.ts)：共享字段唯一清单、凭证规则、资源收集/应用、SDK 插件处理。
- [config-sync-git.ts](../../lib/config-sync-git.ts)：非交互 Git、URL/分支/路径校验、tree/blob 读写。
- [config-sync-types.ts](../../lib/config-sync-types.ts)、[API route](../../app/api/config-sync/route.ts)：浏览器契约与请求边界。
- [ConfigSync](../../components/ConfigSync.tsx)、[SettingsPanel](../../components/SettingsPanel.tsx)、[settings-navigation](../../lib/settings-navigation.ts)：页签、表单和显式重载。
- [atomic-file](../../lib/atomic-file.ts)、[global-settings-file](../../lib/global-settings-file.ts)：二进制原子文件写入与全局设置锁。
- [设置 UI 说明](../agents/settings-ui.md)、[模型说明](../agents/models.md)、[工具说明](../agents/tools.md)：相关已有接口。

## 自动验收

```bash
node --experimental-strip-types --test lib/config-sync*.test.mjs app/api/config-sync/route.test.mjs components/ConfigSync.test.mjs components/SettingsPanel.test.mjs lib/settings-navigation.test.mjs
node --experimental-strip-types --test lib/atomic-file.test.mjs lib/codemode-settings.test.mjs lib/powershell-settings.test.mjs lib/task-report-settings.test.mjs app/api/tools/settings/route.test.mjs
node e2e/config-sync.mjs
node node_modules/typescript/bin/tsc --noEmit
```

Git 测试只使用临时 bare 仓库，通过隔离的 Git URL rewrite 验证 HTTPS 形状的绑定，不访问真实远端。覆盖往返、无变化 Push、二进制、两种技能目录、密钥/本机字段保留、管理删除、未管理冲突、远端变更、API 来源检查和安装失败。安全测试覆盖 Git 链接 blob、目录 junction、大小写重命名、URL/命令引用、容量边界、本机凭证优先/删除保护、最终设置写入恢复和远端成功但回执写入失败。文件 symlink 按系统权限独立跳过，目录 junction 检查继续执行。

浏览器测试挂载实际 SettingsPanel，拦截全部 HTTP，覆盖三种语言、1100px/390px、保存信任、忙碌/错误重试、草稿保留和显式重载。它不是完整 Next 服务、Git 凭证或第三方插件安装验收。

## 人工验收

使用专门测试仓库和两个隔离 agent 目录，预先配置各自 Git 凭证和同名 Provider 环境变量。

1. 无项目打开设置，确认 MCP 后可进入配置同步。只打开时无 Git 网络请求。
2. 保存可信仓库，在 A 点击 Push。在仓库检查模型定义、固定插件版本和完整资源；确认无认证文件/模型明文 Key。
3. B 点击 Pull。确认默认模型和资源落盘，B 的密钥、本机路径、子代理并发设置不变。新会话或显式重载后检查资源。
4. A 删除一个已同步技能文件并 Push；B Pull 后该文件消失，B 未管理技能仍在。
5. B 修改共享设置后 Pull；应报冲突并保持原文件。另一端更新后再 Push，应拒绝覆盖远端历史。
6. 使用不可访问插件或离线缺失插件；应报安装失败，配置和成功回执不推进。

真实 Git/插件认证和安装可能访问外网并执行安装脚本，须使用明确授权的测试资源。本轮不使用用户真实仓库、密钥或全局安装验证。

## 局限与 rebase 清单

- 原子性按单文件保证，正常异常有内存恢复；进程中断/断电不是跨文件事务，也没有后台自动修复。回执失败按未知结果人工核对，不自动强推或丢弃修改。
- 插件安装受 SDK 的离线规则、认证和安装器行为约束，不提供新增沙箱或可中止安装器。平台脚本依赖仍需各机器自行满足。
- 资源中的自定义秘密、非标准凭证文件无法自动识别。模型字面量 headers 均留本机，依赖这些 headers 的网关需逐机配置，或改为环境变量引用。
- 只支持约定资源和共享字段；不把整个 agent 目录或项目目录加入 Git。新字段须显式加入唯一允许清单并补测试。
- rebase 时保留 MCP 后的全局导航、三语言文案、API 来源检查、SDK 包版本验证和原子写入测试。若 SDK 改动包路径/离线行为或认证值语法，先更新契约和回归，不做静默兼容。

修改同步范围、失败语义、存储/API 或入口时，同步本文件与 [README 索引](README.md)。
