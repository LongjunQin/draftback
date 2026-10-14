'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const store = require('../lib/review-store');
const PROJECT = path.resolve(__dirname, '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-store-'));
  const dataDir = path.join(root, '.mdread');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { root, dataDir, options: { dataDir } };
}

function writeMd(root, name, body = '# 测试\n') {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT, env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('多文档会话独立，同一文档复用活动会话', async (t) => {
  const f = fixture(t);
  const a = writeMd(f.root, '项目 A/方案.md');
  const b = writeMd(f.root, '项目 B/方案.md');
  const first = await store.openReview(a, f.options);
  const second = await store.openReview(b, f.options);
  const reused = await store.openReview(a, f.options);
  assert.notEqual(first.review.id, second.review.id);
  assert.equal(reused.review.id, first.review.id);
  assert.equal(reused.reused, true);
  assert.equal((await store.listReviews(f.options)).length, 2);
});

test('源文档变化后会话进入 conflict，sidecar 不被写入', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '冲突.md');
  const { review } = await store.openReview(file, f.options);
  await store.mutateAnnotations(file, (data) => data.annotations.push({ id: 'existing', comment: '原批注', status: 'open' }));
  const sidecarBefore = fs.readFileSync(store.sidecarFor(file));
  fs.appendFileSync(file, '\n外部修改\n');
  await assert.rejects(store.assertReviewUnchanged(review.id, f.options), (error) => error.code === 'SOURCE_CONFLICT');
  const current = await store.getReviewById(review.id, f.options);
  assert.equal(current.status, 'conflict');
  assert.deepEqual(fs.readFileSync(store.sidecarFor(file)), sidecarBefore);
});

test('冲突会话在批注全部处理后自愈：重新打开自动开启新一轮', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '自愈.md');
  const first = await store.openReview(file, f.options);
  await store.mutateAnnotations(file, (data) => data.annotations.push({ id: 'n1', comment: '改一下', status: 'open' }));
  await store.submitReview(first.review.id, f.options);
  // Agent 漏跑 begin-apply 直接改稿 → 冲突
  fs.appendFileSync(file, '\n已按批注修改\n');
  await assert.rejects(store.assertReviewUnchanged(first.review.id, f.options), (error) => error.code === 'SOURCE_CONFLICT');
  // 仍有 open 批注时,重新打开必须维持冲突保护
  await assert.rejects(store.openReview(file, f.options), (error) => error.code === 'SOURCE_CONFLICT');
  // 批注全部标记 applied 后,重新打开自动结束旧会话并开启新一轮
  await store.mutateAnnotations(file, (data) => { data.annotations[0].status = 'applied'; });
  const reopened = await store.openReview(file, f.options);
  assert.equal(reopened.reused, false);
  assert.equal(reopened.recovered, true);
  assert.notEqual(reopened.review.id, first.review.id);
  assert.equal(reopened.review.status, 'reviewing');
  const old = await store.getReviewById(first.review.id, f.options);
  assert.equal(old.status, 'complete');
  assert.match(old.autoClosedReason, /自动结束旧会话/);
});

test('mdreview wait 在用户提交审阅后退出,无会话时直接报错', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '等待.md');
  const opened = await store.openReview(file, f.options);
  await store.mutateAnnotations(file, (data) => data.annotations.push({ id: 'w1', comment: '改一下', status: 'open' }));
  const waiting = runNode(['mdreview.js', 'wait', file, '--timeout-minutes', '1'], {
    MDREAD_DATA_DIR: f.dataDir,
    MDREAD_WAIT_POLL_MS: '300',
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await store.submitReview(opened.review.id, f.options);
  const result = await waiting;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /用户已完成批注/);
  // 输出必须内嵌"代理下一步引导":指向 sidecar 与 begin-apply
  assert.match(result.stdout, /annotations\.json/);
  assert.match(result.stdout, /begin-apply/);

  const missing = await runNode(['mdreview.js', 'wait', path.join(f.root, '不存在.md')], { MDREAD_DATA_DIR: f.dataDir });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /没有活动审阅会话/);
});

test('mdreview 全流程 stdout 内嵌代理下一步引导', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '引导.md');
  const env = { MDREAD_DATA_DIR: f.dataDir };

  const opened = await runNode(['mdreview.js', 'open', file, '--no-open'], env);
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /Agent 下一步/);
  assert.match(opened.stdout, /mdreview wait/);

  await store.mutateAnnotations(file, (data) => data.annotations.push({ id: 'g1', comment: '改一下', status: 'open' }));
  const review = await store.getReviewByPath(file, f.options);
  await store.submitReview(review.id, f.options);

  const began = await runNode(['mdreview.js', 'begin-apply', file], env);
  assert.equal(began.code, 0, began.stderr);
  assert.match(began.stdout, /applied\/wontfix/);
  assert.match(began.stdout, /mdreview complete/);

  // 仍有 open 批注时 complete 被拒,且 stderr 指明剩余数量与补救动作
  const rejected = await runNode(['mdreview.js', 'complete', file], env);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /仍有 1 条 open 批注/);
  assert.match(rejected.stderr, /applied\/wontfix/);

  await store.mutateAnnotations(file, (data) => { data.annotations[0].status = 'applied'; });
  const completed = await runNode(['mdreview.js', 'complete', file], env);
  assert.equal(completed.code, 0, completed.stderr);
  assert.match(completed.stdout, /闭环完成/);
});

test('状态机覆盖 approved 与 ready/applying/complete', async (t) => {
  const f = fixture(t);
  const approvedFile = writeMd(f.root, '直接通过.md');
  const approved = await store.openReview(approvedFile, f.options);
  const approvedResult = await store.submitReview(approved.review.id, f.options);
  assert.equal(approvedResult.review.status, 'complete');
  assert.equal(approvedResult.review.outcome, 'approved');
  assert.match(approvedResult.review.finalHash, /^[a-f0-9]{64}$/);

  const file = writeMd(f.root, '需要修改.md');
  const opened = await store.openReview(file, f.options);
  await assert.rejects(store.beginApply(file, f.options), (error) => error.code === 'INVALID_STATE');
  await store.mutateAnnotations(file, (data) => data.annotations.push({ id: 'n1', comment: '修改', status: 'open' }));
  const submitted = await store.submitReview(opened.review.id, f.options);
  assert.equal(submitted.review.status, 'ready_to_apply');
  assert.equal((await store.beginApply(file, f.options)).status, 'applying');
  await assert.rejects(store.completeReview(file, f.options), (error) => error.code === 'OPEN_ANNOTATIONS');
  await store.mutateAnnotations(file, (data) => { data.annotations[0].status = 'applied'; });
  const completed = await store.completeReview(file, f.options);
  assert.equal(completed.status, 'complete');
  assert.match(completed.finalHash, /^[a-f0-9]{64}$/);
});

test('损坏 sidecar 会拒绝覆盖', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '损坏保护.md');
  const sidecar = store.sidecarFor(file);
  fs.writeFileSync(sidecar, '{broken', 'utf8');
  const before = fs.readFileSync(sidecar);
  await assert.rejects(store.mutateAnnotations(file, () => {}), (error) => error.code === 'MALFORMED_JSON');
  assert.deepEqual(fs.readFileSync(sidecar), before);
});

test('多进程 mdreview open 不丢记录', async (t) => {
  const f = fixture(t);
  const files = Array.from({ length: 8 }, (_, index) => writeMd(f.root, `并发/文档 ${index}.md`));
  const reviewRuns = await Promise.all(files.map((file) => runNode(['mdreview.js', 'open', file, '--no-open'], {
    MDREAD_DATA_DIR: f.dataDir,
  })));
  assert.ok(reviewRuns.every((result) => result.code === 0), reviewRuns.map((result) => result.stderr).join('\n'));
  assert.equal((await store.listReviews(f.options)).length, files.length);
});

test('人工解锁在源文件被删除后仍可恢复，私有权限会迁移', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '待恢复.md');
  await store.openReview(file, f.options);
  fs.unlinkSync(file);
  const cancelled = await store.unlockReview(file, '源文件已删除', f.options);
  assert.equal(cancelled.status, 'cancelled');

  const paths = store.getPaths(f.options);
  fs.chmodSync(paths.dataDir, 0o755);
  fs.chmodSync(paths.reviews, 0o644);
  store.ensureDataDir(f.options);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(paths.dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.reviews).mode & 0o777, 0o600);
  }
});

// 2026-10-13 修复:改稿阶段(用户手工修改 / Agent 已 begin-apply)文件内容变化是预期行为,
// 再次 openReview 以前会按哈希不符判冲突,批注清零时甚至自动结束用户那一轮并重新冻结。
test('改稿阶段再次 openReview 复用本轮,不冲突、不自动结束、不开新一轮', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '手工修改.md', '# 手工\n\n原文。\n');
  const { review } = await store.openReview(file, f.options);
  fs.writeFileSync(`${file}.annotations.json`, JSON.stringify({ version: 1, file: '手工修改.md', annotations: [] }));
  await store.submitReview(review.id, f.options);
  const manual = await store.beginManualEdit(file, f.options);
  assert.equal(manual.status, 'applying');
  assert.equal(manual.applyMode, 'manual');
  fs.writeFileSync(file, '# 手工\n\n用户已经改了一句。\n');

  // 手工修改轮是一个新会话(上一轮已因"无批注"闭环);再次 open 必须复用它
  const reopened = await store.openReview(file, f.options);
  assert.equal(reopened.reused, true);
  assert.equal(reopened.review.id, manual.id);
  assert.equal(reopened.review.status, 'applying');
  assert.equal(reopened.review.applyMode, 'manual');
  const stored = await store.getReviewById(manual.id, f.options);
  assert.equal(stored.status, 'applying', '用户的手工修改轮不能被结束');
  const all = Object.values(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'reviews.json'), 'utf8')).reviews);
  assert.equal(all.filter((item) => item.status === 'applying').length, 1, '不得另起一轮');
  assert.equal(all.length, 2, '只有闭环的第一轮和手工修改轮');
});

test('人工解锁作废本轮 open 批注,之后能进入手工修改', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '解锁.md', '# 标题\n正文\n');
  const { review } = await store.openReview(file, f.options);
  fs.writeFileSync(store.sidecarFor(file), JSON.stringify({
    version: 1,
    annotations: [
      { id: 'n1', comment: '没处理的', quote: '正文', status: 'open', reviewSessionId: review.id },
      { id: 'n0', comment: '上一轮已处理', quote: '标题', status: 'applied', reviewSessionId: 'r-old' },
    ],
  }));
  await assert.rejects(store.beginManualEdit(file, f.options), (error) => error.code === 'STATE_ERROR' || error.code === 'OPEN_ANNOTATIONS' || /活动审阅会话/.test(error.message));
  const unlocked = await store.unlockReview(file, '不想要这轮了', f.options);
  assert.equal(unlocked.status, 'cancelled');
  const sidecar = JSON.parse(fs.readFileSync(store.sidecarFor(file), 'utf8'));
  assert.equal(sidecar.annotations.find((a) => a.id === 'n1').status, 'cancelled');
  assert.match(sidecar.annotations.find((a) => a.id === 'n1').cancelReason, /不想要这轮了/);
  assert.equal(sidecar.annotations.find((a) => a.id === 'n0').status, 'applied');
  const manual = await store.beginManualEdit(file, f.options);
  assert.equal(manual.status, 'applying');
  assert.equal(manual.applyMode, 'manual');
});

test('启动清理:文件已删的会话取消或删除,结束超过 90 天的会话删除,活动会话保留', async (t) => {
  const f = fixture(t);
  const keep = writeMd(f.root, '保留.md');
  const gone = writeMd(f.root, '已删.md');
  const oldDone = writeMd(f.root, '很久以前.md');
  const { review: active } = await store.openReview(keep, f.options);
  const { review: goneActive } = await store.openReview(gone, f.options);
  const { review: done } = await store.openReview(oldDone, f.options);
  await store.mutateReviews((data) => {
    data.reviews[goneActive.id].lastOpenedAt = '2026-01-01T00:00:00.000Z'; // 一天没碰
    data.reviews[done.id].status = 'complete';
    data.reviews[done.id].completedAt = '2026-01-01T00:00:00.000Z'; // 超过 90 天
    data.reviews['r-gone-finished'] = { id: 'r-gone-finished', absPath: path.join(f.root, '不存在.md'), file: '不存在.md', status: 'cancelled', cancelledAt: new Date().toISOString(), createdAt: new Date().toISOString() };
    data.reviews['r-broken'] = null;
    return null;
  }, f.options);
  fs.rmSync(gone);
  const result = await store.pruneReviews(f.options);
  assert.deepEqual(result, { removed: 3, cancelled: 1 });
  const left = await store.listReviews(f.options);
  assert.deepEqual(left.map((r) => r.id).sort(), [active.id, goneActive.id].sort());
  assert.equal((await store.getReviewById(goneActive.id, f.options)).status, 'cancelled');
  assert.equal((await store.getReviewById(active.id, f.options)).status, 'reviewing');
});

test('文件名的 NFC / NFD 两种写法指向同一篇文档,只建一套会话', async (t) => {
  const f = fixture(t);
  const nfd = '제안서.md'.normalize('NFD');
  const nfc = '제안서.md'.normalize('NFC');
  const file = writeMd(f.root, nfd, '# 제안\n');
  const first = await store.openReview(file, f.options);
  const second = await store.openReview(path.join(f.root, nfc), f.options);
  assert.equal(second.review.id, first.review.id);
  assert.equal(second.reused, true);
  assert.equal(first.review.absPath, first.review.absPath.normalize('NFC'));
  assert.equal((await store.listReviews(f.options)).length, 1);
});
