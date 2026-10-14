'use strict';

// 规则③的服务端落点:开轮与存第一条批注合成一步;批注没存成就撤掉刚建的轮,不留空轮。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const store = require('../lib/review-store');
const versions = require('../lib/version-store');
const PROJECT = path.resolve(__dirname, '..');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
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
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('open-annotate:普通文档存第一条批注即开第 1 轮;稿子回来后再存即开下一轮;批注无效时不留空轮', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-open-annotate-')));
  const dataDir = path.join(root, '.draftback');
  const doc = path.join(root, '首条.md');
  fs.writeFileSync(doc, '# 首条\n\n正文。\n');
  store.ensureDataDir({ dataDir });
  const child = spawn(process.execPath, ['server.js'], { cwd: PROJECT, env: { ...process.env, DRAFTBACK_DATA_DIR: dataDir, DRAFTBACK_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill('SIGTERM'); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const portFile = store.getPaths({ dataDir }).port;
  let port = 0;
  for (let i = 0; i < 100 && !port; i += 1) { try { port = Number(fs.readFileSync(portFile, 'utf8').trim()); } catch {} if (!port) await sleep(50); }

  // 无效批注(空内容):400,且不建会话、不留版本目录
  const bad = await request(port, '/api/app/review/open-annotate', { method: 'POST', body: { path: doc, note: { comment: '   ' } } });
  assert.equal(bad.status, 400);
  assert.equal(await store.getReviewByPath(doc, { dataDir, activeOnly: true }), null);

  const first = await request(port, '/api/app/review/open-annotate', { method: 'POST', body: { path: doc, note: { comment: '第一条', quote: '正文。', clientRequestId: 'c1' } } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.review.status, 'reviewing');
  assert.equal(first.json.review.round, 1);
  assert.equal(first.json.note.comment, '第一条');
  assert.equal(first.json.note.reviewSessionId, first.json.review.id);
  assert.ok(fs.existsSync(path.join(versions.versionDir(first.json.review.docId, first.json.review.versionId, { dataDir }), 'original.md')), '开轮即留底');

  // 同一轮再存:复用会话,不开新轮
  const again = await request(port, '/api/app/review/open-annotate', { method: 'POST', body: { path: doc, note: { comment: '第二条', quote: '正文。', clientRequestId: 'c2' } } });
  assert.equal(again.json.reused, true);
  assert.equal(again.json.review.id, first.json.review.id);

  // 走完一轮(零批注通过 → complete),再存一条 → 第 2 轮
  await store.mutateAnnotations(doc, (data) => { for (const n of data.annotations) n.status = 'applied'; }, { dataDir });
  await store.submitReview(first.json.review.id, { dataDir });
  const next = await request(port, '/api/app/review/open-annotate', { method: 'POST', body: { path: doc, note: { comment: '下一轮', quote: '正文。', clientRequestId: 'c3' } } });
  assert.equal(next.json.reused, false);
  assert.equal(next.json.review.round, 2);
  assert.notEqual(next.json.review.id, first.json.review.id);

  // 撤销路径:直接调用 discardFreshReview 只对"还在 reviewing 且没有批注"的轮生效
  assert.equal(await store.discardFreshReview(next.json.review.id, { dataDir }), false, '已有批注的轮不能撤');
  const empty = (await store.openReview(path.join(root, '另一篇.md').replace('另一篇.md', '首条.md'), { dataDir })).review; // 复用当前轮
  assert.equal(empty.id, next.json.review.id);
});
