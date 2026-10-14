# 改名执行方案:MDTurn → Draftback / 回稿(2026-10-14)

给执行改名的智能体(Opus 5.5)照做的文档。读完就能动手,不需要再问产品问题。

## 0. 已定的事

| 项 | 定了 |
|---|---|
| 英文名(全球唯一身份) | **Draftback** |
| 中文名(中国区显示名、中文界面里的叫法) | **回稿** |
| 二者关系 | 不是翻译,是各自语言里说同一个瞬间:稿子回来了。文档和界面里中文语境写「回稿」,英文语境写「Draftback」,不要写成「Draftback(回稿)」混排 |
| 域名 | draftback.app(查过可注册;用户在商标查清后自己注册) |
| 反向域名前缀 | `app.draftback` |
| 定位 | 第一句话是闭环(你批一轮、AI 改一轮、稿子回来),第二句话才是「也是好用的 Markdown 阅读编辑器」 |

**改名的时机:上架 App Store 之前一次做完。** 在那之前所有打磨照常,不要零散地改名。

> 2026-10-14 用户在手机上批注,要一张小狗小猫打闹的图来测试批注往返(新 App「回稿 测试」第一次交回批注):
>
> ![小狗和小猫在草坪上打闹](images/puppy-kitten-play.svg)

**前置条件(用户办,未办完不要开始):** 美国 USPTO 与中国商标局第 9 类检索 Draftback 无冲突;draftback.app 已注册到用户名下。

## 1. 原则:改「身份」,不改「内脏」

名字有两层。**对外身份**(用户、商店、系统能看见的)全改;**内部身份**(用户永远看不见、改了只有迁移风险没有收益的)不改。判断标准只有一条:用户或 App Store 审核员能不能看见。

### 1.1 改(对外可见)

| 位置 | 现在 | 改成 |
|---|---|---|
| Mac App 产品名(菜单栏、Dock、关于、窗口标题) | MDTurn | Draftback |
| Mac App 包标识 | org.mdturn.desktop | app.draftback.mac |
| Mac 同步辅助程序包标识 / 产品名 | org.mdturn.desktop.sync / MDTurn Sync | app.draftback.mac.sync / Draftback Sync |
| Mac 安装包文件名 | MDTurn-x.y.z-arm64.dmg | Draftback-x.y.z-arm64.dmg |
| Mac 应用内 `Contents/Helpers/MDTurn Sync.app` | | `Contents/Helpers/Draftback Sync.app` |
| iOS 包标识(正式 / 测试) | org.mdturn.ios / org.mdturn.ios.dev | app.draftback.ios / app.draftback.ios.dev |
| iOS 主屏幕名 | MDTurn / MDTurn 测试 | 英文系统 Draftback;中文系统 回稿(用 InfoPlist.strings 本地化 CFBundleDisplayName);测试版后缀「测试」/「Beta」照旧 |
| iOS 工程名、目录名、Scheme | ios/MDTurn、MDTurn.xcodeproj | ios/Draftback、Draftback.xcodeproj |
| 「文件」App 里的文件夹名 | 跟随显示名 | 跟随显示名(自动) |
| 界面文案里的产品名 | 「MDTurn」「在 MDTurn 中打开」「MDTurn 文件夹」 | 中文界面写「回稿」,英文界面写「Draftback」 |
| 标题栏 / 关于 / 导出 HTML 页脚 / 打印页眉 | MDTurn | 同上 |
| 图标、启动页、品牌 SVG(docs/images、branding/) | MDTurn 字样 | 重做:见第 4 节 |
| README、CONTRIBUTING、LICENSE 里的产品名、docs/ 下所有文档 | MDTurn | Draftback(中文段落里写回稿) |
| GitHub 仓库名 | LongjunQin/mdturn | LongjunQin/draftback(GitHub 自动把旧地址转到新地址,本地 remote 要更新) |
| 跨端规则、路线图、进度文档的标题与正文 | MDTurn | 改名,并在开头加一行「2026-xx-xx 起产品改名为 Draftback / 回稿,此前文档里的 MDTurn 指同一产品」 |
| AGENTS.md、~/work/CLAUDE.md 里的叫法 | 「用 MDTurn 打开」 | 「用回稿打开」;命令 `mdreview` 不变(见 1.2) |

### 1.2 不改(内部,改了只有风险)

| 位置 | 为什么不改 |
|---|---|
| `mdreview` 命令及其子命令 | 它是给智能体用的协议词,描述动作(Markdown review),不是品牌;AGENTS.md、所有文档、用户的肌肉记忆都用它 |
| 数据目录 `~/.mdread` 及其中所有文件名 | 用户看不见;里面有 258 条审阅记录、快照、备份,迁移等于冒险 |
| iCloud 容器 `iCloud.org.mdturn`、区名 `mdturn`、四种记录类型 | 容器标识永远不展示给用户;新 App ID 可以直接挂到这个容器上;换容器意味着手机上已同步的文档、未回执的批次全部作废。**不换** |
| 环境变量 `MDREAD_*`、`MDTURN_*` | 内部契约,测试和脚本都依赖;改了没收益 |
| 本地服务名 `md-read`、`/api/app/*` 路径、`mdturn-server` 目录名 | 同上 |
| 浏览器端 localStorage 键 `mdturn.*` | 改了用户的阅读偏好(缩放、深色)全丢 |
| sidecar 文件名 `.annotations.json`、`_apply` 协议文本 | 协议,不是品牌 |
| 批次 JSON 的字段名、`docId` 格式 | 协议 |
| 源代码里的变量名、CSS 类名(`mdturn-*`)、`window.MDTurnEditor` 这类全局对象 | 用户看不见;整仓库替换会把 1.2 节里要保留的东西一起改坏 |

一句话:**grep 替换 `MDTurn` 的时候,先按 1.1 的清单逐处改,不要全局替换。** 322 处 `MDTurn` 里有一半属于 1.2。

### 1.3 唯一需要迁移的东西:Electron 的用户数据目录

Electron 按产品名决定 `~/Library/Application Support/<产品名>/`,里面是窗口状态、标签恢复、localStorage。产品名变了目录就变,用户升级后会「丢失打开的标签和偏好」。处理:主进程首次以新名启动时,若新目录不存在而旧目录 `~/Library/Application Support/MDTurn` 存在,整目录复制过来(复制不是移动,留旧目录给回滚)。写成一个带测试的函数。

## 2. 顺序(按这个做,每步可验证)

1. **用户办**:开发者网站新建 App ID `app.draftback.mac`、`app.draftback.mac.sync`、`app.draftback.ios`、`app.draftback.ios.dev`,每个都勾 iCloud 并 Configure 挂上容器 `iCloud.org.mdturn`;iOS 两个再勾 Push Notifications。然后删掉 `~/Library/Developer/Xcode/UserData/Provisioning Profiles/` 里的旧描述文件。
2. **仓库改名**:GitHub 仓库 → draftback;本地 `git remote set-url`。开新分支 `rename/draftback`。
3. **Mac 同步辅助程序**(mac-sync/):project.yml 的 bundle、PRODUCT_NAME、目录与 scheme 名;build.sh 产物路径;desktop/main.js 里找辅助程序的路径(`Helpers/Draftback Sync.app/...`);electron-builder 的 extraFiles 与 signIgnore。构建一次,`codesign -d --entitlements` 确认容器仍是 `iCloud.org.mdturn`。
4. **Mac App**(desktop/):package.json 的 name、productName、appId、dmg 文件名;`app.setName`、`setAppUserModelId`;窗口标题;1.3 节的目录迁移;dock-icon。跑 `npm --prefix desktop test`。
5. **本地服务与页面**(server.js、static/):仅改用户可见文案(标题、页脚、提示语、导出 HTML 页脚);`desktop.html` 的 `<title>`;脚本缓存版本号 `v=` 加一。跑 `node --test` 与 4 个浏览器冒烟。
6. **iOS**(ios/):目录与工程重命名;project.yml 的 bundle、显示名、entitlements 路径;`InfoPlist.strings`(en: Draftback;zh-Hans: 回稿);install-device.sh 的默认包标识与显示名;界面文案。装到手机,确认「来自 Mac」还在、旧文档还能打开(容器没换,数据应原样可见)。
7. **文档与品牌**:README、docs/*、AGENTS.md、CLAUDE.md、图标与 SVG。
8. **全链路复验**:`mdreview open` 一篇带图的文档 → 手机看到 → 批注交回 → `mdreview complete --summary` → 手机自动换新。用 scratchpad 里的 sync-e2e 脚本思路重跑。
9. **出包**:Mac 版本号跳到 1.0.0-beta.1;iOS 同步跳版本。装到用户电脑和手机。
10. 合并到 main。旧的 `MDTurn.app` 由安装脚本挪走,不要留两个 App 同时跑(两个辅助程序会同时轮询同一个容器)。

## 3. 风险与回滚

| 风险 | 对策 |
|---|---|
| 新包标识拿不到带容器的描述文件 | 第 1 步没做完的典型症状;检查 App ID 的 iCloud 行是否「Enabled iCloud Containers (1)」 |
| 两个辅助程序同时跑(旧 MDTurn 没退干净) | 安装脚本先 `pkill` 两种名字的辅助程序;服务端对同一批次已有回执会跳过,不会重复写 |
| iOS 新包标识 = 新 App,手机上是「另装一个」而不是升级 | 测试阶段可接受;旧 App 卸载前先确认新 App 已看到「来自 Mac」。本地批注草稿存在 App 沙盒里,会丢:改名前先把手机上未提交的批注都提交掉 |
| Electron 用户数据目录变化 | 1.3 节的复制迁移 |
| 全局替换误伤 1.2 节的内部标识 | 逐处改;改完 `git grep -n "MDTurn"` 剩下的每一处都要能说出属于 1.2 的哪一行 |
| 回滚 | 整个改名在一个分支上;不合并即回滚。数据目录与容器都没动,旧版 App 装回去立刻可用 |

## 4. 品牌视觉(单独一轮,先出方案再做)

- 图标:围绕「稿子回来」。候选意象:一张纸带一个回转箭头;对折后翻回的页角;信封口张开、纸正在回来。要在 29px 尺寸下仍能认出,中文系统下图标不带文字。
- 启动页 / 空状态文案:中文「回稿:你批,AI 改,稿子自己回到你手上」;英文「Draftback: you mark it up, the AI revises, the draft comes back」。
- 旧的 branding/candidates 和 docs/images 里的 MDTurn 字样全部作废。

## 5. 改完的验收(用户做)

1. Mac 菜单栏、Dock、关于窗口显示 Draftback;打开旧文档,标签、缩放偏好还在。
2. 中文 iPhone 主屏幕显示「回稿」(测试版显示「回稿 测试」),「来自 Mac」里旧文档还在。
3. 第 2 节第 8 步的全链路跑通。
4. `git grep -c MDTurn` 的剩余命中,每一处都在 1.2 节的允许范围内。
