# 本地源码 → 默认全局 npm 安装契约

关联契约：[Windows 无窗口启动链](windows-silent-start.md)。安装器外层隐藏启动与 CLI 内部 Next/browser 子进程隐藏共同构成受控启动路径；`--no-open` 只控制浏览器打开，不代替控制台隐藏配置。修改启动链时同时验收日志、进程归属和退出行为。

> 维护基线：`63c6e4e`，对应上游 `96966e5`。本页提供复验契约，不代表已完成真实安装或服务切换验收。

## 目的、权威工作流与非目标

当任务涉及本地个人版本打包、替换全局 Pi Web、服务重启、安装失败恢复，或 rebase 冲突触及安装脚本时读本文。

**真正执行安装前，必须完整阅读现有 [pi-web-local-global-install skill](../../.pi/skills/pi-web-local-global-install/SKILL.md)。它是安全执行工作流的唯一入口。** 恢复、OOM、锁或清理问题还需阅读其 [troubleshooting](../../.pi/skills/pi-web-local-global-install/references/troubleshooting.md)。本文补充可检查的不变量、覆盖边界和上游整合要求，不替代 skill，也不提供另一套手写 cutover 命令。

目标是把一个明确的已提交版本，在活动 checkout 外构建为经验证的 npm tarball，安装到**默认全局 npm prefix**，可在授权时切换服务并核验身份。非目标：发布 npm、自动升级所有电脑、修改系统级环境、随意杀进程、自动修复任何崩溃、完整依赖快照备份、多平台部署。实现目前仅 Windows。

个人分支版本约定使用上游基号加 `-personal.N`，例如本基线 [package.json](../../package.json) 为 `0.9.3-personal.6`，上游为 `0.9.3`。调整个人版本须获明确授权，更新 package.json 及 [package-lock.json](../../package-lock.json) 的顶层 version、packages[""] version，并在安装前提交预期改动；安装脚本只校验三者一致，不强制解析这个个人后缀，也不会替你 bump/commit/tag。

**本工作流不执行 `npm publish`，也不使用 `npm run release`。** 仓库现有 release 脚本包含 publish，它属于另一条发布路径，不适用于个人本地全局安装。

## 入口、默认值与源码导航

| 文件/符号 | 职责 |
| --- | --- |
| [install-global.mjs](../../.pi/skills/pi-web-local-global-install/scripts/install-global.mjs) `main` / `HELP` | run、status、resume；worker 为分离运行器内部入口，不是手工替代 run 的捷径。 |
| [policy.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/policy.mjs) `parseArgs` | 默认 source HEAD、restart=false、defer=0、port=30141、heap=4096 MiB、执行测试；参数按子命令白名单验证。 |
| 同文件 `buildEnvironment` / `sameProcess` / `inspectPack` / `cutoverTransaction` | 环境隔离、身份/包检查、租约与事务顺序。 |
| [workflow.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/workflow.mjs) `inspectSource` / `createPlan` / `prepare` / `backup` / `apply` / `schedule` / `execute` | 源码取样、外部目录、构建打包、备份、延迟切换、恢复与状态持久化。 |
| [host.mjs](../../.pi/skills/pi-web-local-global-install/scripts/lib/host.mjs) `WindowsHost` | Windows 进程发现、默认 prefix、空闲等待、启动、原生校验和安全停止新进程树。 |

入口接受 `--commit REF` 选择已提交对象；heap 范围 1024–16384 MiB，port 1–65535；正数 defer 至多 3600 秒且需 restart。`resume` 只接受原 runDir、重启授权与延迟，不能带新的源码/测试/heap/port 选项，尤其不支持 `resume --dry-run`。完整执行命令以 skill 为准。

## 必须保持的具体不变量

1. **安装只使用确定的已提交源码。** `inspectSource` 解析 commit 对象并从 git show 读取版本，实际 run 拒绝 tracked dirty；dry-run 仅报告。untracked 文件被报告但不打包进工作树，不能将未跟踪的新功能误认为会被安装。脚本不自动提交，也不替用户挑选应提交的文件。
2. **安装授权与停服授权分开。** 默认不停止或启动服务，目标端口已有可识别全局 Pi Web 时必须明确 `--restart`。restart 在无服务时也会启动。识别到当前会话托管于待替换服务时拒绝前台 cutover；按 skill 使用 `--restart --defer 90`。祖先进程检测不覆盖全部托管方式，关系不确定时也采用延迟路径，先结束答复再切换。
3. **平台与进程身份失败关闭。** `WindowsHost` 要求 Windows、Node 随附 npm、Windows tar.exe，另需 Git、PowerShell 和相应进程查询能力。只识别默认全局包路径下的 Next start 子进程及 pi-web launcher，保留原 host/port。未知端口占用、多个 owner、PID/创建时间/父进程/命令改变都拒绝停止，不能按进程名或端口盲杀。
4. **构建与活动 checkout 隔离。** `createPlan` 在仓库兄弟目录 `.pi-web-installs/<repo-key>/<unique-run>/` 建立运行目录；`prepare` 创建唯一 detached worktree 并独立 `npm ci --include=dev`。不复用未经验证的 node_modules Junction，不在活动 checkout 的 `.next` 构建，不因已有旧产物而跳过失败构建。
5. **build home 只用于验证/构建。** 同盘、worktree 外空 HOME/USERPROFILE 和 TEMP/TMP/TMPDIR 仅传给 typecheck/test/build，避免 Next/NFT 跨盘扩展用户目录发现。依赖安装保留真实 npm auth/cache；helper/install 命令剥离继承 NODE_OPTIONS/TURBOPACK，服务启动恢复原 runtime home/Node options。默认 heap 为 4096 MiB；OOM 先诊断，不能自动加内存重试或改用 dev 构建。
6. **验证失败在全局变更前停止。** 默认依次执行 `tsc --noEmit`（3 分钟）、全量 `npm test`（5 分钟）、production build。只有用户明确接受并记录原因时 `--skip-tests-reason` 才跳过 npm test；类型检查、构建、包校验和安装验证仍强制。构建成功且非空 BUILD_ID 才能 pack，失败不能拿旧 tarball 冒充新构建。
7. **包身份不只看版本。** `pack` 验证 npm dry-run/实际 pack 清单和 tarball 中 package name/version/BUILD_ID，记录 SHA-256；要求 bin、server/static、BUILD_ID，拒绝 `.env*`、`.next/dev`、`.next/cache`、log，允许正常 `.next/diagnostics`。这不是任意内容的秘密扫描器。相同版本可有不同 BUILD_ID/hash，不能仅凭文件名判断已安装哪次构建。
8. **默认 prefix 锁跨 checkout/TEMP。** 租约在 canonical 默认 prefix 的 `.pi-web-installer/`，短操作由 proper-lockfile guard 串行、完整临时 JSON rename 发布持久租约。guard 有有限等待及两分钟 stale 期限；显式 resume 只可恢复同一 run 且 owner 身份已死的租约。损坏租约拒绝自动修复，不通过删锁强行并发安装。
9. **分离 worker 自给依赖、交接可核验。** runner 复制到外部 runDir，并复制 proper-lockfile 依赖图；无 node_modules checkout 只在 runner 内引导固定 `proper-lockfile@4.1.2`，使用 ignore-scripts、不写源码 lockfile、不改全局脚本政策。worker 继承必要环境，持有租约并以 worker-ready.json 确认；控制器退出不能释放已移交的锁。交接超时先查身份/status/log，不能立即再建第二 run。
10. **先等待空闲，再复核身份，最后变更。** cutover 顺序为 preflight → idle → preflight → stop → install → verify → launch/health → success。延迟后仍最多等候运行中会话约十分钟；查不到有效 runningSessionIds 或超时就拒绝打断。支持继承 PI_WEB_PASSWORD 的固定 `pi` Basic Auth 查询。该检查并非冻结新请求的全局 admission lock；切换期间用户应停止新任务。
11. **真实安装核验后才能成功。** `verify` 检查安装 version 与 BUILD_ID、`npm ls -g`、CLI help、实际 node-pty spawn；若启动服务，还验证原 endpoint 的 `/api/home`、launcher/server 身份与真实 runtime home。没有 restart 时不以 HTTP 服务启动为必要条件。旧 `verified` 状态不证明今天仍运行同一 build，status 必须与当前 installation/listener 一起看。
12. **失败恢复不覆盖未知活动进程。** 旧包在切换前归档；安装/验证/启动失败后只在安全时回滚，先停止已核验的新启动进程树（包括未监听子进程）。未知 ownership、PID 重用、孤儿子进程或无旧 archive 的首次安装失败进入人工恢复边界。rollback 恢复的是应用包，不是每个传递依赖的逐字节快照；npm 范围依赖可能重新解析。
13. **状态、秘密与清理边界。** plan/status/log、archives/fallback、worker/service log 留在 runDir，plan 保存源码/身份/校验/跳测理由，不存 key 或环境 dump；原 runtime options 通过继承环境传递。进程命令和子进程日志仍需按敏感运行资料处理，不应承诺所有日志自动脱敏。verified 后仅清理经目录/commit/realpath/干净 tracked 内容验证的自有 worktree；异常 Junction 不递归删除。清理失败记日志，不回滚健康服务；archives/log 无自动保留期清理。

## 状态与恢复的判读

具体操作以 [troubleshooting](../../.pi/skills/pi-web-local-global-install/references/troubleshooting.md) 为准。以下用于验收时避免错误报告：

| 状态 | 应得出的结论 |
| --- | --- |
| prepared / building / built / packed / backing_up | 尚未全局切换；检查日志、原安装和锁再决定是否允许恢复。 |
| scheduled | 仅待执行，worker 可能仍等待延迟/空闲。必须报告 pending，不能报告「安装成功」。 |
| stopping / installing / starting / rolling_back | 可能已中断旧安装；禁止盲目 forward resume。 |
| verified | 当前 run 的指定 artifact 经验证；仍需核对 status 的 installedMatchesArtifact/currentService。 |
| rolled_back | 升级失败，恢复了旧包；不是请求版本安装成功。显式恢复前确认旧 build 仍匹配。 |
| failed | 可恢复的切换前错误语义；内存中已知 interruption 或状态写失败不得误标为安全 failed。 |
| recovery_required | 自动恢复不安全/未完成，保留证据，先人工确认进程与包身份。 |

## 自动化验收（仓库根目录，无全局变更）

前置：符合 [package.json](../../package.json) 的 Node、测试所需依赖可用。以下是精确命令，不是已运行记录：

```bash
node --experimental-strip-types --test lib/local-global-install.test.mjs
```

[local-global-install.test.mjs](../../lib/local-global-install.test.mjs) 使用临时目录、假 host/注入 adapter 和部分真实本地文件锁，覆盖参数授权、build/runtime 环境、清单拒绝、SHA、租约发布/损坏/恢复、worker 交接、进程身份、transaction 顺序、失败状态、runner bootstrap 和 startup-tree rollback。

边界必须在报告里保留：假 npm/bootstrap 不访问 registry；假 tar/BUILD_ID 不证明真实 Next 打包；假 Windows process adapter 不证明生产 CIM/服务权限；测试不执行全局 install、不重启服务，不证明当前脚本已完成真实 cutover。其它平台能跑部分 fixtures 不等于安装器支持其它平台。

修改脚本后先完成该测试，再在另行授权的 Windows 环境做以下只读探测；它不是单测，可能调用本地 Git/npm/PowerShell 查询：

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs --help
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --dry-run
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs status --run-dir "ABSOLUTE_RUN_DIRECTORY"
```

最后一条需替换为已存在 runDir；没有历史运行时不要求 status 成功。仅在用户授权相应操作且满足环境前置条件时执行；文档验收不自动授权安装或外部请求。

## Windows 全量测试的可移植性约束

安装前仍执行完整 `npm test`，不能用平台差异为由自动跳过。测试夹具与时钟必须和被验证的行为分离：

- `directory-browser.test.mjs` 在 Windows 使用目录 junction、POSIX 使用目录 symlink，避免创建链接本身要求管理员权限；`subagent-input.test.mjs` 同样用 junction 指向 cwd 外目录中的真实文件，保留实际链接逃逸拒绝断言，不能改成 mock realpath 或省略安全用例。
- `project-command-env.test.mjs` 模拟 Linux 的期望 PATH 使用 `:`，不能误用 Windows 宿主的 `path.delimiter`；原生平台执行用例仍按宿主分隔符检查。
- `terminal-manager.test.mjs` 的真实 ConPTY 启动是异步的：等待输出后再断言有效 PID，清理时等待退出，均有明确 deadline。租约边界测试使用隔离的 mock PTY + 假时钟，防止将 node-pty 自身启动/销毁计时器一起快进；在租约前一毫秒仍存活，到期仅 kill 一次。真实原生模块检查仍保留，不新增 skip。
- `enabled-models-runtime.test.mjs` 比较设置文件身份时展开显示路径的 `~`，以兼容 Windows 临时目录在 HOME 内与安装器的隔离临时目录；独立的主目录缩写展示断言仍保留。
- 输入框增加灰字镜像 wrapper 后，`MobilePwaLayout.test.mjs` 同时检查外层 flex item 的 `minWidth: 0` 与 textarea 的全宽约束，不能继续要求两项位于旧的单一 style 对象。

本轮修复仅修改测试与文档，未放宽业务授权或修改终端实现。普通 Windows 工作区全量 **1497 项：1492 通过、0 失败、5 个已有跳过**；原先失败的 6 项所在定向集 **28/28 通过、0 跳过**。安装器仍需对提交后的独立 worktree 重新执行完整验证，不能用此记录代替真实 build/cutover。

## 手工验收与负例

1. **只读预检。** 前置 Windows 工具链齐全、目标服务与 checkout 可辨认。记录 git HEAD、tracked/untracked、默认 prefix、原 version/BUILD_ID、监听端口/host/进程身份。执行 dry-run，预期只报告、不创建安装计划或改包；tracked dirty 被报告而非静默忽略。未知 listener 必须拒绝识别，不能为「通过预检」停止它。
2. **参数负例。** 在不触发变更的独立终端检查 `resume --dry-run`、`run --defer 90`（无 restart）、非法 port/heap、空跳测理由均在参数阶段拒绝。真实 dirty/run、活跃服务无 restart、自托管前台拒绝已由 fixtures 覆盖；若人工重验，应在可丢弃环境中且先确认不会跨过 guard，不把生产安装当负例场。
3. **准备真正切换。** 仅在用户另外授权安装、所需依赖下载及是否 restart 后按 skill 操作。确认意图代码已提交（untracked 新文件不算），个人 version 三处一致；备份旧标识，停止提交新任务。自托管或关系不明确使用 skill 的延迟路径。预期外部 worktree 有独立依赖、build home 与 build 同盘但不在其内，活动 checkout 的 `.next` 不变。
4. **验证切换。** 若返回 scheduled，先交付 pending 与 runDir，断线重连后检查 status。预期只有所有检查通过才 verified，installedMatchesArtifact=true、version/BUILD_ID 与 artifact 一致；restart 时 endpoint/hostname、runtime home 与服务进程身份正确，模型凭证来自真实环境而非 build-home。不得仅运行 `pi-web --version` 就宣布成功。
5. **失败演练仅在可丢弃环境。** 构建失败预期无全局包变更；idle 查询失败/仍有会话预期不停止；并发安装预期被 prefix lease 拦住。接受后的安装/启动失败若安全可回滚，预期 rolled_back 与旧 build 匹配；未知新进程归属、首次安装无 fallback 或恢复失败预期 recovery_required，而非强制覆盖。生产环境不主动制造这些失败，用现有 fixture 作为低风险验收。
6. **恢复与收尾。** 确认 owner 已死、阶段在允许范围、安装仍匹配原 plan 后才按 troubleshooting resume。中断阶段先人工诊断；不可用 `npm --force`、删未知锁/目录或改变 npm allow-scripts 来推进。检查 verified 的自有 worktree 被安全清理，归档和日志仍留存；若清理延后，记录原因，不删除 Junction 目标。

## Rebase / 上游整合清单

- [ ] 将个人版本后缀与上游正式版本更新分开处理，三处版本保持一致；不把冲突解决成调用 release/publish。
- [ ] 上游改变 `files`、production build、Next 启动布局、bin/postinstall 或 node-pty 依赖时，同时检查 `inspectPack`、tarball 验证、`WindowsHost.service` 和 native 校验。不要为兼容新布局简单删掉身份检查。
- [ ] 上游改变 running/home API、认证用户名或 hostname 参数时，核对 idle/health 契约；失败须保持不停止未知服务。
- [ ] 检查 source/runtime/build 三套目录和环境仍分离，runner 不从将被替换的全局包加载锁依赖。
- [ ] 合并新的恢复逻辑时保留 interrupted 的内存标记、状态写失败保护、startup-tree ownership 与 unsafe resume 拒绝测试。
- [ ] 如果上游提供正式本地安装器，先对照授权、默认 prefix、延迟交接、验证/回滚语义，再决定迁移；不并存两套未经协调的锁和 cutover。
- [ ] 代码改动后同步 skill 与 troubleshooting（由获得相应编辑权限的维护任务完成），本文只维护功能契约；报告 fixture、dry-run、真实安装三层证据，不互相替代。

## 限制与维护完成标准

只支持默认 npm prefix 的 Windows 安装，依赖该宿主识别的全局 launcher 布局；自定义 prefix、其他进程管理器或未知端口拥有者不在自动接管范围。脚本执行真实 run 时可能联网安装依赖，这不是离线发布器。延迟与 idle 轮询不是无条件零中断保证，rollback 也不是完整系统快照。

修改安装器时必须重新读 canonical skill 和恢复指南，更新此页基线与受影响不变量，并记录失败/跳过/未做的现场验证。完成条件包括明确源码 commit、version、BUILD_ID、prefix、endpoint 与验证缺口；若只生成文档或跑 fixtures，应明确没有实际安装，不以历史 verified 或 scheduled 作成功凭据。
