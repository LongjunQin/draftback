'use strict';

// 手机批注批次导入(跨端规则第 6 节):按版本指纹找会话、整批写入、去重、迟到拒收、版本不一致拒收、回执可重放。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const store = require('../lib/review-store');
const batches = require('../lib/batches');
const PROJECT = path.resolve(__dirname, '..');

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-batches-')));
  const dataDir = path.join(root, '.mdread');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}

function makeBatch(review, overrides = {}) {
  return {
    version: 1,
    batchId: overrides.batchId || `b${Math.random().toString(16).slice(2, 14)}`,
    documentName: review.file,
    baseVersion: overrides.baseVersion || review.sourceHash,
    completedAt: new Date().toISOString(),
    device: '测试 iPhone',
    annotations: overrides.annotations || [
      { id: 'n-phone-1', comment: '第一条手机批注', quote: '正文', anchorVersion: 3, lineStart: 2, lineEnd: 2, startTextOffset: 0, endTextOffset: 2, createdBy: 'iPhone', baseVersion: review.sourceHash },
      { id: 'n-phone-2', comment: '第二条手机批注', quote: '正文', anchorVersion: 3, lineStart: 2, lineEnd: 2, startTextOffset: 0, endTextOffset: 2 },
    ],
  };
}

test('批次导入:按版本指纹匹配会话,整批写入 sidecar 并进入待改稿;重复导入沿用回执不重复写', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const doc = path.join(docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n正文\n');
  const { review } = await store.openReview(doc, options);

  const batch = makeBatch(review);
  const first = await batches.importBatch(batch, options);
  assert.equal(first.receipt.accepted, true);
  assert.deepEqual(first.receipt.acceptedIds, ['n-phone-1', 'n-phone-2']);
  assert.equal(first.review.status, 'ready_to_apply');
  const sidecar = store.readAnnotations(doc).annotations;
  assert.equal(sidecar.length, 2);
  assert.equal(sidecar[0].status, 'open');
  assert.equal(sidecar[0].reviewSessionId, review.id);
  assert.equal(sidecar[0].receivedBatchId, batch.batchId);
  assert.equal(sidecar[0].baseVersion, undefined, '批次内的 baseVersion 字段不进 sidecar');
  assert.equal(sidecar[1].createdBy, '测试 iPhone');

  const again = await batches.importBatch(batch, options);
  assert.equal(again.receipt.reused, true);
  assert.equal(store.readAnnotations(doc).annotations.length, 2, '重复导入不得重复写入');
  assert.equal(batches.readReceipt(batch.batchId, options).accepted, true);
  const stored = await store.getReviewById(review.id, options);
  assert.equal(stored.receivedBatches.length, 1);
});

test('批次导入:会话已推进则拒收并保留回执;版本不一致拒收;没有对应会话拒收;损坏批次整批抛错', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const doc = path.join(docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n正文\n');
  const { review } = await store.openReview(doc, options);

  const mismatch = await batches.importBatch(makeBatch(review, { baseVersion: 'a'.repeat(64) }), options);
  assert.equal(mismatch.receipt.accepted, false);
  assert.equal(mismatch.receipt.reason, 'no-session');
  assert.equal(store.readAnnotations(doc).annotations.length, 0);

  const explicit = await batches.importBatch(makeBatch(review, { baseVersion: 'a'.repeat(64) }), { ...options, documentPath: doc });
  assert.equal(explicit.receipt.reason, 'version-mismatch');
  assert.equal(explicit.receipt.currentVersion, review.sourceHash);

  await assert.rejects(() => batches.importBatch(makeBatch(review, { annotations: [{ id: 'x', comment: '' }] }), options), (error) => error.code === 'BATCH_INVALID');
  assert.equal(store.readAnnotations(doc).annotations.length, 0, '损坏批次一条都不能写');

  const accepted = await batches.importBatch(makeBatch(review), options);
  assert.equal(accepted.receipt.accepted, true);
  const late = await batches.importBatch(makeBatch(review), { ...options, documentPath: doc });
  assert.equal(late.receipt.accepted, false);
  assert.equal(late.receipt.reason, 'session-advanced', '会话已进入待改稿,迟到的批次拒收');
  assert.equal(store.readAnnotations(doc).annotations.length, 2);
  assert.ok(batches.readReceipt(late.receipt.batchId, options), '拒收也要有回执');
});

test('CLI:mdreview import-batch 接收文件并提示下一步;拒收时非零退出', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const doc = path.join(docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n正文\n');
  const { review } = await store.openReview(doc, options);
  const file = path.join(docDir, '方案.abcd1234.mdturn-batch.json');
  fs.writeFileSync(file, JSON.stringify(makeBatch(review)));
  const env = { ...process.env, MDREAD_DATA_DIR: dataDir };
  const run = (...args) => spawnSync(process.execPath, ['mdreview.js', ...args], { cwd: PROJECT, env, encoding: 'utf8' });

  const ok = run('import-batch', file);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /已接收 2 条批注/);
  assert.match(ok.stdout, /begin-apply/);

  fs.writeFileSync(file, JSON.stringify(makeBatch(review)));
  const refused = run('import-batch', file);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /session-advanced/);
});

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startServer(t, dataDir) {
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
  return port;
}

test('服务接口:/api/app/batch/import 接受批次内容(拖放)或文件路径;坏内容与空请求 400', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const docA = path.join(docDir, '甲.md');
  const docB = path.join(docDir, '乙.md');
  fs.writeFileSync(docA, '# 甲\n正文\n');
  fs.writeFileSync(docB, '# 乙\n正文\n');
  const { review: reviewA } = await store.openReview(docA, options);
  const { review: reviewB } = await store.openReview(docB, options);
  const port = await startServer(t, dataDir);

  const byContent = await request(port, '/api/app/batch/import', { method: 'POST', body: { batch: makeBatch(reviewA) } });
  assert.equal(byContent.status, 200, byContent.text);
  assert.equal(byContent.json.receipt.accepted, true);
  assert.equal(byContent.json.review.status, 'ready_to_apply');
  assert.equal(store.readAnnotations(docA).annotations.length, 2);

  const file = path.join(docDir, '乙.mdturn-batch.json');
  fs.writeFileSync(file, JSON.stringify(makeBatch(reviewB)));
  const byPath = await request(port, '/api/app/batch/import', { method: 'POST', body: { path: file } });
  assert.equal(byPath.status, 200, byPath.text);
  assert.equal(byPath.json.receipt.accepted, true);
  assert.equal(byPath.json.review.id, reviewB.id);

  const bad = await request(port, '/api/app/batch/import', { method: 'POST', body: { batch: { version: 1 } } });
  assert.equal(bad.status, 400, bad.text);
  const empty = await request(port, '/api/app/batch/import', { method: 'POST', body: {} });
  assert.equal(empty.status, 400, empty.text);
});

// 2026-10-13 修复:no-session 拒收以前也写回执,会话建好后再导同一批次仍被缓存的回执挡住,批注永远进不来。
test('批次早于会话到达:先拒收 no-session,会话建好后再导入同一批次被采用', async (t) => {
  const { docDir, options } = setup(t);
  const doc = path.join(docDir, '先到.md');
  fs.writeFileSync(doc, '# 先到\n正文\n');
  const crypto = require('crypto');
  const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(doc)).digest('hex');
  const batch = makeBatch({ file: '先到.md', sourceHash: fingerprint }, { batchId: 'early-batch-0001' });

  const early = await batches.importBatch(batch, options);
  assert.equal(early.receipt.accepted, false);
  assert.equal(early.receipt.reason, 'no-session');
  assert.equal(batches.readReceipt(batch.batchId, options), null, 'no-session 不落盘');

  const { review } = await store.openReview(doc, options);
  const later = await batches.importBatch(batch, options);
  assert.equal(later.receipt.accepted, true, later.receipt.message);
  assert.equal(later.review.id, review.id);
  assert.equal(store.readAnnotations(doc).annotations.length, 2);
});
