# Windows / SDK 1.0 全量测试验证契约

核对基线：`55abaf2`，Pi Web `0.10.0-personal.6` / Pi SDK `1.0.0`。本页记录 2026-10-09 安装前测试失败的根因修复，关联 [上游整合](rebase-0.10.0.md) 和 [本地全局安装](local-global-install.md)。不改变生产 MCP 信任、认证、传输或文件授权语义。

## 目的与边界

全量测试必须在 Windows、干净 SDK 1.0 依赖和安装器的隔离 HOME/TEMP 条件下完成，不能靠跳过 `npm test`、删除安全断言或扩大目录授权获得绿色结果。原安装日志在五分钟内记录了 123 条失败，未完成最终汇总；这不是 123 个互相独立的产品 bug。

## 保留的测试约束与修复

1. **源码换行**：根 `.gitattributes` 对文本采用 LF；`.bat` / `.cmd` 保持 CRLF，二进制不转码。源码结构断言依旧严格。`lib/checkout-line-endings.test.mjs` 在临时 Git 仓库、`core.autocrlf=true` 下检查真实 checkout、原生脚本和二进制字节。旧工作区需要一次纯换行规范化；不得覆盖未提交的内容改动。
2. **React 模块身份**：Jiti 组件 fixture 以与组件相同的无扩展名 `@/hooks/useI18n` 导入 Provider。Windows 上显式 `.tsx` 与无扩展名解析可能分别使用正反斜杠的模块缓存键，导致一个组件树使用两个 Context。修复的是 fixture 身份，不是移除 Provider 检查；组件真实静态渲染断言保留。
3. **MCP 资源清理**：`lib/__fixtures__/mcp-test-helpers.mjs` 注册单个 after hook，等待每个 wrapper 的 `shutdown()`，再有界重试删除子进程 cwd；用 `Promise.allSettled` 确保一项失败不妨碍其他会话清理。不得用即返的 `destroy()` 后立即删目录或靠强制退出测试隐藏活句柄。调用点是 host、read-only policy、builtin extensions 三组 integration fixture；cleanup 应在可能失败的扩展绑定之前登记。
4. **Shell / HOME fixture**：marker 命令引用路径与输出，Windows 转换反斜杠但保留空格和单引号为数据。全局配置测试同时隔离并恢复 HOME / USERPROFILE，因 Windows `os.homedir()` 使用后者。可信会运行、不可信绝不运行的断言全部保留。
5. **符号链接能力**：Windows 的目录链接使用无需额外权限的 junction。真正的文件 symlink 不用 hardlink 或 junction 冒充；仅在 Windows 返回 EPERM / EACCES / ENOTSUP / ENOSYS 时显式跳过对应的独立文件链接测试。混合测试拆开，尺寸、目录链接、regular-file、边界授权和路由/列表一致性仍执行；其他错误必须失败。
6. **文件 mode 与拒绝写入**：Code mode 设置测试对照同一文件系统实际以 `0600` 创建的控制文件。POSIX 继续验证 `0600`，Windows 验证系统实际表达的 mode；不声称验证 Windows ACL 隐私隔离。Preview secret 轮换测试在临时文件创建和替换边界定向注入 EACCES，验证真实轮换函数返回 unwritable、保留原 manifest 并清理临时文件；不依赖 Windows 不支持或 POSIX root 可绕过的目录 chmod。
7. **安装器隔离 TEMP**：真实 Windows OS temp 通常在原用户 HOME 下。HOME 隔离后，SDK 祖先扫描可能把用户 `.agents/skills` 认成项目资源，导致新文件夹的信任测试批量失败。构建 TEMP 移至 checkout 外部的 `<runDir>/build-temp`；若 runDir 在原 profile 下则采用 SystemRoot 的 Temp。详见 F14；不能放宽生产信任逻辑来解决 fixture 问题。

8. **异步计时确定性**：MCP idle unit fixture 使用受控 `setTimeout` 时钟、真实 macrotask 刷新 readiness；不得依赖“睡 5ms 一定早于 idle 20ms”这种负载相关假设。stdio integration 在有界 waitFor 内等待两个失败状态真正落地，再验证 stderr 与 masking；不扩大生产 prompt wait 或删除错误断言。

## 实现与回归入口

- `.gitattributes`、`lib/checkout-line-endings.test.mjs`：LF checkout、原生脚本和二进制。
- `components/{BranchNavigator,McpAddServer,McpConfig,McpSignIn,ProjectTrustDialog}.test.mjs`：模块身份与真实渲染。
- `lib/__fixtures__/mcp-test-helpers.mjs`、`lib/mcp-test-helpers.test.mjs`：shutdown 顺序、失败时所有 session 仍清理、shell 引用。
- `app/api/mcp/{route-add,test/route,sign-in/route}.test.mjs`、`lib/mcp-config-read.test.mjs`：可信/不可信行为、HOME、目录与文件链接边界。
- `lib/codemode-settings.test.mjs`：mode 控制文件。
- `lib/{project-trust,regular-file,worktree}.test.mjs`：真实祖先资源与模拟 HOME 隔离、junction、独立文件链接子测试。
- `lib/rotate-preview-secrets.test.mjs`：两处 EACCES 与保留 manifest / 清理 temp 的真实轮换函数行为。
- `lib/mcp-host.test.mjs`：受控 idle 时钟，保留连接关闭与重连状态断言。
- `.pi/skills/pi-web-local-global-install/scripts/lib/{policy,workflow}.mjs`、`lib/local-global-install*.test.mjs`：跨平台 temp 选择、运行目录在原 profile 内外两种情况、目录提前创建和 runtime 环境不变。

```bash
npm ci --include=dev
npm test
node node_modules/typescript/bin/tsc --noEmit
npm run lint
```

必须另外用安装器 `buildEnvironment()` 生成的隔离 HOME / USERPROFILE / PI_CODING_AGENT_DIR / TEMP 环境运行全量 `npm test`，并确保 HOME/TEMP 已创建。这个测试调用只验证测试环境，不能执行安装器 apply、全局覆盖或服务重启。

## 本轮验证

环境：Windows，Node `24.19.0`，Pi SDK `1.0.0`，按锁文件执行 `npm ci --include=dev`，没有跳过全量测试。

- 正常环境 `npm test`：**2,610 项，2,573 通过、0 失败、37 跳过、0 取消**；约 22 秒正常退出。
- 安装器 `buildEnvironment()` 的隔离 HOME / USERPROFILE / PI_CODING_AGENT_DIR / TEMP 环境 `npm test`：**相同结果**，约 22 秒正常退出。
- `tsc --noEmit`、所有修改 JS/MJS/TSX 文件的 ESLint、`git diff --check`：通过。
- 全仓库 ESLint：0 错误；既有 `test-results/keyboard/baseline-file-viewer*.test.mjs` 两处 unused-import 告警，未修改这些旧生成 fixture。
- 37 项跳过包含既有平台专属、进程/FIFO/文件链接能力检查；本轮新增 4 个明确的文件 symlink 能力跳过，其他断言继续运行。未把跳过计为功能通过。
- 完整输出与摘要保留在 sibling `.pi-web-installs/<repo-key>/<run-name>/test-repair-validation/final-rerun/` 的两份 npm-test 日志和 `results.json`。原安装器失败状态与原始日志保留，不改写成安装成功。

全量复测揭露的后半段 fixture 同步修复：project-trust 的模拟 HOME fixture 在 Windows 使用 SystemRoot/Temp，避免受真实用户祖先资源干扰；project-trust / worktree 的目录链接使用 junction；regular-file 的文件链接作为独立子测试，不阻断字节上限、类型和路径检查；preview 轮换的 EACCES 行为独立验证。首次修复后完整测试在约 23 秒退出，原五分钟挂起已消除；并行双全量复测发现的 idle / 冷启动时序假设也已用受控时钟与有界状态等待修复。最终按正常安装检查顺序逐轮执行的两次完整结果如上。

Windows 无文件符号链接权限的检查是明确的验证缺口，需在允许文件 symlink 的 Windows 或非 Windows 环境补验；跳过不能记为该行为已验收。此轮不运行生产 build，不升级全局包，不重启服务。

## 任务看板安装前修复（2026-10-13）

`feature/task-dashboard` 的 `3310e04` 在同一 Windows/Node 24.19/SDK 1.0 环境中隔离安装测试为 2,982 项：2,893 通过、33 失败、56 跳过。失败不是全部环境缺口；修复保留全部原断言：

- **任务错误模块身份**：Jiti 的 `@/lib/...` 与相对导入在 Windows 上可使用不同缓存键。`lib/__fixtures__/task-jiti.mjs` 为 TaskOperationError、SessionCopyError 和报告设置错误的模块提供完整 native-path alias；HTTP、legacy 及报告/复制 fixture 使用同一 helper。`lib/task-jiti.test.mjs` 验证构造器身份与真实操作错误，不改生产 `instanceof` 或降级错误状态码。
- **原生会话目录**：`lib/task-sessions.test.mjs` 交由真实 SDK `SessionManager.create(cwd)` 编码目录，不再把含驱动器/反斜杠的 cwd 直接拼到 sessions 下；历史、项目范围、竞争/唯一归属及生命周期断言继续执行。
- **有效存储故障**：`lib/task-fs-write-fault.fixture.mjs` 在生产模块导入前装配 fs 绑定，仅在显式 armed 时对指定文件的 `open(temp, "wx")` 持续注入 EACCES，finally 恢复。报告分层与复制测试断言注入真实命中、旧字节/材料可读、发送不重做、已知 SDK child 的精确重试和来源生命周期；不依赖 Windows 无效的 chmod，不跳过原场景，也不声称测了 Windows ACL。
- **真实文件替换竞态**：密集读取可令 Windows `rename(temp, report.json/board.json)` 返回 EPERM，普通与隔离全量复跑均曾暴露此问题，并用独立并发读写探针复现。`lib/task-file-replacement.ts` 共用 Windows EPERM/EACCES/EBUSY 同路径 rename 重试，最多 6 次、计划退避总计 310ms（不是包含系统调用的硬耗时上限）；不重发模型、不重做逻辑操作、不重写正文、不删旧目标。board 在每次 rename 前重新检查原锁，退避期间失锁即拒绝提交。永久或持续占用仍失败并清理临时文件。`lib/task-report-write.test.mjs` 验证三类短暂/永久错误与 EIO 不重试；`lib/task-store-write.test.mjs` 验证同 temp/单次 revision、永久失败字节不变/恢复及真实 onCompromised 拒绝第二次 rename。
- **报告自身读写隔离**：`writeTaskReport/readReportFile` 的文件段用既有 `serializeByKey` 按报告 absolute key（Windows 小写）FIFO 排队，跨 route bundle/HMR 共用 `Symbol.for`，防轮询读句柄与自身替换竞争。committed 引用检查仍先执行；I/O 回调不反向获取 board 锁、不读设置、不调用模型，查询不建目录/迁移/写盘。barrier 回归确定性验证 reader 阻塞时 writer 尚未 mkdir，释放后分别得到原/新完整版本，无计时睡眠。它是进程内 I/O 顺序，不是跨进程事务、别名 realpath 合并或无限共享占用保证。
- **恢复进程清理**：独立 service-start fixture 等 executor 完成后关闭全局 HTTP dispatcher 并自然退出，不使用 `process.exit()` 与 Windows libuv 活动句柄竞争。保留真实启动入口、持久边界、进程重启及请求次数检查。

本轮最终在锁文件 `npm ci --include=dev` 后，普通环境与安装器 `buildEnvironment()` 的隔离 HOME/USERPROFILE/PI_CODING_AGENT_DIR/TEMP 环境分别执行完整 `npm test`，结果相同：**2,995 项：2,939 通过、0 失败、56 跳过、0 取消**。`tsc --noEmit` 与全仓 ESLint 通过（0 错误；仍只有两处既有 keyboard 生成 fixture unused-import 告警）。未新增 Windows 跳过；新增 rename 的 Windows 专属成功重试用例只在非 Windows 标注不适用。

完整日志保留在原失败安装目录的 `test-repair-validation/npm-test-final-io.log` 和 `isolated-final-io/npm-test.log`，原失败日志未改写。静态独立复核无新增阻断；既有 rename 与 unlink 同时失败时清理错误可能覆盖原错误的诊断边界仍存在。

这不是浏览器/真实 provider 质量、Windows ACL、断电或 NFS 验收。安装器仍需对提交后 HEAD 独立运行隔离全量测试、生产构建、tarball 与实际进程验证；这两轮测试结果不能替代 F14 的安装/重启结果。

## 维护与整合

修改 fixture 必须保留原断言语义；MCP shutdown 或进程生命周期 API 改变时重新核对 cleanup helper。修改 installer temp 必须同步 F14、skill 与恢复指南，并验证运行时环境未被 build-only 环境污染。新源码文件继承 LF 策略；不得绕过 Git 属性让 source-contract 测试重新依赖操作者的 autocrlf 设置。
