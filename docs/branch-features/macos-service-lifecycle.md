# macOS 服务重启：Terminal 委托与用户级 LaunchAgent

关联[本地全局安装](local-global-install.md)、[Windows 启动链](windows-silent-start.md)。仅处理默认全局 npm 实例；不管理 dev server、不使用 sudo、不修改系统权限或 TCC 授权。

## 背景与边界

历史运行曾出现自动 detached 重启后 HTTP 可用、但用户查询与 DNS 同时失败的情况。Terminal 手动启动后的对照正常。这支持检查 macOS 启动上下文，但不证明 detached 本身必然破坏 Mach bootstrap/TCC。本实现消除从旧服务直接 detached 拉起新服务的默认路径，并补充能力诊断；真实 Terminal、Automation、launchd 和 TCC 行为仍需单独验收。

源码修改本身不授权部署、真实重启、注册登录项或迁移权限。Windows 原有 detached/无窗口行为保持不变。

## 入口与授权

```sh
# 只读；不创建运行目录、不打开 Terminal、不注册 job
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs restart --dry-run

# 普通重启：不构建、不 npm install 全局包；自托管时留时间结束当前响应
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs restart --defer 90

# 明确选择 Terminal（也用于从已有 LaunchAgent 迁回 Terminal）
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs restart --macos-launch terminal --defer 90

# 首次启用 LaunchAgent：显式授权持久注册与登录时启动
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs restart --macos-launch launchagent --macos-env-file /absolute/private-env.json --defer 90

# 构建安装 + 重启也支持同样两个 macOS 参数
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --defer 90
```

- `restart` 本身授权重启，但不授权跳过 active-session idle 检查；`--no-wait` 仍须用户明确接受中断。它不接受 commit/build/skip-tests 参数，dirty checkout 不影响已安装包；复制 runner 和准备锁依赖不是安装全局 Pi Web。
- 未注册过 LaunchAgent 时默认 `terminal`；已有受识别注册时默认保留 `launchagent`。不能默默创建登录项。
- `--macos-launch` 仅允许 `terminal|launchagent`；`--macos-env-file` 只用于显式 launchagent，必须绝对路径。Windows 拒绝这些参数。
- 旧版 macOS restart plan 不可直接 resume 到新的启动语义，需重新生成计划。安装的 committed-source、测试、无备份覆盖规则不变。

## Terminal 交接协议

所有 macOS 维护事务（包括 LaunchAgent 的安装/重启）先通过 `/usr/bin/osascript` 委托一个新的 Terminal 命令，再执行停服。**LaunchAgent 服务本身不依赖这个 Terminal worker 存活，但当前维护入口仍需要 Terminal/Automation；不是无交互远程管理器。**

1. controller 在 OS temp 中创建 0700 私有目录和 0600 Unix socket。
2. AppleScript 通过 argv 接收 shell-quoted 命令；命令只含绝对 Node/runner 路径、socket 路径、工作目录。无环境转储、凭证文件或把密钥放进命令行。worker 启动移除 NODE_OPTIONS/TURBOPACK 的控制器注入，运行服务时保留原 runtime 配置。
3. worker 报 PID；controller 核对真实进程、argv 中的 runner/socket 和 cwd，再通过 socket 发送内存中的原服务环境。worker 确认接收后才交接 prefix lease。
4. worker 必须确认计划与 lease 属于自己，检查 GUI domain，然后按照 defer/idle/身份复核规则停服。超时、Automation 拒绝、身份不符、未知 job 都阻止切换，不降级回 detached/nohup/sudo。
5. socket/私有目录在交接或失败后关闭删除。没有确认 lease 的迟到 worker 不得执行事务。
6. Terminal 模式的 CLI 是 worker 的 attached 子进程，不 detached、不 unref；窗口需保持开启。服务日志在 runDir/service.log；worker/错误可在 Terminal 查看，run.log/status 保留。

## LaunchAgent 持久配置

- 服务注册在 `gui/<uid>`，限制 `Aqua`，拒绝 root；不是系统 LaunchDaemon。
- label 从规范化 prefix+port 派生：`com.pi-web.service.<hash>`。
- plist 位于 `~/Library/LaunchAgents/<label>.plist`；固定 runner、config 与日志位于 `~/Library/Application Support/Pi Web/<label>/`。路径和 argv 经过 XML escaping，不使用 shell 启动服务。
- plist `RunAtLoad=true`、`KeepAlive=false`。登录时启动；崩溃/诊断失败不无限自动重启。重启事务使用 **bootout → 等待端口释放 → bootstrap**，安装期间不会被保活抢跑。
- 仅接受自有配置、完整匹配的 plist 和已确认的运行 job。未知 label、修改过的 plist、检查失败不得覆盖或 bootout。
- 服务运行环境由用户明确指定的 JSON 文件提供。只读 owner-owned、0600 regular file，拒绝符号链接、非字符串值、无 HOME/PATH、HOME 改变。不会自动导出当前环境。
- 首次迁移时，原有 PI_WEB_PASSWORD、PI_CODING_AGENT_DIR、TAPSVC_API_KEY 不得被静默丢弃或改变。其他 provider/proxy/SSH/扩展需要的变量由用户明确配置，不能假设继承交互式 shell。
- Node/CLI/config/env-file 使用绝对路径。LaunchAgent wrapper 自身清理启动 NODE_OPTIONS/TURBOPACK；用户文件里的 runtime 值只用于 CLI。
- env-file 路径进入 config/plan，**内容不进入 plist、计划或错误信息**；秘密本身仍由用户选择持久化到其私有文件，备份策略由用户负责。
- 从 launchagent 显式迁回 terminal 时，先确认并 bootout 自有 job，再移除自有 plist/config；保留日志和用户 env-file，不删除用户秘密。

环境文件示意（通过本机编辑器准备，不在聊天里粘贴真实凭证）：

```json
{
  "HOME": "/Users/you",
  "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}
```

文件需设为 0600。已有密码、自定义 agent-dir、provider 环境变量、代理需明确补齐；不要复制 build-home、完整 process.env 或易失效的 Terminal 专属 SSH_AUTH_SOCK。环境文件不会被运行时自动更新。Node 安装路径变化需要重新核验注册。

## 服务内诊断与状态

新增 `GET /api/service/health`，沿用现有 Web 认证。返回有限布尔检查，不返回用户名称、凭证、IP、实际路径或文件内容；不接受客户端指定探测地址/文件。

- `user`：服务自身 `os.userInfo()`。
- `dns`：系统 `dns.lookup()`，默认 github.com；可用 host runtime 的 PI_WEB_HEALTH_DNS_HOST 指定适合所在网络的域名。
- `childUser/childDns`：服务实际启动的独立 Node 子进程中的相同能力，有超时。这不是完整的 SDK bash/扩展工具链验收。
- `paths`：只读 HOME，并可通过 host runtime 的 PI_WEB_HEALTH_PATHS（JSON 字符串数组，合计最多 8 路径）加入实际需要的目录/文件。不是任意 project allow-list 或全部 TCC 能力的证明。
- 路径只读打开/读取最小内容，不修改权限。诊断最多等待有界时间，并以五秒 cache 合并请求。DNS-only 失败是 degraded，用户/子进程/路径失败是 unhealthy；不自动重启。

macOS 安装器在原 HTTP/HOME/identity 检查后运行诊断，健康时跨过五秒缓存再检查一次；最后复核监听者身份。检查缺失（旧包 404）、失败或网络退化时，事务写 `degraded`，保留服务供诊断，不标 `verified`、不循环重启、不自动恢复旧包。`status` 同时报告当下的 runtime health，不拿历史记录冒充当前状态。degraded 不可 resume，需诊断后发起新 restart。

## 实现地图

- [install-global.mjs](../../.pi/skills/pi-web-local-global-install/scripts/install-global.mjs)、[policy.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/policy.mjs)：命令与参数/plan。
- [mac-terminal.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/mac-terminal.mjs)、[terminal-worker.mjs](../../.pi/skills/pi-web-local-global-install/scripts/terminal-worker.mjs)：私有交接、Terminal worker。
- [mac-launchagent.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/mac-launchagent.mjs)、[agent-entry.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/agent-entry.mjs)：注册身份、plist、私有环境文件、服务 wrapper。
- [macos-host.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/macos-host.mjs)、[workflow.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/workflow.mjs)：事务接线、停止/启动与 degraded。
- [service-health.ts](../../lib/service-health.ts)、[health route](../../app/api/service/health/route.ts)：运行诊断。

## 验收与限制

```sh
node --experimental-strip-types --test lib/macos-service.test.mjs lib/service-health.test.mjs lib/local-global-install.test.mjs lib/local-global-install.macos.test.mjs
node --test lib/pi-web-launch.test.mjs lib/pi-web-options.test.mjs lib/process-lifecycle.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```

自动测试覆盖私有 IPC 的真实子进程交接（替代 Terminal、不打开窗口）、参数与注入转义、lease 交接、拒绝未授权直接启动、attached process group、假 launchctl 的注册/卸载和未知身份拒绝、私有环境文件与错误脱敏、restart 无构建覆盖、诊断 failure/degraded。原生测试只操作己方临时进程和文件，不注册真实 job、不停实际服务。

另行获得部署/重启授权后，必须人工验收：
1. Terminal Automation 允许和拒绝两条路径，拒绝时旧服务仍可用。
2. Terminal 新服务内 user/DNS/真实 Agent bash、SSH 和所需目录正常；正常 Ctrl+C/关闭窗口的行为明确。
3. LaunchAgent GUI 注册、plist/运行 job 身份、维护 worker 退出后健康、注销/重新登录后健康。
4. TCC 受保护目录与自动化按最终运行身份测试。LaunchAgent **不继承 Terminal 的授权**；本实现不自动授予 Full Disk Access，不承诺所有 Terminal 权限等价。
5. 无外网时记录 degraded、不无限重启；旧包缺诊断接口也不假报 verified。
6. 从 LaunchAgent 迁回 Terminal、自有/未知 job 冲突、失败后的人工恢复。

### 已完成的真实启动验收

在明确授权下，已使用同一份既有全局包完成 Terminal restart-only，以及从 Terminal 向用户 GUI LaunchAgent 的迁移；没有生产构建或全局包替换。

- Terminal 路径确认新监听者的父链经过 Terminal/独立 worker，实际工具运行在新服务之下；用户查询、系统 DNS、HOME/会话目录/仓库读取、HTTP 与 GitHub SSH 认证正常。
- LaunchAgent 路径确认自有注册、服务 wrapper 的父进程为 launchd，CLI/Next 属于该 job；维护 worker 退出后，服务仍运行。新服务中的上述能力检查正常，环境文件为 0600。没有自动写入 API key/密码，也没有持久化临时 SSH socket。
- 一次 Terminal 委托失败发生在停服前；已确认旧服务、注册与 lease 均未被切换。随后无害 Automation 探针成功，再通过相同计划的 pre-cutover resume 完成交接；不把其原因归定为 TCC，也没有降级到 detached。
- 既有全局包没有新增诊断接口，故自动记录保持 `degraded/unavailable`；实际工具补验不改写该记录为 verified。

尚未实测注销/重新登录或系统重启恢复、全部 TCC 受保护目录/桌面自动化、LaunchAgent 迁回 Terminal，以及全局包覆盖更新。真实启动验收不等于这些场景或根因机制已全部证实。

## 维护与 rebase

保留默认 Terminal/显式持久注册、秘密只在私有 IPC 或用户选择的环境文件、双向交接、进程/注册归属、prefix lease、bootout-before-install、degraded 不假成功等契约。不要重新将 macOS 合并进共用 detached launch，不要影响 Windows 隐藏启动。新增健康检查不能暴露 host env 或变成客户端可控的文件/网络探测接口。同步本页、安装 skill/恢复说明、安装文档、功能索引和相关测试。
