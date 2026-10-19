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
# 中文旁的加粗、斜体(「**设立背景。**聚变」)
cp "$SRC/markdown-cjk.js" "$DEST/markdown-cjk.js"
# 回稿卡「显示改动」:与 Mac 对比视图同一套对比算法(纯函数)与字级差异库
cp "$SRC/desktop-diff.js" "$DEST/desktop-diff.js"
cp "$SRC/vendor/diff-match-patch.js" "$DEST/diff-match-patch.js"
# 方案 C 的纸纹、火漆印、回形针、图钉:与 Mac 同一份(static/skin)
mkdir -p "$ROOT/ios/Draftback/Web/skin"
for f in seal.svg clip.svg pin.svg paper-fiber.svg paper-fiber-night.svg; do
  cp "$SRC/skin/$f" "$ROOT/ios/Draftback/Web/skin/$f"
done
echo "已同步渲染内核到 $DEST"
