# 本地源码 → 默认全局 npm：Windows / macOS 直接覆盖

关联[Windows 无窗口启动链](windows-silent-start.md)。原始功能基线 `63c6e4e` / 上游 `96966e5`；本页同步后续 macOS 支持与用户明确要求的无备份覆盖策略，不以历史部署记录代表当前脚本已完成真实切换验收。

## 目的、范围与唯一入口

把已提交的本地 Pi Web 构建成核验过的 tarball，安装到默认全局 npm prefix，可在授权后重启服务。支持 Windows 和 macOS；不发布 npm、不自动改版本/提交/打 tag、不在当前 dev checkout 构建。

Canonical skill：[SKILL.md](../../.pi/skills/pi-web-local-global-install/SKILL.md)。入口：[install-global.mjs](../../.pi/skills/pi-web-local-global-install/scripts/install-global.mjs)。禁止另写临时 cutover 脚本绕过流程；现场手动例外需要额外授权。

**当前策略只有直接覆盖：不打包旧版，不创建 fallback 目录，不自动回滚。** 旧版 version/BUILD_ID/进程身份只是防止误覆盖的元数据，不是备份。历史已存在的备份不主动删除。覆盖失败可能让服务不可用，须明确报告并按恢复指南手动处理。

## 授权、源码与命令

- 默认 committed HEAD，`--commit REF` 选择已提交版本；tracked dirty 阻止真实安装，untracked 只报告且排除。dry-run 可检查 dirty checkout。平台扩展不等于允许自动提交或工作区快照。
- 安装不自动授权停止服务。已有全局实例时需要 `--restart`；未运行时该选项会在安装后启动。
- 普通重启先等 idle。self-hosted 或来源不确定时采用 `--restart --defer 90`。
- 用户明确要求“不等待/直接中断”时才用 `--restart --no-wait`：跳过 idle，由外部 worker 立即切换；可额外组合 `--defer N`。无等待不是跳过构建/核验。
- 没有任何流程会停止未知监听者、用 npm `--force` 绕过占用或改变 npm script policy。

```sh
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --dry-run
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --defer 90
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --no-wait
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs status --run-dir "RUN"
```

默认检查 `tsc --noEmit`、全量 `npm test`（五分钟上限）、production build。只有用户明确接受具体测试缺口时可用 `--skip-tests-reason`；类型检查、构建、包和安装验证不能省略。版本升级仍须单独授权，修改 package.json 与根 lock 两个 version 后先验证/提交。

## 平台适配

| 平台 | npm / 包目录 | 进程与工具 |
|---|---|---|
| Windows | Node bundled npm CLI；`<prefix>/node_modules/@agegr/pi-web` | PowerShell/CIM/NetTCP、Windows tar.exe、隐藏 detached launcher；保留原有无窗口契约 |
| macOS | PATH 中 npm 必须解析到 npm-cli.js；`<prefix>/lib/node_modules/@agegr/pi-web` | Node/Git/python3、系统 ps/lsof/BSD tar；KERN_PROCARGS2 读取真实 argv/env，支持路径空格和 CLI symlink |

macOS 只接受正确包 cwd 的 Next listener 和明确指向全局 Pi Web 的 CLI parent；不按进程名猜归属。正向识别后才读取原服务环境，保存在内存/子进程环境中，不写日志或 plan。Windows 保留调用者 runtime 环境。两平台均复核 PID、创建时间、父进程和 command。

## 构建、包与覆盖不变量

1. 唯一外部 Git worktree、独立 `npm ci --include=dev`，不共享未经验证的 node_modules Junction/symlink。
2. build-only HOME/USERPROFILE、PI_CODING_AGENT_DIR、TMP/TEMP/TMPDIR 位于 checkout 外部空目录；TEMP 必须避开真实用户 home，防止 SDK 在祖先扫描中把用户 `.agents/skills` 当作项目资源。macOS 使用 OS temp；Windows 默认用 `<runDir>/build-temp`，若 runDir 本身位于原 USERPROFILE 下则改用 `<SystemRoot>/Temp/pi-web-build/<run-name>`。检查前创建 HOME/TEMP；目录无写权限时在切换前失败，禁止回退到原 profile 临时目录。npm ci 保持真实 npm auth/cache，重启恢复真实 runtime 环境。默认 heap 4096 MB，不自动 OOM 重试。
3. 构建必须成功并有 BUILD_ID；npm pack manifest 与实际 archive 内版本、BUILD_ID、SHA-256 一致。拒绝 dev/cache、env、日志；允许正常 `.next/diagnostics`。
4. 默认 prefix 共享 durable lease；macOS 首次创建前也解析现有祖先，`/var` 与 `/private/var` 不生成两个锁。runner 本地 guard 解析真实路径，不错误使用全局安装中的依赖。
5. `--defer` / `--no-wait` 从复制的外部 runner 启动 worker；guard 依赖随 runner 独立复制，无依赖 checkout 只 bootstrap pinned proper-lockfile。handoff 需 worker-ready 回执。token/环境不进入 plan。
6. 覆盖前核验 prefix、旧包身份和服务身份；idle 后再核验一次。`--no-wait` 仅跳过 idle，不能跳过身份/授权检查。
7. npm install 只使用核验后的**新** tarball，一次正常覆盖；无旧包 archive 和失败重装。安装后核验 version、BUILD_ID、npm ls、CLI help、native node-pty、HTTP、进程及 runtime home。
8. 失败的新启动可在归属确定时清理；未知/reused/orphaned 进程拒绝清理，不覆盖其占用文件。macOS 有界 SIGTERM 后只对已授权、同创建时间/command 的精确 PID 强制结束；短暂 zombie 视为已退出。

## 状态、恢复与留存

运行目录在仓库 sibling `.pi-web-installs/<repo-key>/`，包含 plan/status/run.log、新 archive、worker/service 日志。`scheduled` 是待执行，**不是安装完成**；`--no-wait` 可能立即断开当前会话，重连后核对记录与实时安装/监听者。

- `building/built/packed/failed`：切换尚未开始，pre-cutover 失败可在原约束下明确 resume。
- `stopping/installing/starting/recovery_required`：中断风险已发生，拒绝盲目 resume；没有旧版备份可自动恢复。
- `verified`：核验通过；status 仍需比较当前实际 BUILD_ID/进程，不把旧 verified 当成当前健康证明。
- legacy rollback 状态仅兼容读取；当前流程不再进入自动 rollback。

错误写状态也不能把中断包装成 harmless failed。保留最后 durable interrupted phase 或 recovery_required。手动恢复使用核验的新 archive 或另行授权选择的 release，并先确认进程/端口归属；详见[恢复指南](../../.pi/skills/pi-web-local-global-install/references/troubleshooting.md)。成功后仅清理己方已确认的干净 worktree；不自动删除旧 run/备份。

## 实现地图

| 路径 | 职责 |
|---|---|
| [install-global.mjs](../../.pi/skills/pi-web-local-global-install/scripts/install-global.mjs) | CLI、平台选择、dry-run/status/resume/worker |
| [local-host.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/local-host.mjs) | 共用构建/安装/HTTP/CLI/native probe 与服务生命周期 |
| [host.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/host.mjs) | Windows npm 路径、CIM/listener/tree cleanup |
| [macos-host.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/macos-host.mjs)、[mac-process.py](../../.pi/skills/pi-web-local-global-install/scripts/lib/mac-process.py) | macOS prefix、argv/env、cwd/identity、端口及精确停止 |
| [workflow.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/workflow.mjs) | source/build/pack、lease/handoff、直接覆盖、失败状态、cleanup |
| [policy.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/policy.mjs) | 授权/参数、环境隔离、包/plan、transaction 与锁规则 |

## 验收与覆盖边界

```sh
node --experimental-strip-types --test lib/local-global-install.test.mjs lib/local-global-install.macos.test.mjs
node --test lib/pi-web-launch.test.mjs lib/pi-web-options.test.mjs lib/process-lifecycle.test.mjs
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --dry-run
```

安装器 38 项测试覆盖参数、直接覆盖无备份、失败不重装、无等待授权、运行环境、包核验、锁/guard/bootstrap/handoff、macOS 路径空格/CLI symlink、未知进程拒绝与状态写失败。macOS native probe 只创建、检查和停止己方临时 Node process，不触碰实际服务。真实 macOS dry-run 已核对当前 npm prefix、全局 BUILD_ID、server/launcher 和 self-hosted 身份；没有执行这次新脚本的实际覆盖。

此前现场授权的 macOS 手动安装成功不等于本次新安装器 live 验收。Windows native流程/无窗口 smoke、本次跨平台安装器的真实全局切换仍需另行授权测试。全量仓库测试的无关既有失败应单独报告，不绕过安装前检查。

## v0.10.0 Rebase 版本

本次主线整合将包与 lockfile 根版本统一为 `0.10.0-personal.6`，SDK 依赖保留上游 `1.0.0`，没有退回旧依赖。仅修改源码不等于已更新全局安装；本轮未执行安装、生产构建、发布或服务重启。

## Windows 全量测试可移植性

SDK 1.0 的 Windows 安装前检查曾出现批量失败和五分钟超时。TEMP 隔离修复由 `lib/local-global-install.test.mjs` 覆盖原 profile 内外两种 runDir，以及 macOS 的 OS-temp 保留；MCP fixture 清理、模块身份与换行规则见 [Windows 测试验证契约](windows-test-portability.md)。修复测试不等于完成全局安装或服务重启，仍须另跑安装器并核对实时状态。

## 维护与 Rebase

保留源码来源/显式重启和 no-wait 授权、隔离构建、完整包/进程验证、共享锁、独立 runner 和可观察错误。不要重新加入备份/自动回滚，也不要把 no-wait 变成默认。改变平台工具、参数、恢复状态或 runtime 环境时同步 skill、恢复指南、本页、测试和[功能索引](README.md)；Windows启动层变更还须核对无窗口契约。
