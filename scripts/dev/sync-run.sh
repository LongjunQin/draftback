#!/bin/bash
# 同步联调(常驻):用单独的数据目录起本地服务,再起同步辅助程序(服务退出时它跟着退出)。
# 不碰正在用的 ~/.draftback。辅助程序用这台 Mac 登录的 iCloud(开发环境):推上去的稿子,装了测试版的手机上看得到。
# 先用 mac-sync/scripts/build.sh 构建辅助程序。
#
# 用法:
#   scripts/dev/sync-run.sh          # 启动,打印端口和进程号
#   scripts/dev/sync-run.sh stop     # 停止
# 环境变量:DRAFTBACK_DEV_DIR 联调目录(默认 $TMPDIR/draftback-sync-dev)、DRAFTBACK_SYNC_INTERVAL 同步间隔秒数(默认 10)。
# 操作这套环境:DRAFTBACK_DATA_DIR="<联调目录>/data" node mdreview.js …
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEV="${DRAFTBACK_DEV_DIR:-${TMPDIR:-/tmp}/draftback-sync-dev}"
HELPER="$REPO/mac-sync/build/Draftback Sync.app/Contents/MacOS/Draftback Sync"
export DRAFTBACK_DATA_DIR="$DEV/data"
mkdir -p "$DRAFTBACK_DATA_DIR"
if [ "${1:-}" = "stop" ]; then
  # 只停这里起的进程(按进程号),不碰正在用的回稿和它的同步程序
  for f in helper server; do [ -f "$DEV/$f.pid" ] && kill "$(cat "$DEV/$f.pid")" 2>/dev/null; rm -f "$DEV/$f.pid"; done
  echo "已停止"; exit 0
fi
[ -x "$HELPER" ] || { echo "没有辅助程序:先跑 mac-sync/scripts/build.sh" >&2; exit 1; }
cd "$REPO"
rm -f "$DRAFTBACK_DATA_DIR/port"
DRAFTBACK_PORT=0 nohup node server.js >> "$DEV/server.log" 2>&1 &
echo $! > "$DEV/server.pid"
for i in $(seq 1 40); do [ -s "$DRAFTBACK_DATA_DIR/port" ] && break; sleep 0.25; done
[ -s "$DRAFTBACK_DATA_DIR/port" ] || { echo "服务 10 秒内没起来,看 $DEV/server.log" >&2; exit 1; }
DRAFTBACK_PARENT_PID="$(cat "$DEV/server.pid")" DRAFTBACK_SYNC_INTERVAL="${DRAFTBACK_SYNC_INTERVAL:-10}" nohup "$HELPER" > /dev/null 2>&1 &
echo $! > "$DEV/helper.pid"
echo "服务 pid=$(cat "$DEV/server.pid") 端口=$(cat "$DRAFTBACK_DATA_DIR/port");辅助程序 pid=$(cat "$DEV/helper.pid")"
echo "数据目录 $DRAFTBACK_DATA_DIR"
