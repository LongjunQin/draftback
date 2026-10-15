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
  if (editing) { try { await require('./batches').settlePendingImportFor(absPath, options); } catch (_) {} }
  // 登记在这篇文档的事务锁内进行:恢复、冻结等持锁操作期间登记会等待,不会插在检查之后
  return store.withReviewTransaction(absPath, () => mutateEditing((data) => {
    if (editing) store.assertNoPendingImport(absPath, options);
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
  const presence = require('./agent-presence');
  const items = [];
  for (const entry of merged.values()) {
    const review = latestByPath.get(entry.absPath) || null;
    const activeReview = review && active.has(review.status) ? review : null;
    let openCount = null;
    if (activeReview) {
      try { openCount = store.countOpenAnnotations(entry.absPath); } catch { openCount = null; }
    }
    // 左栏「稿件」按轮到谁分组要的东西(UI 方案 3.2):轮次、AI 在不在、这一轮采纳几条、回稿后看过没有
    let latest = null;
    if (review) {
      // 采纳 / 未采纳与回稿卡同一个来源:这一轮版本事件里固化的处理记录;没有归档就不显示数字
      let applied = null, wontfix = null;
      if (review.status === 'complete' && review.docId && review.versionId) {
        const meta = require('./version-store').readMetaFor(review.docId, review.versionId, options);
        if (meta && Array.isArray(meta.annotations)) {
          const members = Array.isArray(meta.memberAnnotationIds) ? new Set(meta.memberAnnotationIds) : null;
          const notes = meta.annotations.filter((note) => !members || members.has(note.id));
          applied = notes.filter((note) => note.status === 'applied').length;
          wontfix = notes.filter((note) => note.status === 'wontfix').length;
        }
      }
      const stamps = [review.completedAt, review.submittedAt, review.claimedAt, review.applyStartedAt, review.cancelledAt, review.finalizedAt, review.createdAt]
        .map((value) => Date.parse(value || '')).filter(Number.isFinite);
      const activityAt = stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
      const returned = review.status === 'complete' && !review.outcome && review.applyMode !== 'manual';
      const seen = Date.parse(review.seenAt || '');
      latest = {
        id: review.id, status: review.status, applyMode: review.applyMode || null, outcome: review.outcome || null,
        round: Number.isInteger(review.round) ? review.round : null,
        agentState: review.status === 'ready_to_apply' ? presence.withAgentState(review, options).agentState : null,
        activityAt, completedAt: review.completedAt || null, applied, wontfix, openCount,
        unread: returned && !(Number.isFinite(seen) && seen >= Date.parse(review.completedAt || 0)),
      };
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
      latest,
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
  // 最新一轮(不限状态):稿子回来了 / 已通过 / 已恢复 / 已定稿的文档再打开要进那一轮,回稿卡与历史才看得到(规则⑤第三段)
  const latest = review || await store.getReviewByPath(absPath, options);
  if (options.touch !== false) await touchRecent(absPath, options);
  const editing = isEditing(absPath, options);
  return {
    document: { id: documentId(absPath), absPath, file: path.basename(absPath), directory: path.dirname(absPath), title: path.basename(absPath) },
    source: { path: absPath, name: path.basename(absPath), content: source.content, hash: source.hash, mode: source.mode, size: source.size, mtimeMs: source.mtimeMs,
      encoding: source.encoding, readOnly: source.readOnly, readOnlyReason: source.readOnlyReason },
    activeReview: review ? { id: review.id, status: review.status, applyMode: review.applyMode || null } : null,
    latestReview: latest ? { id: latest.id, status: latest.status, applyMode: latest.applyMode || null, outcome: latest.outcome || null, docId: latest.docId || null } : null,
    // 文档身份(来自 documents.json):会话被 90 天清理后版本记录仍在,界面靶它显示历史、对比与恢复
    docId: (latest && latest.docId) || (require('./version-store').documentByPath(absPath, options) || {}).docId || null,
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
  const absPath = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved)).normalize('NFC');
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

  // 手机交来的批次还没处理完(比如开下一轮到一半):先收敛,再写(跨端规则 v2.4 第 6.9 条「在途导入的隔离」)
  try { await require('./batches').settlePendingImportFor(absPath, options); } catch (_) {}
  // 与审阅事务共用同一把锁:mdreview open 算指纹建会话的瞬间,普通写入不得插进来。
  return store.withReviewTransaction(absPath, async () => {
    if (requestKey && recentWrites.has(requestKey)) return { ...recentWrites.get(requestKey), reused: true };
    store.assertNoPendingImport(absPath, options);
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

// ---------- 图片落盘(UI 方案 1.2「图像」):粘贴、拖入、上传按钮的图片存到文档旁的 images/,正文写相对路径 ----------

const IMAGE_TYPES = Object.freeze({
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
});
const IMAGE_MAX_BYTES = 20 * 1024 * 1024; // base64 后约 27 MB,低于服务的 32 MB 请求上限

function safeStem(value, fallback) {
  // 只留字母、数字(含中文)、下划线与连字符:相对路径里没有空格和括号,Markdown 链接目标不用转义
  const stem = String(value || '').normalize('NFC').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return stem || fallback;
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 把一张图片存进 <文档目录>/images/,返回相对路径。
 * 只在文档可编辑时允许(没有活动会话,或处于「我自己改」);只收常见图片类型;不覆盖已有文件。
 */
async function saveDocumentImage(inputPath, input = {}, options = {}) {
  const absPath = store.normalizeMdPath(inputPath);
  const ext = IMAGE_TYPES[String(input.type || '').toLowerCase()];
  if (!ext) fail('IMAGE_TYPE', '只支持 PNG、JPEG、GIF、WebP、AVIF、SVG 图片。');
  if (typeof input.data !== 'string' || !input.data) fail('INVALID_PAYLOAD', '缺少图片数据。');
  const buffer = Buffer.from(input.data, 'base64');
  if (!buffer.length) fail('INVALID_PAYLOAD', '图片数据为空。');
  if (buffer.length > IMAGE_MAX_BYTES) fail('IMAGE_TOO_LARGE', '图片超过 20 MB,请先压缩再插入。', 413);
  const review = await store.getReviewByPath(absPath, { ...options, activeOnly: true });
  if (review && !(review.status === 'applying' && review.applyMode === 'manual')) {
    fail('REVIEW_ACTIVE', '这篇文档正处于审阅中,原文已锁定,不能插入图片。', 409, { review: { id: review.id, status: review.status } });
  }
  const docDir = fs.realpathSync(path.dirname(absPath));
  const imagesDir = path.join(docDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  // images 若是指向文档目录之外的符号链接,拒绝:只往文档旁边写
  const realImages = fs.realpathSync(imagesDir);
  if (realImages !== imagesDir && !realImages.startsWith(`${docDir}${path.sep}`)) fail('IMAGE_DIR', 'images 文件夹指向了文档目录之外,已停止写入。', 409);
  const base = `${safeStem(path.basename(absPath, path.extname(absPath)), 'image')}-${stamp()}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = `${base}${attempt ? `-${attempt + 1}` : ''}.${ext}`;
    const target = path.join(realImages, name);
    try {
      fs.writeFileSync(target, buffer, { flag: 'wx', mode: 0o644 });
      return { ok: true, relPath: `images/${name}`, absPath: target, bytes: buffer.length };
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      fail('IMAGE_WRITE_FAILED', `图片没能写入:${error.message}`, 500);
    }
  }
  fail('IMAGE_WRITE_FAILED', '同名图片太多,没能写入。', 500);
}

// ---------- 另存为副本(UI 方案 1.2「复制」):新文件、新文档身份,不继承原稿历史与批注 ----------

function sameFile(a, b) {
  try { const x = fs.statSync(a), y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}

async function saveDocumentCopy(targetPath, input = {}, options = {}) {
  const resolved = path.resolve(String(targetPath || ''));
  if (!targetPath || !/\.md$/i.test(resolved)) fail('INVALID_DOCUMENT', `副本只能存成 .md 文件: ${resolved}`);
  if (typeof input.content !== 'string') fail('INVALID_PAYLOAD', 'content 必须是字符串。');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  // 目标已存在时取磁盘上的真实写法(不分大小写的卷上「a.md」与「A.md」是同一个文件)
  const absPath = fs.existsSync(resolved)
    ? fs.realpathSync.native(resolved).normalize('NFC')
    : path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved)).normalize('NFC');
  if (input.sourcePath && (sameFile(absPath, String(input.sourcePath)) || path.resolve(String(input.sourcePath)) === absPath)) {
    fail('COPY_SAME_FILE', '副本不能存回原文件,请换一个名字。', 409);
  }
  const buffer = Buffer.from(input.content, 'utf8');
  return store.withReviewTransaction(absPath, async () => {
    // 有审阅记录、文档身份或批注的路径不能拿来放副本——正文被删了也一样:
    // 新副本会接上那篇的旧批注、历史和身份
    const review = await store.getReviewByPath(absPath, options);
    const identity = require('./version-store').documentByPath(absPath, options);
    if (review || identity || fs.existsSync(store.sidecarFor(absPath))) {
      fail('COPY_TARGET_HAS_HISTORY', '这个位置有审阅记录或批注,不能放副本。请换一个名字。', 409, { absPath });
    }
    if (fs.existsSync(absPath)) {
      // 存储面板已经问过「要替换吗」:普通文件覆盖前先备份
      const current = readSource(absPath);
      backupBeforeOverwrite(absPath, current, options);
      await store.atomicWriteFile(absPath, buffer, { mode: current.mode || 0o644 });
    } else {
      fs.writeFileSync(absPath, buffer, { flag: 'wx', mode: 0o644 });
    }
    // 不复制旁注:副本是新文档,批注与历史都留在原稿
    const payload = await readDocument(absPath, options);
    return { ...payload, copied: true };
  }, options);
}

// ---------- 改名(同一文件夹里换名字):批注、审阅记录、文档身份、编辑登记、最近文件、覆盖前备份都跟着走 ----------
// 在访达里改名会让回稿认不出这篇(左栏显示「文件已不存在」,批注和历史断开);在回稿里改名就不会。

function validateNewName(input, ext) {
  let name = String(input == null ? '' : input).normalize('NFC').trim();
  // 带不带扩展名都行;统一用原来的扩展名
  if (name.toLowerCase().endsWith(ext.toLowerCase())) name = name.slice(0, -ext.length).trim();
  if (!name) fail('RENAME_INVALID_NAME', '名字不能是空的。');
  if (name.startsWith('.')) fail('RENAME_INVALID_NAME', '名字不能以「.」开头,那样文件会被隐藏。');
  if (/[/:\u0000-\u001f\u007f]/.test(name)) fail('RENAME_INVALID_NAME', '名字里不能有「/」「:」或控制字符。');
  const file = `${name}${ext}`;
  if (Buffer.byteLength(file, 'utf8') > 255) fail('RENAME_INVALID_NAME', '名字太长了。');
  return file;
}

function samePathOrAlias(stored, wanted) {
  if (typeof stored !== 'string') return false;
  const value = stored.normalize('NFC');
  if (value === wanted) return true;
  if (value.toLowerCase() !== wanted.toLowerCase()) return false;
  try { return fs.realpathSync.native(value).normalize('NFC') === wanted; } catch { return false; }
}

// 改名日志:改文件名之前落一份,改完删掉。进程中途被杀时,下次启动先按日志把改名做完或退回(recoverRenames),
// 再跑审阅索引清理——否则清理会把"文件已不存在"的已结束会话当垃圾删掉,历史就断了
function renamesDir(options = {}) {
  const dir = path.join(store.getDataDir(options), 'renames');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function journalFile(id, options) { return path.join(renamesDir(options), `${id}.json`); }
function removeJournal(id, options) { try { fs.unlinkSync(journalFile(id, options)); } catch {} }

// 把一篇文档的记录从 from 挂到 to:旁注(并刷新旁注里的文件名)、各轮审阅记录、文档身份、编辑登记。
// 必须全部成功;调用方持两个路径的事务锁。重放安全:已经挂过去的跳过。
async function moveRecords(from, to, stamp, options) {
  const versionStore = require('./version-store');
  const sidecarFrom = store.sidecarFor(from);
  const sidecarTo = store.sidecarFor(to);
  if (fs.existsSync(sidecarFrom) && !fs.existsSync(sidecarTo)) fs.renameSync(sidecarFrom, sidecarTo);
  if (fs.existsSync(sidecarTo)) await store.mutateAnnotations(to, () => null, options); // 读时按新路径写回 sourceFile / file
  await store.mutateReviews((data) => {
    for (const review of Object.values(data.reviews)) {
      if (review && samePathOrAlias(review.absPath, from)) {
        review.renamedFrom = review.absPath; review.absPath = to; review.file = path.basename(to); review.renamedAt = stamp;
      }
    }
    return null;
  }, options);
  const identity = versionStore.documentByPath(from, options);
  if (identity) await versionStore.moveIdentity(identity.docId, from, to, options);
  await mutateEditing((data) => {
    const entry = data.entries[from];
    if (entry) { delete data.entries[from]; data.entries[to] = entry; }
  }, options);
}

// 退回:只动这次改名挂过去的(renamedAt 对得上),别的不碰
async function unmoveRecords(from, to, stamp, options) {
  const versionStore = require('./version-store');
  await mutateEditing((data) => {
    const entry = data.entries[to];
    if (entry) { delete data.entries[to]; data.entries[from] = entry; }
  }, options);
  const identity = versionStore.documentByPath(to, options);
  if (identity && Array.isArray(identity.movedFrom) && identity.movedFrom.some((item) => item && item.path === from)) {
    await versionStore.moveIdentity(identity.docId, to, from, options);
  }
  await store.mutateReviews((data) => {
    for (const review of Object.values(data.reviews)) {
      if (review && review.absPath === to && review.renamedAt === stamp) {
        review.absPath = review.renamedFrom || from; review.file = path.basename(review.absPath); delete review.renamedFrom; delete review.renamedAt;
      }
    }
    return null;
  }, options);
  const sidecarFrom = store.sidecarFor(from);
  const sidecarTo = store.sidecarFor(to);
  if (fs.existsSync(sidecarTo) && !fs.existsSync(sidecarFrom)) {
    fs.renameSync(sidecarTo, sidecarFrom);
    await store.mutateAnnotations(from, () => null, options);
  }
}

// 只改大小写时 existsSync 两边都是真:看目录里的实际写法
function nameOnDisk(absPath) {
  try { return fs.readdirSync(path.dirname(absPath)).includes(path.basename(absPath)); } catch { return false; }
}

async function renameDocument(inputPath, newName, options = {}) {
  const from = store.normalizeMdPath(inputPath);
  const ext = path.extname(from);
  const file = validateNewName(newName, ext);
  const to = path.join(path.dirname(from), file).normalize('NFC');
  if (to === from) return { ...(await readDocument(from, { ...options, touch: false })), renamed: false, from, to };
  const versionStore = require('./version-store');
  // 只改大小写(Report.md → report.md):不分大小写的卷上新旧是同一个文件
  const targetTaken = () => fs.existsSync(to) && !sameFile(to, from);
  if (targetTaken()) fail('RENAME_TARGET_EXISTS', `这个文件夹里已经有「${file}」了。`, 409, { absPath: to });
  const [first, second] = [from, to].sort();
  return store.withReviewTransaction(first, () => store.withReviewTransaction(second, async () => {
    // 锁内复查:原文件还在、目标没被占、这一轮走完了、没有卡住的恢复
    if (!fs.existsSync(from)) fail('SOURCE_NOT_FOUND', '原文件已经不在了。', 404, { absPath: from });
    if (targetTaken()) fail('RENAME_TARGET_EXISTS', `这个文件夹里已经有「${file}」了。`, 409, { absPath: to });
    const reviews = (await store.listReviews(options)).filter((review) => review && samePathOrAlias(review.absPath, from));
    const active = reviews.find((review) => store.ACTIVE_REVIEW_STATES.has(review.status));
    if (active) fail('RENAME_BLOCKED', '这一轮还没走完,走完再改名。', 409, { reviewId: active.id, status: active.status });
    if (versionStore.restoreConflictFor(from, options)) fail('RESTORE_PENDING', '这篇有没走完的恢复,处理完再改名。', 409);
    const identity = versionStore.documentByPath(from, options);
    const caseOnly = to.toLowerCase() === from.toLowerCase() && sameFile(to, from);
    if (!caseOnly) {
      // 新名字不能接上别的文档留下的批注、身份或审阅记录(正文被删了也一样)
      const otherIdentity = versionStore.documentByPath(to, options);
      const otherReview = await store.getReviewByPath(to, options);
      if ((otherIdentity && (!identity || otherIdentity.docId !== identity.docId)) || otherReview || fs.existsSync(store.sidecarFor(to))) {
        fail('RENAME_TARGET_HAS_HISTORY', `「${file}」这个名字留有别的文档的批注或历史,换一个名字。`, 409, { absPath: to });
      }
    }
    const stamp = new Date().toISOString();
    const journal = { id: `rn_${crypto.randomBytes(6).toString('hex')}`, from, to, stamp, docId: identity ? identity.docId : null, reviews: reviews.length };
    await store.atomicWriteJson(journalFile(journal.id, options), journal, { mode: 0o600 });
    try {
      fs.renameSync(from, to);
    } catch (error) {
      removeJournal(journal.id, options);
      fail('RENAME_FAILED', `没能改名:${error.message}`, 500, { absPath: from });
    }
    try {
      await moveRecords(from, to, stamp, options);
    } catch (error) {
      // 撤回:记录与文件都改回原名,再报错
      try { await unmoveRecords(from, to, stamp, options); } catch {}
      try { fs.renameSync(to, from); } catch {}
      removeJournal(journal.id, options);
      throw error;
    }
    removeJournal(journal.id, options);
    // 下面两项坏了不影响文件和历史,尽力而为
    try {
      await store.withFileLock(recentPath(options), async () => {
        const data = readRecent(options);
        data.entries = data.entries.filter((entry) => entry && entry.absPath !== to)
          .map((entry) => (entry && entry.absPath === from ? { ...entry, absPath: to, file: path.basename(to) } : entry));
        await store.atomicWriteJson(recentPath(options), data, { mode: 0o600 });
      });
    } catch {}
    try {
      const oldBackups = path.join(store.getDataDir(options), 'backups', 'documents', pathKey(from));
      const newBackups = path.join(store.getDataDir(options), 'backups', 'documents', pathKey(to));
      if (fs.existsSync(oldBackups) && !fs.existsSync(newBackups)) {
        fs.renameSync(oldBackups, newBackups);
        fs.writeFileSync(path.join(newBackups, 'origin.txt'), `${to}\n`, { mode: 0o600 });
      }
    } catch {}
    // 改名已经完成:读回来时不再碰最近文件(那一步失败也不能把整个改名报成失败)
    return { ...(await readDocument(to, { ...options, touch: false })), renamed: true, from, to, reviews: reviews.length, identity: identity ? identity.docId : null };
  }, options), options);
}

/**
 * 启动时收敛中途断掉的改名(服务启动、审阅索引清理之前调用):
 * 新名字在磁盘上 → 把记录挂过去;还是旧名字 → 退回已经挂过去的记录;两个都不在 → 丢弃日志。
 */
async function recoverRenames(options = {}) {
  let names = [];
  try { names = fs.readdirSync(renamesDir(options)).filter((name) => name.endsWith('.json')); } catch { return []; }
  const results = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    let journal = null;
    try { journal = store.readJsonStrict(journalFile(id, options)); } catch { journal = null; }
    if (!journal || typeof journal.from !== 'string' || typeof journal.to !== 'string') { removeJournal(id, options); continue; }
    const { from, to, stamp } = journal;
    const [first, second] = [from, to].sort();
    try {
      const action = await store.withReviewTransaction(first, () => store.withReviewTransaction(second, async () => {
        const caseOnly = from.toLowerCase() === to.toLowerCase();
        const renamed = caseOnly ? nameOnDisk(to) : fs.existsSync(to) && !fs.existsSync(from);
        const stayed = caseOnly ? nameOnDisk(from) : fs.existsSync(from) && !fs.existsSync(to);
        if (renamed) { await moveRecords(from, to, stamp, options); return 'completed'; }
        if (stayed) { await unmoveRecords(from, to, stamp, options); return 'rolled-back'; }
        return fs.existsSync(from) || fs.existsSync(to) ? 'left' : 'abandoned';
      }, options), options);
      if (action !== 'left') removeJournal(id, options);
      results.push({ id, from, to, action });
    } catch (error) {
      results.push({ id, from, to, action: 'error', message: error.message });
    }
  }
  return results;
}

module.exports = {
  documentId,
  renameDocument,
  recoverRenames,
  readDocument,
  createDocument,
  writeDocument,
  saveDocumentImage,
  saveDocumentCopy,
  IMAGE_TYPES,
  listRecent,
  touchRecent,
  forgetRecent,
  isEditing,
  setEditing,
  clearEditing,
  listEditing,
};
