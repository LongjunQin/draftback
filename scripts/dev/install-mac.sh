#!/bin/bash
# 把 desktop/dist 里打好的安装包装到 /Applications,替换正在用的回稿(也能替换改名前的 MDTurn)。
# 先用 `npm --prefix desktop run dist:dmg` 打包。
#
# 用法:
#   scripts/dev/install-mac.sh                  # 装 desktop/package.json 里这一版
#   scripts/dev/install-mac.sh 1.0.0-beta.23    # 装指定版本
#
# 步骤:记下旧端口 → 挂载 → 退出新旧两种 App → 停服务与同步程序 → 旧 App 挪到 desktop/dist/old-apps
# 并从系统登记里注销 → 拷贝新 App → 首次装 Draftback 时把旧端口写进新设置(页面本地存储按端口隔离,
# 标签和偏好才能接上)→ 启动 → 等健康检查。
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
VER="${1:-$(node -p 'require(process.argv[1]).version' "$REPO/desktop/package.json")}"
OLD_APPS="$REPO/desktop/dist/old-apps"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
DMG="$REPO/desktop/dist/Draftback-$VER-arm64.dmg"
[ -f "$DMG" ] || { echo "没有 $DMG,先打包" >&2; exit 1; }
OLD_PORT=$(cat ~/.draftback/port 2>/dev/null | tr -dc '0-9')
MNT=$(hdiutil attach "$DMG" -nobrowse -readonly 2>/dev/null | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
[ -d "$MNT/Draftback.app" ] || { echo "挂载失败: $MNT" >&2; exit 1; }
osascript -e 'tell application id "app.draftback.mac" to quit' >/dev/null 2>&1
osascript -e 'tell application id "org.mdturn.desktop" to quit' >/dev/null 2>&1
for i in $(seq 1 40); do pgrep -x MDTurn >/dev/null || pgrep -x Draftback >/dev/null || break; sleep 0.5; done
pkill -f "mdturn-server/server.js" 2>/dev/null; pkill -f "draftback-server/server.js" 2>/dev/null
pkill -f "MDTurn Sync.app/Contents/MacOS/MDTurn Sync" 2>/dev/null
pkill -f "Draftback Sync.app/Contents/MacOS/Draftback Sync" 2>/dev/null
mkdir -p "$OLD_APPS"
for NAME in MDTurn Draftback; do
  if [ -d "/Applications/$NAME.app" ]; then
    OLD=$(defaults read "/Applications/$NAME.app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo old)
    rm -rf "$OLD_APPS/$NAME-$OLD.app"; mv "/Applications/$NAME.app" "$OLD_APPS/$NAME-$OLD.app"
  fi
done
# 挪走的旧 App 和打包目录里的 App 不能再被系统当成 .md 的打开方式(否则双击 .md 可能拉起旧版,两个同步程序同时跑)
for app in "$OLD_APPS"/*.app "$REPO"/desktop/dist/mac-arm64/*.app; do [ -d "$app" ] && "$LSREG" -u "$app" >/dev/null 2>&1; done
ditto "$MNT/Draftback.app" /Applications/Draftback.app
hdiutil detach "$MNT" -quiet
"$LSREG" -f /Applications/Draftback.app >/dev/null 2>&1
UD="$HOME/Library/Application Support/Draftback"
if [ -n "$OLD_PORT" ] && [ ! -f "$UD/settings.json" ]; then
  mkdir -p "$UD" && printf '{\n  "servicePort": %s\n}\n' "$OLD_PORT" > "$UD/settings.json"
  echo "首次安装:沿用旧端口 $OLD_PORT"
fi
open -a /Applications/Draftback.app
for i in $(seq 1 60); do
  PORT=$(cat ~/.draftback/port 2>/dev/null)
  if [ -n "$PORT" ] && curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "已安装 回稿 $(defaults read /Applications/Draftback.app/Contents/Info.plist CFBundleShortVersionString),服务端口 $PORT"; exit 0
  fi
  sleep 0.5
done
echo "App 已装,但 30 秒内没等到服务健康检查(端口文件: $(cat ~/.draftback/port 2>/dev/null))" >&2; exit 2
