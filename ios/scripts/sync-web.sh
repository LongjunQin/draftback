#!/bin/bash
# 把桌面端的渲染内核(第三方库 + 锚点模块)同步进 iOS 工程的 Web 目录,保证手机与 Mac 用同一套渲染代码。
# 用法: ios/scripts/sync-web.sh   (xcodegen 之前运行一次;静态文件改动后再运行)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/static"
DEST="$ROOT/ios/MDTurn/Web/vendor"
mkdir -p "$DEST"
for f in markdown-it.min.js katex.min.js katex.min.css texmath.min.js highlight.min.js highlight-github.min.css mermaid.min.js dompurify.min.js; do
  cp "$SRC/vendor/$f" "$DEST/$f"
done
rm -rf "$DEST/fonts" && cp -R "$SRC/vendor/fonts" "$DEST/fonts"
cp "$SRC/desktop-anchor.js" "$DEST/desktop-anchor.js"
echo "已同步渲染内核到 $DEST"
