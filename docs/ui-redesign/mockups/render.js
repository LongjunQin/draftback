// 效果图出图:node docs/ui-redesign/mockups/render.js <mockups 目录> <输出目录> [名字...](出 PNG;放进文档前转成 JPEG:sips -s format jpeg -s formatOptions 88)
// 先用 CDP 按一倍量出 .board 尺寸,再用 Chrome 自带的 --screenshot 按两倍出图(CDP 两倍截大图会让页面崩掉)。
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { pathToFileURL } = require('node:url'); const { execFileSync } = require('node:child_process');
const { waitUntil, stopChild, startChrome, chromeExecutable } = require(path.join(__dirname, '../../../test/helpers/browser-smoke'));
const [mockDir, outDir, ...names] = process.argv.slice(2);
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const files = names.length ? names.map((n) => `${n}.html`) : fs.readdirSync(mockDir).filter((f) => f.endsWith('.html') && !f.startsWith('_'));
  const sizes = {};
  const chrome = await startChrome(fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-measure-')));
  try {
    for (const file of files) {
      await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
      await chrome.cdp.send('Page.navigate', { url: pathToFileURL(path.join(mockDir, file)).href });
      await waitUntil(`加载 ${file}`, () => chrome.cdp.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('.board'))`));
      await chrome.cdp.evaluate('document.fonts.ready.then(() => true)');
      sizes[file] = await chrome.cdp.evaluate(`(() => { const b = document.querySelector('.board').getBoundingClientRect(); return { w: Math.ceil(b.width), h: Math.ceil(b.height) }; })()`);
    }
    if (chrome.cdp.exceptions.length) console.log('页面异常:', chrome.cdp.exceptions.join(' | '));
  } finally { await stopChild(chrome.child); }
  for (const file of files) {
    const { w, h } = sizes[file];
    const out = path.join(outDir, file.replace(/\.html$/, '.png'));
    execFileSync(chromeExecutable(), ['--headless=new', '--disable-gpu', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-shot-'))}`,
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=2', '--virtual-time-budget=4000',
      `--window-size=${w},${h}`, `--screenshot=${out}`, pathToFileURL(path.join(mockDir, file)).href], { stdio: 'ignore', timeout: 180000 });
    console.log(`${file} → ${path.basename(out)} ${w}×${h}`);
  }
})().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
