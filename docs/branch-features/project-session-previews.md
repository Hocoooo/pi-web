# 项目会话预览：默认五个会话族

## 目的、用户价值与范围

在[全项目侧边栏](all-projects-sidebar.md)中限制每个项目初始占用的纵向空间，同时允许按项目展开全部会话。修改五条限制、会话排序、子代理归组、更多/收起按钮或选择揭示逻辑时使用本契约。

预览属于客户端行模型，不是服务器分页或减少会话目录请求；`current` 模式和独立搜索结果不受五条限制。这里的“根会话”指会话族根（非 `subagent`），不是文件系统项目根。

## 入口与当前默认值

开启“显示所有项目”后，每个未折叠项目默认最多显示 **5 个会话族根行**；超过五个时显示“展开更多（N 条）”，展开后为“收起更多”。常量为 `PROJECT_SESSION_PREVIEW_LIMIT = 5`。

项目整体折叠与“显示更多”是两种状态：前者存入浏览器偏好，后者是 `SessionSidebar` 的 `expandedProjects` 内存数组，初始为空。

## 行为要求与不变量

1. **计数单位。** 先按稳定项目 key 分组，再调用 `listSessionFamilies`，最后对会话族切片。五个根加任意数量子代理仍只有五行且没有更多按钮；普通主会话及 fork（只要不是 `subagent`）各占一个根行。
2. **子代理归属。** 同一项目输入集合内的多级 `subagent.parentSessionId` 链最终归于非子代理根；所有后代藏在同一根行背后，不单独渲染，也不提供预览内子代理树。孤儿或循环关系不提升为根。跨项目 key 的关系在项目内分组时无法找到根，不应凭 UI 名称强行归组。
3. **活动排序。** 会话族按根及其可解析后代的最大 `modified` 倒序，旧根可因子代理新活动进入前五。根行沿用根的名称/消息数，显示时间可取族最新时间；选中/运行/未读标志检查根和族内后代。点击及[复制会话 ID](session-id-copy.md)仍针对根。
4. **边界。** 0–5 个族不显示更多按钮；有活动空项目时仍可有项目标题而无会话行。6 个族显示 5 行及 `remaining = 1`，更大数量始终用 `族总数 - 5` 计算剩余值，而非 session 总数或未挂载 DOM 数。
5. **展开/收起。** 展开一个项目显示该项目全部族并保留尾部“收起更多”；其他项目不变。收起恢复最新前五，不改变已选会话。项目整体折叠时仅显示标题，隐藏会话及更多行；再次展开时沿用尚在内存的更多状态。
6. **生命周期。** 更多状态不写 localStorage、不跨标签同步，完整刷新/组件重新挂载后恢复五条。同一组件存活期间切换 `current`/`all` 不清空 `expandedProjects`。数据更新后重新计算排序/行数；删除到五个族以下时更多行消失，即便 expanded key 仍在内存。
7. **选择例外必须区分。** URL/搜索/普通会话选择会展开项目，但没有通用的“选中就突破五条”规则。`pi:focus-session-sidebar`（通常来自 Alt+Left）找到所选会话或其父族后，若该族当前不在 `listRows`，将该项目加入更多状态并聚焦根行。项目原本整体折叠时即使所选族属于前五，也可能因“当前不在行模型”而展开全部。这是现有实现，不应把它描述成严格只揭示第六条以后的例外。
8. **虚拟化。** 项目标题、根行、更多行共同进入一个扁平固定高度列表；更多行也占 54px。展开改变逻辑行数，不意味着一次挂载全部 DOM。键盘必须按完整逻辑行模型导航，见[侧边栏键盘导航](sidebar-keyboard-navigation.md)。
9. **失败与状态隔离。** 预览本身不发请求、不改变 cwd、不修改磁盘会话；依赖侧边栏加载错误处理。不会因为某个运行/未读族在第五条后就自动突破限制，项目标题活动计数仍反映完整项目。只有明确展开或上述焦点路径才改变更多状态。

## 实现地图

| 路径 | 关键符号/职责 |
| --- | --- |
| [sidebar-project-rows.ts](../../lib/sidebar-project-rows.ts) | `PROJECT_SESSION_PREVIEW_LIMIT`、`SidebarProjectRow`、`buildSidebarProjectRows` |
| [session-family.ts](../../lib/session-family.ts) | `resolveFamilyRoots`、`listSessionFamilies`，多级归组、循环/孤儿排除、族排序；此基础能力继承自上游 |
| [project-groups.ts](../../lib/project-groups.ts) | `getRecentProjects`，项目活动顺序，不与族顺序混淆 |
| [SessionSidebar.tsx](../../components/SessionSidebar.tsx) | `expandedProjects`、`projectRows`、`listRows`、`focusSidebar`、`virtualIndices`、`row.kind === "more"`、`displaySession` |
| [sidebar-keyboard.ts](../../lib/sidebar-keyboard.ts) | `sidebarKeyboardAction`、`sidebarRowKey`；更多行展开前后使用同一 `more:<projectKey>` |
| [zh-CN.ts](../../lib/i18n/messages/zh-CN.ts) | `sidebar.showMoreSessions`、`sidebar.showFewerSessions`（另有 en/zh-TW 对应键） |

## 自动化验收

根目录命令如下；这里只描述可用覆盖，具体运行结果须在各次维护任务中记录。

```sh
node --experimental-strip-types --test lib/sidebar-project-rows.test.mjs lib/session-family.test.mjs lib/sidebar-keyboard.test.mjs components/SessionSidebar.test.mjs
```

- [行模型测试](../../lib/sidebar-project-rows.test.mjs)执行真实纯函数：0/1/4/5/6/20 边界、剩余数量、两项目独立展开、折叠覆盖更多、删除后无更多、worktree、相同 basename 和族计数。
- [会话族测试](../../lib/session-family.test.mjs)覆盖多级子代理、族活动顺序、孤儿及循环；[键盘测试](../../lib/sidebar-keyboard.test.mjs)覆盖更多行左右键动作。
- [组件测试](../../components/SessionSidebar.test.mjs)的族 UI 聚合为源码断言，虚拟窗口计算为函数测试，不是浏览器渲染证明。

另开终端运行 `npm run dev`，在已安装 Playwright Chromium 的环境从根目录用 Git Bash/POSIX shell 执行：

```sh
E2E_BASE_URL=http://127.0.0.1:30141 node e2e/sidebar-view.mjs
PI_WEB_TEST_URL=http://127.0.0.1:30141 node e2e/session-keyboard.mjs
```

[sidebar-view.mjs](../../e2e/sidebar-view.mjs)用真实 Chromium 和拦截 API 的 7/6 根 fixture 验证五条、数量、独立更多/收起、单项目不截断。[session-keyboard.mjs](../../e2e/session-keyboard.mjs)以 80 个根验证展开后到末尾，选末尾会话刷新后 Alt+Left 揭示它。两者都不是实时后端数据测试，未覆盖浏览器中的真实子代理/孤儿/循环；也不由 `npm run test:e2e` 自动运行。

## 手工验收

前置：可丢弃会话数据；项目 A 有 7 个根，B 有 6 个根，C 有 5 个根并有至少 8 个属于其中一根的子代理。记录根及子代理的 `modified`，开启 all 模式，完整刷新重置更多状态。

1. A/B/C 各显示五个根；A 按钮数量为 2，B 为 1，C 无更多。项目标题和更多按钮均不计入“五个根”。
2. 展开 A：应显示 7 根及“收起更多”，B 仍为五根。整体折叠 A 再展开，应保持七根；收起更多后回五根。切换模式再回来不应主动重置其内存状态；完整刷新则恢复五根。
3. 更新 C 中较旧根的子代理活动：对应根按族最新时间排序，不出现子代理独立行。模拟孤儿/循环元数据时不应出现伪根；此步骤只在隔离 fixture 中修改数据。
4. 在 A 选中第七根，再完整刷新：聊天仍可选中该会话，但预览可只显示五根。按 Alt+Left 应展开 A 并滚动聚焦第七根；如果选中的是子代理，应聚焦对应父族根。按“收起更多”后不应切换聊天。
5. 使用测试数据将 A 减至五根，等待列表刷新：更多按钮消失。模拟列表刷新失败，应显示列表错误并保留既有数据，而非把更多状态误当作 API 分页失败；恢复请求后按新数据重新计算。

## Rebase 保留清单与上游交互

- [ ] 顺序保持“项目身份分组 → 会话族 → 族活动排序 → 五条切片”，不能提前按原始 session 截断。
- [ ] 保留孤儿/循环处理及上游“子代理不单独出现在主列表”的语义；若上游改族结构，逐条复核计数与根动作。
- [ ] 更多状态与项目折叠状态分离，前者不持久化；普通选择与 Alt+Left 揭示例外分别验收。
- [ ] 固定高度、尾部更多行和稳定 key 与新虚拟列表实现相容；键盘展开后焦点跟随更多行而非旧索引处的新会话。
- [ ] 搜索结果和 `current` 模式不被错误套用五条规则。

## 已知限制与未验证区域

此限制减少渲染行，不减少服务器列举量；展开也不是“下一页”。自动排序可能在后台活动后移动根行。没有针对“选中/运行/未读必须置顶”的额外规则。跨项目 key 的子代理链、全折叠后焦点揭示及浏览器动态删行尚需手工组合验收，纯函数覆盖不能代替这些联动。

## 维护规则与基线

固定基线 **`63c6e4e`**，比较对象 `origin/main` 为 `96966e5`。分支新增预览模型/更多 UI，族归组是复用机制。调整限制、生命周期或揭示条件时同步修改契约与边界测试，重新核对关联全项目和键盘文档；只有明确重验后才更换基线，不自动追随 HEAD。
