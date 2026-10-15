#!/usr/bin/env node
'use strict';

// 手机阅读页「复制到本轮」找引文(v2.4 代码审查第 6、11 条):
//
//   1. 正文与引文都有连续空白:照样找到(两边用同一种规范化)。
//   2. 同一句在两节都出现:按原批注所在的章节挑;挑不出唯一一处返回 null(原生改成总体意见),不默认挂到第一处。
//   3. 跨段引文能找到,锚点从第一段开始;找不到返回 null。
//   4. 逐条结果定位(locateQuote)照常工作。
//
// 用法: node test/phone-reader-quote-smoke.js   (需要本机有 Google Chrome / Chromium)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PROJECT, waitUntil, stopChild, startChrome } = require('./helpers/browser-smoke');

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-phone-quote-'));
  let chrome = null;
  try {
    chrome = await startChrome(profile);
    const { cdp } = chrome;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__posted = []; window.webkit = { messageHandlers: { draftback: { postMessage: (m) => window.__posted.push(m) } } };',
    });
    await cdp.send('Page.navigate', { url: pathToFileURL(path.join(PROJECT, 'ios/Draftback/Web/reader.html')).href });
    await waitUntil('阅读页就绪', () => cdp.evaluate('Boolean(window.DraftbackReader) && window.__posted.some((m) => m.type === "ready")'));

    const markdown = [
      '# 方案', '',
      '## 第一节', '',
      '预算要再核一遍。', '',
      '这里有    四个空格的句子。', '',
      '## 第二节', '',
      '预算要再核一遍。', '',
      '第一段结尾。', '',
      '第二段开头。', '',
    ].join('\n');
    await cdp.evaluate(`window.DraftbackReader.load(${JSON.stringify({ markdown, annotations: [], assets: {}, fontScale: 1 })})`);
    await waitUntil('正文渲染', () => cdp.evaluate('window.__posted.some((m) => m.type === "rendered")'));
    const anchor = (quote, headingPath) => cdp.evaluate(`window.DraftbackReader.anchorForQuote(${JSON.stringify(quote)}, ${JSON.stringify(headingPath)})`);

    const spaced = await anchor('这里有    四个空格的句子', ['方案', '第一节']);
    assert.ok(spaced, '连续空白的引文要找得到');
    assert.equal(spaced.lineStart, 7);

    const second = await anchor('预算要再核一遍。', ['方案', '第二节']);
    assert.ok(second, '两处都有时按章节挑到第二节');
    assert.equal(second.lineStart, 11);
    assert.deepEqual(second.headingPath, ['方案', '第二节']);
    const first = await anchor('预算要再核一遍。', ['方案', '第一节']);
    assert.equal(first.lineStart, 5);
    assert.equal(await anchor('预算要再核一遍。', ['别的章节']), null, '挑不出唯一一处:返回 null');
    assert.equal(await anchor('预算要再核一遍。', []), null, '没有章节信息也不默认第一处');

    const across = await anchor('第一段结尾。\n\n第二段开头。', ['方案', '第二节']);
    assert.ok(across, '跨段引文找得到');
    assert.equal(across.lineStart, 13);
    assert.equal(await anchor('正文里没有这句', ['方案']), null);

    assert.equal(await cdp.evaluate('window.DraftbackReader.locateQuote("第二段开头")'), true, '逐条结果定位照常');
    assert.equal(await cdp.evaluate('window.DraftbackReader.locateQuote("没有这句")'), false);
    assert.deepEqual(chrome.cdp.exceptions, [], '页面没有脚本异常');
    console.log('PASS: 连续空白、重复引文按章节挑、挑不出不默认第一处、跨段引文、找不到返回空、逐条结果定位。');
  } finally {
    if (chrome) await stopChild(chrome.child);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
