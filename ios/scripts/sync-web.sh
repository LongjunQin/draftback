#!/bin/bash
# 把桌面端的渲染内核(第三方库 + 锚点模块)同步进 iOS 工程的 Web 目录,保证手机与 Mac 用同一套渲染代码。
# 用法: ios/scripts/sync-web.sh   (xcodegen 之前运行一次;静态文件改动后再运行)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/static"
DEST="$ROOT/ios/Draftback/Web/vendor"
mkdir -p "$DEST"
for f in markdown-it.min.js katex.min.js katex.min.css texmath.min.js highlight.min.js highlight-github.min.css mermaid.min.js dompurify.min.js; do
  cp "$SRC/vendor/$f" "$DEST/$f"
done
rm -rf "$DEST/fonts" && cp -R "$SRC/vendor/fonts" "$DEST/fonts"
cp "$SRC/desktop-anchor.js" "$DEST/desktop-anchor.js"
# 回稿卡「显示改动」:与 Mac 对比视图同一套对比算法(纯函数)与字级差异库
cp "$SRC/desktop-diff.js" "$DEST/desktop-diff.js"
cp "$SRC/vendor/diff-match-patch.js" "$DEST/diff-match-patch.js"
echo "已同步渲染内核到 $DEST"
