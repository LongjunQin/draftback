#!/usr/bin/env node
'use strict';

// 阅读器小件的真实浏览器冒烟(路线图 v3 第一轮阅读器线):查找、深色模式、打印样式、拖放提示、拖入手机批次导入。
// 另外把深色与打印两种外观截图到 --shots <目录>,供人工过目。
//
// 用法: node test/desktop-reader-tools-smoke.js [--shots /tmp/shots]

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/review-store');
const { sleep, waitUntil, stopChild, startServer, startChrome } = require('./helpers/browser-smoke');

const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;

async function screenshot(cdp, file) {
  if (!shotsDir) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotsDir, file), Buffer.from(data, 'base64'));
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-tools-smoke-')));
  const dataDir = path.join(root, '.mdread');
  const docRoot = path.join(root, 'docs');
  const profileDir = path.join(root, 'chrome-profile');
  const source = path.join(docRoot, '工具冒烟.md');
  let server = null;
  let chrome = null;
  try {
    fs.mkdirSync(docRoot, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(source, [
      '# 工具冒烟', '',
      '第一段提到苹果。', '',
      '> 引用块里也提到苹果,还有 **粗体苹果**。', '',
      '| 列 | 值 |', '|---|---|', '| 苹果 | 1 |', '',
      '```js', 'const apple = "苹果";', '```', '',
      '<details><summary>折叠</summary>折叠里的苹果</details>', '',
      '![同目录图片](smoke.svg) 与 [附件链接](smoke.svg)', '',
      '最后一段没有水果。', '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(docRoot, 'smoke.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#f59a23"/></svg>', 'utf8');
    store.ensureDataDir({ dataDir });
    await store.openReview(source, { dataDir });

    server = await startServer(dataDir);
    chrome = await startChrome(profileDir);
    await chrome.cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });
    await waitUntil('最近文件', () => chrome.cdp.evaluate(`document.readyState === 'complete' && document.querySelector('#welcomeRecent .recent-item')`));
    await chrome.cdp.evaluate(`document.querySelector('#welcomeRecent .recent-item').click()`);
    await waitUntil('正文渲染', () => chrome.cdp.evaluate(`document.querySelector('#documentContent').textContent.includes('最后一段')`));

    // 1. 查找:Cmd+F 打开,输入后计数,Enter 下一个,Esc 关闭。
    await chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', modifiers: 4, windowsVirtualKeyCode: 70 });
    await chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: 4, windowsVirtualKeyCode: 70 });
    await waitUntil('查找栏打开', () => chrome.cdp.evaluate(`!document.querySelector('#findBar').hidden && document.activeElement === document.querySelector('#findInput')`));
    await chrome.cdp.send('Input.insertText', { text: '苹果' });
    await waitUntil('计数', () => chrome.cdp.evaluate(`document.querySelector('#findCount').textContent === '1 / 6'`));
    assert.equal(await chrome.cdp.evaluate(`CSS.highlights.has('mdturn-find') && CSS.highlights.has('mdturn-find-current')`), true, '查找命中必须用高亮标出');
    await chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitUntil('下一个', () => chrome.cdp.evaluate(`document.querySelector('#findCount').textContent === '2 / 6'`));
    await chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 8, windowsVirtualKeyCode: 13 });
    await waitUntil('上一个', () => chrome.cdp.evaluate(`document.querySelector('#findCount').textContent === '1 / 6'`));
    await chrome.cdp.evaluate(`(() => { const i = document.querySelector('#findInput'); i.value = '不存在的词'; i.dispatchEvent(new Event('input')); })()`);
    await waitUntil('无命中', () => chrome.cdp.evaluate(`document.querySelector('#findBar').classList.contains('no-match') && document.querySelector('#findCount').textContent === '0 / 0'`));
    await chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitUntil('查找栏关闭', () => chrome.cdp.evaluate(`document.querySelector('#findBar').hidden && !CSS.highlights.has('mdturn-find')`));
    await screenshot(chrome.cdp, 'light-reading.png');

    // 2. 深色模式:模拟系统深色,壳与正文背景都应变暗,文字变亮。
    await chrome.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(200);
    const dark = await chrome.cdp.evaluate(`(() => {
      const lum = (color) => { const m = color.match(/\\d+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
      return {
        shell: lum(getComputedStyle(document.body).backgroundColor),
        paper: lum(getComputedStyle(document.querySelector('#readerScroll')).backgroundColor),
        text: lum(getComputedStyle(document.querySelector('#documentContent p')).color),
        code: lum(getComputedStyle(document.querySelector('#documentContent pre')).backgroundColor),
        card: lum(getComputedStyle(document.querySelector('#openNotesList')).backgroundColor),
        titlebar: lum(getComputedStyle(document.querySelector('.titlebar')).backgroundColor),
        toolbar: lum(getComputedStyle(document.querySelector('#documentToolbar')).backgroundColor),
        outlineFont: parseFloat(getComputedStyle(document.querySelector('#outlinePanel .outline-link')).fontSize),
      };
    })()`);
    assert.ok(dark.shell < 0.25, `深色下外壳背景应很暗,实际亮度 ${dark.shell}`);
    assert.ok(dark.paper < 0.25, `深色下正文背景应很暗,实际亮度 ${dark.paper}`);
    assert.ok(dark.text > 0.7, `深色下正文文字应很亮,实际亮度 ${dark.text}`);
    assert.ok(dark.code < 0.3, `深色下代码块背景应很暗,实际亮度 ${dark.code}`);
    assert.ok(dark.titlebar < 0.25, `深色下标签栏不得仍是浅色,实际亮度 ${dark.titlebar}`);
    assert.ok(dark.toolbar < 0.25, `深色下工具栏不得仍是浅色,实际亮度 ${dark.toolbar}`);
    assert.ok(dark.outlineFont >= 13, `大纲字号应不小于 13px,实际 ${dark.outlineFont}`);
    await screenshot(chrome.cdp, 'dark-reading.png');
    await chrome.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

    // 3. 打印样式:左右栏、工具栏、顶栏不可见,正文可见;折叠块在 beforeprint 时展开。
    await chrome.cdp.evaluate(`window.dispatchEvent(new Event('beforeprint'))`);
    await chrome.cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(200);
    const print = await chrome.cdp.evaluate(`(() => {
      const visible = (selector) => { const node = document.querySelector(selector); if (!node) return null; const style = getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden'; };
      return { left: visible('#leftSidebar'), right: visible('#rightSidebar'), toolbar: visible('#documentToolbar'), titlebar: visible('.titlebar'), content: visible('#documentContent'), detailsOpen: document.querySelector('#documentContent details').open };
    })()`);
    assert.deepEqual({ left: print.left, right: print.right, toolbar: print.toolbar, titlebar: print.titlebar, content: print.content }, { left: false, right: false, toolbar: false, titlebar: false, content: true }, JSON.stringify(print));
    assert.equal(print.detailsOpen, true, '打印时折叠块必须展开');
    await screenshot(chrome.cdp, 'print-preview.png');
    await chrome.cdp.send('Emulation.setEmulatedMedia', { media: '' });
    await chrome.cdp.evaluate(`window.dispatchEvent(new Event('afterprint'))`);
    assert.equal(await chrome.cdp.evaluate(`document.querySelector('#documentContent details').open`), false, '打印后折叠块恢复原状');

    // 4. 拖放提示:拖入文件时出现遮罩,离开后消失。
    await chrome.cdp.evaluate(`(() => {
      const dt = new DataTransfer();
      const enter = new DragEvent('dragenter', { bubbles: true, dataTransfer: dt });
      Object.defineProperty(enter, 'dataTransfer', { value: { types: ['Files'], files: [] } });
      window.dispatchEvent(enter);
    })()`);
    await waitUntil('拖放遮罩出现', () => chrome.cdp.evaluate(`!document.querySelector('#dropOverlay').hidden`));
    await chrome.cdp.evaluate(`(() => {
      const leave = new DragEvent('dragleave', { bubbles: true });
      Object.defineProperty(leave, 'dataTransfer', { value: { types: ['Files'], files: [] } });
      window.dispatchEvent(leave);
    })()`);
    await waitUntil('拖放遮罩消失', () => chrome.cdp.evaluate(`document.querySelector('#dropOverlay').hidden`));

    // 5. 拖入手机批注批次:页面读出文件内容提交(不靠服务按路径读「下载」),会话收到批注进入待改稿;坏文件给提示。
    const review = await store.getReviewByPath(source, { dataDir });
    const batch = {
      version: 1, batchId: 'smoke-batch-0001', documentName: '工具冒烟.md', baseVersion: review.sourceHash,
      completedAt: new Date().toISOString(), device: '冒烟 iPhone',
      annotations: [{ id: 'phone-note-1', comment: '手机上提的意见', quote: '第一段', anchorVersion: 3, lineStart: 3, lineEnd: 3, startTextOffset: 0, endTextOffset: 3 }],
    };
    const dropFile = (text, name) => chrome.cdp.evaluate(`(() => {
      const file = new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'application/json' });
      const drop = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
      window.dispatchEvent(drop);
    })()`);
    await dropFile(JSON.stringify(batch), '工具冒烟.smoke0001.mdturn-batch.json');
    await waitUntil('拖入批次后会话进入待改稿', async () => {
      const current = await store.getReviewById(review.id, { dataDir });
      return current && current.status === 'ready_to_apply';
    });
    assert.equal(store.readAnnotations(source).annotations.filter((note) => note.receivedBatchId === 'smoke-batch-0001').length, 1);
    await waitUntil('导入成功提示', () => chrome.cdp.evaluate(`Array.from(document.querySelectorAll('#toastRegion .toast')).some((item) => item.textContent.includes('已接收手机批注 1 条'))`));
    await dropFile('不是 JSON', '坏的.mdturn-batch.json');
    await waitUntil('坏批次提示', () => chrome.cdp.evaluate(`Array.from(document.querySelectorAll('#toastRegion .toast')).some((item) => item.textContent.includes('不是有效的批注批次文件'))`));

    // 6. 导出单文件 HTML:工具栏「导出」菜单 → 导出为 HTML。浏览器里没有外壳,走下载;这里截住生成的 Blob 读内容:
    //    文件应自带样式、图片内联、链接还原为相对路径,不引用本地服务。
    await chrome.cdp.evaluate(`(() => {
      window.__mdturnExportBlobs = [];
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__mdturnExportBlobs.push(blob); return original(blob); };
    })()`);
    await chrome.cdp.evaluate(`document.querySelector('#exportMenuButton').click()`);
    await waitUntil('导出菜单打开', () => chrome.cdp.evaluate(`!document.querySelector('#exportMenu').hidden`));
    await screenshot(chrome.cdp, 'export-menu.png');
    await chrome.cdp.evaluate(`document.querySelector('#exportMenu button[data-command="export-html"]').click()`);
    await waitUntil('HTML 导出完成提示', () => chrome.cdp.evaluate(`Array.from(document.querySelectorAll('#toastRegion .toast')).some((item) => item.textContent.includes('HTML 已导出'))`));
    const html = await chrome.cdp.evaluate(`window.__mdturnExportBlobs.length ? window.__mdturnExportBlobs[0].text() : null`);
    assert.ok(html, '应生成 HTML 文件内容');
    assert.equal(await chrome.cdp.evaluate(`document.querySelector('#exportMenu').hidden`), true, '点击菜单项后菜单应关闭');
    assert.match(html, /<title>工具冒烟\.md<\/title>/);
    assert.match(html, /\.markdown-body\s*\{/, '应内联正文样式');
    assert.match(html, /\.hljs/, '应内联代码高亮样式');
    assert.match(html, /<img[^>]+src="data:image\/svg\+xml/, '同目录图片应内联为 data: URI');
    assert.match(html, /<a[^>]+href="smoke\.svg"/, '附件链接应还原为相对路径');
    assert.doesNotMatch(html, /\/api\/app\/file/, '导出文件不得引用本地服务地址');
    assert.match(html, /折叠里的苹果/);

    // 7. 新建:左栏「新建 Markdown 文档」→(浏览器里用路径输入框)→ 文件建好、进入编辑模式、计入最近文件;再次新建同名文件不覆盖。
    const fresh = path.join(docRoot, '新建冒烟.md');
    await chrome.cdp.evaluate(`document.querySelector('#filesModeButton').click()`);
    chrome.cdp.nextPromptText = fresh;
    await chrome.cdp.evaluate(`document.querySelector('#newFileButton').click()`);
    await waitUntil('新建文件已写入并进入编辑', () => {
      if (!fs.existsSync(fresh)) return null;
      return chrome.cdp.evaluate(`!document.querySelector('#editorPane').hidden && document.querySelector('#tabList .tab.active .tab-title').textContent.includes('新建冒烟.md')`);
    });
    assert.equal(fs.readFileSync(fresh, 'utf8'), '# 新建冒烟\n\n');
    await chrome.cdp.evaluate(`document.querySelector('#readingModeButton').click()`);
    await waitUntil('退出编辑', () => chrome.cdp.evaluate(`document.querySelector('#editorPane').hidden`));
    fs.writeFileSync(fresh, '# 已有内容\n');
    chrome.cdp.nextPromptText = fresh;
    await chrome.cdp.evaluate(`document.querySelector('#newFileButton').click()`);
    await waitUntil('同名文件不覆盖并提示', () => chrome.cdp.evaluate(`Array.from(document.querySelectorAll('#toastRegion .toast')).some((item) => item.textContent.includes('已经存在'))`));
    assert.equal(fs.readFileSync(fresh, 'utf8'), '# 已有内容\n', '新建不得覆盖已有文件');

    const fatal = chrome.cdp.exceptions.filter((item) => !/favicon/i.test(item));
    assert.deepEqual(fatal, [], `页面不得抛出未处理异常:\n${fatal.join('\n')}`);
    console.log('PASS: 查找(计数/上下/高亮/关闭)、深色模式、打印样式、拖放提示、拖入手机批次导入、导出单文件 HTML、新建文档。');
  } finally {
    if (chrome) { try { chrome.cdp.socket && chrome.cdp.socket.close(); } catch (_) {} await stopChild(chrome.child); }
    if (server) await stopChild(server.child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
