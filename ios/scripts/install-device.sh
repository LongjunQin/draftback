#!/bin/bash
# 把回稿(Draftback)测试版签名、构建并装到连着这台 Mac 的 iPhone 上(命令行完成,不用打开 Xcode)。
#
# 开发者账户激活前用 Xcode 里的免费个人团队签名:证书 7 天有效,过期后重跑本脚本即可。
# 测试版用单独的包标识 app.draftback.ios.dev、主屏幕名"回稿 测试"(英文系统 "Draftback Beta"),
# 正式标识 app.draftback.ios 留给 TestFlight / App Store。
#
# 用法:
#   ios/scripts/install-device.sh              # 自动找第一台已配对、已开开发者模式的 iPhone
#   ios/scripts/install-device.sh <设备UDID>
# 手机锁着也可以跑:先编好,手机一解锁就装上(最多等 60 分钟)。
# 可用环境变量覆盖:DRAFTBACK_TEAM(签名团队 ID)、DRAFTBACK_BUNDLE_ID、DRAFTBACK_DISPLAY_NAME、DRAFTBACK_CONFIGURATION、
# DRAFTBACK_UNLOCK_WAIT_MINUTES(等解锁的分钟数)
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
TEAM="${DRAFTBACK_TEAM:-BG7Y59AT44}"
BUNDLE_ID="${DRAFTBACK_BUNDLE_ID:-app.draftback.ios.dev}"
DISPLAY_NAME="${DRAFTBACK_DISPLAY_NAME:-回稿 测试}"
DISPLAY_NAME_EN="${DRAFTBACK_DISPLAY_NAME_EN:-Draftback Beta}"
CONFIGURATION="${DRAFTBACK_CONFIGURATION:-Release}"
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

# 手机锁着时 xcodebuild 连不上手机(要挂开发者磁盘映像)。这时先不连手机编好,解锁后马上装,
# 免得编的那一两分钟里手机又锁上。读不出锁屏状态就当没锁,照常走。
device_locked() {
  xcrun devicectl device info lockState --device "$DEVICE" --json-output - 2>/dev/null \
    | python3 -c 'import json, sys; sys.exit(0 if json.load(sys.stdin)["result"]["passcodeRequired"] else 1)' 2>/dev/null
}
DESTINATION="platform=iOS,id=$DEVICE"
if device_locked; then
  DESTINATION="generic/platform=iOS"
  echo "手机锁着:先编好,解锁后自动装。"
fi

xcodebuild -project "$IOS/Draftback.xcodeproj" -scheme Draftback -configuration "$CONFIGURATION" \
  -destination "$DESTINATION" -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" DRAFTBACK_DISPLAY_NAME_ZH="$DISPLAY_NAME" DRAFTBACK_DISPLAY_NAME_EN="$DISPLAY_NAME_EN" \
  build -quiet

APP="$DERIVED/Build/Products/$CONFIGURATION-iphoneos/Draftback.app"
WAIT_MINUTES="${DRAFTBACK_UNLOCK_WAIT_MINUTES:-60}"
if device_locked; then
  echo "等手机解锁(最多 $WAIT_MINUTES 分钟)…"
  for _ in $(seq 1 $((WAIT_MINUTES * 6))); do device_locked || break; sleep 10; done
  if device_locked; then
    echo "手机一直锁着。解锁后重跑本脚本。" >&2
    exit 1
  fi
fi
xcrun devicectl device install app --device "$DEVICE" "$APP"
LAUNCH_LOG="$(mktemp)"
if xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" >"$LAUNCH_LOG" 2>&1; then
  echo "已安装并启动「${DISPLAY_NAME}」。"
elif grep -q "not been explicitly trusted\|invalid code signature" "$LAUNCH_LOG"; then
  cat <<'TIP'
已装好,但手机还没信任这个开发者证书,所以暂时打不开。在手机上:
  设置 → 通用 → VPN 与设备管理 → 开发者 App 下点 "Apple Development: …" → 信任
然后点主屏幕上的「回稿 测试」即可。每台手机只需信任一次。
TIP
else
  echo "已装好,但没能从 Mac 上启动(手机可能锁屏了),直接在手机上点「${DISPLAY_NAME}」即可。原因:"
  grep -m1 "NSLocalizedFailureReason" "$LAUNCH_LOG" || tail -3 "$LAUNCH_LOG"
fi
rm -f "$LAUNCH_LOG"
