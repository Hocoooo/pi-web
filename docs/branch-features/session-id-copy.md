# 侧边栏右键复制会话 ID

## 目的、用户价值与范围

在不打开/切换会话的情况下，从侧边栏普通会话行获取完整会话 ID，用于定位、调试或交给其他工具。修改会话右键菜单、剪贴板 helper 或下游事件钩子时使用本契约。

个人分支增加默认的内置“复制会话 ID”菜单；上游已有可取消的行右键事件及通用 `copyText` helper。不是复制会话文件路径、项目 cwd、标题或完整聊天，也不保证搜索结果/其他面板都提供同样菜单。

相关：[全项目侧边栏](all-projects-sidebar.md)、[会话族预览](project-session-previews.md)、[键盘焦点规则](sidebar-keyboard-navigation.md)。

## 入口与当前默认值

在主侧边栏的普通根会话行上触发 `contextmenu`（通常右键）。无监听器认领事件时，在鼠标附近显示 `role="menu"` 的单项菜单，菜单项为 **复制会话 ID**。菜单初始关闭、成功提示初始 false；不需要启用 all 模式。

重命名和删除确认中的行没有该 `onContextMenu` handler。主列表展示会话族根，因此入口操作对象是根，不是当前聊天可能选中的子代理 ID。没有专门的复制快捷键或移动长按实现。

## 行为要求与不变量

1. **完整 ID。** 复制 `menu.id`，来自当前根行 `session.id`；不截成标题回退所用的 12 字符，不拼 URL、路径或额外前后缀。打开菜单与复制本身不调用会话选择、修改或删除 API。
2. **扩展优先。** `handleContextMenu` 首先同步调用 `dispatchSessionRowContextMenu`，发出可取消的 `pi-web:session-row-contextmenu`。detail 含 id/path/cwd/name、clientX/clientY、refresh 回调。监听器在同步 dispatch 内 `preventDefault()` 才算认领；仅观察事件不阻止内置菜单，异步取消太晚。
3. **原生菜单与 fallback。** handler 对原始 React contextmenu 总是 preventDefault/stopPropagation。若扩展已认领则不新开内置菜单，否则调用 `onOpenMenu`。这与上游“无人认领就保留原生菜单”的旧行为不同；不要只恢复事件 helper 而丢失 fallback。
4. **位置与挂载。** 内置菜单 portal 到 `document.body`，fixed 定位、z-index 10000；坐标按估算宽 196/高 52 与视口留 8px 边距夹取，最大宽度 `calc(100vw - 16px)`。这是启发式定位，不是动态测量全部语言文本后保证永不溢出。
5. **焦点与关闭。** 挂载时聚焦第一个 button。Escape preventDefault 后关闭；菜单外 pointerdown、窗口 resize、菜单外 scroll（capture 监听）关闭。菜单内点击/滚动不因外部 dismiss 检查关闭。关闭没有显式恢复原行焦点，也没有完整菜单方向键/focus trap。
6. **Clipboard API 分支。** 若 `navigator.clipboard?.writeText` 存在，直接返回其 Promise。resolve 才显示“已复制”，并在约 700ms 后关闭；reject 直接关闭，不显示失败原因、不重试、**不回退** execCommand。权限拒绝、非授权环境的实际失败必须靠粘贴/系统剪贴板核验，不能只看菜单消失。
7. **旧式 fallback 分支。** 只有 writeText 不存在时才创建隐藏 textarea、select、调用 `document.execCommand("copy")`、移除 textarea。同步抛错会 reject 并关闭菜单；若 execCommand 返回 `false`，helper **忽略返回值并 resolve**，UI 仍可能显示“已复制”但剪贴板未改变。这是当前已知缺口，不是保证复制成功的契约。
8. **瞬态与行状态。** transient 禁止磁盘重命名/删除，但没有复制 ID 的 transient guard；只要它实际出现在主列表且为普通行，就可复制其当时 ID。`deleting` 本身也未禁用右键 handler。重命名/确认状态退出后恢复普通入口。
9. **生命周期与存储。** 菜单/成功提示仅是组件内存状态，不写 localStorage、不创建服务器状态；系统剪贴板的保留由系统决定。现有成功定时器未在卸载时清理，也未把每次换 menu.id 作为成功状态重置点，不应承诺快速连续右键/异步回包的竞争已完全处理。

## 实现地图

| 路径 | 关键符号/职责 |
| --- | --- |
| [SessionSidebar.tsx](../../components/SessionSidebar.tsx) | `SessionContextMenuState`、`SessionContextMenu`、`sessionMenu`、`closeSessionMenu`、`SessionItem.handleContextMenu`、`onOpenMenu` |
| [session-row-context-menu.ts](../../lib/session-row-context-menu.ts) | `SESSION_ROW_CONTEXT_MENU_EVENT`、`SessionRowContextMenuDetail`、`dispatchSessionRowContextMenu`，同步认领机制 |
| [clipboard.ts](../../lib/clipboard.ts) | `copyText`，直接 Clipboard API 与旧式 fallback 的实际失败语义 |
| [zh-CN.ts](../../lib/i18n/messages/zh-CN.ts)、[en.ts](../../lib/i18n/messages/en.ts)、[zh-TW.ts](../../lib/i18n/messages/zh-TW.ts) | `session.copyId`、`session.copied`、`sidebar.sessionMenu` |
| [session-family.ts](../../lib/session-family.ts) | `listSessionFamilies`；主列表把后代聚合到根，而复制入口接收根对象 |

## 自动化验收

从仓库根目录执行；以下记录现有覆盖，具体运行结果须在各次维护任务中记录。

```sh
node --experimental-strip-types --test lib/session-row-context-menu.test.mjs components/SessionSidebar.test.mjs
```

- [session-row-context-menu.test.mjs](../../lib/session-row-context-menu.test.mjs)用 Node `EventTarget` 调用真实 dispatch，覆盖无人监听、观察不认领、同步 preventDefault 认领及 detail 原样传递。其“native context menu”测试标题指 helper 没有被认领，不证明当前组件会保留原生菜单。
- [SessionSidebar.test.mjs](../../components/SessionSidebar.test.mjs)对此功能仅是源码契约：普通行才注册 handler、先检查 handled、存在 `copyText(menu.id)` 和文案 key。文件中的其他虚拟窗口测试与剪贴板成功无关。
- 基线中未找到针对本菜单的独立浏览器脚本或 `copyText` 成功/拒绝/execCommand false 的专用自动化测试。`npm run test:e2e` 和其他 sidebar fixture 脚本不能被列作“真实系统剪贴板已验证”的证据。

## 手工验收

前置：使用可丢弃浏览器配置、本地受信任上下文或 HTTPS，以及可辨认完整 ID 的两个测试根会话 A/B；剪贴板先放入标记 `before-copy`，避免把旧内容误认成成功。打开 DevTools 监视请求，准备一个应用外纯文本编辑器作为粘贴目标。

1. 在未选中的 B 普通行右键，应出现内置菜单且原生浏览器菜单被阻止，聊天/URL 仍指向 A。点复制，在外部编辑器粘贴，必须与 B 完整 ID 完全相等；成功提示约 700ms 后关闭。all/current 模式各做一次。
2. 分别在临近视口四角右键，检查菜单可读可点击；Escape、点菜单外、滚动主列表、调整窗口大小都应关闭。重命名 input/删除确认中不应出现此内置菜单。选择某个子代理的聊天后从主列表根行复制，应拿到根 ID。
3. 在 DevTools 添加同步认领 listener：`window.addEventListener("pi-web:session-row-contextmenu", e => e.preventDefault(), { once: true })`。下一次右键不新开内置菜单；再右键（once listener 已移除）恢复。仅记录 detail 而不 preventDefault 的 listener 应仍出现内置菜单。
4. **真实拒绝：** 在浏览器站点权限中拒绝剪贴板写入（若该浏览器提供），或用测试环境策略使 `writeText` 返回 rejected Promise。点击后菜单应关闭，无成功/错误提示；粘贴应仍是旧标记，不得把关闭当成功。API 存在而拒绝时不会走旧式 fallback。若浏览器无法制造真实权限拒绝，记录为未验证，而不是用 mock 冒充真实失败。
5. **受控 fallback 故障注入：** 在隔离测试页将 `navigator.clipboard` 临时设为不可用并让 `document.execCommand` 分别返回 true/false、抛异常；需要 DevTools/自动化支持，结束后刷新恢复。true 只验证 UI 成功路径，仍要实际粘贴核验；false 的当前预期是可能错误显示成功；抛异常应关闭且无失败提示。此步骤是 mock 故障注入，不是操作系统剪贴板验收。
6. 快速开 A 菜单、复制后再开 B 菜单，以及 Promise 延迟时关闭/切行：记录提示/定时关闭的竞争结果。当前没有竞争安全保证；发现旧定时器关闭新菜单应作为缺口记录，不擅自改成新行为要求。

## Rebase 保留清单与上游交互

- [ ] 保留上游事件 detail 和同步可取消语义；先给下游监听器机会，再走本分支内置 fallback。
- [ ] 普通行主动阻止原生菜单，但编辑/确认中不绑定入口；不要借复制添加会话选择或磁盘请求。
- [ ] 始终复制行的完整根 ID，确保上游族模型/搜索 UI 改动没有把标题或子代理 ID 错接进来。
- [ ] 复核通用 `copyText` 的变更：若上游修复 execCommand false、增加拒绝回退或错误提示，同步更新本契约的现状与测试，不能继续声称旧缺口仍在。
- [ ] portal、视口夹取、dismiss 清理和国际化文案均保留；与键盘文档中的非模态/焦点规则联合验收。

## 已知限制与未验证区域

Clipboard API 拒绝无可见失败说明，fallback false 会产生假成功，fallback 在 textarea 创建后抛错还可能没有执行移除。没有确认复制内容的回读、失败重试或显式焦点归还。复制定时器/快速换菜单竞争、屏幕阅读器菜单导航、移动长按及不同浏览器权限策略暂无专门浏览器自动化覆盖。文档只记录这些现状，不把缺陷固化为期望长期保留的产品设计。

## 维护规则与基线

固定基线 **`63c6e4e`**，本次比较的 `origin/main` 为 `96966e5`。已核对分支新增的 portal/fallback 与未改动的事件 helper、clipboard helper；不能从“有复制菜单”推导“系统剪贴板一定成功”。修改菜单/helper 后同步更新成功与失败验收、测试类型及已知缺口；只有显式重新核对才更新基线，不永久声称代表最新 HEAD。
