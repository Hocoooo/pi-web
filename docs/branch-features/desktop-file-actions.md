# 桌面文件动作与 Windows Explorer 标签页契约

> 维护基线：`63c6e4e`，对应上游 `96966e5`。真实系统应用与 Explorer 效果必须在具备前置条件的桌面环境单独验收。

## 目的、范围与非目标

修改 Markdown 本地文件链接、桌面 API、Windows Explorer 自动化，或解决上游 PDF/文件链接冲突时读本文。功能是在聊天里的本地文件链接上提供右键「默认应用打开」和「在文件夹中显示」，同时保留应用内预览。Windows 的「复用」指**复用已有 Explorer 窗口并新建标签页**，不是重定向已有标签页，也不是查找/复用同目录标签页。

桌面动作发生在 **Pi Web 服务所在机器的用户桌面**，不是任意远程浏览器的桌面。因此它不服务 LAN/relay，也不是远程文件下载、任意命令执行器或跨平台通用文件管理器。上游已存在的文件解析、授权、PDF 页面片段和预览继续有效；本分支叠加入口，不能以「支持桌面打开」为由替换它们。

## 入口与默认行为

| 层 | 源码及符号 |
| --- | --- |
| 聊天文本 | [MessageView](../../components/MessageView.tsx) 的 `TextBlock` 转交 sessionId；[MarkdownBody](../../components/MarkdownBody.tsx) 的 `a` renderer 在有 `onOpenFile` 且解析为本地路径时使用 `LocalFileLink`。 |
| 链接/菜单 | [LocalFileLink](../../components/LocalFileLink.tsx)：左键仍 `onOpenFile`；右键创建 portal 菜单；显式选项才 POST `/api/files/desktop`。无单独启用设置，无动作历史持久化。 |
| 解析/净化 | [file-links](../../lib/file-links.ts) 的 `resolveLocalFileHref`、`shouldOpenLocalFileInApp`、`parsePdfPageFragment`；[markdown](../../lib/markdown.ts) 的 `rehypeWindowsFileLinks`、`markdownUrlTransform`。 |
| API/授权 | [desktop POST](../../app/api/files/desktop/route.ts)、[file-access](../../lib/file-access.ts)、[session-file-references](../../lib/session-file-references.ts)。 |
| OS 执行 | [desktop-files](../../lib/desktop-files.ts) 的 `isLocalDesktopRequest`、`desktopFileCommand`、`launchDesktopFile`；[windows-explorer](../../lib/windows-explorer.ts) 的两个静态 PowerShell 脚本。 |

## 必须保持的具体不变量

1. **预览优先，系统打开必须显式选择。** 普通左键和 Ctrl/Cmd+左键继续预览；Shift、Alt、中键、已 preventDefault、非 `_self` target 保留原处理。浏览器通常不允许 HTTP 页面直接导航 file URL，不能把 Ctrl/Cmd 行为改为依赖浏览器打开 file URL。外部链接保留 `target="_blank"` 与 `rel="noopener noreferrer"`，不出现本地菜单。
2. **文件 URL 和 PDF 兼容上游。** `resolveLocalFileHref` 处理 cwd 内相对文件、绝对路径、file URL、源位置后缀等；相对路径不能越过 relativeRoot，协议相对 URL 与 `/api/`、`/_next/` 不是本地文件入口。`parsePdfPageFragment` 仅接受正整数 `#page=N`，预览继续转交 page；其他 fragment 不当作 PDF 页。系统 API 只收到解析后的文件路径，不承诺默认 PDF 应用跳到该页。
3. **先规范盘符，再净化，不能放宽任意协议。** `rehypeWindowsFileLinks` 在 `rehypeRaw` 后、`rehypeSanitize` 前将 Windows 盘符链接规范为 file URL；两个 Markdown rehype pipeline 都保留此顺序。净化仍去除危险协议/标签，`markdownUrlTransform` 仅专门允许 file，其余交给默认 transform。没有应用内 `onOpenFile` 时 file URL 仍经默认 transform 成为惰性空 href。客户端解析不是服务端授权。
4. **来源检查先于文件操作。** `isLocalDesktopRequest` 要求 Host 为 localhost、127.0.0.1 或 `[::1]`，Origin 与 Host 构造出的目标 origin（含端口、协议）匹配；拒绝缺 Origin、`sec-fetch-site` 的 cross-site/same-site，拒绝不同的 x-forwarded-host。相同 x-forwarded-host 允许，因 Next 自身可能添加它。当前检查依据请求头而非 TCP 对端身份，不应宣称能防住任意主动伪造头的代理/本地程序。
5. **JSON 与路径约束。** API 仅接受 JSON、绝对 filePath、`open`/`reveal`，拒绝控制字符；Windows 仅本地盘符路径，并排除 UNC、device path、ADS 与不合法特殊字符。目标必须是文件，不能把目录当文件打开。OS 平台按服务端 `process.platform`，不按浏览器平台决定。
6. **双重根目录检查，引用不扩大目录授权。** 允许根来自已有会话 cwd/projectRoot、默认 cwd 目录及额外允许根（[getAllowedFileRoots](../../lib/file-access.ts)，缓存约 5 秒），不是只限当前聊天项目。正常路径同时经过词法检查和既有路径 realpath 检查。`open` 可使用当前 sessionId 的精确文件引用作为例外；`reveal` 没有该例外，还检查父目录。引用外部文件不会授权浏览其整个父目录。
7. **符号链接不得偷换引用权限。** 路由向 launcher 传 canonical realpath。若走 session 引用例外，canonical 路径也必须被同一会话引用；普通根路径通过 [path-security](../../lib/path-security.ts) 的既有路径检查阻止 symlink/junction 越界。检查到启动之间不是原子文件句柄授权；不要对受恶意并发修改的文件系统宣称完全消除 TOCTOU。
8. **路径是数据，不是脚本。** Windows 使用固定 `-NoProfile -NonInteractive -STA -EncodedCommand` 脚本，路径仅通过 `PI_WEB_DESKTOP_FILE` 环境变量传递，默认打开走 ShellExecute 文件关联。macOS 用 `/usr/bin/open`（reveal 为 `-R`），Linux 用 `xdg-open`（reveal 仅打开父目录，不保证选中文件）；其他平台抛错。`execFile` 每次超时 15 秒、输出上限 64 KiB；启动失败转成可显示的通用错误。文件关联可能运行程序，路径验证并不等于文件内容安全。
9. **Explorer 只操作确认新建的 view。** 静态脚本通过 ShellWindows 保存旧 COM identity，按 Z-order 找到可见 Explorer HWND；必要时还原最小化窗口。UIA Invoke `AddButton` 创建标签页；必须在选定 HWND 看到唯一新 COM view 且 tab 数恰好增加 1，才对这个新 view 执行 `Navigate2` 和 `SelectItem(..., 29)`。不能对旧 view 导航；前台激活只是 best effort。实现不使用 SendKeys、剪贴板或全局键盘注入。
10. **回退宁可新窗口，不误改旧标签页。** 没有 Explorer、缺 tab 控件、UIA/COM 不可用、身份歧义、7 秒内部 deadline 内未完成选中时，走 `explorer.exe /n,/select` 新窗口。脚本失败时不主动关闭已建的新 tab，因用户可能已交互；失败后可能残留空 tab。若整个 PowerShell 执行失败/超时，launcher 再执行不含 UIA 的 fallback，二者均失败才向 API 抛错。
11. **并发与生命周期有界但不持久化。** Windows reveal 用 `globalThis.__piDesktopRevealQueue` 在服务进程内跨链接/会话串行，前一失败不阻断后续；open 不入该队列。它不协调其他 Pi Web 进程或用户手工操作。菜单 `inFlight` 防重复点击，busy 时禁用项；成功关闭菜单并回焦链接，失败保持可见 alert。Escape 关闭并回焦；Tab、外部点击、滚动、resize 等关闭菜单。刷新/服务重启不恢复菜单或队列，已开的系统窗口不会被自动回收。
12. **失败状态可区分。** 非本机来源/权限拒绝为 403；非 JSON 为 415；无效 JSON/路径/动作、目录为 400；授权范围内缺失文件为 404；系统启动或其他运行错误为 500。HTTP 200 只表示 launcher 完成其检查/提交动作，不代表用户已经在应用里读到文件，尤其 fallback 没有完整窗口结果核验。

## 自动化验收（仓库根目录）

前置：现有项目依赖及所需 Node 已安装。以下普通测试不会打开真实桌面应用；其中 Windows 专属项会在其他平台 skip，应记录 skip 而非宣称覆盖。

```bash
node --experimental-strip-types --test lib/desktop-files.test.mjs lib/desktop-files-launch.test.mjs lib/windows-explorer.test.mjs app/api/files/desktop/route.test.mjs components/LocalFileLink.test.mjs components/MarkdownBody.test.mjs
node --experimental-strip-types --test lib/file-links.test.mjs lib/file-access.test.mjs lib/session-file-references.test.mjs lib/file-viewer-state.test.mjs components/AppShell.file-viewer-state.test.mjs
```

- [desktop route test](../../app/api/files/desktop/route.test.mjs)：真实临时文件与 junction/symlink、launcher 和 session 引用 stub；覆盖状态码/授权顺序，**不是 OS 启动验收**。
- [desktop-files-launch](../../lib/desktop-files-launch.test.mjs)：Windows 上 mock execFile，检查队列、重试和失败后恢复。非 Windows 不运行该逻辑。
- [windows-explorer tests](../../lib/windows-explorer.test.mjs)：源码规则断言；Windows 上真实 PowerShell 语法解析，并用替换后的无副作用 fallback 验证失败路径；不验证真实 tab 成功路径。
- [LocalFileLink tests](../../components/LocalFileLink.test.mjs)：抽取 click handler 测试 PDF 和修饰键，不是完整 DOM 菜单测试；[MarkdownBody tests](../../components/MarkdownBody.test.mjs) 为静态渲染/净化回归。

浏览器层需事先有本地可访问、无需额外登录处理的服务、已安装的 Playwright 浏览器、一个 cwd 以 pi-web 结尾的空闲会话：

```bash
node e2e/local-file-links.mjs
```

[e2e/local-file-links](../../e2e/local-file-links.mjs) 默认连 `http://localhost:30141`，可用 `PI_WEB_TEST_URL` 与 `PI_WEB_TEST_BROWSER_CHANNEL` 调整。它仅在响应中替换消息、拦截所有 desktop POST，不发送 prompt；验证菜单、sessionId、错误、焦点和 Ctrl 预览，**不验证服务端授权或真实 Explorer**。

保留上游 PDF 独立回归；前置是没有活跃 dev server 的隔离 checkout 和已装完整 Chromium（headless shell 不带 PDF viewer）：

```bash
node e2e/pdf-page-fragment.mjs
```

[PDF E2E](../../e2e/pdf-page-fragment.mjs) 创建隔离 agentDir、200 页 PDF、会话与本地服务器，并写 `test-results/e2e/`。断言 iframe `#page=` 传递/清除/重建，截图供人工检查；不是系统默认 PDF 阅读器验收。

## 手工及真实桌面验收

前置：服务和浏览器在同一桌面登录用户下；从 localhost 同源进入；在允许根内准备纯文本（含中文、空格、`&`、单引号）及多页 PDF。仅打开已确认安全的文件；LAN、生产会话和未知关联程序不适合作为正向夹具。

1. 左键、Ctrl/Cmd 点击相对路径、盘符绝对路径与 file URL：预期都预览，无系统应用出现。PDF `#page=12` 预期页面参数到达 viewer；同文件无 fragment 再开应清除旧跳页；未知 fragment 不跳页。外部 https 链接预期无桌面菜单。
2. 右键后键盘 ArrowUp/Down、Home/End 选择两项，Escape 返回链接，Tab/外部点击关闭。选 open 预期默认程序打开 canonical 文件；选 reveal 预期显示/选中文件（Linux 只要求父目录）。连续双击不产生重复同一请求；错误注入或不可用默认程序时，菜单保留错误且可关闭重试。
3. Windows 11 打开两个 Explorer 窗口及多个不同目录标签页，记录位置。把目标窗口置于更高 Z-order 后 reveal：预期同一窗口新增一 tab、选中文件、所有旧位置不变。最小化窗口、连续两个 reveal 也核实结果；不得用「有窗口弹出」代替旧标签页未被改写检查。
4. 真实 Explorer 脚本为显式 opt-in，运行前取得桌面交互许可、保持已有 Explorer 窗口、暂停手动改标签页。仓库根目录 **PowerShell** 命令：

   ```powershell
   $env:PI_WEB_TEST_NATIVE_EXPLORER = "1"
   node e2e/windows-explorer-tabs.mjs
   node e2e/windows-explorer-tabs.mjs --fallback
   Remove-Item Env:PI_WEB_TEST_NATIVE_EXPLORER
   ```

   [原生验收脚本](../../e2e/windows-explorer-tabs.mjs) 第一条预期新增一个 view 且 HWND 集合不变；第二条通过缺失控件模拟，预期新增一个顶层窗口。二者检查旧 location 保留和目标文件选中，**会真实打开 tab/窗口，不自动关闭**。执行后仅由用户关闭本次新建对象。无窗口/真实旧版 Explorer 回退仍需单独手工检查，不能用模拟替代全部兼容性验证。
5. 从测试环境逐项发负例：非同源 Origin、LAN Host、缺 Origin、不同 forwarded-host、非 JSON、相对路径、Windows UNC/device/ADS、目录、缺失文件、根外无引用文件、symlink 越界。预期对应 403/415/400/404，绝无系统启动。session 引用根外文件时 open 可获准、reveal 仍 403；此例要求准备真实可解析的 session 引用，不能仅随便填 sessionId。

## Rebase / 上游整合清单

- [ ] 将本分支新增菜单/API 与上游已有 [file-links](../../lib/file-links.ts)、PDF page fragment、session 引用权限分开审查；这些共享 helper 在本基线相对 origin/main 未改，不用本分支重新实现一份。
- [ ] 合并 Markdown renderer 时保留稳定组件身份、sessionId、`onOpenFile(filePath, page)`，以及没有 handler 时的 URL 安全行为。
- [ ] 保留 Windows 盘符规范化在 sanitize 前，验证 script 协议仍被拒绝；同时查两个 rehype pipeline。
- [ ] 检查上游 allowed roots/引用/realpath 变化是否意外授权父目录，逐项运行负例。
- [ ] Explorer UIA ID、ShellWindows tab 暴露形式或超时策略变化时，执行原生 tab/fallback 验收，不以正则通过替代；保留「只导航唯一新 view」约束。
- [ ] 原生启动 API 若被上游统一，确认参数数据通道、平台错误和进程级串行语义等价后再去重。

## 限制与维护要求

需要交互桌面和系统文件关联；无头服务器/服务账户会失败。Windows tab 策略依赖 OS 控件与 COM 暴露行为，回退不是失败掩盖，而是安全降级；允许残留新 tab，不能为了整洁关闭用户可能已使用的对象。来源检查不是认证替代，也没有每个文件类型的执行白名单或额外确认框。

每次修改链接、安全策略或原生脚本，都更新本文基线、逐条不变量和验收矩阵。报告要区分「静态源码」「mock/夹具」「浏览器拦截」「真实 OS」四层证据；命令清单不是运行结果，真实桌面效果需单独验收。
