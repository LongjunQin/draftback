#!/usr/bin/env node
'use strict';

// 规则⑤第三段的真实浏览器冒烟:回稿卡(数据来自版本事件)、独立只读对比视图(含删除、上一处 / 下一处、Esc 关闭回到完成稿)、
// 历史按轮折叠、轮次时间线、恢复到第 N 轮改稿前与「恢复到恢复前的稿子」、稿子回来时默认显示干净稿(2026-10-15 用户定),
// 点回稿卡「显示改动」才打开对比视图。
//
// 用法: node test/desktop-versions-smoke.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/review-store');
const { sleep, waitUntil, stopChild, startServer, startChrome } = require('./helpers/browser-smoke');

const ORIGINAL = ['# 版本冒烟', '', '第一段讲苹果。', '', '第二段要被删掉。', '', '第三段有 12 个数字。', ''].join('\n');
const FINAL = ['# 版本冒烟', '', '第一段讲苹果和香蕉。', '', '第三段有 13 个数字。', '', '新加的第四段。', ''].join('\n');

function sidecar(doc, annotations) {
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: path.basename(doc), annotations }));
}

async function completeRound(doc, review, options, finalText, summary) {
  sidecar(doc, [
    { id: 'n1', comment: '补一句香蕉', quote: '第一段讲苹果。', status: 'open', reviewSessionId: review.id, createdAt: '2026-10-15T01:00:00Z' },
    { id: 'n2', comment: '第二段删掉', quote: '第二段要被删掉。', status: 'open', reviewSessionId: review.id, createdAt: '2026-10-15T01:01:00Z' },
  ]);
  await store.submitReview(review.id, options);
  await store.beginApply(doc, { applyMode: 'agent', applyActor: 'Claude Code', ...options });
  fs.writeFileSync(doc, finalText);
  sidecar(doc, [
    { id: 'n1', comment: '补一句香蕉', quote: '第一段讲苹果。', status: 'applied', appliedNote: '补了香蕉', reviewSessionId: review.id, createdAt: '2026-10-15T01:00:00Z' },
    { id: 'n2', comment: '第二段删掉', quote: '第二段要被删掉。', status: 'wontfix', appliedNote: '改成删掉并补第四段', reviewSessionId: review.id, createdAt: '2026-10-15T01:01:00Z' },
  ]);
  return store.completeReview(doc, { summary, ...options });
}

async function key(cdp, keyName, code, vk, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, modifiers, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers, windowsVirtualKeyCode: vk });
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-versions-smoke-')));
  const dataDir = path.join(root, '.draftback');
  const docRoot = path.join(root, 'docs');
  const profileDir = path.join(root, 'chrome-profile');
  const doc = path.join(docRoot, '版本冒烟.md');
  const doc2 = path.join(docRoot, '自动打开.md');
  const options = { dataDir };
  let server = null;
  let chrome = null;
  try {
    fs.mkdirSync(docRoot, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    store.ensureDataDir(options);
    fs.writeFileSync(doc, ORIGINAL);
    const { review } = await store.openReview(doc, options);
    await completeRound(doc, review, options, FINAL, '补了香蕉;第二段删掉并加了第四段;数字 12 改 13。');
    fs.writeFileSync(doc2, ORIGINAL);
    const second = (await store.openReview(doc2, options)).review;

    server = await startServer(dataDir);
    chrome = await startChrome(profileDir);
    const cdp = chrome.cdp;
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });
    await waitUntil('最近文件', () => cdp.evaluate(`document.readyState === 'complete' && document.querySelectorAll('#welcomeRecent .recent-item').length >= 2`));
    await cdp.evaluate(`Array.from(document.querySelectorAll('#welcomeRecent .recent-item')).find((item) => item.textContent.includes('版本冒烟')).click()`);
    await waitUntil('正文渲染', () => cdp.evaluate(`document.querySelector('#documentContent').textContent.includes('新加的第四段')`));

    // 1. 回稿卡:标题、计数、摘要、逐条结果、改动处数(对比计算)
    await waitUntil('回稿卡', () => cdp.evaluate(`!document.querySelector('#returnCard').hidden && document.querySelector('#returnCard h3')`));
    const card = await cdp.evaluate(`(() => ({
      title: document.querySelector('#returnCard h3').textContent,
      badges: Array.from(document.querySelectorAll('#returnCard .return-badge')).map((b) => b.textContent),
      summary: document.querySelector('#returnCard .return-summary').textContent,
      items: Array.from(document.querySelectorAll('#returnCard .result-item')).map((i) => [i.className, i.querySelector('.result-you').textContent, i.querySelector('.result-ai').textContent]),
      openHidden: document.querySelector('#openNotesList').parentElement.hidden,
      status: document.querySelector('#reviewStateText').textContent,
    }))()`);
    assert.equal(card.title, '第 1 轮回稿');
    assert.ok(card.badges.includes('采纳 1') && card.badges.includes('未采纳 1'), `计数徽标: ${card.badges}`);
    assert.match(card.summary, /补了香蕉/);
    assert.deepEqual(card.items.map((i) => i[0]), ['result-item applied', 'result-item wontfix']);
    assert.equal(card.items[0][1], '你补一句香蕉');
    assert.equal(card.items[0][2], 'AI补了香蕉');
    assert.match(card.items[1][2], /未采纳:改成删掉并补第四段/);
    assert.equal(card.openHidden, true, '没有未处理批注时「本轮」区让位给回稿卡');
    assert.match(card.status, /稿子回来了/);
    await waitUntil('改动处数', () => cdp.evaluate(`Array.from(document.querySelectorAll('#returnCard .return-badge.changes')).some((b) => /改了 4 处/.test(b.textContent))`));

    // 2. 对比视图:四个改动块(改一段、删一段、改数字、加一段,相邻的合在一组渲染);有删除线;上一处 / 下一处;Esc 关闭回到完成稿且阅读位置保留
    await cdp.evaluate(`document.querySelector('#readerScroll').scrollTop = 40`);
    await cdp.evaluate(`Array.from(document.querySelectorAll('#returnCard button')).find((b) => b.textContent.includes('显示改动')).click()`);
    await waitUntil('对比视图打开', () => cdp.evaluate(`!document.querySelector('#compareView').hidden && document.querySelectorAll('#compareContent .diff-change').length > 0`));
    const compare = await cdp.evaluate(`(() => ({
      title: document.querySelector('#compareTitle').textContent,
      meta: document.querySelector('#compareMeta').textContent,
      changes: document.querySelectorAll('#compareContent .diff-change').length,
      dels: Array.from(document.querySelectorAll('#compareContent .diff-del')).map((d) => d.textContent),
      ins: Array.from(document.querySelectorAll('#compareContent .diff-ins')).map((d) => d.textContent),
      deleted: Array.from(document.querySelectorAll('#compareContent .diff-delete')).map((d) => d.textContent.trim()),
      inserted: Array.from(document.querySelectorAll('#compareContent .diff-insert')).map((d) => d.textContent.trim()),
      strike: getComputedStyle(document.querySelector('#compareContent .diff-delete')).textDecorationLine,
      position: document.querySelector('#comparePosition').textContent,
      overlayHidden: getComputedStyle(document.querySelector('#annotationOverlay')).display === 'none',
      readerScrollTop: document.querySelector('#readerScroll').scrollTop,
      equalRendered: !!document.querySelector('#compareContent .diff-equal h1'),
    }))()`);
    assert.equal(compare.title, '第 1 轮改动');
    assert.match(compare.meta, /原稿 → 完成稿 · 4 处/);
    assert.equal(compare.changes, 4, '改一段、删一段、改数字、加一段:四个改动块');
    assert.ok(compare.ins.includes('和香蕉'), `字级新增: ${compare.ins}`);
    assert.ok(compare.dels.includes('2') && compare.ins.includes('3'), `改一个数字: ${compare.dels} / ${compare.ins}`);
    assert.deepEqual(compare.deleted, ['第二段要被删掉。'], '整段删除原位显示');
    assert.deepEqual(compare.inserted, ['新加的第四段。']);
    assert.match(compare.strike, /line-through/);
    assert.equal(compare.position, '1 / 4');
    assert.equal(compare.overlayHidden, true, '对比视图打开时圆钉层不显示');
    assert.equal(compare.equalRendered, true, '没改的块按 Markdown 渲染');
    // 对比视图里划词不出「批注」按钮:批注锚点只认完成稿正文,不让删除线内容进坐标(验收第 9 项)
    await cdp.evaluate(`(() => { const p = document.querySelector('#compareContent .diff-delete p'); const r = document.createRange(); r.selectNodeContents(p); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); })()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await cdp.evaluate(`document.querySelector('#annotateButton').hidden`), true, '对比视图里的选区不能触发批注');
    await cdp.evaluate(`getSelection().removeAllRanges()`);
    await key(cdp, 'ArrowRight', 'ArrowRight', 39, 1 | 4); // ⌥⌘→ 下一处
    await waitUntil('下一处', () => cdp.evaluate(`document.querySelector('#comparePosition').textContent === '2 / 4' && document.querySelectorAll('#compareContent .diff-change')[1].classList.contains('current')`));
    await key(cdp, 'ArrowLeft', 'ArrowLeft', 37, 1 | 4);
    await waitUntil('上一处', () => cdp.evaluate(`document.querySelector('#comparePosition').textContent === '1 / 4'`));
    await key(cdp, 'Escape', 'Escape', 27);
    await waitUntil('Esc 关闭对比视图', () => cdp.evaluate(`document.querySelector('#compareView').hidden && !document.querySelector('#readerPane').classList.contains('compare-open')`));
    assert.equal(await cdp.evaluate(`document.querySelector('#readerScroll').scrollTop`), compare.readerScrollTop, '关闭后阅读位置保留');
    assert.equal(await cdp.evaluate(`document.querySelector('#documentContent').textContent.includes('第二段要被删掉')`), false, '关闭后回到纯完成稿,没有删除线内容');
    // ⇧⌘D 再打开再关
    await key(cdp, 'd', 'KeyD', 68, 4 | 8);
    await waitUntil('⇧⌘D 打开', () => cdp.evaluate(`!document.querySelector('#compareView').hidden`));
    // Esc 先关最上层的小弹层(文档信息卡),对比视图还开着;再按一次才关对比(Codex 审查第二步第 9 条)
    await cdp.evaluate(`document.querySelector('#docTitleButton').click()`);
    await waitUntil('文档信息卡', () => cdp.evaluate(`!document.querySelector('#docInfoPopover').hidden`));
    await key(cdp, 'Escape', 'Escape', 27);
    await waitUntil('先关信息卡', () => cdp.evaluate(`document.querySelector('#docInfoPopover').hidden && !document.querySelector('#compareView').hidden`));
    await key(cdp, 'd', 'KeyD', 68, 4 | 8);
    await waitUntil('⇧⌘D 关闭', () => cdp.evaluate(`document.querySelector('#compareView').hidden`));

    // 3. 历史按轮折叠 + 时间线
    await cdp.evaluate(`document.querySelector('#notesHistoryTab').click()`);
    await waitUntil('历史展开', () => cdp.evaluate(`!document.querySelector('#historySection').hidden && document.querySelectorAll('#historyNotesList .round-group').length === 1`));
    const history = await cdp.evaluate(`(() => {
      const group = document.querySelector('#historyNotesList .round-group');
      return { kind: group.dataset.kind, summary: group.querySelector('summary').textContent.replace(/\\s+/g, ' ').trim(), count: document.querySelector('#historyNotesCount').textContent, open: group.open };
    })()`);
    assert.equal(history.kind, 'review');
    assert.match(history.summary, /第 1 轮/); assert.match(history.summary, /AI 改稿/); assert.match(history.summary, /采纳 1 · 未采纳 1/);
    assert.equal(history.count, '1 轮');
    assert.equal(history.open, false, '每轮默认折叠');
    await cdp.evaluate(`document.querySelector('#reviewStatePill').click()`);
    await waitUntil('时间线', () => cdp.evaluate(`!document.querySelector('#timelinePopover').hidden && document.querySelectorAll('#timelinePopover .timeline-item').length === 1`));
    assert.match(await cdp.evaluate(`document.querySelector('#timelinePopover .timeline-item').textContent`), /第 1 轮/);
    await key(cdp, 'Escape', 'Escape', 27);
    await waitUntil('时间线关闭', () => cdp.evaluate(`document.querySelector('#timelinePopover').hidden`));

    // 4. 恢复到第 1 轮改稿前:确认框 → 文件回到原稿 → 新的一轮(restored)→ 回稿卡与历史都变
    await cdp.evaluate(`document.querySelector('#historyNotesList .round-group summary').click()`);
    await waitUntil('轮展开', () => cdp.evaluate(`document.querySelector('#historyNotesList .round-group').open`));
    const restoreButton = await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('#historyNotesList .round-actions button')).find((x) => x.textContent === '恢复到这轮改稿前'); return b ? { disabled: b.disabled } : null; })()`);
    assert.deepEqual(restoreButton, { disabled: false }, '终态且未编辑:可以恢复');
    await cdp.evaluate(`Array.from(document.querySelectorAll('#historyNotesList .round-actions button')).find((x) => x.textContent === '恢复到这轮改稿前').click()`);
    await waitUntil('确认框', () => cdp.evaluate(`!document.querySelector('#confirmDialog').hidden`));
    assert.match(await cdp.evaluate(`document.querySelector('#confirmMessage').textContent`), /第 1 轮改稿前的样子/);
    await cdp.evaluate(`document.querySelector('#confirmAccept').click()`);
    await waitUntil('已恢复', () => cdp.evaluate(`document.querySelector('#reviewStateText').textContent.includes('已恢复到第 1 轮改稿前')`));
    assert.equal(fs.readFileSync(doc, 'utf8'), ORIGINAL, '文件逐字节回到第 1 轮原稿');
    await waitUntil('恢复后正文', () => cdp.evaluate(`document.querySelector('#documentContent').textContent.includes('第二段要被删掉') && !document.querySelector('#documentContent').textContent.includes('新加的第四段')`));
    await waitUntil('恢复卡', () => cdp.evaluate(`document.querySelector('#returnCard').dataset.kind === 'restored' && document.querySelectorAll('#historyNotesList .round-group').length === 2`));
    const restoredCard = await cdp.evaluate(`(() => ({
      title: document.querySelector('#returnCard h3').textContent,
      buttons: Array.from(document.querySelectorAll('#returnCard button')).map((b) => b.textContent),
      kinds: Array.from(document.querySelectorAll('#historyNotesList .round-group')).map((g) => g.dataset.kind),
    }))()`);
    assert.equal(restoredCard.title, '已恢复到第 1 轮改稿前');
    assert.ok(restoredCard.buttons.includes('恢复到恢复前的稿子'), restoredCard.buttons.join());
    assert.deepEqual(restoredCard.kinds, ['restored', 'review']);
    // 恢复事件的对比:恢复前 → 恢复后
    await cdp.evaluate(`Array.from(document.querySelectorAll('#returnCard button')).find((b) => b.textContent.includes('对比恢复前后')).click()`);
    await waitUntil('恢复对比', () => cdp.evaluate(`!document.querySelector('#compareView').hidden && document.querySelector('#compareTitle').textContent.includes('恢复') && document.querySelectorAll('#compareContent .diff-change').length === 4`));
    await key(cdp, 'Escape', 'Escape', 27);
    await waitUntil('关闭', () => cdp.evaluate(`document.querySelector('#compareView').hidden`));
    // 反悔:恢复到恢复前的稿子
    await cdp.evaluate(`Array.from(document.querySelectorAll('#returnCard button')).find((b) => b.textContent === '恢复到恢复前的稿子').click()`);
    await waitUntil('确认框', () => cdp.evaluate(`!document.querySelector('#confirmDialog').hidden`));
    await cdp.evaluate(`document.querySelector('#confirmAccept').click()`);
    await waitUntil('反悔完成', () => cdp.evaluate(`document.querySelector('#reviewStateText').textContent.includes('已恢复到第 2 轮改稿前')`));
    assert.equal(fs.readFileSync(doc, 'utf8'), FINAL, '反悔后文件回到第 1 轮完成稿');
    await waitUntil('历史三轮', () => cdp.evaluate(`document.querySelectorAll('#historyNotesList .round-group').length === 3`));

    // 5. 稿子回来时默认显示改完的干净稿:第二篇在页面里打开着,后台完成一轮并通知;想看改了哪里点「显示改动」
    await cdp.evaluate(`Array.from(document.querySelectorAll('#tabList .tab, #recentList .recent-item')).length`);
    await cdp.evaluate(`document.querySelector('#filesModeButton').click()`);
    await waitUntil('最近列表', () => cdp.evaluate(`Array.from(document.querySelectorAll('#recentList .recent-item')).some((i) => i.textContent.includes('自动打开'))`));
    await cdp.evaluate(`Array.from(document.querySelectorAll('#recentList .recent-item')).find((i) => i.textContent.includes('自动打开')).click()`);
    await waitUntil('第二篇', () => cdp.evaluate(`document.querySelector('#reviewStateText').textContent.includes('批注中') && document.querySelector('#documentContent').textContent.includes('第二段要被删掉')`));
    await completeRound(doc2, second, options, FINAL, '第二篇改完。');
    const notify = await fetch(`http://127.0.0.1:${server.port}/api/app/review/notify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewSessionId: second.id, reason: 'agent-complete' }),
    });
    assert.equal(notify.ok, true);
    await waitUntil('回稿卡出现', () => cdp.evaluate(`Boolean(document.querySelector('#returnCard h3')) && document.querySelector('#returnCard h3').textContent === '第 1 轮回稿' && Boolean(document.querySelector('#returnCard .return-actions .primary-button'))`), 20_000);
    await sleep(800);
    assert.equal(await cdp.evaluate(`document.querySelector('#compareView').hidden`), true, '稿子回来不自动打开对比视图');
    assert.equal(await cdp.evaluate(`document.querySelector('#documentContent').textContent.includes('第二段要被删掉')`), false, '正文是改完的干净稿');
    const cardButton = `document.querySelector('#returnCard [data-compare-style="card"]')`;
    assert.equal(await cdp.evaluate(`${cardButton}.textContent`), '显示改动');
    await cdp.evaluate(`${cardButton}.click()`);
    await waitUntil('点「显示改动」打开对比视图', () => cdp.evaluate(`!document.querySelector('#compareView').hidden && document.querySelectorAll('#compareContent .diff-change').length === 4`), 20_000);
    // 同一个按钮是开关:开着时写「隐藏改动」,再点关掉回到干净稿(2026-10-15 用户提)
    await waitUntil('按钮变成「隐藏改动」', () => cdp.evaluate(`${cardButton}.textContent === '隐藏改动' && ${cardButton}.getAttribute('aria-pressed') === 'true'`));
    await cdp.evaluate(`${cardButton}.click()`);
    await waitUntil('再点关掉对比视图', () => cdp.evaluate(`document.querySelector('#compareView').hidden && ${cardButton}.textContent === '显示改动'`));
    await cdp.evaluate(`${cardButton}.click()`);
    await waitUntil('第三次点又打开', () => cdp.evaluate(`!document.querySelector('#compareView').hidden`), 20_000);
    await key(cdp, 'Escape', 'Escape', 27);
    await waitUntil('Esc 关闭,按钮变回', () => cdp.evaluate(`document.querySelector('#compareView').hidden && ${cardButton}.textContent === '显示改动'`));

    // 页面没有 <link rel=icon>,Chrome 自动请求 /favicon.ico 得到 404,这条资源错误不算脚本问题
    const errors = cdp.exceptions.concat(cdp.consoleMessages.filter((m) => m.type === 'error').map((m) => m.text)).filter((text) => !/favicon|ERR_|net::|Failed to load resource.*404/.test(text));
    assert.deepEqual(errors, [], `页面不应有脚本异常或 console.error: ${errors.join(' | ')}`);
    console.log('PASS: 回稿卡(事件数据、计数、逐条结果、改动处数)、对比视图(含删除、上一处/下一处、Esc 回到完成稿、⇧⌘D)、历史按轮折叠、时间线、恢复与反悔、稿子回来默认干净稿、「显示改动 / 隐藏改动」开关。');
  } finally {
    if (chrome) await stopChild(chrome.child);
    if (server) await stopChild(server.child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
