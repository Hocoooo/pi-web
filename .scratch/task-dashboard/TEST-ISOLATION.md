# 隔离 worktree 的测试临时目录约束

2026-10-09：恢复票据04时，worker为满足“只写指定工作区”把TMPDIR/HOME/证据置于Git worktree内部。已有非Git/依赖缺失测试因此继承祖先Git与node_modules，另有Unix socket路径过长；这不是可用测试环境。

## 已发生和已处理

- `lib/subagent-isolation.test.mjs` 的非Git fixture向上发现共同仓库，意外创建 `/Users/noname/GitProjects/pi-web-worktrees/agent` 和 `refs/heads/agent`。
- 父代理对照事前worktree清单，核实新worktree完全clean、HEAD与分支仍为85cc4f38、reflog仅有Created from HEAD且无进程cwd占用。
- 仅执行无force的worktree remove与带expected-old-hash的ref删除；无其他用户文件/分支变更。
- 证据 `/tmp/pi-web04-git-incident-vvqf8lyr/`；失败报告在04树 `.scratch/task-dashboard/ticket04-evidence/REPORT.md`。

## 后续硬性要求

- 源码唯一写入worktree；测试数据、HOME、agentDir、日志和TMPDIR明确允许写**Git树外**的新专用短路径临时目录，例如 `/tmp/pw04-XXXXXX`。
- 执行前以临时目录作为cwd检查 `git rev-parse --is-inside-work-tree` 必须失败，并确认没有祖先node_modules影响“依赖不存在”测试。
- 不把临时数据生成在源码树，避免eslint与测试相互删文件、长socket路径和误识别真实仓库。
- 临时Turbopack root workaround只在隔离dev运行时生效；全套/config测试前须还原next.config原字节。
- 浏览器缓存只读引用现有安装；不得通过使用真实HOME/API凭据弥补缺失环境。
- 全套失败与受影响browser必须重新验证；旧green或无exit中断日志不算成功。
- 隔离事故必须报告，不宣称本轮“没有共享Git写入”；本记录仅说明父代理已完成有证据的精确清理。
