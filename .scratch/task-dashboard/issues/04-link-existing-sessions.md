# 04: 把已有对话归入任务

**What to build:** 用户可以从聊天创建任务，或在任务中手动多选关联旧对话，再从任务回到原聊天；看板显示对话数量和独立的 AI 工作提示。

**Blocked by:** 01（建立能保存任务的基础看板）。

**Status:** resolved

## Acceptance criteria

- [x] 从已有聊天创建任务并关联来源对话；任务的项目身份与来源保持一致，不把已有聊天的工作目录改成别的目录。
- [x] 任务详情可选择多个旧对话关联，展示关联列表并打开原聊天；同一对话最多属于一个任务，不关联也可照常使用。
- [x] 项目任务仅接受同项目对话，无项目任务仅接受无项目聊天；同项目不同 worktree 使用现有项目身份归并，Windows 路径大小写和分隔符不会产生错误跨项目判断。
- [x] 后端重新验证身份和范围；批量请求含非法、已属于别的任务或已删除对话时有明确结果，不造成重复归属或悄悄改绑。重复合法请求不增加重复关系。
- [x] 卡片显示真实关联数量及 AI 是否工作，详情呈现必要运行提示；Agent 开始、等待输入、失败、结束或声称完成均不自动修改任务状态。
- [x] 运行提示复用现有生命周期和轻量快照，不能把首个结束事件当作整轮队列停止；断线恢复和页面重开后能够重新校准。
- [x] 关联、浏览、打开详情不主动启动 Agent、不连接 MCP、不发模型请求；历史正文仅按需加载，不逐卡扫描全部 JSONL。
- [x] 关联独立持久化，刷新和重启后保持；不改来源历史、工具预设、模型、草稿或现有导航合同。
- [x] 临时真实 SDK 会话与合成历史验证项目、无项目、不同 worktree、批量冲突和运行状态；浏览器验证从聊天创建、批量关联、回到聊天和卡片提示，不调用真实模型。
- [x] 同步任务看板及受影响的会话、独立聊天、项目导航合同和回归测试，报告真实平台与模拟测试的区别。

## Scope and handoff

本票据只关联未归属对话，已归属其他任务的对话暂不迁移；10 提供带历史风险提示的解除和改绑。11 负责复制对话继承关系，08 负责从任务真正准备和发送新工作。共享资料只能从合法关联中选择，07 不能绕开本票据的范围检查。

不扫描内容自动聚类，不给任务身份增加工具权限，不把独立聊天强制变成 Chat-only。

## Spec coverage

用户故事：US5、US6、US8、US9、US10、US11、US12、US13、US27、US33、US34、US39、US60、US62、US64、US65。
访谈选择：Q02、Q05、Q09、Q10、Q14、Q25、Q29。
实现决策：D1、D2、D5、D10。
验收计划：T02、T09、T10、T21、T22、T24。

## Comments

2026-10-09（父验收）：04主v4集成及权威项目P2修复已独立复审，原缓存A→同路径B
跨项目关联复现现在拒绝且板字节不变；首次来源创建归B、已提交来源删除后重试仍正确。
独立主store12/12、04浏览器7/7及联合双草稿2/2通过，无新的具体阻断；父核对36增量及
主full2693pass/0fail/4skip、113focused、tsc/lint、14browser报告（/tmp/m04-MOJzzo/REPORT.md），
按票据范围验收resolved。保留06history/CAS、13列、03排序/receipt、02原身份，未把源onlyv3猜成主v3。
历史测试Git隔离事故和精确清理保留于TEST-ISOLATION.md，不宣称从未发生共享Git写入。
Windows/Safari真机/最低Node/生产分发/耐久平台仍未验证。本验收解锁05/07/08/11，不代表其已实现。

尚未实施或运行应用测试。阻塞票据须为 resolved 才可领取；失败或部分完成不得标记 resolved。

主集成领取（2026-10-09）：01/02/03/06/13 已父验收 resolved，全保护；04 只读来源29文件增量 SHA256 d77739039d7a9a849e08d22ca87e13bbe3c96207d6c6f078e860a382abbb6acd，不复制整树。主新 beforehash/快照与 fresh 日志在 /tmp/m04-MOJzzo；隔离 green 不当主通过。主统一 v4，v3 明确只指已有 columns/context 主格式，不发布猜测的源-only v3。独立 reviewer P2 缓存项目身份发现获父授权窄修：关联/首次来源创建 await 同规则 uncached 权威解析，原 sidebar SWR 与已提交来源指纹重试优先保留。验收框不勾，保持 claimed，待主独立复审及父验收。

主 fresh 验证完成：Darwin27 arm64/Node26，full2697tests/2693pass/0fail/4Windows skip，任务真实store/API与联合迁移63/63，扩大focused113/113，tsc/lint退出0。浏览器14脚本均exit0：04sessions7/7、01draft12/12、02details8/8、03order10/10及retry6/6、06context8/8、13columns7/7、cancel三语言3/3、基础board、项目/独立聊天/侧栏Git与非Git/键盘。新P2真实Git A缓存→同路径B、拒关联A不改board字节/revision/order、source首次归B与删源后fingerprint精确确认全部通过；联合v1/v2/main-v3→v4保留所有custom columns/history/internal receipts且关系空默认；跨功能retry不回拨。仅复用健康主30142 PIDs14934/14937，无服务动作/依赖配置/隔离源码写入/真实provider数据/commit/push/build。日志、env/时间/exit、before全hash/快照、主36文件精确增量（六新增）、patch/hash及冲突决定在/tmp/m04-MOJzzo/REPORT.md；原source green与事故记录不抹除不复用。保持claimed，不勾验收，主独立复审及父验收仍待完成。Windows/ACL/旧Safari真机/最低Node/生产安装/断电NFS/真实provider缺口保持。
