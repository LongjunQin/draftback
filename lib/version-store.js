'use strict';

/*
 * 轮次版本记录(docs/version-record-design.md v4,规则⑤)——第一段:文档身份层与留底。
 *
 *   documents.json           文档身份索引:{ schema, documents: { [docId]: { docId, currentPath, nextRound, nextVersionSeq, latestVersionId } } }
 *                            轮号从这里单调分配,不再数会话记录;会话清理不影响历史。
 *   versions/<docId>/<versionId>/   每个版本事件一个目录:original.md(事件开始时全文)、final.md(事件结束时全文)、meta.json
 *
 * 留底时机:冻结即捕获原稿(openReview;独立手工修改轮在第一次受控写入前);交出时核对原稿还在;
 * 终态分两步:先「固化载荷」(final.md + 批注结果快照,在推进终态的同一事务里,写不下就不推进),再「发布」(meta 定稿、索引更新,可重试)。
 * 文件一律按原始字节复制,不经字符串;所有判断以文件在不在、指纹对不对为准,meta 只是说明。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./review-store');

const { ReviewStoreError } = store;
const SCHEMA = 1;
const KEEP_EVENTS = 10; // 用户定的"保留 10 轮",按用户可见事件计
const KINDS = new Set(['review', 'approved', 'cancelled', 'manual', 'restored']);

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function nowIso() { return new Date().toISOString(); }

function documentsFile(options = {}) { return path.join(store.getDataDir(options), 'documents.json'); }
function versionsRoot(options = {}) { return path.join(store.getDataDir(options), 'versions'); }
function versionDir(docId, versionId, options = {}) {
  if (!/^doc_[0-9a-f]{16}$/.test(String(docId || '')) || !/^[0-9]{4}-r[0-9a-f]{24}$/.test(String(versionId || ''))) {
    throw new ReviewStoreError('BAD_ARGUMENT', `版本标识无效: ${docId}/${versionId}`, { httpStatus: 400 });
  }
  return path.join(versionsRoot(options), docId, versionId);
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch {} }

// ---------- 文档身份索引 ----------

function emptyIndex() { return { schema: SCHEMA, documents: {} }; }
function readIndex(options = {}) {
  const data = store.readJsonStrict(documentsFile(options), emptyIndex());
  if (!data || typeof data !== 'object' || !data.documents || typeof data.documents !== 'object') return emptyIndex();
  return data;
}
function mutateIndex(options, mutator) {
  return store.mutateJson(documentsFile(options), emptyIndex(), (data) => {
    if (!data.documents || typeof data.documents !== 'object') data.documents = {};
    if (!data.schema) data.schema = SCHEMA;
    return mutator(data);
  }, options);
}

function findByPath(data, absPath) {
  return Object.values(data.documents).find((doc) => doc && doc.currentPath === absPath) || null;
}

/**
 * 给一个路径拿到(或建立)文档身份,并分配下一轮的轮号。
 * 迁移:索引里没有、但会话记录里已有这个路径的 docId 时沿用它,nextRound = 现存最大轮号 + 1。
 * 在审阅事务内调用;索引先于会话记录落盘,会话创建失败最多留下一个跳号(轮号只增不减,跳号无害)。
 */
async function allocateRound(absPath, lineage = [], options = {}) {
  return mutateIndex(options, (data) => {
    let doc = findByPath(data, absPath);
    if (!doc) {
      const known = lineage.find((item) => item && item.docId && data.documents[item.docId]);
      if (known) {
        doc = data.documents[known.docId];
        doc.currentPath = absPath; // 会话记录指向这个路径但索引里的路径不同:以会话为准(改名前的旧记录)
      }
    }
    if (!doc) {
      const legacy = lineage.find((item) => item && item.docId);
      const docId = legacy ? legacy.docId : `doc_${crypto.randomBytes(8).toString('hex')}`;
      const rounds = lineage.filter((item) => item && item.docId === docId && Number.isInteger(item.round)).map((item) => item.round);
      doc = {
        docId,
        currentPath: absPath,
        nextRound: (rounds.length ? Math.max(...rounds) : 0) + 1,
        nextVersionSeq: 1,
        latestVersionId: null,
        createdAt: nowIso(),
      };
      data.documents[docId] = doc;
    }
    const round = Number.isInteger(doc.nextRound) && doc.nextRound > 0 ? doc.nextRound : 1;
    doc.nextRound = round + 1;
    doc.updatedAt = nowIso();
    return { docId: doc.docId, round };
  });
}

/** 独立手工修改轮:只要身份,不占轮号 */
async function ensureDocId(absPath, lineage = [], options = {}) {
  return mutateIndex(options, (data) => {
    let doc = findByPath(data, absPath);
    if (!doc) {
      const legacy = lineage.find((item) => item && item.docId);
      const docId = legacy ? legacy.docId : `doc_${crypto.randomBytes(8).toString('hex')}`;
      const rounds = lineage.filter((item) => item && item.docId === docId && Number.isInteger(item.round)).map((item) => item.round);
      doc = data.documents[docId] || { docId, currentPath: absPath, nextRound: (rounds.length ? Math.max(...rounds) : 0) + 1, nextVersionSeq: 1, latestVersionId: null, createdAt: nowIso() };
      doc.currentPath = absPath;
      data.documents[docId] = doc;
    }
    return doc.docId;
  });
}

async function allocateVersionId(docId, reviewId, options = {}) {
  return mutateIndex(options, (data) => {
    const doc = data.documents[docId];
    if (!doc) throw new ReviewStoreError('DOCUMENT_UNKNOWN', `文档身份不存在: ${docId}`, { httpStatus: 404 });
    const seq = Number.isInteger(doc.nextVersionSeq) && doc.nextVersionSeq > 0 ? doc.nextVersionSeq : 1;
    doc.nextVersionSeq = seq + 1;
    return `${String(seq).padStart(4, '0')}-${reviewId}`;
  });
}

/** 云端发布序号:同一文档下跨轮单调递增(跨端规则 v2.3 第 12 节);重试沿用原值由调用方保证 */
async function allocateRevision(docId, options = {}) {
  return mutateIndex(options, (data) => {
    const doc = data.documents[docId];
    if (!doc) throw new ReviewStoreError('DOCUMENT_UNKNOWN', `文档身份不存在: ${docId}`, { httpStatus: 404 });
    const next = Number.isInteger(doc.nextRevision) && doc.nextRevision > 0 ? doc.nextRevision : 1;
    doc.nextRevision = next + 1;
    return next;
  });
}
/** 整体恢复 / 云端比本地新时抬高水位:下一次发布从 max(云端, 本地) + 1 开始 */
async function raiseRevisionFloor(docId, seen, options = {}) {
  return mutateIndex(options, (data) => {
    const doc = data.documents[docId];
    if (!doc) return null;
    const floor = Number(seen) || 0;
    if (!Number.isInteger(doc.nextRevision) || doc.nextRevision <= floor) doc.nextRevision = floor + 1;
    return doc.nextRevision;
  });
}

function getDocument(docId, options = {}) {
  return readIndex(options).documents[docId] || null;
}

// ---------- 附件清单(只记清单,不存文件;含引用式图片;缺失记 missing) ----------

const LINK_PATTERN = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const REF_DEF_PATTERN = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+)>?/gm;
function assetManifest(absPath, buffer) {
  const text = buffer.toString('utf8');
  const documentDir = path.dirname(absPath);
  const seen = new Set();
  const items = [];
  const consider = (target) => {
    if (!target || seen.has(target)) return;
    seen.add(target);
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || path.isAbsolute(target)) return;
    if (/\.(md|markdown)$/i.test(target)) return;
    const abs = path.resolve(documentDir, target);
    const relative = path.relative(documentDir, abs);
    if (!relative || relative.startsWith('..')) return;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return;
      items.push({ relPath: target, bytes: stat.size, hash: sha256(fs.readFileSync(abs)), state: 'ok' });
    } catch {
      items.push({ relPath: target, bytes: 0, hash: null, state: 'missing' });
    }
  };
  for (const match of text.matchAll(LINK_PATTERN)) consider(match[1]);
  for (const match of text.matchAll(REF_DEF_PATTERN)) consider(match[1]);
  return items;
}

// ---------- meta ----------

function metaPath(dir) { return path.join(dir, 'meta.json'); }
function readMeta(dir) {
  try { return store.readJsonStrict(metaPath(dir)); } catch { return null; }
}
async function writeMeta(dir, meta) {
  await store.atomicWriteJson(metaPath(dir), meta, { mode: 0o600 });
}
function fileState(dir, name, expectedHash) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return 'missing';
  try { return sha256(fs.readFileSync(file)) === expectedHash ? 'archived' : 'corrupt'; } catch { return 'corrupt'; }
}

// ---------- 留底:冻结即捕获原稿 ----------

/**
 * 捕获原稿。review 需要 docId / id / round / absPath;返回 { versionId, hash, bytes }。
 * 失败就抛错(调用方据此不建会话 / 不交出),不留一个没底的轮次。
 */
async function captureOriginal(review, options = {}) {
  const buffer = fs.readFileSync(review.absPath);
  const hash = sha256(buffer);
  const versionId = review.versionId || await allocateVersionId(review.docId, review.id, options);
  const dir = versionDir(review.docId, versionId, options);
  ensureDir(dir);
  await store.atomicWriteFile(path.join(dir, 'original.md'), buffer, { mode: 0o600, encoding: undefined });
  const prior = readMeta(dir) || {};
  const meta = {
    schema: SCHEMA,
    docId: review.docId,
    versionId,
    seq: Number(versionId.slice(0, 4)),
    round: review.round,
    reviewId: review.id,
    kind: prior.kind || (review.applyMode === 'manual' && review.round === 'manual-edit' ? 'manual' : 'review'),
    state: 'captured',
    files: { original: { hash, bytes: buffer.length, state: 'archived' }, final: null },
    assets: { original: assetManifest(review.absPath, buffer), final: null },
    startedAt: prior.startedAt || nowIso(),
    completedAt: null,
    summary: null,
    applyMode: review.applyMode || null,
    applyActor: review.applyActor || null,
    claimedBy: review.claimedBy || null,
    restoredFrom: prior.restoredFrom || null,
    memberAnnotationIds: prior.memberAnnotationIds || null,
    annotations: null,
    sourceEncoding: review.sourceEncoding || null,
  };
  await writeMeta(dir, meta);
  return { versionId, hash, bytes: buffer.length };
}

/** 交出时核对:原稿在、指纹对;不在就再捕一次(文件仍冻结着,指纹必须等于 sourceHash),还不行就抛错阻断交出 */
async function verifyOriginal(review, options = {}) {
  if (!review.docId || !review.versionId) {
    const captured = await captureOriginal(review, options);
    if (captured.hash !== review.sourceHash) {
      throw new ReviewStoreError('VERSION_ORIGINAL_MISMATCH', '原稿留底与冻结指纹不一致,已停止交出。', { httpStatus: 409, details: { reviewId: review.id } });
    }
    return captured;
  }
  const dir = versionDir(review.docId, review.versionId, options);
  const state = fileState(dir, 'original.md', review.sourceHash);
  if (state === 'archived') return { versionId: review.versionId, hash: review.sourceHash };
  const captured = await captureOriginal(review, options);
  if (captured.hash !== review.sourceHash) {
    throw new ReviewStoreError('VERSION_ORIGINAL_MISMATCH', '原稿留底与冻结指纹不一致,已停止交出。', { httpStatus: 409, details: { reviewId: review.id } });
  }
  return captured;
}

/** 交出时固定本轮成员与输入快照 */
async function recordMembers(review, members, options = {}) {
  const dir = versionDir(review.docId, review.versionId, options);
  const meta = readMeta(dir);
  if (!meta) throw new ReviewStoreError('VERSION_META_MISSING', '版本记录缺失,已停止交出。', { httpStatus: 500, details: { reviewId: review.id } });
  meta.memberAnnotationIds = members.map((note) => note.id);
  meta.memberInput = members.map(snapshotAnnotation);
  meta.submittedAt = nowIso();
  meta.state = 'submitted';
  await writeMeta(dir, meta);
}

function snapshotAnnotation(note) {
  const value = note || {};
  const keep = ['id', 'scope', 'quote', 'headingPath', 'anchor', 'anchorVersion', 'blockIndex', 'startOffset', 'endOffset', 'author', 'createdAt', 'comment',
    'status', 'appliedBy', 'appliedAt', 'appliedNote', 'cancelledAt', 'cancelReason', 'reviewSessionId', 'sourceAnnotationId', 'receivedBatchId'];
  const out = {};
  for (const key of keep) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

// ---------- 终态第一步:固化载荷(在推进终态的同一事务里;写不下就抛错,终态不推进) ----------

/**
 * kind: review | approved | cancelled | manual;annotations:本轮成员的当前记录(处理结果)。
 * review / manual 把当前文件作为完成稿写入 final.md;approved / cancelled 没有 final。
 */
async function stageTerminal(review, kind, annotations, options = {}) {
  if (!KINDS.has(kind)) throw new ReviewStoreError('BAD_ARGUMENT', `事件类型无效: ${kind}`, { httpStatus: 400 });
  if (!review.docId || !review.versionId) {
    throw new ReviewStoreError('VERSION_MISSING', '这一轮没有留底,不能固化完成稿。', { httpStatus: 409, details: { reviewId: review.id } });
  }
  const dir = versionDir(review.docId, review.versionId, options);
  const meta = readMeta(dir);
  if (!meta) throw new ReviewStoreError('VERSION_META_MISSING', '版本记录缺失,不能固化完成稿。', { httpStatus: 500, details: { reviewId: review.id } });
  let finalHash = null;
  if (kind === 'review' || kind === 'manual') {
    const buffer = fs.readFileSync(review.absPath);
    finalHash = sha256(buffer);
    // 已固化过(终态写入失败后重试):复用已核验的载荷,不覆盖;文件若变了说明固化后有人写入,拒绝
    if (meta.state === 'staged' && meta.files && meta.files.final) {
      if (meta.files.final.hash !== finalHash || fileState(dir, 'final.md', meta.files.final.hash) !== 'archived') {
        throw new ReviewStoreError('VERSION_STAGED_MISMATCH', '完成稿已固化,但文件随后被改过;不能用改过的内容替换已固化的完成稿。', { httpStatus: 409, details: { reviewId: review.id } });
      }
      return { versionId: review.versionId, finalHash, reused: true };
    }
    await store.atomicWriteFile(path.join(dir, 'final.md'), buffer, { mode: 0o600, encoding: undefined });
    meta.files.final = { hash: finalHash, bytes: buffer.length, state: 'archived' };
    meta.assets.final = assetManifest(review.absPath, buffer);
  }
  meta.kind = kind;
  if (Array.isArray(review.memberAnnotationIds)) meta.memberAnnotationIds = review.memberAnnotationIds.slice();
  meta.annotations = (annotations || []).map(snapshotAnnotation);
  meta.summary = review.summary || meta.summary || null;
  meta.applyMode = review.applyMode || meta.applyMode || null;
  meta.applyActor = review.applyActor || meta.applyActor || null;
  meta.claimedBy = review.claimedBy || meta.claimedBy || null;
  meta.completedAt = nowIso();
  meta.state = 'staged';
  await writeMeta(dir, meta);
  return { versionId: review.versionId, finalHash };
}

// ---------- 终态第二步:发布(可失败、可重试;不回退 latestVersionId) ----------

async function publish(docId, versionId, options = {}) {
  const dir = versionDir(docId, versionId, options);
  const meta = readMeta(dir);
  if (!meta || meta.state === 'captured' || meta.state === 'submitted') {
    throw new ReviewStoreError('VERSION_NOT_STAGED', '这一轮还没有固化完成稿,不能发布。', { httpStatus: 409, details: { docId, versionId } });
  }
  // 发布只认"会话已进入终态"的固化载荷:固化了但终态没写成的轮次不能提前发布
  if (meta.reviewId) {
    const review = await store.getReviewById(meta.reviewId, options);
    if (review && !store.TERMINAL_REVIEW_STATES.has(review.status)) {
      throw new ReviewStoreError('VERSION_NOT_TERMINAL', '这一轮还没有进入终态,不能发布。', { httpStatus: 409, details: { docId, versionId, status: review.status } });
    }
  }
  await mutateIndex(options, (data) => {
    const doc = data.documents[docId];
    if (!doc) throw new ReviewStoreError('DOCUMENT_UNKNOWN', `文档身份不存在: ${docId}`, { httpStatus: 404 });
    // 补发历史轮不回退当前
    if (!doc.latestVersionId || doc.latestVersionId < versionId) doc.latestVersionId = versionId;
    doc.updatedAt = nowIso();
  });
  meta.state = 'published';
  meta.publishedAt = nowIso();
  await writeMeta(dir, meta);
  await pruneEvents(docId, options);
  return meta;
}

/** 固化成功后尝试发布;发布失败不抛,记在 meta 里,留给 archive-retry */
async function publishBestEffort(docId, versionId, options = {}) {
  try { return await publish(docId, versionId, options); } catch (error) {
    try {
      const dir = versionDir(docId, versionId, options);
      const meta = readMeta(dir);
      if (meta) { meta.state = 'publish-failed'; meta.publishError = String(error.message || error).slice(0, 300); await writeMeta(dir, meta); }
    } catch {}
    return null;
  }
}

/** 保留最近 KEEP_EVENTS 个已发布事件;活动轮(未固化)不删;整目录删 */
async function pruneEvents(docId, options = {}) {
  const root = path.join(versionsRoot(options), docId);
  let entries = [];
  try { entries = fs.readdirSync(root).filter((name) => /^[0-9]{4}-r[0-9a-f]{24}$/.test(name)).sort(); } catch { return 0; }
  const published = entries.filter((name) => { const meta = readMeta(path.join(root, name)); return meta && (meta.state === 'published' || meta.state === 'publish-failed'); });
  let removed = 0;
  for (const name of published.slice(0, Math.max(0, published.length - KEEP_EVENTS))) {
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); removed += 1; } catch {}
  }
  return removed;
}

// ---------- 查询 ----------

function listVersions(docId, options = {}) {
  const root = path.join(versionsRoot(options), docId);
  let entries = [];
  try { entries = fs.readdirSync(root).filter((name) => /^[0-9]{4}-r[0-9a-f]{24}$/.test(name)).sort(); } catch { return []; }
  return entries.map((name) => {
    const dir = path.join(root, name);
    const meta = readMeta(dir);
    if (!meta) return { versionId: name, state: 'corrupt' };
    const originalState = meta.files && meta.files.original ? fileState(dir, 'original.md', meta.files.original.hash) : 'missing';
    const finalState = meta.files && meta.files.final ? fileState(dir, 'final.md', meta.files.final.hash) : null;
    const notes = Array.isArray(meta.annotations) ? meta.annotations : [];
    const entry = {
      versionId: name, seq: meta.seq, round: meta.round, kind: meta.kind, reviewId: meta.reviewId, state: meta.state,
      startedAt: meta.startedAt, submittedAt: meta.submittedAt || null, completedAt: meta.completedAt, publishedAt: meta.publishedAt || null,
      summary: meta.summary, restoredFrom: meta.restoredFrom,
      applyMode: meta.applyMode || null, applyActor: meta.applyActor || null, claimedBy: meta.claimedBy || null,
      files: { original: originalState, final: finalState },
      counts: { applied: notes.filter((n) => n.status === 'applied').length, wontfix: notes.filter((n) => n.status === 'wontfix').length, total: notes.length },
      publishError: meta.publishError || null,
    };
    // 回稿卡与历史分轮(设计 v4 第 9 节)读事件里的处理记录,不读会继续变的旁注;只在要求时附带,命令行列表不带
    if (options.includeAnnotations) {
      entry.annotations = Array.isArray(meta.annotations) ? meta.annotations : null;
      entry.memberAnnotationIds = Array.isArray(meta.memberAnnotationIds) ? meta.memberAnnotationIds : null;
      entry.assets = meta.assets || null;
    }
    return entry;
  });
}

function readVersion(docId, versionId, which, options = {}) {
  if (!['original', 'final'].includes(which)) throw new ReviewStoreError('BAD_ARGUMENT', 'which 必须是 original 或 final。', { httpStatus: 400 });
  const dir = versionDir(docId, versionId, options);
  const meta = readMeta(dir);
  const expected = meta && meta.files && meta.files[which] ? meta.files[which].hash : null;
  const file = path.join(dir, `${which}.md`);
  if (!expected || !fs.existsSync(file)) return { available: false, reason: meta ? 'missing' : 'unarchived' };
  const buffer = fs.readFileSync(file);
  const hash = sha256(buffer);
  if (hash !== expected) return { available: false, reason: 'corrupt' };
  return { available: true, hash, bytes: buffer.length, buffer, meta };
}

/** 路径 → 文档身份(只查索引,不建);会话被清理后界面靶它读历史 */
function documentByPath(absPath, options = {}) {
  try { return findByPath(readIndex(options), String(absPath)); } catch { return null; }
}

function readMetaFor(docId, versionId, options = {}) {
  try { return readMeta(versionDir(docId, versionId, options)); } catch { return null; }
}

module.exports = {
  SCHEMA, KEEP_EVENTS, KINDS,
  documentsFile, versionsRoot, versionDir,
  readIndex, getDocument, allocateRound, ensureDocId, allocateVersionId, allocateRevision, raiseRevisionFloor,
  captureOriginal, verifyOriginal, recordMembers, stageTerminal, publish, publishBestEffort, pruneEvents,
  listVersions, readVersion, readMetaFor, documentByPath, assetManifest, snapshotAnnotation,
};

// ---------- 恢复到第 N 轮改稿前(设计 v4 第 6 节):单一 restored 事件 + 两阶段提交 ----------

function restoresDir(options = {}) { const dir = path.join(store.getDataDir(options), 'restores'); ensureDir(dir); return dir; }
function restoreLogPath(id, options) { return path.join(restoresDir(options), `${id}.json`); }
function restoreDonePath(clientRequestId, options) { const dir = path.join(restoresDir(options), 'done'); ensureDir(dir); return path.join(dir, `${clientRequestId}.json`); }
function safeRequestId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(value) ? value : null; }

async function writeRestoreLog(log, options) { await store.atomicWriteJson(restoreLogPath(log.id, options), log, { mode: 0o600 }); }

/**
 * 恢复。input:{ docId, toVersionId, expectedCurrentHash, expectedLatestReviewId, clientRequestId }
 * 前提都在文档锁内核查;承诺:提交前失败不改正文;提交中断可按指纹恢复;同步失败不回滚。
 */
async function restoreTo(input = {}, options = {}) {
  const clientRequestId = safeRequestId(input.clientRequestId) || `restore_${crypto.randomBytes(8).toString('hex')}`;
  try {
    const done = store.readJsonStrict(restoreDonePath(clientRequestId, options));
    if (done) return { ...done, replayed: true };
  } catch {}
  const doc = getDocument(input.docId, options);
  if (!doc) throw new ReviewStoreError('DOCUMENT_UNKNOWN', `文档身份不存在: ${input.docId}`, { httpStatus: 404 });
  const absPath = doc.currentPath;
  const target = readVersion(input.docId, input.toVersionId, 'original', options);
  if (!target.available) throw new ReviewStoreError('VERSION_UNAVAILABLE', `这一轮没有可用的原稿留底(${target.reason}),不能恢复。`, { httpStatus: 409, details: { toVersionId: input.toVersionId } });
  return store.withReviewTransaction(absPath, async () => {
    // 锁内复查:同一请求并发重试只做一次;同文档有在途恢复事务时先收敛,不叠加
    try {
      const done = store.readJsonStrict(restoreDonePath(clientRequestId, options));
      if (done) return { ...done, replayed: true };
    } catch {}
    const inflight = restoreConflictFor(absPath, options);
    if (inflight) {
      if (inflight.clientRequestId === clientRequestId && inflight.stage !== 'conflict') return commitOrRollback(inflight, options);
      throw new ReviewStoreError('RESTORE_PENDING', `这篇文档有一个恢复事务还没收敛(${inflight.id},阶段 ${inflight.stage}),先处理它。`, { httpStatus: 409, details: { id: inflight.id, stage: inflight.stage } });
    }
    const reviews = (await store.listReviews(options)).filter((review) => review && review.absPath === absPath);
    const active = reviews.find((review) => store.ACTIVE_REVIEW_STATES.has(review.status));
    if (active) throw new ReviewStoreError('RESTORE_BLOCKED', `这篇文档还有进行中的一轮(${active.status}),先走完或作废再恢复。`, { httpStatus: 409, details: { reviewId: active.id } });
    const editing = require('./documents').isEditing(absPath, options);
    if (editing) throw new ReviewStoreError('RESTORE_BLOCKED', '用户正在回稿里编辑这篇文档,先退出编辑再恢复。', { httpStatus: 409 });
    const pendingImport = require('./batches').pendingImportFor(absPath, options);
    if (pendingImport) throw new ReviewStoreError('IMPORT_PENDING', `有手机批次(${pendingImport.batchId})导入未收敛,先 mdreview import-resume。`, { httpStatus: 409 });
    const currentBuffer = fs.readFileSync(absPath);
    const beforeHash = sha256(currentBuffer);
    if (input.expectedCurrentHash && String(input.expectedCurrentHash).toLowerCase() !== beforeHash) {
      throw new ReviewStoreError('RESTORE_STALE', '当前稿和你看到的不一样了,请重新打开后再恢复。', { httpStatus: 409, details: { currentHash: beforeHash } });
    }
    const latest = reviews.filter((review) => review.docId === input.docId).sort((a, b) => (Number(b.round) || 0) - (Number(a.round) || 0))[0] || null;
    if (input.expectedLatestReviewId && (!latest || latest.id !== input.expectedLatestReviewId)) {
      throw new ReviewStoreError('RESTORE_STALE', '这篇文档的最新一轮已经变了,请重新打开后再恢复。', { httpStatus: 409 });
    }
    const afterHash = target.hash;
    const targetMeta = target.meta || {};
    const newReviewId = `r${crypto.randomBytes(12).toString('hex')}`;
    const { round: newRound } = await allocateRound(absPath, reviews, options);
    const newVersionId = await allocateVersionId(input.docId, newReviewId, options);
    const log = {
      id: `restore_${newReviewId}`, clientRequestId, docId: input.docId, absPath, toVersionId: input.toVersionId, toRound: targetMeta.round || null,
      beforeHash, afterHash, newReviewId, newRound, newVersionId, stage: 'prepared', createdAt: nowIso(),
    };
    await writeRestoreLog(log, options);
    // 第 2 步:恢复事件目录——original = 恢复前当前稿,final = 恢复后的稿(目标轮原稿)
    const dir = versionDir(input.docId, newVersionId, options);
    ensureDir(dir);
    await store.atomicWriteFile(path.join(dir, 'original.md'), currentBuffer, { mode: 0o600, encoding: undefined });
    await store.atomicWriteFile(path.join(dir, 'final.md'), target.buffer, { mode: 0o600, encoding: undefined });
    await writeMeta(dir, {
      schema: SCHEMA, docId: input.docId, versionId: newVersionId, seq: Number(newVersionId.slice(0, 4)), round: newRound, reviewId: newReviewId, kind: 'restored', state: 'staged',
      files: { original: { hash: beforeHash, bytes: currentBuffer.length, state: 'archived' }, final: { hash: afterHash, bytes: target.buffer.length, state: 'archived' } },
      assets: { original: assetManifest(absPath, currentBuffer), final: targetMeta.assets && targetMeta.assets.original ? targetMeta.assets.original : assetManifest(absPath, target.buffer) },
      startedAt: log.createdAt, completedAt: nowIso(), summary: `已恢复到第 ${targetMeta.round || '?'} 轮改稿前`, applyMode: null, applyActor: null, claimedBy: null,
      restoredFrom: { versionId: input.toVersionId, round: targetMeta.round || null, reviewId: targetMeta.reviewId || null },
      memberAnnotationIds: [], annotations: [], sourceEncoding: null,
    });
    log.stage = 'archived';
    await writeRestoreLog(log, options);
    // 第 3 步:写回正文
    await store.atomicWriteFile(absPath, target.buffer, { encoding: undefined });
    log.stage = 'written';
    await writeRestoreLog(log, options);
    return commitRestore(log, options);
  }, options);
}

/** 第 4 步:会话索引新建一条 complete/restored(新身份)、发布事件、写幂等凭据、删事务日志。重放时跳过已做的。 */
async function commitRestore(log, options = {}) {
  const now = nowIso();
  const existing = await store.getReviewById(log.newReviewId, options);
  if (!existing) {
    await store.mutateReviews((data) => {
      data.reviews[log.newReviewId] = {
        id: log.newReviewId, docId: log.docId, round: log.newRound, absPath: log.absPath, file: path.basename(log.absPath),
        sourceHash: log.afterHash, finalHash: log.afterHash, status: 'complete', outcome: 'restored', versionId: log.newVersionId,
        restoredFrom: { versionId: log.toVersionId, round: log.toRound }, summary: `已恢复到第 ${log.toRound || '?'} 轮改稿前`,
        createdAt: now, lastOpenedAt: now, submittedAt: now, completedAt: now, memberAnnotationIds: [],
        sync: { state: 'never', pushRequestedAt: now },
      };
      return null;
    }, options);
  }
  log.stage = 'committed';
  await writeRestoreLog(log, options);
  await publishBestEffort(log.docId, log.newVersionId, options);
  const result = { ok: true, docId: log.docId, reviewId: log.newReviewId, round: log.newRound, versionId: log.newVersionId, restoredFrom: { versionId: log.toVersionId, round: log.toRound }, hash: log.afterHash };
  await store.atomicWriteJson(restoreDonePath(log.clientRequestId, options), result, { mode: 0o600 });
  try { fs.unlinkSync(restoreLogPath(log.id, options)); } catch {}
  return result;
}

/** 恢复事件目录是否完整(两份字节都在且指纹对得上) */
function restoreArchiveComplete(log, options) {
  try {
    const dir = versionDir(log.docId, log.newVersionId, options);
    return fileState(dir, 'original.md', log.beforeHash) === 'archived' && fileState(dir, 'final.md', log.afterHash) === 'archived' && Boolean(readMeta(dir));
  } catch { return false; }
}

/**
 * 在文档锁内判定一笔在途恢复事务该补齐还是撤销:
 *   - 已提交(会话记录存在或阶段 committed):只能补齐,不看工作稿指纹(用户之后把正文改回去也不能撤销)
 *   - 正文 = after 且归档完整:补齐;正文 = before(且不是上面两种):撤销
 *   - 同指纹(before = after)按阶段与归档完整性判:written 之后且归档完整才补齐,否则撤销
 *   - 都不是:保留事务、标 conflict,不动文件
 */
async function commitOrRollback(log, options = {}) {
  const committed = log.stage === 'committed' || Boolean(await store.getReviewById(log.newReviewId, options));
  if (committed) return { action: 'completed', result: await commitRestore(log, options) };
  let actual = null;
  try { actual = sha256(fs.readFileSync(log.absPath)); } catch {}
  const archiveOk = restoreArchiveComplete(log, options);
  const sameHash = log.beforeHash === log.afterHash;
  const treatAsAfter = sameHash ? (log.stage === 'written' && archiveOk && actual === log.afterHash) : (actual === log.afterHash && archiveOk);
  if (treatAsAfter) return { action: 'completed', result: await commitRestore(log, options) };
  if (actual === log.beforeHash) {
    try { fs.rmSync(versionDir(log.docId, log.newVersionId, options), { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(restoreLogPath(log.id, options)); } catch {}
    return { action: 'rolled-back' };
  }
  if (log.stage !== 'conflict') { log.stage = 'conflict'; log.conflictHash = actual; await writeRestoreLog(log, options); }
  return { action: 'conflict', message: '恢复事务与文件对不上,需要人工处理' };
}

/** 启动时收敛中断的恢复(每笔都在它那篇文档的锁内判定) */
async function recoverRestores(options = {}) {
  let names = [];
  try { names = fs.readdirSync(restoresDir(options)).filter((name) => name.endsWith('.json')); } catch { return []; }
  const results = [];
  for (const name of names) {
    let log = null;
    try { log = store.readJsonStrict(restoreLogPath(name.slice(0, -5), options)); } catch { continue; }
    if (!log || !log.absPath) continue;
    try {
      const outcome = await store.withReviewTransaction(log.absPath, () => commitOrRollback(log, options), options);
      results.push({ id: log.id, ...outcome });
    } catch (error) { results.push({ id: log.id, action: 'error', message: error.message }); }
  }
  return results;
}

/** 这篇文档有没有卡住的恢复事务(界面与 status 用) */
function restoreConflictFor(absPath, options = {}) {
  let names = [];
  try { names = fs.readdirSync(restoresDir(options)).filter((name) => name.endsWith('.json')); } catch { return null; }
  for (const name of names) {
    try { const log = store.readJsonStrict(restoreLogPath(name.slice(0, -5), options)); if (log && log.absPath === absPath) return log; } catch {}
  }
  return null;
}

module.exports.restoreTo = restoreTo;
module.exports.recoverRestores = recoverRestores;
module.exports.restoreConflictFor = restoreConflictFor;

// ---------- 受控重关联(设计 v4 第 2 节):改名 / 移动后保留身份与历史 ----------

/**
 * 把文档身份从旧路径挂到新路径:更新索引 currentPath、所有会话记录的 absPath / file、搬旁注文件。
 * 两个路径的事务锁都拿;目标路径已属于另一个 docId 则拒绝;旧路径还存在且内容不同也拒绝(那是复制,不是移动)。
 */
async function relink(oldPath, newPath, options = {}) {
  const from = path.resolve(oldPath);
  const to = store.normalizeMdPath(newPath);
  if (from === to) throw new ReviewStoreError('BAD_ARGUMENT', '新旧路径相同。', { httpStatus: 400 });
  const index = readIndex(options);
  const doc = Object.values(index.documents).find((item) => item && item.currentPath === from);
  if (!doc) throw new ReviewStoreError('DOCUMENT_UNKNOWN', `旧路径没有文档身份: ${from}`, { httpStatus: 404 });
  const occupied = Object.values(index.documents).find((item) => item && item.currentPath === to && item.docId !== doc.docId);
  if (occupied) throw new ReviewStoreError('RELINK_CONFLICT', `目标路径已属于另一篇文档(${occupied.docId}),不能重关联。`, { httpStatus: 409 });
  if (fs.existsSync(from)) {
    let same = false;
    try { same = sha256(fs.readFileSync(from)) === sha256(fs.readFileSync(to)); } catch {}
    if (!same) throw new ReviewStoreError('RELINK_CONFLICT', '旧路径的文件还在且内容不同:这是复制不是移动,副本应是新身份。', { httpStatus: 409 });
  }
  const [first, second] = [from, to].sort();
  return store.withReviewTransaction(first, () => store.withReviewTransaction(second, async () => {
    // 锁内复查:目标占用、在途恢复、活动会话(任何进行中的一轮都先走完,避免持旧路径锁的写入与新路径交错)
    const fresh = readIndex(options);
    if (Object.values(fresh.documents).some((item) => item && item.currentPath === to && item.docId !== doc.docId)) {
      throw new ReviewStoreError('RELINK_CONFLICT', '目标路径已属于另一篇文档,不能重关联。', { httpStatus: 409 });
    }
    if ((fresh.documents[doc.docId] || {}).currentPath !== from) throw new ReviewStoreError('RELINK_CONFLICT', '文档身份已被别的操作改过,请重试。', { httpStatus: 409 });
    if (restoreConflictFor(from, options) || restoreConflictFor(to, options)) throw new ReviewStoreError('RESTORE_PENDING', '有在途的恢复事务,先收敛再重关联。', { httpStatus: 409 });
    const reviews = (await store.listReviews(options)).filter((review) => review && review.absPath === from);
    const active = reviews.find((review) => store.ACTIVE_REVIEW_STATES.has(review.status));
    if (active) {
      throw new ReviewStoreError('RELINK_BLOCKED', `这篇文档正在 ${active.status},先走完或作废这一轮再重关联。`, { httpStatus: 409 });
    }
    const oldSidecar = store.sidecarFor(from);
    const newSidecar = store.sidecarFor(to);
    if (fs.existsSync(oldSidecar)) {
      if (fs.existsSync(newSidecar)) throw new ReviewStoreError('RELINK_CONFLICT', '目标路径旁已有批注文件,不能覆盖。', { httpStatus: 409 });
      fs.renameSync(oldSidecar, newSidecar);
    }
    await store.mutateReviews((data) => {
      for (const review of Object.values(data.reviews)) {
        if (review && review.absPath === from) { review.absPath = to; review.file = path.basename(to); review.relinkedFrom = from; review.relinkedAt = nowIso(); }
      }
      return null;
    }, options);
    await mutateIndex(options, (data) => {
      const item = data.documents[doc.docId];
      item.currentPath = to;
      item.movedFrom = Array.isArray(item.movedFrom) ? item.movedFrom : [];
      item.movedFrom.push({ path: from, at: nowIso() });
      item.updatedAt = nowIso();
    });
    return { docId: doc.docId, from, to, reviews: reviews.length };
  }, options), options);
}

module.exports.relink = relink;
