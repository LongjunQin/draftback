#!/bin/bash
# 手机界面截图:在模拟器里用演示稿件(--demo-drafts)启动调试版回稿,按场景截图。不碰真实数据。
# 先把调试版装进模拟器(见 docs/advanced.md「iOS 工程」)。
#
# 用法:
#   scripts/dev/phone-shots.sh <输出目录> <名字> [启动参数...]                  # 截一张
#   scripts/dev/phone-shots.sh <输出目录> --list scripts/dev/phone-shots.list   # 按清单截一批
# 清单每行:名字 启动参数...;# 开头是注释。启动参数都会自动加 --demo-drafts。
# 环境变量:SIM 模拟器(默认已启动的那台)、WAIT 启动后等几秒再截(默认 5)。
# 换封面 / 外观(重启 App 后生效):
#   xcrun simctl spawn booted defaults write app.draftback.ios draftback.cover -string black
#   xcrun simctl ui booted appearance dark
set -u
SIM="${SIM:-booted}"
OUT="${1:?用法见脚本开头}"; shift
mkdir -p "$OUT"
shoot() {
  local name="$1"; shift
  xcrun simctl terminate "$SIM" app.draftback.ios >/dev/null 2>&1
  xcrun simctl launch "$SIM" app.draftback.ios --demo-drafts "$@" >/dev/null || { echo "启动失败:$name(调试版装进模拟器了吗?)" >&2; return 1; }
  sleep "${WAIT:-5}"
  xcrun simctl io "$SIM" screenshot "$OUT/$name.png" >/dev/null 2>&1 && echo "$OUT/$name.png"
}
if [ "${1:-}" = "--list" ]; then
  LIST="${2:?缺清单文件}"
  while read -r name args; do
    case "$name" in ''|'#'*) continue ;; esac
    # shellcheck disable=SC2086 # 参数按空格拆开
    shoot "$name" $args < /dev/null
  done < "$LIST"
else
  shoot "${1:?缺名字}" "${@:2}"
fi
