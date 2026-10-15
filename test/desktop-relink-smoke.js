#!/usr/bin/env node
'use strict';

// 受控重关联(跨端规则第 3 节)的真实浏览器冒烟:一篇走完一轮的文档在访达里挪了位置,
//   1. 打开新位置:问「接上审阅历史?」;点「当成新文档」按普通文档打开,下次再打开不再问;
//   2. 另一篇同样挪过的:点「接上历史」,按那一轮打开(回稿卡在),最近文件里是新路径。
//
// 用法: node test/desktop-relink-smoke.js   (需要本机有 Google Chrome / Chromium)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/review-store');
const { sleep, waitUntil, stopChild, startServer, startChrome } = require('./helpers/browser-smoke');

async function finishedDoc(doc, options) {
  fs.writeFileSync(doc, '# 方案\n\n原来的正文。\n');
  const { review } = await store.openReview(doc, options);
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: path.basename(doc), annotations: [{ id: 'm1', comment: '改一下', status: 'open', reviewSessionId: review.id }] }));
  await store.submitReview(review.id, options);
  await store.beginApply(doc, options);
  fs.writeFileSync(doc, `# 方案\n\n${path.basename(doc)} 改完的正文。\n`);
  await store.mutateAnnotations(doc, (data) => { data.annotations[0].status = 'applied'; data.annotations[0].appliedNote = '改了'; }, options);
  return store.completeReview(doc, { ...options, summary: '改了。' });
}

async function openPath(cdp, filePath) {
  cdp.nextPromptText = filePath;
  await cdp.evaluate(`(!document.querySelector('#welcome').hidden ? document.querySelector('#welcomeOpenButton') : document.querySelector('#openTabButton')).click()`);
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-relink-smoke-')));
  const dataDir = path.join(root, '.draftback');
  const options = { dataDir };
  let server = null;
  let chrome = null;
  try {
    fs.mkdirSync(path.join(root, 'old'), { recursive: true });
    fs.mkdirSync(path.join(root, 'new'), { recursive: true });
    store.ensureDataDir(options);
    const declineOld = path.join(root, 'old', '甲.md');
    const acceptOld = path.join(root, 'old', '乙.md');
    await finishedDoc(declineOld, options);
    await finishedDoc(acceptOld, options);
    const declineNew = path.join(root, 'new', '甲.md');
    const acceptNew = path.join(root, 'new', '乙.md');
    fs.renameSync(declineOld, declineNew);
    fs.renameSync(acceptOld, acceptNew);

    server = await startServer(dataDir);
    chrome = await startChrome(path.join(root, 'chrome-profile'));
    const { cdp } = chrome;
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });
    await waitUntil('欢迎页就绪', () => cdp.evaluate(`document.readyState === 'complete' && !document.querySelector('#welcome').hidden`));

    // 1. 当成新文档:按普通文档打开;再打开不再问
    await openPath(cdp, declineNew);
    await waitUntil('问要不要接上历史', () => cdp.evaluate(`!document.querySelector('#confirmDialog').hidden && document.querySelector('#confirmTitle').textContent === '接上审阅历史?'`));
    const message = await cdp.evaluate(`document.querySelector('#confirmMessage').textContent`);
    assert.match(message, /甲\.md/);
    assert.match(message, /前 1 轮的审阅历史/);
    assert.equal(await cdp.evaluate(`document.querySelector('#confirmCancel').textContent`), '当成新文档');
    await cdp.evaluate(`document.querySelector('#confirmCancel').click()`);
    await waitUntil('按普通文档打开', () => cdp.evaluate(`document.querySelector('#documentContent').textContent.includes('甲.md 改完的正文') && document.querySelector('#returnCard').hidden`));
    await openPath(cdp, declineNew);
    await sleep(800);
    assert.equal(await cdp.evaluate(`document.querySelector('#confirmDialog').hidden`), true, '说过「当成新文档」的不再问');

    // 2. 接上历史:按那一轮打开,回稿卡在;最近文件是新路径
    await openPath(cdp, acceptNew);
    await waitUntil('问要不要接上历史', () => cdp.evaluate(`!document.querySelector('#confirmDialog').hidden && document.querySelector('#confirmMessage').textContent.includes('乙.md')`));
    await cdp.evaluate(`document.querySelector('#confirmAccept').click()`);
    await waitUntil('按那一轮打开', () => cdp.evaluate(`!document.querySelector('#returnCard').hidden && document.querySelector('#returnCard h3').textContent === '第 1 轮回稿' && document.querySelector('#documentContent').textContent.includes('乙.md 改完的正文')`), 20_000);
    const recent = JSON.parse(fs.readFileSync(path.join(dataDir, 'recent.json'), 'utf8')).entries.map((entry) => entry.absPath);
    assert.ok(recent.includes(acceptNew), '最近文件里是新路径');
    assert.ok(!recent.includes(acceptOld), '旧路径不在最近文件里');
    const reviews = await store.listReviews(options);
    assert.ok(reviews.some((review) => review.absPath === acceptNew && review.relinkedFrom === acceptOld), '会话跟到新路径');

    const errors = cdp.exceptions.concat(cdp.consoleMessages.filter((m) => m.type === 'error').map((m) => m.text)).filter((text) => !/favicon|ERR_|net::|Failed to load resource.*404/.test(text));
    assert.deepEqual(errors, [], `页面不应有脚本异常或 console.error: ${errors.join(' | ')}`);
    console.log('PASS: 挪过位置的文档打开时问「接上审阅历史?」;当成新文档后不再问;接上后按那一轮打开、最近文件与会话跟到新路径。');
  } finally {
    if (chrome) await stopChild(chrome.child);
    if (server) await stopChild(server.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
