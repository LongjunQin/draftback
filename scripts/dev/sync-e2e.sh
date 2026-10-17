#!/bin/bash
# 同步联调(单轮):单独的数据目录起服务 → 打开一篇测试稿进入审阅 → 辅助程序跑一轮(--once)→ 看同步状态。
# 不碰正在用的 ~/.draftback。辅助程序用这台 Mac 登录的 iCloud(开发环境):「同步测试稿」在装了测试版的手机上看得到。
# 先用 mac-sync/scripts/build.sh 构建辅助程序。
#
# 用法:
#   scripts/dev/sync-e2e.sh          # 跑完停服务
#   scripts/dev/sync-e2e.sh keep     # 跑完服务留着(用 scripts/dev/sync-run.sh stop 停)
# 环境变量:DRAFTBACK_DEV_DIR 联调目录(默认 $TMPDIR/draftback-sync-dev,与 sync-run.sh 同一个)。
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEV="${DRAFTBACK_DEV_DIR:-${TMPDIR:-/tmp}/draftback-sync-dev}"
HELPER="$REPO/mac-sync/build/Draftback Sync.app/Contents/MacOS/Draftback Sync"
export DRAFTBACK_DATA_DIR="$DEV/data"
DOC="$DEV/doc/同步测试稿.md"
mkdir -p "$DRAFTBACK_DATA_DIR" "$DEV/doc"
[ -x "$HELPER" ] || { echo "没有辅助程序:先跑 mac-sync/scripts/build.sh" >&2; exit 1; }
[ -f "$DOC" ] || printf '# 同步测试稿\n\n联调用的测试稿。\n\n## 第一节\n\n这一段用来划词批注。\n' > "$DOC"
cd "$REPO"
rm -f "$DRAFTBACK_DATA_DIR/port"
DRAFTBACK_PORT=0 node server.js > "$DEV/server.log" 2>&1 &
SERVER=$!
echo "$SERVER" > "$DEV/server.pid"
for i in $(seq 1 40); do [ -s "$DRAFTBACK_DATA_DIR/port" ] && break; sleep 0.25; done
[ -s "$DRAFTBACK_DATA_DIR/port" ] || { echo "服务 10 秒内没起来,看 $DEV/server.log" >&2; kill "$SERVER" 2>/dev/null; exit 1; }
echo "服务 pid=$SERVER 端口=$(cat "$DRAFTBACK_DATA_DIR/port")"
node mdreview.js open "$DOC" --no-open 2>&1 | tail -8
echo "--- 辅助程序跑一轮"
DRAFTBACK_SYNC_INTERVAL=5 "$HELPER" --once
echo "辅助程序退出码 $?"
echo "--- 辅助程序日志"
tail -30 "$DRAFTBACK_DATA_DIR/sync-helper.log" 2>/dev/null
echo "--- 同步状态"
node mdreview.js sync-status 2>&1
if [ "${1:-}" != "keep" ]; then kill "$SERVER" 2>/dev/null; rm -f "$DEV/server.pid"; echo "服务已停"; else echo "服务留着(pid=$SERVER)"; fi
