# 开发环境遗留 Service Worker 与缓存清理

> 功能基线：`63c6e4e`。这是本分支随其他功能带入的开发环境保护，不能因提交标题未单列它而在 rebase 时遗漏。

## 目的与范围

同源地址曾运行生产版本后，遗留 Service Worker 及静态缓存可能继续影响开发页面。开发模式在首屏初始化和组件挂载两处尝试注销旧 worker，首屏脚本还删除 `pi-web-` 前缀缓存，以减少旧资源干扰。

这不是一般性的“清空所有浏览器数据”，不清除会话、localStorage、草稿或模型设置；也不代替上游 PWA 的生产注册和 fetch 超时策略。与 [开发服务输出断管保护](dev-stdio-guard.md) 是两项独立能力：一项处理浏览器缓存，一项处理服务进程输出管道。

## 入口与行为要求

1. **环境隔离**：仅非 `production` 分支执行该清理；生产环境继续按原有路径注册 `/sw.js?v=<appVersion>`，scope 为 `/`，`updateViaCache: "none"`。
2. **首屏路径**：`THEME_INIT_SCRIPT` 完成主题恢复后，在非生产且支持 Service Worker 的环境调用 `getRegistrations()`，逐个 `unregister()`。必须保留该脚本原本的主题 palette、系统跟随和 dark class 逻辑。
3. **缓存范围**：同一首屏路径中，若存在 CacheStorage，只删除名称以 `pi-web-` 开头的缓存。其他应用缓存不得被扩大删除。
4. **挂载补充路径**：`PwaRegistration` effect 在非生产环境枚举并注销 registrations 后返回，不继续注册生产 worker。不支持 Service Worker 的浏览器直接返回。
5. **注销范围要明确**：当前实现注销 `getRegistrations()` 返回的当前 origin 下全部 registrations，并未按 Pi Web scope 再过滤；不能宣传成“只注销 Pi Web 的 worker”。共享同源部署时应评估这一副作用。
6. **异步边界**：清理调用是异步、未整体 await；注销不等于立刻解除当前页面 controller，也不保证当前已加载资源立即更新。必要时重新加载页面验证。
7. **失败边界**：首屏清理外围只捕获同步异常，`.then()` 的异步拒绝没有完整 catch；组件注销路径也没有统一失败回调。不能把当前实现写成“任何清理失败都完全静默无错误”。
8. **不增加启动副作用**：清理不请求模型、不触碰服务端文件、不重启服务，不把删除缓存扩展为删除用户偏好。

## 实现导航

- [PwaRegistration.tsx](../../components/PwaRegistration.tsx)：非生产注销与提前返回；生产注册/加载事件路径。
- [theme.ts](../../lib/theme.ts)：`THEME_INIT_SCRIPT`，首屏主题恢复和 worker/cache 清理。
- [layout.tsx](../../app/layout.tsx)：首屏脚本及注册组件的接入；调整布局时检查入口没有被丢弃。
- [PwaRegistration.test.mjs](../../components/PwaRegistration.test.mjs)：开发注销与生产 register 仍存在的源码契约。
- [theme.test.mjs](../../lib/theme.test.mjs)：初始主题及带清理环境的 VM 执行。

## 自动验收

```bash
node --experimental-strip-types --test components/PwaRegistration.test.mjs lib/theme.test.mjs
```

测试边界：PWA 测试主要是源码正则断言；主题测试验证主题恢复在模拟清理环境中不被破坏，但新增用例没有等待并断言每次异步 unregister/cache delete 结果。**这些测试不是“真实旧 worker 和缓存已清理”的浏览器证明。** 后续改清理范围、时机或错误处理时，应补充异步结果/生产分支的回归。

## 人工验收

前置：隔离浏览器 profile/测试 origin，不与其他应用共享重要 registrations。测试服务生命周期遵循根 AGENTS；不要在运行中的开发 checkout 执行 build。

1. 先在测试 origin 准备遗留 worker，以及 `pi-web-test-stale` 和 `other-app-test` 两个可丢弃缓存。
2. 用同一 origin 打开非生产 Pi Web，等待清理 Promise 完成，在 DevTools Application 中检查。**期望**：registrations 被注销，`pi-web-test-stale` 删除，`other-app-test` 保留；若页面仍被旧 controller 控制，重新加载后再检查。
3. 预先保存任一主题，重复加载。**期望**：主题及暗色 class 正确，没有因为清理改变 `pi-theme` 或其他偏好。
4. 在不支持 Service Worker 的模拟环境运行入口。**期望**：不访问缺失 API，正常主题/UI 仍可使用。
5. 在独立的生产验证环境检查原有注册路径。**期望**：worker 正常注册更新，不执行开发清理。源码条件检查不能代替实际部署验证。
6. 模拟浏览器禁止存储/异步 API 拒绝并记录 console；当前实现的异步错误处理缺口须如实报告，不能为了验收通过而隐藏它。

## Rebase 保留清单

- `PwaRegistration` 冲突时保留上游生产 worker 的版本参数、加载时机和错误报告，同时保留开发注销后提前返回。
- `theme.ts` 的首屏脚本是一行字符串，文本合并容易整行覆盖；逐项检查主题恢复、环境条件、注销和 cache 前缀过滤。
- 上游增加主题或改 hydration 时，不能为保留清理而退回旧主题枚举；若将清理迁到专用模块，更新入口和时机验收。
- 如果上游提供等价清理，核对 origin/scope、缓存范围、异步失败行为，再替换本地实现，不要保留两套相互矛盾的流程。

修改开发/生产分界、清理范围、首屏脚本或 PWA 入口时，必须同步本文件、测试与 [README](README.md)。
