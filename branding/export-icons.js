#!/usr/bin/env node
'use strict';

// 方案 C 图标出图:用无头 Chrome 打开 skin-icon.html,出透明底 PNG,再拼 macOS 的 icon.icns。
// 用法: node branding/export-icons.js
// 产物:desktop/build/icon.png(1024)、desktop/build/icon.icns、desktop/dock-icon.png(512,默认淡绿)、
//      desktop/dock-icons/<封面>.png(512,另外 5 种,设置里「程序坞图标跟着封面换」用)、static/brand/icon-256.png(欢迎页)、
//      desktop/build/icon.ico(Windows)、branding/icon-1024.png 与 desktop/build/icon-source-fullbleed.png(全出血方块)。
// iOS 的图标(ios/…/AppIcon.appiconset)不在这里出:改手机界面时用全出血的 branding/icon-1024.png 另出。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { startChrome, stopChild, waitUntil } = require('../test/helpers/browser-smoke');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(__dirname, 'skin-icon.html');
// 默认淡绿用 desktop/dock-icon.png;其余 5 种各一张
const COVERS = ['mist', 'lavender', 'gold', 'orange', 'black'];

async function shoot(cdp, theme, size, out, { full = false } = {}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${pathToFileURL(PAGE).href}?theme=${theme}&size=${size}${full ? '&full=1' : ''}` });
  await waitUntil(`图标页 ${theme} ${size}`, () => cdp.evaluate(`document.readyState === 'complete' && document.body.dataset.ready === '1' && Boolean(document.querySelector('#seal'))`));
  await cdp.evaluate('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))');
  await new Promise((r) => setTimeout(r, 300)); // SVG 纹理是异步栅格化的,等一下再截
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 }, captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`${path.relative(ROOT, out)} ${size}×${size}`);
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-icons-'));
  const chrome = await startChrome(profile);
  try {
    const cdp = chrome.cdp;
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await shoot(cdp, 'green', 1024, path.join(ROOT, 'desktop/build/icon.png'));
    await shoot(cdp, 'green', 1024, path.join(ROOT, 'branding/icon-1024.png'), { full: true });
    fs.copyFileSync(path.join(ROOT, 'branding/icon-1024.png'), path.join(ROOT, 'desktop/build/icon-source-fullbleed.png'));
    // Windows:和 scripts/make-icons.py 一样,从全出血方块切 40/256 的圆角
    execFileSync('python3', ['-c', [
      'import sys', 'from PIL import Image, ImageDraw',
      'src = Image.open(sys.argv[1]).convert("RGB").resize((256, 256), Image.LANCZOS)',
      'mask = Image.new("L", (1024, 1024), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, 1023, 1023], radius=160, fill=255)',
      'win = src.convert("RGBA"); win.putalpha(mask.resize((256, 256), Image.LANCZOS))',
      'win.save(sys.argv[2], sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])',
    ].join('\n'), path.join(ROOT, 'branding/icon-1024.png'), path.join(ROOT, 'desktop/build/icon.ico')]);
    console.log('desktop/build/icon.ico');
    await shoot(cdp, 'green', 512, path.join(ROOT, 'desktop/dock-icon.png'));
    await shoot(cdp, 'green', 256, path.join(ROOT, 'static/brand/icon-256.png'));
    for (const cover of COVERS) await shoot(cdp, cover, 512, path.join(ROOT, `desktop/dock-icons/${cover}.png`));
    // icon.icns:每个尺寸单独出图(小尺寸直接按小画布排版,比缩小大图清楚)
    const iconset = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-iconset-')), 'icon.iconset');
    fs.mkdirSync(iconset);
    for (const base of [16, 32, 128, 256, 512]) {
      await shoot(cdp, 'green', base, path.join(iconset, `icon_${base}x${base}.png`));
      await shoot(cdp, 'green', base * 2, path.join(iconset, `icon_${base}x${base}@2x.png`));
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ROOT, 'desktop/build/icon.icns')]);
    console.log('desktop/build/icon.icns');
  } finally {
    await stopChild(chrome.child);
  }
})().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
