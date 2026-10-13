#!/bin/bash
# 构建 MDTurn Sync.app:xcodegen 生成工程 → xcodebuild 自动签名(需要 Xcode 已登录开发者账号)。
# 产物:mac-sync/build/MDTurn Sync.app;打 Mac 安装包时由 electron-builder 原样放进 MDTurn.app/Contents/Helpers/。
# 用法:mac-sync/scripts/build.sh [Debug|Release]
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG="${1:-Debug}"
TEAM="${DEVELOPMENT_TEAM:-BG7Y59AT44}"
xcodegen generate >/dev/null
LOG="build/xcodebuild-${CONFIG}.log"
mkdir -p build
if ! xcodebuild -project MDTurnSync.xcodeproj -scheme MDTurnSync -configuration "$CONFIG" \
    -derivedDataPath build/DerivedData -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic build > "$LOG" 2>&1; then
  echo "构建失败,日志: $LOG"; grep -E "error:|warning: .*provision" "$LOG" | sort -u | head -20; exit 1
fi
rm -rf "build/MDTurn Sync.app"
ditto "build/DerivedData/Build/Products/$CONFIG/MDTurn Sync.app" "build/MDTurn Sync.app"
echo "已构建 build/MDTurn Sync.app"
codesign -dv --entitlements - "build/MDTurn Sync.app" 2>&1 | grep -E "Authority=|icloud" | head -6
ls "build/MDTurn Sync.app/Contents/embedded.provisionprofile" >/dev/null 2>&1 && echo "已嵌入描述文件" || echo "注意:没有嵌入描述文件(CloudKit 可能拒绝)"
