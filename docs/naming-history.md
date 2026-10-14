# 命名沿革

这个项目改过两次名。本文记录每个名字用在哪、现在还能在哪看到、为什么留着,免得多年后没人知道代码和账号里的旧名是什么。

## 名字的三个时期

| 时期 | 名字 | 用在哪 |
|---|---|---|
| 2026-07 之前(内部原型) | **md在线阅读 / md-read / mdread** | 目录名「01_md在线阅读」、本地服务名 `md-read`、数据目录 `~/.mdread`、环境变量 `MDREAD_*`、测试临时目录前缀 |
| 2026-07-31 → 2026-10-14 | **MDTurn** | 首次开源时的产品名;Mac App 名、包标识 `org.mdturn.*`、iCloud 容器 `iCloud.org.mdturn`、代码里的全局对象、环境变量 `MDTURN_*`、GitHub 仓库 `LongjunQin/mdturn` |
| 2026-10-14 起 | **Draftback / 回稿** | 英文名是全球唯一身份,中文名是中国区显示名与中文界面的叫法。两者不是翻译,各自说「稿子回来了」这个瞬间 |

改名的原因与决策记录见 [naming-proposals.md](naming-proposals.md)(候选与调研)和 [rename-plan.md](rename-plan.md)(执行方案)。

## 现在的标识(2026-10-14 第二阶段改名后)

品牌名只出现在显示文案和本地化资源里;下面这些内部标识一经选定不再随品牌变。

| 用途 | 标识 |
|---|---|
| Mac App 包标识 / 产品名 | `app.draftback.mac` / Draftback(中文系统显示「回稿」) |
| Mac 同步辅助程序 | `app.draftback.mac.sync` / Draftback Sync |
| iOS 包标识(正式 / 测试) | `app.draftback.ios` / `app.draftback.ios.dev` |
| iCloud 容器 / 区 / 订阅 | `iCloud.app.draftback` / `draftback` / `draftback-zone-changes` |
| 本地服务名(健康检查契约) | `draftback-service` |
| 数据目录 | `~/.draftback`(App、CLI、智能体共用) |
| App 内置服务资源目录 | `Contents/Resources/draftback-server/` |
| 环境变量 | `DRAFTBACK_DATA_DIR`、`DRAFTBACK_PORT`、`DRAFTBACK_HOST`、`DRAFTBACK_PARENT_PID`、`DRAFTBACK_SYNC_*`、`DRAFTBACK_APP_PATH`、`DRAFTBACK_DEBUG` 等 |
| 页面全局对象 / 本地存储键 / 高亮名 | `DraftbackEditor`、`DraftbackAnchor`、`DraftbackPatch`、`DraftbackReader`;`draftback.*`;`draftback-open` 等 |
| 进程间通道(Electron) | `draftback:*` |
| 手机导出的批次文件后缀 | `.draftback-batch.json` |
| 智能体用的命令 | `mdreview`(意思是「审阅 Markdown」,是动作不是品牌,所以不改) |
| 批注旁车文件 | `<文件>.md.annotations.json`(协议,不改) |

## 旧名还能在哪看到(以及为什么留着)

| 位置 | 情况 |
|---|---|
| git 提交历史 | 原样保留。它本身就是记录,改写会让所有旧链接失效 |
| 2026-10-14 之前的历史文档(round1-progress、审计记录、早期路线图) | 原样保留,开头加了一行改名说明。它们写的是当时发生的事 |
| 苹果开发者账号里的旧容器 `iCloud.org.mdturn` | 苹果不允许删除容器。已闲置,不再有任何 App 使用;旧 App ID `org.mdturn.*` 已删除 |
| GitHub 旧地址 `LongjunQin/mdturn` | 仓库已改名为 `LongjunQin/draftback`,旧地址由 GitHub 自动跳转 |
| 代码里的 `LEGACY_*` 常量与 `MDTurn`/`.mdread` 字样 | 都是搬迁逻辑:第一次用新版时把旧数据目录(`~/.mdread`、`Application Support/MDTurn`)、旧本地存储键(`mdturn.*`)搬到新位置。每处旁边有注释指回本文 |
| 旧的安装包文件名 `MDTurn-x.y.z-arm64.dmg` | 2026-10-14 之前发布的版本;v0.4.1 是最后一个以 MDTurn 为名公开发布的版本 |
| 用户自己文档旁的 `.annotations.json` 里的 `_apply` 说明文字 | 读取时自动重写为当前版本的文字,不用手动改 |

## 以后新建标识的规矩

1. 品牌名只放显示文案、本地化资源、商店页。
2. 包标识、容器、数据目录、存储键、协议名、环境变量一经选定不随品牌变;真要变,写进本文并做自动搬迁。
3. 历史文档不改写,只在开头加说明。
