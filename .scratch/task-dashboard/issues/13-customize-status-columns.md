# 13: 增加、改名和调整状态列

**What to build:** 用户可以维护所有项目共用的状态列，增加未完成列、改名、调整顺序；完成列即使改名也保持完成含义，设置重启后仍有效。

**Blocked by:** 01（建立能保存任务的基础看板）。

**Status:** resolved

## Acceptance criteria

- [x] 提供列设置入口，可以增加列、编辑名称和调整全局顺序，保存后所有项目及无项目看板使用同一配置。
- [x] 初始五列与 01 的稳定身份继续有效，已有任务不会因改名被移列或新建状态；身份不按文案匹配。
- [x] 新增列一律表示尚未完成，不允许靠命名“已完成”或修改前端参数创建第二个完成语义。
- [x] 唯一完成列可改名、调序，但完成含义不变；已有用户完成状态保留，不触发 AI、归档或额外运行。
- [x] 列名称和顺序有服务端校验，不能生成无效列引用；初始化与迁移不重复增加默认列，旧任务可直接使用更新后的配置。
- [x] 列配置与任务状态存储一致，刷新、重开存储后顺序和名称保留；两页面同时修改提示冲突，不静默覆盖。
- [x] 页面可用键盘或按钮调整列顺序，不仅靠拖拽；手机上名称编辑、确认、取消和失败反馈可用。
- [x] 通过统一任务操作入口和浏览器验证新增、改名、排序、完成身份、重复初始化、竞争和故障；若筛选功能已接入，按列身份保存的条件在改名后仍有效。
- [x] 同步全局状态列与看板设置的功能合同，沿用仓库既有设置 UI 规范，不新增独立于任务模块的第二套列配置逻辑。
- [x] 测试使用临时存储，不调用真实模型、不改真实任务；记录平台与浏览器的实际验证范围。

## Scope and handoff

只新增、改名、重排；删除由 14 完成，不展示一个未经保护的删除按钮。没有必要等待对话关联、共享重点、拖拽卡片或归档，因此只依赖 01。

本票据保持一个完成列和至少一个未完成列，不提供按项目覆盖配置、多完成列或完成勾选框。任务卡片的列内顺序与列本身的顺序是两种不同设置。

## Spec coverage

用户故事：US18、US19、US20、US21、US22、US60、US61、US62、US63、US65。
访谈选择：Q07、Q17、Q27。
实现决策：D2、D3、D4、D10。
验收计划：T01、T05、T17、T21、T23。

## Comments

2026-10-09（父验收）：隔离核心review和主集成独立review均无未关闭P0/P1/P2。
主完整证据 `/tmp/pi-web-ticket13-main-integration-20261009/REPORT.md`：2681pass/0fail/4skip、
tsc/lint及必要浏览器通过。独立复审另外完成2个迁移窄测、4组跨进程真实store和4组实际浏览器
交叉验证，确认06历史/CAS、02创建/资料、03移动receipt、列配置与双草稿互不污染。
父核对增量/验证报告，现按13范围验收resolved；无删除功能，04仍未集成，不能据此验收后续。
Windows/Safari真机/最低Node/生产打包/故障耐久性仍未验证。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

2026-10-09 主集成领取：按用户当前授权，仅在主工作区增量集成只读 ticket13 成果；01/02/03/06 均保留父验收 resolved，04 仍隔离开发，不读取或写入其树。13 保持 claimed，不勾父验收。源证据 `/tmp/pi-web-parallel-13-5ihjn5br/ticket13/ticket13-artifacts/REPORT.md` 不作为主通过；主 fresh 证据与精确含新文件增量记录于 `/tmp/pi-web-ticket13-main-integration-20261009/REPORT.md`。主 beforehash `/tmp/ticket13-main-beforehash-20261009-193039.json`。

主集成实施：只按源增量合并v1/v2→v3 columns/columnsRevision、SettingsUi列设置与三语言，保留主06完整validation/hydration/current/history/CAS/receipt/被动Markdown、01/02/03创建指纹/资料草稿/排序receipt。新增真实v2含06历史迁移、列设置后知识与精确重试不回拨、自定义列共享/资料/移动、坏知识拒读交叉测试；不添加删除。源树只读，无04集成、commit/push/build/global install/provider/服务动作。

主fresh：store/API51/51、列/交叉11/11、扩大focused86/86、full2685tests/2681pass/0fail/4Windows-only skip、tsc/lint0；13browser两轮7/7、06context两轮8/8、01draft12/12、02details8/8、03order10/10、retry-reload6/6、三语言取消3/3、基础看板/项目/独立聊天/键盘均退出0。本轮无失败或取消，skip明确不算通过；详细命令/log/exit及主含三新增增量patch见上述REPORT。复用主30142新14934/14937、SSR元数据/PARALLEL/AGENTS/父验收评论未回退；父新增TEST-ISOLATION仅保留不进13产品增量。TMPDIR默认Git树外/tmp，next.config原字节不变，tsbuildinfo/tmp。旧Safari/Windows/软件键盘真机/最低Node/生产打包/断电NFS/真实provider未验。仍claimed，父验收框未勾选。
