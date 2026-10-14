'use strict';

// Codex 代码审查(第一、二段)指出的失败路径的回归测试:并发重投、导入被越过、迟到批注接管、重复新 ID、
// 损坏旁注、固化后冻结写入、同指纹恢复中断、已提交恢复不被撤销、转换时状态复查、重关联前提、revision 过期、
// 被跳过的发布只确认那一次、非 UTF-8 归档不推正文。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const iconv = (() => { try { return require('iconv-lite'); } catch { return null; } })();

const store = require('../lib/review-store');
const versions = require('../lib/version-store');
const batches = require('../lib/batches');
const sync = require('../lib/sync');
const documentService = require('../lib/document-service');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-fixes-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}
function sidecar(doc, annotations) { fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: path.basename(doc), annotations })); }
function note(review, id) { return { id, comment: '改', quote: '正文', docId: review.docId, reviewId: review.id, baseVersion: review.sourceHash }; }
function batchFor(review, ids, batchId) {
  return { version: 2, batchId: batchId || `b${crypto.randomBytes(6).toString('hex')}`, docId: review.docId, reviewId: review.id, documentName: review.file, baseVersion: review.sourceHash, completedAt: new Date().toISOString(), device: 'iPhone', annotations: ids.map((id) => note(review, id)) };
}
async function openDoc(f, name, body = '# 稿\n\n正文。\n') { const doc = path.join(f.docDir, name); fs.writeFileSync(doc, body); return { doc, review: (await store.openReview(doc, f.options)).review }; }

test('导入被越过:A 停在 prepared,B 到达 → 先收敛 A(A 采用),B 因会话已交出拒收;A 停在 notes 而 B 先交出 → A 重放得拒收回执,批注留给下一轮', async (t) => {
  const f = fixture(t);
  const { doc, review } = await openDoc(f, '越过.md');
  const a = batchFor(review, ['a1'], 'batch-a-prepared');
  fs.mkdirSync(path.join(f.dataDir, 'imports'), { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, 'imports', `${a.batchId}.json`), JSON.stringify({ batchId: a.batchId, docId: review.docId, reviewId: review.id, absPath: doc, baseVersion: review.sourceHash, device: 'iPhone', batch: a, acceptedIds: ['a1'], skippedIds: [], stage: 'prepared', createdAt: new Date().toISOString() }));
  const b = await batches.importBatch(batchFor(review, ['b1']), f.options);
  assert.equal(b.receipt.reason, 'session-advanced', 'B 到达时先把 A 收敛掉,A 交出后 B 自然被拒');
  const receiptA = batches.readReceipt(a.batchId, f.options);
  assert.equal(receiptA.accepted, true);
  assert.deepEqual((await store.getReviewById(review.id, f.options)).memberAnnotationIds, ['a1']);

  // 第二种:A 旁注已写(stage notes),但会话被 C 先交出且成员里没有 a2 → A 重放得拒收;a2 留在旁注里等下一轮接管
  const { doc: doc2, review: review2 } = await openDoc(f, '越过2.md');
  const a2 = batchFor(review2, ['a2'], 'batch-a-notes');
  sidecar(doc2, [{ id: 'a2', comment: '改', status: 'open', reviewSessionId: review2.id, receivedBatchId: a2.batchId }]);
  await store.mutateReviews((data) => { data.reviews[review2.id].memberAnnotationIds = ['c1']; data.reviews[review2.id].status = 'ready_to_apply'; data.reviews[review2.id].submittedAt = new Date().toISOString(); return null; }, f.options);
  fs.writeFileSync(path.join(f.dataDir, 'imports', `${a2.batchId}.json`), JSON.stringify({ batchId: a2.batchId, docId: review2.docId, reviewId: review2.id, absPath: doc2, baseVersion: review2.sourceHash, device: 'iPhone', batch: a2, acceptedIds: ['a2'], skippedIds: [], stage: 'notes', createdAt: new Date().toISOString() }));
  const replay = await batches.importBatch(a2, f.options);
  assert.equal(replay.receipt.accepted, false);
  assert.equal(replay.receipt.reason, 'session-advanced');
  assert.equal(batches.pendingImportFor(doc2, f.options), null);
});

test('迟到批注由下一轮接管;同一批次里重复的新 ID 只落一条;损坏的旁注阻断完成而不是零批注通过', async (t) => {
  const f = fixture(t);
  const { doc, review } = await openDoc(f, '迟到.md');
  sidecar(doc, [{ id: 'n1', comment: '改', status: 'open', reviewSessionId: review.id }]);
  await store.submitReview(review.id, f.options);
  sidecar(doc, [{ id: 'n1', comment: '改', status: 'applied', reviewSessionId: review.id }, { id: 'late', comment: '迟到的', status: 'open', reviewSessionId: review.id }]);
  await store.beginApply(doc, { applyMode: 'agent', ...f.options });
  await store.completeReview(doc, f.options);
  const next = (await store.openReview(doc, f.options)).review;
  const late = store.readAnnotations(doc).annotations.find((n) => n.id === 'late');
  assert.equal(late.reviewSessionId, next.id, '迟到批注挂到新一轮');
  assert.equal(late.lateFromReviewId, review.id);
  const submitted = (await store.submitReview(next.id, f.options)).review;
  assert.deepEqual(submitted.memberAnnotationIds, ['late']);

  const { doc: doc2, review: review2 } = await openDoc(f, '重复.md');
  const dup = await batches.importBatch(batchFor(review2, ['x', 'x']), f.options);
  assert.deepEqual(dup.receipt.acceptedIds, ['x']);
  assert.deepEqual(dup.receipt.skippedIds, ['x']);
  assert.equal(store.readAnnotations(doc2).annotations.filter((n) => n.id === 'x').length, 1);

  const { doc: doc3, review: review3 } = await openDoc(f, '损坏.md');
  sidecar(doc3, [{ id: 'k1', comment: '改', status: 'open', reviewSessionId: review3.id }]);
  await store.submitReview(review3.id, f.options);
  await store.beginApply(doc3, { applyMode: 'agent', ...f.options });
  fs.writeFileSync(`${doc3}.annotations.json`, '{ 坏掉的 JSON');
  await assert.rejects(() => store.completeReview(doc3, f.options), (e) => e.code === 'MALFORMED_JSON');
  assert.equal((await store.getReviewById(review3.id, f.options)).status, 'applying', '旁注损坏时不得完成');
});

test('固化后冻结写入:完成稿固化而终态未写成时,受控写入被拒,重试完成复用已核验的载荷', async (t) => {
  const f = fixture(t);
  const { doc, review } = await openDoc(f, '固化.md');
  sidecar(doc, []);
  await store.submitReview(review.id, f.options); // approved
  const manual = await store.beginManualEdit(doc, f.options);
  const current = fs.readFileSync(doc);
  await documentService.writeSource(manual.id, { content: '# 稿\n\n自己改了。\n', expectedHash: sha(current), clientRequestId: 'w1' }, f.options);
  const withVersion = await store.getReviewById(manual.id, f.options);
  // 模拟"固化成功但终态没写成":直接固化
  await versions.stageTerminal(withVersion, 'manual', [], f.options);
  await assert.rejects(() => documentService.writeSource(manual.id, { content: '# 稿\n\n又改。\n', expectedHash: sha(fs.readFileSync(doc)), clientRequestId: 'w2' }, f.options), (e) => e.code === 'VERSION_STAGED');
  await assert.rejects(() => versions.publish(withVersion.docId, withVersion.versionId, f.options), (e) => e.code === 'VERSION_NOT_TERMINAL', '没进终态不能发布');
  const done = await store.completeReview(doc, { expectedApplyMode: 'manual', ...f.options });
  assert.equal(done.status, 'complete');
  const meta = versions.readMetaFor(withVersion.docId, withVersion.versionId, f.options);
  assert.equal(meta.state, 'published');
  assert.equal(meta.files.final.hash, sha(fs.readFileSync(doc)));
});

test('恢复:同指纹事务停在 prepared 被撤销;已提交的事务即使正文被改回去也只补齐不撤销;并发同请求只做一次;转换与重关联的状态复查', async (t) => {
  const f = fixture(t);
  const { doc, review } = await openDoc(f, '恢复判定.md', '# 稿\n\n0\n');
  sidecar(doc, [{ id: 'r1', comment: '改', status: 'open', reviewSessionId: review.id }]);
  await store.submitReview(review.id, f.options);
  await store.beginApply(doc, { applyMode: 'agent', ...f.options });
  fs.writeFileSync(doc, '# 稿\n\n1\n');
  sidecar(doc, [{ id: 'r1', comment: '改', status: 'applied', reviewSessionId: review.id }]);
  await store.completeReview(doc, f.options);
  const v1 = versions.listVersions(review.docId, f.options)[0];
  const current = fs.readFileSync(doc);
  fs.mkdirSync(path.join(f.dataDir, 'restores'), { recursive: true });
  // 同指纹、prepared:撤销
  const sameId = `r${crypto.randomBytes(12).toString('hex')}`;
  const sameLog = { id: `restore_${sameId}`, clientRequestId: 'same-1', docId: review.docId, absPath: doc, toVersionId: v1.versionId, toRound: 1, beforeHash: sha(current), afterHash: sha(current), newReviewId: sameId, newRound: 9, newVersionId: await versions.allocateVersionId(review.docId, sameId, f.options), stage: 'prepared', createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(f.dataDir, 'restores', `${sameLog.id}.json`), JSON.stringify(sameLog));
  let results = await versions.recoverRestores(f.options);
  assert.equal(results.find((r) => r.id === sameLog.id).action, 'rolled-back');
  assert.equal(await store.getReviewById(sameId, f.options), null);
  // 已提交(committed,会话已在)、文件被改回 before:补齐,不撤销
  const doneId = `r${crypto.randomBytes(12).toString('hex')}`;
  const doneVersionId = await versions.allocateVersionId(review.docId, doneId, f.options);
  const doneLog = { id: `restore_${doneId}`, clientRequestId: 'done-1', docId: review.docId, absPath: doc, toVersionId: v1.versionId, toRound: 1, beforeHash: sha(current), afterHash: sha('# 稿\n\n0\n'), newReviewId: doneId, newRound: 10, newVersionId: doneVersionId, stage: 'committed', createdAt: new Date().toISOString() };
  const dir = versions.versionDir(review.docId, doneVersionId, f.options); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'original.md'), current); fs.writeFileSync(path.join(dir, 'final.md'), '# 稿\n\n0\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schema: 1, docId: review.docId, versionId: doneVersionId, seq: 3, round: 10, reviewId: doneId, kind: 'restored', state: 'staged', files: { original: { hash: sha(current) }, final: { hash: sha('# 稿\n\n0\n') } }, assets: {}, annotations: [] }));
  await store.mutateReviews((data) => { data.reviews[doneId] = { id: doneId, docId: review.docId, round: 10, absPath: doc, file: '恢复判定.md', sourceHash: sha('# 稿\n\n0\n'), finalHash: sha('# 稿\n\n0\n'), status: 'complete', outcome: 'restored', versionId: doneVersionId, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }; return null; }, f.options);
  fs.writeFileSync(path.join(f.dataDir, 'restores', `${doneLog.id}.json`), JSON.stringify(doneLog));
  results = await versions.recoverRestores(f.options);
  assert.equal(results.find((r) => r.id === doneLog.id).action, 'completed');
  assert.ok(await store.getReviewById(doneId, f.options), '已提交的恢复不会被撤销');
  assert.equal(fs.readFileSync(doc).equals(current), true, '收敛不改正文');
  // 并发同请求:第二次同 clientRequestId 返回原结果,不多开一轮
  const rounds = () => Object.values(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'reviews.json'), 'utf8')).reviews).length;
  const before = rounds();
  const [x, y] = await Promise.all([
    versions.restoreTo({ docId: review.docId, toVersionId: v1.versionId, clientRequestId: 'twice-0001' }, f.options),
    versions.restoreTo({ docId: review.docId, toVersionId: v1.versionId, clientRequestId: 'twice-0001' }, f.options),
  ]);
  assert.equal(x.reviewId, y.reviewId);
  assert.equal(rounds(), before + 1);
  // 转换:交出后转旧批注 → 拒收
  const { doc: doc2, review: review2 } = await openDoc(f, '转换复查.md');
  sidecar(doc2, [{ id: 'z1', comment: '改', status: 'open', reviewSessionId: review2.id }]);
  await store.submitReview(review2.id, f.options);
  const legacy = { version: 1, batchId: 'legacy-after-submit', documentName: '转换复查.md', baseVersion: review2.sourceHash, completedAt: new Date().toISOString(), device: '旧', annotations: [{ id: 'o1', comment: '旧', quote: '正文' }] };
  const conv = await batches.importBatch(legacy, { ...f.options, asNewNotes: true, documentPath: doc2 });
  assert.equal(conv.receipt.accepted, false);
  assert.equal(conv.receipt.reason, 'session-advanced');
  // 重关联:有进行中的一轮(哪怕只是批注中)也拒绝
  const { doc: doc3, review: review3 } = await openDoc(f, '搬家.md');
  const moved = path.join(f.docDir, '搬家2.md');
  fs.renameSync(doc3, moved);
  await assert.rejects(() => versions.relink(doc3, moved, f.options), (e) => e.code === 'RELINK_BLOCKED');
  assert.ok(review3);
});

test('发布序号:旧快照拿不到更大的 revision;被跳过的发布只确认那一次;非 UTF-8 归档只推状态', async (t) => {
  const f = fixture(t);
  const { doc, review } = await openDoc(f, '序号.md');
  const first = await sync.readPushPayload(review.id, f.options);
  assert.equal(first.revision, 1);
  const stale = { ...review }; // 批注中的旧快照
  sidecar(doc, []);
  await store.submitReview(review.id, f.options); // approved:签名变了
  await assert.rejects(() => sync.revisionFor(stale, f.options), (e) => e.code === 'PUSH_STALE');
  const latest = await sync.readPushPayload(review.id, f.options);
  assert.equal(latest.revision, 2);
  // 被跳过的是旧签名那次发布:只确认它,当前状态仍待推
  await sync.markPushSuperseded(review.id, 5, first.signature, f.options);
  const after = await store.getReviewById(review.id, f.options);
  assert.equal(after.sync.pushedSignature, first.signature);
  const outbox = await sync.listOutbox(f.options);
  assert.ok(outbox.some((item) => item.reviewId === review.id), '当前状态(已通过)仍要推');
  assert.ok((await sync.readPushPayload(review.id, f.options)).revision >= 6, '水位抬到云端之上');

  if (iconv) {
    const gbkDoc = path.join(f.docDir, 'gbk.md');
    fs.writeFileSync(gbkDoc, iconv.encode('# 标题\n\n中文正文。\n', 'gbk'));
    const gbk = (await store.openReview(gbkDoc, f.options)).review;
    sidecar(gbkDoc, []);
    await store.submitReview(gbk.id, f.options);
    const payload = await sync.readPushPayload(gbk.id, f.options);
    assert.equal(payload.contentAvailable, false, '非 UTF-8 归档只推状态');
    assert.equal(payload.encoding, 'gbk');
  }
});
