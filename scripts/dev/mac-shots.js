#!/usr/bin/env node
'use strict';
// Mac 界面截图:造几篇不同状态的稿子(临时数据目录,不碰 ~/.draftback),在无头 Chrome 里打开桌面页,按场景截图。
// 原生外壳用假桥代替,所以不需要打包,改了 static/ 就能截。
//
// 用法: node scripts/dev/mac-shots.js <输出目录> [--scale 2] [--cover green] [--size 1440x900] [场景...]
//   不写场景就全截。场景:welcome back diff confirm settings comment dialog(含 selection) toast conflict
//   night(含 night-back) popovers(history-timeline docinfo export find quickopen shortcuts)
//   approve(approve-confirm approve-done) handed edit narrow(含 collapsed)
//   封面:green mist lavender gold orange black。NO_ANIM=1 关掉指示灯闪烁,截夜读时用。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PROJECT = path.join(__dirname, '..', '..');
const store = require(`${PROJECT}/lib/review-store`);
const documents = require(`${PROJECT}/lib/documents`);
const { sleep, waitUntil, stopChild, startServer, startChrome } = require(`${PROJECT}/test/helpers/browser-smoke`);

const args = process.argv.slice(2);
const outDir = args.shift();
if (!outDir || outDir.startsWith('--')) {
  console.error('用法: node scripts/dev/mac-shots.js <输出目录> [--scale 2] [--cover green] [--size 1440x900] [场景...]');
  process.exit(2);
}
let scale = 1; let cover = 'green'; let W = 1440; let H = 900;
const scenes = [];
while (args.length) { const a = args.shift(); if (a === '--scale') scale = Number(args.shift()); else if (a === '--cover') cover = args.shift(); else if (a === '--size') { [W, H] = args.shift().split('x').map(Number); } else scenes.push(a); }
const want = (name) => !scenes.length || scenes.includes(name);

const ORIGINAL = ['# 产品方案', '', '回稿把同一份文档在 Mac 和 iPhone 之间来回传。这份说明讲清楚谁说了算、批注怎么走。', '',
  '## 谁说了算', '', 'Mac 管原文、轮次和最终状态。手机管自己还没交出去的批注。云端只是邮筒,不做裁判。', '',
  '## 批注怎么走', '', '批注写好以后会立刻上传到云端,Mac 随时来取。Mac 收到后回一张回执。', '',
  '## 出了岔子怎么办', '', 'Mac 上的原文被别的程序改了,这批批注不会被采用。它们留在手机上,不会丢。', '',
  '| 谁 | 管什么 |', '| --- | --- |', '| Mac | 原文与轮次 |', '| 手机 | 没交出去的批注 |', '',
  '> 云端只是邮筒。', '', '```js', 'mdreview wait "产品方案.md"', '```', ''].join('\n');
const FINAL = ORIGINAL.replace('手机管自己还没交出去的批注。', '手机管自己还没交出去的批注,强退也不会丢。')
  .replace('批注写好以后会立刻上传到云端,Mac 随时来取。', '手机上写的每一条先存在手机里。点「交给 AI」才打包上传。');

const FAKE_BRIDGE = (coverId) => `
  window.__db = { commands: [], appearance: 'system', sync: true, cover: ${JSON.stringify(coverId)}, dockFollows: false };
  window.draftbackDesktop = {
    platform: 'darwin',
    pickMarkdown: async () => [], revealPath: async () => true, openExternal: async () => true, notifyReviewComplete: async () => false,
    exportPdf: async () => ({ ok: false, cancelled: true }), print: async () => ({ ok: false }),
    newDocument: async () => ({ ok: false, cancelled: true }), exportHtml: async () => ({ ok: false, cancelled: true }), exportDocx: async () => ({ ok: false, cancelled: true }),
    setMenuState: () => {}, noteRecent: () => {},
    getSettings: async () => ({ appearance: window.__db.appearance, cover: window.__db.cover, dockIconFollowsCover: window.__db.dockFollows, syncEnabled: true, syncHelperAvailable: true, syncHelperRunning: true, version: '1.0.0', packaged: true,
      cli: { installed: true, path: '/usr/local/bin/mdreview', pointsTo: 'this-app', target: '/x/mdreview.js' } }),
    setAppearance: async (v) => { window.__db.appearance = v; return v; },
    setCover: async (v) => { window.__db.cover = v; return v; },
    setDockIconFollowsCover: async (v) => { window.__db.dockFollows = v; return v; },
    setSyncEnabled: async (v) => ({ syncEnabled: v }), installCli: async () => ({ ok: true }),
    saveCopyDialog: async () => ({ ok: false, cancelled: true }), pickBatchFile: async () => ({ ok: false, cancelled: true }),
    pathsForFiles: () => [],
    onOpenFiles: () => () => {}, onCommand: (cb) => { window.__db.command = cb; return () => {}; }, onActivateReview: () => () => {},
  };
`;

function note(id, review, quote, comment, extra = {}) {
  return { id, comment, quote, reviewSessionId: review.id, status: 'open', createdAt: '2026-10-16T05:02:00Z', ...extra };
}

async function seed(docs, options) {
  const p = (name) => path.join(docs, `${name}.md`);
  // 1. 稿子回来了:三条批注,采纳 2、未采纳 1
  fs.writeFileSync(p('产品方案'), ORIGINAL);
  let r = (await store.openReview(p('产品方案'), options)).review;
  const notes = [
    note('a1', r, '手机管自己还没交出去的批注。', '这句再说清楚,强退也不会丢'),
    note('a2', r, '批注写好以后会立刻上传到云端,Mac 随时来取。', '「批注怎么走」写得太简单'),
    note('a3', r, '云端只是邮筒,不做裁判。', '这个比喻换掉'),
  ];
  await store.mutateAnnotations(p('产品方案'), (d) => { d.annotations.push(...notes); }, options);
  await store.submitReview(r.id, options);
  await store.beginApply(p('产品方案'), { applyMode: 'agent', applyActor: 'Claude Code', ...options });
  fs.writeFileSync(p('产品方案'), FINAL);
  await store.mutateAnnotations(p('产品方案'), (d) => {
    for (const a of d.annotations) {
      if (a.id === 'a1') Object.assign(a, { status: 'applied', appliedNote: '在这句后面补了「强退也不会丢」。' });
      if (a.id === 'a2') Object.assign(a, { status: 'applied', appliedNote: '改成三句:先存手机、交出才上传、Mac 回执。' });
      if (a.id === 'a3') Object.assign(a, { status: 'wontfix', appliedNote: '没改。前文已经用过这个比喻,换掉会前后对不上。' });
    }
  }, options);
  await store.completeReview(p('产品方案'), { summary: '按 3 条批注改了第二节的说法,删掉一段重复的背景。', ...options });
  // 2. 批注中:两条未交
  fs.writeFileSync(p('跨端规则'), ORIGINAL);
  r = (await store.openReview(p('跨端规则'), options)).review;
  await store.mutateAnnotations(p('跨端规则'), (d) => { d.annotations.push(
    note('b1', r, '云端只是邮筒,不做裁判。', '这个比喻换掉'),
    note('b2', r, 'Mac 收到后回一张回执。', '回执是什么?说清楚是谁回给谁')); }, options);
  // 3. AI 正在修改
  fs.writeFileSync(p('发布说明'), ORIGINAL);
  r = (await store.openReview(p('发布说明'), options)).review;
  await store.mutateAnnotations(p('发布说明'), (d) => { d.annotations.push(note('c1', r, '云端只是邮筒,不做裁判。', '这个比喻换掉')); }, options);
  await store.submitReview(r.id, options);
  await store.claimReview(p('发布说明'), { claimedBy: 'Claude Code', ...options });
  // 4. 已定稿
  fs.writeFileSync(p('年度总结'), ORIGINAL);
  r = (await store.openReview(p('年度总结'), options)).review;
  await store.submitReview(r.id, options);
  await store.finalizeReview(r.id, options).catch(() => {});
  // 5. 普通文档
  fs.writeFileSync(p('会议纪要'), ORIGINAL.replace('# 产品方案', '# 会议纪要'));
  await documents.touchRecent(p('会议纪要'), options);
  // 7. 批注中但一条批注都没有:工具栏是「通过 · 定稿」(零批注直接通过)
  fs.writeFileSync(p('空白轮'), ORIGINAL.replace('# 产品方案', '# 空白轮'));
  await store.openReview(p('空白轮'), options);
  // 8. 已交出、还没有 AI 接入:工具栏是「我自己改」+「复制改稿指令」
  fs.writeFileSync(p('等人接手'), ORIGINAL.replace('# 产品方案', '# 等人接手'));
  r = (await store.openReview(p('等人接手'), options)).review;
  await store.mutateAnnotations(p('等人接手'), (d) => { d.annotations.push(note('e1', r, '云端只是邮筒,不做裁判。', '换个说法')); }, options);
  await store.submitReview(r.id, options);
  // 6. 文件在外面被改了
  fs.writeFileSync(p('定价页'), ORIGINAL.replace('# 产品方案', '# 定价页'));
  r = (await store.openReview(p('定价页'), options)).review;
  await store.mutateAnnotations(p('定价页'), (d) => { d.annotations.push(note('d1', r, '云端只是邮筒,不做裁判。', '冲突前的批注')); }, options);
  fs.writeFileSync(p('定价页'), ORIGINAL.replace('# 产品方案', '# 定价页(外面改过)'));
}

async function shot(cdp, name) {
  await sleep(450);
  // 无头 Chrome 不开 GPU 时,大窗口夜读截 PNG 会把页面截崩(页面本身没事);JPEG + optimizeForSpeed 不会
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
  fs.writeFileSync(path.join(outDir, `${name}.jpg`), Buffer.from(data, 'base64'));
  console.log('shot', name);
}
const click = (cdp, sel) => cdp.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) throw new Error('没有 ' + ${JSON.stringify(sel)}); n.click(); return true; })()`);
async function openDoc(cdp, name) {
  await cdp.evaluate(`document.querySelector('#filesModeButton').click()`);
  await waitUntil(`列表里有 ${name}`, () => cdp.evaluate(`Array.from(document.querySelectorAll('#recentList .recent-item')).some((i) => i.textContent.includes(${JSON.stringify(name)}))`));
  await cdp.evaluate(`Array.from(document.querySelectorAll('#recentList .recent-item')).find((i) => i.textContent.includes(${JSON.stringify(name)})).click()`);
  await waitUntil(`打开 ${name}`, () => cdp.evaluate(`(document.querySelector('#docTitleText') || {}).textContent.includes(${JSON.stringify(name)}) && document.querySelector('#documentContent').textContent.length > 20`));
  await sleep(300);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-skin-')));
  const dataDir = path.join(root, '.draftback'); const docs = path.join(root, 'docs'); const profile = path.join(root, 'chrome');
  fs.mkdirSync(docs, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  const options = { dataDir };
  store.ensureDataDir(options);
  await seed(docs, options);
  let server = null; let chrome = null;
  try {
    server = await startServer(dataDir);
    chrome = await startChrome(profile);
    const cdp = chrome.cdp;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: scale, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE(cover) });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });
    await waitUntil('页面就绪', () => cdp.evaluate(`document.readyState === 'complete' && document.querySelectorAll('#welcomeRecent .recent-item').length > 0`));
    await cdp.evaluate('document.fonts.ready.then(() => true)');
    if (want('welcome')) await shot(cdp, 'welcome');
    await openDoc(cdp, '产品方案');
    if (want('back')) await shot(cdp, 'back');
    if (want('diff')) {
      await click(cdp, '#compareToggleButton');
      await waitUntil('对比视图', () => cdp.evaluate(`!document.querySelector('#compareView').hidden`));
      await cdp.evaluate(`document.querySelector('#returnCard .return-collapse') && document.querySelector('#returnCard .return-collapse').click()`);
      await shot(cdp, 'diff');
      await click(cdp, '#compareClose');
      await cdp.evaluate(`document.querySelector('#returnCard .return-collapse') && document.querySelector('#returnCard .return-collapse').click()`);
    }
    if (want('confirm')) {
      await cdp.evaluate(`document.querySelector('#primaryAction').click()`);
      await sleep(300);
      await shot(cdp, 'confirm');
      await cdp.evaluate(`(() => { const b = document.querySelector('#finalizeCancel') || document.querySelector('#confirmCancel'); if (b && !b.closest('[hidden]')) b.click(); })()`);
    }
    if (want('settings')) {
      await cdp.evaluate(`window.__db.command('settings')`);
      await waitUntil('设置', () => cdp.evaluate(`!document.querySelector('#settingsDialog').hidden`));
      await shot(cdp, 'settings');
      await click(cdp, '#settingsClose');
    }
    await openDoc(cdp, '跨端规则');
    if (want('comment')) await shot(cdp, 'comment');
    if (want('dialog')) {
      await cdp.evaluate(`(() => { const p = Array.from(document.querySelectorAll('#documentContent p')).find((x) => x.textContent.includes('批注写好')); const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 12); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); })()`);
      await sleep(300);
      await shot(cdp, 'selection');
      await cdp.evaluate(`document.querySelector('#annotateButton').click()`);
      await waitUntil('批注框', () => cdp.evaluate(`!document.querySelector('#annotationDialog').hidden`));
      await cdp.evaluate(`document.querySelector('#annotationText').value = '“先存在手机里”要说清楚存多久'`);
      await shot(cdp, 'dialog');
      await click(cdp, '#cancelAnnotation');
    }
    if (want('toast')) {
      await cdp.evaluate(`(() => { const r = document.querySelector('#toastRegion'); r.innerHTML = '<div class="toast"><span class="toast-text">已交给 AI · 2 条批注。</span></div><div class="toast"><span class="toast-text">已删除这条批注。</span><button class="toast-action" type="button">撤销</button></div><div class="toast error"><span class="toast-text">保存失败:磁盘空间不够。</span></div>'; })()`);
      await shot(cdp, 'toast');
      await cdp.evaluate(`document.querySelector('#toastRegion').innerHTML = ''`);
    }
    await openDoc(cdp, '定价页');
    if (want('conflict')) await shot(cdp, 'conflict');
    if (want('night')) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      if (process.env.NO_ANIM) await cdp.evaluate(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { animation: none !important; }'; document.head.appendChild(st); })()`);
      await openDoc(cdp, '发布说明');
      await shot(cdp, 'night');
      await openDoc(cdp, '产品方案');
      await shot(cdp, 'night-back');
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    }
    if (want('popovers')) {
      await openDoc(cdp, '产品方案');
      await click(cdp, '#notesHistoryTab');
      await sleep(300);
      await cdp.evaluate(`document.querySelector('#historyNotesList details') && (document.querySelector('#historyNotesList details').open = true)`);
      await click(cdp, '#reviewStatePill');
      await sleep(300);
      await shot(cdp, 'history-timeline');
      await click(cdp, '#reviewStatePill');
      await click(cdp, '#notesCurrentTab');
      await click(cdp, '#docTitleButton');
      await sleep(300);
      await shot(cdp, 'docinfo');
      await click(cdp, '#docTitleButton');
      await click(cdp, '#exportMenuButton');
      await sleep(300);
      await shot(cdp, 'export');
      await click(cdp, '#exportMenuButton');
      await cdp.evaluate(`window.__db.command('find')`);
      await sleep(200);
      await cdp.send('Input.insertText', { text: '邮筒' });
      await sleep(300);
      await shot(cdp, 'find');
      await cdp.evaluate(`document.querySelector('#findClose').click()`);
      await cdp.evaluate(`window.__db.command('quick-open')`);
      await sleep(400);
      await shot(cdp, 'quickopen');
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.evaluate(`window.__db.command('help-shortcuts')`);
      await sleep(400);
      await shot(cdp, 'shortcuts');
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
    if (want('approve')) {
      await openDoc(cdp, '空白轮');
      await waitUntil('通过 · 定稿', () => cdp.evaluate(`document.querySelector('#primaryAction').dataset.action === 'approve'`));
      await click(cdp, '#primaryAction');
      await waitUntil('原地确认', () => cdp.evaluate(`!document.querySelector('#finalizeConfirm').hidden`));
      await shot(cdp, 'approve-confirm');
      await click(cdp, '#finalizeStamp');
      await waitUntil('已定稿', () => cdp.evaluate(`document.querySelector('#reviewStateText').textContent.startsWith('已定稿')`), 15000);
      await shot(cdp, 'approve-done');
      console.log('toasts:', await cdp.evaluate(`Array.from(document.querySelectorAll('#toastRegion .toast')).map((t) => t.textContent).join(' | ')`));
    }
    if (want('handed')) { await openDoc(cdp, '等人接手'); await shot(cdp, 'handed'); }
    if (want('edit')) {
      await openDoc(cdp, '会议纪要');
      await click(cdp, '#editingModeButton');
      await waitUntil('编辑器', () => cdp.evaluate(`!document.querySelector('#editorPane').hidden`));
      await sleep(600);
      await shot(cdp, 'edit');
      await click(cdp, '#readingModeButton');
    }
    if (want('narrow')) {
      await openDoc(cdp, '跨端规则');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 800, deviceScaleFactor: scale, mobile: false });
      await sleep(400);
      await cdp.evaluate(`document.querySelector('#toggleRightTop').click()`);
      await shot(cdp, 'narrow');
      await cdp.evaluate(`document.querySelector('#toggleRightTop').click()`);
      await cdp.evaluate(`document.querySelector('#collapseLeft').click()`);
      await shot(cdp, 'collapsed');
      await cdp.evaluate(`document.querySelector('#toggleLeftTop').click()`);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: scale, mobile: false });
    }
    if (chrome.cdp.exceptions.length) console.log('页面异常:', chrome.cdp.exceptions.join(' | '));
  } finally {
    if (chrome) await stopChild(chrome.child);
    if (server) await stopChild(server.child);
  }
})().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
