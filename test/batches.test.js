'use strict';

// 手机批注批次导入(跨端规则 v2.3 第 6 节):逐条身份、最新轮次、状态、实际指纹按顺序校验;
// 同一事务写旁注并交出;回执可重放;导入记录崩溃重放;没身份的旧批次只能显式转为本轮新批注。

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-batches-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}

function note(review, id, comment = '手机批注') {
  return { id, comment, quote: '正文', anchorVersion: 3, lineStart: 2, lineEnd: 2, startTextOffset: 0, endTextOffset: 2, createdBy: 'iPhone',
    docId: review.docId, reviewId: review.id, baseVersion: review.sourceHash };
}
function makeBatch(review, overrides = {}) {
  return {
    version: overrides.version === undefined ? 2 : overrides.version,
    batchId: overrides.batchId || `b${Math.random().toString(16).slice(2, 14)}`,
    documentName: review.file,
    docId: overrides.docId === undefined ? review.docId : overrides.docId,
    reviewId: overrides.reviewId === undefined ? review.id : overrides.reviewId,
    baseVersion: overrides.baseVersion || review.sourceHash,
    completedAt: new Date().toISOString(),
    device: '测试 iPhone',
    annotations: overrides.annotations || [note(review, 'n-phone-1', '第一条手机批注'), note(review, 'n-phone-2', '第二条手机批注')],
  };
}
async function openDoc(f, name, body = '# 方案\n\n正文。\n') {
  const doc = path.join(f.docDir, name);
  fs.writeFileSync(doc, body);
  return { doc, review: (await store.openReview(doc, f.options)).review };
}

test('批次导入:逐条身份齐全 → 同一事务写入旁注并交出;回执带身份;重复导入沿用回执不重复写', async (t) => {
  const f = setup(t);
  const { doc, review } = await openDoc(f, '方案.md');
  const batch = makeBatch(review);
  const first = await batches.importBatch(batch, f.options);
  assert.equal(first.receipt.accepted, true);
  assert.deepEqual(first.receipt.acceptedIds, ['n-phone-1', 'n-phone-2']);
  assert.equal(first.receipt.batchReviewId, review.id);
  assert.equal(first.review.status, 'ready_to_apply');
  assert.deepEqual(first.review.memberAnnotationIds, ['n-phone-1', 'n-phone-2'], '交出时固定本轮成员');
  const sidecar = store.readAnnotations(doc).annotations;
  assert.equal(sidecar.length, 2);
  assert.equal(sidecar[0].reviewSessionId, review.id);
  assert.equal(sidecar[0].docId, undefined, '批注自带的身份字段不进旁注文件');
  assert.equal(sidecar[0].receivedBatchId, batch.batchId);
  assert.equal(batches.readImport(batch.batchId, f.options), null, '导入记录收敛后删除');

  const again = await batches.importBatch(batch, f.options);
  assert.equal(again.receipt.reused, true);
  assert.equal(store.readAnnotations(doc).annotations.length, 2);
});

test('接收顺序:缺身份 missing-identity;旧轮 round-advanced(正文相同也拒);已交出 session-advanced;文件被改 version-mismatch;未知文档 no-session', async (t) => {
  const f = setup(t);
  const { doc, review } = await openDoc(f, '顺序.md');

  const v1 = await batches.importBatch(makeBatch(review, { version: 1 }), f.options);
  assert.equal(v1.receipt.reason, 'missing-identity');
  const noNoteIdentity = await batches.importBatch(makeBatch(review, { annotations: [{ id: 'x1', comment: '没身份', quote: '正文' }] }), f.options);
  assert.equal(noNoteIdentity.receipt.reason, 'missing-identity');
  const crossed = await batches.importBatch(makeBatch(review, { annotations: [{ ...note(review, 'x2'), reviewId: 'r000000000000000000000000' }] }), f.options);
  assert.equal(crossed.receipt.reason, 'missing-identity', '逐条身份与外层不一致也拒');
  assert.equal(store.readAnnotations(doc).annotations.length, 0);

  const unknown = await batches.importBatch(makeBatch(review, { docId: 'doc_0000000000000000', annotations: [{ ...note(review, 'u1'), docId: 'doc_0000000000000000' }] }), f.options);
  assert.equal(unknown.receipt.reason, 'no-session');
  assert.equal(unknown.documentKnown, false);

  // 走完第一轮(零批注通过),开第二轮;手机交回第一轮的批次:正文一字不差,仍拒
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: '顺序.md', annotations: [] }));
  await store.submitReview(review.id, f.options);
  const second = (await store.openReview(doc, f.options)).review;
  assert.equal(second.sourceHash, review.sourceHash);
  const stale = await batches.importBatch(makeBatch(review), f.options);
  assert.equal(stale.receipt.reason, 'round-advanced');
  assert.equal(stale.receipt.latestRound, 2);
  assert.equal(store.readAnnotations(doc).annotations.length, 0);

  // 第二轮交出后再来一批 → session-advanced
  const ok = await batches.importBatch(makeBatch(second), f.options);
  assert.equal(ok.receipt.accepted, true);
  const late = await batches.importBatch(makeBatch(second, { annotations: [note(second, 'n-late')] }), f.options);
  assert.equal(late.receipt.reason, 'session-advanced');

  // 第三轮:文件在外面被改 → version-mismatch(先于写入)
  await store.beginApply(doc, { applyMode: 'agent', ...f.options });
  await store.mutateAnnotations(doc, (data) => { for (const n of data.annotations) n.status = 'applied'; }, f.options);
  await store.completeReview(doc, f.options);
  const third = (await store.openReview(doc, f.options)).review;
  const batch3 = makeBatch(third);
  fs.writeFileSync(doc, '# 方案\n\n外面改了。\n');
  const mismatch = await batches.importBatch(batch3, f.options);
  assert.equal(mismatch.receipt.reason, 'version-mismatch');
  assert.equal(store.readAnnotations(doc).annotations.filter((n) => n.receivedBatchId === batch3.batchId).length, 0, '拒收不写入');

  await assert.rejects(() => batches.importBatch({ version: 2, batchId: 'bad' }, f.options), (e) => e.code === 'BATCH_INVALID');
  await assert.rejects(() => batches.importBatch({ ...makeBatch(third), annotations: undefined }, f.options), (e) => e.code === 'BATCH_INVALID', '批注列表缺失整批拒绝');
});

test('崩溃重放:导入记录停在各阶段,重放都补齐到定稿回执,接受列表不变;空批次与全部去重也有回执;未收敛时不得改稿', async (t) => {
  const f = setup(t);
  for (const stage of ['prepared', 'notes', 'submitted']) {
    const { doc, review } = await openDoc(f, `重放-${stage}.md`);
    const batch = makeBatch(review);
    // 先正常导入,再把它"倒回"到某个阶段:删掉回执、放回导入记录
    const done = await batches.importBatch(batch, f.options);
    assert.equal(done.receipt.accepted, true);
    fs.unlinkSync(path.join(f.dataDir, 'receipts', `${batch.batchId}.json`));
    const record = { batchId: batch.batchId, docId: review.docId, reviewId: review.id, absPath: doc, baseVersion: review.sourceHash, device: '测试 iPhone', batch, acceptedIds: ['n-phone-1', 'n-phone-2'], skippedIds: [], stage, createdAt: done.receipt.receivedAt };
    if (stage === 'prepared') {
      // 模拟"旁注没写、状态没推进":清掉旁注与交出
      fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: path.basename(doc), annotations: [] }));
      await store.mutateReviews((data) => { const r = data.reviews[review.id]; r.status = 'reviewing'; delete r.memberAnnotationIds; delete r.submittedAt; return null; }, f.options);
    }
    if (stage === 'notes') await store.mutateReviews((data) => { const r = data.reviews[review.id]; r.status = 'reviewing'; delete r.memberAnnotationIds; delete r.submittedAt; return null; }, f.options);
    fs.writeFileSync(path.join(f.dataDir, 'imports', `${batch.batchId}.json`), JSON.stringify(record));
    assert.ok(batches.pendingImportFor(doc, f.options));
    await assert.rejects(() => store.beginApply(doc, { applyMode: 'agent', ...f.options }), (e) => e.code === 'IMPORT_PENDING', '未收敛时不得改稿');
    const replayed = await batches.importBatch(batch, f.options);
    assert.equal(replayed.receipt.accepted, true, stage);
    assert.deepEqual(replayed.receipt.acceptedIds, ['n-phone-1', 'n-phone-2']);
    assert.equal(replayed.review.status, 'ready_to_apply');
    assert.equal(store.readAnnotations(doc).annotations.length, 2);
    assert.equal(batches.pendingImportFor(doc, f.options), null);
  }
  // 空批次 → 零批注通过也有回执;全部去重 → 回执 accepted、acceptedIds 为空
  const { doc, review } = await openDoc(f, '空批次.md');
  const empty = await batches.importBatch(makeBatch(review, { annotations: [] }), f.options);
  assert.equal(empty.receipt.accepted, true);
  assert.equal(empty.review.status, 'complete');
  const { doc: doc2, review: review2 } = await openDoc(f, '去重.md');
  fs.writeFileSync(`${doc2}.annotations.json`, JSON.stringify({ version: 1, file: '去重.md', annotations: [{ id: 'n-phone-1', comment: '已有', status: 'open', reviewSessionId: review2.id }] }));
  const dup = await batches.importBatch(makeBatch(review2, { annotations: [note(review2, 'n-phone-1'), note(review2, 'n-phone-1')] }), f.options);
  assert.equal(dup.receipt.accepted, true);
  assert.deepEqual(dup.receipt.acceptedIds, []);
  assert.deepEqual(dup.receipt.skippedIds, ['n-phone-1', 'n-phone-1']);
});

test('没有身份的旧批次:显式 --as-new-notes 转为本轮新批注(新 ID、保留来源、不交出);再转一次不重复', async (t) => {
  const f = setup(t);
  const { doc, review } = await openDoc(f, '转换.md');
  const legacy = { version: 1, batchId: 'legacy-batch-01', documentName: '转换.md', baseVersion: review.sourceHash, completedAt: new Date().toISOString(), device: '旧手机',
    annotations: [{ id: 'old-1', comment: '旧批注', quote: '正文' }] };
  const refused = await batches.importBatch(legacy, f.options);
  assert.equal(refused.receipt.reason, 'missing-identity');
  const converted = await batches.importBatch(legacy, { ...f.options, asNewNotes: true, documentPath: doc });
  assert.equal(converted.receipt.converted, true);
  assert.equal(converted.receipt.acceptedIds.length, 1);
  assert.notEqual(converted.receipt.acceptedIds[0], 'old-1');
  const notes = store.readAnnotations(doc).annotations;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].sourceAnnotationId, 'legacy-batch-01:old-1');
  assert.equal(notes[0].reviewSessionId, review.id);
  assert.equal((await store.getReviewById(review.id, f.options)).status, 'reviewing', '转换不交出,用户在回稿里交');
  const twice = await batches.importBatch(legacy, { ...f.options, asNewNotes: true, documentPath: doc });
  assert.equal(twice.receipt.acceptedIds.length, 0);
  assert.equal(store.readAnnotations(doc).annotations.length, 1);
});

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

test('CLI 与服务接口:import-batch 文件(带身份)接收;--as-new-notes 转换;/api/app/batch/import 带 documentPath 时自动转换;坏内容 400', async (t) => {
  const f = setup(t);
  const { doc, review } = await openDoc(f, '接口.md');
  const env = { ...process.env, DRAFTBACK_DATA_DIR: f.dataDir };
  const file = path.join(f.root, 'one.draftback-batch.json');
  fs.writeFileSync(file, JSON.stringify(makeBatch(review, { annotations: [note(review, 'n-cli-1')] })));
  const cli = spawnSync(process.execPath, ['mdreview.js', 'import-batch', file], { cwd: PROJECT, env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /begin-apply/);

  const { doc: doc2, review: review2 } = await openDoc(f, '接口2.md');
  const legacyFile = path.join(f.root, 'legacy.draftback-batch.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, batchId: 'legacy-batch-02', documentName: '接口2.md', baseVersion: review2.sourceHash, completedAt: new Date().toISOString(), device: '旧手机', annotations: [{ id: 'o1', comment: '旧', quote: '正文' }] }));
  const refused = spawnSync(process.execPath, ['mdreview.js', 'import-batch', legacyFile], { cwd: PROJECT, env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /missing-identity/);
  const converted = spawnSync(process.execPath, ['mdreview.js', 'import-batch', legacyFile, '--as-new-notes', '--document', doc2], { cwd: PROJECT, env, encoding: 'utf8' });
  assert.equal(converted.status, 0, converted.stderr);
  assert.match(converted.stdout, /转为本轮新批注/);

  const child = spawn(process.execPath, ['server.js'], { cwd: PROJECT, env: { ...env, DRAFTBACK_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill('SIGTERM'); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]); });
  const portFile = store.getPaths(f.options).port;
  let port = 0;
  for (let i = 0; i < 100 && !port; i += 1) { try { port = Number(fs.readFileSync(portFile, 'utf8').trim()); } catch {} if (!port) await sleep(50); }
  const { doc: doc3, review: review3 } = await openDoc(f, '接口3.md');
  const dropped = await request(port, '/api/app/batch/import', { method: 'POST', body: { batch: { version: 1, batchId: 'dropped-batch-01', documentName: '接口3.md', baseVersion: review3.sourceHash, completedAt: new Date().toISOString(), device: '旧手机', annotations: [{ id: 'd1', comment: '拖进来的', quote: '正文' }] }, documentPath: doc3 } });
  assert.equal(dropped.status, 200);
  assert.equal(dropped.json.receipt.converted, true);
  assert.equal(store.readAnnotations(doc3).annotations.length, 1);
  const withIdentity = await request(port, '/api/app/batch/import', { method: 'POST', body: { batch: makeBatch(review3, { annotations: [note(review3, 'n-api-1')] }), documentPath: doc3 } });
  assert.equal(withIdentity.json.receipt.accepted, true);
  assert.equal(withIdentity.json.receipt.converted, undefined, '带身份的批次走正常路径');
  const bad = await request(port, '/api/app/batch/import', { method: 'POST', body: { batch: { version: 2 } } });
  assert.equal(bad.status, 400);
  assert.equal((await request(port, '/api/app/batch/import', { method: 'POST', body: {} })).status, 400);
});
