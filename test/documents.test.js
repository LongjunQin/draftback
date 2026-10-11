'use strict';

// 普通文档层(阅读与审阅分离):不建会话的读写、外部变化检测、幂等、备份、
// 审阅中拒绝普通写入、编辑登记阻止 mdreview open、最近文件合并。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const store = require('../lib/review-store');
const documents = require('../lib/documents');
const PROJECT = path.resolve(__dirname, '..');

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-documents-')));
  const dataDir = path.join(root, '.mdread');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}

test('普通读写:不建会话;外部改动拒写;幂等;覆盖前备份;审阅中拒绝普通写入', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const doc = path.join(docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n第一版\n');

  const opened = await documents.readDocument(doc, options);
  assert.equal(opened.document.id, documents.documentId(doc));
  assert.equal(opened.source.content, '# 方案\n第一版\n');
  assert.equal(opened.activeReview, null);
  assert.equal(opened.editing, null);
  assert.equal(await store.getReviewByPath(doc, { ...options, activeOnly: true }), null, '普通打开不得创建审阅会话');
  assert.equal(fs.existsSync(store.sidecarFor(doc)), false, '普通打开不得创建 sidecar');

  const first = await documents.writeDocument(doc, { content: '# 方案\n第二版\n', expectedHash: opened.source.hash, clientRequestId: 'w1' }, options);
  assert.equal(first.changed, true);
  assert.equal(fs.readFileSync(doc, 'utf8'), '# 方案\n第二版\n');
  assert.ok(first.backup && fs.existsSync(first.backup), '覆盖前必须备份旧内容');
  assert.equal(fs.readFileSync(first.backup, 'utf8'), '# 方案\n第一版\n');

  const repeated = await documents.writeDocument(doc, { content: '# 方案\n第二版\n', expectedHash: opened.source.hash, clientRequestId: 'w1' }, options);
  assert.equal(repeated.reused, true, '同一 clientRequestId 重复提交直接复用结果');
  assert.equal(repeated.currentHash, first.currentHash);

  await assert.rejects(
    () => documents.writeDocument(doc, { content: '# 方案\n第三版\n', expectedHash: opened.source.hash, clientRequestId: 'w2' }, options),
    (error) => error.code === 'SOURCE_CHANGED' && error.details.currentHash === first.currentHash,
  );
  assert.equal(fs.readFileSync(doc, 'utf8'), '# 方案\n第二版\n', '过期指纹的写入不得落盘');

  const same = await documents.writeDocument(doc, { content: '# 方案\n第二版\n', expectedHash: first.currentHash, clientRequestId: 'w3' }, options);
  assert.equal(same.changed, false);
  assert.equal(same.backup, null, '内容未变不写文件也不备份');

  await store.openReview(doc, options);
  const reread = await documents.readDocument(doc, options);
  assert.equal(reread.activeReview.status, 'reviewing', '普通打开要告诉界面这篇文档正在审阅');
  await assert.rejects(
    () => documents.writeDocument(doc, { content: '# 方案\n乱改\n', expectedHash: first.currentHash, clientRequestId: 'w4' }, options),
    (error) => error.code === 'REVIEW_ACTIVE',
  );
  assert.equal(fs.readFileSync(doc, 'utf8'), '# 方案\n第二版\n', '审阅中原文冻结');

  await assert.rejects(() => documents.writeDocument(doc, { content: 'x', expectedHash: 'nope' }, options), (error) => error.code === 'INVALID_PAYLOAD');
  await assert.rejects(() => documents.readDocument(path.join(docDir, '不存在.md'), options), (error) => error.code === 'SOURCE_NOT_FOUND');
});

test('备份轮换:每篇文档最多保留 10 份覆盖前备份', async (t) => {
  const { docDir, options, dataDir } = setup(t);
  const doc = path.join(docDir, '轮换.md');
  fs.writeFileSync(doc, '第 0 版\n');
  let hash = (await documents.readDocument(doc, options)).source.hash;
  let backupDir = null;
  for (let version = 1; version <= 13; version += 1) {
    const result = await documents.writeDocument(doc, { content: `第 ${version} 版\n`, expectedHash: hash }, options);
    hash = result.currentHash;
    backupDir = path.dirname(result.backup);
  }
  assert.ok(backupDir.startsWith(path.join(dataDir, 'backups', 'documents')));
  const kept = fs.readdirSync(backupDir).filter((name) => name.endsWith('.md'));
  assert.equal(kept.length, 10);
  assert.equal(fs.readFileSync(path.join(backupDir, kept.sort().at(-1)), 'utf8'), '第 12 版\n', '最新备份是最后一次覆盖前的内容');
});

test('编辑登记:登记期间 openReview 拒绝冻结;退出登记后可冻结;过期进程的登记忽略;服务启动清空', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const doc = path.join(docDir, '编辑中.md');
  fs.writeFileSync(doc, '# 编辑中\n');

  const begun = await documents.setEditing(doc, true, { token: 'tab-a' }, options);
  assert.equal(begun.editing, true);
  assert.ok(documents.isEditing(doc, options));
  await assert.rejects(() => store.openReview(doc, options), (error) => error.code === 'USER_EDITING');
  assert.equal(await store.getReviewByPath(doc, { ...options, activeOnly: true }), null);

  const other = await documents.setEditing(doc, false, { token: 'tab-b' }, options);
  assert.equal(other.editing, true, '别的标签不能替本标签解除登记');
  const ended = await documents.setEditing(doc, false, { token: 'tab-a' }, options);
  assert.equal(ended.editing, false);
  assert.equal(documents.isEditing(doc, options), null);
  const opened = await store.openReview(doc, options);
  assert.equal(opened.review.status, 'reviewing');

  // 过期进程留下的登记:写入一个不存在的 pid。
  const editingFile = path.join(dataDir, 'editing.json');
  fs.writeFileSync(editingFile, JSON.stringify({ version: 1, entries: { [doc]: { since: 'x', token: 't', pid: 999999999 } } }));
  assert.equal(documents.isEditing(doc, options), null, '进程不在的登记视为过期');
  assert.deepEqual(documents.listEditing(options), []);

  // CLI 入口同样被挡住,并给出指引。
  await store.unlockReview(doc, '测试', options);
  await documents.setEditing(doc, true, { token: 'tab-a' }, options);
  const cli = spawnSync(process.execPath, ['mdreview.js', 'open', doc, '--no-open'], { cwd: PROJECT, env: { ...process.env, MDREAD_DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /USER_EDITING/);
  assert.match(cli.stderr, /退出编辑模式/);

  await documents.clearEditing(options);
  assert.deepEqual(documents.listEditing(options), []);
});

test('最近文件:普通打开与审阅打开合并,按最后打开时间排序,带活动会话与编辑标记', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const plain = path.join(docDir, '普通.md');
  const reviewed = path.join(docDir, '审阅.md');
  const finished = path.join(docDir, '已完成.md');
  for (const file of [plain, reviewed, finished]) fs.writeFileSync(file, `# ${path.basename(file)}\n`);

  await documents.readDocument(plain, options);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.openReview(reviewed, options);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const done = await store.openReview(finished, options);
  await store.unlockReview(finished, '完成', options);
  await documents.setEditing(plain, true, { token: 't' }, options);

  const items = await documents.listRecent(options);
  assert.deepEqual(items.map((item) => item.file), ['已完成.md', '审阅.md', '普通.md']);
  const byFile = Object.fromEntries(items.map((item) => [item.file, item]));
  assert.equal(byFile['普通.md'].activeReview, null);
  assert.equal(byFile['普通.md'].editing, true);
  assert.equal(byFile['审阅.md'].activeReview.status, 'reviewing');
  assert.equal(byFile['审阅.md'].activeReview.openCount, 0);
  assert.equal(byFile['已完成.md'].activeReview, null);
  assert.equal(byFile['已完成.md'].lastReview.id, done.review.id);
  assert.equal(byFile['已完成.md'].lastReview.status, 'cancelled');
  assert.ok(items.every((item) => item.exists));

  fs.unlinkSync(plain);
  const after = await documents.listRecent(options);
  assert.equal(after.find((item) => item.file === '普通.md').exists, false, '文件没了仍列出但标记不存在');
  await documents.forgetRecent(plain, options);
  assert.ok(!(await documents.listRecent(options)).some((item) => item.file === '普通.md'));
});

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...(options.headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('服务接口:/api/app/document* 与 /api/app/recent;启动清空编辑登记', async (t) => {
  const { dataDir, docDir } = setup(t);
  const doc = path.join(docDir, '接口.md');
  fs.writeFileSync(doc, '# 接口\n正文\n');
  fs.writeFileSync(path.join(dataDir, 'editing.json'), JSON.stringify({ version: 1, entries: { [doc]: { since: 'x', token: 't', pid: process.pid } } }));

  const child = spawn(process.execPath, ['server.js'], { cwd: PROJECT, env: { ...process.env, MDREAD_DATA_DIR: dataDir, MDREAD_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  });
  const portFile = store.getPaths({ dataDir }).port;
  const deadline = Date.now() + 5000;
  let port = 0;
  while (Date.now() < deadline && !port) {
    try { port = Number(fs.readFileSync(portFile, 'utf8').trim()); } catch {}
    if (!port) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(port > 0, stderr);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(documents.listEditing({ dataDir }), [], '服务启动必须清空上次留下的编辑登记');

  const opened = await request(port, '/api/app/document/open', { method: 'POST', body: { path: doc } });
  assert.equal(opened.status, 200, opened.text);
  assert.equal(opened.json.source.content, '# 接口\n正文\n');
  assert.equal(opened.json.activeReview, null);

  const editing = await request(port, '/api/app/document/editing', { method: 'POST', body: { path: doc, editing: true, token: 'tab-1' } });
  assert.equal(editing.status, 200);
  assert.equal(editing.json.editing, true);
  assert.ok(documents.isEditing(doc, { dataDir }));

  const saved = await request(port, '/api/app/document', { method: 'PUT', body: { path: doc, content: '# 接口\n改过\n', expectedHash: opened.json.source.hash, clientRequestId: 'r1' } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(fs.readFileSync(doc, 'utf8'), '# 接口\n改过\n');

  const stale = await request(port, '/api/app/document', { method: 'PUT', body: { path: doc, content: '# 接口\n再改\n', expectedHash: opened.json.source.hash, clientRequestId: 'r2' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'source_changed');

  const fresh = await request(port, `/api/app/document?path=${encodeURIComponent(doc)}`);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.source.hash, saved.json.currentHash);
  assert.equal(fresh.json.editing && typeof fresh.json.editing.since, 'string');

  const done = await request(port, '/api/app/document/editing', { method: 'POST', body: { path: doc, editing: false, token: 'tab-1' } });
  assert.equal(done.json.editing, false);

  const recent = await request(port, '/api/app/recent');
  assert.equal(recent.status, 200);
  assert.equal(recent.json.items.length, 1);
  assert.equal(recent.json.items[0].file, '接口.md');
  assert.equal(recent.json.items[0].editing, false);

  const missing = await request(port, '/api/app/document/open', { method: 'POST', body: { path: path.join(docDir, '无.md') } });
  assert.equal(missing.status, 404);
});
