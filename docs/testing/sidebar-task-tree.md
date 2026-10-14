# F38 侧栏任务树与检索验收记录

实现契约：[sidebar-task-tree.md](../branch-features/sidebar-task-tree.md)。固定起点 `4e7e720`；用户确认 HTTP 与浏览器两个测试入口，未新增私有函数测试 seam。

## Red → Green

- HTTP 目录：缺少新 route 时 red；实现 decoder-only 只读 allowlist 后 4/4。
- HTTP 正文范围：原 search route 对 taskId 的 7 条行为全部 red；完整 membership/祖先/归档交集、截断前过滤后 7/7。
- 浏览器：Settings 缺少 Task 开关时 red；开关、折叠 Task、每Task五族、空任务/未关联筛选后 green。
- 独立双轴审查的四个组合问题均补浏览器回归并修复：
  - 复制继承只刷新 session 而未刷新 owner → refreshKey 同步读取目录；`/clone` 只由 fixture 模拟成功与继承，不运行 Agent/SDK。
  - tree-off 先剪不匹配祖先，丢掉多级 child 的运行/选择与上下文标记 → 完整 family 投影与 matching-member flags 共用。
  - 旧筛选行看似可见，清筛选后第六根消失 → 按目标条件的 reveal 保守展开更多。
  - 未关联筛选未展开其项目 → 从完整匹配族展开包含的项目。
- 最后复核发现折叠项目误报任务为空 → 按折叠前匹配族计数，新增 red/green 断言。两轴定向复核无剩余 findings（静态复核，不代表两位 reviewer 独立重跑）。

## 最终执行结果

- `node_modules/.bin/tsc --noEmit`、`npm run lint`、`git diff --check`：通过。
- HTTP 11 条 + 现有侧栏/搜索/归档/任务视图定向回归：79 条通过。
- `E2E_BASE_URL=http://127.0.0.1:30142 node e2e/sidebar-task-tree.mjs`：真实应用 Chromium + 全 API 隔离 fixture 通过；覆盖设置默认/持久/跨标签、current/all、Task五族、清筛选、空任务说明/资料检索、正文 taskId 请求变化、读错保留/重试、树关闭兼容、Task与Session归档独立、同名跨项目、子代理/多级跨Task族、copy刷新、折叠空态、键盘/Alt+Left、390px en/zh-CN/zh-TW。
- `e2e/sidebar-view.mjs`、`e2e/session-keyboard.mjs`：原项目预览、目录选择与80根虚拟键盘回归通过；新目录请求已加空 fixture。
- 最终全量：**3081 条，3072 通过，0 失败，9 跳过**。

开发服务复用进程 cwd 为当前源码的 `30142`；`30141` 为已安装版本，不作为本次源码验收。没有启动第二个 dev 或重启已安装服务，没有生产 build、安装、发布或真实 provider 调用。

## 全量测试环境校准

初次原环境全量为 3043 通过、29 失败、9 跳过。一条是旧源码形状断言，本轮维护；其余 **28 条在固定基点副本全部复现**。

- 25 条 MCP/子进程测试继承 `NODE_OPTIONS=--require=./bin/stdio-guard.js …`。子进程 cwd 是临时目录，无法解析这个相对 preload。仅在测试命令中移除此项后恢复；不改仓库 stdio/MCP 实现。
- 3 条会话复制故障注入比较 lexical `/tmp` 和 realpath `/private/tmp` 前缀，注入未命中。仅设置 canonical TMPDIR 后原 copy 文件 16/16。
- 两轮校准后的全量均 3072/0/9；最终轮在最后空态修复之后执行。校准只影响子命令环境，不持久修改用户环境。

```bash
canonical_tmp=$(node -e "process.stdout.write(require('fs').realpathSync(require('os').tmpdir()))")
NODE_OPTIONS='--max-old-space-size=8192 --enable-source-maps' TMPDIR="$canonical_tmp" npm test
```

本地临时证据：`/tmp/pi-web-task-tree-full-final.log`（exit 0）、`/tmp/pi-web-task-tree-targeted.log`、`/tmp/pi-web-baseline-4e7e720-cBriFC/REPORT.md`。浅/深色390px截图保存在浏览器脚本输出的 `pi-web-sidebar-task-tree-*` 临时目录；已检查 en-light/zh-CN-dark，截图等待移动抽屉动画完成，不把过渡帧误判为布局裁切。以上临时路径不是永久工件保证。

## 未验证

Safari/iOS16.2、Windows 真机/文件系统、生产打包及全局安装、真实 provider 和外部集成费用未验。9 条跳过不计入通过。Task目录与session目录分别读取，事件/focus校准不是跨文件事务快照；目录不分页。浏览器 API fixture 与 HTTP 临时 handler 测试不替代生产环境全链验收。
