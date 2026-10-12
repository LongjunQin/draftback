#!/usr/bin/env python3
"""从一张 1024×1024 全出血方形图生成三端图标。

用法: python3 scripts/make-icons.py branding/icon-1024.png

产出:
  ios/MDTurn/Assets.xcassets/AppIcon.appiconset/   iOS 单尺寸 1024(不带透明通道,系统自己切圆角)
  desktop/build/icon.png                            macOS:824 圆角方块居中放在 1024 透明画布上,带投影(苹果规范)
  desktop/build/icon-source-fullbleed.png           原图备份
  desktop/build/icon.ico                            Windows:256/128/64/48/32/16 圆角版
  desktop/dock-icon.png                             运行时设给 Dock 的图标(绕过系统图标缓存)
  static/brand/icon-256.png                         桌面端界面里的品牌标
electron-builder 打包时自动把 icon.png 转成 icns。
"""
import json
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent


def rounded_mask(size, radius, scale=4):
    big = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle([0, 0, size * scale - 1, size * scale - 1], radius=radius * scale, fill=255)
    return big.resize((size, size), Image.LANCZOS)


def rounded(img, radius):
    out = img.convert("RGBA")
    out.putalpha(rounded_mask(img.width, radius))
    return out


def mac_icon(src):
    """苹果规范:图形占 824/1024,圆角约 22.37%,其余留透明边,再加一层柔和投影。"""
    inner = 824
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    tile = rounded(src.resize((inner, inner), Image.LANCZOS), round(inner * 0.2237))
    offset = (1024 - inner) // 2
    shadow = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    shadow_mask = Image.new("L", (1024, 1024), 0)
    shadow_mask.paste(tile.getchannel("A"), (offset, offset + 12))
    shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(18))
    shadow.putalpha(shadow_mask.point(lambda v: int(v * 0.30)))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(tile, (offset, offset))
    return canvas


def main(source):
    src = Image.open(source).convert("RGB")
    if src.size != (1024, 1024):
        sys.exit(f"源图必须是 1024×1024,现在是 {src.size}")

    ios_dir = ROOT / "ios/MDTurn/Assets.xcassets/AppIcon.appiconset"
    ios_dir.mkdir(parents=True, exist_ok=True)
    (ROOT / "ios/MDTurn/Assets.xcassets/Contents.json").write_text(json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2) + "\n")
    src.save(ios_dir / "icon-1024.png", optimize=True)
    (ios_dir / "Contents.json").write_text(json.dumps({
        "images": [{"filename": "icon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
        "info": {"author": "xcode", "version": 1},
    }, indent=2) + "\n")

    build = ROOT / "desktop/build"
    build.mkdir(parents=True, exist_ok=True)
    src.save(build / "icon-source-fullbleed.png", optimize=True)
    mac = mac_icon(src)
    mac.save(build / "icon.png", optimize=True)
    # 运行时 app.dock.setIcon 用:绕过 macOS 的图标缓存,保证 Dock 里立刻是新图标
    mac.resize((512, 512), Image.LANCZOS).save(ROOT / "desktop/dock-icon.png", optimize=True)
    # 桌面端界面里的品牌标(标题栏、欢迎页),CSS 自己切圆角
    brand = ROOT / "static/brand"; brand.mkdir(parents=True, exist_ok=True)
    src.resize((256, 256), Image.LANCZOS).save(brand / "icon-256.png", optimize=True)
    win = rounded(src.resize((256, 256), Image.LANCZOS), 40)
    win.save(build / "icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print("已生成:", ios_dir / "icon-1024.png", build / "icon.png", build / "icon.ico", sep="\n  ")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
