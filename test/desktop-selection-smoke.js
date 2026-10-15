#!/usr/bin/env node
'use strict';

// 划词后的「批注」按钮(2026-10-15 用户报:选中一段想批注,按钮时有时无)。
//
//   1. 选区终点落在正文外(拖到文末下方空白处才松手):只取正文里的部分,按钮照常出现,批注引文不含正文外的东西。
//   2. 真实鼠标从正文中间拖到文末下方空白处:按钮出现。
//   3. 选完再滚动(包括拖选时自动往下滚):按钮跟着选区走,不再一滚就消失;选区整段滚出视野时藏起,滚回来再出现。
//   4. 选区没了:滚动不会让按钮带着旧选区回来。
//
// 用法: node test/desktop-selection-smoke.js   (需要本机有 Google Chrome / Chromium)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/review-store');
const { sleep, waitUntil, stopChild, startServer, startChrome } = require('./helpers/browser-smoke');

const buttonState = `(() => {
  const button = document.querySelector('#annotateButton');
  const rect = button.getBoundingClientRect();
  const view = document.querySelector('#readerScroll').getBoundingClientRect();
  return { hidden: button.hidden, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom,
    inView: rect.top >= view.top && rect.bottom <= view.bottom && rect.left >= view.left && rect.right <= view.right };
})()`;

async function frames(cdp, count = 3) {
  for (let i = 0; i < count; i += 1) await cdp.evaluate('new Promise((resolve) => requestAnimationFrame(() => resolve(true)))');
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-selection-smoke-')));
  const dataDir = path.join(root, '.draftback');
  const source = path.join(root, 'docs', '询价沟通.md');
  let server = null;
  let chrome = null;
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const lines = ['# 询价沟通', '', '## 第一部分 内部调研报告', ''];
    for (let i = 1; i <= 60; i += 1) lines.push(`第一部分第 ${i} 段:水平磁场、无液氦传导冷却、分段失超保护,这些都是首台套已采用的技术。`, '');
    lines.push('## 第二部分 客户沟通内容', '', '### 一、微信回复稿', '', '梁老师好,两项需求我们已组织研发逐项评估,结论如下:', '');
    for (let i = 1; i <= 5; i += 1) lines.push(`${i}. **第 ${i} 条**:升降场三十分钟以内,研发判断可行,正在核算电源配置。`);
    lines.push('', '### 四、会前准备', '', '- 研发:最小径向尺寸链。', '- 李工:首台套装配照片与测试计划。', '- 秦:本稿定稿、微信回复、会议邀请。', '');
    fs.writeFileSync(source, lines.join('\n'), 'utf8');
    store.ensureDataDir({ dataDir });

    server = await startServer(dataDir);
    chrome = await startChrome(path.join(root, 'chrome-profile'));
    const { cdp } = chrome;
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });
    await waitUntil('欢迎页就绪', () => cdp.evaluate(`document.readyState === 'complete' && !document.querySelector('#welcome').hidden`));
    cdp.nextPromptText = source;
    await cdp.evaluate(`document.querySelector('#welcomeOpenButton').click()`);
    await waitUntil('文档打开', () => cdp.evaluate(`document.querySelectorAll('#documentContent li').length === 8`));

    // 1. 选区终点在正文外(文末下方的空白):以前判为无效,按钮不出
    await cdp.evaluate(`(() => {
      const heading = Array.from(document.querySelectorAll('#documentContent h2')).find((node) => node.textContent.includes('第二部分'));
      heading.scrollIntoView({ block: 'start', behavior: 'instant' });
      const scroller = document.querySelector('#readerScroll');
      const range = document.createRange();
      range.setStart(heading.firstChild, 0);
      range.setEnd(scroller, scroller.childNodes.length);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
    })()`);
    await waitUntil('终点在正文外时批注按钮出现', () => cdp.evaluate(`!document.querySelector('#annotateButton').hidden`));
    let state = await cdp.evaluate(buttonState);
    assert.equal(state.inView, true, '按钮在阅读区里,不压到工具栏和批注栏');
    await cdp.evaluate(`document.querySelector('#annotateButton').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))`);
    await waitUntil('批注框弹出', () => cdp.evaluate(`!document.querySelector('#annotationDialog').hidden`));
    const quote = await cdp.evaluate(`document.querySelector('#annotationQuote').textContent`);
    assert.match(quote, /第二部分 客户沟通内容/, '引文从选区起点开始');
    assert.match(quote, /本稿定稿、微信回复、会议邀请/, '引文一直到正文末尾');
    await cdp.evaluate(`document.querySelector('#annotationDialog .dialog-close, #annotationCancel')?.click()`);
    await waitUntil('批注框关闭', () => cdp.evaluate(`document.querySelector('#annotationDialog').hidden`));
    await cdp.evaluate(`window.getSelection().removeAllRanges()`);
    await waitUntil('清掉选区后按钮藏起', () => cdp.evaluate(`document.querySelector('#annotateButton').hidden`));

    // 2. 真实鼠标:从「第二部分」标题拖到文末下方的空白处才松手
    await cdp.evaluate(`Array.from(document.querySelectorAll('#documentContent h2')).find((node) => node.textContent.includes('第二部分')).scrollIntoView({ block: 'start', behavior: 'instant' })`);
    await frames(cdp);
    const points = await cdp.evaluate(`(() => {
      const heading = Array.from(document.querySelectorAll('#documentContent h2')).find((node) => node.textContent.includes('第二部分'));
      const start = heading.getBoundingClientRect();
      const last = document.querySelector('#documentContent li:last-child').getBoundingClientRect();
      const view = document.querySelector('#readerScroll').getBoundingClientRect();
      return { start: { x: start.left + 2, y: start.top + start.height / 2 }, end: { x: last.left + 40, y: Math.min(view.bottom - 10, last.bottom + 60) } };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.start.x, y: points.start.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.start.x, y: points.start.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 12; step += 1) {
      const ratio = step / 12;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1,
        x: points.start.x + (points.end.x - points.start.x) * ratio, y: points.start.y + (points.end.y - points.start.y) * ratio });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.end.x, y: points.end.y, button: 'left', buttons: 0, clickCount: 1 });
    const dragged = await cdp.evaluate(`window.getSelection().toString()`);
    assert.match(dragged, /第二部分/, '真实拖选从标题开始');
    await waitUntil('拖到文末下方松手后批注按钮出现', () => cdp.evaluate(`!document.querySelector('#annotateButton').hidden`));
    await cdp.evaluate(`window.getSelection().removeAllRanges()`);
    await waitUntil('按钮藏起', () => cdp.evaluate(`document.querySelector('#annotateButton').hidden`));

    // 3. 选完再滚动:按钮跟着选区走
    await cdp.evaluate(`(() => {
      const target = Array.from(document.querySelectorAll('#documentContent p')).find((node) => node.textContent.startsWith('第一部分第 14 段'));
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      const range = document.createRange(); range.selectNodeContents(target);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    })()`);
    await waitUntil('选中一段后按钮出现', () => cdp.evaluate(`!document.querySelector('#annotateButton').hidden`));
    const selectionTop = `(() => { const rects = window.getSelection().getRangeAt(0).getClientRects(); return rects[rects.length - 1].top; })()`;
    const before = await cdp.evaluate(buttonState);
    const beforeRect = await cdp.evaluate(selectionTop);
    await cdp.evaluate(`document.querySelector('#readerScroll').scrollBy({ top: -90, behavior: 'instant' })`);
    await frames(cdp);
    state = await cdp.evaluate(buttonState);
    const moved = (await cdp.evaluate(selectionTop)) - beforeRect;
    assert.equal(state.hidden, false, '滚动后按钮不消失');
    assert.ok(moved > 30, `测试前提:选区随滚动下移(实际 ${moved})`);
    assert.ok(Math.abs((state.top - before.top) - moved) <= 3, `按钮跟着选区移动(选区 ${moved},按钮 ${state.top - before.top})`);
    await cdp.evaluate(`document.querySelector('#readerScroll').scrollBy({ top: 4000, behavior: 'instant' })`);
    await frames(cdp);
    assert.equal((await cdp.evaluate(buttonState)).hidden, true, '选区整段滚出视野时按钮藏起');
    await cdp.evaluate(`Array.from(document.querySelectorAll('#documentContent p')).find((node) => node.textContent.startsWith('第一部分第 14 段')).scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await frames(cdp);
    state = await cdp.evaluate(buttonState);
    assert.equal(state.hidden, false, '滚回来按钮再出现');
    assert.equal(state.inView, true);

    // 4. 选区没了:滚动不会让按钮带着旧选区回来
    await cdp.evaluate(`window.getSelection().removeAllRanges()`);
    await waitUntil('清掉选区后按钮藏起', () => cdp.evaluate(`document.querySelector('#annotateButton').hidden`));
    await cdp.evaluate(`document.querySelector('#readerScroll').scrollBy({ top: 60, behavior: 'instant' })`);
    await frames(cdp);
    await sleep(100);
    assert.equal((await cdp.evaluate(buttonState)).hidden, true, '没有选区时滚动不出按钮');

    console.log('desktop selection smoke: ok');
  } finally {
    if (chrome) await stopChild(chrome.child);
    if (server) await stopChild(server.child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
