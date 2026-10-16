#!/usr/bin/env node
'use strict';

// 手机(方案 C)的图片资源:App 图标(6 种封面,含深色、着色)、皮纹、纸纹、火漆印、回形针、图钉。
// 用无头 Chrome 把效果图里同一份 SVG 画成 PNG,放进 ios/Draftback/Assets.xcassets。改纹理或印章后重跑:
//   node branding/export-ios-assets.js
// App 图标不能带透明通道(系统自己切圆角),出图后用 PIL 去掉透明通道。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { startChrome, stopChild, waitUntil } = require('../test/helpers/browser-smoke');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'ios/Draftback/Assets.xcassets');
const ICON_PAGE = path.join(__dirname, 'skin-icon.html');
const SKIN = path.join(ROOT, 'static/skin');
const ALTERNATES = ['mist', 'lavender', 'gold', 'orange', 'black'];

function writeJson(file, object) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(object, null, 2)}\n`); }

async function capture(cdp, url, width, height, scale, out, ready) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await cdp.send('Page.navigate', { url });
  await waitUntil(`加载 ${path.basename(out)}`, () => cdp.evaluate(ready));
  await cdp.evaluate('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))');
  await new Promise((r) => setTimeout(r, 300));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`${path.relative(ROOT, out)} ${width * scale}×${height * scale}`);
}

// 单张 SVG 画成透明底 PNG(纹理按原尺寸平铺用)
function svgPage(svgFile, width, height) {
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}div{width:${width}px;height:${height}px;background:url(${pathToFileURL(svgFile).href}) 0 0/${width}px ${height}px no-repeat}</style><div></div><script>document.body.dataset.ready='1'</script>`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-svg-')), 'page.html');
  fs.writeFileSync(file, html);
  return pathToFileURL(file).href;
}

function imageSet(name, file3x, extra = {}) {
  const dir = path.join(ASSETS, `${name}.imageset`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file3x, path.join(dir, `${name}@3x.png`));
  writeJson(path.join(dir, 'Contents.json'), { images: [{ idiom: 'universal', filename: `${name}@3x.png`, scale: '3x' }], info: { author: 'xcode', version: 1 }, ...extra });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-ios-assets-'));
  const chrome = await startChrome(path.join(tmp, 'profile'));
  try {
    const cdp = chrome.cdp;
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    // 1. App 图标:全出血 1024
    const iconUrl = (theme) => `${pathToFileURL(ICON_PAGE).href}?theme=${theme}&size=1024&full=1`;
    const iconReady = `document.readyState === 'complete' && document.body.dataset.ready === '1' && Boolean(document.querySelector('#seal'))`;
    const raw = {};
    for (const theme of ['green', ...ALTERNATES]) {
      raw[theme] = path.join(tmp, `icon-${theme}.png`);
      await capture(cdp, iconUrl(theme), 1024, 1024, 1, raw[theme], iconReady);
    }
    // 2. 纹理与小物件(按 3 倍出,界面里按点数平铺)
    const tex = (svg, w, h, name) => ({ url: svgPage(path.join(SKIN, svg), w, h), w, h, out: path.join(tmp, `${name}.png`), name });
    const items = [
      tex('leather-fine.svg', 240, 240, 'LeatherGrain'),
      tex('paper-fiber.svg', 300, 300, 'PaperFiber'),
      tex('paper-fiber-night.svg', 300, 300, 'PaperFiberNight'),
      tex('seal.svg', 104, 106, 'Seal'),
      tex('clip.svg', 18, 64, 'PaperClip'),
      tex('pin.svg', 28, 28, 'Pin'),
    ];
    for (const item of items) await capture(cdp, item.url, item.w, item.h, 3, item.out, `document.body.dataset.ready === '1'`);
    // 3. 去掉图标的透明通道;着色图标用灰度
    execFileSync('python3', ['-c', [
      'import sys, json', 'from PIL import Image, ImageOps, ImageEnhance',
      'tmp, assets = sys.argv[1], sys.argv[2]',
      'def rgb(name): return Image.open(f"{tmp}/icon-{name}.png").convert("RGB")',
      'import os',
      'os.makedirs(f"{assets}/AppIcon.appiconset", exist_ok=True)',
      'rgb("green").save(f"{assets}/AppIcon.appiconset/icon-1024.png")',
      'rgb("black").save(f"{assets}/AppIcon.appiconset/icon-1024-dark.png")',
      'gray = ImageEnhance.Contrast(ImageOps.grayscale(rgb("black"))).enhance(1.35)',
      'gray.convert("RGB").save(f"{assets}/AppIcon.appiconset/icon-1024-tinted.png")',
      'for name in sys.argv[3:]:',
      '    os.makedirs(f"{assets}/AppIcon-{name}.appiconset", exist_ok=True)',
      '    rgb(name).save(f"{assets}/AppIcon-{name}.appiconset/icon-1024.png")',
    ].join('\n'), tmp, ASSETS, ...ALTERNATES]);
    writeJson(path.join(ASSETS, 'AppIcon.appiconset/Contents.json'), {
      images: [
        { filename: 'icon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
        { appearances: [{ appearance: 'luminosity', value: 'dark' }], filename: 'icon-1024-dark.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
        { appearances: [{ appearance: 'luminosity', value: 'tinted' }], filename: 'icon-1024-tinted.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
      ],
      info: { author: 'xcode', version: 1 },
    });
    for (const name of ALTERNATES) {
      writeJson(path.join(ASSETS, `AppIcon-${name}.appiconset/Contents.json`), {
        images: [{ filename: 'icon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }], info: { author: 'xcode', version: 1 },
      });
    }
    for (const item of items) imageSet(item.name, item.out);
    console.log('完成');
  } finally {
    await stopChild(chrome.child);
  }
})().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
