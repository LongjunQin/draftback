'use strict';
/*
 * 数据快照:整体备份与恢复(路线图 v3 第 5.8 节"旧会话与批注可备份、可恢复")。
 *
 * 一份快照 = 审阅索引 reviews.json + 每篇文档旁的批注 sidecar + 手工改稿前的原文备份,
 * 连同清单(manifest.json,含每个文件的 SHA-256)放在 <数据目录>/snapshots/<快照 id>/ 下。
 *
 * - 自动快照:本地服务启动时,若最近一次自动快照已超过 24 小时就再做一份,只保留最近 10 份。
 * - 手动快照:mdreview snapshot [--reason "<原因>"],永不自动删除。
 * - 恢复:mdreview restore <快照 id> --yes;恢复前自动再做一份 pre-restore 快照,所以恢复可反悔。
 *
 * 快照只读取现有文件,不改动任何审阅状态;sidecar 所在目录已不存在的文档会记在清单的 missing 里。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./review-store');

const SNAPSHOTS_DIR_NAME = 'snapshots';
const MANIFEST_VERSION = 1;
const AUTO_REASON = 'auto';
const AUTO_KEEP = 10;
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;

const { ReviewStoreError } = store;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function snapshotsDir(options = {}) {
  const dir = path.join(store.getDataDir(options), SNAPSHOTS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

function slugReason(reason) {
  const slug = String(reason || 'manual').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'manual').slice(0, 24);
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isSafeSnapshotId(id) {
  return typeof id === 'string' && /^[0-9]{8}-[0-9]{6}-[a-z0-9一-鿿-]+(?:-[0-9]+)?$/.test(id);
}

function uniqueSnapshotDir(base, id) {
  let candidate = id;
  for (let suffix = 2; fs.existsSync(path.join(base, candidate)); suffix += 1) candidate = `${id}-${suffix}`;
  return candidate;
}

function readIndexRaw(paths) {
  try {
    const bytes = fs.readFileSync(paths.reviews);
    let parsed = null;
    let valid = false;
    try { parsed = JSON.parse(bytes.toString('utf8')); valid = parsed && typeof parsed === 'object'; } catch { valid = false; }
    return { present: true, bytes, parsed: valid ? parsed : null, valid };
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, bytes: null, parsed: null, valid: false };
    throw error;
  }
}

function reviewsOf(index) {
  if (!index || typeof index !== 'object') return [];
  const reviews = index.reviews;
  if (Array.isArray(reviews)) return reviews.filter((item) => item && typeof item === 'object');
  if (reviews && typeof reviews === 'object') return Object.values(reviews).filter((item) => item && typeof item === 'object');
  return [];
}

function writePrivate(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
}

function copyTree(from, to) {
  let count = 0;
  if (!fs.existsSync(from)) return count;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) { count += copyTree(source, target); continue; }
    if (!entry.isFile()) continue;
    writePrivate(target, fs.readFileSync(source));
    count += 1;
  }
  return count;
}

async function createSnapshot(options = {}) {
  const reason = slugReason(options.reason);
  const now = options.now instanceof Date ? options.now : new Date();
  const paths = store.getPaths(options);
  store.ensureDataDir(options);
  const base = snapshotsDir(options);
  const id = uniqueSnapshotDir(base, `${stamp(now)}-${reason}`);
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const index = readIndexRaw(paths);
  const manifest = {
    version: MANIFEST_VERSION,
    id,
    createdAt: now.toISOString(),
    reason,
    dataDir: paths.dataDir,
    reviewsJson: index.present
      ? { file: 'reviews.json', bytes: index.bytes.length, sha256: sha256(index.bytes), valid: index.valid }
      : null,
    sidecars: [],
    missingSidecars: [],
    originalsCopied: 0,
    documentsJson: null,
    versionFilesCopied: 0,
  };
  if (index.present) writePrivate(path.join(dir, 'reviews.json'), index.bytes);

  const byPath = new Map();
  for (const review of reviewsOf(index.parsed)) {
    if (typeof review.absPath !== 'string' || !review.absPath) continue;
    const entry = byPath.get(review.absPath) || { absPath: review.absPath, reviewIds: [] };
    if (typeof review.id === 'string') entry.reviewIds.push(review.id);
    byPath.set(review.absPath, entry);
  }
  for (const entry of byPath.values()) {
    const sidecar = store.sidecarFor(entry.absPath);
    let bytes;
    try { bytes = fs.readFileSync(sidecar); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { manifest.missingSidecars.push(entry.absPath); continue; }
      throw error;
    }
    const file = `sidecars/${sha256(Buffer.from(entry.absPath, 'utf8')).slice(0, 16)}.annotations.json`;
    writePrivate(path.join(dir, file), bytes);
    manifest.sidecars.push({ absPath: entry.absPath, reviewIds: entry.reviewIds, file, bytes: bytes.length, sha256: sha256(bytes) });
  }
  manifest.sidecars.sort((left, right) => left.absPath.localeCompare(right.absPath));
  manifest.missingSidecars.sort();
  manifest.originalsCopied = copyTree(path.join(paths.dataDir, 'backups'), path.join(dir, 'originals'));
  // 轮次版本记录(规则⑤第 10 节):文档身份索引与每轮留底一起入快照;恢复时整体放回,不拆开
  const documentsJson = path.join(paths.dataDir, 'documents.json');
  if (fs.existsSync(documentsJson)) {
    const bytes = fs.readFileSync(documentsJson);
    writePrivate(path.join(dir, 'documents.json'), bytes);
    manifest.documentsJson = { file: 'documents.json', bytes: bytes.length, sha256: sha256(bytes) };
  }
  manifest.versionFilesCopied = copyTree(path.join(paths.dataDir, 'versions'), path.join(dir, 'versions'));

  await store.atomicWriteJson(path.join(dir, 'manifest.json'), manifest, { mode: 0o600 });
  if (reason === AUTO_REASON) pruneAutoSnapshots(options, AUTO_KEEP);
  return manifest;
}

function readManifest(options, id) {
  if (!isSafeSnapshotId(id)) {
    throw new ReviewStoreError('BAD_ARGUMENT', `快照 id 无效: ${id}`, { httpStatus: 400 });
  }
  const dir = path.join(snapshotsDir(options), id);
  const manifest = store.readJsonStrict(path.join(dir, 'manifest.json'));
  if (!manifest || manifest.version !== MANIFEST_VERSION || manifest.id !== id) {
    throw new ReviewStoreError('SNAPSHOT_CORRUPT', `快照清单无效: ${id}`, { httpStatus: 500, details: { id } });
  }
  return { dir, manifest };
}

function listSnapshots(options = {}) {
  const base = snapshotsDir(options);
  const items = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeSnapshotId(entry.name)) continue;
    try {
      const { manifest } = readManifest(options, entry.name);
      items.push({
        id: manifest.id, createdAt: manifest.createdAt, reason: manifest.reason,
        sidecars: manifest.sidecars.length, missingSidecars: manifest.missingSidecars.length,
        reviewsJson: manifest.reviewsJson ? { bytes: manifest.reviewsJson.bytes, valid: manifest.reviewsJson.valid } : null,
      });
    } catch (error) {
      items.push({ id: entry.name, createdAt: null, reason: null, corrupt: true, error: error.message });
    }
  }
  items.sort((left, right) => String(right.createdAt || right.id).localeCompare(String(left.createdAt || left.id)));
  return items;
}

function pruneAutoSnapshots(options, keep) {
  const autos = listSnapshots(options).filter((item) => item.reason === AUTO_REASON && !item.corrupt);
  for (const item of autos.slice(keep)) {
    fs.rmSync(path.join(snapshotsDir(options), item.id), { recursive: true, force: true });
  }
}

async function ensureAutoSnapshot(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const latest = listSnapshots(options).find((item) => item.reason === AUTO_REASON && !item.corrupt && item.createdAt);
  if (latest && now.getTime() - Date.parse(latest.createdAt) < AUTO_INTERVAL_MS) return { created: false, latest: latest.id };
  const manifest = await createSnapshot({ ...options, reason: AUTO_REASON, now });
  return { created: true, latest: manifest.id };
}

function verifySnapshot(dir, manifest) {
  const problems = [];
  const check = (file, expected) => {
    let bytes;
    try { bytes = fs.readFileSync(path.join(dir, file)); } catch { problems.push(`缺少文件 ${file}`); return null; }
    if (sha256(bytes) !== expected) { problems.push(`校验失败 ${file}`); return null; }
    return bytes;
  };
  const reviewsBytes = manifest.reviewsJson ? check(manifest.reviewsJson.file, manifest.reviewsJson.sha256) : null;
  const sidecars = manifest.sidecars.map((entry) => ({ entry, bytes: check(entry.file, entry.sha256) }));
  if (problems.length) {
    throw new ReviewStoreError('SNAPSHOT_CORRUPT', `快照内容与清单不符,已停止恢复: ${problems.join('; ')}`, {
      httpStatus: 500, details: { id: manifest.id, problems },
    });
  }
  return { reviewsBytes, sidecars };
}

function planRestore(manifest) {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    reviewsJson: manifest.reviewsJson ? (manifest.reviewsJson.valid ? 'restore' : 'skip-invalid') : 'absent',
    sidecars: manifest.sidecars.map((entry) => ({
      absPath: entry.absPath,
      action: fs.existsSync(path.dirname(entry.absPath)) ? 'restore' : 'skip-missing-dir',
    })),
  };
}

async function restoreSnapshot(options = {}) {
  const { id, dryRun = false, confirm = false } = options;
  const { dir, manifest } = readManifest(options, id);
  const content = verifySnapshot(dir, manifest);
  const plan = planRestore(manifest);
  if (dryRun) return { plan, dryRun: true };
  if (!confirm) {
    throw new ReviewStoreError('NEEDS_CONFIRM', '恢复会覆盖当前的审阅索引与批注文件,需要明确加 --yes 才执行。', { httpStatus: 400, details: { plan } });
  }
  const pre = await createSnapshot({ ...options, reason: 'pre-restore' });
  const paths = store.getPaths(options);
  const restored = { reviewsJson: false, sidecars: 0, skipped: [] };
  if (plan.reviewsJson === 'restore') {
    await store.withFileLock(paths.reviews, async () => {
      await store.atomicWriteFile(paths.reviews, content.reviewsBytes, { mode: 0o600, encoding: null });
    });
    restored.reviewsJson = true;
  }
  for (const { entry, bytes } of content.sidecars) {
    const sidecar = store.sidecarFor(entry.absPath);
    if (!fs.existsSync(path.dirname(entry.absPath))) { restored.skipped.push(entry.absPath); continue; }
    await store.withFileLock(sidecar, async () => {
      await store.atomicWriteFile(sidecar, bytes, { mode: 0o644, encoding: null });
    });
    restored.sidecars += 1;
  }
  // 版本目录只增不覆盖已有的(留底文件按内容寻址不会冲突);先放回,下面算高水位时把快照里的也算上
  restored.versionFiles = copyTree(path.join(dir, 'versions'), path.join(paths.dataDir, 'versions'));
  // 文档身份索引按 docId 合并,不整体倒回(跨端规则第 12 节「整体恢复高水位」):身份(路径等)以快照为准,
  // 轮次号、版本序号、发布序号取快照、当前与 versions/ 里实有的最大值,latestVersionId 不倒退;快照之后才有的身份照旧留着
  const snapshotDocuments = path.join(dir, 'documents.json');
  if (manifest.documentsJson && fs.existsSync(snapshotDocuments)) {
    const target = path.join(paths.dataDir, 'documents.json');
    await store.withFileLock(target, async () => {
      await store.atomicWriteJson(target, mergeDocumentIndex(readJson(snapshotDocuments), readJson(target), paths.dataDir), { mode: 0o600 });
    });
    restored.documentsJson = true;
  }
  // 恢复回来的会话按旧的发布签名与序号算是「已推过」:清掉,让每篇按新的序号重新发布一次,手机不会停在恢复前的状态
  if (restored.reviewsJson) restored.republish = await forceRepublish(options);
  return { plan, restored, preSnapshot: pre.id };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const positiveInt = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

/** versions/<docId>/ 里实有的最大版本序号与轮号(目录名「序号-会话标识」,轮号读 meta) */
function versionHighWater(dataDir, docId) {
  const high = { seq: 0, round: 0, latest: null };
  let names = [];
  try { names = fs.readdirSync(path.join(dataDir, 'versions', docId)).filter((name) => /^[0-9]{4}-r[0-9a-f]{24}$/.test(name)).sort(); } catch { return high; }
  for (const name of names) {
    high.seq = Math.max(high.seq, Number(name.slice(0, 4)));
    const meta = readJson(path.join(dataDir, 'versions', docId, name, 'meta.json'));
    if (meta && Number.isInteger(meta.round)) high.round = Math.max(high.round, meta.round);
    if (meta && meta.state === 'published') high.latest = name;
  }
  return high;
}

function mergeDocumentIndex(snapshot, current, dataDir) {
  const snap = snapshot && snapshot.documents ? snapshot : { documents: {} };
  const now = current && current.documents ? current : { documents: {} };
  const merged = { ...now, ...snap, documents: { ...now.documents } };
  const later = (...ids) => ids.filter((id) => typeof id === 'string' && id).sort().pop() || null;
  for (const [docId, doc] of Object.entries(snap.documents)) {
    if (!doc || typeof doc !== 'object') continue;
    const cur = now.documents[docId];
    const disk = versionHighWater(dataDir, docId);
    merged.documents[docId] = {
      ...(cur || {}),
      ...doc,
      // 路径以现在为准(快照之后挪过、重关联过的,文件就在新位置);账号与云端附件清单也取现在的
      currentPath: cur && cur.currentPath ? cur.currentPath : doc.currentPath,
      ...(cur && cur.account ? { account: cur.account } : {}),
      ...(cur && Array.isArray(cur.cloudAttachments) ? { cloudAttachments: cur.cloudAttachments } : {}),
      nextRound: Math.max(positiveInt(doc.nextRound), positiveInt(cur && cur.nextRound), disk.round + 1, 1),
      nextVersionSeq: Math.max(positiveInt(doc.nextVersionSeq), positiveInt(cur && cur.nextVersionSeq), disk.seq + 1, 1),
      nextRevision: Math.max(positiveInt(doc.nextRevision), positiveInt(cur && cur.nextRevision), 1),
      latestVersionId: later(doc.latestVersionId, cur && cur.latestVersionId, disk.latest),
    };
  }
  // 一个路径只能属于一篇:快照里的旧路径已被现在的另一篇占着时,现在的那篇留着,快照这篇的路径空出来(历史还在,打开新位置时可重关联)
  const owner = new Map();
  for (const [docId, doc] of Object.entries(now.documents)) if (doc && doc.currentPath) owner.set(doc.currentPath.normalize('NFC').toLowerCase(), docId);
  for (const [docId, doc] of Object.entries(merged.documents)) {
    if (!doc || !doc.currentPath) continue;
    const key = doc.currentPath.normalize('NFC').toLowerCase();
    const holder = owner.get(key);
    if (holder && holder !== docId) { doc.detachedPath = doc.currentPath; doc.currentPath = null; continue; }
    owner.set(key, docId);
  }
  return merged;
}

async function forceRepublish(options) {
  // 只管推过的会话(没推过的本来就会推);一条都没有就不碰索引文件
  const pushed = (review) => review && review.docId && review.sync && (review.sync.pushedSignature || review.sync.pushedAt);
  if (!(await store.listReviews(options)).some(pushed)) return 0;
  let count = 0;
  await store.mutateReviews((data) => {
    for (const review of Object.values(data.reviews || {})) {
      if (!pushed(review)) continue;
      delete review.sync.pushedSignature;
      delete review.sync.revision;
      delete review.sync.revisionSignature;
      review.sync.republishRequired = true; // 云端若已有更高序号的旧发布,也要在它之上重新发布(sync.markPushSuperseded)
      count += 1;
    }
  }, options);
  return count;
}

module.exports = {
  AUTO_KEEP,
  AUTO_INTERVAL_MS,
  snapshotsDir,
  createSnapshot,
  listSnapshots,
  readManifest,
  ensureAutoSnapshot,
  restoreSnapshot,
};
