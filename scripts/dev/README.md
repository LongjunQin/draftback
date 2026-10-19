# 开发用小脚本

给开发和排查用,不进安装包。都从仓库根目录跑。

| 脚本 | 做什么 |
|---|---|
| `install-mac.sh [版本]` | 把 `desktop/dist` 里打好的安装包装到 /Applications,替换正在用的回稿 |
| `sync-run.sh [stop]` | 同步联调(常驻):单独的数据目录起服务和同步辅助程序 |
| `sync-e2e.sh [keep]` | 同步联调(单轮):打开测试稿 → 辅助程序跑一轮 → 看同步状态 |
| `mac-shots.js <输出目录> [场景…]` | Mac 界面截图:造几篇不同状态的稿子,无头 Chrome 按场景截图 |
| `phone-shots.sh <输出目录> …` | 手机界面截图:模拟器里用演示稿件按场景截图 |

手机锁着时装机不用另外的脚本:`ios/scripts/install-device.sh` 会先编好,手机一解锁就装上。

## 装 Mac 安装包

```bash
npm --prefix desktop run dist:dmg
scripts/dev/install-mac.sh                  # 装 desktop/package.json 里这一版
scripts/dev/install-mac.sh 1.0.0-beta.23    # 装指定版本
```

- 会退出正在用的回稿和它的同步程序,装完自动启动,等到服务健康检查通过才算装好。
- 旧 App 挪到 `desktop/dist/old-apps`,并从系统登记里注销,双击 .md 不会拉起旧版。
- 第一次从改名前的 MDTurn 换过来时,沿用旧端口(页面本地存储按端口隔离,标签和偏好才能接上)。

## 同步联调

```bash
mac-sync/scripts/build.sh          # 先构建同步辅助程序
scripts/dev/sync-e2e.sh            # 跑一轮就停
scripts/dev/sync-run.sh            # 常驻;再用 DRAFTBACK_DATA_DIR="<联调目录>/data" node mdreview.js … 操作
scripts/dev/sync-run.sh stop
```

- 联调目录默认 `$TMPDIR/draftback-sync-dev`,用 `DRAFTBACK_DEV_DIR` 改。不碰正在用的 `~/.draftback`。
- 辅助程序用这台 Mac 登录的 iCloud(开发环境)。推上去的稿子,装了测试版的手机上看得到。
- `stop` 只按进程号停这里起的服务和辅助程序,不碰正在用的回稿。

## Mac 界面截图

```bash
node scripts/dev/mac-shots.js /tmp/shots                       # 全部场景
node scripts/dev/mac-shots.js /tmp/shots back night --cover mist --scale 2
```

- 稿子造在临时目录里,不碰 `~/.draftback`。原生外壳用假桥代替,改了 `static/` 不用打包就能截。
- 场景:`welcome` `back` `diff` `confirm` `settings` `comment` `dialog` `toast` `conflict` `night` `popovers` `approve` `handed` `applying` `edit` `panels` `narrow`。
- `--cover` 是封面颜色:`green` `mist` `lavender` `gold` `orange` `black`。`--size` 默认 `1440x900`。
- 截夜读时加 `NO_ANIM=1`,关掉指示灯闪烁。

## 手机界面截图

先把调试版装进模拟器(见 `docs/advanced.md`「开发、验证与打包」里的 iOS 工程)。

```bash
scripts/dev/phone-shots.sh /tmp/phone home --demo-expand-all              # 截一张
scripts/dev/phone-shots.sh /tmp/phone --list scripts/dev/phone-shots.list # 按清单截一批
```

- 只用演示稿件(`--demo-drafts`),不碰真实数据。清单每行是「名字 启动参数」,演示稿件的说明在 `phone-shots.list` 开头。
- `SIM` 指定模拟器(默认已启动的那台),`WAIT` 是启动后等几秒再截(默认 5)。
- 换封面、换外观以后重新截:

```bash
xcrun simctl spawn booted defaults write app.draftback.ios draftback.cover -string black
xcrun simctl ui booted appearance dark
```
