'use strict';

// 跨端规则收尾(2026-10-15 核对第 13 节阶段表后补的缺口):
//   挪动已结束文档后重启,审阅记录不被当成垃圾清掉;非 UTF-8 文档在批注中也只推状态;
//   整体快照恢复不让轮次号、版本序号、发布序号倒退。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('../lib/review-store');
const sync = require('../lib/sync');

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-wrapup-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function finishedDoc(f, name) {
  const doc = path.join(f.docDir, name);
  fs.writeFileSync(doc, '# 方案\n\n原来的正文。\n');
  const { review } = await store.openReview(doc, f.options);
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: name, annotations: [{ id: 'm1', comment: '改一下', status: 'open', reviewSessionId: review.id }] }));
  await store.submitReview(review.id, f.options);
  await store.beginApply(doc, f.options);
  fs.writeFileSync(doc, '# 方案\n\n改完的正文。\n');
  await store.mutateAnnotations(doc, (data) => { data.annotations[0].status = 'applied'; }, f.options);
  const done = await store.completeReview(doc, { ...f.options, summary: '改了。' });
  return { doc, review: done };
}

test('挪动已结束的文档后重启清理:有文档身份的审阅记录留着(等重关联),没有身份的旧会话照旧清掉', async (t) => {
  const f = setup(t);
  const { doc, review } = await finishedDoc(f, '挪走.md');
  fs.renameSync(doc, path.join(f.docDir, '挪到别处.md'));
  // 一条没有文档身份的旧会话,文件也不在了
  await store.mutateReviews((data) => {
    data.reviews.rold = { id: 'rold', absPath: path.join(f.docDir, '早就删了.md'), status: 'complete', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  }, f.options);
  const summary = await store.pruneReviews(f.options);
  assert.equal(summary.removed, 1, '只清掉没有身份的那条');
  assert.ok(await store.getReviewById(review.id, f.options), '挪走的文档的审阅记录还在');
  assert.equal(await store.getReviewById('rold', f.options), null);
});

test('非 UTF-8 文档(GBK)批注中推送:只推状态,不把乱码推到手机', async (t) => {
  const f = setup(t);
  const doc = path.join(f.docDir, '旧编码.md');
  // 「# 标题」的 GBK 字节(不是合法 UTF-8)
  fs.writeFileSync(doc, Buffer.from([0x23, 0x20, 0xb1, 0xea, 0xcc, 0xe2, 0x0a]));
  const { review } = await store.openReview(doc, f.options);
  const payload = await sync.readPushPayload(review.id, f.options);
  assert.equal(payload.contentAvailable, false);
  assert.equal(payload.content, null);
  assert.deepEqual(payload.attachments, []);
  assert.equal(payload.encoding, 'gbk');
  assert.equal(payload.contentHash, sha(fs.readFileSync(doc)));
});

test('整体快照恢复:轮次号、版本序号、发布序号不倒退,latestVersionId 不倒退;恢复后每篇重新发布', async (t) => {
  const f = setup(t);
  const snapshot = require('../lib/snapshot');
  const versionStore = require('../lib/version-store');
  const { doc, review } = await finishedDoc(f, '快照.md');
  await versionStore.allocateRevision(review.docId, f.options);
  await store.mutateReviews((data) => { data.reviews[review.id].sync = { state: 'pushed', pushedSignature: 'old', revision: 1, revisionSignature: 'old' }; }, f.options);
  const snap = await snapshot.createSnapshot({ ...f.options, reason: 'test' });
  // 快照之后又走了一轮,发布序号也往前走了
  const { review: second } = await store.openReview(doc, f.options);
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: '快照.md', annotations: [{ id: 'm2', comment: '再改', status: 'open', reviewSessionId: second.id }] }));
  await store.submitReview(second.id, f.options);
  await store.beginApply(doc, f.options);
  fs.writeFileSync(doc, '# 方案\n\n第二轮改完。\n');
  await store.mutateAnnotations(doc, (data) => { for (const n of data.annotations) n.status = 'applied'; }, f.options);
  const secondDone = await store.completeReview(doc, { ...f.options, summary: '第二轮。' });
  for (let i = 0; i < 3; i += 1) await versionStore.allocateRevision(review.docId, f.options);
  const before = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'documents.json'), 'utf8')).documents[review.docId];

  const result = await snapshot.restoreSnapshot({ ...f.options, id: snap.id, confirm: true });
  assert.equal(result.restored.documentsJson, true);
  const after = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'documents.json'), 'utf8')).documents[review.docId];
  assert.ok(after.nextRound >= before.nextRound, `轮次号不倒退: ${after.nextRound} / ${before.nextRound}`);
  assert.ok(after.nextVersionSeq >= before.nextVersionSeq, '版本序号不倒退');
  assert.ok(after.nextRevision >= before.nextRevision, '发布序号不倒退');
  assert.equal(after.latestVersionId, before.latestVersionId, 'latestVersionId 不倒退');
  assert.equal(after.latestVersionId, secondDone.versionId);
  const restored = await store.getReviewById(review.id, f.options);
  assert.equal(restored.sync.pushedSignature, undefined, '恢复后要重新发布');
  assert.equal(restored.sync.revision, undefined);
  // 恢复后再开一轮:轮号接着往上走,不和第 2 轮撞号
  const { review: third } = await store.openReview(doc, f.options);
  assert.equal(third.round, before.nextRound);
});
