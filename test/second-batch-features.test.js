'use strict';

// 第二批(常规功能)的服务端落点:图片落盘、另存为副本、删除批注可撤销、冲突的两条路、随包说明、动作表。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const store = require('../lib/review-store');
const documents = require('../lib/documents');
const Actions = require('../static/desktop-actions.js');
const PROJECT = path.resolve(__dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({ hostname: '127.0.0.1', port, path: encodeURI(pathname), method: options.method || 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-batch2-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}
async function startServer(t, dataDir) {
  const child = spawn(process.execPath, ['server.js'], { cwd: PROJECT, env: { ...process.env, DRAFTBACK_DATA_DIR: dataDir, DRAFTBACK_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill('SIGTERM'); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]); });
  const portFile = store.getPaths({ dataDir }).port;
  for (let i = 0; i < 200; i += 1) {
    try { const port = Number(fs.readFileSync(portFile, 'utf8').trim()); if (port) return port; } catch {}
    await sleep(50);
  }
  throw new Error('服务没有起来');
}

test('图片落盘:存到文档旁 images/,不覆盖、只收图片类型、审阅锁定时拒绝、images 指向外面时拒绝', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '图文 稿.md');
  fs.writeFileSync(doc, '# 图文\n');
  const data = PNG.toString('base64');
  const first = await documents.saveDocumentImage(doc, { name: 'image.png', type: 'image/png', data }, f.options);
  assert.match(first.relPath, /^images\/图文-稿-\d{8}-\d{6}\.png$/, '相对路径没有空格');
  assert.equal(fs.readFileSync(path.join(f.docDir, first.relPath)).equals(PNG), true);
  const second = await documents.saveDocumentImage(doc, { name: 'image.png', type: 'image/png', data }, f.options);
  assert.notEqual(second.relPath, first.relPath, '同一秒再存也不覆盖');
  await assert.rejects(documents.saveDocumentImage(doc, { type: 'text/html', data }, f.options), /只支持/);
  await assert.rejects(documents.saveDocumentImage(doc, { type: 'image/png', data: '' }, f.options), /缺少图片数据/);
  const big = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64');
  await assert.rejects(documents.saveDocumentImage(doc, { type: 'image/png', data: big }, f.options), /超过 20 MB/);

  const locked = path.join(f.docDir, '锁定.md');
  fs.writeFileSync(locked, '# 锁定\n');
  await store.openReview(locked, f.options);
  await assert.rejects(documents.saveDocumentImage(locked, { type: 'image/png', data }, f.options), (error) => error.code === 'REVIEW_ACTIVE');

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const sub = path.join(f.docDir, 'sub');
  fs.mkdirSync(sub);
  fs.symlinkSync(outside, path.join(sub, 'images'));
  const subDoc = path.join(sub, '外链.md');
  fs.writeFileSync(subDoc, '# 外链\n');
  await assert.rejects(documents.saveDocumentImage(subDoc, { type: 'image/png', data }, f.options), (error) => error.code === 'IMAGE_DIR');
  assert.deepEqual(fs.readdirSync(outside), [], '没有写到文档目录之外');
});

test('另存为副本:新文件新身份、不带旁注;不能存回原文件、不能盖掉正在审阅的文件;覆盖普通文件前先备份', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '原稿.md');
  fs.writeFileSync(doc, '# 原稿\n\n正文。\n');
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: '原稿.md', annotations: [{ id: 'n1', comment: '批', status: 'open' }] }));
  const copyPath = path.join(f.docDir, '原稿 副本.md');
  const copy = await documents.saveDocumentCopy(copyPath, { content: '# 原稿\n\n改过的正文。\n', sourcePath: doc }, f.options);
  assert.equal(copy.copied, true);
  assert.equal(fs.readFileSync(copyPath, 'utf8'), '# 原稿\n\n改过的正文。\n');
  assert.equal(fs.existsSync(`${copyPath}.annotations.json`), false, '副本不带批注');
  assert.equal(copy.latestReview, null, '副本没有审阅历史');
  await assert.rejects(documents.saveDocumentCopy(doc, { content: 'x', sourcePath: doc }, f.options), (error) => error.code === 'COPY_SAME_FILE');
  const reviewed = path.join(f.docDir, '审阅中.md');
  fs.writeFileSync(reviewed, '# 审阅中\n');
  await store.openReview(reviewed, f.options);
  await assert.rejects(documents.saveDocumentCopy(reviewed, { content: 'x' }, f.options), (error) => error.code === 'COPY_TARGET_HAS_HISTORY');
  assert.equal(fs.readFileSync(reviewed, 'utf8'), '# 审阅中\n', '正在审阅的文件没被盖掉');
  await documents.saveDocumentCopy(copyPath, { content: '# 再盖一次\n' }, f.options);
  assert.equal(fs.readFileSync(copyPath, 'utf8'), '# 再盖一次\n');
  const backups = path.join(f.dataDir, 'backups', 'documents');
  assert.ok(fs.readdirSync(backups).length >= 1, '覆盖前留了备份');
});

test('接口:删除批注可撤销(同 id、原位置;交出后撤销失效)、冲突两条路、随包说明', async (t) => {
  const f = fixture(t);
  const port = await startServer(t, f.dataDir);

  // 删除与撤销
  const doc = path.join(f.docDir, '撤销.md');
  fs.writeFileSync(doc, '# 撤销\n\n第一段。\n\n第二段。\n');
  const a = await request(port, '/api/app/review/open-annotate', { method: 'POST', body: { path: doc, note: { comment: '一', quote: '第一段。', clientRequestId: 'c1' } } });
  const reviewId = a.json.review.id;
  const b = await request(port, `/api/annotations?r=${reviewId}`, { method: 'POST', body: { comment: '二', quote: '第二段。' } });
  const c = await request(port, `/api/annotations?r=${reviewId}`, { method: 'POST', body: { comment: '三', quote: '第二段。' } });
  const middle = b.json.note.id;
  const del = await request(port, `/api/annotations?r=${reviewId}&id=${middle}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.json.undoable, true);
  assert.deepEqual(store.readAnnotations(doc).annotations.map((n) => n.id), [a.json.note.id, c.json.note.id]);
  const restored = await request(port, `/api/app/annotation/restore?r=${reviewId}&id=${middle}`, { method: 'POST' });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.deepEqual(store.readAnnotations(doc).annotations.map((n) => n.id), [a.json.note.id, middle, c.json.note.id], '同一个 id 放回原位置');
  const again = await request(port, `/api/app/annotation/restore?r=${reviewId}&id=${middle}`, { method: 'POST' });
  assert.equal(again.status, 410, '撤销只能用一次');
  // 交出后:撤销失效,本轮成员不变
  await request(port, `/api/annotations?r=${reviewId}&id=${c.json.note.id}`, { method: 'DELETE' });
  await request(port, `/api/review/submit?r=${reviewId}`, { method: 'POST', body: {} });
  const late = await request(port, `/api/app/annotation/restore?r=${reviewId}&id=${c.json.note.id}`, { method: 'POST' });
  assert.ok(late.status === 409 || late.status === 423, `交出后不能放回:${late.status} ${JSON.stringify(late.json)}`);
  assert.equal(store.readAnnotations(doc).annotations.some((n) => n.id === c.json.note.id), false);

  // 冲突一:以磁盘上的版本重新开始
  const doc1 = path.join(f.docDir, '冲突一.md');
  fs.writeFileSync(doc1, '# 冲突一\n\n原文。\n');
  const r1 = await request(port, '/api/app/review/open-annotate', { method: 'POST', body: { path: doc1, note: { comment: '批', quote: '原文。' } } });
  fs.writeFileSync(doc1, '# 冲突一\n\n外面改了。\n');
  await request(port, `/api/app/bundle?r=${r1.json.review.id}`);
  assert.equal((await store.getReviewById(r1.json.review.id, f.options)).status, 'conflict');
  const restart = await request(port, `/api/app/review/restart-from-disk?r=${r1.json.review.id}`, { method: 'POST' });
  assert.equal(restart.status, 200, JSON.stringify(restart.json));
  assert.equal(restart.json.review.status, 'cancelled');
  assert.equal(fs.readFileSync(doc1, 'utf8'), '# 冲突一\n\n外面改了。\n', '磁盘上的文件不动');
  assert.equal(store.readAnnotations(doc1).annotations[0].status, 'cancelled', '这一轮的批注作废但留着');

  // 冲突二:另存我的版本(锁定时的原稿 + 未处理批注带过去)
  const doc2 = path.join(f.docDir, '冲突二.md');
  fs.writeFileSync(doc2, '# 冲突二\n\n原文第二段。\n');
  const r2 = await request(port, '/api/app/review/open-annotate', { method: 'POST', body: { path: doc2, note: { comment: '改这句', quote: '原文第二段。' } } });
  fs.writeFileSync(doc2, '# 冲突二\n\n外面改过。\n');
  await request(port, `/api/app/bundle?r=${r2.json.review.id}`);
  const forkPath = path.join(f.docDir, '冲突二 我的版本.md');
  const fork = await request(port, `/api/app/review/fork?r=${r2.json.review.id}`, { method: 'POST', body: { path: forkPath } });
  assert.equal(fork.status, 200, JSON.stringify(fork.json));
  assert.equal(fork.json.carried, 1);
  assert.equal(fs.readFileSync(forkPath, 'utf8'), '# 冲突二\n\n原文第二段。\n', '副本是锁定时的原稿');
  assert.equal(fs.readFileSync(doc2, 'utf8'), '# 冲突二\n\n外面改过。\n', '磁盘上的文件不动');
  const forked = await store.getReviewById(fork.json.reviewId, f.options);
  assert.equal(forked.status, 'reviewing');
  const carried = store.readAnnotations(forkPath).annotations;
  assert.equal(carried.length, 1);
  assert.equal(carried[0].comment, '改这句');
  assert.equal(carried[0].reviewSessionId, forked.id);
  assert.equal(carried[0].forkedFrom.reviewId, r2.json.review.id);
  assert.equal((await store.getReviewById(r2.json.review.id, f.options)).status, 'cancelled', '原文件这一轮作废');
  const notConflict = await request(port, `/api/app/review/restart-from-disk?r=${fork.json.reviewId}`, { method: 'POST' });
  assert.equal(notConflict.status, 409, '不是冲突状态不处理');

  // 随包说明:复制到数据目录再打开
  const guide = await request(port, '/api/app/help/open', { method: 'POST', body: { name: 'guide' } });
  assert.equal(guide.status, 200);
  assert.ok(guide.json.path.startsWith(fs.realpathSync(path.join(f.dataDir, 'help'))));
  assert.match(fs.readFileSync(guide.json.path, 'utf8'), /^# 回稿使用说明/);
  const ai = await request(port, '/api/app/help/open', { method: 'POST', body: { name: 'ai' } });
  assert.match(fs.readFileSync(ai.json.path, 'utf8'), /mdreview claim/);
  assert.equal((await request(port, '/api/app/help/open', { method: 'POST', body: { name: '../../etc/passwd' } })).status, 400);

  // 图片接口
  const plain = path.join(f.docDir, '普通.md');
  fs.writeFileSync(plain, '# 普通\n');
  const image = await request(port, '/api/app/document/image', { method: 'POST', body: { path: plain, name: 'a.png', type: 'image/png', data: PNG.toString('base64') } });
  assert.equal(image.status, 200, JSON.stringify(image.json));
  assert.ok(fs.existsSync(path.join(f.docDir, image.json.relPath)));
});

test('动作表:每个快捷键都能解析、互不重复;页面命令都有处理;快捷键一览按菜单分组', () => {
  const items = Actions.flatten();
  const seen = new Map();
  for (const item of items) {
    if (!item.accelerator) continue;
    const parsed = Actions.parseAccelerator(item.accelerator);
    assert.ok(parsed, `${item.id} 的快捷键 ${item.accelerator} 解析不了`);
    const key = JSON.stringify(parsed);
    assert.ok(!seen.has(key), `${item.id} 与 ${seen.get(key)} 快捷键重复`);
    seen.set(key, item.id);
  }
  const page = fs.readFileSync(path.join(PROJECT, 'static', 'desktop.js'), 'utf8');
  const mainCommands = new Set(['open', 'reconnect']);
  for (const item of items) {
    if (!item.command || mainCommands.has(item.command) || item.command.startsWith('appearance:')) continue;
    const handled = item.command.startsWith('format:') ? page.includes("command.startsWith('format:')") : page.includes(`'${item.command}'`);
    assert.ok(handled, `页面没有处理命令 ${item.command}`);
  }
  assert.equal(Actions.displayAccelerator('Shift+Alt+CmdOrCtrl+M'), '⌥⇧⌘M');
  assert.equal(Actions.displayAccelerator('Ctrl+CmdOrCtrl+S'), '⌃⌘S');
  const event = { code: 'KeyM', metaKey: true, altKey: true, shiftKey: false, ctrlKey: false };
  assert.equal(Actions.actionForEvent(event).command, 'annotate');
  assert.equal(Actions.isEnabled(items.find((i) => i.id === 'save'), { hasDoc: true, mode: 'read' }), false, '阅读时保存置灰');
  assert.equal(Actions.isEnabled(items.find((i) => i.id === 'save'), { hasDoc: true, mode: 'edit' }), true);
  assert.equal(Actions.isEnabled(items.find((i) => i.id === 'submit'), { primary: 'finalize' }), false, '「交给 AI」只在主按钮就是交给 AI 时可点');
  const groups = Actions.shortcutList();
  assert.ok(groups.some((g) => g.menu === '稿件' && g.rows.some((r) => r.label === '批注所选文字' && r.keys === '⌥⌘M')));
  assert.ok(!groups.some((g) => g.rows.some((r) => /开发版/.test(r.label))), '一览里没有开发版菜单项');
});

test('Codex 审查修补:大小写别名不能绕过「不能存回原文件」与「不覆盖有历史的文件」;路径按磁盘上的写法归一', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, 'Report.md');
  fs.writeFileSync(doc, '# Report\n');
  const alias = path.join(f.docDir, 'report.md');
  if (!fs.existsSync(alias)) return; // 区分大小写的卷上没有别名问题
  assert.equal(store.normalizeMdPath(alias), doc, '按磁盘上的真实写法归一');
  await assert.rejects(documents.saveDocumentCopy(alias, { content: 'x', sourcePath: doc }, f.options), (error) => error.code === 'COPY_SAME_FILE');
  const { review } = await store.openReview(doc, f.options);
  assert.equal((await store.getReviewByPath(alias, { ...f.options, activeOnly: true })).id, review.id, '大小写不同也找得到同一个会话');
  const other = path.join(f.docDir, 'Other.md');
  fs.writeFileSync(other, '# Other\n');
  await assert.rejects(documents.saveDocumentCopy(path.join(f.docDir, 'REPORT.md'), { content: 'x', sourcePath: other }, f.options), (error) => error.code === 'COPY_TARGET_HAS_HISTORY');
  assert.equal(fs.readFileSync(doc, 'utf8'), '# Report\n');
});

test('Codex 审查修补:副本不覆盖有批注或审阅历史的文件;冲突另存遇到认不出的编码时拒绝且不作废原轮', async (t) => {
  const f = fixture(t);
  const withNotes = path.join(f.docDir, '有批注.md');
  fs.writeFileSync(withNotes, '# 有批注\n');
  fs.writeFileSync(`${withNotes}.annotations.json`, JSON.stringify({ version: 1, file: '有批注.md', annotations: [] }));
  await assert.rejects(documents.saveDocumentCopy(withNotes, { content: 'x' }, f.options), (error) => error.code === 'COPY_TARGET_HAS_HISTORY');
  const finished = path.join(f.docDir, '审过.md');
  fs.writeFileSync(finished, '# 审过\n');
  const { review } = await store.openReview(finished, f.options);
  await store.unlockReview(finished, '结束', f.options);
  fs.rmSync(`${finished}.annotations.json`, { force: true });
  await assert.rejects(documents.saveDocumentCopy(finished, { content: 'x' }, f.options), (error) => error.code === 'COPY_TARGET_HAS_HISTORY', `会话 ${review.id} 结束了也算历史`);

  const port = await startServer(t, f.dataDir);
  const odd = path.join(f.docDir, '怪编码.md');
  fs.writeFileSync(odd, Buffer.from([0x23, 0x20, 0x81, 0x0a]));
  const opened = await store.openReview(odd, f.options);
  fs.writeFileSync(odd, '# 外面改了\n');
  await request(port, `/api/app/bundle?r=${opened.review.id}`);
  const fork = await request(port, `/api/app/review/fork?r=${opened.review.id}`, { method: 'POST', body: { path: path.join(f.docDir, '怪编码 我的版本.md') } });
  assert.equal(fork.status, 409);
  assert.match(fork.json.message, /编码认不出来/);
  assert.equal((await store.getReviewById(opened.review.id, f.options)).status, 'conflict', '拒绝时原轮不动');

  // 说明目录被换成链接:不往外写
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-help-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.join(f.dataDir, 'help'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(f.dataDir, 'help'));
  const help = await request(port, '/api/app/help/open', { method: 'POST', body: { name: 'guide' } });
  assert.equal(help.status, 409);
  assert.deepEqual(fs.readdirSync(outside), []);
});
