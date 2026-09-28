# Windows 无窗口启动链

> 本功能在 `61b3a61` 之后新增。初始实现补齐 CLI 的子进程隐藏配置，沿用已有安装器的后台启动机制；不新增 CLI 参数或改变服务管理方式。

## 目的与范围

当 Pi Web 从隐藏的后台启动器运行时，避免启动 Next 或打开浏览器所需的 `cmd.exe` 分配可见控制台，从而减少启动时短暂闪窗。隐藏的是控制台窗口，不是日志，也不是默认打开的浏览器页面。

适用入口是现有[本地全局安装器](local-global-install.md)的服务启动路径，以及具备相同隐藏/日志条件的外部启动器。直接从已经打开的终端运行 `pi-web` 仍然是正常前台命令；双击 `.cmd/.bat` 先创建的调用窗口不在 CLI 子进程的控制范围内。

## 入口与行为要求

1. **最外层**：安装器以 `detached: true`、`windowsHide: true`、stdin ignore、stdout/stderr 指向 `service.log` 的方式启动 Node CLI，保留当前用户的 runtime 环境。该配置已存在，本功能不替换安装器的进程归属检查、idle 等待和失败恢复。
2. **Next 子进程**：`bin/pi-web.js` 直接启动 Node + Next JS 入口并设置 `windowsHide: true`。不要增加 `.cmd`、`npm` 或 `shell: true` 中间层。
3. **Next 生命周期**：Next 仍然不是 detached 子进程，不调用 `unref()`；继续由 `wireChildProcessLifecycle` 转发退出信号、处理启动失败和退出码。不能为了隐藏窗口将其变成无人管理的服务。
4. **日志不丢失**：Next stdio 仍为 `["inherit", "pipe", "inherit"]`。stdout 继续转发到 CLI stdout，stderr 继续继承外层；安装器启动时因此进入文件日志，终端启动时仍在终端可见。
5. **浏览器 opener**：Windows `cmd.exe /c start "" <url>` 也设置 `windowsHide: true`，保留结构化 argv、ignore stdio、detached 和 unref。只抑制辅助控制台，不阻止浏览器窗口打开。
6. **完全后台的受控路径**：安装器传 `--no-open`，所以既没有自动浏览器，也明确要求隐藏所有受控的控制台子进程。普通 CLI 的浏览器默认值不变；用户可用 `--no-open` 或 `PI_WEB_NO_OPEN` 禁止浏览器打开。
7. **错误可观察**：浏览器 opener 错误保留 warning；Next 启动/运行失败保留原生命周期日志。无窗口不等于吞掉错误、丢弃日志或一直假报健康。
8. **跨平台**：Node 的 `windowsHide` 是 Windows 选项；macOS/Linux 继续使用 `open`/`xdg-open` 和原有启动逻辑。
9. **环境身份**：不切换到 SYSTEM 或非交互账户来达到隐藏效果，避免改变 home、认证、会话目录，以及桌面文件操作的可用性。

## 实现导航

- [pi-web.js](../../bin/pi-web.js)：Next spawn 和 Windows browser opener 的 `windowsHide`。
- [pi-web-options.js](../../bin/pi-web-options.js)：现有 `--no-open` / 环境变量语义。没有新增 `--silent` 或 `--background`。
- [process-lifecycle.js](../../bin/process-lifecycle.js)：Next 的归属、信号和错误处理。
- [安装器 host.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/host.mjs)：`launch` 的隐藏启动、runtime env 和 service.log。
- [安装器 workflow.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/workflow.mjs)：延迟 worker 的独立隐藏启动。

## 自动验收

从仓库根目录运行：

```bash
node --test lib/pi-web-launch.test.mjs lib/pi-web-options.test.mjs lib/process-lifecycle.test.mjs
node --experimental-strip-types --test lib/local-global-install.test.mjs
node e2e/windows-silent-start.mjs
```

- `pi-web-launch.test.mjs` 在 VM 中执行真实 CLI，替换 spawn，检查两处隐藏标志、结构化 argv、Next 不 detached、生命周期接线、stdout 转发、no-open、Ready 后只开一次浏览器、失败 warning 和跨平台 opener。不把源码字符串包含某字段当作唯一证据。
- `process-lifecycle` 测试继续覆盖退出码、信号转发与强制结束回退。
- Windows 原生 smoke 需要 `powershell.exe` 和可用的 .NET `Add-Type` 编译能力。在临时目录编译一个小型控制台探针，从隐藏 detached launcher 执行真实 CLI spawn 路径，仅把 Next / cmd.exe 替换为探针；检查 `GetConsoleWindow` / `IsWindowVisible`，验证探针运行时没有可见控制台和日志仍可转发。
- smoke 不启动真实 Next、不打开浏览器、不占用端口、不改变全局安装；临时目录在结束后清理。非 Windows 明确输出 SKIP。它是原生控制台行为检查，**不是对整个桌面每一帧的录像，也不是实际部署无闪窗的绝对证明**。

## 人工验收与发布

1. 先通过上述测试。保持实际端口上的服务不变，不为测试重启用户正在使用的实例。
2. 需要部署时，按安装器 skill 先提交目标源码，再在获准重启后执行隔离构建和延迟切换；本功能修改本身不授权再次安装、停止服务或跳过测试。
3. 观察实际启动全过程。**期望**：受控启动链没有可见控制台；安装器路径不打开浏览器，服务地址能访问，service.log 有启动/错误输出。
4. 检查进程身份、实际版本与 BUILD_ID，不能只凭“窗口没出现”判断服务已启动。
5. 使用已有终端启动测试实例。**期望**：调用终端仍保留、日志可见、Ctrl+C 生命周期不变；隐藏子进程不应隐藏用户自己的终端。
6. 需要验收自动打开浏览器时，在隔离实例保留 openBrowser 默认值。**期望**：浏览器打开一次，辅助 cmd 不额外闪窗，打开失败有 warning。

## 已知边界与降级

- 无法事后阻止双击 `.bat/.cmd` 或外部启动器本身创建的窗口；此类入口要实现完全无窗口，应从源头改用隐藏启动方式，而不是添加一个不存在的 `--silent` 参数。
- Windows Terminal、系统策略、浏览器/文件关联和外部启动器不全部受这两处配置控制。若实际环境仍短暂闪窗，应先确定窗口所属进程，再作针对性处理；不要为消除闪窗盲目停止所有 Node 或控制台进程。
- 用户已允许完全无窗口不可达时接受短暂闪窗。此降级不允许持续留下控制台、丢日志或破坏服务启动；也不应拿来跳过验证。
- 修改源码不会自动更新已安装的 npm 包。是否已部署需要单独报告，不能把源码测试通过写成当前全局服务已应用。

## Rebase 与维护要求

- 合并 CLI 的 upstream 启动/Node args/生命周期变更时保留两处隐藏配置，不覆盖掉新的退出处理。
- 保留正常 CLI 浏览器默认行为、`--no-open` 和三平台 opener；不要将“隐藏辅助窗口”改成所有用户默认不打开浏览器。
- 安装器、CLI、自动化 smoke 和本文件共同界定受控链路；改变任何一层时更新测试、本文与 [README](README.md) 的覆盖边界。
