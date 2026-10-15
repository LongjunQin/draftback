#!/usr/bin/env node
'use strict';
/*
 * draftback-service —— 回稿(Draftback,原名 MDTurn)的本机冻结审阅服务。
 *
 * 只监听 loopback:桌面壳加载 /desktop,CLI 与 App 通过 /api/* 协作。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./lib/review-store');
const sync = require('./lib/sync');
const presence = require('./lib/agent-presence');
const versionStore = require('./lib/version-store');
const documents = require('./lib/document-service');
const snapshot = require('./lib/snapshot');
const plainDocuments = require('./lib/documents');
const batches = require('./lib/batches');
const { createReviewEventHub } = require('./lib/review-events');

function parsePort(value, fallback = null, options = {}) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d{1,5}$/.test(text)) return fallback;
  const port = Number(text);
  const minimum = options.allowZero ? 0 : 1;
  return Number.isInteger(port) && port >= minimum && port <= 65535 ? port : fallback;
}
const PORT_BASE = parsePort(process.env.DRAFTBACK_PORT === undefined ? '8080' : process.env.DRAFTBACK_PORT, null, { allowZero: true });
if (PORT_BASE === null) {
  console.error(`启动失败: DRAFTBACK_PORT 无效: ${process.env.DRAFTBACK_PORT}`);
  process.exit(1);
}
const HOST = process.env.DRAFTBACK_HOST || '127.0.0.1';
const STATIC_DIR = path.join(__dirname, 'static');
const PATHS = store.getPaths();
const EVENT_HEARTBEAT_MS = (() => {
  const value = Number(process.env.DRAFTBACK_EVENT_HEARTBEAT_MS);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
})();
const reviewEvents = createReviewEventHub({ heartbeatMs: EVENT_HEARTBEAT_MS });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function safeJoin(base, rel) {
  try { rel = decodeURIComponent(rel || ''); } catch { return null; }
  rel = rel.replace(/^[\\/]+/, '');
  const target = path.resolve(base, rel);
  const r = path.relative(base, target);
  if (r !== '' && (r.startsWith('..') || path.isAbsolute(r))) return null;
  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    const realRelative = path.relative(realBase, realTarget);
    if (realRelative !== '' && (realRelative.startsWith('..') || path.isAbsolute(realRelative))) return null;
    return realTarget;
  } catch {
    // 不存在的目标交给 sendFile 返回 404；已存在的 symlink 一定会在上面的 realpath 检查中被拦截。
    return target;
  }
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
const sendJson = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
function sendFile(res, abs, cacheControl = 'no-store', extraHeaders = {}) {
  fs.readFile(abs, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mimeOf(abs), 'Cache-Control': cacheControl, ...extraHeaders });
    res.end(buf);
  });
}

// 桌面页的内容安全策略(与 static/desktop.html 里的 meta 保持一致):
// 文档夹带的脚本一律不执行;脚本只能来自本机服务的静态文件;页面只能连回本机服务。
const DESKTOP_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:", "font-src 'self' data:", "connect-src 'self'",
  "media-src 'self' data: blob:", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

// 文档资源(图片、附件)的访问边界:只提供文档所在目录树、用户主目录、系统临时目录之内的文件,
// 且主目录与临时目录下不进入任何以 . 开头的隐藏目录(.ssh、.draftback、.git 等);
// 文档自己就住在隐藏目录里时,它所在的目录树照常可用。
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function hasHiddenSegment(root, target) {
  return path.relative(root, target).split(path.sep).some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}
function resolveDocumentAsset(reviewAbsPath, candidate) {
  const documentDir = path.dirname(reviewAbsPath);
  const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(documentDir, candidate);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { return null; }
  const roots = [documentDir, os.homedir(), os.tmpdir()].map((root) => {
    try { return fs.realpathSync(root); } catch { return root; }
  });
  if (isInside(roots[0], real)) return real;
  for (const root of roots.slice(1)) {
    if (isInside(root, real) && !hasHiddenSegment(root, real)) return real;
  }
  return null;
}
// 请求体上限 32 MB(内嵌 base64 截图的讲稿动辄几 MB;超限后边读边丢,内存有界)。
// 必须把所有 Buffer 拼完再按 UTF-8 解码:逐块 toString 会把跨块的多字节字符(汉字 3 字节)
// 解码成 U+FFFD,0.6.3 及之前保存超过 64 KB 的中文文档会因此写坏字符。
const BODY_LIMIT_BYTES = 32 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (tooLarge) return;
      if (bytes > BODY_LIMIT_BYTES) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('error', fail);
    req.on('end', () => {
      if (settled) return;
      if (tooLarge) {
        return fail(new store.ReviewStoreError('BODY_TOO_LARGE', '内容超过 32 MB，回稿暂不支持这么大的文档。', { httpStatus: 413 }));
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        settled = true;
        resolve(parsed);
      } catch {
        fail(new store.ReviewStoreError('MALFORMED_BODY', '请求体不是有效 JSON。', { httpStatus: 400 }));
      }
    });
  });
}
function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
// Host 头也要是本机:防 DNS 重绑定(恶意域名解析到 127.0.0.1 后,浏览器带着该域名的 Host 访问本地服务)
function isLocalHostHeader(req) {
  const host = req.headers.host;
  if (!host) return true; // 极少数不带 Host 的本机命令行客户端
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}
function localOnly(req, res) {
  if (isLoopback(req) && isLocalHostHeader(req)) return true;
  sendJson(res, 404, { error: 'not_found', message: 'Not found' });
  return false;
}
function localAppOriginOnly(req, res) {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 404, { error: 'not_found', message: 'Not found' });
    return false;
  }
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') {
      return true;
    }
  } catch {}
  sendJson(res, 404, { error: 'not_found', message: 'Not found' });
  return false;
}
function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
  return false;
}

function errorName(error) {
  if (error && error.code === 'SOURCE_CONFLICT') return 'source_changed';
  if (error && error.code === 'REVIEW_READ_ONLY') return 'review_read_only';
  return String((error && error.code) || 'internal_error').toLowerCase();
}
function sendError(res, error) {
  const status = Number.isInteger(error && error.httpStatus) ? error.httpStatus : 500;
  const payload = {
    error: errorName(error),
    message: (error && error.message) || '服务器内部错误。',
  };
  if (error && error.details !== undefined) payload.details = error.details;
  return sendJson(res, status, payload);
}
function reviewReadOnly(review) {
  return new store.ReviewStoreError('REVIEW_READ_ONLY',
    `审阅会话当前为 ${review ? review.status : 'unknown'}，只有 reviewing 状态可以修改批注。`, {
      httpStatus: 423, details: review ? { review } : undefined,
    });
}
function annotationCounts(data) {
  return data.annotations.reduce((counts, annotation) => {
    const status = annotation.status || 'open';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}
async function reviewSummary(review) {
  const data = store.readAnnotations(review.absPath);
  return {
    ...presence.withAgentState(review),
    sessionId: review.id,
    sourceFile: review.absPath,
    title: path.basename(review.absPath),
    directory: path.dirname(review.absPath),
    counts: annotationCounts(data),
    // 交出后只数本轮成员(规则⑤第 7.1 节);批注中按整份旁注文件数
    openCount: review.status === 'reviewing'
      ? data.annotations.filter((annotation) => store.annotationStatus(annotation) === 'open').length
      : store.countOpenForReview(review),
  };
}

function normalizedEventReason(value, fallback = 'review-changed') {
  const reason = typeof value === 'string' ? value.trim() : '';
  return (reason || fallback).slice(0, 120);
}

function reviewEventPayload(review, reason) {
  return {
    reviewSessionId: review.id,
    reason: normalizedEventReason(reason),
    at: new Date().toISOString(),
    status: review.status,
    sourceFile: review.absPath,
    applyMode: review.applyMode || null,
    sourceRevision: Number(review.sourceRevision || 0),
    workingHash: review.workingHash || review.sourceHash || null,
    finalHash: review.finalHash || null,
    completedAt: review.completedAt || null,
    agentState: presence.agentStateFor(review, presence.describe(review.id)),
  };
}

async function publishReviewChanged(reviewSessionId, reason) {
  // External notifiers are hints only.  Never trust their claimed status or
  // hashes: reread the persisted review before constructing the event.
  const review = await store.getReviewById(reviewSessionId);
  if (!review) {
    throw new store.ReviewStoreError('REVIEW_NOT_FOUND', `找不到审阅会话: ${reviewSessionId || ''}`, {
      httpStatus: 404, details: { ref: reviewSessionId || null },
    });
  }
  const event = reviewEventPayload(review, reason);
  const delivered = reviewEvents.broadcast('review-changed', event);
  return { review, event, delivered };
}

async function publishReviewChangedSafe(reviewSessionId, reason) {
  try {
    return await publishReviewChanged(reviewSessionId, reason);
  } catch (error) {
    console.error(`审阅状态已更新，但主动通知失败: ${error.message || error}`);
    return null;
  }
}
async function requireReview(ref) {
  const review = ref ? await store.getReviewById(ref) : null;
  if (!review) {
    throw new store.ReviewStoreError('REVIEW_NOT_FOUND', `找不到审阅会话: ${ref || ''}`, { httpStatus: 404 });
  }
  return review;
}
// 删除批注可撤销(UI 方案 3.4):删掉的批注在这里留一会儿,撤销时原样放回(同一个 id、同一个位置)。
// 只在这一轮仍是「批注中」时能放回;交出之后本轮成员已固定,不再改动。服务重启后撤销失效。
const DELETED_NOTE_TTL_MS = 60_000;
const deletedNotes = new Map(); // `${reviewId}:${noteId}` → { note, index, at }
function rememberDeletedNote(reviewId, note, index) {
  const now = Date.now();
  for (const [key, entry] of deletedNotes) if (now - entry.at > DELETED_NOTE_TTL_MS) deletedNotes.delete(key);
  if (deletedNotes.size > 200) deletedNotes.delete(deletedNotes.keys().next().value);
  deletedNotes.set(`${reviewId}:${note.id}`, { note: JSON.parse(JSON.stringify(note)), index, at: now });
}
async function restoreDeletedNote(review, noteId) {
  const key = `${review.id}:${noteId}`;
  const entry = deletedNotes.get(key);
  if (!entry || Date.now() - entry.at > DELETED_NOTE_TTL_MS) {
    deletedNotes.delete(key);
    throw new store.ReviewStoreError('UNDO_EXPIRED', '撤销已过期,这条批注没有放回。', { httpStatus: 410 });
  }
  return store.withReviewTransaction(review.absPath, async () => {
    const writable = await requireWritableReview(review.id);
    const restored = await mutateReviewAnnotations(writable, (data) => {
      if (data.annotations.some((item) => item.id === noteId)) return data.annotations.find((item) => item.id === noteId);
      const at = Math.max(0, Math.min(entry.index, data.annotations.length));
      data.annotations.splice(at, 0, entry.note);
      return entry.note;
    });
    deletedNotes.delete(key);
    return restored;
  });
}

// ---------- 冲突处理(UI 方案 3.3):「文件在外面被改了」只给两条路 ----------

// 一、以磁盘上的版本重新开始:这一轮作废(批注留在历史里),之后划词按磁盘上的正文开新一轮
async function restartFromDisk(ref) {
  const review = await documents.requireReview(ref);
  if (review.status !== 'conflict') {
    throw new store.ReviewStoreError('NOT_CONFLICT', '只有「文件在外面被改了」时才需要这样处理。', { httpStatus: 409 });
  }
  return store.unlockReview(review.absPath, '原文在别处被改过:以磁盘上的版本重新开始');
}

// 二、另存我的版本:把这一轮冻结时的原稿存成新文件(新文档身份),本轮未处理的批注跟着带过去,原文件这一轮作废
async function forkConflictRound(ref, targetPath) {
  const review = await documents.requireReview(ref);
  if (review.status !== 'conflict') {
    throw new store.ReviewStoreError('NOT_CONFLICT', '只有「文件在外面被改了」时才能另存当时的版本。', { httpStatus: 409 });
  }
  if (!review.docId || !review.versionId) {
    throw new store.ReviewStoreError('VERSION_MISSING', '这一轮没有留底,没法另存冻结时的版本。', { httpStatus: 409 });
  }
  const original = versionStore.readVersion(review.docId, review.versionId, 'original');
  if (!original.available) {
    throw new store.ReviewStoreError('VERSION_UNAVAILABLE', '这一轮的原稿留底不可用,没法另存。', { httpStatus: 409 });
  }
  const { decodeText } = require('./lib/text-encoding');
  const content = decodeText(original.buffer).content;
  const copy = await plainDocuments.saveDocumentCopy(targetPath, { content, sourcePath: review.absPath });
  const copyPath = copy.document.absPath;
  const notes = store.readAnnotations(review.absPath).annotations
    .filter((note) => (note.status || 'open') === 'open' && (!note.reviewSessionId || note.reviewSessionId === review.id));
  const opened = await store.openReview(copyPath);
  const carried = [];
  if (notes.length) {
    await store.mutateAnnotations(copyPath, (data) => {
      for (const note of notes) {
        const next = {};
        for (const field of NOTE_FIELDS) if (note[field] !== undefined && field !== 'clientRequestId') next[field] = note[field];
        const created = {
          ...next, id: newNoteId(), createdAt: note.createdAt || new Date().toISOString(), author: note.author || '我(本机)', status: 'open',
          reviewSessionId: opened.review.id, sourceHash: opened.review.sourceHash,
          forkedFrom: { path: review.absPath, reviewId: review.id, noteId: note.id },
        };
        data.annotations.push(created);
        carried.push(created.id);
      }
    });
  }
  await store.unlockReview(review.absPath, `已另存为副本「${path.basename(copyPath)}」,这一轮在原文件上作废`);
  return { ok: true, reviewId: opened.review.id, absPath: copyPath, carried: carried.length };
}

async function requireWritableReview(ref) {
  let review = await requireReview(ref);
  if (review.status !== 'reviewing') throw reviewReadOnly(review);
  review = await store.assertReviewUnchanged(review.id);
  if (review.status !== 'reviewing') throw reviewReadOnly(review);
  return review;
}
async function mutateReviewAnnotations(review, mutator) {
  try {
    return await store.mutateAnnotations(review.absPath, (data) => {
      if (store.sha256File(review.absPath) !== review.sourceHash) {
        throw new store.ReviewStoreError('SOURCE_CONFLICT',
          '源文档在审阅期间已发生变化，已停止保存。', { httpStatus: 409 });
      }
      return mutator(data);
    });
  } catch (error) {
    if (error && error.code === 'SOURCE_CONFLICT') {
      await store.markConflict(review.id, '保存批注时检测到源文档变化').catch(() => {});
      await publishReviewChangedSafe(review.id, 'review-conflict');
    }
    throw error;
  }
}
function newNoteId() { return 'n' + crypto.randomBytes(6).toString('hex'); }
const NOTE_FIELDS = [
  'comment', 'quote', 'prefix', 'suffix', 'headingPath', 'lineStart', 'lineEnd',
  'startTextOffset', 'endTextOffset', 'figureRef', 'clientRequestId', 'anchorVersion', 'scope',
];
function buildNote(input, author, extra = {}) {
  const note = {};
  for (const field of NOTE_FIELDS) {
    if (input[field] === undefined || (field !== 'comment' && input[field] === null)) continue;
    if (field === 'headingPath') {
      if (Array.isArray(input.headingPath)) {
        note.headingPath = input.headingPath
          .filter((item) => item !== null && item !== undefined)
          .slice(0, 12)
          .map((item) => String(item).slice(0, 200));
      }
    } else if (field === 'scope') {
      // 目前唯一合法取值:document(针对全篇的总体意见,无文字锚点)。
      if (input.scope === 'document') note.scope = 'document';
    } else if (field === 'lineStart' || field === 'lineEnd' || field === 'startTextOffset' ||
        field === 'endTextOffset' || field === 'anchorVersion') {
      const value = Number(input[field]);
      note[field] = Number.isFinite(value) ? value : null;
    } else {
      const limits = { comment: 20000, quote: 20000, prefix: 500, suffix: 500, figureRef: 200, clientRequestId: 120 };
      note[field] = String(input[field]).slice(0, limits[field] || 1000);
    }
  }
  return {
    ...note,
    id: newNoteId(),
    createdAt: new Date().toISOString(),
    author: String(author || '匿名').slice(0, 40),
    status: 'open',
    ...extra,
  };
}
function hasOwn(object, key) {
  return !!object && typeof object === 'object' && !Array.isArray(object) &&
    Object.prototype.hasOwnProperty.call(object, key);
}
function editedComment(body) {
  if (!hasOwn(body, 'comment') || typeof body.comment !== 'string' || !body.comment.trim()) return null;
  return body.comment.trim().slice(0, 20000);
}
function applyCommentEdit(annotation, comment, actor) {
  annotation.comment = comment;
  annotation.updatedAt = new Date().toISOString();
  annotation.updatedBy = String(actor || '审阅者').slice(0, 80);
  const previousCount = Number(annotation.editCount);
  annotation.editCount = Number.isInteger(previousCount) && previousCount >= 0 ? previousCount + 1 : 1;
  return annotation;
}
async function handleReviewAnnotations(req, res, q, review) {
  const absMd = review.absPath;
  if (req.method === 'GET') return sendJson(res, 200, store.readAnnotations(absMd));

  if (req.method === 'POST') {
    const note = await readBody(req);
    if (!note || typeof note !== 'object' || !String(note.comment || '').trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '批注内容不能为空。' });
    }
    const requestId = note.clientRequestId ? String(note.clientRequestId).slice(0, 120) : null;
    const result = await store.withReviewTransaction(absMd, async () => {
      const writable = await requireWritableReview(review.id);
      return mutateReviewAnnotations(writable, (data) => {
        if (requestId) {
          const existing = data.annotations.find((item) =>
            item.reviewSessionId === writable.id && item.clientRequestId === requestId);
          if (existing) return { note: existing, reused: true };
        }
        const created = buildNote(note, note.author || '我(本机)', {
          reviewSessionId: writable.id,
          sourceHash: writable.sourceHash,
        });
        if (!requestId) delete created.clientRequestId;
        data.annotations.push(created);
        return { note: created, reused: false };
      });
    });
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (req.method === 'PATCH') {
    const id = q.get('id');
    const body = await readBody(req);
    const isCommentEdit = hasOwn(body, 'comment');
    const comment = isCommentEdit ? editedComment(body) : null;
    // 审阅人只能把自己误操作改回 open；applied/wontfix 由 Agent 写 sidecar。
    if (!id || !body || typeof body !== 'object' || Array.isArray(body) ||
        (isCommentEdit ? !comment || hasOwn(body, 'status') : body.status !== 'open')) {
      const message = isCommentEdit ? '批注内容不能为空，且不能同时修改状态。' : '本地审阅页不能把批注标为已处理。';
      return sendJson(res, 400, { error: 'bad_request', message });
    }
    let found = false;
    let immutable = false;
    let updatedNote = null;
    await store.withReviewTransaction(absMd, async () => {
      const writable = await requireWritableReview(review.id);
      await mutateReviewAnnotations(writable, (data) => {
        const annotation = data.annotations.find((item) => item.id === id);
        if (annotation) {
          found = true;
          if (isCommentEdit) {
            if (annotation.status !== 'open') { immutable = true; return; }
            updatedNote = applyCommentEdit(annotation, comment, '我(本机)');
          } else {
            annotation.status = 'open';
            delete annotation.appliedAt;
            delete annotation.appliedBy;
            delete annotation.appliedNote;
          }
        }
      });
    });
    if (immutable) return sendJson(res, 409, { error: 'annotation_read_only', message: '已处理批注不能编辑。' });
    if (!found) return sendJson(res, 404, { error: 'annotation_not_found', message: '找不到批注。' });
    return sendJson(res, 200, isCommentEdit ? { ok: true, note: updatedNote } : { ok: true });
  }
  if (req.method === 'DELETE') {
    const id = q.get('id');
    if (!id) return sendJson(res, 400, { error: 'bad_request', message: '缺少批注 id。' });
    let found = false;
    let immutable = false;
    await store.withReviewTransaction(absMd, async () => {
      const writable = await requireWritableReview(review.id);
      await mutateReviewAnnotations(writable, (data) => {
        const annotation = data.annotations.find((item) => item.id === id);
        if (!annotation) return;
        if (annotation.status !== 'open') { immutable = true; return; }
        const index = data.annotations.indexOf(annotation);
        data.annotations = data.annotations.filter((item) => item.id !== id);
        rememberDeletedNote(writable.id, annotation, index);
        found = true;
      });
    });
    if (immutable) return sendJson(res, 409, { error: 'annotation_read_only', message: '已处理批注不能由审阅页删除。' });
    if (!found) return sendJson(res, 404, { error: 'annotation_not_found', message: '找不到批注。' });
    return sendJson(res, 200, { ok: true, undoable: true, undoSeconds: DELETED_NOTE_TTL_MS / 1000 });
  }
  return sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
}

// 跨端同步(跨端规则第 12 节):随 App 打包的原生辅助程序 Draftback Sync.app 通过这些接口取待推送项、
// 报推送结果、送来手机批次、报回执已发;云端(CloudKit)的读写都在辅助程序里,这里只管会话上的同步状态。
async function handleSyncApi(req, res, pathname, q) {
  if (pathname === '/api/app/sync/outbox') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendJson(res, 200, { items: await sync.listOutbox(), helper: sync.readHelperState() });
  }
  if (pathname === '/api/app/sync/status') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendJson(res, 200, { helper: sync.readHelperState(), reviews: await sync.listSyncStatus() });
  }
  if (pathname === '/api/app/sync/document') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendJson(res, 200, await sync.readPushPayload(q.get('r')));
  }
  if (!allowMethods(req, res, ['POST'])) return;
  const body = await readBody(req);
  if (pathname === '/api/app/sync/pushed') {
    const review = await sync.markPushed(body.reviewId, body);
    await publishReviewChangedSafe(review.id, 'sync-pushed');
    return sendJson(res, 200, { ok: true, sync: review.sync });
  }
  if (pathname === '/api/app/sync/superseded') {
    if (!body || typeof body.reviewId !== 'string') return sendJson(res, 400, { error: 'bad_request', message: '缺少 reviewId。' });
    return sendJson(res, 200, { ok: true, review: await sync.markPushSuperseded(body.reviewId, body.cloudRevision, body.signature) });
  }
  if (pathname === '/api/app/sync/error') {
    const review = await sync.markPushError(body.reviewId, body.error);
    return sendJson(res, 200, { ok: true, sync: review.sync });
  }
  if (pathname === '/api/app/sync/heartbeat') {
    return sendJson(res, 200, { ok: true, helper: await sync.writeHelperState(body || {}) });
  }
  if (pathname === '/api/app/sync/batch') {
    if (!body || typeof body.batch !== 'object' || !body.batch) {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供批次内容。' });
    }
    const result = await batches.importBatch(body.batch);
    if (result.review) {
      await sync.markBatchReceived(result.review.id, result.receipt);
      await publishReviewChangedSafe(result.review.id, 'batch-imported');
    }
    return sendJson(res, 200, result);
  }
  if (pathname === '/api/app/sync/reset') {
    if (!allowMethods(req, res, ['POST'])) return;
    return sendJson(res, 200, await sync.requestPushAll());
  }
  if (pathname === '/api/app/sync/receipt-sent') {
    if (!body.reviewId) return sendJson(res, 400, { error: 'bad_request', message: '缺少 reviewId。' });
    const review = await sync.markReceiptSent(body.reviewId, body.batchId);
    return sendJson(res, 200, { ok: true, sync: review.sync });
  }
  return sendJson(res, 404, { error: 'not_found', message: 'Not found' });
}

async function handleLocalReviewApi(req, res, pathname, q) {
  if (pathname === '/api/health') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendJson(res, 200, { ok: true, service: 'draftback-service', port: activePort });
  }
  if (pathname === '/api/reviews') {
    if (!allowMethods(req, res, ['GET'])) return;
    const reviews = await store.listReviews();
    const summaries = [];
    const seenPaths = new Set();
    for (const review of reviews) {
      if (seenPaths.has(review.absPath)) continue;
      seenPaths.add(review.absPath);
      try {
        summaries.push(await reviewSummary(review));
      } catch (error) {
        summaries.push({
          ...review,
          sessionId: review.id,
          sourceFile: review.absPath,
          title: path.basename(review.absPath),
          directory: path.dirname(review.absPath),
          counts: {},
          openCount: null,
          summaryError: {
            code: String(error.code || 'ANNOTATIONS_READ_FAILED').toLowerCase(),
            message: error.message || '批注数据读取失败。',
          },
        });
      }
    }
    return sendJson(res, 200, { reviews: summaries });
  }

  const ref = q.get('r');
  const review = await requireReview(ref);
  if (pathname === '/api/review/submit') {
    if (!allowMethods(req, res, ['POST'])) return;
    let result;
    try {
      result = await store.submitReview(review.id);
    } catch (error) {
      if (error && error.code === 'SOURCE_CONFLICT') await publishReviewChangedSafe(review.id, 'review-conflict');
      throw error;
    }
    await publishReviewChangedSafe(result.review.id,
      result.review.status === 'complete' ? 'review-approved' : 'review-submitted');
    return sendJson(res, 200, { ok: true, review: await reviewSummary(result.review) });
  }
  if (pathname === '/api/annotations') return handleReviewAnnotations(req, res, q, review);
  return sendJson(res, 404, { error: 'not_found', message: 'Not found' });
}

async function handleAppApi(req, res, pathname, q) {
  if (pathname === '/api/app/events') {
    if (!allowMethods(req, res, ['GET'])) return;
    reviewEvents.subscribe(req, res);
    return;
  }
  if (pathname === '/api/app/review/notify') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        typeof body.reviewSessionId !== 'string' || !body.reviewSessionId.trim() ||
        typeof body.reason !== 'string' || !body.reason.trim()) {
      return sendJson(res, 400, {
        error: 'bad_request', message: 'reviewSessionId 和 reason 必须是非空字符串。',
      });
    }
    const published = await publishReviewChanged(
      body.reviewSessionId.trim().slice(0, 200),
      body.reason,
    );
    return sendJson(res, 200, {
      ok: true,
      delivered: published.delivered,
      event: published.event,
    });
  }
  // 智能体监听登记(规划 v3 规则②):登记只说明"有程序在听",不是领取。CLI 直接写 listeners.json,
  // 这两条路由给没有数据目录直写权限的调用方用,并顺带广播事件让页面立刻刷新状态区。
  if (pathname === '/api/app/review/listen' || pathname === '/api/app/review/unlisten') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.reviewSessionId !== 'string' || !body.reviewSessionId.trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: 'reviewSessionId 必须是非空字符串。' });
    }
    const reviewSessionId = body.reviewSessionId.trim().slice(0, 200);
    const review = await store.getReviewById(reviewSessionId);
    if (!review) return sendJson(res, 404, { error: 'review_not_found', message: `找不到审阅会话: ${reviewSessionId}` });
    let entry = null;
    let reason = 'agent-left';
    if (pathname === '/api/app/review/unlisten') {
      await presence.unregister(review.id);
    } else if (body.handoff === true) {
      entry = await presence.handoff(review.id, { agent: body.agent, minutes: body.minutes });
      reason = 'agent-handoff';
    } else {
      entry = await presence.register(review.id, { agent: body.agent });
      reason = 'agent-listening';
    }
    await publishReviewChangedSafe(review.id, reason);
    return sendJson(res, 200, { ok: true, entry, agent: presence.describe(review.id) });
  }
  // 轮次版本记录(规则⑤第 11 节):按 docId / versionId 寻址,不依赖会话是否还在
  if (pathname === '/api/app/document/versions') {
    if (!allowMethods(req, res, ['GET'])) return;
    const docId = q.get('docId');
    if (!docId) return sendJson(res, 400, { error: 'bad_request', message: '缺少 docId。' });
    const includeAnnotations = q.get('detail') === '1';
    return sendJson(res, 200, { document: versionStore.getDocument(docId), versions: versionStore.listVersions(docId, { includeAnnotations }) });
  }
  if (pathname === '/api/app/version') {
    if (!allowMethods(req, res, ['GET'])) return;
    const docId = q.get('docId');
    const versionId = q.get('versionId');
    const which = q.get('which') || 'final';
    if (!docId || !versionId) return sendJson(res, 400, { error: 'bad_request', message: '缺少 docId 或 versionId。' });
    const result = versionStore.readVersion(docId, versionId, which);
    if (!result.available) return sendJson(res, 200, { available: false, reason: result.reason });
    return sendJson(res, 200, { available: true, hash: result.hash, bytes: result.bytes, content: result.buffer.toString('utf8'), meta: result.meta });
  }
  if (pathname === '/api/app/document/restore') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body.docId !== 'string' || typeof body.toVersionId !== 'string') {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供 docId 与 toVersionId。' });
    }
    const result = await versionStore.restoreTo(body);
    await publishReviewChangedSafe(result.reviewId, 'review-restored');
    return sendJson(res, 200, result);
  }
  if (pathname === '/api/app/document/archive-retry') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body.docId !== 'string' || typeof body.versionId !== 'string') {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供 docId 与 versionId。' });
    }
    const meta = await versionStore.publish(body.docId, body.versionId);
    return sendJson(res, 200, { ok: true, state: meta.state });
  }
  // 规则③:首次成功保存一条批注才算开轮。开轮与存第一条批注合成一步:批注没存成就撤掉刚建的轮,不留空轮。
  if (pathname === '/api/app/review/open-annotate') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body.path !== 'string' || !body.path.trim() || !body.note || typeof body.note !== 'object' || !String(body.note.comment || '').trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供 path 与非空的 note。' });
    }
    const opened = await store.openReview(body.path);
    const absMd = opened.review.absPath;
    const requestId = body.note.clientRequestId ? String(body.note.clientRequestId).slice(0, 120) : null;
    let saved;
    try {
      saved = await store.withReviewTransaction(absMd, async () => {
        const writable = await requireWritableReview(opened.review.id);
        return mutateReviewAnnotations(writable, (data) => {
          if (requestId) {
            const existing = data.annotations.find((item) => item.reviewSessionId === writable.id && item.clientRequestId === requestId);
            if (existing) return { note: existing, reused: true };
          }
          const created = buildNote(body.note, body.note.author || '我(本机)', { reviewSessionId: writable.id, sourceHash: writable.sourceHash });
          if (!requestId) delete created.clientRequestId;
          data.annotations.push(created);
          return { note: created, reused: false };
        });
      });
    } catch (error) {
      if (!opened.reused) await store.discardFreshReview(opened.review.id).catch(() => false);
      throw error;
    }
    await publishReviewChangedSafe(opened.review.id, opened.reused ? 'review-reopened' : 'review-opened');
    return sendJson(res, 200, { ok: true, reused: opened.reused, review: await reviewSummary(opened.review), note: saved.note, noteReused: saved.reused });
  }
  if (pathname === '/api/app/open') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.path !== 'string' || !body.path.trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供 Markdown 文档路径。' });
    }
    const opened = await store.openReview(body.path);
    await publishReviewChangedSafe(opened.review.id, opened.reused ? 'review-reopened' : 'review-opened');
    return sendJson(res, 200, {
      ok: true,
      reused: opened.reused,
      review: await reviewSummary(opened.review),
    });
  }

  // ---- 普通文档(不建审阅会话)----
  if (pathname === '/api/app/document/open') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body.path !== 'string' || !body.path.trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供 Markdown 文档路径。' });
    }
    return sendJson(res, 200, await plainDocuments.readDocument(body.path));
  }
  // 帮助(帮助 › 回稿使用说明 / 给 AI 的说明):随包的说明复制到数据目录再按普通文档打开,批注不会写进 App 包里
  if (pathname === '/api/app/help/open') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    const names = { guide: '回稿使用说明.md', ai: '给 AI 的说明.md' };
    const name = body && names[body.name];
    if (!name) return sendJson(res, 400, { error: 'bad_request', message: '没有这份说明。' });
    const source = path.join(STATIC_DIR, 'help', name);
    const dir = path.join(store.getDataDir(), 'help');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);
    const fresh = fs.readFileSync(source);
    // 随版本更新说明;用户在这份上的批注(旁注)不受影响
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(fresh)) {
      const active = await store.getReviewByPath(target, { activeOnly: true }).catch(() => null);
      if (!active) fs.writeFileSync(target, fresh);
    }
    return sendJson(res, 200, { ok: true, path: fs.realpathSync(target) });
  }
  // 图片落盘:编辑器里粘贴、拖入、上传的图片存到文档旁的 images/,返回相对路径
  if (pathname === '/api/app/document/image') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body.path !== 'string' || !body.path.trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供 Markdown 文档路径。' });
    }
    return sendJson(res, 200, await plainDocuments.saveDocumentImage(body.path, body));
  }
  // 另存为副本:新文件、新文档身份;不复制旁注
  if (pathname === '/api/app/document/copy') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body.path !== 'string' || !body.path.trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供副本的保存路径。' });
    }
    return sendJson(res, 200, await plainDocuments.saveDocumentCopy(body.path, body));
  }
  if (pathname === '/api/app/document/create') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body.path !== 'string' || !body.path.trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供要新建的 Markdown 文档路径。' });
    }
    return sendJson(res, 201, await plainDocuments.createDocument(body.path, { content: body.content }));
  }
  if (pathname === '/api/app/document') {
    if (req.method === 'GET') {
      const candidate = q.get('path');
      if (!candidate) return sendJson(res, 400, { error: 'bad_request', message: '缺少 path。' });
      return sendJson(res, 200, await plainDocuments.readDocument(candidate, { touch: false }));
    }
    if (!allowMethods(req, res, ['GET', 'PUT'])) return;
    const body = await readBody(req);
    if (!body || typeof body.path !== 'string' || !body.path.trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供 Markdown 文档路径。' });
    }
    return sendJson(res, 200, await plainDocuments.writeDocument(body.path, body));
  }
  if (pathname === '/api/app/document/editing') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body.path !== 'string' || !body.path.trim() || typeof body.editing !== 'boolean') {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供 path 与 editing(布尔)。' });
    }
    return sendJson(res, 200, await plainDocuments.setEditing(body.path, body.editing, { token: body.token }));
  }
  if (pathname === '/api/app/batch/import') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    // 拖进窗口的批次由页面读出内容直接提交(隔空投送落在「下载」,那里受系统访问保护,
    // 拖放本身就是用户授权,不必再让服务按路径去读);命令行和旧调用方仍可只给路径。
    let result;
    // 拖进窗口 / 文件导入的批次没有轮次身份时,只能显式转为当前文档本轮的新批注(跨端规则 v2.3 第 2.2 节);
    // 页面把当前标签的文档路径带上,拖放本身就是"转进这篇"的明确意图
    const documentPath = body && typeof body.documentPath === 'string' && body.documentPath.trim() ? body.documentPath : null;
    const asNewNotes = Boolean(body && (body.asNewNotes === true || (documentPath && body.batch && batches.identityProblem(batches.validateBatch(body.batch)))));
    if (body && body.batch && typeof body.batch === 'object' && !Array.isArray(body.batch)) {
      result = await batches.importBatch(body.batch, { documentPath, asNewNotes });
    } else if (body && typeof body.path === 'string' && body.path.trim()) {
      result = await batches.importBatchFile(body.path, { documentPath, asNewNotes });
    } else {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供批次内容或批次文件路径。' });
    }
    if (result.review) await publishReviewChangedSafe(result.review.id, 'batch-imported');
    return sendJson(res, 200, result);
  }
  if (pathname === '/api/app/recent') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendJson(res, 200, { items: await plainDocuments.listRecent() });
  }
  if (pathname.startsWith('/api/app/sync/')) return handleSyncApi(req, res, pathname, q);

  const ref = q.get('r');
  // /api/app/file 可以不带会话:普通打开的文档按 d=<文档路径> 取旁边的图片与附件
  if (!ref && pathname !== '/api/app/file') return sendJson(res, 400, { error: 'bad_request', message: '缺少审阅会话 r。' });

  if (pathname === '/api/app/bundle') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendJson(res, 200, await documents.readBundle(ref));
  }
  if (pathname === '/api/app/file') {
    if (!allowMethods(req, res, ['GET'])) return;
    // 审阅标签用 r=<会话 id>;普通打开的文档没有会话,用 d=<文档绝对路径>(必须是已存在的 .md)
    const documentPath = q.get('d');
    const baseAbsPath = ref ? (await documents.requireReview(ref)).absPath
      : documentPath ? store.normalizeMdPath(documentPath) : null;
    if (!baseAbsPath) return sendJson(res, 400, { error: 'bad_request', message: '缺少 r 或 d。' });
    let candidate = String(q.get('path') || '');
    try { candidate = decodeURIComponent(candidate); } catch {}
    const abs = resolveDocumentAsset(baseAbsPath, candidate);
    if (!abs) return send(res, 404, 'Not found');
    return sendFile(res, abs, 'private, no-store');
  }
  if (pathname === '/api/app/review/begin-apply') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.mode !== 'manual') {
      return sendJson(res, 400, { error: 'bad_request', message: 'mode 必须是 manual。' });
    }
    const existing = await documents.requireReview(ref);
    let review;
    try {
      review = await store.beginApply(existing.absPath, {
        applyMode: 'manual',
        applyActor: '我(本机)',
        expectedReviewId: ref,
      });
    } catch (error) {
      if (error && error.code === 'SOURCE_CONFLICT') await publishReviewChangedSafe(ref, 'review-conflict');
      throw error;
    }
    await publishReviewChangedSafe(review.id, 'manual-apply-started');
    return sendJson(res, 200, { ok: true, review: await reviewSummary(review) });
  }
  if (pathname === '/api/app/source') {
    if (!allowMethods(req, res, ['PUT'])) return;
    const body = await readBody(req);
    const result = await documents.writeSource(ref, body);
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (pathname === '/api/app/review/restart-from-disk') {
    if (!allowMethods(req, res, ['POST'])) return;
    const review = await restartFromDisk(ref);
    await publishReviewChangedSafe(review.id, 'conflict-restarted');
    return sendJson(res, 200, { ok: true, review });
  }
  if (pathname === '/api/app/review/fork') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body.path !== 'string' || !body.path.trim()) return sendJson(res, 400, { error: 'bad_request', message: '请提供副本的保存路径。' });
    const result = await forkConflictRound(ref, body.path);
    await publishReviewChangedSafe(ref, 'conflict-forked');
    return sendJson(res, 200, result);
  }
  if (pathname === '/api/app/annotation/restore') {
    if (!allowMethods(req, res, ['POST'])) return;
    const noteId = q.get('id');
    if (!noteId) return sendJson(res, 400, { error: 'bad_request', message: '缺少批注 id。' });
    const review = await documents.requireReview(ref);
    const note = await restoreDeletedNote(review, noteId);
    await publishReviewChangedSafe(review.id, 'annotation-restored');
    return sendJson(res, 200, { ok: true, note });
  }
  if (pathname === '/api/app/annotation') {
    if (!allowMethods(req, res, ['PATCH'])) return;
    const body = await readBody(req);
    const result = await documents.patchAnnotation(ref, q.get('id'), body);
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (pathname === '/api/app/review/claim') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = (await readBody(req)) || {};
    const existing = await documents.requireReview(ref);
    const review = await store.claimReview(existing.absPath, { agent: body.agent, expectedReviewId: ref });
    await publishReviewChangedSafe(review.id, 'agent-claimed');
    return sendJson(res, 200, { ok: true, review: await reviewSummary(review) });
  }
  if (pathname === '/api/app/review/finalize') {
    if (!allowMethods(req, res, ['POST'])) return;
    const review = await store.finalizeReview(ref);
    await publishReviewChangedSafe(review.id, 'review-finalized');
    return sendJson(res, 200, { ok: true, review: await reviewSummary(review) });
  }
  if (pathname === '/api/app/review/manual-edit') {
    if (!allowMethods(req, res, ['POST'])) return;
    const existing = await documents.requireReview(ref);
    const review = await store.beginManualEdit(existing.absPath, { applyActor: '我(本机)' });
    await publishReviewChangedSafe(review.id, 'manual-edit-started');
    return sendJson(res, 200, { ok: true, review: await reviewSummary(review) });
  }
  if (pathname === '/api/app/review/complete') {
    if (!allowMethods(req, res, ['POST'])) return;
    const existing = await documents.requireReview(ref);
    const review = await store.completeReview(existing.absPath, {
      expectedApplyMode: 'manual',
      expectedReviewId: ref,
    });
    await publishReviewChangedSafe(review.id, 'manual-complete');
    return sendJson(res, 200, { ok: true, review: await reviewSummary(review) });
  }
  return sendJson(res, 404, { error: 'not_found', message: 'Not found' });
}

async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); } catch {
    throw new store.ReviewStoreError('MALFORMED_URL', '请求 URL 编码无效。', { httpStatus: 400 });
  }
  const q = u.searchParams;

  if (pathname.startsWith('/static/')) {
    if (!allowMethods(req, res, ['GET'])) return;
    const abs = safeJoin(STATIC_DIR, pathname.slice('/static/'.length));
    const cache = abs && abs.includes(`${path.sep}vendor${path.sep}`)
      ? 'public, max-age=86400, immutable'
      : 'no-store';
    return abs ? sendFile(res, abs, cache) : send(res, 403, 'Forbidden');
  }

  const localPage = pathname === '/desktop' || pathname === '/desktop/';
  const reviewApi = pathname === '/api/health' || pathname === '/api/reviews' ||
    pathname === '/api/review/submit' || pathname.startsWith('/api/app/') || !!q.get('r');
  if (localPage || reviewApi) {
    if (!localOnly(req, res)) return;
    if (localPage) {
      if (!allowMethods(req, res, ['GET'])) return;
      return sendFile(res, path.join(STATIC_DIR, 'desktop.html'), 'no-store', { 'Content-Security-Policy': DESKTOP_CSP });
    }
    // 所有审阅接口都拒绝来自其他站点的浏览器请求(浏览器里打开的网页不得代替用户提交或改批注);
    // CLI 与 App 自身的请求不带跨站来源,照常放行。
    if (!localAppOriginOnly(req, res)) return;
    if (pathname.startsWith('/api/app/')) return handleAppApi(req, res, pathname, q);
    return handleLocalReviewApi(req, res, pathname, q);
  }

  return send(res, 404, 'Not found');
}

let activePort = null;
let ownedPortInode = null;
function banner(port) {
  const line = '─'.repeat(54);
  console.log(`\n${line}\n  📖  draftback-service 已启动  ${HOST}:${port}\n${line}`);
  console.log(`  回稿: http://localhost:${port}/desktop`);
  console.log('  停止: Ctrl + C\n');
}
async function publishPort(port) {
  activePort = port;
  try {
    await store.writePort(port);
    try { ownedPortInode = fs.statSync(PATHS.port).ino; } catch { ownedPortInode = null; }
  } catch (error) {
    activePort = null;
    ownedPortInode = null;
    throw error;
  }
}
function cleanupOwnedPort() {
  if (activePort === null || ownedPortInode === null) return;
  try {
    const stat = fs.statSync(PATHS.port);
    const contents = fs.readFileSync(PATHS.port, 'utf8').trim();
    if (stat.ino === ownedPortInode && contents === String(activePort)) fs.unlinkSync(PATHS.port);
  } catch {}
  activePort = null;
  ownedPortInode = null;
}
function cleanupProcessState() {
  reviewEvents.close();
  cleanupOwnedPort();
}
process.once('exit', cleanupProcessState);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { cleanupProcessState(); process.exit(0); });
}
// 作为 App 内置服务运行时:主进程崩溃或被强退不会给我们发 SIGTERM,这里自己盯着父进程,
// 它消失就收摊;否则孤儿服务继续占着端口文件,下次启动的新 App 会复用它,看到的还是旧版代码。
const parentPid = Number(process.env.DRAFTBACK_PARENT_PID);
if (Number.isInteger(parentPid) && parentPid > 0) {
  const watchdog = setInterval(() => {
    try { process.kill(parentPid, 0); } catch (error) {
      if (error && error.code === 'ESRCH') { clearInterval(watchdog); cleanupProcessState(); process.exit(0); }
    }
  }, 5000);
  watchdog.unref();
}

(function start(port, tries) {
  store.ensureDataDir();
  // 编辑登记归本服务所有:上一次运行留下的条目一律作废。
  plainDocuments.clearEditing().catch((error) => { console.error('清理编辑登记失败:', error.message); });
  // 启动即做一份自动快照(24 小时内已有则跳过,只留最近 10 份):动真实文件前先有退路。失败只记日志,不影响服务。
  snapshot.ensureAutoSnapshot().then((result) => {
    if (result.created) console.log(`  自动快照: ${result.latest}`);
  }).catch((error) => { console.error('自动快照失败:', error.message); });
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!Number.isInteger(error && error.httpStatus) || error.httpStatus >= 500) console.error(error);
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    });
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && tries > 0) return start(port + 1, tries - 1);
    console.error('启动失败:', error.message);
    process.exit(1);
  });
  server.listen(port, HOST, async () => {
    try {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      await publishPort(actualPort);
      banner(actualPort);
      versionStore.recoverRestores().then((results) => {
        for (const item of results) console.log(`恢复事务收敛: ${item.id} → ${item.action}${item.message ? ` (${item.message})` : ''}`);
      }).catch((error) => console.error(`恢复事务收敛失败: ${error.message || error}`));
      batches.resumePendingImports().then((results) => {
        const done = results.filter((item) => item && item.receipt).length;
        if (done) console.log(`批次导入收敛: ${done} 个中途断掉的导入已补齐`);
      }).catch((error) => console.error(`批次导入收敛失败: ${error.message || error}`));
      store.pruneReviews().then((result) => {
        if (result.removed || result.cancelled) console.log(`审阅索引清理: 删除 ${result.removed} 条,取消 ${result.cancelled} 条文件已不存在的会话`);
      }).catch((error) => console.error('审阅索引清理失败:', error.message));
    } catch (error) {
      console.error('写入端口文件失败:', error.message);
      server.close(() => process.exit(1));
    }
  });
})(PORT_BASE, 10);
