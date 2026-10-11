'use strict';

// 手机批注批次导入(跨端规则第 6 节):按版本指纹找会话、整批写入、去重、迟到拒收、版本不一致拒收、回执可重放。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
