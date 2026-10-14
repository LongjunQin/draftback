# 轮次版本记录:设计(规则⑤,v2,2026-10-14)

> 给评审与产品负责人看的设计页。电脑版规划 v3 第 4.1 节规则⑤要它同时承担三件事:**对比**(显示改动,含删除)、**历史**(每轮的原稿、完成稿、批注、处理结果对应到同一个轮次号)、**恢复**(退回第 N 轮改稿前,不删当前稿)。外加一条硬要求:**恢复产生新的版本身份,旧轮的手机批次即使正文相同也拒收**。
>
> **v2 修订说明**:v1 经 Codex(gpt-6-astra,只读审查、对照代码)评审,结论"暂不宜定稿",11 条意见全部核实成立,本版逐条采纳。最大的改动:① 增加独立的**文档身份层**(不再靠会话数量编轮号、不随 90 天清理失联);② 留底时机提前到**冻结时**并统一所有终态入口,留底失败**阻断交出**;③ 恢复改成**一个版本事件**(原稿 = 恢复前当前稿,完成稿 = 恢复后稿),走两阶段提交,可中断恢复;④ 终态归档**不可变**,后续普通编辑是工作稿,同步从归档读;⑤ 收批次**必须有身份**,无身份只能走"转为新批注";手机侧批注创建时就固定身份;⑥ 对比用**独立只读视图**、按源文全覆盖,不再沿用渲染 HTML 的块身份。

## 1. 现状(核实过的事实,含 v1 写错的两处)

| 东西 | 现在是什么样 |
|---|---|
| 会话记录 `~/.draftback/reviews.json` | 每轮一条:`id`、`docId`、`round`、`sourceHash`(冻结时原稿指纹)、`finalHash`、`summary`、`status / outcome`、`applyMode / applyActor`、`claimedAt / claimedBy`、各时间戳。只有指纹,没有全文。**轮号 = 同路径现存记录数 + 1**(review-store.js:473):改名、移动会换 `docId`;启动清理会删掉文件已不存在的终态记录与 90 天前的终态记录,轮号可能重号、身份可能重建。 |
| 批注 `<文档>.md.annotations.json` | 所有轮次同一个文件;每条带 `reviewSessionId`、`status`(open / applied / wontfix / cancelled)、`appliedNote / appliedBy / appliedAt`、`scope`、`headingPath`、锚点。**前端把 `cancelled` 当成 `open`**(desktop-anchor.js:21 只认三种),作废批注显示不对——本设计顺手修。 |
| 备份 | 普通编辑覆盖前留 10 份;**手工改稿轮在第一次受控写入前按 `review.id` 存了原始字节**(document-service.js:168),但不是每轮都有;整体快照复制索引、旁注与 `backups/`。(v1 说"都不含原稿"不对。) |
| 终态会话仍可被写 | `complete / cancelled` 的会话允许继续写源文件,并**改写它的 `finalHash`**(document-service.js:11、252)。所以"文件指纹 = 会话 finalHash"只在完成那一刻成立。 |
| 独立手工修改轮 | `beginManualEdit` 直接建 `applying/manual` 记录,`round: 'manual-edit'`,**没有 `docId`**,不经过交出。 |
| 手机批次 | 带 `docId`、`baseVersion`、`reviewId`。Mac 导入按 `docId` 找最新活动轮,找不到就**退回全库按指纹匹配**(batches.js:67),只校验状态与指纹,不校验 `reviewId`;写批注与提交不在同一把文档锁里。 |
| 手机侧批注 | **只按正文指纹判断归属**(Models.swift:23);创建时只存 `baseVersion`,提交时取**当前**会话编号(DocumentStore.swift:363)。新版到达直接覆盖本地正文,没有旧稿副本(CloudSync.swift:209)。 |
| 同步 | 终态会话推送时读**实时**文件(今天刚改的:指纹不一致也按实际正文推)。Mac 云写入覆盖同 `docId` 记录,没有版本先后检查。 |
| 对比的现成件 | markdown-patch.js 的块身份 = 渲染 HTML 压掉空白(:37),只取顶层 token;**改引用链接 URL、改代码缩进都判为"未变化"**(评审实测)。LCS 分配完整矩阵。 |

## 2. 文档身份层(新)

`~/.draftback/documents.json`:`{ [docId]: { currentPath, nextRound, nextVersionSeq, latestVersionId, createdAt, movedFrom: [] } }`

- **轮号单调**:开轮从 `nextRound` 取并自增,不再数记录;90 天清理、文件不存在清理都不影响。
- **改名 / 移动**:走受控重新关联(`mdreview relink <旧路径> <新路径>` 或 App 里打开时发现同 `docId` 记录指向不存在的旧路径且新路径内容指纹一致 → 提示确认),保留身份;**复制**明确产生新身份,相同正文不自动合并。
- 独立手工修改轮也分配 `docId`(没有就建),进历史。
- 会话记录加 `docId` 以后不再变;版本接口**按 `docId / versionId` 寻址**,不依赖会话是否还在。
- 迁移:首次启动扫描现有会话,按 `absPath` 归并生成文档索引,`nextRound` = 现存最大轮号 + 1。

## 3. 数据模型:每个版本事件一个目录

```
~/.draftback/versions/<docId>/<versionId>/      versionId = 两位序号 + 事件类型 + 会话编号,例 0007-review-r3f2…
  original.md    事件开始时的全文(原始字节,不经字符串转换)
  final.md       事件结束时的全文(同上)
  meta.json      见下
```

`meta.json`(带 `schema: 1`):

```
{ docId, versionId, seq, round, kind, reviewId,
  files: { original: { hash, bytes, state }, final: { hash, bytes, state } },   state = archived | missing | failed | corrupt
  startedAt, completedAt, summary, applyMode, applyActor, claimedBy,
  restoredFrom: { versionId, round } | null,
  memberAnnotationIds: [...],          冻结时固定的本轮成员(交出时固定,之后新加的不算这轮)
  annotations: [ 完整字段快照:id, scope, quote, headingPath, anchor, author, createdAt, comment,
                 status, appliedBy, appliedAt, appliedNote, cancelReason ],
  assets: [ { relPath, hash, bytes } ],   文档引用的本地图片与附件清单(只记清单,不存文件)
  sourceEncoding }
```

- `kind`:`review`(AI 改或我自己改的一轮:original = 冻结时原稿,final = 完成稿)/ `approved`(零批注通过:只有 original)/ `cancelled`(作废:只有 original)/ `manual`(独立手工修改轮:original = 第一次写入前,final = 提交时)/ `restored`(恢复事件:**original = 恢复前的当前稿,final = 恢复后的稿**,带 `restoredFrom`)。
- 每轮的三样东西靠 `reviewId` + `round` 对应;恢复事件也占一个轮号(第 4 节)。
- **保留 10 个用户可见事件**(用户已定的"10 轮"按事件数计):提交成功后才清理最旧的;活动轮与在途事务依赖的目录不删。会话记录的 90 天清理不变,但清理会话不动版本目录。
- 不入版本记录的:没有会话的普通编辑(靠现有 10 份覆盖备份)。

## 4. 什么时候写、写不成怎么办

**原则:原稿在冻结那一刻就捕获;进入可改稿状态前必须确认原稿完整;终态统一归档入口。**

| 时机 | 做什么 | 失败时 |
|---|---|---|
| 冻结(`openReview` 新建会话;独立手工修改轮在第一次受控写入前) | 捕获 `original.md`(原始字节)+ 最小 meta(`state` 先记 `pending`) | open 失败并给出原因(磁盘)。智能体看到错误会重试;用户侧提示"没能留底,稍后再试"。宁可不冻结,也不留一个没底的轮次 |
| 交出(`submitReview`) | 核对 original 存在且指纹 = sourceHash(文件冻结着,指纹必然一致);固定 `memberAnnotationIds`;写 meta | **阻断交出**:批注已经在旁注文件里,不会丢;状态留在批注中,提示"留底失败,请重试交出"。不进入可改稿状态 |
| 终态(`completeReview` agent / manual、零批注通过、`unlock` 作废、重新打开时自动结束旧轮、启动清理取消)**统一走 `archiveTerminal(review)`** | 写 `final.md`(有完成稿的 kind)、meta 的批注结果快照、`assets` 清单 | 归档失败:会话照常进入终态(不能让智能体重做批注),meta 的 `files.final.state = failed`,提供**只重试归档**的入口(`mdreview archive-retry <路径>` 与界面提示);回稿卡降级为只有摘要 |
| 旧会话(上线前的轮次) | 不补造;历史列表显示"未归档(旧版本)";手工改稿轮若在 `backups/` 里有当年的原始字节,迁移时搬进来标 `migrated` | — |

写法:先写临时文件再原子改名(`atomicWriteFile`),目录 0700;**直接复制 Buffer**,不经 UTF-8 字符串(非 UTF-8 文档只读,但留底仍要字节一致)。meta 写失败同样不能当作可靠补偿,所以所有降级都以"文件在不在、指纹对不对"为准,不以 meta 字段为准。

## 5. 终态归档不可变;后续编辑是工作稿

- 终态会话的 `finalHash` 归档后**不再被后续写入改写**(改 document-service.js:252 的行为):complete / cancelled 之后用户普通编辑,产生的是"工作稿",不属于任何轮,走普通编辑的覆盖备份。
- 同步推送 complete / restored 时**从归档读正文**(`final.md`),不读实时文件;实时文件与归档不一致时,手机收到的是"这一轮的完成稿",摘要与正文一致。工作稿不推(手机只收轮次事件;要推工作稿就得开新一轮)。
- 迟到的保存(旧身份的写入)除指纹外还要校验最新身份;Mac 云写入带 `versionSeq`,不写回比云端更旧的记录。

## 6. 恢复到第 N 轮改稿前

**前提**(都在文档锁内核查):没有活动会话(reviewing / ready_to_apply / applying / conflict 都不行;complete / cancelled 可以);没有编辑登记;没有未完成的源写入(先按现有 `pending → 写正文 → 完成记录` 机制收尾);请求带 `expectedCurrentHash`(= 用户看到的当前稿)与 `expectedLatestReviewId`,不一致就拒绝;目标版本的 `original.md` 存在且指纹对得上。保留"不自动作废 reviewing"的决定。

**步骤**(两阶段提交,`clientRequestId` 幂等):

1. 写恢复日志 `restores/<id>.json`:`{ docId, toVersionId, currentHash, newReviewId, newVersionId, stage: 'prepared' }`。
2. 新建版本事件目录(kind `restored`):`original.md` = 当前稿,`final.md` = 目标轮原稿(从归档复制),meta 带 `restoredFrom`;`stage: 'archived'`。
3. 原子写回文档(覆盖前照样走 `backupBeforeOverwrite`);`stage: 'written'`。
4. 会话索引新建一条:`status: complete`、`outcome: restored`、`round` 从文档索引取(例如第 4 轮)、`sourceHash = finalHash` = 原稿指纹、`restoredFrom`、`summary: "已恢复到第 N 轮改稿前"`;**不复制**旧会话的 `applyMode / claimed*`;文档索引 `latestVersionId` 更新;`stage: 'committed'`,删日志。
5. 推到手机(从归档读),失败重试;**同步失败不回滚本地恢复**。

**中断恢复**:启动时扫描 `restores/`,按 `stage` 与文件实际指纹决定是继续完成还是撤销(`written` 之后一律继续完成;之前一律撤销并删目录)。
**承诺的措辞**:提交前失败不改正文;提交中断可恢复;同步失败不回滚本地恢复。(v1 的"任一步失败整体回滚"做不到,现有事务只有互斥锁。)
**反悔**:恢复事件的 `original.md` 就是恢复前的稿,"恢复到它"走同一条路。连续恢复、恢复后再恢复都是普通事件。
**界面与 wait**:`restored` 在状态区有专用文案「已恢复到第 N 轮改稿前」(不显示成"稿子回来了");`mdreview wait` 遇到它继续等(现有语义:complete 且非 approved / manual / finalized 即继续等,mdreview.js:401),并发一条 `review-restored` 事件。最近列表按路径合并,不多一条。

## 7. 收批次:必须有身份

- 同步来的批次必须带 `docId + reviewId + baseVersion`;**缺身份一律拒收**(`missing-identity`)。旧的文件导入批次没有身份:不再按指纹放行,只提供显式入口 `mdreview import-batch <文件> --as-new-notes`,把它转换为**当前轮的新批注**(保留来源批次号),不冒充旧轮。
- 带 `docId` 时**禁止跨文档按指纹回退**:找不到就是 `no-session`。
- 顺序:先按 `reviewId` 对照**最新身份(含终态)**:不是最新一轮 → `round-advanced`(回执"轮次已推进:这批对应第 N 轮,Mac 已是第 M 轮,请在手机上打开最新一轮再提交");再判状态(`session-advanced`)、再判指纹(`version-mismatch`)。指纹相同也拒。
- 身份、状态、文件指纹、写批注、推进状态**在同一把文档锁内**完成:拆出锁内的提交函数,不再嵌套调用会再次加锁的 `submitReview`。
- 手机侧(属于手机阶段的工作,但规则现在定下,写进跨端规则下一版):批注创建时固定 `{ docId, reviewId, baseVersion }`;提交按批注自身身份,不取当前会话;新轮到达后,旧轮未提交的批注**不自动改挂**到新轮,界面标"上一轮的批注",用户显式"复制到本轮"才成为新批注;"重新发送"读原批次快照,不重新填身份。

## 8. 显示改动(对比)

- **数据**:本轮事件的 `original.md` 与 `final.md`,按需取(`GET /api/app/version?docId=&versionId=&which=`),不塞进 bundle。
- **算法以源文为准,覆盖全部源文**:分块覆盖 Front Matter、块间空隙、引用链接定义;块相等以**源文字节**判断,不用渲染 HTML 的块身份;块级对齐用带上限的 LCS(超过上限按章节分段对齐再逐段 LCS),改动块内做字级对比(diff-match-patch,放 vendor)。代码块保留空白对比;表格按行列对齐,结构变了就显示旧表、新表;公式、Mermaid、复杂 HTML 退化为源码差异。结果三种:新增、删除、替换;移动显示为删旧加新。
- **显示:独立只读对比视图**(稿子回来时的回稿卡上「显示改动」打开它),不往批注用的正文里插删除线——批注锚点按正文字符偏移算,插了会污染下一轮坐标。视图里:改过的块左边绿线,新增浅绿底,删除原位灰色删除线,整段删除是一个删除线段落;「上一处 / 下一处」。要继续批注就关掉视图回到纯完成稿。
- **性能**:300 章样本首次计算 ≤ 300 ms、缓存后开关 ≤ 50 ms;计算放后台(Worker),结果按版本缓存;超上限的块退化为"整块替换"。

## 9. 回稿卡的数据

摘要、采纳 / 未采纳计数、逐条"你说了什么 / AI 怎么处理"都读本轮事件的 `meta.annotations`;meta 缺失或 `failed` 时从会话记录降级读摘要,并标明"这轮的处理记录没有归档",不伪装成完整历史。旧批注没有 `reviewSessionId` 的,归到"更早(未分轮)"。前端状态规则与服务端对齐(认 `cancelled`)。

## 10. 快照、附件、边界

- 整体快照纳入 `versions/`、`documents.json`、`restores/` 与校验清单;整体恢复后**重建当前身份**(不把新身份退回旧身份)。
- 恢复只覆盖 `.md`;图片与附件按实时路径读。meta 记 `assets` 清单与指纹,恢复后对照当前文件:缺失或变化的在界面提示"这轮引用的 N 个附件已变化,画面可能与当时不同";不承诺恢复完整历史画面。
- 原始字节与编码:只读文档(GBK / UTF-16)同样留底,不转码。

## 11. 接口与命令

| 接口 / 命令 | 作用 |
|---|---|
| `GET /api/app/document/versions?docId=` | 历史事件列表:seq、round、kind、时间、文件状态、summary、采纳计数、restoredFrom |
| `GET /api/app/version?docId=&versionId=&which=original\|final` | 取某个事件的全文 |
| `POST /api/app/document/restore` `{ docId, toVersionId, expectedCurrentHash, expectedLatestReviewId, clientRequestId }` | 恢复(第 6 节),返回新会话 |
| `POST /api/app/document/archive-retry` `{ r }` | 只重试归档 |
| `mdreview versions <路径>`、`mdreview restore-round <路径> --to <轮次> --yes`、`mdreview archive-retry <路径>`、`mdreview relink <旧> <新>`、`mdreview import-batch <文件> --as-new-notes` | 命令行对应项(排查与智能体用) |

旁注文件格式不变(只是前端认全四种状态);回执多两个 `reason`(`round-advanced`、`missing-identity`);手机记录格式加批注的 `reviewId`(手机阶段做)。

## 12. 验收(测试要覆盖的场景)

1. 冻结即留底:open 后 `original.md` 字节一致;留底失败 open 报错不建会话。
2. 交出核对留底;留底缺失时交出被拒、批注仍在、可重试;成员 ID 在交出时固定,之后新加的批注不算这轮。
3. 五种终态都归档(含重新打开自动结束、启动清理取消、提交前作废、独立手工修改轮);归档失败会话照常终态、`archive-retry` 能补。
4. 第 11 个事件产生时最旧的被清;活动轮与在途恢复不被清;会话 90 天清理后版本仍可按 `docId/versionId` 取到;**轮号不回退**。
5. **三轮 + 恢复**:完成三轮 → 恢复到第二轮改稿前 → 文件 = 第二轮 original 逐字节一致;出现第 4 轮 `restored` 会话;恢复事件 original = 恢复前稿;各轮批注与处理结果不变;没有活动会话;手机收到归档正文与恢复摘要;状态区专用文案;wait 继续等。
6. **旧批次拒收**:再批注交出(第 5 轮)→ 手机交回第二轮批次(reviewId = 第二轮,baseVersion = 当前指纹)→ `round-advanced`,正文未改,回执到手机;同指纹旧批注在手机上"重新打包"、人工"重新发送"都带原身份 → 同样拒收;缺身份 → `missing-identity`;`--as-new-notes` 导入成为本轮新批注。
7. 恢复每个落盘阶段中断(prepared / archived / written)后重启,按规则撤销或完成,文件与索引一致;`clientRequestId` 重放不重复恢复;`expectedCurrentHash` 不符拒绝;恢复期间插入的编辑登记被拒;连续恢复与反悔。
8. 终态后普通编辑不改 `finalHash`;complete / restored 推送内容 = 归档;云写入不回退。
9. 对比:新增一句、删一句、改一个数字、整段删除、表格单元格修改、**改引用链接 URL、改代码缩进**各自标对;公式 / Mermaid 退化为源码差异;300 章样本首次 ≤ 300 ms;**对比视图打开时划词 → 关闭回到完成稿 → 提交下一轮 → 重新打开仍准确定位**。
10. 旧会话未归档:列表标"未归档",取全文返回 `available: false`,不报错;作废批注在前端显示为作废。
11. 改名 / 移动受控重关联后 `docId` 不变、历史可见;复制产生新身份。

## 13. 已定的取舍(请产品负责人过目)

| 取舍 | 定法 | 理由 |
|---|---|---|
| 留底失败能不能交出 | **不能**(阻断,批注不丢,可重试) | 批注已保存,不需要用失去原稿来换"保住批注";没原稿就没有对比和恢复 |
| 有活动会话时能不能恢复 | **不能**,先走完或作废 | 少一条隐式路径 |
| 对比在哪看 | **独立只读视图**,不在批注正文里标删除 | 保住下一轮批注的定位精度 |
| 恢复附件吗 | **只恢复正文**,附件变化给提示 | 附件按路径读,恢复附件会动用户目录里的文件 |
| 旧批次没有身份怎么办 | **不放行**,只能显式转成本轮新批注 | 这是规则⑤的硬要求,放行就等于没做 |
| 保留多少 | **10 个事件**(含恢复事件),按提交成功后清理 | 用户定的"10 轮",按事件计更直观 |

工期:设计定稿后按第 12 节 11 项验收估,分三段交付——身份层与留底(含归档)→ 恢复与收批次 → 对比视图与回稿卡。
