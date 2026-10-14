# 轮次版本记录:设计(规则⑤,v1 草案,2026-10-14)

> 给评审看的一页设计。电脑版规划 v3 第 4.1 节规则⑤要它同时承担三件事:**对比**(显示改动,含删除)、**历史**(每轮的原稿、完成稿、批注、处理结果对应到同一个轮次号)、**恢复**(退回第 N 轮改稿前,不删当前稿)。外加一条硬要求:**恢复产生新的版本身份,旧轮的手机批次即使正文相同也拒收**。设计定了再估工期。

## 1. 现状(核实过的事实)

| 东西 | 现在是什么样 |
|---|---|
| 会话记录 `~/.draftback/reviews.json` | 每轮一条:`id`(会话编号)、`docId`、`round`、`sourceHash`(交出时原稿指纹)、`finalHash`(完成稿指纹)、`summary`、`status / outcome`、`applyMode / applyActor`、`claimedAt / claimedBy`、各时间戳。**只有指纹,没有全文。** |
| 批注 `<文档>.md.annotations.json` | 所有轮次在同一个文件里;每条带 `reviewSessionId`(回稿页面保存时、手机批次导入时都写)、`status`(open / applied / wontfix / cancelled)、`appliedNote / appliedBy / appliedAt`。页面按 `reviewSessionId` 把历史批注分轮。 |
| 备份 | 普通编辑覆盖前留 10 份(`backups/documents/`);整体快照(索引 + 旁注文件)。**都不按轮次,也不含交出时的原稿。** |
| 手工改稿轮 | `round` 是字符串 `'manual-edit'`,不占轮次号;「我自己改」(ready_to_apply → applying/manual)占正常轮次号。 |
| 手机批次 | 带 `docId`、`baseVersion`(原稿指纹)、`reviewId`。Mac 导入时按 `docId` 找最新活动轮,只校验状态与指纹,**不校验 `reviewId`**。 |
| 同步 | complete 时把完成稿与 `summary` 推到手机;手机换新版前自己留一份旧正文做对比(手机侧,不在本设计内)。 |

## 2. 数据模型:每轮一个目录

```
~/.draftback/versions/<docId>/<reviewId>/
  original.md    交出时的原稿(全文,指纹 = 会话的 sourceHash)
  final.md       回来时的完成稿(全文,指纹 = 会话的 finalHash)
  meta.json      { docId, reviewId, round, kind, originalHash, finalHash, submittedAt, completedAt,
                   summary, applyMode, applyActor, annotations: [ { id, quote, comment, status, appliedNote } ] }
```

- `kind`:`agent`(AI 改)/ `manual`(我自己改)/ `approved`(零批注通过,只有 original,没有 final)/ `cancelled`(作废,只有 original)/ `superseded`(恢复时被换下来的当前稿,只有 final,见第 4 节)。
- `annotations` 是**处理结果的快照**:旁注文件以后还会变(新一轮、作废),历史里要看到"当时怎么处理的",所以 complete 时抄一份进 meta。
- 一篇文档只认 `docId`,不认路径;改名、移动后历史跟着走(现有规则)。
- **保留 10 轮**(用户已定):每篇文档超过 10 个版本目录时删最旧的(按 round 与时间),会话记录本身的 90 天清理不变。
- 不入版本记录的:普通编辑(没有会话,靠现有的 10 份覆盖备份)。

## 3. 什么时候写、写不成怎么办

| 时机 | 写什么 | 写不成 |
|---|---|---|
| 交出(submitReview 成功那一刻;此时文件指纹 = sourceHash,原文已冻结) | `original.md` | **不阻断交出**:记一条警告到会话(`versionWarning`),这一轮的「显示改动」和「恢复到本轮改稿前」不可用,界面说明"这轮没有留底"。理由:留底失败多半是磁盘问题,不该把用户的批注卡在交不出去。(请评审) |
| 完成(completeReview,agent 与 manual 都走) | `final.md` + `meta.json` | 同上,不阻断完成;回稿卡退化为只有摘要 |
| 零批注通过(approved) | `meta.json`(kind approved),`original.md` 若交出时已写 | — |
| 作废(unlock → cancelled) | `meta.json`(kind cancelled) | — |
| 旧会话(本设计上线前的轮次) | 不补造。接口返回 `available: false`,界面说"这轮没有留底(旧版本)" | — |

写法:先写临时文件再原子改名(沿用 `atomicWriteFile`),目录权限 0700。

## 4. 恢复到第 N 轮改稿前

**前提**:这篇文档当前没有活动会话(reviewing / ready_to_apply / applying / conflict 都不行;complete / cancelled 可以),且用户没在普通编辑中(编辑登记)。有活动会话时按钮置灰,提示"先把这一轮走完或作废"。(请评审:要不要允许在 reviewing 时恢复并自动作废当前轮?我倾向不允许,少一条隐式路径。)

**步骤**(一个事务内,任一步失败整体回滚、文件不动):

1. **当前稿先留底**:当前文件内容写成一个版本目录,`kind: superseded`,`final.md` = 当前内容,meta 记 `supersededBy: <新会话编号>`,`note: "恢复到第 N 轮改稿前时被换下"`。
2. **写回原稿**:把第 N 轮的 `original.md` 原子写回文档(覆盖前照样走 `backupBeforeOverwrite`,双保险)。
3. **新的版本身份**:新建一条会话记录,`status: complete`、`outcome: restored`、`round` = 下一个轮次号(例如第 4 轮)、`sourceHash = finalHash` = 原稿指纹、`restoredFrom: { reviewId, round: N }`、`summary: "已恢复到第 N 轮改稿前"`。它是 complete 态,所以没有活动会话;用户再划词批注就按现有逻辑开第 5 轮。
4. **历史不动**:旁注文件里各轮的批注与处理结果原样保留;版本目录也不删。
5. **推到手机**:按 complete 推(正文 = 原稿,summary 说明是恢复),手机换新正文;手机上旧轮次的批注因为轮次已推进不能再交(第 5 节)。

**为什么新建会话而不是改旧会话**:会话编号就是手机批次的身份,恢复必须换身份,否则第 5 节做不到。
**反悔**:第 1 步留下的 superseded 版本出现在历史列表里("第 N 轮恢复前的稿子"),可以再恢复到它。

## 5. 收批次时校验轮次身份

`importBatch` 找到会话后增加一条:**批次带 `reviewId` 且 ≠ 会话编号 → 拒收**,原因 `round-advanced`,回执文案"轮次已推进:这批批注对应第 N 轮,Mac 上已是第 M 轮,请在手机上打开最新一轮再提交"。指纹相同也拒。旧的文件导入批次没有 `reviewId`,维持现状(只校验指纹)。手机侧把这个原因显示出来(现有回执通道,不需要新字段)。

## 6. 显示改动(对比)

- **数据**:本轮 `original.md` 与 `final.md`;页面按需取(`GET /api/app/review/version?r=<会话>&which=original|final`),不塞进 bundle(300 章的大文档两份全文不该每次都带)。
- **算法**:先按块切分(沿用 markdown-patch 的块级切分,和保存时一致),块级做 LCS 对齐,改动块内再做字级对比(diff-match-patch,放 vendor,约 50 KB)。结果三种:新增、删除、替换;段落移动显示为"删旧 + 加新",不识别移动。
- **显示**:改过的块左边一道绿线;新增文字浅绿底;**删除的文字原位灰色删除线**(不是段末小字,原位才看得出删了什么);整段删除显示为一个灰色删除线的段落;表格单元格修改按单元格文字对比。
- **入口**:回稿卡上的「显示改动」开关(⇧⌘D),稿子回来时默认开;「上一处 / 下一处」在改动块之间跳。
- **性能目标**:300 章样本(约 6000 行)开关一次 ≤ 300 ms,超了就把字级对比限制在改动块内(本来就是)并按需渲染。

## 7. 回稿卡的数据

摘要(`summary`)、采纳 / 未采纳计数与逐条"你说了什么 / AI 怎么处理"(`meta.annotations`),加「显示改动」开关与上一处 / 下一处。都来自本设计的 meta,不再读旁注文件(旁注会变)。

## 8. 接口与命令

| 接口 | 作用 |
|---|---|
| `GET /api/app/review/versions?r=<会话>` | 这篇文档的历史:每轮 round、kind、时间、有无留底、summary、采纳计数 |
| `GET /api/app/review/version?r=<会话>&which=original\|final` | 取某一轮的全文 |
| `POST /api/app/review/restore` `{ r: <当前会话>, toReviewId }` | 恢复(第 4 节),返回新会话 |
| `mdreview versions <路径>` | 列历史(排查用) |
| `mdreview restore-round <路径> --to <轮次> --yes` | 命令行恢复(排查用;正常走界面) |

旁注文件格式、`mdreview` 现有命令、手机记录格式都不变;只给回执多一个 `reason` 值(`round-advanced`)。

## 9. 验收(测试要覆盖的场景)

1. 交出写 original;完成写 final + meta(含批注结果快照);零批注通过与作废各写对应 kind;写失败不阻断、会话带警告。
2. 第 11 轮产生时最旧的版本目录被清理;会话记录不受影响。
3. **三轮 + 恢复**:完成三轮 → 恢复到第二轮改稿前 → 文件 = 第二轮 original 逐字节一致;出现第 4 轮 `restored` 会话;当前稿留成 superseded 版本;各轮批注与处理结果不变;没有活动会话;手机收到新正文。
4. **旧批次拒收**:接着再批注交出(第 5 轮)→ 手机交回"第二轮"的批次(reviewId = 第二轮,baseVersion = 第二轮原稿指纹 = 当前指纹)→ 拒收 `round-advanced`,正文未改,回执到手机。
5. 显示改动:新增一句、删一句、改一个数字(替换)、整段删除、表格单元格修改,五例各自标对位置;300 章样本开关 ≤ 300 ms。
6. 旧会话没留底:接口 `available: false`,界面提示,不报错。
7. 有活动会话或编辑登记中:恢复被拒,文件不动。

## 10. 请评审重点看

1. 交出时留底失败**不阻断交出**(第 3 节)——还是应该阻断?
2. 恢复只允许在没有活动会话时(第 4 节)——够不够?有没有漏掉的状态?
3. 恢复 = 新建一条 complete/restored 会话(第 4 节第 3 步)——这个"新身份"的做法有没有副作用(同步、`mdreview wait` 跨轮语义、最近列表)?
4. 版本目录按 `reviewId` 命名、meta 存批注结果快照(第 2 节)——还有什么该进 meta 的?
5. 第 5 节只在批次带 `reviewId` 时校验——旧批次放行是否可接受?
6. 对比算法与显示(第 6 节)——首版这样够不够看出"删掉了什么"?
