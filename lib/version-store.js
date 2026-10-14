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
    return {
      versionId: name, seq: meta.seq, round: meta.round, kind: meta.kind, reviewId: meta.reviewId, state: meta.state,
      startedAt: meta.startedAt, completedAt: meta.completedAt, summary: meta.summary, restoredFrom: meta.restoredFrom,
      files: { original: originalState, final: finalState },
      counts: { applied: notes.filter((n) => n.status === 'applied').length, wontfix: notes.filter((n) => n.status === 'wontfix').length, total: notes.length },
    };
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

function readMetaFor(docId, versionId, options = {}) {
  try { return readMeta(versionDir(docId, versionId, options)); } catch { return null; }
}

module.exports = {
  SCHEMA, KEEP_EVENTS, KINDS,
  documentsFile, versionsRoot, versionDir,
  readIndex, getDocument, allocateRound, ensureDocId, allocateVersionId,
  captureOriginal, verifyOriginal, recordMembers, stageTerminal, publish, publishBestEffort, pruneEvents,
  listVersions, readVersion, readMetaFor, assetManifest, snapshotAnnotation,
};
