'use strict';

// 恢复到第 N 轮改稿前(设计 v4 第 6 节、第 12 节 5、7、12 项):三轮 + 恢复;恢复产生新身份、旧批次拒收;
// 中断按正文指纹判定(补齐 / 撤销 / 冲突);幂等;有活动会话或编辑登记时拒绝。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('../lib/review-store');
const versions = require('../lib/version-store');
const batches = require('../lib/batches');
const documents = require('../lib/documents');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-restore-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}
function sidecar(doc, annotations) { fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: path.basename(doc), annotations })); }
function note(review, id) { return { id, comment: '改', quote: '正文', docId: review.docId, reviewId: review.id, baseVersion: review.sourceHash }; }
async function runRound(f, doc, content, noteId) {
  const review = (await store.openReview(doc, f.options)).review;
  sidecar(doc, [...store.readAnnotations(doc).annotations, { id: noteId, comment: '改', quote: '正文', status: 'open', reviewSessionId: review.id }]);
  await store.submitReview(review.id, f.options);
  await store.beginApply(doc, { applyMode: 'agent', ...f.options });
  fs.writeFileSync(doc, content);
  await store.mutateAnnotations(doc, (data) => { for (const n of data.annotations) if (n.id === noteId) n.status = 'applied'; }, f.options);
  await store.completeReview(doc, { summary: `第 ${review.round} 轮`, ...f.options });
  return review;
}

test('三轮 + 恢复到第二轮改稿前:正文逐字节一致、新轮 restored、恢复前稿留底、历史不动、无活动会话;再开一轮后旧批次拒收', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '恢复.md');
  fs.writeFileSync(doc, '# 稿\n\n第 0 版。\n');
  const r1 = await runRound(f, doc, '# 稿\n\n第 1 版。\n', 'a1');
  const r2 = await runRound(f, doc, '# 稿\n\n第 2 版。\n', 'a2');
  const r3 = await runRound(f, doc, '# 稿\n\n第 3 版。\n', 'a3');
  assert.deepEqual([r1.round, r2.round, r3.round], [1, 2, 3]);
  const before = versions.listVersions(r1.docId, f.options);
  assert.equal(before.length, 3);
  const target = before.find((v) => v.round === 2);

  const result = await versions.restoreTo({ docId: r1.docId, toVersionId: target.versionId, expectedCurrentHash: sha(fs.readFileSync(doc)), expectedLatestReviewId: r3.id, clientRequestId: 'req-restore-1' }, f.options);
  assert.equal(fs.readFileSync(doc, 'utf8'), '# 稿\n\n第 1 版。\n', '第二轮改稿前 = 第一轮完成稿');
  assert.equal(result.round, 4);
  const restored = await store.getReviewById(result.reviewId, f.options);
  assert.equal(restored.status, 'complete');
  assert.equal(restored.outcome, 'restored');
  assert.equal(restored.restoredFrom.round, 2);
  assert.notEqual(restored.id, r2.id, '恢复是新身份');
  assert.equal(await store.getReviewByPath(doc, { ...f.options, activeOnly: true }), null, '恢复后没有活动会话');
  const after = versions.listVersions(r1.docId, f.options);
  assert.equal(after.length, 4);
  const event = after[3];
  assert.equal(event.kind, 'restored');
  assert.equal(versions.readVersion(r1.docId, event.versionId, 'original', f.options).buffer.toString(), '# 稿\n\n第 3 版。\n', '恢复前的当前稿留在事件 original 里');
  assert.equal(versions.readVersion(r1.docId, event.versionId, 'final', f.options).buffer.toString(), '# 稿\n\n第 1 版。\n');
  assert.deepEqual(store.readAnnotations(doc).annotations.map((n) => [n.id, n.status]), [['a1', 'applied'], ['a2', 'applied'], ['a3', 'applied']], '历史批注不动');
  // 幂等重放
  const replay = await versions.restoreTo({ docId: r1.docId, toVersionId: target.versionId, clientRequestId: 'req-restore-1' }, f.options);
  assert.equal(replay.replayed, true);
  assert.equal(replay.reviewId, result.reviewId);
  assert.equal(versions.listVersions(r1.docId, f.options).length, 4);

  // 再开一轮(第 5 轮):正文与第二轮原稿一字不差;手机交回第二轮批次 → round-advanced
  const r5 = (await store.openReview(doc, f.options)).review;
  assert.equal(r5.round, 5);
  assert.equal(r5.sourceHash, r2.sourceHash);
  const stale = await batches.importBatch({ version: 2, batchId: 'old-round-2-batch', docId: r2.docId, reviewId: r2.id, documentName: '恢复.md', baseVersion: r2.sourceHash, completedAt: new Date().toISOString(), device: 'iPhone', annotations: [note(r2, 'p1')] }, f.options);
  assert.equal(stale.receipt.reason, 'round-advanced');
  assert.equal(stale.receipt.latestRound, 5);
  assert.equal(store.readAnnotations(doc).annotations.some((n) => n.id === 'p1'), false);
  // 反悔:恢复到"恢复前的稿子"(恢复事件的 original)
  sidecar(doc, store.readAnnotations(doc).annotations); await store.submitReview(r5.id, f.options); // 零成员通过,清掉活动会话
  const back = await versions.restoreTo({ docId: r1.docId, toVersionId: event.versionId, clientRequestId: 'req-restore-2' }, f.options);
  assert.equal(fs.readFileSync(doc, 'utf8'), '# 稿\n\n第 3 版。\n');
  assert.equal(back.round, 6);
});

test('前提:有活动会话、编辑登记、当前稿变了、最新轮不符、目标没留底 → 拒绝且文件不动', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '前提.md');
  fs.writeFileSync(doc, '# 前提\n\n0\n');
  const r1 = await runRound(f, doc, '# 前提\n\n1\n', 'b1');
  const v1 = versions.listVersions(r1.docId, f.options)[0];
  const active = (await store.openReview(doc, f.options)).review;
  await assert.rejects(() => versions.restoreTo({ docId: r1.docId, toVersionId: v1.versionId }, f.options), (e) => e.code === 'RESTORE_BLOCKED');
  sidecar(doc, store.readAnnotations(doc).annotations); await store.submitReview(active.id, f.options);
  await documents.setEditing(doc, true, { token: 't1' }, f.options);
  await assert.rejects(() => versions.restoreTo({ docId: r1.docId, toVersionId: v1.versionId }, f.options), (e) => e.code === 'RESTORE_BLOCKED');
  await documents.setEditing(doc, false, { token: 't1' }, f.options);
  await assert.rejects(() => versions.restoreTo({ docId: r1.docId, toVersionId: v1.versionId, expectedCurrentHash: 'f'.repeat(64) }, f.options), (e) => e.code === 'RESTORE_STALE');
  await assert.rejects(() => versions.restoreTo({ docId: r1.docId, toVersionId: v1.versionId, expectedLatestReviewId: 'r000000000000000000000000' }, f.options), (e) => e.code === 'RESTORE_STALE');
  await assert.rejects(() => versions.restoreTo({ docId: r1.docId, toVersionId: '9999-r000000000000000000000000' }, f.options), (e) => e.code === 'VERSION_UNAVAILABLE');
  assert.equal(fs.readFileSync(doc, 'utf8'), '# 前提\n\n1\n');
});

test('中断恢复:文件 = after 补齐,= before 撤销,都不是报冲突且不动文件', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '中断.md');
  fs.writeFileSync(doc, '# 中断\n\n0\n');
  const r1 = await runRound(f, doc, '# 中断\n\n1\n', 'c1');
  const r2 = await runRound(f, doc, '# 中断\n\n2\n', 'c2');
  const v2 = versions.listVersions(r1.docId, f.options).find((v) => v.round === 2);
  const current = fs.readFileSync(doc);
  const makeLog = async (stage) => {
    const newReviewId = `r${crypto.randomBytes(12).toString('hex')}`;
    const newVersionId = await versions.allocateVersionId(r1.docId, newReviewId, f.options);
    const log = { id: `restore_${newReviewId}`, clientRequestId: `crash-${stage}`, docId: r1.docId, absPath: doc, toVersionId: v2.versionId, toRound: 2,
      beforeHash: sha(current), afterHash: v2 && versions.readVersion(r1.docId, v2.versionId, 'original', f.options).hash, newReviewId, newRound: 99, newVersionId, stage, createdAt: new Date().toISOString() };
    fs.mkdirSync(path.join(f.dataDir, 'restores'), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, 'restores', `${log.id}.json`), JSON.stringify(log));
    return log;
  };
  // 1) 日志停在 archived、文件没换 → 撤销
  const a = await makeLog('archived');
  let results = await versions.recoverRestores(f.options);
  assert.equal(results.find((r) => r.id === a.id).action, 'rolled-back');
  assert.equal(fs.readFileSync(doc).equals(current), true);
  // 2) 日志停在 written、文件已是 after → 补齐成 restored 会话
  const b = await makeLog('written');
  fs.writeFileSync(doc, versions.readVersion(r1.docId, v2.versionId, 'original', f.options).buffer);
  const dir = versions.versionDir(r1.docId, b.newVersionId, f.options);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'original.md'), current); fs.writeFileSync(path.join(dir, 'final.md'), fs.readFileSync(doc));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schema: 1, docId: r1.docId, versionId: b.newVersionId, seq: 3, round: 99, reviewId: b.newReviewId, kind: 'restored', state: 'staged', files: { original: { hash: sha(current) }, final: { hash: b.afterHash } }, assets: { original: [], final: [] }, restoredFrom: { versionId: v2.versionId, round: 2 }, annotations: [] }));
  results = await versions.recoverRestores(f.options);
  assert.equal(results.find((r) => r.id === b.id).action, 'completed');
  const restored = await store.getReviewById(b.newReviewId, f.options);
  assert.equal(restored.outcome, 'restored');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'restores', `${b.id}.json`)), false);
  // 3) 文件既不是 before 也不是 after → 冲突,保留日志,不动文件
  const c = await makeLog('written');
  fs.writeFileSync(doc, '# 中断\n\n别人改的\n');
  results = await versions.recoverRestores(f.options);
  assert.equal(results.find((r) => r.id === c.id).action, 'conflict');
  assert.equal(fs.readFileSync(doc, 'utf8'), '# 中断\n\n别人改的\n');
  assert.ok(versions.restoreConflictFor(doc, f.options));
});

test('重关联:改名后身份与历史跟着走、旁注搬家;目标属于别的文档或旧文件内容不同(复制)时拒绝', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '原名.md');
  fs.writeFileSync(doc, '# 原名\n\n0\n');
  const r1 = await runRound(f, doc, '# 原名\n\n1\n', 'd1');
  const moved = path.join(f.docDir, '新名.md');
  fs.renameSync(doc, moved);
  fs.renameSync(`${doc}.annotations.json`, `${moved}.annotations.json.bak`); // 模拟用户只搬了 md,旁注还留在旧名(重关联要把它接上)
  fs.renameSync(`${moved}.annotations.json.bak`, `${doc}.annotations.json`);
  const result = await versions.relink(doc, moved, f.options);
  assert.equal(result.docId, r1.docId);
  assert.equal(versions.getDocument(r1.docId, f.options).currentPath, moved);
  assert.equal((await store.getReviewById(r1.id, f.options)).absPath, moved);
  assert.equal(fs.existsSync(`${moved}.annotations.json`), true, '旁注文件跟着搬');
  assert.equal(versions.listVersions(r1.docId, f.options).length, 1, '历史可见');
  // 再开一轮:轮号接着来,身份不变
  const r2 = (await store.openReview(moved, f.options)).review;
  assert.equal(r2.docId, r1.docId);
  assert.equal(r2.round, 2);
  sidecar(moved, store.readAnnotations(moved).annotations); await store.submitReview(r2.id, f.options);
  // 复制(旧文件还在且内容不同)→ 拒绝
  const copy = path.join(f.docDir, '副本.md');
  fs.writeFileSync(copy, '# 副本\n');
  await assert.rejects(() => versions.relink(moved, copy, f.options), (e) => e.code === 'RELINK_CONFLICT');
  // 目标已属于另一篇文档 → 拒绝
  const other = (await store.openReview(copy, f.options)).review;
  assert.notEqual(other.docId, r1.docId);
  fs.renameSync(moved, path.join(f.docDir, '又改名.md'));
  await assert.rejects(() => versions.relink(moved, copy, f.options), (e) => e.code === 'RELINK_CONFLICT');
});
