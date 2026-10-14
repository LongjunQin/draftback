'use strict';

// 数据快照(路线图 v3 第 5.8 节):整体备份、清单校验、恢复可反悔、自动快照节流与轮换。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const store = require('../lib/review-store');
const snapshot = require('../lib/snapshot');
const PROJECT = path.resolve(__dirname, '..');

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-snapshot-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}

async function openWithNote(docPath, dataDir, comment) {
  const opened = await store.openReview(docPath, { dataDir });
  await store.mutateAnnotations(docPath, (data) => {
    data.annotations.push({ id: `n-${comment}`, status: 'open', comment, quote: '正文', createdAt: new Date().toISOString() });
  }, { dataDir });
  return opened.review;
}

test('快照:备份索引与全部批注文件,清单带校验;缺失的 sidecar 记入 missing', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const docA = path.join(docDir, '甲.md');
  const docB = path.join(docDir, '乙.md');
  const docGone = path.join(docDir, '已删除', '丙.md');
  fs.writeFileSync(docA, '# 甲\n正文\n');
  fs.writeFileSync(docB, '# 乙\n正文\n');
  fs.mkdirSync(path.dirname(docGone), { recursive: true });
  fs.writeFileSync(docGone, '# 丙\n正文\n');
  await openWithNote(docA, dataDir, '甲一');
  await openWithNote(docB, dataDir, '乙一');
  await store.openReview(docGone, { dataDir });
  fs.rmSync(path.dirname(docGone), { recursive: true, force: true });

  const manifest = await snapshot.createSnapshot({ ...options, reason: '测试 手动' });
  assert.match(manifest.id, /^\d{8}-\d{6}-测试-手动$/);
  assert.equal(manifest.reviewsJson.valid, true);
  assert.deepEqual(manifest.sidecars.map((item) => item.absPath).sort(), [docA, docB].sort());
  assert.deepEqual(manifest.missingSidecars, [docGone]);
  const dir = path.join(snapshot.snapshotsDir(options), manifest.id);
  assert.ok(fs.existsSync(path.join(dir, 'reviews.json')));
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  for (const item of manifest.sidecars) {
    assert.equal(fs.readFileSync(path.join(dir, item.file), 'utf8'), fs.readFileSync(store.sidecarFor(item.absPath), 'utf8'));
  }
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, '快照目录只对本人可读');
    assert.equal(fs.statSync(path.join(dir, 'reviews.json')).mode & 0o777, 0o600);
  }
  const listed = snapshot.listSnapshots(options);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, manifest.id);
  assert.equal(listed[0].sidecars, 2);
  assert.equal(listed[0].missingSidecars, 1);
});

test('恢复:需要 --yes;恢复前自动做 pre-restore 快照;被改坏的索引与批注回到快照时的内容;内容被篡改的快照拒绝恢复', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const doc = path.join(docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n正文\n');
  await openWithNote(doc, dataDir, '原批注');
  const paths = store.getPaths(options);
  const indexBefore = fs.readFileSync(paths.reviews, 'utf8');
  const sidecarBefore = fs.readFileSync(store.sidecarFor(doc), 'utf8');

  const manifest = await snapshot.createSnapshot({ ...options, reason: 'before-damage' });

  // 模拟事故:索引损坏、批注被清空。
  fs.writeFileSync(paths.reviews, '{"version":1,"reviews":{}}\n');
  fs.writeFileSync(store.sidecarFor(doc), '{"annotations":[]}\n');

  const preview = await snapshot.restoreSnapshot({ ...options, id: manifest.id, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.plan.reviewsJson, 'restore');
  assert.deepEqual(preview.plan.sidecars, [{ absPath: doc, action: 'restore' }]);
  assert.equal(fs.readFileSync(paths.reviews, 'utf8'), '{"version":1,"reviews":{}}\n', '预览不得改动文件');

  await assert.rejects(() => snapshot.restoreSnapshot({ ...options, id: manifest.id }), (error) => error.code === 'NEEDS_CONFIRM');
  assert.equal(fs.readFileSync(paths.reviews, 'utf8'), '{"version":1,"reviews":{}}\n', '未确认不得改动文件');

  const result = await snapshot.restoreSnapshot({ ...options, id: manifest.id, confirm: true });
  assert.equal(result.restored.reviewsJson, true);
  assert.equal(result.restored.sidecars, 1);
  assert.equal(fs.readFileSync(paths.reviews, 'utf8'), indexBefore);
  assert.equal(fs.readFileSync(store.sidecarFor(doc), 'utf8'), sidecarBefore);
  assert.match(result.preSnapshot, /-pre-restore$/);
  const pre = snapshot.readManifest(options, result.preSnapshot);
  assert.equal(fs.readFileSync(path.join(pre.dir, 'reviews.json'), 'utf8'), '{"version":1,"reviews":{}}\n', 'pre-restore 快照保存的是恢复前的状态');

  // 篡改快照里的批注文件 → 校验失败,拒绝恢复,且不动现有文件。
  const tampered = path.join(snapshot.snapshotsDir(options), manifest.id, manifest.sidecars[0].file);
  fs.writeFileSync(tampered, '{"annotations":[{"id":"evil"}]}\n');
  await assert.rejects(() => snapshot.restoreSnapshot({ ...options, id: manifest.id, confirm: true }), (error) => error.code === 'SNAPSHOT_CORRUPT');
  assert.equal(fs.readFileSync(store.sidecarFor(doc), 'utf8'), sidecarBefore);

  // 文档目录已不存在的 sidecar 跳过,不凭空创建目录。
  const docElsewhere = path.join(docDir, '临时目录', '别处.md');
  fs.mkdirSync(path.dirname(docElsewhere), { recursive: true });
  fs.writeFileSync(docElsewhere, '# 别处\n正文\n');
  await openWithNote(docElsewhere, dataDir, '别处批注');
  const second = await snapshot.createSnapshot({ ...options, reason: 'with-elsewhere' });
  fs.rmSync(path.dirname(docElsewhere), { recursive: true, force: true });
  const partial = await snapshot.restoreSnapshot({ ...options, id: second.id, confirm: true });
  assert.deepEqual(partial.restored.skipped, [docElsewhere]);
  assert.equal(fs.existsSync(path.dirname(docElsewhere)), false);

  await assert.rejects(() => snapshot.restoreSnapshot({ ...options, id: '../../etc', confirm: true }), (error) => error.code === 'BAD_ARGUMENT');
});

test('自动快照:24 小时内只做一份,超过后再做;自动快照只保留最近 10 份,手动快照不清理', async (t) => {
  const { dataDir, docDir, options } = setup(t);
  const doc = path.join(docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n正文\n');
  await openWithNote(doc, dataDir, '批注');

  const base = new Date('2026-10-11T08:00:00');
  const first = await snapshot.ensureAutoSnapshot({ ...options, now: base });
  assert.equal(first.created, true);
  const again = await snapshot.ensureAutoSnapshot({ ...options, now: new Date(base.getTime() + 23 * 60 * 60 * 1000) });
  assert.equal(again.created, false);
  assert.equal(again.latest, first.latest);
  const later = await snapshot.ensureAutoSnapshot({ ...options, now: new Date(base.getTime() + 25 * 60 * 60 * 1000) });
  assert.equal(later.created, true);

  await snapshot.createSnapshot({ ...options, reason: 'keep-me', now: new Date(base.getTime() + 1000) });
  for (let day = 2; day < 2 + snapshot.AUTO_KEEP + 3; day += 1) {
    await snapshot.createSnapshot({ ...options, reason: 'auto', now: new Date(base.getTime() + day * 24 * 60 * 60 * 1000) });
  }
  const listed = snapshot.listSnapshots(options);
  assert.equal(listed.filter((item) => item.reason === 'auto').length, snapshot.AUTO_KEEP);
  assert.equal(listed.filter((item) => item.reason === 'keep-me').length, 1);
  assert.ok(!listed.some((item) => item.id === first.latest), '最早的自动快照已被轮换掉');
});

test('CLI:mdreview snapshot / snapshots / restore --dry-run 与 --yes', async (t) => {
  const { dataDir, docDir } = setup(t);
  const doc = path.join(docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n正文\n');
  await openWithNote(doc, dataDir, 'CLI 批注');
  const env = { ...process.env, DRAFTBACK_DATA_DIR: dataDir };
  const run = (...args) => spawnSync(process.execPath, ['mdreview.js', ...args], { cwd: PROJECT, env, encoding: 'utf8' });

  const created = run('snapshot', '--reason', 'cli-test', '--json');
  assert.equal(created.status, 0, created.stderr);
  const manifest = JSON.parse(created.stdout);
  assert.equal(manifest.reason, 'cli-test');
  assert.equal(manifest.sidecars.length, 1);

  const listed = run('snapshots');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(manifest.id));

  fs.writeFileSync(store.sidecarFor(doc), '{"annotations":[]}\n');
  const preview = run('restore', manifest.id, '--dry-run');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /仅预览/);
  assert.equal(fs.readFileSync(store.sidecarFor(doc), 'utf8'), '{"annotations":[]}\n');

  const refused = run('restore', manifest.id);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--yes/);

  const restored = run('restore', manifest.id, '--yes');
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /pre-restore/);
  assert.equal(JSON.parse(fs.readFileSync(store.sidecarFor(doc), 'utf8')).annotations.length, 1);
});
