# 轮次版本记录:设计(规则⑤,v4,2026-10-14)

> 给评审与产品负责人看的设计页。电脑版规划 v3 第 4.1 节规则⑤要它同时承担三件事:**对比**(显示改动,含删除)、**历史**(每轮的原稿、完成稿、批注、处理结果对应到同一个轮次号)、**恢复**(退回第 N 轮改稿前,不删当前稿)。外加一条硬要求:**恢复产生新的版本身份,旧轮的手机批次即使正文相同也拒收**。
>
> **v4 修订说明**:v3 经 Codex 第三轮审查,①②④⑥已闭合;补三处实质缺口:(a) 手机正文缓存绑定自己的身份与指纹,状态更新不得改挂正文身份,只有实际字节通过本轮指纹校验才能批注;(b) 批次导入的崩溃重放按持久化的导入记录补齐旁注、成员集、会话状态后再定稿原回执,不凭"旁注里有没有"判断;(c) 云端发布每次初读与冲突重读都比较业务 revision,旧发布跳过,补发历史不回退当前。另对齐四处措辞(发布失败≠归档失败;同步正文按事件表;批次协议字段统一为 `version: 2` 并真实传递;成员集贯穿所有处理提示与手工完成门槛)。Codex 认为余下都是实现注意项,**可以定稿开工**。
>
> **v3 修订说明**:v2 经 Codex 复审,"方向都对,但 6 组规则没闭合":① 恢复中断按前后指纹判定、幂等凭据、编辑登记进文档锁;② 归档分"载荷固化"与"发布"两步、事件规则表;③ 手机批注逐条身份成为上线门槛、导入结果与回执同一事务;④ 重关联贯穿所有读写、整体快照隔离在途事务;⑤ 云端发布用 revision + 条件写入;⑥ 本轮成员集贯穿交出—处理—完成—归档。另加两条首版范围限制(附件双清单、非 UTF-8 不同步正文)。本版逐条补齐,见各节加粗的「v3」。
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
- **v3 重关联要贯穿所有读写**:文档锁改为按 `docId` 加(路径只是解析结果);所有读写先经 `docId → currentPath` 解析,会话记录里的 `absPath` 只是缓存,重关联事务里一并更新会话 `absPath`、搬迁旁注文件、最近列表与界面的 `document.id`;重关联后对旧路径的请求返回 `DOCUMENT_MOVED`(不再读写旧路径);目标路径已属于另一个 `docId` → 拒绝;重关联与保存共用文档锁。迁移时保留现有有效 `docId`。
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
  memberAnnotationIds: [...],          交出时固定的本轮成员(见第 7.1 节;之后新加的留待下一轮)
  annotations: [ 完整字段快照:id, scope, quote, headingPath, anchor, author, createdAt, comment,
                 status, appliedBy, appliedAt, appliedNote, cancelReason ],
  assets: { original: [ { relPath, hash, bytes, state } ], final: [ ... ] },   冻结时与完成时各采一份清单(只记清单,不存文件;state = ok | missing)
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
| 交出(`submitReview`) | 实时读文件核对指纹 = sourceHash(冻结只是应用协议,照样校验),再核对 original 存在且指纹一致;固定 `memberAnnotationIds` 与输入快照;写 meta | **阻断交出**:批注已经在旁注文件里,不会丢;状态留在批注中,提示"留底失败,请重试交出"。不进入可改稿状态 |
| 终态(`completeReview` agent / manual、零批注通过、`unlock` 作废、重新打开时自动结束旧轮、启动清理取消)**统一走 `archiveTerminal(review)`,分两步** | **v3** 第一步「载荷固化」:在推进终态的同一事务里,先把完成稿字节与批注结果快照写进 `versions/<docId>/<versionId>/`(不可变);第二步「发布」:meta 定稿、文档索引更新、推送手机 | 第一步写不下 → **终态不推进**(`complete` 报错,状态不变,智能体重试 complete 即可,不用重做批注;期间阻止后续受控写入与开轮);第二步失败 → 会话已是终态,`archive-retry` 按 `docId/versionId` 只重试发布;回稿卡降级为只有摘要 |
| 旧会话(上线前的轮次) | 不补造;历史列表显示"未归档(旧版本)";手工改稿轮若在 `backups/` 里有当年的原始字节,迁移时搬进来标 `migrated` | — |

写法:先写临时文件再原子改名(`atomicWriteFile`),目录 0700;**直接复制 Buffer**,不经 UTF-8 字符串(非 UTF-8 文档只读,但留底仍要字节一致)。meta 写失败同样不能当作可靠补偿,所以所有降级都以"文件在不在、指纹对不对"为准,不以 meta 字段为准。

**v3 事件规则表**(每种事件的两份正文从哪来、同步推什么):

| kind | original | final | 同步推送的正文 |
|---|---|---|---|
| review(AI 改 / 我自己改) | 冻结时 | 完成时 | final |
| approved(零批注通过) | 冻结时 | 无 | original(就是当前稿) |
| cancelled(作废) | 冻结时 | 无 | 不推正文,只推状态 |
| manual(独立手工修改) | 第一次受控写入前 | 提交时 | final;**没有发生任何写入就提交 → 不产生事件**(撤掉 pending 目录) |
| restored(恢复) | 恢复前当前稿 | 恢复后稿 | final |
| 旧会话 / 发布失败 | 按实际有的 | 按实际有的 | 只推状态与摘要,**不拿实时工作稿冒充归档稿** |

## 5. 终态归档不可变;后续编辑是工作稿

- 终态会话的 `finalHash` 归档后**不再被后续写入改写**(改 document-service.js:252 的行为):complete / cancelled 之后用户普通编辑,产生的是"工作稿",不属于任何轮,走普通编辑的覆盖备份。
- 同步推送 complete / restored 时**从归档读正文**(`final.md`),不读实时文件;实时文件与归档不一致时,手机收到的是"这一轮的完成稿",摘要与正文一致。工作稿不推(手机只收轮次事件;要推工作稿就得开新一轮)。
- 迟到的保存(旧身份的写入)除指纹外还要校验最新身份。
- **v3 云端不回退**:事件序号之外,每次发布(批注中 → 已交出 → 回来了 → 已定稿都算)递增一个 `revision`,**在同一 `docId` 下跨轮单调**,记在会话 `sync.revision`;重试沿用原发布的 revision。Mac 写云记录改为**条件写入**(CloudKit 的 `ifServerRecordUnchanged`);**v4:条件写入只保证"没人在我读之后改过",不判断业务先后**——所以每次**初读与冲突重读都先比较 revision**:云端更新 → 本次发布作废跳过;相同 → 只确认是同一次发布,不重写;本地更新 → 才条件写入。手机拒绝 `revision` 更小的记录。整体恢复后 revision 高水位取 max(云端, 本地) + 1,再从那里续发,新身份不会被当成旧版本。
- **v4 补发历史不回退当前**:第 N 轮发布失败、第 N+1 轮已完成后再补发第 N 轮,只写历史事件,**不得回退文档索引的 `latestVersionId`,也不得覆盖云端当前记录**(云端当前记录只接受更大的 revision)。
- **v3 编码边界**:首版非 UTF-8(GBK / UTF-16)文档只在 Mac 留底原字节,**不同步正文**(手机只收状态);要同步正文得先定义编码传输与落盘校验。
- **v4 手机正文身份契约**(与"只同步状态"配套,否则手机会拿旧正文配新身份):手机本地的正文缓存**单独绑定它实际对应的会话身份与指纹**;只收到状态更新时,**不得把缓存正文改挂到新身份**;只有正文实际字节通过本轮指纹校验,才允许对本轮批注。不支持编码的新轮在手机上只显示状态;留着的旧正文按旧轮只读显示,不能批注。
- 同步推送的正文一律**按第 4 节事件表取**(approved 推 original,不是 final)。

## 6. 恢复到第 N 轮改稿前

**前提**(都在文档锁内核查):没有活动会话(reviewing / ready_to_apply / applying / conflict 都不行;complete / cancelled 可以);没有编辑登记——**v3:编辑登记改为在文档锁内登记**(现在只锁 editing.json,登记可以插在检查之后),恢复持锁期间登记被拒;没有未完成的源写入(先按现有 `pending → 写正文 → 完成记录` 机制收尾);请求带 `expectedCurrentHash`(= 用户看到的当前稿)与 `expectedLatestReviewId`,不一致就拒绝;目标版本的 `original.md` 存在且指纹对得上。保留"不自动作废 reviewing"的决定。

**步骤**(两阶段提交,`clientRequestId` 幂等):

1. 写恢复日志 `restores/<id>.json`:`{ clientRequestId, docId, toVersionId, beforeHash(当前稿), afterHash(目标原稿), newReviewId, newRound, newVersionId, stage: 'prepared' }`——身份与轮号在这一步分配并记入日志。
2. 新建版本事件目录(kind `restored`):`original.md` = 当前稿,`final.md` = 目标轮原稿(从归档复制),meta 带 `restoredFrom`;`stage: 'archived'`。
3. 原子写回文档(覆盖前照样走 `backupBeforeOverwrite`);`stage: 'written'`。
4. 会话索引新建一条:`status: complete`、`outcome: restored`、`round` = 日志里的 `newRound`、`sourceHash = finalHash` = 原稿指纹、`restoredFrom`、`summary: "已恢复到第 N 轮改稿前"`;**不复制**旧会话的 `applyMode / claimed*`;文档索引 `latestVersionId` 更新;`stage: 'committed'`;把结果写进 `restores/done/<clientRequestId>.json`(幂等凭据,保留 30 天),再删事务日志。
5. 推到手机(从归档读),失败重试;**同步失败不回滚本地恢复**。

**v3 中断恢复:按正文实际指纹判,不按阶段猜**。启动时扫描 `restores/`,读文件实际指纹:= `afterHash` → 正文已换,补齐后面所有步骤(会话索引、文档索引、凭据);= `beforeHash` → 正文没换,撤销并删事件目录;两者都不是 → **保留事务不动**,标 `conflict`,界面与 `mdreview status` 报"恢复事务与文件对不上,需要人工处理",不盲目覆盖也不删除。正文相同(目标原稿 = 当前稿)的恢复靠事务身份判定,不靠指纹。会话索引、文档索引分别落盘后中断的,同样按"文件已是 after 就补齐"处理。重放同一 `clientRequestId`:先查 `restores/done/`,有就返回原结果。
**承诺的措辞**:提交前失败不改正文;提交中断可恢复;同步失败不回滚本地恢复。(v1 的"任一步失败整体回滚"做不到,现有事务只有互斥锁。)
**反悔**:恢复事件的 `original.md` 就是恢复前的稿,"恢复到它"走同一条路。连续恢复、恢复后再恢复都是普通事件。
**界面与 wait**:`restored` 在状态区有专用文案「已恢复到第 N 轮改稿前」(不显示成"稿子回来了");`mdreview wait` 遇到它继续等(现有语义:complete 且非 approved / manual / finalized 即继续等,mdreview.js:401),并发一条 `review-restored` 事件。最近列表按路径合并,不多一条。

## 7. 收批次:必须有身份

- 同步来的批次必须带 `docId + reviewId + baseVersion`,**且每条批注自带创建身份 `{ docId, reviewId, baseVersion }` 并与批次外层一致**(批次协议字段 `version` 升到 `2`,手机真实写出、Mac 辅助程序原样传递,不在桥层硬填);缺任何一层身份一律拒收(`missing-identity`,回执文案「请更新手机上的回稿」)。**v3:这是上线门槛**——旧手机 App 会把旧轮批注打包成新轮外层身份,Mac 单靠外层校验挡不住,所以手机的批注记录加身份这一小步必须与本功能同批上线(合同层例外,见规划 v3 第 0 节)。旧的文件导入批次没有身份:不再按指纹放行,只提供显式入口 `mdreview import-batch <文件> --as-new-notes`,转换为**当前轮的新批注**(新 ID、新导入身份,保留来源批次号与原批注 ID),不冒充旧轮。
- 带 `docId` 时**禁止跨文档按指纹回退**:找不到就是 `no-session`。
- 顺序:先按 `reviewId` 对照**最新身份(含终态)**:不是最新一轮 → `round-advanced`(回执"轮次已推进:这批对应第 N 轮,Mac 已是第 M 轮,请在手机上打开最新一轮再提交");再判状态(`session-advanced`)、再判指纹(`version-mismatch`)。指纹相同也拒。
- 身份、状态、文件指纹、写批注、推进状态、**写回执**在同一把文档锁、同一个事务内完成(拆出锁内的提交函数,不再嵌套调用会再次加锁的 `submitReview`)。**v4 导入记录与崩溃重放**:动手之前先把**导入记录**落盘(`imports/<batchId>.json`:目标身份、输入批次、算好的 `acceptedIds / skippedIds`、阶段);旁注写入、成员集固定、会话状态推进、回执定稿各自推进阶段;会话记录里同时记下这个批次的提交凭据。同一批次再到达时,先查定稿回执——有就原样返回;只有导入记录的,**在文档锁内按记录补齐剩下的阶段(旁注、成员集、会话状态),最后定稿原回执**,`acceptedIds` 以记录为准不重算;**不凭"旁注里有没有这批批注"判断成功**(空批次、全部去重的批次本来就没有旁注证据;旁注已写但状态未推进也不算成功)。有未收敛的导入记录时,这篇文档不得推进到改稿或开新轮。
- 手机侧(**与本功能同批上线的最小改动**,写进跨端规则下一版):批注创建时固定 `{ docId, reviewId, baseVersion }`;打包按批注自身身份,不取当前会话;新轮到达后,旧轮未提交的批注**不自动改挂**到新轮,界面标「上一轮的批注」,用户显式「复制到本轮」才成为新批注(新 ID、本轮身份、保留来源);「重新发送」读原批次快照,不重新填身份。手机界面的其他改动仍按"电脑端做完再做手机"的顺序。

### 7.1 本轮成员集:一个集合贯穿交出、处理、完成、归档(**v3**)

- **交出时固定** `memberAnnotationIds`(= 旁注文件里此刻 `status=open` 且 `reviewSessionId` = 本轮的批注)并存输入快照。
- 之后一切都只看这个集合:智能体提示(「处理这 N 条」)、旁注文件里的 `_apply` 说明、AGENTS / 技能提示、完成门槛(`countOpen` 只数成员,不再数整份旁注文件)、界面「提交修改」按钮的门槛、回稿卡计数、归档快照。缺 `status` 的旧批注继续按 open 兼容。
- **迟到批注**(交出后新加的):留待下一轮,界面在这条批注上标「将进入下一轮」;开下一轮时它们成为新轮成员。
- **旧批注重新置 open**(用户在历史里「再提一次」):生成新 ID、归本轮、保留 `sourceAnnotationId`;不改旧记录的轮次归属。
- **交出前作废**:在作废事务里固定「当时的成员」(就是当时 open 的那些)写进 cancelled 事件;独立手工修改轮成员为空集合。

## 8. 显示改动(对比)

- **数据**:本轮事件的 `original.md` 与 `final.md`,按需取(`GET /api/app/version?docId=&versionId=&which=`),不塞进 bundle。
- **算法以源文为准,覆盖全部源文**:分块覆盖 Front Matter、块间空隙、引用链接定义;块相等以**源文字节**判断,不用渲染 HTML 的块身份;块级对齐用带上限的 LCS(超过上限按章节分段对齐再逐段 LCS),改动块内做字级对比(diff-match-patch,放 vendor)。代码块保留空白对比;表格按行列对齐,结构变了就显示旧表、新表;公式、Mermaid、复杂 HTML 退化为源码差异。结果三种:新增、删除、替换;移动显示为删旧加新。
- **显示:独立只读对比视图**(稿子回来时的回稿卡上「显示改动」打开它),不往批注用的正文里插删除线——批注锚点按正文字符偏移算,插了会污染下一轮坐标。视图里:改过的块左边绿线,新增浅绿底,删除原位灰色删除线,整段删除是一个删除线段落;「上一处 / 下一处」。要继续批注就关掉视图回到纯完成稿。
- **性能**:300 章样本首次计算 ≤ 300 ms、缓存后开关 ≤ 50 ms;计算放后台(Worker),结果按版本缓存;超上限的块退化为"整块替换"。

## 9. 回稿卡的数据

摘要、采纳 / 未采纳计数、逐条"你说了什么 / AI 怎么处理"都读本轮事件的 `meta.annotations`;meta 缺失或 `failed` 时从会话记录降级读摘要,并标明"这轮的处理记录没有归档",不伪装成完整历史。旧批注没有 `reviewSessionId` 的,归到"更早(未分轮)"。前端状态规则与服务端对齐(认 `cancelled`)。

## 10. 快照、附件、边界

- 整体快照纳入 `versions/`、`documents.json`、`restores/` 与校验清单;**v3:快照发布前先收敛在途事务**(持全局锁等 `restores/` 清空或取一致检查点,再复制);整体恢复时把快照里的 `restores/` **隔离到 `restores/imported/`,不进入启动重放队列**(只供排查);身份重建与整体恢复在同一个事务里提交,**重建当前身份**(不把新身份退回旧身份);同步的 revision 高水位按第 5 节处理。
- **v3 附件双清单**:`assets.original` 在冻结时采,`assets.final` 在完成时采;扫描含引用式图片(`![x][ref]`);缺失文件记 `state: missing` 而不是跳过。恢复 original 时对照 `assets.original`。
- 恢复只覆盖 `.md`;图片与附件按实时路径读。恢复后对照清单:缺失或变化的在界面提示「这轮引用的 N 个附件已变化,画面可能与当时不同」;不承诺恢复完整历史画面。
- 原始字节与编码:只读文档(GBK / UTF-16)同样留底,不转码。

## 11. 接口与命令

| 接口 / 命令 | 作用 |
|---|---|
| `GET /api/app/document/versions?docId=` | 历史事件列表:seq、round、kind、时间、文件状态、summary、采纳计数、restoredFrom |
| `GET /api/app/version?docId=&versionId=&which=original\|final` | 取某个事件的全文 |
| `POST /api/app/document/restore` `{ docId, toVersionId, expectedCurrentHash, expectedLatestReviewId, clientRequestId }` | 恢复(第 6 节),返回新会话 |
| `POST /api/app/document/archive-retry` `{ docId, versionId }` | 只重试发布(第二步),不指向路径,路径可能已进入新轮 |
| `mdreview versions <路径>`、`mdreview restore-round <路径> --to <轮次> --yes`、`mdreview archive-retry <路径>`、`mdreview relink <旧> <新>`、`mdreview import-batch <文件> --as-new-notes` | 命令行对应项(排查与智能体用) |

旁注文件格式不变(只是前端认全四种状态;重提的批注多 `sourceAnnotationId`);回执多两个 `reason`(`round-advanced`、`missing-identity`);批次协议 `version: 2`(逐条身份,全链路真实传递),手机记录加批注创建身份(与本功能同批上线)。

## 12. 验收(测试要覆盖的场景)

1. 冻结即留底:open 后 `original.md` 字节一致;留底失败 open 报错不建会话。
2. 交出核对留底;留底缺失时交出被拒、批注仍在、可重试;成员 ID 在交出时固定,之后新加的批注不算这轮。
3. 五种终态都归档(含重新打开自动结束、启动清理取消、提交前作废、独立手工修改轮);载荷固化失败终态不推进、**发布失败**会话照常终态、`archive-retry` 能补且不回退 `latestVersionId`。
4. 第 11 个事件产生时最旧的被清;活动轮与在途恢复不被清;会话 90 天清理后版本仍可按 `docId/versionId` 取到;**轮号不回退**。
5. **三轮 + 恢复**:完成三轮 → 恢复到第二轮改稿前 → 文件 = 第二轮 original 逐字节一致;出现第 4 轮 `restored` 会话;恢复事件 original = 恢复前稿;各轮批注与处理结果不变;没有活动会话;手机收到归档正文与恢复摘要;状态区专用文案;wait 继续等。
6. **旧批次拒收**:再批注交出(第 5 轮)→ 手机交回第二轮批次(reviewId = 第二轮,baseVersion = 当前指纹)→ `round-advanced`,正文未改,回执到手机;同指纹旧批注在手机上"重新打包"、人工"重新发送"都带原身份 → 同样拒收;缺身份 → `missing-identity`;`--as-new-notes` 导入成为本轮新批注。
7. 恢复每个落盘阶段中断(prepared / archived / written)后重启,按规则撤销或完成,文件与索引一致;`clientRequestId` 重放不重复恢复;`expectedCurrentHash` 不符拒绝;恢复期间插入的编辑登记被拒;连续恢复与反悔。
8. 终态后普通编辑不改 `finalHash`;complete / restored 推送内容 = 归档;云写入不回退。
9. 对比:新增一句、删一句、改一个数字、整段删除、表格单元格修改、**改引用链接 URL、改代码缩进**各自标对;公式 / Mermaid 退化为源码差异;300 章样本首次 ≤ 300 ms;**对比视图打开时划词 → 关闭回到完成稿 → 提交下一轮 → 重新打开仍准确定位**。
10. 旧会话未归档:列表标"未归档",取全文返回 `available: false`,不报错;作废批注在前端显示为作废。
11. 改名 / 移动受控重关联后 `docId` 不变、历史可见、旧路径请求返回 `DOCUMENT_MOVED`、目标路径属于别的文档时拒绝;复制产生新身份。
12. **v3** 恢复中断判定:三个阶段各自中断后,文件 = after 补齐、= before 撤销、都不是则报冲突且不动文件;同 `clientRequestId` 重放返回原结果;恢复持锁期间编辑登记被拒。
13. **v3** 完成时载荷写不下 → `complete` 失败、状态不变、重试成功;发布失败 → `archive-retry(docId, versionId)` 补上,即使路径已进入新轮。
14. **v3** 导入崩溃重放:批注已写、状态已推进、回执未定稿时重启,再收同一批次返回成功回执,手机不显示「未采用」;旧手机 App(schema 1)批次被拒并提示更新;`--as-new-notes` 产生新 ID 与来源。
15. **v3** 云端:同一事件的旧 revision 不能覆盖新 revision(Mac 条件写入冲突重读;手机拒旧);整体恢复后 revision 从高水位续发。
16. **v3** 成员集:交出后新加的批注不算本轮、不阻塞完成、进入下一轮;旧批注重提生成新 ID 归本轮;独立手工修改无写入不产生事件;approved 推 original。
17. **v3** 非 UTF-8 文档:Mac 留底字节一致,手机只收状态;附件双清单含引用式图片与缺失状态;整体快照导入的 `restores/` 不被重放。
18. **v4** 手机正文身份:手机缓存 UTF-8 稿 A → Mac 新轮为 GBK 稿 B 只推状态 → 手机显示 A 为旧轮只读,**不能对 B 批注**;正文字节通过本轮指纹后才能批注。
19. **v4** 导入重放:「旁注已写但状态未写」「空批次」「全部去重」三种情况下重启重放,都补齐到定稿回执,`acceptedIds` 与首次一致,手机不显示未采用;有未收敛导入记录时不能改稿或开新轮。
20. **v4** 云端顺序:旧 payload 在新发布之后才读云记录,也不能覆盖(初读比较 revision 跳过);同 revision 重试不重写;补发历史轮不动当前记录与 `latestVersionId`。

## 13. 已定的取舍(请产品负责人过目)

| 取舍 | 定法 | 理由 |
|---|---|---|
| 留底失败能不能交出 | **不能**(阻断,批注不丢,可重试) | 批注已保存,不需要用失去原稿来换"保住批注";没原稿就没有对比和恢复 |
| 有活动会话时能不能恢复 | **不能**,先走完或作废 | 少一条隐式路径 |
| 对比在哪看 | **独立只读视图**,不在批注正文里标删除 | 保住下一轮批注的定位精度 |
| 恢复附件吗 | **只恢复正文**,附件变化给提示 | 附件按路径读,恢复附件会动用户目录里的文件 |
| 旧批次没有身份怎么办 | **不放行**,只能显式转成本轮新批注 | 这是规则⑤的硬要求,放行就等于没做 |
| 保留多少 | **10 个事件**(含恢复事件),按提交成功后清理 | 用户定的"10 轮",按事件计更直观 |
| 手机要不要同批改 | **要,只改一小步**:批注记录加创建身份、打包用它 | 不改,旧 App 能把旧轮批注伪装成新轮,规则⑤的硬要求就守不住;其余手机界面仍放后面 |
| 非 UTF-8 文档 | **首版不同步正文**,只在 Mac 留底 | 跨端编码传输没定义前,同步会出现正文变了指纹没变 |

**实现时的注意项**(Codex 第三轮列出,不阻塞定稿):同指纹恢复要结合事务身份与归档完整性判定;整体恢复不能只套互斥锁,要覆盖中断重放并保住轮号与 revision 高水位(现 snapshot.js 逐文件恢复);批次协议字段 `version` 要从手机一路真实传到 Mac(现 SyncLoop.swift 桥层硬编码 `version: 1`);成员集改动要同时落到 `_apply` 说明、AGENTS/技能提示、手工完成按钮。

工期:设计定稿后按第 12 节 20 项验收估,分三段交付——身份层与留底(含归档两步、成员集)→ 恢复与收批次(含手机那一小步与导入记录)→ 对比视图与回稿卡。
