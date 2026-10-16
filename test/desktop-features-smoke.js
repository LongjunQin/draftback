#!/usr/bin/env node
'use strict';

// 第二批常规功能的真实浏览器冒烟。页面里装一个假的桌面桥(代替 Electron 预加载脚本),
// 这样菜单命令、设置、另存对话框都能在无头 Chrome 里走一遍:
// 图片粘贴落盘、任务列表勾选框、编辑模式查找替换、格式命令与快捷键、删除批注可撤销、批注导航、⌘/ 切换、
// 快速打开、设置、快捷键一览、另存为副本、审阅中点编辑的两条路、冲突的「另存我的版本」、导入批注文件、帮助、菜单状态。
//
// 用法: node test/desktop-features-smoke.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/review-store');
const { sleep, waitUntil, stopChild, startServer, startChrome } = require('./helpers/browser-smoke');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FAKE_BRIDGE = `
  window.__db = { commands: [], menuState: null, recents: [], copyPath: null, batch: null, appearance: 'system', cover: 'mist', dockFollows: false, sync: true, revealed: null, external: null };
  window.draftbackDesktop = {
    platform: 'darwin',
    pickMarkdown: async () => [],
    revealPath: async (p) => { window.__db.revealed = p; return true; },
    openExternal: async (u) => { window.__db.external = u; return true; },
    notifyReviewComplete: async () => false,
    exportPdf: async () => ({ ok: false, cancelled: true }), print: async () => ({ ok: false }),
    newDocument: async () => ({ ok: false, cancelled: true }), exportHtml: async () => ({ ok: false, cancelled: true }), exportDocx: async () => ({ ok: false, cancelled: true }),
    setMenuState: (s) => { window.__db.menuState = s; },
    noteRecent: (p) => { window.__db.recents.push(p); },
    getSettings: async () => ({ appearance: window.__db.appearance, cover: window.__db.cover, dockIconFollowsCover: window.__db.dockFollows, syncEnabled: window.__db.sync, syncHelperAvailable: true, syncHelperRunning: true, version: '9.9.9', packaged: true,
      cli: { installed: true, path: '/usr/local/bin/mdreview', pointsTo: 'elsewhere', target: '/somewhere/mdreview.js' } }),
    setAppearance: async (v) => { window.__db.appearance = v; return v; },
    setCover: async (v) => { window.__db.cover = v; return v; },
    setDockIconFollowsCover: async (v) => { window.__db.dockFollows = v; return v; },
    setSyncEnabled: async (v) => { window.__db.sync = v; return { syncEnabled: v }; },
    installCli: async () => ({ ok: true, installed: true, path: '/usr/local/bin/mdreview', pointsTo: 'this-app' }),
    saveCopyDialog: async () => (window.__db.copyPath ? { ok: true, filePath: window.__db.copyPath } : { ok: false, cancelled: true }),
    pickBatchFile: async () => (window.__db.batch ? { ok: true, name: window.__db.batch.name, text: window.__db.batch.text } : { ok: false, cancelled: true }),
    pathsForFiles: () => [],
    onOpenFiles: (cb) => { window.__db.openFiles = cb; return () => {}; },
    onCommand: (cb) => { window.__db.command = cb; return () => {}; },
    onActivateReview: (cb) => { window.__db.activate = cb; return () => {}; },
  };
`;

async function key(cdp, keyName, code, vk, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, modifiers, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers, windowsVirtualKeyCode: vk });
}
const ALT = 1, META = 4, SHIFT = 8;
const command = (cdp, name) => cdp.evaluate(`window.__db.command(${JSON.stringify(name)})`);
const toastHas = (cdp, text) => cdp.evaluate(`Array.from(document.querySelectorAll('#toastRegion .toast')).some((t) => t.textContent.includes(${JSON.stringify(text)}))`);
const activeTitle = (cdp) => cdp.evaluate(`(document.querySelector('#tabList .tab.active .tab-title') || {}).textContent || ''`);

async function openRecent(cdp, name) {
  await cdp.evaluate(`document.querySelector('#filesModeButton').click()`);
  await waitUntil(`最近文件里有 ${name}`, () => cdp.evaluate(`Array.from(document.querySelectorAll('#recentList .recent-item')).some((i) => i.textContent.includes(${JSON.stringify(name)}))`));
  await cdp.evaluate(`Array.from(document.querySelectorAll('#recentList .recent-item')).find((i) => i.textContent.includes(${JSON.stringify(name)})).click()`);
  await waitUntil(`打开 ${name}`, async () => (await activeTitle(cdp)).includes(name));
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-features-smoke-')));
  const dataDir = path.join(root, '.draftback');
  const docs = path.join(root, 'docs');
  const profileDir = path.join(root, 'chrome-profile');
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const plain = path.join(docs, '普通稿.md');
  const tasks = path.join(docs, '任务稿.md');
  const reviewed = path.join(docs, '审阅稿.md');
  const conflict = path.join(docs, '冲突稿.md');
  fs.writeFileSync(plain, '# 普通稿\n\n第一段写着苹果和苹果。\n\n第二段。\n');
  fs.writeFileSync(tasks, '# 任务稿\n\n- [ ] 没做的事\n- [x] 做完的事\n- 普通列表项\n');
  fs.writeFileSync(reviewed, '# 审阅稿\n\n第一段要改。\n\n第二段也要改。\n');
  fs.writeFileSync(conflict, '# 冲突稿\n\n锁定时的原文。\n');
  const gbk = path.join(docs, '旧编码.md');
  fs.writeFileSync(gbk, Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a])); // "# 中文" 的 GBK 字节
  store.ensureDataDir({ dataDir });
  const options = { dataDir };
  for (const doc of [plain, tasks, gbk]) await require('../lib/documents').touchRecent(doc, options);
  const { review } = await store.openReview(reviewed, options);
  await store.mutateAnnotations(reviewed, (data) => {
    data.annotations.push(
      { id: 'n-first', comment: '第一条', quote: '第一段要改。', headingPath: ['审阅稿'], reviewSessionId: review.id, status: 'open', createdAt: '2026-10-15T01:00:00Z', lineStart: 3, lineEnd: 3, startTextOffset: 0, endTextOffset: 6, anchorVersion: 3 },
      { id: 'n-second', comment: '第二条', quote: '第二段也要改。', headingPath: ['审阅稿'], reviewSessionId: review.id, status: 'open', createdAt: '2026-10-15T01:01:00Z', lineStart: 5, lineEnd: 5, startTextOffset: 0, endTextOffset: 7, anchorVersion: 3 },
    );
  }, options);
  const conflictReview = (await store.openReview(conflict, options)).review;
  await store.mutateAnnotations(conflict, (data) => {
    data.annotations.push({ id: 'c-1', comment: '冲突前的批注', quote: '锁定时的原文。', reviewSessionId: conflictReview.id, status: 'open', createdAt: '2026-10-15T01:02:00Z' });
  }, options);

  let server = null;
  let chrome = null;
  try {
    server = await startServer(dataDir);
    chrome = await startChrome(profileDir);
    const cdp = chrome.cdp;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });
    await waitUntil('页面就绪', () => cdp.evaluate(`document.readyState === 'complete' && typeof window.__db.command === 'function' && document.querySelectorAll('#recentList .recent-item').length >= 4`));

    // 1. 任务列表:阅读时是只读勾选框,文字里没有 [ ]
    await openRecent(cdp, '任务稿.md');
    await waitUntil('任务列表勾选框', () => cdp.evaluate(`document.querySelectorAll('#documentContent .task-check').length === 2`));
    const taskDom = await cdp.evaluate(`({
      checked: document.querySelectorAll('#documentContent .task-check.checked').length,
      text: document.querySelector('#documentContent ul').textContent,
      listClass: document.querySelector('#documentContent ul').className,
      itemClasses: Array.from(document.querySelectorAll('#documentContent li')).map((li) => li.className),
    })`);
    assert.equal(taskDom.checked, 1);
    // 「[ ] 」原文仍在正文文字里(看不见):旧批注的文字坐标不变(Codex 审查第 11 条)
    assert.match(taskDom.text, /\[ \] 没做的事/);
    assert.equal(await cdp.evaluate(`document.querySelector('#documentContent .task-marker').getBoundingClientRect().width <= 1`), true, '[ ] 文字看不见');
    assert.match(taskDom.listClass, /contains-task-list/);
    assert.deepEqual(taskDom.itemClasses, ['task-list-item', 'task-list-item', ''], '普通列表项不受影响');
    const state1 = await cdp.evaluate(`window.__db.menuState`);
    assert.equal(state1.hasDoc, true); assert.equal(state1.mode, 'read'); assert.equal(state1.plain, true);
    assert.ok((await cdp.evaluate(`window.__db.recents`)).includes(tasks), '打开的文档进系统「打开最近」');

    // 1b. GBK 文件:按原样显示,状态区标只读,「编辑」置灰(此前页面从没真正标出只读)
    await openRecent(cdp, '旧编码.md');
    await waitUntil('GBK 只读', () => cdp.evaluate(`document.querySelector('#documentContent').textContent.includes('中文') && document.querySelector('#reviewStateText').textContent.includes('GBK 只读') && document.querySelector('#editingModeButton').disabled`));
    await key(cdp, '/', 'Slash', 191, META);
    await sleep(200);
    assert.equal(await cdp.evaluate(`document.querySelector('#editorPane').hidden`), true, '只读文件 ⌘/ 不进编辑');
    assert.match(await cdp.evaluate(`document.querySelector('#stateCard').hidden ? '' : document.querySelector('#stateCard').textContent`), /GBK 编码 · 只读.*另存为 UTF-8/, '批注栏顶部说明只读与怎么办');

    // 2. ⌘/ 切换到编辑;粘贴图片 → 存到 images/,编辑器里显示;⌘S 写回相对路径
    await openRecent(cdp, '普通稿.md');
    await key(cdp, '/', 'Slash', 191, META);
    await waitUntil('⌘/ 进入编辑', () => cdp.evaluate(`!document.querySelector('#editorPane').hidden && !!document.querySelector('#codeEditor .ProseMirror')`));
    await waitUntil('菜单状态变成编辑', async () => (await cdp.evaluate(`window.__db.menuState && window.__db.menuState.mode`)) === 'edit');
    await sleep(300);
    await cdp.evaluate(`(() => {
      const pm = document.querySelector('#codeEditor .ProseMirror');
      pm.focus();
      const para = Array.from(pm.querySelectorAll('p')).find((p) => p.textContent.includes('第二段'));
      const range = document.createRange(); range.selectNodeContents(para); range.collapse(false);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    })()`);
    await sleep(100);
    await cdp.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'image.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(file);
      const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector('#codeEditor .ProseMirror').dispatchEvent(event);
    })()`);
    await waitUntil('图片存到 images/', () => fs.existsSync(path.join(docs, 'images')) && fs.readdirSync(path.join(docs, 'images')).some((name) => name.endsWith('.png')));
    await waitUntil('编辑器里显示图片(经本地服务)', () => cdp.evaluate(`Array.from(document.querySelectorAll('#codeEditor img')).some((img) => img.getAttribute('src').startsWith('/api/app/file?') && img.complete && img.naturalWidth > 0)`));
    await key(cdp, 's', 'KeyS', 83, META);
    try {
      await waitUntil('⌘S 写回相对路径', () => /!\[[^\]]*\]\(images\/普通稿-\d{8}-\d{6}\.png\)/.test(fs.readFileSync(plain, 'utf8')));
    } catch (error) {
      console.error('文件内容:', JSON.stringify(fs.readFileSync(plain, 'utf8')));
      console.error('页面:', JSON.stringify(await cdp.evaluate(`({ toasts: Array.from(document.querySelectorAll('#toastRegion .toast')).map((t) => t.textContent), save: document.querySelector('#editorSaveState').textContent, confirm: document.querySelector('#confirmDialog').hidden ? null : document.querySelector('#confirmMessage').textContent, imgs: Array.from(document.querySelectorAll('#codeEditor img')).map((i) => i.getAttribute('src')) })`)));
      throw error;
    }

    // 3. 编辑模式查找替换:⌥⌘F 出替换行,全部替换后保存
    await key(cdp, 'f', 'KeyF', 70, ALT | META);
    await waitUntil('替换行出现', () => cdp.evaluate(`!document.querySelector('#findBar').hidden && !document.querySelector('#replaceRow').hidden`));
    await cdp.evaluate(`(() => { const i = document.querySelector('#findInput'); i.value = '苹果'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitUntil('找到两处', () => cdp.evaluate(`document.querySelector('#findCount').textContent === '1 / 2' && document.querySelectorAll('#codeEditor .db-find-match').length === 2`));
    // 逐个替换:换上的文字里又含查找词时,下一处要从换完的位置往后找(Codex 审查第 7 条)
    await cdp.evaluate(`document.querySelector('#replaceInput').value = '苹果树'; document.querySelector('#replaceOne').click(); document.querySelector('#replaceOne').click();`);
    await waitUntil('逐个替换两次', () => cdp.evaluate(`document.querySelector('#codeEditor .ProseMirror').textContent.includes('第一段写着苹果树和苹果树。')`));
    await cdp.evaluate(`(() => { const i = document.querySelector('#findInput'); i.value = '苹果树'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await cdp.evaluate(`document.querySelector('#replaceInput').value = '香蕉'; document.querySelector('#replaceAll').click();`);
    await waitUntil('替换提示', () => toastHas(cdp, '已替换 2 处'));
    await key(cdp, 'Escape', 'Escape', 27);
    await key(cdp, 's', 'KeyS', 83, META);
    await waitUntil('替换写回文件', () => fs.readFileSync(plain, 'utf8').includes('第一段写着香蕉和香蕉。'));

    // 4. 格式:菜单命令(标题 2)与编辑模式捕获的快捷键(⌥⌘X 任务列表)
    await cdp.evaluate(`(() => {
      const pm = document.querySelector('#codeEditor .ProseMirror'); pm.focus();
      const para = Array.from(pm.querySelectorAll('p')).find((p) => p.textContent.includes('第二段'));
      const range = document.createRange(); range.setStart(para.firstChild, 1); range.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    })()`);
    await sleep(100);
    await command(cdp, 'format:h2');
    await waitUntil('标题 2', () => cdp.evaluate(`Array.from(document.querySelectorAll('#codeEditor h2')).some((h) => h.textContent.includes('第二段'))`));
    await cdp.evaluate(`(() => {
      const pm = document.querySelector('#codeEditor .ProseMirror'); pm.focus();
      const para = Array.from(pm.querySelectorAll('p')).find((p) => p.textContent.includes('第一段'));
      const range = document.createRange(); range.setStart(para.firstChild, 1); range.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    })()`);
    await sleep(100);
    await key(cdp, 'x', 'KeyX', 88, ALT | META);
    await key(cdp, 's', 'KeyS', 83, META);
    await waitUntil('格式写回', () => { const text = fs.readFileSync(plain, 'utf8'); return text.includes('## 第二段') && /- \[ \] 第一段/.test(text); });
    await key(cdp, '/', 'Slash', 191, META);
    await waitUntil('⌘/ 回到阅读', () => cdp.evaluate(`!document.querySelector('#readerScroll').hidden && document.querySelector('#editorPane').hidden`));

    // 5. 快速打开 ⇧⌘O
    await key(cdp, 'o', 'KeyO', 79, SHIFT | META);
    await waitUntil('快速打开', () => cdp.evaluate(`!document.querySelector('#quickOpen').hidden && document.activeElement === document.querySelector('#quickOpenInput')`));
    await cdp.evaluate(`(() => { const i = document.querySelector('#quickOpenInput'); i.value = '审阅'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitUntil('只剩审阅稿', () => cdp.evaluate(`document.querySelectorAll('#quickOpenList .quick-open-item').length === 1`));
    await key(cdp, 'Enter', 'Enter', 13);
    await waitUntil('打开审阅稿', async () => (await activeTitle(cdp)).includes('审阅稿.md'));
    await waitUntil('审阅稿正文', () => cdp.evaluate(`document.querySelector('#documentContent').textContent.includes('第二段也要改')`));

    // 6. 批注导航 ⌥⌘↓,删除可撤销(同 id 放回)
    await key(cdp, 'ArrowDown', 'ArrowDown', 40, ALT | META);
    await waitUntil('导航到第一条', () => cdp.evaluate(`!!document.querySelector('#openNotesList .note-card.focused[data-note-id="n-first"]')`));
    await key(cdp, 'ArrowDown', 'ArrowDown', 40, ALT | META);
    await waitUntil('导航到第二条', () => cdp.evaluate(`!!document.querySelector('#openNotesList .note-card.focused[data-note-id="n-second"]')`));
    await cdp.evaluate(`Array.from(document.querySelectorAll('#openNotesList .note-card[data-note-id="n-first"] .note-actions button')).find((b) => b.textContent === '删除').click()`);
    await waitUntil('删除提示带撤销', () => cdp.evaluate(`!!Array.from(document.querySelectorAll('#toastRegion .toast-action')).find((b) => b.textContent === '撤销')`));
    assert.equal(await cdp.evaluate(`document.querySelector('#confirmDialog').hidden`), true, '删除不再弹确认框');
    assert.equal(store.readAnnotations(reviewed).annotations.some((n) => n.id === 'n-first'), false);
    await cdp.evaluate(`Array.from(document.querySelectorAll('#toastRegion .toast-action')).find((b) => b.textContent === '撤销').click()`);
    await waitUntil('撤销后放回', () => store.readAnnotations(reviewed).annotations[0].id === 'n-first');
    await waitUntil('界面也放回', () => cdp.evaluate(`!!document.querySelector('#openNotesList .note-card[data-note-id="n-first"]')`));
    // 在「历史」页时按 ⌥⌘↓ 定位本轮批注:右栏切回「本轮」,卡片看得见(Codex 审查第二步第 7 条)
    await cdp.evaluate(`document.querySelector('#notesHistoryTab').click()`);
    await waitUntil('切到历史', () => cdp.evaluate(`!document.querySelector('#historySection').hidden`));
    await key(cdp, 'ArrowDown', 'ArrowDown', 40, ALT | META);
    await waitUntil('定位时切回本轮', () => cdp.evaluate(`document.querySelector('#historySection').hidden && !document.querySelector('#currentPane').hidden && !!document.querySelector('#openNotesList .note-card.focused')`));
    assert.equal(await cdp.evaluate(`document.querySelector('#openNotesLabel').textContent`), '未交');

    // 7. 审阅中点「编辑」:原文已锁定,选「另存为副本」→ 新文件、原稿与批注不动
    const copyPath = path.join(docs, '审阅稿 副本.md');
    await cdp.evaluate(`window.__db.copyPath = ${JSON.stringify(copyPath)}`);
    await cdp.evaluate(`document.querySelector('#editingModeButton').click()`);
    await waitUntil('原文已锁定', () => cdp.evaluate(`!document.querySelector('#confirmDialog').hidden && document.querySelector('#confirmTitle').textContent === '原文已锁定'`));
    await cdp.evaluate(`document.querySelector('#confirmAlt').click()`);
    await waitUntil('副本打开', async () => (await activeTitle(cdp)).includes('审阅稿 副本.md'));
    assert.equal(fs.readFileSync(copyPath, 'utf8'), fs.readFileSync(reviewed, 'utf8'));
    assert.equal(fs.existsSync(`${copyPath}.annotations.json`), false);
    assert.equal((await store.getReviewById(review.id, options)).status, 'reviewing', '原稿这一轮不受影响');

    // 8. 冲突:外面改了文件 → 「处理…」→ 另存我的版本(带批注)
    await openRecent(cdp, '冲突稿.md');
    fs.writeFileSync(conflict, '# 冲突稿\n\n外面改过的。\n');
    // 切到别的标签再切回来:回到标签时重新读一次,发现原文在外面被改了
    await cdp.evaluate(`Array.from(document.querySelectorAll('#tabList .tab')).find((t) => t.textContent.includes('普通稿.md')).click()`);
    await waitUntil('切走', async () => (await activeTitle(cdp)).includes('普通稿.md'));
    await cdp.evaluate(`Array.from(document.querySelectorAll('#tabList .tab')).find((t) => t.textContent.includes('冲突稿.md')).click()`);
    await waitUntil('冲突状态与「处理…」', () => cdp.evaluate(`document.querySelector('#reviewStateText').textContent.includes('外面被改') && document.querySelector('#primaryAction').textContent === '处理…'`));
    assert.equal(await cdp.evaluate(`!document.querySelector('#stateCard').hidden && document.querySelector('#stateCard').dataset.tone`), 'conflict', '批注栏顶部一张冲突说明卡');
    const forkPath = path.join(docs, '冲突稿 我的版本.md');
    await cdp.evaluate(`window.__db.copyPath = ${JSON.stringify(forkPath)}`);
    await cdp.evaluate(`document.querySelector('#primaryAction').click()`);
    await waitUntil('冲突对话框', () => cdp.evaluate(`!document.querySelector('#confirmDialog').hidden && document.querySelector('#confirmAlt').textContent.includes('另存我的版本')`));
    await cdp.evaluate(`document.querySelector('#confirmAlt').click()`);
    await waitUntil('我的版本打开', async () => (await activeTitle(cdp)).includes('冲突稿 我的版本.md'));
    await waitUntil('批注带过去', () => cdp.evaluate(`Array.from(document.querySelectorAll('#openNotesList .note-comment')).some((n) => n.textContent === '冲突前的批注')`));
    assert.equal(fs.readFileSync(forkPath, 'utf8'), '# 冲突稿\n\n锁定时的原文。\n');
    assert.equal((await store.getReviewById(conflictReview.id, options)).status, 'cancelled');

    // 9. 设置 ⌘,:版本、外观、字号、命令行工具状态;Esc 关闭
    await key(cdp, ',', 'Comma', 188, META);
    await waitUntil('设置打开', () => cdp.evaluate(`!document.querySelector('#settingsDialog').hidden && document.querySelector('#aboutLine').textContent.includes('9.9.9')`));
    assert.match(await cdp.evaluate(`document.querySelector('#cliStatusLine').textContent`), /指向别处/);
    assert.equal(await cdp.evaluate(`document.querySelector('#cliInstallButton').textContent`), '改为指向这个回稿');
    // 封面颜色(方案 C,2026-10-16 用户定 6 种,默认青雾蓝):点色块,窗口跟着换色并存进设置;程序坞图标可以跟着换
    assert.equal(await cdp.evaluate(`document.querySelectorAll('#coverSwatches [data-cover]').length`), 6);
    assert.equal(await cdp.evaluate(`document.querySelector('#coverSwatches [data-cover="mist"]').getAttribute('aria-checked')`), 'true', '默认青雾蓝');
    await cdp.evaluate(`document.querySelector('#coverSwatches [data-cover="sage"]').click()`);
    await waitUntil('封面换成鼠尾草绿', async () => (await cdp.evaluate(`window.__db.cover`)) === 'sage' && (await cdp.evaluate(`document.documentElement.dataset.cover`)) === 'sage');
    assert.equal(await cdp.evaluate(`localStorage.getItem('draftback.cover')`), 'sage', '本地留一份,下次第一次绘制前就用它');
    assert.equal(await cdp.evaluate(`document.querySelector('#coverSwatches [data-cover="sage"]').getAttribute('aria-checked')`), 'true');
    assert.equal(await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--c1').trim()`), '#9fb099', '皮面颜色跟着换');
    await cdp.evaluate(`document.querySelector('#dockIconToggle').click()`);
    await waitUntil('程序坞图标跟着封面换', async () => (await cdp.evaluate(`window.__db.dockFollows`)) === true && (await cdp.evaluate(`document.querySelector('#dockIconToggle').getAttribute('aria-checked')`)) === 'true');
    assert.deepEqual(await cdp.evaluate(`Array.from(document.querySelectorAll('#appearanceSegment button')).map((b) => b.textContent)`), ['跟随系统', '日间', '夜读'], '外观改叫日间 / 夜读');
    await cdp.evaluate(`document.querySelector('#appearanceSegment [data-appearance="dark"]').click()`);
    await waitUntil('外观设为深色', async () => (await cdp.evaluate(`window.__db.appearance`)) === 'dark');
    await cdp.evaluate(`(() => { const r = document.querySelector('#zoomRange'); r.value = '150'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--reader-zoom')`), '1.5');
    await cdp.evaluate(`document.querySelector('#zoomResetButton').click()`);
    await key(cdp, 'Escape', 'Escape', 27);
    await waitUntil('设置关闭', () => cdp.evaluate(`document.querySelector('#settingsDialog').hidden`));

    // 10. 帮助:快捷键一览、使用说明;导入批注文件(坏文件);在访达中显示;标签切换
    await command(cdp, 'help-shortcuts');
    await waitUntil('快捷键一览', () => cdp.evaluate(`!document.querySelector('#infoDialog').hidden && document.querySelector('#infoBody').textContent.includes('批注所选文字') && document.querySelector('#infoBody').textContent.includes('⌥⌘M')`));
    await key(cdp, 'Escape', 'Escape', 27);
    await command(cdp, 'help-guide');
    await waitUntil('使用说明打开', async () => (await activeTitle(cdp)).includes('回稿使用说明.md'));
    await cdp.evaluate(`window.__db.batch = { name: '坏批次.json', text: '不是 JSON' }`);
    await command(cdp, 'import-batch');
    await waitUntil('坏批次提示', () => toastHas(cdp, '不是有效的批注批次文件'));
    await command(cdp, 'reveal');
    assert.match(await cdp.evaluate(`window.__db.revealed`), /回稿使用说明\.md$/);
    const before = await activeTitle(cdp);
    await key(cdp, '[', 'BracketLeft', 219, SHIFT | META);
    await waitUntil('⇧⌘[ 切到上一个标签', async () => (await activeTitle(cdp)) !== before);
    const menu = await cdp.evaluate(`window.__db.menuState`);
    assert.ok(menu.tabs >= 5, `菜单状态里有标签数:${menu.tabs}`);

    const errors = cdp.exceptions.concat(cdp.consoleMessages.filter((m) => m.type === 'error').map((m) => m.text))
      .filter((text) => !/favicon|ERR_|net::|Failed to load resource.*404/.test(text));
    assert.deepEqual(errors, [], `页面不应有脚本异常:${errors.join(' | ')}`);
    console.log('PASS: 任务勾选框、⌘/ 切换、图片粘贴落盘、编辑查找替换、格式命令与快捷键、快速打开、批注导航、删除可撤销、锁定时另存副本、冲突另存我的版本、设置、快捷键一览、使用说明、导入、访达、标签切换、菜单状态。');
  } finally {
    if (chrome) await stopChild(chrome.child);
    if (server) await stopChild(server.child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
