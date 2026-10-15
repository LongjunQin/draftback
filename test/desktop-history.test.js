'use strict';

// 回稿卡与历史分轮(版本记录设计 v4 第 9 节、第 12 节第 10 项;UI 方案 3.2/3.8):
// 摘要、计数、逐条结果读版本事件;事件缺失 / 发布失败时降级并明说没归档;旧批注归「更早(未分轮)」;
// 历史按轮折叠且区分事件类型;缺原稿或未归档的轮禁用对比与恢复;版本列表 detail=1 才附带处理记录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const History = require('../static/desktop-history');
const store = require('../lib/review-store');
const versions = require('../lib/version-store');

const T = '2026-10-15T01:02:03.000Z';
const agentVersion = {
  versionId: '0003-rabc', seq: 3, round: 3, kind: 'review', reviewId: 'rabc', state: 'published', completedAt: T, summary: '改了两处',
  applyMode: 'agent', applyActor: 'Claude Code', files: { original: 'archived', final: 'archived' }, counts: { applied: 1, wontfix: 1, total: 2 },
  memberAnnotationIds: ['n1', 'n2'],
  annotations: [
    { id: 'n1', quote: '第一段', comment: '改第一段', status: 'applied', appliedNote: '改了', reviewSessionId: 'rabc' },
    { id: 'n2', quote: '第二段', comment: '改第二段', status: 'wontfix', appliedNote: '原文更准确', reviewSessionId: 'rabc' },
    { id: 'n9', quote: '迟到', comment: '不是成员', status: 'open', reviewSessionId: 'rabc' },
  ],
};

test('回稿卡:摘要、采纳 / 未采纳计数、逐条「你 / AI」都来自版本事件,只算固定成员;已定稿不显示卡', () => {
  const card = History.returnCard({ review: { id: 'rabc', status: 'complete', versionId: '0003-rabc', round: 3 }, versions: [agentVersion], annotations: [] });
  assert.equal(card.show, true);
  assert.equal(card.kind, 'agent');
  assert.equal(card.title, '第 3 轮回稿');
  assert.match(card.subtitle, /Claude Code/);
  assert.equal(card.summary, '改了两处');
  assert.deepEqual([card.counts.applied, card.counts.wontfix, card.counts.total], [1, 1, 2], '迟到的 n9 不算本轮');
  assert.deepEqual(card.items.map((i) => [i.you, i.ai]), [['改第一段', '改了'], ['改第二段', '未采纳:原文更准确']]);
  assert.equal(card.degraded, false);
  assert.equal(card.canCompare, true);
  assert.equal(History.returnCard({ review: { id: 'rabc', status: 'complete', outcome: 'finalized' }, versions: [agentVersion] }).show, false);
  assert.equal(History.returnCard({ review: { id: 'rabc', status: 'reviewing' }, versions: [agentVersion] }).show, false);
});

test('回稿卡降级:事件缺失时只有会话摘要并标明没归档,发布失败保留快照并给重试;通过 / 恢复 / 作废各有自己的卡', () => {
  const missing = History.returnCard({
    review: { id: 'rold', status: 'complete', summary: '旧会话的摘要', applyMode: 'agent' }, versions: [],
    annotations: [{ id: 'a', comment: '旧', status: 'applied', appliedNote: '改了', reviewSessionId: 'rold' }, { id: 'b', comment: '别轮的', status: 'applied', reviewSessionId: 'rother' }],
  });
  assert.equal(missing.degraded, true);
  assert.equal(missing.degradedText, History.UNARCHIVED_TEXT);
  assert.equal(missing.summary, '旧会话的摘要');
  assert.deepEqual(missing.items, [], '没归档只给摘要,不从旁注拼结果(Codex 审查第 5 条)');
  assert.equal(missing.counts, null);
  assert.equal(missing.canCompare, false);

  const failed = History.returnCard({ review: { id: 'rabc', status: 'complete', versionId: '0003-rabc' }, versions: [{ ...agentVersion, state: 'publish-failed' }] });
  assert.equal(failed.degraded, true);
  assert.match(failed.degradedText, /发布失败/);
  assert.equal(failed.canRetryPublish, true);
  assert.equal(failed.counts.total, 2, '发布失败但处理记录已固化:仍显示');

  const approved = History.returnCard({ review: { id: 'r2', status: 'complete', outcome: 'approved', round: 2 }, versions: [] });
  assert.equal(approved.kind, 'approved');
  assert.match(approved.title, /第 2 轮 · 通过/);
  const restored = History.returnCard({ review: { id: 'r4', status: 'complete', outcome: 'restored', restoredFrom: { round: 2 } }, versions: [{ versionId: '0004-r4', reviewId: 'r4', kind: 'restored', state: 'published', files: { original: 'archived', final: 'archived' }, restoredFrom: { round: 2 } }] });
  assert.equal(restored.kind, 'restored');
  assert.equal(restored.title, '已恢复到第 2 轮改稿前');
  assert.equal(restored.canCompare, true);
  assert.equal(restored.restoreBackVersionId, '0004-r4');
  const cancelled = History.returnCard({ review: { id: 'r5', status: 'cancelled', round: 5, cancelReason: '人工解锁' }, versions: [] });
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(cancelled.summary, '人工解锁');
});

test('历史按轮折叠:每轮一行带类型与采纳数;未归档轮与「更早(未分轮)」分开;缺原稿禁用对比与恢复;进行中的轮不可恢复', () => {
  const list = [
    { versionId: '0001-r1', seq: 1, round: 1, kind: 'approved', reviewId: 'r1', state: 'published', completedAt: '2026-10-13T01:00:00Z', files: { original: 'archived', final: null }, annotations: [], memberAnnotationIds: [] },
    { versionId: '0002-r2', seq: 2, round: 2, kind: 'review', applyMode: 'manual', reviewId: 'r2', state: 'published', completedAt: '2026-10-13T02:00:00Z', files: { original: 'missing', final: 'archived' }, annotations: [{ id: 'm1', comment: 'x', status: 'applied' }], memberAnnotationIds: ['m1'] },
    agentVersion,
    { versionId: '0004-r4', seq: 4, round: 4, kind: 'restored', reviewId: 'r4', state: 'published', completedAt: '2026-10-14T02:00:00Z', files: { original: 'archived', final: 'archived' }, restoredFrom: { round: 2 }, annotations: [], memberAnnotationIds: [] },
    { versionId: '0005-r5', seq: 5, round: 5, kind: 'review', reviewId: 'r5', state: 'captured', startedAt: '2026-10-15T00:00:00Z', files: { original: 'archived', final: null }, annotations: null, memberAnnotationIds: null },
  ];
  const notes = [
    { id: 'legacy1', comment: '很早的', status: 'applied' },
    { id: 'u1', comment: '事件被清理的那轮', status: 'wontfix', reviewSessionId: 'rgone', appliedAt: '2026-10-12T00:00:00Z' },
    { id: 'cur', comment: '本轮未处理', status: 'open', reviewSessionId: 'r5' },
  ];
  const { rounds, legacy } = History.buildRounds({ review: { id: 'r5', status: 'reviewing', round: 5 }, versions: list, annotations: notes });
  assert.deepEqual(rounds.map((r) => r.label), ['恢复到第 2 轮改稿前', 'AI 改稿', '我自己改', '通过 · 没有批注', '未归档'], '进行中的第 5 轮不进历史');
  assert.deepEqual(rounds.map((r) => r.round), [4, 3, 2, 1, null]);
  const third = rounds.find((r) => r.round === 3);
  assert.deepEqual([third.counts.applied, third.counts.wontfix], [1, 1]);
  assert.equal(third.canCompare, true); assert.equal(third.canRestore, true);
  const second = rounds.find((r) => r.round === 2);
  assert.equal(second.canCompare, false, '缺原稿不能对比'); assert.equal(second.canRestore, false);
  assert.equal(rounds.find((r) => r.round === 1).canRestore, false, '零批注通过没有可恢复的改稿');
  assert.equal(rounds.some((r) => r.round === 5), false, '未处理的批注与进行中的轮不进历史');
  const gone = rounds.find((r) => r.kind === 'unarchived');
  assert.equal(gone.degraded, true); assert.equal(gone.counts.wontfix, 1);
  assert.equal(legacy.count, 1); assert.equal(legacy.items[0].id, 'legacy1');

  const line = History.timeline({ review: { id: 'r5', status: 'reviewing', round: 5 }, versions: list });
  assert.deepEqual(line.map((e) => [e.round, e.pending]), [[1, false], [2, false], [3, false], [4, false], [5, true]]);
});

test('版本列表只在 detail=1 时附带处理记录与成员;列表本身仍有类型、执行者与文件状态', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-history-')));
  const dataDir = path.join(root, '.draftback');
  const doc = path.join(root, '详情.md');
  fs.writeFileSync(doc, '# 详情\n\n第一段。\n');
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const options = { dataDir };
  const { review } = await store.openReview(doc, options);
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: '详情.md', annotations: [{ id: 'n1', comment: '改', status: 'open', reviewSessionId: review.id }] }));
  await store.submitReview(review.id, options);
  await store.beginApply(doc, { applyMode: 'agent', applyActor: 'Codex', ...options });
  fs.writeFileSync(doc, '# 详情\n\n第一段改了。\n');
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: '详情.md', annotations: [{ id: 'n1', comment: '改', status: 'applied', appliedNote: '改了', reviewSessionId: review.id }] }));
  await store.completeReview(doc, { summary: '改了一处', ...options });
  const plain = versions.listVersions(review.docId, options)[0];
  assert.equal(plain.annotations, undefined);
  assert.equal(plain.applyActor, 'Codex');
  assert.equal(plain.kind, 'review');
  const detailed = versions.listVersions(review.docId, { ...options, includeAnnotations: true })[0];
  assert.deepEqual(detailed.memberAnnotationIds, ['n1']);
  assert.deepEqual(detailed.annotations.map((n) => [n.id, n.status, n.appliedNote]), [['n1', 'applied', '改了']]);
  const card = History.returnCard({ review: await store.getReviewById(review.id, options), versions: [detailed], annotations: [] });
  assert.equal(card.summary, '改了一处');
  assert.equal(card.items[0].ai, '改了');
  assert.equal(card.canCompare, true);
});

test('Codex 审查修补:没有快照只给摘要不拼旁注;作废事件里的 open 成员按作废显示;恢复 / 通过卡发布失败也有重试;历史轮带重试', () => {
  const missing = History.returnCard({
    review: { id: 'rold', status: 'complete', summary: '旧摘要', applyMode: 'agent' }, versions: [],
    annotations: [{ id: 'legacy', comment: '旧', status: 'applied', appliedNote: '改了' }],
  });
  assert.equal(missing.counts, null, '没归档就不显示计数');
  assert.deepEqual(missing.items, [], '不从旁注拼本轮结果');
  assert.equal(missing.summary, '旧摘要');
  const cancelledVersion = { versionId: '0002-r2', seq: 2, round: 2, kind: 'cancelled', reviewId: 'r2', state: 'published', summary: '人工解锁', files: { original: 'archived', final: null }, memberAnnotationIds: ['c1'], annotations: [{ id: 'c1', comment: 'x', status: 'open' }] };
  const { rounds } = History.buildRounds({ review: { id: 'r3', status: 'reviewing' }, versions: [cancelledVersion], annotations: [] });
  assert.equal(rounds[0].items[0].status, 'cancelled');
  assert.match(rounds[0].items[0].ai, /已作废/);
  assert.equal(rounds[0].counts.open, 0);
  const restoredFailed = History.returnCard({ review: { id: 'r4', status: 'complete', outcome: 'restored', restoredFrom: { round: 1 } }, versions: [{ versionId: '0004-r4', reviewId: 'r4', kind: 'restored', state: 'publish-failed', files: { original: 'archived', final: 'archived' }, restoredFrom: { round: 1 } }] });
  assert.equal(restoredFailed.degraded, true); assert.equal(restoredFailed.canRetryPublish, true);
  const failedRound = History.buildRounds({ review: { id: 'r9', status: 'reviewing' }, versions: [{ ...agentVersion, state: 'publish-failed' }], annotations: [] }).rounds[0];
  assert.equal(failedRound.canRetryPublish, true);
  assert.match(failedRound.degradedText, /重试/);
});

test('Codex 审查修补:作废时固化的是作废后的状态;普通打开带文档身份', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-cancel-')));
  const dataDir = path.join(root, '.draftback');
  const doc = path.join(root, '作废.md');
  fs.writeFileSync(doc, '# 作废\n');
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const options = { dataDir };
  const { review } = await store.openReview(doc, options);
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: '作废.md', annotations: [{ id: 'n1', comment: '改', status: 'open', reviewSessionId: review.id }] }));
  await store.unlockReview(doc, '测试作废', options);
  const [event] = versions.listVersions(review.docId, { ...options, includeAnnotations: true });
  assert.equal(event.kind, 'cancelled');
  assert.deepEqual(event.annotations.map((n) => [n.id, n.status]), [['n1', 'cancelled']]);
  assert.match(event.annotations[0].cancelReason, /测试作废/);
  const documents = require('../lib/documents');
  const opened = await documents.readDocument(doc, options);
  assert.equal(opened.docId, review.docId);
  // 会话被清理后仍能按身份拿到
  await store.mutateReviews((data) => { delete data.reviews[review.id]; return null; }, options);
  const after = await documents.readDocument(doc, options);
  assert.equal(after.latestReview, null);
  assert.equal(after.docId, review.docId, '会话没了,文档身份还在');
});
