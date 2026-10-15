'use strict';

// 跨端规则 v2.4 第 6.9 条:带意图的批次(version 3)。
//   next-round:稿子回来后在手机上接着批,Mac 在一个可恢复事务里开下一轮、写入、交出;
//   finalize:手机定稿(批注中先零批注通过再定稿);
// 以及:结构校验(版本与意图)、锁内判断与拒收原因、断点重放、"最新一轮"与推送同一个定义。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('../lib/review-store');
const batches = require('../lib/batches');
const documents = require('../lib/documents');
const sync = require('../lib/sync');
const versionStore = require('../lib/version-store');

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-intent-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
let counter = 0;
const batchId = () => `bt${Date.now().toString(16)}${(counter += 1)}`;

// 一篇走完第 1 轮(AI 改完)的文档
async function returnedDoc(f, name = '方案.md') {
  const doc = path.join(f.docDir, name);
  fs.writeFileSync(doc, '# 方案\n\n原来的正文。\n');
  const { review } = await store.openReview(doc, f.options);
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: name, annotations: [{ id: 'm1', comment: '改一下', status: 'open', reviewSessionId: review.id }] }));
  await store.submitReview(review.id, f.options);
  await store.beginApply(doc, f.options);
  fs.writeFileSync(doc, '# 方案\n\n改完的正文。\n');
  await store.mutateAnnotations(doc, (data) => { data.annotations[0].status = 'applied'; data.annotations[0].appliedNote = '改了'; }, f.options);
  const done = await store.completeReview(doc, { ...f.options, summary: '改了正文。' });
  return { doc, review: done, finalHash: sha(fs.readFileSync(doc)) };
}
function nextNote(review, base, id) {
  return { id, comment: `手机写给下一轮的 ${id}`, quote: '改完的正文', intent: 'next-round', createdBy: 'iPhone', docId: review.docId, reviewId: review.id, baseVersion: base };
}
function nextRoundBatch(review, base, ids = ['p1', 'p2'], overrides = {}) {
  return { version: 3, intent: 'next-round', batchId: overrides.batchId || batchId(), documentName: review.file, docId: review.docId, reviewId: review.id,
    baseVersion: base, completedAt: new Date().toISOString(), device: '测试 iPhone', annotations: ids.map((id) => nextNote(review, base, id)), ...overrides };
}
function finalizeBatch(review, base, overrides = {}) {
  return { version: 3, intent: 'finalize', batchId: overrides.batchId || batchId(), documentName: review.file, docId: review.docId, reviewId: review.id,
    baseVersion: base, completedAt: new Date().toISOString(), device: '测试 iPhone', annotations: [], ...overrides };
}
const invalid = (error) => error && error.code === 'BATCH_INVALID';

test('结构:意图只在 version 3;未知意图、v2 带意图、定稿带批注、next-round 混入旧批注都整批拒绝', async (t) => {
  const f = setup(t);
  const { review, finalHash } = await returnedDoc(f);
  assert.throws(() => batches.validateBatch({ ...nextRoundBatch(review, finalHash), intent: 'reopen' }), invalid);
  assert.throws(() => batches.validateBatch({ ...nextRoundBatch(review, finalHash), version: 2 }), invalid, 'v2 不能带意图');
  assert.throws(() => batches.validateBatch({ ...nextRoundBatch(review, finalHash), intent: undefined }), invalid, 'v3 必带意图');
  assert.throws(() => batches.validateBatch({ ...finalizeBatch(review, finalHash), annotations: [nextNote(review, finalHash, 'x')] }), invalid, '定稿不带批注');
  const mixed = nextRoundBatch(review, finalHash);
  delete mixed.annotations[1].intent;
  assert.throws(() => batches.validateBatch(mixed), invalid, '旧批注要先复制到本轮,不能混进 next-round');
  assert.throws(() => batches.validateBatch({ ...nextRoundBatch(review, finalHash), annotations: [] }), invalid, 'next-round 至少一条');
});

test('next-round:开第 2 轮、写入、交出一个事务;回执给目标轮;重复投递拿原回执;推送带 macProtocol', async (t) => {
  const f = setup(t);
  const { doc, review, finalHash } = await returnedDoc(f);
  const batch = nextRoundBatch(review, finalHash);
  const result = await batches.importBatch(batch, f.options);
  assert.equal(result.receipt.accepted, true, result.receipt.message);
  assert.equal(result.receipt.intent, 'next-round');
  assert.equal(result.receipt.batchReviewId, review.id, '回执带批次原身份');
  const next = await store.getReviewById(result.receipt.targetReviewId, f.options);
  assert.ok(next, '新开的一轮');
  assert.notEqual(next.id, review.id);
  assert.equal(next.round, 2);
  assert.equal(next.docId, review.docId);
  assert.equal(next.openedByBatch, batch.batchId);
  assert.equal(next.status, 'ready_to_apply', '开轮后交出');
  assert.deepEqual(next.memberAnnotationIds.sort(), ['p1', 'p2']);
  const notes = store.readAnnotations(doc).annotations.filter((note) => ['p1', 'p2'].includes(note.id));
  assert.equal(notes.length, 2);
  assert.ok(notes.every((note) => note.reviewSessionId === next.id && note.intent === undefined && note.openedNextRoundFrom === review.id));
  assert.equal(batches.pendingImportFor(doc, f.options), null);
  const again = await batches.importBatch(batch, f.options);
  assert.equal(again.receipt.reused, true);
  assert.equal(again.receipt.targetReviewId, next.id);
  assert.equal((await store.listReviews(f.options)).filter((item) => item.docId === review.docId).length, 2, '只开一轮');
  const outbox = await sync.listOutbox(f.options);
  assert.equal(outbox.find((item) => item.docId === review.docId).macProtocol, 3);
});

test('next-round 拒收:轮次推进、没结束、Mac 在编辑、原文改过;拒收不开轮、不写旁注', async (t) => {
  const f = setup(t);
  const { doc, review, finalHash } = await returnedDoc(f);
  const count = async () => (await store.listReviews(f.options)).filter((item) => item.docId === review.docId).length;

  await documents.setEditing(doc, true, { token: 'mac' }, f.options);
  const editing = await batches.importBatch(nextRoundBatch(review, finalHash), f.options);
  assert.equal(editing.receipt.reason, 'user-editing');
  await documents.setEditing(doc, false, { token: 'mac' }, f.options);

  const stale = await batches.importBatch(nextRoundBatch(review, sha('别的版本')), f.options);
  assert.equal(stale.receipt.reason, 'version-mismatch');
  assert.equal(await count(), 1, '拒收不开轮');

  // Mac 上先划词开了第 2 轮:手机针对第 1 轮的 next-round → round-advanced
  await store.openReview(doc, f.options);
  const advanced = await batches.importBatch(nextRoundBatch(review, finalHash), f.options);
  assert.equal(advanced.receipt.reason, 'round-advanced');
  assert.equal(await count(), 2);
  assert.equal(store.readAnnotations(doc).annotations.some((note) => note.id === 'p1'), false);
});

test('两个 next-round 同时到:只开一轮,后到的 round-advanced;回执不被覆盖', async (t) => {
  const f = setup(t);
  const { review, finalHash } = await returnedDoc(f);
  const a = nextRoundBatch(review, finalHash, ['a1']);
  const b = nextRoundBatch(review, finalHash, ['b1']);
  const [ra, rb] = await Promise.all([batches.importBatch(a, f.options), batches.importBatch(b, f.options)]);
  const accepted = [ra, rb].filter((r) => r.receipt.accepted);
  assert.equal(accepted.length, 1, '只有一个能开轮');
  assert.equal([ra, rb].find((r) => !r.receipt.accepted).receipt.reason, 'round-advanced');
  assert.equal((await store.listReviews(f.options)).filter((item) => item.docId === review.docId).length, 2);
  const winner = accepted[0].receipt.batchId;
  const [againA, againB] = await Promise.all([batches.importBatch(a, f.options), batches.importBatch(b, f.options)]);
  assert.equal([againA, againB].find((r) => r.receipt.batchId === winner).receipt.accepted, true, '重复投递拿原接受回执');
});

test('next-round 断点:预留后崩溃(留底写了、会话没写)重放只开一轮;开轮后、写批注后、交出后崩溃都补齐到同一回执', async (t) => {
  const f = setup(t);
  for (const stage of ['reserved-orphan', 'prepared', 'notes', 'submitted']) {
    const { doc, review, finalHash } = await returnedDoc(f, `断点-${stage}.md`);
    const batch = nextRoundBatch(review, finalHash);
    const reserveId = `r${crypto.randomBytes(12).toString('hex')}`;
    const record = { batchId: batch.batchId, docId: review.docId, intent: 'next-round', previousReviewId: review.id, reviewId: reserveId, absPath: doc,
      baseVersion: finalHash, device: '测试 iPhone', batch, acceptedIds: ['p1', 'p2'], skippedIds: [], stage: 'reserved', createdAt: new Date().toISOString() };
    if (stage === 'reserved-orphan') {
      // 留底写了、会话没写:用一次真开轮再删掉会话来造
      await store.withReviewTransaction(doc, () => store.openReviewLocked(doc, { ...f.options, reserveReviewId: reserveId, openedByBatch: batch.batchId }), f.options);
      await store.mutateReviews((data) => { delete data.reviews[reserveId]; return null; }, f.options);
      assert.ok(versionStore.findVersionByReviewId(doc, reserveId, f.options), '孤立留底在');
    } else {
      await store.withReviewTransaction(doc, () => store.openReviewLocked(doc, { ...f.options, reserveReviewId: reserveId, openedByBatch: batch.batchId }), f.options);
      record.stage = stage;
      if (stage === 'notes' || stage === 'submitted') {
        await store.mutateAnnotations(doc, (data) => { for (const id of ['p1', 'p2']) data.annotations.push({ id, comment: id, status: 'open', reviewSessionId: reserveId }); }, f.options);
      }
      if (stage === 'submitted') await store.submitReview(reserveId, { ...f.options, fromImport: true });
    }
    fs.writeFileSync(path.join(f.dataDir, 'imports', `${batch.batchId}.json`), JSON.stringify(record));
    const replayed = await batches.importBatch(batch, f.options);
    assert.equal(replayed.receipt.accepted, true, `${stage}: ${replayed.receipt.message || ''}`);
    assert.equal(replayed.receipt.targetReviewId, reserveId, `${stage} 用预留的会话标识`);
    const rounds = (await store.listReviews(f.options)).filter((item) => item.docId === review.docId);
    assert.equal(rounds.length, 2, `${stage} 只开一轮`);
    assert.equal(store.readAnnotations(doc).annotations.filter((note) => ['p1', 'p2'].includes(note.id)).length, 2, stage);
    assert.equal((await store.getReviewById(reserveId, f.options)).status, 'ready_to_apply', stage);
    assert.equal(batches.pendingImportFor(doc, f.options), null);
  }
});

test('next-round 重放时决定拒收(原文在崩溃后被改):删掉本事务的孤立留底,写拒收回执', async (t) => {
  const f = setup(t);
  const { doc, review, finalHash } = await returnedDoc(f);
  const batch = nextRoundBatch(review, finalHash);
  const reserveId = `r${crypto.randomBytes(12).toString('hex')}`;
  await store.withReviewTransaction(doc, () => store.openReviewLocked(doc, { ...f.options, reserveReviewId: reserveId, openedByBatch: batch.batchId }), f.options);
  await store.mutateReviews((data) => { delete data.reviews[reserveId]; return null; }, f.options);
  fs.writeFileSync(path.join(f.dataDir, 'imports', `${batch.batchId}.json`), JSON.stringify({ batchId: batch.batchId, docId: review.docId, intent: 'next-round',
    previousReviewId: review.id, reviewId: reserveId, absPath: doc, baseVersion: finalHash, batch, acceptedIds: ['p1', 'p2'], skippedIds: [], stage: 'reserved', createdAt: new Date().toISOString() }));
  fs.writeFileSync(doc, '# 方案\n\n崩溃后在外面改过。\n');
  const replayed = await batches.importBatch(batch, f.options);
  assert.equal(replayed.receipt.accepted, false);
  assert.equal(replayed.receipt.reason, 'version-mismatch');
  assert.equal(versionStore.findVersionByReviewId(doc, reserveId, f.options), null, '孤立留底删掉');
  assert.equal(batches.pendingImportFor(doc, f.options), null);
});

test('在途导入隔离:写批注、领取、普通保存之前先收敛', async (t) => {
  const f = setup(t);
  const { doc, review, finalHash } = await returnedDoc(f);
  const batch = nextRoundBatch(review, finalHash);
  const reserveId = `r${crypto.randomBytes(12).toString('hex')}`;
  await store.withReviewTransaction(doc, () => store.openReviewLocked(doc, { ...f.options, reserveReviewId: reserveId, openedByBatch: batch.batchId }), f.options);
  fs.writeFileSync(path.join(f.dataDir, 'imports', `${batch.batchId}.json`), JSON.stringify({ batchId: batch.batchId, docId: review.docId, intent: 'next-round',
    previousReviewId: review.id, reviewId: reserveId, absPath: doc, baseVersion: finalHash, batch, acceptedIds: ['p1', 'p2'], skippedIds: [], stage: 'prepared', createdAt: new Date().toISOString() }));
  // Mac 上领取:先收敛(手机批注写进去、交出),再领
  const claimed = await store.claimReview(doc, { agent: 'Claude', ...f.options });
  assert.equal(claimed.id, reserveId);
  assert.equal(batches.pendingImportFor(doc, f.options), null);
  assert.ok(batches.readReceipt(batch.batchId, f.options).accepted);
  assert.equal(store.readAnnotations(doc).annotations.filter((note) => ['p1', 'p2'].includes(note.id)).length, 2);
});

test('finalize:回稿 → 定稿;重复 → 原样接受不改时间;作废 / 有遗留批注 / Mac 编辑中 / 原文改过 → 拒收', async (t) => {
  const f = setup(t);
  const { doc, review, finalHash } = await returnedDoc(f);
  const first = await batches.importBatch(finalizeBatch(review, finalHash), f.options);
  assert.equal(first.receipt.accepted, true, first.receipt.message);
  assert.equal(first.receipt.intent, 'finalize');
  const finalized = await store.getReviewById(review.id, f.options);
  assert.equal(finalized.outcome, 'finalized');
  const at = finalized.finalizedAt;
  const second = await batches.importBatch(finalizeBatch(review, finalHash), f.options);
  assert.equal(second.receipt.accepted, true, '已定稿:原样接受');
  assert.equal((await store.getReviewById(review.id, f.options)).finalizedAt, at, '不改定稿时间');

  // 遗留批注(交出后才写、等下一轮的)
  const other = await returnedDoc(f, '遗留.md');
  await store.mutateAnnotations(other.doc, (data) => { data.annotations.push({ id: 'late1', comment: '交出后才写的', status: 'open', reviewSessionId: other.review.id }); }, f.options);
  assert.equal((await batches.importBatch(finalizeBatch(other.review, other.finalHash), f.options)).receipt.reason, 'has-open-notes');

  const edited = await returnedDoc(f, '编辑中.md');
  await documents.setEditing(edited.doc, true, { token: 'mac' }, f.options);
  assert.equal((await batches.importBatch(finalizeBatch(edited.review, edited.finalHash), f.options)).receipt.reason, 'user-editing');
  await documents.setEditing(edited.doc, false, { token: 'mac' }, f.options);
  assert.equal((await batches.importBatch(finalizeBatch(edited.review, sha('旧版本')), f.options)).receipt.reason, 'version-mismatch');

  const cancelledDoc = path.join(f.docDir, '作废.md');
  fs.writeFileSync(cancelledDoc, '# 作废\n');
  const opened = (await store.openReview(cancelledDoc, f.options)).review;
  await store.unlockReview(cancelledDoc, '测试作废', f.options);
  const cancelled = await store.getReviewById(opened.id, f.options);
  assert.equal((await batches.importBatch(finalizeBatch(cancelled, sha(fs.readFileSync(cancelledDoc))), f.options)).receipt.reason, 'session-advanced');
});

test('finalize 在批注中:Mac 上没有批注 → 先通过再定稿;中途崩溃(通过了没定稿)重放补齐;Mac 上有批注 → has-open-notes', async (t) => {
  const f = setup(t);
  const doc = path.join(f.docDir, '通过.md');
  fs.writeFileSync(doc, '# 通过\n\n正文。\n');
  const { review } = await store.openReview(doc, f.options);
  const base = sha(fs.readFileSync(doc));
  const ok = await batches.importBatch(finalizeBatch(review, base), f.options);
  assert.equal(ok.receipt.accepted, true, ok.receipt.message);
  const after = await store.getReviewById(review.id, f.options);
  assert.equal(after.status, 'complete');
  assert.equal(after.outcome, 'finalized');
  assert.equal(after.finalizedFrom, 'approved', '先记为通过,再定稿');
  // 定稿后推送仍按事件类型取原稿(不去找不存在的完成稿)
  const payload = await sync.readPushPayload(review.id, f.options);
  assert.equal(payload.contentAvailable, true);
  assert.match(payload.content, /正文/);

  // 断点:通过了、还没定稿
  const doc2 = path.join(f.docDir, '断点.md');
  fs.writeFileSync(doc2, '# 断点\n');
  const r2 = (await store.openReview(doc2, f.options)).review;
  const b2 = finalizeBatch(r2, sha(fs.readFileSync(doc2)));
  await store.submitReview(r2.id, f.options); // 零批注 → 通过
  fs.writeFileSync(path.join(f.dataDir, 'imports', `${b2.batchId}.json`), JSON.stringify({ batchId: b2.batchId, docId: r2.docId, intent: 'finalize', reviewId: r2.id, absPath: doc2,
    baseVersion: b2.baseVersion, batch: b2, acceptedIds: [], skippedIds: [], stage: 'finalizing', createdAt: new Date().toISOString() }));
  const replayed = await batches.importBatch(b2, f.options);
  assert.equal(replayed.receipt.accepted, true);
  assert.equal((await store.getReviewById(r2.id, f.options)).outcome, 'finalized');

  const doc3 = path.join(f.docDir, '有批注.md');
  fs.writeFileSync(doc3, '# 有批注\n');
  const r3 = (await store.openReview(doc3, f.options)).review;
  fs.writeFileSync(`${doc3}.annotations.json`, JSON.stringify({ version: 1, file: '有批注.md', annotations: [{ id: 'mac1', comment: 'Mac 上写的', status: 'open', reviewSessionId: r3.id }] }));
  assert.equal((await batches.importBatch(finalizeBatch(r3, sha(fs.readFileSync(doc3))), f.options)).receipt.reason, 'has-open-notes');
  assert.equal((await store.getReviewById(r3.id, f.options)).status, 'reviewing', '没有被交出');
});

test('"最新一轮"一个定义:第 1 轮之后我自己改了一次,针对手工修改那条的定稿被接受,针对第 1 轮的 round-advanced;推送也挑手工修改那条', async (t) => {
  const f = setup(t);
  const { doc, review } = await returnedDoc(f);
  await store.finalizeReview(review.id, f.options);
  const manual = await store.beginManualEdit(doc, f.options);
  fs.writeFileSync(doc, '# 方案\n\n我自己又改了一句。\n');
  const done = await store.completeReview(doc, { ...f.options, expectedApplyMode: 'manual', expectedReviewId: manual.id });
  const latest = store.latestReviewOf((await store.listReviews(f.options)).filter((item) => item.docId === review.docId));
  assert.equal(latest.id, done.id, '最新的是手工修改');
  const pushed = (await sync.listSyncStatus(f.options)).find((item) => item.docId === review.docId);
  assert.equal(pushed.reviewId, done.id, '推送挑的也是它');
  const base = sha(fs.readFileSync(doc));
  assert.equal((await batches.importBatch(finalizeBatch(review, base), f.options)).receipt.reason, 'round-advanced');
  const ok = await batches.importBatch(finalizeBatch(done, base), f.options);
  assert.equal(ok.receipt.accepted, true, ok.receipt.message);
});

test('审查修补:开轮后、迟到批注接管前崩溃,重放补接管,迟到批注随新一轮交出', async (t) => {
  const f = setup(t);
  const { doc, review, finalHash } = await returnedDoc(f);
  // Mac 上交出后才写的、留待下一轮的批注
  await store.mutateAnnotations(doc, (data) => { data.annotations.push({ id: 'late1', comment: '交出后才写的', status: 'open', reviewSessionId: review.id }); }, f.options);
  const batch = nextRoundBatch(review, finalHash);
  const reserveId = `r${crypto.randomBytes(12).toString('hex')}`;
  await store.withReviewTransaction(doc, () => store.openReviewLocked(doc, { ...f.options, reserveReviewId: reserveId, openedByBatch: batch.batchId }), f.options);
  // 造"接管前崩溃":把迟到批注改回旧轮
  await store.mutateAnnotations(doc, (data) => { const late = data.annotations.find((n) => n.id === 'late1'); late.reviewSessionId = review.id; delete late.lateFromReviewId; }, f.options);
  fs.writeFileSync(path.join(f.dataDir, 'imports', `${batch.batchId}.json`), JSON.stringify({ batchId: batch.batchId, docId: review.docId, intent: 'next-round',
    previousReviewId: review.id, reviewId: reserveId, absPath: doc, baseVersion: finalHash, batch, acceptedIds: ['p1', 'p2'], skippedIds: [], stage: 'reserved', createdAt: new Date().toISOString() }));
  const replayed = await batches.importBatch(batch, f.options);
  assert.equal(replayed.receipt.accepted, true, replayed.receipt.message);
  const next = await store.getReviewById(reserveId, f.options);
  assert.ok(next.memberAnnotationIds.includes('late1'), '迟到批注随新一轮交出');
  assert.equal(store.readAnnotations(doc).annotations.find((n) => n.id === 'late1').reviewSessionId, reserveId);
});

test('审查修补:定稿日志落盘后、定稿前正文被改 → 重放复核后拒收,不定稿', async (t) => {
  const f = setup(t);
  const { doc, review, finalHash } = await returnedDoc(f);
  const batch = finalizeBatch(review, finalHash);
  fs.writeFileSync(path.join(f.dataDir, 'imports', `${batch.batchId}.json`), JSON.stringify({ batchId: batch.batchId, docId: review.docId, intent: 'finalize', reviewId: review.id,
    absPath: doc, baseVersion: finalHash, batch, acceptedIds: [], skippedIds: [], stage: 'finalizing', createdAt: new Date().toISOString() }));
  fs.writeFileSync(doc, '# 方案\n\n崩溃后在外面改过。\n');
  const replayed = await batches.importBatch(batch, f.options);
  assert.equal(replayed.receipt.accepted, false);
  assert.equal(replayed.receipt.reason, 'version-mismatch');
  assert.notEqual((await store.getReviewById(review.id, f.options)).outcome, 'finalized');
});

test('审查修补:我自己改之后,Mac 上也不能再给旧的第 1 轮定稿(最新一轮同一个定义)', async (t) => {
  const f = setup(t);
  const { doc, review } = await returnedDoc(f);
  const manual = await store.beginManualEdit(doc, f.options);
  fs.writeFileSync(doc, '# 方案\n\n我自己又改了一句。\n');
  await store.completeReview(doc, { ...f.options, expectedApplyMode: 'manual', expectedReviewId: manual.id });
  await assert.rejects(() => store.finalizeReview(review.id, f.options), (e) => e.code === 'INVALID_STATE');
});

test('审查修补:归档坏了只推状态,修好后签名变、补推正文', async (t) => {
  const f = setup(t);
  const { review } = await returnedDoc(f);
  const current = await store.getReviewById(review.id, f.options);
  const finalFile = path.join(versionStore.versionDir(current.docId, current.versionId, f.options), 'final.md');
  const good = fs.readFileSync(finalFile);
  const intact = sync.pushSignature(current, f.options);
  fs.writeFileSync(finalFile, '坏了');
  const broken = sync.pushSignature(current, f.options);
  assert.notEqual(broken, intact, '归档坏了签名要变');
  assert.equal((await sync.readPushPayload(review.id, f.options)).contentAvailable, false, '载荷同样判断为不可用');
  fs.writeFileSync(finalFile, good);
  assert.equal(sync.pushSignature(current, f.options), intact, '修好后签名回到可用,与上次推的不同就会补推');
});

test('审查修补:留底只写了原稿、meta 没写就崩溃,重放沿用同一个目录(重新分配轮号),不留半成品', async (t) => {
  const f = setup(t);
  const { doc, review, finalHash } = await returnedDoc(f);
  const batch = nextRoundBatch(review, finalHash);
  const reserveId = `r${crypto.randomBytes(12).toString('hex')}`;
  // 造半成品:有原稿,没有 meta(目录名带会话标识)
  const versionId = await versionStore.allocateVersionId(review.docId, reserveId, f.options);
  const dir = versionStore.versionDir(review.docId, versionId, f.options);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'original.md'), fs.readFileSync(doc));
  assert.equal(versionStore.findVersionByReviewId(doc, reserveId, f.options).partial, true);
  fs.writeFileSync(path.join(f.dataDir, 'imports', `${batch.batchId}.json`), JSON.stringify({ batchId: batch.batchId, docId: review.docId, intent: 'next-round',
    previousReviewId: review.id, reviewId: reserveId, absPath: doc, baseVersion: finalHash, batch, acceptedIds: ['p1', 'p2'], skippedIds: [], stage: 'reserved', createdAt: new Date().toISOString() }));
  const replayed = await batches.importBatch(batch, f.options);
  assert.equal(replayed.receipt.accepted, true, replayed.receipt.message);
  const next = await store.getReviewById(reserveId, f.options);
  assert.equal(next.versionId, versionId, '沿用半成品目录');
  assert.ok(versionStore.readMetaFor(review.docId, versionId, f.options), 'meta 补上了');
});

test('审查复核:留底目录刚建、什么都没写就崩溃,决定拒收时也能清掉', async (t) => {
  const f = setup(t);
  const { doc, review, finalHash } = await returnedDoc(f);
  const batch = nextRoundBatch(review, finalHash);
  const reserveId = `r${crypto.randomBytes(12).toString('hex')}`;
  const versionId = await versionStore.allocateVersionId(review.docId, reserveId, f.options);
  const dir = versionStore.versionDir(review.docId, versionId, f.options);
  fs.mkdirSync(dir, { recursive: true }); // 空目录
  fs.writeFileSync(path.join(f.dataDir, 'imports', `${batch.batchId}.json`), JSON.stringify({ batchId: batch.batchId, docId: review.docId, intent: 'next-round',
    previousReviewId: review.id, reviewId: reserveId, absPath: doc, baseVersion: finalHash, batch, acceptedIds: ['p1', 'p2'], skippedIds: [], stage: 'reserved', createdAt: new Date().toISOString() }));
  fs.writeFileSync(doc, '# 方案\n\n崩溃后在外面改过。\n'); // 重放时正文已变 → 拒收
  const replayed = await batches.importBatch(batch, f.options);
  assert.equal(replayed.receipt.accepted, false);
  assert.equal(fs.existsSync(dir), false, '空的半成品目录被清掉');
});

test('审查复核:一篇的归档读不了,推送队列照常列出别的文档;权限修好后重新判断', async (t) => {
  const f = setup(t);
  const { review } = await returnedDoc(f);
  const current = await store.getReviewById(review.id, f.options);
  const finalFile = path.join(versionStore.versionDir(current.docId, current.versionId, f.options), 'final.md');
  const intact = sync.pushSignature(current, f.options);
  fs.chmodSync(finalFile, 0o000);
  t.after(() => { try { fs.chmodSync(finalFile, 0o600); } catch {} });
  if (process.getuid && process.getuid() === 0) return; // root 读得了无权限文件,这条测不了
  assert.notEqual(sync.pushSignature(current, f.options), intact, '读不了算不可用');
  await sync.listOutbox(f.options); // 不抛错
  await sync.listSyncStatus(f.options);
  fs.chmodSync(finalFile, 0o600);
  assert.equal(sync.pushSignature(current, f.options), intact, '权限修好后(只改了状态改变时间)重新判断为可用');
});
