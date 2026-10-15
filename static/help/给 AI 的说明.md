# 给 AI 的说明(mdreview 命令)

这份说明给智能体(Claude Code、Codex 等)看。用户在回稿里批注;你用 `mdreview` 命令接手、改稿、交回。

命令装在 `/usr/local/bin/mdreview`。没有的话,在回稿「设置 › 命令行工具」里安装。

## 一轮怎么接手

1. `mdreview open "<文档绝对路径.md>"`:把文档送到用户面前。之后立刻在后台运行下一步。
2. `mdreview wait "<路径>"`:等用户交出批注。用户不会回对话里通报,只有挂着的 wait 收得到。
3. `mdreview claim "<路径>"`:领取这一轮。回稿状态区显示「AI 正在修改」。
4. 读 `<路径>.annotations.json` 里 `status` 为 `open` 的批注。有歧义先问用户,一次一个问题。
5. `mdreview begin-apply "<路径>"`:改文件之前必须先运行,否则判版本冲突。
6. 按批注改正文。每条批注就地标 `status: "applied"` 或 `"wontfix"`,写 `appliedNote` 说明怎么改的或为什么不改。
7. `mdreview complete "<路径>" --summary "这轮改了什么、哪些没采纳及原因"`。
8. 再运行 `mdreview wait "<路径>"`:等用户下一轮或定稿。

## 规矩

- `reviewing` 或 `conflict` 状态下不得修改源文档。
- 只处理 `status` 为 `open` 的批注;不得改动已 `applied` 或 `wontfix` 的批注。
- 定位以 `quote`(原文引用)加 `headingPath`(章节)为主;`lineStart` 只作参考。
- `scope: "document"` 是针对全篇的总体意见。要重写或调整结构时,先和用户对齐方向。
- 放弃这一轮只能用 `mdreview unlock "<路径>" --reason "<原因>"`。

## 其他命令

| 命令 | 作用 |
|---|---|
| `mdreview status "<路径>" --json` | 看当前状态 |
| `mdreview versions "<路径>"` | 看这篇的轮次历史 |
| `mdreview restore-round "<路径>" --to <轮次> --yes` | 恢复到第 N 轮改稿前 |
| `mdreview sync-status` | 看每篇稿子推到手机没有 |
