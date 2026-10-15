#!/usr/bin/env node
'use strict';

// 在回稿里改名(2026-10-15 用户要的功能)的真实浏览器冒烟:
//   1. 双击文件名:就地变成输入框(信息卡不闪出来),回车改名;磁盘上的文件、标签、左栏跟着变。
//   2. 单击文件名照旧开信息卡;卡里「重新命名…」也能改;Esc 取消,什么都不动。
//   3. 同一文件夹里已有同名文件:提示,输入框留着让你改。
//   4. 这一轮还没走完:提示「走完再改名」,不出输入框。
//   5. 有审阅历史的文档改名后,批注和历史跟着走(标签还是同一轮)。
//
// 用法: node test/desktop-rename-smoke.js   (需要本机有 Google Chrome / Chromium)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/review-store');
const { sleep, waitUntil, stopChild, startServer, startChrome } = require('./helpers/browser-smoke');

async function mouseClick(cdp, selector, clickCount = 1) {
  const point = await cdp.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  for (let count = 1; count <= clickCount; count += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: count });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: count });
  }
}
async function pressKey(cdp, key, code, keyCode) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}
async function typeName(cdp, text) {
  await cdp.evaluate(`document.querySelector('.doc-title-input').select()`);
  await cdp.send('Input.insertText', { text });
}
const titleText = `document.querySelector('#docTitleText').textContent`;
const lastToast = `(() => { const items = document.querySelectorAll('.toast-region .toast, .toast-region > *'); return items.length ? items[items.length - 1].textContent : ''; })()`;

async function openPath(cdp, filePath) {
  cdp.nextPromptText = filePath;
  await cdp.evaluate(`(!document.querySelector('#welcome').hidden ? document.querySelector('#welcomeOpenButton') : document.querySelector('#openTabButton')).click()`);
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-rename-smoke-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  let server = null;
  let chrome = null;
  try {
    fs.mkdirSync(docDir, { recursive: true });
    const plain = path.join(docDir, '未命名.md');
    fs.writeFileSync(plain, '# 未命名\n\n随手写的一段。\n');
    fs.writeFileSync(path.join(docDir, '月报.md'), '# 月报\n');
    store.ensureDataDir({ dataDir });
    server = await startServer(dataDir);
    chrome = await startChrome(path.join(root, 'chrome-profile'));
    const { cdp } = chrome;
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });
    await waitUntil('欢迎页就绪', () => cdp.evaluate(`document.readyState === 'complete' && !document.querySelector('#welcome').hidden`));
    await openPath(cdp, plain);
    await waitUntil('普通文档打开', () => cdp.evaluate(`${titleText} === '未命名.md' && !document.querySelector('#docTitleButton').hidden`));

    // 1. 双击:就地改名,信息卡不闪出来
    await mouseClick(cdp, '#docTitleButton', 2);
    await waitUntil('输入框出现', () => cdp.evaluate(`Boolean(document.querySelector('.doc-title-input')) && document.activeElement === document.querySelector('.doc-title-input')`));
    assert.equal(await cdp.evaluate(`document.querySelector('.doc-title-input').value`), '未命名', '输入框里是不带扩展名的名字');
    await sleep(350);
    assert.equal(await cdp.evaluate(`document.querySelector('#docInfoPopover').hidden`), true, '双击不打开信息卡');
    assert.equal(await cdp.evaluate(`document.querySelector('#docTitleButton').hidden`), true, '改名时原来的标题藏起来');
    await typeName(cdp, '周报');
    await pressKey(cdp, 'Enter', 'Enter', 13);
    await waitUntil('改名完成', () => cdp.evaluate(`${titleText} === '周报.md' && !document.querySelector('.doc-title-input') && !document.querySelector('#docTitleButton').hidden`));
    assert.ok(fs.existsSync(path.join(docDir, '周报.md')), '磁盘上是新名字');
    assert.equal(fs.existsSync(plain), false, '旧名字不在了');
    await waitUntil('标签与左栏跟着变', () => cdp.evaluate(`document.querySelector('#tabList .tab.active') ? document.querySelector('#tabList .tab.active').textContent.includes('周报.md') : true`));

    // 2. 单击开信息卡;卡里「重新命名…」;Esc 取消
    await mouseClick(cdp, '#docTitleButton', 1);
    await waitUntil('单击打开信息卡', () => cdp.evaluate(`!document.querySelector('#docInfoPopover').hidden`));
    const renameButton = await cdp.evaluate(`Array.from(document.querySelectorAll('#docInfoPopover button')).map((b) => b.textContent)`);
    assert.ok(renameButton.includes('重新命名…'), `信息卡里有「重新命名…」:${renameButton.join(' / ')}`);
    await cdp.evaluate(`Array.from(document.querySelectorAll('#docInfoPopover button')).find((b) => b.textContent === '重新命名…').click()`);
    await waitUntil('信息卡收起、输入框出现', () => cdp.evaluate(`document.querySelector('#docInfoPopover').hidden && Boolean(document.querySelector('.doc-title-input'))`));
    await typeName(cdp, '不要这个名字');
    await pressKey(cdp, 'Escape', 'Escape', 27);
    await waitUntil('Esc 取消', () => cdp.evaluate(`!document.querySelector('.doc-title-input') && ${titleText} === '周报.md'`));
    assert.ok(fs.existsSync(path.join(docDir, '周报.md')));
    assert.equal(fs.existsSync(path.join(docDir, '不要这个名字.md')), false);

    // 3. 同名文件已存在:提示,输入框留着
    await mouseClick(cdp, '#docTitleButton', 2);
    await waitUntil('输入框出现', () => cdp.evaluate(`Boolean(document.querySelector('.doc-title-input'))`));
    await typeName(cdp, '月报');
    await pressKey(cdp, 'Enter', 'Enter', 13);
    await waitUntil('同名提示', () => cdp.evaluate(`${lastToast}.includes('已经有「月报.md」')`));
    assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.doc-title-input'))`), true, '输入框留着让你改');
    assert.equal(fs.readFileSync(path.join(docDir, '月报.md'), 'utf8'), '# 月报\n', '已有的文件不动');
    await pressKey(cdp, 'Escape', 'Escape', 27);
    await waitUntil('收起', () => cdp.evaluate(`!document.querySelector('.doc-title-input')`));

    // 3b. 改名输入了新名字,直接点另一个标签:取消改名,不提交(失焦先于切换触发,以前会把名字改掉)
    const second = path.join(docDir, '第二篇.md');
    fs.writeFileSync(second, '# 第二篇\n');
    await openPath(cdp, second);
    await waitUntil('第二篇打开', () => cdp.evaluate(`${titleText} === '第二篇.md' && document.querySelectorAll('#tabList .tab').length >= 2`));
    await mouseClick(cdp, '#docTitleButton', 2);
    await waitUntil('输入框出现', () => cdp.evaluate(`Boolean(document.querySelector('.doc-title-input'))`));
    await typeName(cdp, '不该改成这个');
    const otherTab = await cdp.evaluate(`(() => { const tab = Array.from(document.querySelectorAll('#tabList .tab')).find((t) => t.textContent.includes('周报')); tab.id = tab.id || 'rename-smoke-other-tab'; return '#' + tab.id; })()`);
    await mouseClick(cdp, otherTab, 1);
    await waitUntil('切到另一篇', () => cdp.evaluate(`${titleText} === '周报.md' && !document.querySelector('.doc-title-input')`));
    await sleep(300);
    assert.ok(fs.existsSync(second), '点别的标签不提交改名');
    assert.equal(fs.existsSync(path.join(docDir, '不该改成这个.md')), false);

    // 4. 这一轮还没走完:不出输入框
    const active = path.join(docDir, '审阅中.md');
    fs.writeFileSync(active, '# 审阅中\n\n正文。\n');
    const { review } = await store.openReview(active, { dataDir });
    fs.writeFileSync(`${active}.annotations.json`, JSON.stringify({ version: 1, file: '审阅中.md', annotations: [] }));
    await openPath(cdp, active);
    await waitUntil('审阅中的文档打开', () => cdp.evaluate(`${titleText} === '审阅中.md' && document.querySelector('#reviewStateText').textContent.includes('批注中')`));
    await mouseClick(cdp, '#docTitleButton', 2);
    await waitUntil('走完再改名', () => cdp.evaluate(`${lastToast}.includes('走完再改名')`));
    assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.doc-title-input'))`), false);

    // 5. 有审阅历史:这一轮走完(零批注通过)后改名,还是同一轮的标签,批注文件跟着走
    await store.submitReview(review.id, { dataDir });
    await cdp.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await waitUntil('本轮结束', () => cdp.evaluate(`!document.querySelector('#reviewStateText').textContent.includes('批注中')`), 20_000);
    await mouseClick(cdp, '#docTitleButton', 2);
    await waitUntil('输入框出现', () => cdp.evaluate(`Boolean(document.querySelector('.doc-title-input'))`));
    await typeName(cdp, '审阅过的方案');
    await pressKey(cdp, 'Enter', 'Enter', 13);
    await waitUntil('改名完成', () => cdp.evaluate(`${titleText} === '审阅过的方案.md'`));
    assert.ok(fs.existsSync(path.join(docDir, '审阅过的方案.md.annotations.json')), '批注文件跟着新名字');
    assert.equal((await store.getReviewById(review.id, { dataDir })).absPath, path.join(docDir, '审阅过的方案.md'));

    const errors = cdp.exceptions.concat(cdp.consoleMessages.filter((m) => m.type === 'error').map((m) => m.text)).filter((text) => !/favicon|ERR_|net::|Failed to load resource/.test(text));
    assert.deepEqual(errors, [], `页面不应有脚本异常或 console.error: ${errors.join(' | ')}`);
    console.log('PASS: 双击就地改名、单击开信息卡、卡里重新命名、Esc 取消、同名提示、点别的标签不提交、这一轮没走完不改、审阅历史跟着走。');
  } finally {
    if (chrome) await stopChild(chrome.child);
    if (server) await stopChild(server.child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
