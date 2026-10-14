# 回稿进阶手册

面向 Agent 编排者、高级用户与贡献者。日常使用看 [README](../README.md) 就够了。

## 架构与入口

`draftback-service` 是回稿复用的本地审阅服务与 CLI。批注保存在文档旁的
`<文档.md>.annotations.json`：

```text
Agent 生成 MD → mdreview open → 回稿冻结审阅 → Agent 应用批注 → mdreview complete → 回稿自动刷新
```

## 电脑本地审阅

```bash
mdreview open "/绝对路径/方案.md"
```

`mdreview open` 会创建或复用该文件的审阅会话、记录 SHA-256 版本指纹，并把文档打开到已安装的回稿。未安装回稿时命令会报错并给出安装指引（会话仍已创建，安装后重跑即可）。`--no-open` 只创建或复用会话，不唤起 App。

服务由回稿启动时自动拉起、退出时带走，只监听 `127.0.0.1` loopback，不经过任何公网。

页面始终在正文上方显示当前状态：

```text
审阅中 · 原文已锁定        可阅读和批注，不能改原文
等待修改 · 批注已提交      已停止批注，等待 Agent 或手工处理
Agent 修改中 · 文档暂时只读  Agent 正在改稿，完成后自动刷新
手工修改中 · 请逐条处理批注  你正在编辑，需将未处理批注清零
修改已完成 · 已加载最新版    本轮结束，可开始下一轮
版本冲突 · 已停止写入        源文件在冻结期间变化，需先处理冲突
```

底层审阅状态仍为 `reviewing → ready_to_apply → applying → complete`；
`applying` 会根据 `applyMode` 在界面上分成“Agent 修改中”和“手工修改中”。
`conflict` 是版本冲突停写，`cancelled` 是人工取消本轮。

源文档在 `reviewing` 期间发生变化时，会话立即进入 `conflict`，旧版本批注不再写入。关闭窗口或标签不会自动解锁。

冲突会话可以自愈：再次 `mdreview open` 时，若旧一轮批注已全部处理（没有 `open`），
会自动结束冲突会话并按当前内容开启新一轮——典型场景是 Agent 改完了稿但漏跑
`begin-apply`/`complete`。仍有未处理批注时维持冲突保护，需人工 `mdreview unlock` 决断。

审阅中的未处理批注可以在批注列表里继续“编辑”或“删除”；点击“完成本轮审阅”后页面只读。

一轮改稿完成（`complete`）后，标题栏出现「定稿并关闭」：确认这版就是终稿，会话记为
`finalized`，正在 `wait` 的 Agent 收到“审阅结束”，标签页随即关闭。此时若改为进入「编辑」，
App 会直接开一轮 `applying/manual` 的手工修改轮，把写者身份记进会话——Agent 此时
`mdreview open` 会得到“用户正在手工修改”的提示而不会把文档重新冻结、把你踢出编辑器；
你点「提交修改」后该轮结束。**任何时刻一篇文档只有一个写者**是整个状态机的不变量。
跨段选择会记录完整起止行，并高亮覆盖的全部段落；旧版本已经保存成错误单行范围的长批注，
页面也会根据引用正文做兼容显示，但不会偷偷改写历史 sidecar。

Agent 执行 `mdreview complete` 后会主动通知正在运行的回稿，不需要高频轮询。
前端仅保留 60 秒一次的轻量状态核对，用于 App 断网、睡眠或错过事件后的容错；
它不会定时重载整篇正文。未保存草稿存在时，远程更新会被挂起而不是覆盖草稿。

常用恢复/Agent 命令：

```bash
mdreview status "/绝对路径/方案.md" --json
mdreview wait "/绝对路径/方案.md" --timeout-minutes 480
mdreview begin-apply "/绝对路径/方案.md"
mdreview complete "/绝对路径/方案.md"
mdreview unlock "/绝对路径/方案.md" --reason "放弃本轮审阅"
```

## 按批注改稿（Agent 协议）

`mdreview` 每一步命令的输出末尾都会以 `→` 给出 Agent 下一步该做什么（open 提示挂
wait、wait 退出提示读批注并 begin-apply、begin-apply 提示标 applied/wontfix 后
complete）。从未读过本文档的 Agent 只要从 `mdreview open` 进入并照每步输出走，
即可完整走完 打开 → 等待 → 改稿 → 完成 全流程；下文是完整协议说明。

本地冻结审阅必须先由用户点击「交给 AI」（⌘↩）。推荐 Agent 在 `mdreview open` 之后立即
后台运行 `mdreview wait`：命令会一直阻塞到用户有下一个动作才退出（退出码
0=批注已提交 / 全文通过 / 已定稿 / 用户手工改完 / 别处已开始改稿；2=冲突/取消/会话丢失；
3=超时，默认 480 分钟，可 `--timeout-minutes` 调整）。命令退出即等于用户通报“批注完了”，
用户不需要回到对话里再说一遍。

`wait` 是**跨轮**的：它不会因为启动时已处于的状态而退出。上一轮 `complete` 之后再挂一次
`wait`，它会一直等到用户在 App 里再批注一轮并交出、或点「通过 · 定稿」。因此
Agent 的节奏固定为：`open` → 挂 `wait` → 改稿 → `complete` → 再挂 `wait` …… 直到 `wait`
报告“用户已定稿”。Agent 随后：

1. 运行 `mdreview status`，确认状态（用了 wait 且退出码为 0 可跳过）；
2. 读取 sidecar 中 `status=open` 的批注，对有歧义的先向用户提问确认；
3. `ready_to_apply` 时先 `mdreview claim`（可省，`begin-apply` 也算领取），再运行 `mdreview begin-apply`；
4. 逐条改稿，以 `quote + headingPath` 定位，标记 `applied/wontfix`，保留审计字段。
   带 `scope: "document"` 的批注是**总体意见**（针对全篇，无文字锚点）——若它要求重写、
   调整架构或先讨论，先与用户对齐方向再动笔，闭环方式相同；
5. 全部 open 清零后运行 `mdreview complete`，再挂一次 `mdreview wait` 等下一轮或定稿。

没有审阅会话的旧 sidecar 继续遵守原有 `open → applied/wontfix` 协议。

### 接手路径：在听与领取分开记（2026-10-14 起）

用户交出批注后，回稿的状态区要能回答"有没有 AI 接手"。这件事分两层记（电脑版规划 v3 规则②）：

| 层 | 怎么记 | 含义 |
|---|---|---|
| 监听登记 | `mdreview wait` 启动时登记到数据目录的 `listeners.json`，每 30 秒续期，90 秒没续期自动失效；wait 因用户交出而返回时转为「已交棒」（15 分钟内仍算在线） | 只说明"有程序在听"，**不是**接手 |
| 领取 | `mdreview claim` 或 `mdreview begin-apply` 成功时记在会话上（`claimedAt / claimedBy`） | 以真实事件为准；界面只在领取后才显示"AI 正在修改" |

状态区据此显示三档：「已交出 · 还没有 AI 接入」（主按钮「复制改稿指令」，把文件路径和要执行的命令复制到剪贴板，贴给任何智能体都能接上）、「已交出 · ○○ 在线，等待领取」（超过 10 分钟没领取会提示重新复制指令）、「AI 正在修改…」。智能体名字取 `--agent`、环境变量 `DRAFTBACK_AGENT`，否则按运行环境推断（Claude Code / Codex / AI）。

本地服务对应接口：`POST /api/app/review/listen`（`reviewSessionId, agent, handoff?`）、`/unlisten`、`POST /api/app/review/claim?r=<会话>`；摘要、bundle 与事件都带 `agentState`（`none / listening / claimed`，只在 `ready_to_apply` 下有值）。

### 什么时候算开始新一轮（规则③）

普通打开的文档**首次成功保存一条文字批注或总体意见时**自动开第 1 轮并锁定原文；稿子回来（`complete`）或本轮作废（`cancelled`）后同样在首次成功保存批注时开下一轮。只选字、只打开输入框又取消，都不改轮次。App 里没有单独的「开始审阅」按钮了；智能体侧仍用 `mdreview open`。

## 轮次版本记录(2026-10-14 起,设计见 version-record-design.md)

每篇文档有自己的身份索引(`~/.draftback/documents.json`:`docId`、当前路径、下一轮轮号),轮号只增不减,会话清理不影响历史。
每一轮是 `~/.draftback/versions/<docId>/<versionId>/` 下的一个版本事件:

| 文件 | 内容 |
|---|---|
| `original.md` | 冻结那一刻的原稿(原始字节;独立手工修改轮在第一次受控写入前捕获) |
| `final.md` | 完成稿(AI 改 / 我自己改的轮才有) |
| `meta.json` | 轮次、事件类型(review / approved / cancelled / manual / restored)、两份文件的指纹与状态、交出时固定的本轮成员、处理结果快照、改稿摘要、附件清单 |

规矩:冻结即留底,留不下就不建会话;交出时核对留底并固定本轮成员(交出后新加的批注进下一轮,不阻塞完成);终态先「固化载荷」(写不下就不推进终态,智能体重试 `complete` 即可)再「发布」(失败可用 `mdreview archive-retry` 补);complete / cancelled 之后的普通编辑是工作稿,不改历史;同步推到手机的完成稿从归档读。每篇保留最近 10 个事件。
命令:`mdreview versions <路径>` 列历史;接口 `GET /api/app/document/versions?docId=`、`GET /api/app/version?docId=&versionId=&which=original|final`。恢复与对比视图是后两段的工作。

## 内置服务

本地服务由回稿桌面壳用 Electron 自带的 Node 运行时拉起（`ELECTRON_RUN_AS_NODE`），
macOS 与 Windows 走同一条路径：App 启动时先探测健康服务并复用，否则自己拉起并持有生命周期，
退出时一并结束。开发时也可手工 `node server.js` 启动，App 会直接复用它。

服务只监听 `127.0.0.1`，不提供本地目录浏览。实际端口写入 `~/.draftback/port`，CLI 不写死 8080。

## 普通阅读、普通编辑与审阅会话(2026-10 起)

打开文件(⌘O、双击、拖放、最近文件)默认是**普通阅读**:不创建审阅会话、不加锁、不写 sidecar,状态条显示"普通阅读 · 未冻结",
划词只会提示去点右上角「开始审阅」。「开始审阅」把当前标签原地转成审阅会话(冻结 + 指纹 + 可批注)。
智能体 `mdreview open` 建的会话照旧直接以审阅标签打开;同一文档已在普通标签里打开时自动转换。

**普通编辑**直接把修改写回文件:保存前核对指纹(文件被别的程序改过就拒写,`SOURCE_CHANGED`),
覆盖前把旧内容备份到 `~/.draftback/backups/documents/<路径哈希>/`(每篇保留 10 份),同一 `clientRequestId` 重复提交幂等。
处于活动审阅会话的文档拒绝普通写入(`REVIEW_ACTIVE`),必须走审阅标签里的手工修改流程。

**编辑登记**:进入普通编辑即在 `~/.draftback/editing.json` 登记;期间 `mdreview open` 以 `USER_EDITING` 拒绝冻结并提示稍后重试。
登记归本地服务所有:服务重启清空,条目带进程号,进程不在即视为过期。

**编辑保存保真**(所见即所得编辑器):保存不直接落盘编辑器输出,而是用 `static/markdown-patch.js` 做三方对比
(原文 / 编辑器规范化基线 / 当前内容),没碰过的块回写原文字节,改过的块才用编辑器文本,列表细到项;Front Matter 不进编辑器。
改到编辑器无法无损表示的块(原始 HTML、公式、脚注等)、列表增删项、无法对齐时,保存前弹确认,可取消。

相关接口:`POST /api/app/document/open`、`GET|PUT /api/app/document`、`POST /api/app/document/editing`、`GET /api/app/recent`。

## 快照备份与恢复

```bash
mdreview snapshot [--reason "<原因>"]   # 整体备份 reviews.json + 全部批注 sidecar + 手工改稿原文备份,清单带 SHA-256
mdreview snapshots [--json]
mdreview restore <快照id> --dry-run     # 只预览
mdreview restore <快照id> --yes         # 恢复;恢复前自动再做一份 pre-restore 快照,可反悔
```

快照放在 `~/.draftback/snapshots/<时间戳-原因>/`。本地服务启动时自动做一份(24 小时内已有则跳过,只保留最近 10 份自动快照);手动快照不自动清理。
内容与清单校验不符的快照拒绝恢复;文档目录已不存在的 sidecar 跳过,不凭空建目录。

## 手机批注批次导入

iPhone 端「完成本轮」导出 `<文档>.<批次id>.draftback-batch.json`(格式见 docs/cross-device-rules.md 第 6 节)。CloudKit 接入前,把文件隔空投送到 Mac 后:

```bash
mdreview import-batch "<批次文件>.json"
```

或直接把文件拖进回稿窗口。接收规则:按 `baseVersion`(文档 SHA-256)匹配审阅中的会话 → 会话仍在审阅中 → 版本一致 → 批次编号未见过 →
整批写入 sidecar(已存在的批注 id 跳过)并进入待改稿;任何一步不过都拒收并写回执(`~/.draftback/receipts/<批次id>.json`),
sidecar 与状态不动。重复导入沿用上次回执。

## 数据与可靠性

- `~/.draftback/reviews.json`：本地审阅会话与冻结状态（CLI、App 与 Agent 共享；`DRAFTBACK_DATA_DIR` 可覆盖）。
- `~/.draftback/port`：当前本地服务端口。
- `<文档.md>.annotations.json`：批注正文，兼容旧格式。
- 批注修改会保留原创建记录，并追加 `updatedAt / updatedBy / editCount` 审计字段。
- JSON 写入采用跨进程锁、锁内重读、临时文件和原子替换；已有 JSON 损坏时停止写入，不会按空数据覆盖。
- `.draftback` 权限为 `0700`，其中索引文件为 `0600`。
- 未保存的回稿编辑草稿按 `reviewSessionId + sourceHash` 保存在 App 本地存储中；刷新或异常重开时只恢复匹配版本的草稿。

## 开发、验证与打包

后端只使用 Node 内置模块。桌面壳依赖全部固定版本并记录在 `desktop/package-lock.json`：

```bash
npm --prefix desktop install --cache desktop/.npm-cache
npm --prefix desktop run build:vendor
```

完整测试：

```bash
node --test test/*.test.js
node test/desktop-production-smoke.js          # 审阅全流程;编辑段验证刷新恢复草稿、保存只改动编辑过的块
DRAFTBACK_SMOKE_WIDTH=980 node test/desktop-production-smoke.js
node test/desktop-security-smoke.js            # 安全收口:夹带脚本不执行、CSP 无告警
node test/desktop-plain-document-smoke.js      # 普通阅读/编辑/开始审阅,块级回写保真
node test/desktop-reader-tools-smoke.js        # 查找、深色、打印样式、拖放;加 --shots <目录> 可截图
node test/desktop-performance-probe.js --runs 3 # 渲染层性能探针
npm --prefix desktop test
node --check server.js
node --check mdreview.js
```

iOS 工程(`ios/`,XcodeGen):

```bash
ios/scripts/sync-web.sh && (cd ios && xcodegen generate)
cd ios && xcodebuild -project 回稿.xcodeproj -scheme 回稿 -destination 'platform=iOS Simulator,id=<模拟器UDID>' build
xcrun simctl launch <UDID> org.mdturn.ios --open-sample   # 直接进入示例文档
```

装到连着这台 Mac 的 iPhone(手机需已信任此电脑、开启开发者模式;Xcode 已登录 Apple ID):

```bash
ios/scripts/install-device.sh            # 免费个人团队签名,包标识 org.mdturn.ios.dev,主屏名「回稿测试」
```

免费签名 7 天有效,过期重跑即可;首次安装后要在手机「设置 → 通用 → VPN 与设备管理」里信任开发者证书。
把文件放进手机应用文件夹(「文件」→ 我的 iPhone → 回稿测试):

```bash
xcrun devicectl device copy to --device <设备UDID> --domain-type appDataContainer \
  --domain-identifier org.mdturn.ios.dev --source <本机文件> --destination Documents/<文件名>
```

外观(0.6.1 起):菜单栏「显示 → 外观」可选跟随系统 / 浅色 / 深色,存在应用数据目录的 settings.json;大纲随 ⌘+ / ⌘- 一起缩放。

新建与导出(0.6.0 起):

- **新建 Markdown**(⌘N,或欢迎页/左栏「文件」里的按钮):先选位置和文件名,由本地服务创建文件(已存在绝不覆盖,而是直接打开它),建好即进入编辑。
- **导出**在工具栏「导出」菜单和菜单栏「文件」里:PDF(⇧⌘E)、单文件 HTML、Word、打印(⌘P)。
- 单文件 HTML:正文样式、代码高亮、公式样式与字体、同目录图片全部内联,可脱离回稿单独打开或发送。
- Word 由 pandoc 转换,公式成为 Word 原生可编辑公式,图片与表格按 Word 结构落地。电脑上要先装 pandoc(`brew install pandoc`);
  没装时导出会给出安装提示。公开版再决定随 App 附带 pandoc 还是改纯 JS 转换器。

图标:源文件在 `branding/icon.svg`(候选与对比图在 `branding/candidates/`),改完渲染成 1024×1024 PNG 后一条命令生成三端图标:

```bash
python3 scripts/make-icons.py branding/icon-1024.png   # iOS 资源目录、macOS icon.png(打包时转 icns)、Windows icon.ico
```

生成 macOS arm64 App：

```bash
npm --prefix desktop run dist:app
```

当前构建使用 ad-hoc 签名，适合本机安装和早期开源试用；正式公开下载前还需要 Apple Developer ID
签名与 notarization。

生成 Windows 11 x64 安装包（无原生依赖、不签名，因此在 macOS 上也能直接交叉构建）：

```bash
npm --prefix desktop run dist:win
```

正式发布走 GitHub Actions：推送 `v*` 标签后，CI 会在真实 macOS 与 Windows 机器上
跑完整测试并构建 `.dmg` 与 `.exe`，以草稿 Release 形式挂出，人工确认后发布
（见 `.github/workflows/release.yml`）。

产物为 `desktop/dist/Draftback-<版本>-x64.exe`（NSIS 安装器，支持自选目录、快捷方式、
卸载和 `.md` 文件关联）。Windows Beta 未做代码签名，安装时 SmartScreen 显示“未知发布者”
属预期。Windows 版覆盖完整的本地审阅闭环，暂不含自动更新与 ARM64，
边界详见 [windows-porting.md](windows-porting.md)。
