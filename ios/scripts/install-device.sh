#!/bin/bash
# 把 MDTurn 测试版签名、构建并装到连着这台 Mac 的 iPhone 上(命令行完成,不用打开 Xcode)。
#
# 开发者账户激活前用 Xcode 里的免费个人团队签名:证书 7 天有效,过期后重跑本脚本即可。
# 测试版用单独的包标识 org.mdturn.ios.dev、主屏幕名"MDTurn 测试",
# 正式标识 org.mdturn.ios 留给开发者账户(免费团队先注册的标识,付费团队可能无法再用)。
#
# 用法:
#   ios/scripts/install-device.sh              # 自动找第一台已配对、已开开发者模式的 iPhone
#   ios/scripts/install-device.sh <设备UDID>
# 可用环境变量覆盖:MDTURN_TEAM(签名团队 ID)、MDTURN_BUNDLE_ID、MDTURN_DISPLAY_NAME、MDTURN_CONFIGURATION
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
TEAM="${MDTURN_TEAM:-BG7Y59AT44}"
BUNDLE_ID="${MDTURN_BUNDLE_ID:-org.mdturn.ios.dev}"
DISPLAY_NAME="${MDTURN_DISPLAY_NAME:-MDTurn 测试}"
CONFIGURATION="${MDTURN_CONFIGURATION:-Release}"
DERIVED="$IOS/build/DerivedData-device"
DEVICE="${1:-}"

if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun devicectl list devices --json-output - 2>/dev/null | python3 -c '
import json, sys
for dev in json.load(sys.stdin)["result"]["devices"]:
    hw, conn, props = dev.get("hardwareProperties", {}), dev.get("connectionProperties", {}), dev.get("deviceProperties", {})
    if hw.get("reality") == "physical" and hw.get("platform") == "iOS" and conn.get("pairingState") == "paired":
        if props.get("developerModeStatus") != "enabled":
            sys.exit("手机已配对,但没开开发者模式:设置 → 隐私与安全性 → 开发者模式")
        print(hw["udid"]); break
')"
fi
if [ -z "$DEVICE" ]; then
  echo "没找到已配对的 iPhone:用数据线连上 Mac,手机上点「信任」,再重跑。" >&2
  exit 1
fi
echo "目标设备: $DEVICE  签名团队: $TEAM  包标识: $BUNDLE_ID"

"$IOS/scripts/sync-web.sh"
(cd "$IOS" && xcodegen generate --quiet)

xcodebuild -project "$IOS/MDTurn.xcodeproj" -scheme MDTurn -configuration "$CONFIGURATION" \
  -destination "platform=iOS,id=$DEVICE" -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" MDTURN_DISPLAY_NAME="$DISPLAY_NAME" \
  build -quiet

APP="$DERIVED/Build/Products/$CONFIGURATION-iphoneos/MDTurn.app"
xcrun devicectl device install app --device "$DEVICE" "$APP"
if ! xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" >/dev/null 2>&1; then
  cat <<'TIP'
已装好,但手机还没信任这个开发者证书,所以暂时打不开。在手机上:
  设置 → 通用 → VPN 与设备管理 → 开发者 App 下点 "Apple Development: …" → 信任
然后点主屏幕上的「MDTurn 测试」即可。每台手机只需信任一次。
TIP
  exit 0
fi
echo "已安装并启动「$DISPLAY_NAME」。"
