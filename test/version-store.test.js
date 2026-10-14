'use strict';

// 轮次版本记录第一段(docs/version-record-design.md v4 第 12 节 1~4、13、16 项):
// 文档身份与轮号单调;冻结即留底;交出核对留底与固定成员;终态固化+发布;事件类型;保留 10 个事件;终态不可变;旧会话跳过。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('../lib/review-store');
const versions = require('../lib/version-store');
const documentService = require('../lib/document-service');
const sync = require('../lib/sync');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-versions-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}
function sidecar(doc, annotations) {
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: path.basename(doc), annotations }));
}
function versionDirOf(f, review) { return versions.versionDir(review.docId, review.versionId, f.options); }

test('冻结即留底:open 后 original.md 字节一致、身份索引有轮号;轮号单调不随清理回退', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '留底.md');
  const original = Buffer.from('---\ntitle: x\n---\n# 留底\n\n正文  \n', 'utf8');
  fs.writeFileSync(doc, original);
  const { review } = await store.openReview(doc, f.options);
  assert.match(review.versionId, /^0001-r[0-9a-f]{24}$/);
  const dir = versionDirOf(f, review);
  assert.equal(fs.readFileSync(path.join(dir, 'original.md')).equals(original), true, '原始字节一致');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'captured');
  assert.equal(meta.files.original.hash, sha(original));
  const index = versions.getDocument(review.docId, f.options);
  assert.equal(index.currentPath, doc);
  assert.equal(index.nextRound, 2);
  assert.equal(review.round, 1);

  // 走完一轮,删掉会话记录模拟清理,再开一轮:轮号仍是 2 → 3,不回退
  sidecar(doc, []);
  await store.submitReview(review.id, f.options); // approved
  const second = (await store.openReview(doc, f.options)).review;
  assert.equal(second.round, 2);
  sidecar(doc, []);
  await store.submitReview(second.id, f.options);
  await store.mutateReviews((data) => { delete data.reviews[review.id]; delete data.reviews[second.id]; return null; }, f.options);
  const third = (await store.openReview(doc, f.options)).review;
  assert.equal(third.round, 3, '轮号从索引单调分配,会话清理不影响');
  assert.equal(third.docId, review.docId);
});

test('一轮完整走完:交出核对留底并固定成员;完成先固化再推进;发布后索引指向最新;迟到批注不阻塞完成', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '完整.md');
  fs.writeFileSync(doc, '# 完整\n\n第一段。\n\n第二段。\n');
  const { review } = await store.openReview(doc, f.options);
  sidecar(doc, [
    { id: 'n1', comment: '改第一段', status: 'open', reviewSessionId: review.id },
    { id: 'n2', comment: '改第二段', status: 'open', reviewSessionId: review.id },
  ]);
  const submitted = (await store.submitReview(review.id, f.options)).review;
  assert.deepEqual(submitted.memberAnnotationIds, ['n1', 'n2']);
  let meta = JSON.parse(fs.readFileSync(path.join(versionDirOf(f, review), 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'submitted');
  assert.deepEqual(meta.memberAnnotationIds, ['n1', 'n2']);

  await store.beginApply(doc, { applyMode: 'agent', applyActor: 'Claude Code', ...f.options });
  fs.writeFileSync(doc, '# 完整\n\n第一段改过了。\n\n第二段。\n');
  // 迟到批注:交出后新加的 n3 不算本轮,不阻塞完成
  sidecar(doc, [
    { id: 'n1', comment: '改第一段', status: 'applied', appliedNote: '改了', reviewSessionId: review.id },
    { id: 'n2', comment: '改第二段', status: 'wontfix', appliedNote: '不改', reviewSessionId: review.id },
    { id: 'n3', comment: '迟到的', status: 'open', reviewSessionId: review.id },
  ]);
  assert.equal(store.countOpenForReview(await store.getReviewById(review.id, f.options)), 0, '只数本轮成员');
  const completed = await store.completeReview(doc, { summary: '改了第一段', ...f.options });
  assert.equal(completed.status, 'complete');
  const dir = versionDirOf(f, review);
  assert.equal(fs.readFileSync(path.join(dir, 'final.md'), 'utf8'), '# 完整\n\n第一段改过了。\n\n第二段。\n');
  meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'published');
  assert.equal(meta.kind, 'review');
  assert.equal(meta.summary, '改了第一段');
  assert.deepEqual(meta.annotations.map((n) => [n.id, n.status]), [['n1', 'applied'], ['n2', 'wontfix']], '处理结果快照只含成员');
  assert.equal(meta.files.final.hash, completed.finalHash);
  assert.equal(versions.getDocument(review.docId, f.options).latestVersionId, review.versionId);
  const list = versions.listVersions(review.docId, f.options);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].counts, { applied: 1, wontfix: 1, total: 2 });
  assert.equal(list[0].files.final, 'archived');
  const read = versions.readVersion(review.docId, review.versionId, 'original', f.options);
  assert.equal(read.buffer.toString('utf8'), '# 完整\n\n第一段。\n\n第二段。\n');

  // 终态不可变:complete 之后普通受控写入是工作稿,finalHash 不变
  const before = (await store.getReviewById(review.id, f.options)).finalHash;
  const current = fs.readFileSync(doc);
  await documentService.writeSource(review.id, { content: '# 完整\n\n完成后又改。\n', expectedHash: sha(current), clientRequestId: 'w1' }, f.options);
  const after = await store.getReviewById(review.id, f.options);
  assert.equal(after.finalHash, before, '归档后的 finalHash 不随工作稿变');
  assert.notEqual(after.workingHash, before);
});

test('事件类型:零批注通过只有原稿;作废固化当时成员且只推状态;独立手工修改没写入不产生事件、写了就留底', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '事件.md');
  fs.writeFileSync(doc, '# 事件\n');
  const approved = (await store.openReview(doc, f.options)).review;
  sidecar(doc, []);
  await store.submitReview(approved.id, f.options);
  let meta = JSON.parse(fs.readFileSync(path.join(versionDirOf(f, approved), 'meta.json'), 'utf8'));
  assert.equal(meta.kind, 'approved');
  assert.equal(meta.files.final, null);
  assert.equal(meta.state, 'published');
  const payload = await sync.readPushPayload(approved.id, f.options);
  assert.equal(payload.archived, true, '零批注通过推原稿');
  assert.equal(payload.content, '# 事件\n');

  const cancelled = (await store.openReview(doc, f.options)).review;
  sidecar(doc, [{ id: 'c1', comment: '没处理的', status: 'open', reviewSessionId: cancelled.id }]);
  await store.unlockReview(doc, '测试作废', f.options);
  meta = JSON.parse(fs.readFileSync(path.join(versionDirOf(f, cancelled), 'meta.json'), 'utf8'));
  assert.equal(meta.kind, 'cancelled');
  assert.deepEqual(meta.memberAnnotationIds, ['c1']);
  assert.equal(meta.annotations[0].status, 'open', '固化的是作废那一刻的记录');
  assert.equal(store.readAnnotations(doc).annotations[0].status, 'cancelled');

  // 独立手工修改:不写就提交 → 没有版本事件
  const manual = await store.beginManualEdit(doc, f.options);
  assert.ok(manual.docId, '独立手工修改轮也有文档身份');
  assert.equal(manual.versionId, undefined);
  await store.completeReview(doc, { expectedApplyMode: 'manual', ...f.options });
  assert.equal(versions.listVersions(approved.docId, f.options).length, 2);
  // 写了一笔 → 第一次写入前留底,提交后有 manual 事件
  const manual2 = await store.beginManualEdit(doc, f.options);
  const current = fs.readFileSync(doc);
  await documentService.writeSource(manual2.id, { content: '# 事件\n\n自己改的。\n', expectedHash: sha(current), clientRequestId: 'm1' }, f.options);
  const withVersion = await store.getReviewById(manual2.id, f.options);
  assert.match(withVersion.versionId || '', /^0003-/);
  assert.equal(fs.readFileSync(path.join(versionDirOf(f, withVersion), 'original.md')).equals(current), true);
  await store.completeReview(doc, { expectedApplyMode: 'manual', ...f.options });
  const list = versions.listVersions(approved.docId, f.options);
  assert.equal(list.length, 3);
  assert.equal(list[2].kind, 'manual');
  assert.equal(list[2].files.final, 'archived');
});

test('保留 10 个事件:第 11 个发布后最旧的被清;旧会话(无留底)照常走完不报错', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '保留.md');
  fs.writeFileSync(doc, '# 保留\n');
  let docId = null;
  for (let i = 0; i < 11; i += 1) {
    const { review } = await store.openReview(doc, f.options);
    docId = review.docId;
    sidecar(doc, []);
    await store.submitReview(review.id, f.options);
  }
  const list = versions.listVersions(docId, f.options);
  assert.equal(list.length, 10);
  assert.equal(list[0].seq, 2, '最旧的 0001 已清理');

  // 旧会话:手工造一条没有 versionId 的 reviewing 记录,交出 / 完成都不因留底缺失而失败
  const legacyDoc = path.join(f.docDir, '旧.md');
  fs.writeFileSync(legacyDoc, '# 旧\n');
  await store.mutateReviews((data) => {
    data.reviews.rlegacy000000000000000000 = { id: 'rlegacy000000000000000000', absPath: legacyDoc, file: '旧.md', sourceHash: sha(fs.readFileSync(legacyDoc)), status: 'reviewing', createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() };
    return null;
  }, f.options);
  sidecar(legacyDoc, [{ id: 'l1', comment: '改', status: 'open' }]);
  await store.submitReview('rlegacy000000000000000000', f.options);
  await store.beginApply(legacyDoc, { applyMode: 'agent', ...f.options });
  sidecar(legacyDoc, [{ id: 'l1', comment: '改', status: 'applied' }]);
  const done = await store.completeReview(legacyDoc, f.options);
  assert.equal(done.status, 'complete');
});
