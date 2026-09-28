# 开发服务输出管道断开保护

> 功能基线：`63c6e4e`。这是开发启动路径的运行稳定性修复，不是全局异常吞噬器。

## 目的

启动器关闭 stdout/stderr 管道时，仍存活的开发服务可能在写日志时遇到 `EPIPE`。如果 Next 的异常日志又写入同一条坏管道，可能出现反复异常。通过早于 Next 加载的 preload，为两个输出流处理且仅处理 `EPIPE`。

## 入口与行为要求

1. `npm run dev` 与 `npm run dev:lan` 均通过 Node 的 `--require ./bin/stdio-guard.js` 启动 Next 的 CLI，而不是直接调用 `next dev`。
2. preload 必须先于 Next 的 uncaughtException 日志处理加载；改变脚本顺序可能使保护失效。
3. 同时在 `process.stdout` 和 `process.stderr` 的 `error` 事件上注册 handler。
4. 仅忽略 `error.code === "EPIPE"`；其他流错误必须抛出，不能用空 catch 隐藏真实应用故障。
5. 正常 stdout/stderr 内容不重写、不丢弃、不重定向；管道断开不应仅因该错误而结束仍可服务的进程。
6. 不安装进程级“忽略所有 uncaughtException”策略，不改变 stdin、网络错误、文件错误处理。
7. 当前 `start`/`start:lan` 和生产全局 CLI 没有因这个定制而统一 preload；不要宣称所有运行路径已经受保护。
8. 保留原有 host/端口语义：dev 为 loopback，dev:lan 为 `0.0.0.0`，端口 30141；本修复不负责改变暴露范围。

## 实现导航

- [bin/stdio-guard.js](../../bin/stdio-guard.js)：`handleOutputError`，两个输出流监听。
- [package.json](../../package.json)：`dev` / `dev:lan` 启动命令。
- [lib/stdio-guard.test.mjs](../../lib/stdio-guard.test.mjs)：独立子进程正常输出、输出断开与非 EPIPE 错误。

## 自动验收

```bash
node --experimental-strip-types --test lib/stdio-guard.test.mjs
```

测试使用子进程和管道验证保护，不必启动 Next，也不依赖模型凭证。以实际测试文件为准确认 stdout/stderr 断开用例均执行；不要只看“服务启动成功”就判定通过。

## 人工验收

前置：隔离测试 checkout，没有正在使用同一个 `.next` 的 dev 服务。遵守根 [AGENTS.md](../../AGENTS.md) 的 dev-server 规则；不能为同一个 checkout 换端口绕过 lock。

1. 通过标准 dev 脚本启动，确认页面和 API 可正常访问、stdout/stderr 正常输出。
2. 若需要复现原启动器问题，在可控制的测试启动器中关闭输出管道但保留子进程，随后触发输出。**期望**：无 EPIPE 日志风暴，服务仍能响应。
3. 在测试子进程注入非 EPIPE 的流错误。**期望**：进程失败，不能被保护逻辑吞掉。不要在用户的真实开发服务中注入错误。
4. 清理本次测试进程。不要使用广泛的 `killall node` / 停止所有 Node 进程。

## Rebase 保留清单与局限

- `package.json` 经常因版本和依赖升级冲突；选择上游版本/依赖时也要保留两个 dev 脚本的 preload。
- 保留上游 Turbopack 开发方式，不为此改成 `next dev --webpack`。
- 若上游已提供等价保护，先比较加载时机与错误范围，再决定替换；不能只因文件短小删除。
- 测试证明的是输出流行为，不证明任意启动器、Next 版本或所有生产部署都不会崩溃。Windows 下命名管道/进程树等差异仍需具体场景验证。

改动脚本、异常处理范围或开发启动器时，必须同步本文件和对应测试，并更新 [README](README.md) 的入口信息。
