'use strict';

// 在回稿里改名(2026-10-15 用户要的功能):同一文件夹里换名字,批注、审阅记录、文档身份、编辑登记、最近文件、
// 覆盖前备份都跟着走;这一轮没走完、新名字已被占或留有别人的历史时拒绝,而且什么都不动。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/review-store');
const documents = require('../lib/documents');
const versionStore = require('../lib/version-store');
const sync = require('../lib/sync');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-rename-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}
const codeOf = (code) => (error) => error && error.code === code;

test('普通文档改名:文件、最近文件、编辑登记、覆盖前备份跟着走;名字校验', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '未命名.md');
  fs.writeFileSync(doc, '# 未命名\n\n正文。\n');
  await documents.readDocument(doc, f.options); // 进最近文件
  await documents.setEditing(doc, true, { token: 'tab-1' }, f.options);
  const current = fs.readFileSync(doc);
  await documents.writeDocument(doc, { content: '# 未命名\n\n改过的正文。\n', expectedHash: require('crypto').createHash('sha256').update(current).digest('hex') }, f.options);

  const result = await documents.renameDocument(doc, '周报', f.options);
  const target = path.join(f.docDir, '周报.md');
  assert.equal(result.renamed, true);
  assert.equal(result.to, target);
  assert.equal(result.document.file, '周报.md');
  assert.equal(fs.existsSync(doc), false, '旧名字不在了');
  assert.match(fs.readFileSync(target, 'utf8'), /改过的正文/);
  const recent = await documents.listRecent(f.options);
  assert.equal(recent.some((item) => item.absPath === doc), false, '最近文件里没有旧名字');
  assert.equal(recent[0].absPath, target);
  assert.ok(documents.isEditing(target, f.options), '编辑登记跟着走');
  assert.equal(documents.isEditing(doc, f.options), null);
  const backupDirs = fs.readdirSync(path.join(f.dataDir, 'backups', 'documents'));
  assert.equal(backupDirs.length, 1);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'backups', 'documents', backupDirs[0], 'origin.txt'), 'utf8').trim(), target, '覆盖前备份跟着新名字');

  // 带扩展名也行;名字没变就什么都不做
  assert.equal((await documents.renameDocument(target, '周报.md', f.options)).renamed, false);
  for (const bad of ['', '   ', '.隐藏', 'a/b', 'a:b', 'x'.repeat(260)]) {
    await assert.rejects(() => documents.renameDocument(target, bad, f.options), codeOf('RENAME_INVALID_NAME'), JSON.stringify(bad));
  }
  assert.ok(fs.existsSync(target), '校验失败不动文件');

  // 同一文件夹里已有同名文件:拒绝,两个文件都不动
  const other = path.join(f.docDir, '月报.md');
  fs.writeFileSync(other, '# 月报\n');
  await assert.rejects(() => documents.renameDocument(target, '月报', f.options), codeOf('RENAME_TARGET_EXISTS'));
  assert.equal(fs.readFileSync(other, 'utf8'), '# 月报\n');
  assert.ok(fs.existsSync(target));
});

test('有审阅历史的文档改名:旁注、所有轮次、文档身份跟着走;手机上的标题跟着变', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n\n正文。\n');
  const first = (await store.openReview(doc, f.options)).review;
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: '方案.md', annotations: [] }));
  await store.submitReview(first.id, f.options); // 零批注 → 本轮结束(已通过)
  const docId = versionStore.documentByPath(doc, f.options).docId;
  assert.ok(docId);
  const before = (await sync.listOutbox(f.options))[0];
  await sync.markPushed(first.id, { signature: before.signature }, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 0);

  const result = await documents.renameDocument(doc, '方案 v2', f.options);
  const target = path.join(f.docDir, '方案 v2.md');
  assert.equal(result.identity, docId);
  assert.equal(result.reviews, 1);
  assert.equal(fs.existsSync(`${doc}.annotations.json`), false);
  assert.ok(fs.existsSync(`${target}.annotations.json`), '旁注跟着新名字');
  const sidecarJson = JSON.parse(fs.readFileSync(`${target}.annotations.json`, 'utf8'));
  assert.equal(sidecarJson.file, '方案 v2.md', '旁注里的文件名跟着变');
  assert.equal(sidecarJson.sourceFile, target);
  assert.equal(fs.readdirSync(path.join(f.dataDir, 'renames')).length, 0, '改名完成后日志删掉');
  const review = await store.getReviewByPath(target, f.options);
  assert.equal(review.id, first.id, '审阅记录跟着新名字');
  assert.equal(review.file, '方案 v2.md');
  assert.equal(review.renamedFrom, doc);
  assert.equal(await store.getReviewByPath(doc, f.options), null);
  const identity = versionStore.documentByPath(target, f.options);
  assert.equal(identity.docId, docId, '文档身份不变');
  assert.equal(identity.movedFrom.at(-1).path, doc);
  assert.equal(result.docId, docId, '读回来的载荷认得出历史');
  assert.ok(versionStore.listVersions(docId, f.options).length >= 1, '历史还在');

  // 手机上的标题要跟着变:改过名的文档名字进推送签名
  const outbox = await sync.listOutbox(f.options);
  assert.equal(outbox.length, 1, '改名后要再推一次');
  assert.equal(outbox[0].title, '方案 v2.md');

  // 下一轮在新名字上开,沿用同一个文档身份
  const second = (await store.openReview(target, f.options)).review;
  assert.equal(second.docId, docId);
  assert.equal(second.round, 2);
});

test('这一轮没走完不能改名;新名字留有别人的批注或历史也不能改;什么都不动', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '报告.md');
  fs.writeFileSync(doc, '# 报告\n');
  const { review } = await store.openReview(doc, f.options);
  await assert.rejects(() => documents.renameDocument(doc, '新报告', f.options), codeOf('RENAME_BLOCKED'));
  assert.ok(fs.existsSync(doc));
  assert.equal((await store.getReviewById(review.id, f.options)).absPath, doc);

  const plain = path.join(f.docDir, '草稿.md');
  fs.writeFileSync(plain, '# 草稿\n');
  // 「旧稿.md」正文被删了,但旁注还在:新名字不能接上它
  fs.writeFileSync(path.join(f.docDir, '旧稿.md.annotations.json'), JSON.stringify({ version: 1, annotations: [{ id: 'n1', comment: '别人的' }] }));
  await assert.rejects(() => documents.renameDocument(plain, '旧稿', f.options), codeOf('RENAME_TARGET_HAS_HISTORY'));
  assert.ok(fs.existsSync(plain));
});

test('只改大小写也能改(不分大小写的卷上新旧是同一个文件)', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, 'Report.md');
  fs.writeFileSync(doc, '# Report\n');
  const result = await documents.renameDocument(doc, 'report', f.options);
  assert.equal(result.renamed, true);
  assert.ok(fs.readdirSync(f.docDir).includes('report.md'), '磁盘上的写法变成小写');
  assert.equal(fs.readdirSync(f.docDir).includes('Report.md'), false);
});

test('改名中途被杀:启动时按日志把记录挂到新名字,或退回到旧名字;之后的索引清理不会删历史', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '季度报告.md');
  fs.writeFileSync(doc, '# 季度报告\n');
  const first = (await store.openReview(doc, f.options)).review;
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: '季度报告.md', annotations: [] }));
  await store.submitReview(first.id, f.options);
  const docId = versionStore.documentByPath(doc, f.options).docId;

  // 情形一:日志写了、文件已改名,记录还没挂过去(进程在这里被杀)
  const target = path.join(f.docDir, '季度报告(终版).md');
  const renames = path.join(f.dataDir, 'renames');
  fs.mkdirSync(renames, { recursive: true });
  fs.writeFileSync(path.join(renames, 'rn_crash1.json'), JSON.stringify({ id: 'rn_crash1', from: doc, to: target, stamp: '2026-10-15T00:00:00.000Z' }));
  fs.renameSync(doc, target);
  const results = await documents.recoverRenames(f.options);
  assert.deepEqual(results.map((item) => item.action), ['completed']);
  assert.equal((await store.getReviewById(first.id, f.options)).absPath, target, '审阅记录挂到新名字');
  assert.equal(versionStore.documentByPath(target, f.options).docId, docId, '文档身份挂到新名字');
  assert.ok(fs.existsSync(`${target}.annotations.json`), '旁注挂到新名字');
  assert.equal(fs.readdirSync(renames).length, 0, '日志收掉');
  const pruned = await store.pruneReviews(f.options);
  assert.equal(pruned.removed, 0, '索引清理不会把它当成文件已不存在');
  assert.ok(await store.getReviewById(first.id, f.options));

  // 情形二:日志写了、记录挂过去了一半,文件还没改名(改文件名之前被杀)
  const other = path.join(f.docDir, '季度报告(草).md');
  fs.writeFileSync(path.join(renames, 'rn_crash2.json'), JSON.stringify({ id: 'rn_crash2', from: target, to: other, stamp: '2026-10-15T01:00:00.000Z' }));
  await store.mutateReviews((data) => {
    const review = data.reviews[first.id];
    review.renamedFrom = review.absPath; review.absPath = other; review.file = path.basename(other); review.renamedAt = '2026-10-15T01:00:00.000Z';
    return null;
  }, f.options);
  const back = await documents.recoverRenames(f.options);
  assert.deepEqual(back.map((item) => item.action), ['rolled-back']);
  assert.equal((await store.getReviewById(first.id, f.options)).absPath, target, '挂过去的一半退回');
  assert.ok(fs.existsSync(target));
  assert.equal(fs.existsSync(other), false);
});
