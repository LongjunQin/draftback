'use strict';
/*
 * 普通文档层(路线图 v3 第一轮"阅读与审阅分离",跨端规则第 8 节三个状态维度之一)。
 *
 * - 普通阅读:打开文件只读内容,不建审阅会话、不加锁、不算指纹入库。
 * - 普通编辑:直接把修改写回文件,仍然有外部变化检测(expectedHash)、幂等(clientRequestId)、
 *   覆盖前备份与原子写入;文档处于活动审阅会话时拒绝普通写入,必须走审阅会话的手工修改流程。
 * - 编辑登记:用户在回稿里编辑某文档期间,智能体的 mdreview open 不得冻结它(review-store.openReview 会查这里)。
 *   登记文件归本地服务所有:服务启动时清空;条目带服务进程号,进程不在即视为过期。
 * - 最近文件:无论普通打开还是审阅打开,都记一笔;与审阅索引合并后供界面显示。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./review-store');
const { decodeText, readOnlyMessage } = require('./text-encoding');

const { ReviewStoreError } = store;
const DOCUMENT_BACKUP_KEEP = 10;
const RECENT_KEEP = 50;

function fail(code, message, httpStatus = 400, details) {
  throw new ReviewStoreError(code, message, { httpStatus, details });
}

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function pathKey(absPath) { return sha256(Buffer.from(absPath, 'utf8')).slice(0, 16); }
function documentId(absPath) { return `d${pathKey(absPath)}`; }

function readSource(absPath) {
  let buffer;
  let stat;
  try {
    buffer = fs.readFileSync(absPath);
    stat = fs.statSync(absPath);
  } catch (error) {
    fail('SOURCE_READ_FAILED', `无法读取文档: ${absPath}`, error.code === 'ENOENT' ? 404 : 500, { absPath });
  }
  if (!stat.isFile()) fail('INVALID_DOCUMENT', `路径不是文件: ${absPath}`, 400, { absPath });
  const decoded = decodeText(buffer);
  return { buffer, content: decoded.content, encoding: decoded.encoding, readOnly: decoded.readOnly, readOnlyReason: decoded.readOnly ? readOnlyMessage(decoded) : null,
    hash: sha256(buffer), mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, size: stat.size };
}

// ---------- 编辑登记 ----------

function editingPath(options = {}) { return path.join(store.getDataDir(options), 'editing.json'); }
const emptyEditing = () => ({ version: 1, entries: {} });

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readEditing(options = {}) {
  const data = store.readJsonStrict(editingPath(options), emptyEditing());
  if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') return emptyEditing();
  return data;
}

function liveEditingEntry(entry) {
  return !!entry && typeof entry === 'object' && processIsRunning(Number(entry.pid));
}

function isEditing(inputPath, options = {}) {
  const absPath = store.resolvePathBestEffort(inputPath);
  const entry = readEditing(options).entries[absPath];
  return liveEditingEntry(entry) ? { absPath, since: entry.since, token: entry.token } : null;
}

async function mutateEditing(mutator, options = {}) {
  store.ensureDataDir(options);
  return store.withFileLock(editingPath(options), async () => {
    const data = readEditing(options);
    const result = await mutator(data);
    await store.atomicWriteJson(editingPath(options), data, { mode: 0o600 });
    return result;
  });
}

async function setEditing(inputPath, editing, input = {}, options = {}) {
  const absPath = store.normalizeMdPath(inputPath);
  const token = typeof input.token === 'string' && input.token ? input.token : null;
  // 登记在这篇文档的事务锁内进行:恢复、冻结等持锁操作期间登记会等待,不会插在检查之后
  return store.withReviewTransaction(absPath, () => mutateEditing((data) => {
    const current = data.entries[absPath];
    if (editing) {
      if (liveEditingEntry(current) && token && current.token && current.token !== token) {
        return { absPath, editing: true, since: current.since, owned: false };
      }
      data.entries[absPath] = { since: liveEditingEntry(current) ? current.since : new Date().toISOString(), token, pid: process.pid };
      return { absPath, editing: true, since: data.entries[absPath].since, owned: true };
    }
    if (current && (!token || !current.token || current.token === token)) delete data.entries[absPath];
    return { absPath, editing: !!data.entries[absPath], owned: !data.entries[absPath] };
  }, options), options);
}

async function clearEditing(options = {}) {
  return mutateEditing((data) => { data.entries = {}; }, options);
}

function listEditing(options = {}) {
  const data = readEditing(options);
  return Object.entries(data.entries)
    .filter(([, entry]) => liveEditingEntry(entry))
    .map(([absPath, entry]) => ({ absPath, since: entry.since }));
}

// ---------- 最近文件 ----------

function recentPath(options = {}) { return path.join(store.getDataDir(options), 'recent.json'); }
const emptyRecent = () => ({ version: 1, entries: [] });

function readRecent(options = {}) {
  const data = store.readJsonStrict(recentPath(options), emptyRecent());
  if (!data || !Array.isArray(data.entries)) return emptyRecent();
  return data;
}

async function touchRecent(absPath, options = {}) {
  store.ensureDataDir(options);
  return store.withFileLock(recentPath(options), async () => {
    const data = readRecent(options);
    const now = new Date().toISOString();
    data.entries = [{ absPath, file: path.basename(absPath), lastOpenedAt: now },
      ...data.entries.filter((entry) => entry && entry.absPath !== absPath)].slice(0, RECENT_KEEP);
    await store.atomicWriteJson(recentPath(options), data, { mode: 0o600 });
    return data.entries[0];
  });
}

async function forgetRecent(absPath, options = {}) {
  store.ensureDataDir(options);
  return store.withFileLock(recentPath(options), async () => {
    const data = readRecent(options);
    data.entries = data.entries.filter((entry) => entry && entry.absPath !== absPath);
    await store.atomicWriteJson(recentPath(options), data, { mode: 0o600 });
  });
}

function activeStatuses() { return new Set(['reviewing', 'ready_to_apply', 'applying', 'conflict']); }

// 最近文件 ∪ 审阅索引(按路径取最新一条),按最后打开时间倒序;每条带 activeReview(活动会话摘要)或 null。
async function listRecent(options = {}) {
  const reviews = await store.listReviews(options);
  const latestByPath = new Map();
  for (const review of reviews) {
    if (!review || typeof review.absPath !== 'string') continue;
    const prior = latestByPath.get(review.absPath);
    const stampOf = (item) => item.lastOpenedAt || item.createdAt || '';
    if (!prior || stampOf(review) > stampOf(prior)) latestByPath.set(review.absPath, review);
  }
  const merged = new Map();
  for (const entry of readRecent(options).entries) {
    if (!entry || typeof entry.absPath !== 'string') continue;
    merged.set(entry.absPath, { absPath: entry.absPath, lastOpenedAt: entry.lastOpenedAt || '' });
  }
  for (const [absPath, review] of latestByPath) {
    const stampValue = review.lastOpenedAt || review.createdAt || '';
    const existing = merged.get(absPath);
    if (!existing) merged.set(absPath, { absPath, lastOpenedAt: stampValue });
    else if (stampValue > existing.lastOpenedAt) existing.lastOpenedAt = stampValue;
  }
  const editing = new Set(listEditing(options).map((item) => item.absPath));
  const active = activeStatuses();
  const items = [];
  for (const entry of merged.values()) {
    const review = latestByPath.get(entry.absPath) || null;
    const activeReview = review && active.has(review.status) ? review : null;
    let openCount = null;
    if (activeReview) {
      try { openCount = store.countOpenAnnotations(entry.absPath); } catch { openCount = null; }
    }
    items.push({
      id: documentId(entry.absPath),
      absPath: entry.absPath,
      file: path.basename(entry.absPath),
      directory: path.dirname(entry.absPath),
      lastOpenedAt: entry.lastOpenedAt,
      exists: fs.existsSync(entry.absPath),
      editing: editing.has(entry.absPath),
      lastReview: review ? { id: review.id, status: review.status, applyMode: review.applyMode || null, outcome: review.outcome || null } : null,
      activeReview: activeReview
        ? { id: activeReview.id, status: activeReview.status, applyMode: activeReview.applyMode || null, openCount }
        : null,
    });
  }
  items.sort((left, right) => String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt)));
  return items;
}

// ---------- 普通读写 ----------

async function readDocument(inputPath, options = {}) {
  const absPath = store.normalizeMdPath(inputPath);
  const source = readSource(absPath);
  const review = await store.getReviewByPath(absPath, { ...options, activeOnly: true });
  if (options.touch !== false) await touchRecent(absPath, options);
  const editing = isEditing(absPath, options);
  return {
    document: { id: documentId(absPath), absPath, file: path.basename(absPath), directory: path.dirname(absPath), title: path.basename(absPath) },
    source: { path: absPath, name: path.basename(absPath), content: source.content, hash: source.hash, mode: source.mode, size: source.size, mtimeMs: source.mtimeMs,
      encoding: source.encoding, readOnly: source.readOnly, readOnlyReason: source.readOnlyReason },
    activeReview: review ? { id: review.id, status: review.status, applyMode: review.applyMode || null } : null,
    editing: editing ? { since: editing.since } : null,
  };
}

/**
 * 新建一篇 Markdown:文件已存在则报 DOCUMENT_EXISTS(409),绝不覆盖;创建后计入最近文件。
 * 返回与 readDocument 相同的载荷,外加 created: true。
 */
async function createDocument(inputPath, input = {}, options = {}) {
  const resolved = path.resolve(String(inputPath || ''));
  if (!inputPath || !/\.md$/i.test(resolved)) throw fail('INVALID_DOCUMENT', `只支持新建 .md 文件: ${resolved}`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  // normalizeMdPath 要求文件已存在,这里自己把目录解析成真实路径再拼文件名
  const absPath = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  const content = typeof input.content === 'string' ? input.content : `# ${path.basename(absPath, path.extname(absPath))}\n\n`;
  if (Buffer.byteLength(content, 'utf8') > 64 * 1024) throw fail('INVALID_CONTENT', '新建文档的初始内容过大。');
  try {
    fs.writeFileSync(absPath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error && error.code === 'EEXIST') throw fail('DOCUMENT_EXISTS', `文件已存在,未覆盖: ${absPath}`, 409, { absPath });
    throw fail('CREATE_FAILED', `无法创建文件: ${error.message}`, 500);
  }
  const payload = await readDocument(absPath, options);
  return { ...payload, created: true };
}

function documentBackupsDir(absPath, options = {}) {
  const dir = path.join(store.getDataDir(options), 'backups', 'documents', pathKey(absPath));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function backupBeforeOverwrite(absPath, current, options = {}) {
  const dir = documentBackupsDir(absPath, options);
  const stampValue = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stampValue}-${current.hash.slice(0, 8)}.md`);
  fs.writeFileSync(file, current.buffer, { mode: 0o600 });
  const entries = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  for (const name of entries.slice(0, Math.max(0, entries.length - DOCUMENT_BACKUP_KEEP))) {
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
  try { fs.writeFileSync(path.join(dir, 'origin.txt'), `${absPath}\n`, { mode: 0o600 }); } catch {}
  return file;
}

const recentWrites = new Map(); // clientRequestId -> result(本进程内幂等)

function validateWrite(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_PAYLOAD', '请求体必须是 JSON 对象。');
  if (typeof input.content !== 'string') fail('INVALID_PAYLOAD', 'content 必须是字符串。');
  if (typeof input.expectedHash !== 'string' || !/^[0-9a-f]{64}$/i.test(input.expectedHash)) fail('INVALID_PAYLOAD', 'expectedHash 必须是 SHA-256。');
  if (input.clientRequestId !== undefined && (typeof input.clientRequestId !== 'string' || !input.clientRequestId)) fail('INVALID_PAYLOAD', 'clientRequestId 必须是非空字符串。');
  return { content: input.content, expectedHash: input.expectedHash.toLowerCase(), clientRequestId: input.clientRequestId || null };
}

async function writeDocument(inputPath, input, options = {}) {
  const absPath = store.normalizeMdPath(inputPath);
  const payload = validateWrite(input);
  const requestKey = payload.clientRequestId ? `${absPath}\n${payload.clientRequestId}` : null;
  if (requestKey && recentWrites.has(requestKey)) return { ...recentWrites.get(requestKey), reused: true };

  // 与审阅事务共用同一把锁:mdreview open 算指纹建会话的瞬间,普通写入不得插进来。
  return store.withReviewTransaction(absPath, async () => {
    if (requestKey && recentWrites.has(requestKey)) return { ...recentWrites.get(requestKey), reused: true };
    const review = await store.getReviewByPath(absPath, { ...options, activeOnly: true });
    if (review) {
      fail('REVIEW_ACTIVE', '这篇文档正处于审阅会话中,原文已冻结。请在审阅标签页里走"手工修改"流程,或另存为副本再编辑。', 409, {
        absPath, review: { id: review.id, status: review.status, applyMode: review.applyMode || null },
      });
    }
    const current = readSource(absPath);
    if (current.readOnly) fail('ENCODING_READ_ONLY', current.readOnlyReason, 409, { absPath, encoding: current.encoding });
    if (current.hash !== payload.expectedHash) {
      fail('SOURCE_CHANGED', '文件在你打开之后被别的程序改过,为避免覆盖别人的修改,已停止保存。请重新打开后再编辑。', 409, {
        absPath, expectedHash: payload.expectedHash, currentHash: current.hash,
      });
    }
    const nextBuffer = Buffer.from(payload.content, 'utf8');
    const nextHash = sha256(nextBuffer);
    let backup = null;
    if (nextHash !== current.hash) {
      backup = backupBeforeOverwrite(absPath, current, options);
      await store.atomicWriteFile(absPath, nextBuffer, { mode: current.mode || 0o644 });
    }
    const result = { ok: true, absPath, previousHash: current.hash, currentHash: nextHash, changed: nextHash !== current.hash, backup, savedAt: new Date().toISOString() };
    if (requestKey) {
      recentWrites.set(requestKey, result);
      if (recentWrites.size > 200) recentWrites.delete(recentWrites.keys().next().value);
    }
    return result;
  }, options);
}

module.exports = {
  documentId,
  readDocument,
  createDocument,
  writeDocument,
  listRecent,
  touchRecent,
  forgetRecent,
  isEditing,
  setEditing,
  clearEditing,
  listEditing,
};
