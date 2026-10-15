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

test('换 iCloud 账号:第一次知道账号时,以前推过的文档记到这个账号;换账号后旧账号的文档不进推送队列,换回来接着推', async (t) => {
  const f = setup(t);
  const { review } = await finishedDoc(f, '账号.md');
  await sync.markPushed(review.id, {}, f.options); // 升级前推过、没记账号
  await sync.writeHelperState({ account: 'acctA', accountStatus: 'available' }, f.options);
  assert.equal((await store.getReviewById(review.id, f.options)).sync.account, 'acctA', '第一次知道账号:推过的文档记到这个账号');
  // 文档又有了新内容(要再推)
  await store.mutateReviews((data) => { data.reviews[review.id].sync.pushedSignature = 'stale'; }, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 1);
  await sync.writeHelperState({ account: 'acctB', accountStatus: 'available' }, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 0, '换成别的账号:属于原账号的文档不推');
  const status = (await sync.listSyncStatus(f.options)).find((item) => item.reviewId === review.id);
  assert.equal(status.otherAccount, true);
  assert.equal(status.needsPush, false);
  assert.match(sync.describeSync(status, status.needsPush), /另一个 iCloud 账号/);
  // 新账号下新开的文档记到新账号
  const { review: fresh } = await finishedDoc(f, '新账号.md');
  await sync.markPushed(fresh.id, {}, f.options);
  assert.equal((await store.getReviewById(fresh.id, f.options)).sync.account, 'acctB');
  await sync.writeHelperState({ account: 'acctA', accountStatus: 'available' }, f.options);
  const outbox = await sync.listOutbox(f.options);
  assert.ok(outbox.some((item) => item.reviewId === review.id), '换回原账号:接着推');
  assert.ok(!outbox.some((item) => item.reviewId === fresh.id), '新账号的文档不推进原账号');
});

test('云端清理:定稿或作废满 30 天、推过、当前账号的最新一轮才列出,带上它的批次;清过的不再列', async (t) => {
  const f = setup(t);
  const { review } = await finishedDoc(f, '清理.md');
  await sync.writeHelperState({ account: 'acctA' }, f.options);
  await store.finalizeReview(review.id, f.options);
  await sync.markPushed(review.id, {}, f.options);
  fs.mkdirSync(path.join(f.dataDir, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, 'receipts', 'b1.json'), JSON.stringify({ batchId: 'b1', docId: review.docId, accepted: true }));
  const day = 86400000;
  assert.deepEqual(await sync.listCloudCleanup({ ...f.options, now: Date.now() + 29 * day }), [], '不满 30 天不清');
  const due = await sync.listCloudCleanup({ ...f.options, now: Date.now() + 31 * day });
  assert.equal(due.length, 1);
  assert.equal(due[0].docId, review.docId);
  assert.deepEqual(due[0].batchIds, ['b1']);
  await sync.markCloudCleaned(review.id, f.options);
  assert.deepEqual(await sync.listCloudCleanup({ ...f.options, now: Date.now() + 31 * day }), [], '清过的不再列');
  // 回稿了但没定稿:不清
  const { review: open } = await finishedDoc(f, '没定稿.md');
  await sync.markPushed(open.id, {}, f.options);
  assert.deepEqual((await sync.listCloudCleanup({ ...f.options, now: Date.now() + 31 * day })).map((item) => item.reviewId), []);
});

test('推到手机的附件:引用式图片也打包;缺的文件记进清单(不再悄悄跳过);指向其他 Markdown 的不打包', async (t) => {
  const f = setup(t);
  const doc = path.join(f.docDir, '图片.md');
  fs.writeFileSync(path.join(f.docDir, 'ref.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(f.docDir, 'inline.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  const text = '# 图片\n\n![行内](inline.png)\n\n![引用式][pic]\n\n![缺了](missing.png)\n\n[另一篇](other.md)\n\n[pic]: ref.png\n';
  fs.writeFileSync(doc, text);
  const items = sync.collectAttachments(doc, text);
  const byPath = Object.fromEntries(items.map((item) => [item.relPath, item]));
  assert.equal(byPath['inline.png'].included, true);
  assert.equal(byPath['ref.png'].included, true, '引用式图片也打包');
  assert.equal(byPath['ref.png'].sha256, sha(fs.readFileSync(path.join(f.docDir, 'ref.png'))));
  assert.equal(byPath['missing.png'].included, false, '缺的文件记进清单');
  assert.equal(byPath['missing.png'].reason, '文件不在');
  assert.equal(byPath['other.md'], undefined, '指向其他 Markdown 的不打包');
});

test('受控重关联:挪过位置的已知文档打开时给出提示;接上后会话、身份、最近文件都跟到新路径;内容不同或几篇都像就不提示', async (t) => {
  const f = setup(t);
  const documents = require('../lib/documents');
  const { doc, review } = await finishedDoc(f, '挪动.md');
  await documents.readDocument(doc, f.options); // 进最近文件
  const moved = path.join(f.docDir, '新位置', '挪动.md');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(doc, moved);
  const opened = await documents.readDocument(moved, f.options);
  assert.equal(opened.docId, null);
  assert.deepEqual(opened.relinkCandidate, { docId: review.docId, oldPath: doc, file: '挪动.md', round: 1, hash: sha(fs.readFileSync(moved)) });
  const result = await documents.relinkDocument(doc, moved, f.options);
  assert.equal(result.docId, review.docId);
  const again = await documents.readDocument(moved, f.options);
  assert.equal(again.docId, review.docId, '接上后有身份');
  assert.equal(again.relinkCandidate, null);
  assert.equal(again.latestReview.id, review.id, '会话跟到新路径');
  const recent = await documents.listRecent(f.options);
  assert.ok(recent.some((item) => item.absPath === moved));
  assert.ok(!recent.some((item) => item.absPath === doc), '最近文件里的旧路径换成新路径');
  // 内容改过就不提示
  const { doc: doc2 } = await finishedDoc(f, '改过.md');
  const moved2 = path.join(f.docDir, '新位置', '改过.md');
  fs.renameSync(doc2, moved2);
  fs.appendFileSync(moved2, '\n挪完又改了一句。\n');
  assert.equal((await documents.readDocument(moved2, f.options)).relinkCandidate, null);
});

test('恢复到某一轮:我自己改之后,按「最新一轮」(我自己改那条)核对,不误报「最新一轮已经变了」', async (t) => {
  const f = setup(t);
  const versions = require('../lib/version-store');
  const { doc, review } = await finishedDoc(f, '自己改后恢复.md');
  const manual = await store.beginManualEdit(doc, f.options);
  fs.writeFileSync(doc, '# 方案\n\n我自己又改了一句。\n');
  const manualDone = await store.completeReview(doc, { ...f.options, expectedApplyMode: 'manual', expectedReviewId: manual.id });
  const target = (await versions.listVersions(review.docId, f.options)).find((item) => item.reviewId === review.id);
  const result = await versions.restoreTo({ docId: review.docId, toVersionId: target.versionId, expectedCurrentHash: sha(fs.readFileSync(doc)),
    expectedLatestReviewId: manualDone.id, clientRequestId: 'req-after-manual' }, f.options);
  assert.ok(result, '按我自己改那条核对,恢复照常进行');
  assert.equal(fs.readFileSync(doc, 'utf8'), '# 方案\n\n原来的正文。\n', '回到第 1 轮改稿前');
});

test('复核修补:账号记在文档身份上——A 下开的新一轮还没推就换到 B,也不进 B 的推送队列;账号又不明时一篇都不推', async (t) => {
  const f = setup(t);
  await sync.writeHelperState({ account: 'acctA' }, f.options);
  const { doc, review } = await finishedDoc(f, '新一轮.md');
  await sync.markPushed(review.id, {}, f.options);
  const second = (await store.openReview(doc, f.options)).review; // 还没推
  assert.ok((await sync.listOutbox(f.options)).some((item) => item.reviewId === second.id));
  await sync.writeHelperState({ account: 'acctB' }, f.options);
  assert.ok(!(await sync.listOutbox(f.options)).some((item) => item.reviewId === second.id), '新一轮跟着文档归 A,不推进 B');
  // 新文档在 B 下建立:身份上直接记 B
  const { review: fresh } = await finishedDoc(f, 'B 的新文档.md');
  assert.equal(require('../lib/version-store').getDocument(fresh.docId, f.options).account, 'acctB');
  // 账号又不明(iCloud 暂时不可用):一篇都不推
  await sync.writeHelperState({ accountStatus: 'temporarilyUnavailable' }, f.options);
  assert.deepEqual(await sync.listOutbox(f.options), []);
});

test('复核修补:快照恢复后的重新发布被云端更高的旧发布挡住,仍要在更高序号上再发,不算推过', async (t) => {
  const f = setup(t);
  const snapshot = require('../lib/snapshot');
  const { review } = await finishedDoc(f, '高水位.md');
  await sync.markPushed(review.id, {}, f.options);
  const snap = await snapshot.createSnapshot({ ...f.options, reason: 'test' });
  await snapshot.restoreSnapshot({ ...f.options, id: snap.id, confirm: true });
  let current = await store.getReviewById(review.id, f.options);
  assert.equal(current.sync.republishRequired, true);
  assert.equal(sync.needsPush(current, f.options), true);
  await sync.markPushSuperseded(review.id, 10, sync.pushSignature(current, f.options), f.options);
  current = await store.getReviewById(review.id, f.options);
  assert.equal(sync.needsPush(current, f.options), true, '被旧发布挡住:还要再推');
  assert.equal(current.sync.revision, undefined, '序号作废,下次在抬高的水位上重新分配');
  assert.ok(require('../lib/version-store').getDocument(review.docId, f.options).nextRevision > 10);
  await sync.markPushed(review.id, {}, f.options);
  current = await store.getReviewById(review.id, f.options);
  assert.equal(current.sync.republishRequired, undefined, '推成功后清掉标记');
  assert.equal(sync.needsPush(current, f.options), false);
});

test('复核修补:快照里的旧路径现在是另一篇文档时拒绝恢复(不悄悄盖掉它的批注);只是挪了位置的,恢复后打开新位置会问接上历史', async (t) => {
  const f = setup(t);
  const snapshot = require('../lib/snapshot');
  const documents = require('../lib/documents');
  const { doc, review } = await finishedDoc(f, '原位.md');
  const snap = await snapshot.createSnapshot({ ...f.options, reason: 'test' });
  const moved = path.join(f.docDir, '挪走.md');
  fs.renameSync(doc, moved);
  await documents.relinkDocument(doc, moved, f.options);
  fs.writeFileSync(doc, '# 原位上的新文档\n');
  const { review: other } = await store.openReview(doc, f.options);
  await assert.rejects(() => snapshot.restoreSnapshot({ ...f.options, id: snap.id, confirm: true }),
    (error) => error.code === 'RESTORE_CONFLICT' && error.details.conflicts.includes(doc));
  assert.equal((await store.getReviewById(other.id, f.options)).absPath, doc, '拒绝时什么都没动');
});

test('复核修补:快照之后只是挪了位置(原位置空着):恢复后身份回到快照时的位置,打开新位置会问接上历史', async (t) => {
  const f = setup(t);
  const snapshot = require('../lib/snapshot');
  const documents = require('../lib/documents');
  const { doc, review } = await finishedDoc(f, '只挪了.md');
  const snap = await snapshot.createSnapshot({ ...f.options, reason: 'test' });
  const moved = path.join(f.docDir, '只挪了-新位置.md');
  fs.renameSync(doc, moved);
  await documents.relinkDocument(doc, moved, f.options);
  await snapshot.restoreSnapshot({ ...f.options, id: snap.id, confirm: true });
  assert.equal(require('../lib/version-store').getDocument(review.docId, f.options).currentPath, doc, '身份回到快照时的位置(与恢复回来的会话一致)');
  const offered = (await documents.readDocument(moved, f.options)).relinkCandidate;
  assert.equal(offered && offered.docId, review.docId, '打开新位置问要不要接上历史');
});

test('复核修补:快照时最新一轮分到了发布序号还没推上去,恢复后也要在云端水位之上重新发布', async (t) => {
  const f = setup(t);
  const snapshot = require('../lib/snapshot');
  const { review } = await finishedDoc(f, '没推上去.md');
  await store.mutateReviews((data) => { data.reviews[review.id].sync = { state: 'never', revision: 2, revisionSignature: 'sig' }; }, f.options);
  const snap = await snapshot.createSnapshot({ ...f.options, reason: 'test' });
  await snapshot.restoreSnapshot({ ...f.options, id: snap.id, confirm: true });
  let current = await store.getReviewById(review.id, f.options);
  assert.equal(current.sync.republishRequired, true);
  assert.equal(current.sync.revision, undefined, '旧序号作废');
  await sync.markPushSuperseded(review.id, 10, sync.pushSignature(current, f.options), f.options);
  current = await store.getReviewById(review.id, f.options);
  assert.equal(sync.needsPush(current, f.options), true, '被云端旧发布挡住也还要推');
});

test('复核修补:升级认领时,会话上已经记着别的账号的文档不认领给当前账号', async (t) => {
  const f = setup(t);
  const { review } = await finishedDoc(f, '已有归属.md');
  await store.mutateReviews((data) => { data.reviews[review.id].sync = { state: 'pushed', pushedAt: new Date().toISOString(), pushedSignature: 'x', account: 'acctA' }; }, f.options);
  await sync.writeHelperState({ account: 'acctB' }, f.options);
  assert.equal(require('../lib/version-store').getDocument(review.docId, f.options).account, 'acctA', '按会话上的归属认领');
  assert.ok(!(await sync.listOutbox(f.options)).some((item) => item.reviewId === review.id), 'A 的文档不进 B 的队列');
  assert.equal(sync.readHelperState(f.options).accountEverKnown, true);
});

test('复核修补:重关联只认最后一版——挪走前的旧原稿副本不提示;提示后文件又改过,接上时拒绝', async (t) => {
  const f = setup(t);
  const documents = require('../lib/documents');
  const { doc, review } = await finishedDoc(f, '旧副本.md'); // 原稿「原来的正文」,完成稿「改完的正文」
  const elsewhere = path.join(f.docDir, '别处');
  fs.mkdirSync(elsewhere);
  fs.renameSync(doc, path.join(elsewhere, '旧副本.md'));
  const oldCopy = path.join(f.docDir, '旧原稿副本.md');
  fs.writeFileSync(oldCopy, '# 方案\n\n原来的正文。\n');
  assert.equal((await documents.readDocument(oldCopy, f.options)).relinkCandidate, null, '旧原稿不算最后一版');
  const moved = path.join(elsewhere, '旧副本.md');
  const offered = (await documents.readDocument(moved, f.options)).relinkCandidate;
  assert.equal(offered.docId, review.docId);
  fs.appendFileSync(moved, '提示之后又改了。\n');
  await assert.rejects(() => documents.relinkDocument(doc, moved, { ...f.options, expectedDocId: offered.docId, expectedHash: offered.hash }), (error) => error.code === 'RELINK_STALE');
});

test('复核修补:云端清理带上推过的全部附件(包括后来不再引用的);尖括号里带空格的图片路径照样打包', async (t) => {
  const f = setup(t);
  await sync.writeHelperState({ account: 'acctA' }, f.options);
  const { review } = await finishedDoc(f, '附件清理.md');
  await sync.markPushed(review.id, { attachments: ['att_x_old'] }, f.options);
  await sync.markPushed(review.id, { attachments: ['att_x_new'] }, f.options);
  await store.finalizeReview(review.id, f.options);
  const due = await sync.listCloudCleanup({ ...f.options, now: Date.now() + 31 * 86400000 });
  assert.deepEqual(due[0].attachments.sort(), ['att_x_new', 'att_x_old']);
  const doc = path.join(f.docDir, '空格.md');
  fs.writeFileSync(path.join(f.docDir, 'image name.png'), Buffer.from([1, 2, 3]));
  const text = '![a][pic]\n\n![b](<image name.png>)\n\n[pic]: <image name.png>\n';
  fs.writeFileSync(doc, text);
  const items = sync.collectAttachments(doc, text);
  assert.deepEqual(items.map((item) => [item.relPath, item.included]), [['image name.png', true]]);
});
