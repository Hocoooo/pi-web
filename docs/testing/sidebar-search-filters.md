# F39 统一搜索与筛选入口：第一版验收

契约：[sidebar-search-filters.md](../branch-features/sidebar-search-filters.md)。实现起点 `444d25e`；沿用用户批准的 HTTP 与真实浏览器公开入口，临时 API fixture，不操作真实Task/会话或调用模型。

## 已执行

- Red：现有UI没有 `Search and filters` 按钮，新浏览器首切片失败；迁移旧Task树/归档脚本也记录相同red。
- Green：复用原按钮打开desktop浮层；不常驻Task/范围select或搜索input；Task资料搜索子页、范围/添加条件、关闭保留正文结果、32px摘要与清除。
- 后续red/green：Task选项ArrowDown/End/Enter；IME 229箭头不抢输入；手机modal阻止焦点进入背景；摘要固定单行和保留`+N`。
- `node_modules/.bin/tsc --noEmit`、`npm run lint`、`git diff --check`：通过。
- 现有Node/HTTP定向回归：**65 通过，0失败**。原SessionSidebar测试需要加载新的CSS module bundler artifact，按仓库ChatMinimap测试先例注册Node加载hook；此stub不作CSS渲染证据。
- 专项 `e2e/sidebar-search-filters.mjs`：desktop +390px en/zh-CN/zh-TW、浅深主题；真实CSS；默认清爽、Task资料/完成标准查找与正文独立、组合条件请求、即时范围变化/关闭保持/单项与全部清除、URL不变、外部点击、Escape/IME、选项键盘、mobilemodal焦点/Tab、visualViewport模拟460px时sheet不落到键盘区域，全部通过。
- 迁移后的 `e2e/sidebar-task-tree.mjs`、`e2e/session-archive.mjs`：原Task树/五族/empty/unlinked/owner/copy/归档独立/多级族/筛选reveal、归档写失败/retry/历史/草稿/hover尺寸/跨标签/keyboard/三语言主题通过。
- 原 `e2e/sidebar-view.mjs`、`e2e/session-keyboard.mjs`：旧项目布局和80根虚拟键盘导航通过。
- 双轴独立审查后：reset后Tab不逃出；desktop Alt+Right后`/task`与Settings叠层只由上层处理Escape；跨breakpoint回退可见开关；手机owned sheet桥接精确Alt+Left/Right且保留IME229；同名Task完整路径/归档无障碍说明、长路径不挤掉归档标记，新增浏览器回归通过。`/task`只允许mock的task-picker资料POST，仍拒绝真实/fixture关系写入。
- 最后无障碍red/green：主页条件按钮关联已生效值说明（Task/对话范围），红日志 `/tmp/pi-web-f39-home-description-red.log`，绿日志 `/tmp/pi-web-f39-home-description-green.log`；修复后再次typecheck/lint、全量3081/3072/0失败/9跳过，日志 `/tmp/pi-web-unified-full-delivery.log`，exit0。
- 测试同步修正：正文条件变化等待对应HTTP响应而非固定400ms；移动操作先等待drawer ready与打开几何；nested reveal等待摘要reset再检查焦点，不能把点击时已经有的行焦点当RAF动作完成。所有原断言保留。
- 最终校准环境全量：**3081 条，3072 通过，0 失败，9 跳过**。审查修复后的日志 `/tmp/pi-web-unified-post-review-full.log`，exit0；定向日志 `/tmp/pi-web-unified-targeted.log`，浏览器专项 `/tmp/pi-web-unified-review-green.log`。

## 审查

以固定起点`444d25e`审查本次working-tree和新文件，排除安装器既有改动。Standards与Spec独立执行并独立复审：叠层Escape、reset/Tab、路径/归档提示问题已修复；当前两轴均无剩余blocker或新增范围问题。复审是代码/测试检查，不冒称独立重复执行全部浏览器用例。

## 环境和看效果

复用当前源码的健康dev `http://127.0.0.1:30142`；`30141`是已安装旧版本。没有新开/重启服务、build、全局安装、push或真实provider调用。全量仅在子命令去掉继承的相对Node preload，并使用canonical TMPDIR，与F38校准相同；不持久改用户环境。

浏览器截图为fixture而非用户真实Task。本次临时目录 `/tmp/pi-web-search-filters-38nco9`，包含中文desktop-default/panel/filtered、desktop-active-panel与三语言mobile-light/dark；临时路径不保证永久可用。已检查中文desktop浮层与mobile暗色，截图等待正文响应并仅隐藏Next开发指示器，不把Node CSS stub或短暂drawer过渡帧当视觉验收。

## 边界

Safari/iOS16.2、Windows真机、真实软件键盘与生产安装未验；viewport为Chromium模拟。Task候选未新增大规模虚拟化；首版只有Task/归档/正文，不声称已支持其他筛选条件。9条skip不算通过。服务端API和存储未改，保留F38/F34原HTTP语义。
