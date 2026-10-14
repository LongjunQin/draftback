#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const APPLY_HINT = '本文件是对 sourceFile 的评审批注(由回稿 Draftback 的本地服务生成,与同目录同名 .md 一一对应)。' +
  '改稿协议——第一步:动手修改 sourceFile 之前,必须先运行 mdreview begin-apply "<sourceFile绝对路径>" 声明开始改稿' +
  '(跳过此步直接改文件,会被判为版本冲突);mdreview 不在 PATH 时用回稿仓库下的 node mdreview.js 等价调用。' +
  '第二步:只处理 status=open 的批注;用 quote+headingPath 定位(lineStart 仅辅助,改稿后可能偏移);' +
  'scope=document 的批注是针对全篇的总体意见,没有文字锚点——若它要求重写、调整架构或先讨论,先与用户对齐方向再动笔,同样按 applied/wontfix 闭环;不要移动、改名或删除本文件;' +
  '每处理完一条标 status=applied + appliedAt + appliedBy + appliedNote,不采纳的标 status=wontfix + 理由;绝不重做 status=applied 的。' +
  '第三步:全部 open 清零后运行 mdreview complete "<sourceFile绝对路径>",本轮才算结束。';
const ACTIVE_REVIEW_STATES = new Set(['reviewing', 'ready_to_apply', 'applying', 'conflict']);
// 轮次版本记录(docs/version-record-design.md):文档身份索引与每轮留底;惰性加载避免循环引用
const versions = () => require('./version-store');
const TERMINAL_REVIEW_STATES = new Set(['complete', 'cancelled']);

class ReviewStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ReviewStoreError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
    this.details = options.details;
    if (options.cause) this.cause = options.cause;
  }
}

// CLI、App 内置服务与 Agent 共用同一份会话数据,因此默认目录必须与安装位置无关。
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.draftback');
// 改名前的数据目录(命名沿革见 docs/naming-history.md):第一次用新目录时整个搬过来,旧目录不再保留
const LEGACY_DATA_DIRS = [path.join(os.homedir(), '.mdread')];
let legacyDataDirChecked = false;
function migrateLegacyDataDir(target) {
  if (legacyDataDirChecked || path.resolve(target) !== DEFAULT_DATA_DIR) return;
  legacyDataDirChecked = true;
  if (fs.existsSync(target)) return;
  for (const legacy of LEGACY_DATA_DIRS) {
    let stat;
    try { stat = fs.lstatSync(legacy); } catch { continue; }
    if (!stat.isDirectory()) continue;
    try { fs.renameSync(legacy, target); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error;
    }
    return;
  }
}
function getDataDir(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DRAFTBACK_DATA_DIR || DEFAULT_DATA_DIR);
  migrateLegacyDataDir(dataDir);
  return dataDir;
}

function getPaths(options = {}) {
  const dataDir = getDataDir(options);
  return {
    dataDir,
    reviews: path.join(dataDir, 'reviews.json'),
    port: path.join(dataDir, 'port'),
  };
}

function ensureDataDir(options = {}) {
  const dataDir = getDataDir(options);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const paths = getPaths(options);
  for (const filePath of [paths.reviews, paths.port]) {
    try { fs.chmodSync(filePath, 0o600); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return dataDir;
}

function cloneDefault(valueOrFactory) {
  const value = typeof valueOrFactory === 'function' ? valueOrFactory() : valueOrFactory;
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function readJsonStrict(filePath, defaultValue) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && defaultValue !== undefined) return cloneDefault(defaultValue);
    if (error.code === 'ENOENT') {
      throw new ReviewStoreError('JSON_NOT_FOUND', `JSON 文件不存在: ${filePath}`, {
        httpStatus: 404, details: { filePath }, cause: error,
      });
    }
    throw new ReviewStoreError('JSON_READ_FAILED', `无法读取 JSON: ${filePath}`, {
      details: { filePath }, cause: error,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ReviewStoreError('MALFORMED_JSON', `已有 JSON 已损坏，已停止写入以保护原数据: ${filePath}`, {
      details: { filePath }, cause: error,
    });
  }
}

function modeForExisting(filePath, fallback = 0o600) {
  try { return fs.statSync(filePath).mode & 0o777; } catch { return fallback; }
}

async function atomicWriteFile(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const mode = options.mode === undefined ? modeForExisting(filePath) : options.mode;
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temp, 'wx', mode);
    await handle.writeFile(content, options.encoding || 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.chmod(temp, mode);
    // Windows 上目标文件被并发读取/杀毒扫描短暂占用时 rename 会瞬时 EPERM,限次重试
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.promises.rename(temp, filePath);
        break;
      } catch (renameError) {
        if (!isWindowsTransient(renameError) || attempt >= 40) throw renameError;
        await delay(25);
      }
    }
    try {
      const dirHandle = await fs.promises.open(dir, 'r');
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch {}
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temp).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(filePath, data, options = {}) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  return atomicWriteFile(filePath, serialized, { ...options, encoding: 'utf8' });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Windows 上 rmdir 是异步的"删除挂起":此窗口内对同一目录的 mkdir/stat/rm
// 会瞬时报 EPERM/EBUSY 等,必须当作竞争重试而不是硬错误。
const WINDOWS_TRANSIENT_CODES = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'];
function isWindowsTransient(error) {
  return process.platform === 'win32' && WINDOWS_TRANSIENT_CODES.includes(error.code);
}

async function withFileLock(targetPath, operation, options = {}) {
  const lockPath = options.lockPath || `${targetPath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const timeoutMs = options.timeoutMs || Number(process.env.DRAFTBACK_LOCK_TIMEOUT_MS) || 8000;
  const staleMs = options.staleMs || 60000;
  const started = Date.now();
  const token = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.promises.writeFile(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), {
          flag: 'wx', mode: 0o600,
        });
      } catch (error) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' && !isWindowsTransient(error)) throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          let owner = null;
          try { owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8')); } catch {}
          if (!owner || !processIsRunning(Number(owner.pid))) {
            const stalePath = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
            try {
              await fs.promises.rename(lockPath, stalePath);
              await fs.promises.rm(stalePath, { recursive: true, force: true });
              continue;
            } catch (staleError) {
              if (!['ENOENT', 'EEXIST'].includes(staleError.code)) throw staleError;
            }
          }
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        if (!isWindowsTransient(statError)) throw statError;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new ReviewStoreError('LOCK_TIMEOUT', `等待文件锁超时: ${targetPath}`, {
          httpStatus: 503, details: { targetPath, lockPath, timeoutMs },
        });
      }
      await delay(20 + Math.floor(Math.random() * 31));
    }
  }

  try {
    return await operation();
  } finally {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'));
        if (owner.token === token) await fs.promises.rm(lockPath, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code === 'ENOENT') break;
        if (isWindowsTransient(error) && attempt < 20) { await delay(25); continue; }
        throw error;
      }
    }
  }
}

function reviewTransactionLockPath(absPath, options = {}) {
  const digest = crypto.createHash('sha256').update(path.resolve(absPath)).digest('hex');
  return path.join(getDataDir(options), 'transactions', `${digest}.lock`);
}

async function withReviewTransaction(absPath, operation, options = {}) {
  ensureDataDir(options);
  return withFileLock(absPath, operation, {
    ...(options.lock || {}),
    lockPath: reviewTransactionLockPath(absPath, options),
  });
}

async function mutateJson(filePath, defaultValue, mutator, options = {}) {
  return withFileLock(filePath, async () => {
    const data = readJsonStrict(filePath, defaultValue);
    if (options.validate) options.validate(data, filePath);
    const result = await mutator(data);
    if (options.validate) options.validate(data, filePath);
    await atomicWriteJson(filePath, data, options);
    return result;
  }, options.lock);
}

function sha256File(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch (error) {
    throw new ReviewStoreError('SOURCE_READ_FAILED', `无法读取源文档: ${absPath}`, {
      httpStatus: error.code === 'ENOENT' ? 404 : 500,
      details: { absPath }, cause: error,
    });
  }
}

function normalizeMdPath(inputPath) {
  if (!inputPath) throw new ReviewStoreError('INVALID_DOCUMENT', '请给出 Markdown 文件路径。', { httpStatus: 400 });
  const resolved = path.resolve(inputPath);
  if (!/\.md$/i.test(resolved)) {
    throw new ReviewStoreError('INVALID_DOCUMENT', `只支持 .md 文件: ${resolved}`, {
      httpStatus: 400, details: { absPath: resolved },
    });
  }
  let absPath;
  // 同一个文件名在 Finder 拖入与命令行输入时可能是不同的 Unicode 组合形式(日韩文、带重音字母),
  // 统一成 NFC,否则同一篇文档会出现两套会话;APFS/HFS+ 查找不区分组合形式,打开不受影响
  try { absPath = fs.realpathSync(resolved).normalize('NFC'); } catch (error) {
    throw new ReviewStoreError('SOURCE_NOT_FOUND', `Markdown 文件不存在: ${resolved}`, {
      httpStatus: 404, details: { absPath: resolved }, cause: error,
    });
  }
  if (!fs.statSync(absPath).isFile()) {
    throw new ReviewStoreError('INVALID_DOCUMENT', `路径不是文件: ${absPath}`, {
      httpStatus: 400, details: { absPath },
    });
  }
  return absPath;
}

function resolvePathBestEffort(inputPath) {
  const resolved = path.resolve(inputPath);
  try { return fs.realpathSync(resolved).normalize('NFC'); } catch {}
  try { return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)).normalize('NFC'); } catch {}
  return resolved.normalize('NFC');
}

const sidecarFor = (absMd) => `${absMd}.annotations.json`;

// v1 sidecar 允许批注缺少 status。所有读取与状态判断都必须把它们当作 open，
// 避免旧批注在计数、完成审阅或新应用端中被静默遗漏。
function annotationStatus(annotation) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return 'open';
  // cancelled:会话被人工解锁时该轮尚未处理的批注(保留原文供查看,不再算待处理)
  return ['open', 'applied', 'wontfix', 'cancelled'].includes(annotation.status) ? annotation.status : 'open';
}

function normalizeLegacyAnnotation(annotation) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return annotation;
  if (annotation.status === undefined || annotation.status === null || annotation.status === '') {
    return { ...annotation, status: 'open' };
  }
  return annotation;
}

function readAnnotations(absMd) {
  const sidecar = sidecarFor(absMd);
  const existing = readJsonStrict(sidecar, {});
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new ReviewStoreError('INVALID_SIDECAR', `批注 sidecar 顶层必须是对象: ${sidecar}`, {
      details: { sidecar },
    });
  }
  if (existing.annotations !== undefined && !Array.isArray(existing.annotations)) {
    throw new ReviewStoreError('INVALID_SIDECAR', `批注 sidecar 的 annotations 必须是数组: ${sidecar}`, {
      details: { sidecar },
    });
  }
  return {
    ...existing,
    version: existing.version || 1,
    sourceFile: absMd,
    file: path.basename(absMd),
    _apply: APPLY_HINT,
    annotations: (existing.annotations || []).map(normalizeLegacyAnnotation),
  };
}

async function mutateAnnotations(absMd, mutator, options = {}) {
  const sidecar = sidecarFor(absMd);
  return withFileLock(sidecar, async () => {
    const data = readAnnotations(absMd);
    const result = await mutator(data);
    if (!Array.isArray(data.annotations)) {
      throw new ReviewStoreError('INVALID_SIDECAR', 'mutator 不能把 annotations 改为非数组。', {
        details: { sidecar },
      });
    }
    await atomicWriteJson(sidecar, data, { mode: options.mode });
    return result;
  }, options.lock);
}

/** 本轮成员的当前记录(规则⑤第 7.1 节):交出后只看固定的成员集;交出前按会话归属(没写会话编号的旧批注算当前轮) */
function memberAnnotations(review) {
  let annotations = [];
  try { annotations = readAnnotations(review.absPath).annotations; } catch { return []; }
  if (Array.isArray(review.memberAnnotationIds)) {
    const ids = new Set(review.memberAnnotationIds);
    return annotations.filter((note) => note && ids.has(note.id));
  }
  return annotations.filter((note) => note && (!note.reviewSessionId || note.reviewSessionId === review.id));
}
function countOpenForReview(review) {
  if (!review) return 0;
  if (Array.isArray(review.memberAnnotationIds)) return memberAnnotations(review).filter((note) => annotationStatus(note) === 'open').length;
  return countOpenAnnotations(review.absPath);
}

function countOpenAnnotations(absMd) {
  return readAnnotations(absMd).annotations.filter((annotation) => annotationStatus(annotation) === 'open').length;
}

function validateReviewData(data, filePath) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !data.reviews || typeof data.reviews !== 'object' || Array.isArray(data.reviews)) {
    throw new ReviewStoreError('INVALID_REVIEWS', `审阅索引结构无效: ${filePath}`, {
      details: { filePath },
    });
  }
}

const emptyReviews = () => ({ version: 1, reviews: {} });

function readReviewData(options = {}) {
  const reviewsFile = getPaths(options).reviews;
  const data = readJsonStrict(reviewsFile, emptyReviews);
  validateReviewData(data, reviewsFile);
  return data;
}

function sortNewestFirst(reviews) {
  return reviews.sort((a, b) => Date.parse(b.lastOpenedAt || b.createdAt || 0) - Date.parse(a.lastOpenedAt || a.createdAt || 0));
}

function findByPath(data, absPath, activeOnly = false) {
  const wanted = String(absPath).normalize('NFC');
  const matches = Object.values(data.reviews).filter((review) =>
    review && typeof review.absPath === 'string' && review.absPath.normalize('NFC') === wanted && (!activeOnly || ACTIVE_REVIEW_STATES.has(review.status)));
  return sortNewestFirst(matches)[0] || null;
}

function findByRef(data, ref, activeOnly = false) {
  if (data.reviews[ref] && (!activeOnly || ACTIVE_REVIEW_STATES.has(data.reviews[ref].status))) {
    return data.reviews[ref];
  }
  const absPath = resolvePathBestEffort(ref);
  return findByPath(data, absPath, activeOnly);
}

async function listReviews(options = {}) {
  const data = readReviewData(options);
  return sortNewestFirst(Object.values(data.reviews).filter(Boolean));
}

async function getReviewById(id, options = {}) {
  return readReviewData(options).reviews[id] || null;
}

async function getReviewByPath(inputPath, options = {}) {
  const absPath = resolvePathBestEffort(inputPath);
  return findByPath(readReviewData(options), absPath, !!options.activeOnly);
}

async function mutateReviews(mutator, options = {}) {
  ensureDataDir(options);
  const reviewsFile = getPaths(options).reviews;
  return mutateJson(reviewsFile, emptyReviews, mutator, {
    mode: 0o600,
    validate: validateReviewData,
    lock: options.lock,
  });
}

async function mutateReviewById(ref, mutator, options = {}) {
  if (!ref) throwNotFound(ref);
  return mutateReviews((data) => {
    const review = data.reviews[ref];
    if (!review) throwNotFound(ref);
    return mutator(review, data);
  }, options);
}

async function openReview(inputPath, options = {}) {
  const absPath = normalizeMdPath(inputPath);
  return withReviewTransaction(absPath, async () => {
    // 用户正在回稿里普通编辑这篇文档时不得冻结它(跨端规则第 8 节);登记由本地服务维护。
    const editing = require('./documents').isEditing(absPath, options);
    if (editing) {
      throw new ReviewStoreError('USER_EDITING', '用户正在回稿里编辑这篇文档,未冻结、未创建审阅会话。等用户退出编辑后再试。', {
        httpStatus: 409, details: { absPath, since: editing.since },
      });
    }
    const sourceHash = sha256File(absPath);
    const now = new Date().toISOString();
    const data = readReviewData(options);
    const active = findByPath(data, absPath, true);
    let recovered = false;
    if (active) {
      if (active.status === 'applying') {
        // 本轮正在改稿(用户手工修改,或 Agent 已 begin-apply):文件内容变化是预期行为,
        // 不判冲突、不自动结束、不开新一轮;由调用方提示"先把这一轮走完"。
        const result = await mutateReviews((inner) => {
          const current = findByPath(inner, absPath, true);
          current.lastOpenedAt = now;
          return { review: { ...current }, reused: true };
        }, options);
        return result;
      }
      const conflicted = active.status === 'conflict' || sourceHash !== active.sourceHash;
      if (!conflicted) {
        return mutateReviews((inner) => {
          const current = findByPath(inner, absPath, true);
          current.lastOpenedAt = now;
          // 再次 open 也算一次"推到手机"的请求(跨端规则第 2.1 节:open 即自动推)
          current.sync = { ...(current.sync || { state: 'never' }), pushRequestedAt: now };
          return { review: { ...current }, reused: true };
        }, options);
      }
      // 旧一轮的批注仍有 open 时必须保护,维持冲突;全部处理完则没有可保护
      // 的内容,自动结束旧会话并按当前内容开启新一轮(典型场景:Agent 改完
      // 稿但漏跑 begin-apply/complete,重新打开时自愈,无需人工 unlock)。
      if (countOpenAnnotations(absPath) > 0) {
        const result = await mutateReviews((inner) => ({ conflict: sourceConflict(findByPath(inner, absPath, true), sourceHash) }), options);
        throwConflict(result.conflict);
      }
      // 自动结束旧轮也是终态:先固化载荷(当前文件就是完成稿),固化不了就不结束、不开新轮
      if (active.docId && active.versionId) await versions().stageTerminal(active, 'review', memberAnnotations(active), options);
      await mutateReviews((inner) => {
        const current = findByPath(inner, absPath, true);
        const previousStatus = current.status;
        current.status = 'complete';
        current.completedAt = now;
        current.finalHash = sourceHash;
        current.autoClosedReason = `批注已全部处理,重新打开时自动结束旧会话(原状态 ${previousStatus})`;
        return { ...current };
      }, options);
      if (active.docId && active.versionId) await versions().publishBestEffort(active.docId, active.versionId, options);
      recovered = true;
    }
    // 文档标识与轮次(跨端规则第 3、12 节;规则⑤第 2 节):身份与轮号从文档索引单调分配,手机只认 docId,不认路径
    const lineage = sortNewestFirst(Object.values(readReviewData(options).reviews).filter((item) => item && item.absPath === absPath && item.docId));
    const { docId, round } = await versions().allocateRound(absPath, lineage, options);
    const id = `r${crypto.randomBytes(12).toString('hex')}`;
    const review = {
      id,
      docId,
      round,
      absPath,
      file: path.basename(absPath),
      sourceHash,
      status: 'reviewing',
      createdAt: now,
      lastOpenedAt: now,
      sync: { state: 'never', pushRequestedAt: now },
    };
    // 冻结即留底(规则⑤第 4 节):留不下就不建会话,不留一个没底的轮次
    const captured = await versions().captureOriginal(review, options);
    review.versionId = captured.versionId;
    await mutateReviews((inner) => { inner.reviews[id] = review; return null; }, options);
    return { review: { ...review }, reused: false, recovered };
  }, options);
}

function sourceConflict(review, currentHash, reason) {
  const now = new Date().toISOString();
  review.status = 'conflict';
  review.conflictAt = now;
  review.conflictHash = currentHash || null;
  review.conflictReason = reason || '源文档内容已变化';
  return {
    code: 'SOURCE_CONFLICT',
    message: '源文档在审阅期间已发生变化，已停止保存并标记为 conflict。',
    review: { ...review },
  };
}

function currentHashOrNull(absPath) {
  try { return sha256File(absPath); } catch { return null; }
}

function throwStateError(message, review) {
  throw new ReviewStoreError('INVALID_STATE', message, {
    httpStatus: 409, details: { review },
  });
}

function throwNotFound(ref) {
  throw new ReviewStoreError('REVIEW_NOT_FOUND', `找不到审阅会话: ${ref}`, {
    httpStatus: 404, details: { ref },
  });
}

function throwConflict(conflict) {
  throw new ReviewStoreError(conflict.code, conflict.message, {
    httpStatus: 409, details: { review: conflict.review },
  });
}

async function assertReviewUnchanged(ref, options = {}) {
  const result = await mutateReviews((data) => {
    const review = findByRef(data, ref, true);
    if (!review) throwNotFound(ref);
    const currentHash = currentHashOrNull(review.absPath);
    if (!currentHash || currentHash !== review.sourceHash) {
      return { conflict: sourceConflict(review, currentHash) };
    }
    return { review: { ...review } };
  }, options);
  if (result.conflict) throwConflict(result.conflict);
  return result.review;
}

async function markConflict(ref, reason, options = {}) {
  const result = await mutateReviews((data) => {
    const review = findByRef(data, ref, true);
    if (!review) throwNotFound(ref);
    return sourceConflict(review, currentHashOrNull(review.absPath), reason);
  }, options);
  return result.review;
}

async function submitReview(ref, options = {}) {
  const initial = findByRef(readReviewData(options), ref, true);
  if (!initial) throwNotFound(ref);
  return withReviewTransaction(initial.absPath, async () => {
    const review = findByRef(readReviewData(options), ref, true);
    if (!review) throwNotFound(ref);
    if (review.status !== 'reviewing') {
      throwStateError(`只有 reviewing 状态可以提交，当前为 ${review.status}。`, review);
    }
    // 冻结只是应用协议,照样实时校验正文指纹
    const currentHash = currentHashOrNull(review.absPath);
    if (!currentHash || currentHash !== review.sourceHash) {
      const result = await mutateReviews((data) => ({ conflict: sourceConflict(findByRef(data, ref, true), currentHash) }), options);
      throwConflict(result.conflict);
    }
    // 本轮成员在交出时固定(规则⑤第 7.1 节);之后新加的批注留待下一轮
    const members = memberAnnotations(review).filter((note) => annotationStatus(note) === 'open');
    const openCount = members.length;
    const archived = Boolean(review.docId && review.versionId);
    if (archived) {
      // 原稿留底不在就阻断交出(批注已在旁注文件里,不会丢;可重试)
      await versions().verifyOriginal(review, options);
      await versions().recordMembers(review, members, options);
      if (openCount === 0) await versions().stageTerminal({ ...review, memberAnnotationIds: [] }, 'approved', [], options);
    }
    const result = await mutateReviews((data) => {
      const current = findByRef(data, ref, true);
      if (!current || current.status !== 'reviewing') throwStateError('会话状态已变化,请重试。', current);
      const now = new Date().toISOString();
      current.submittedAt = now;
      current.memberAnnotationIds = members.map((note) => note.id);
      if (openCount === 0) {
        current.status = 'complete';
        current.approved = true;
        current.outcome = 'approved';
        current.approvedAt = now;
        current.completedAt = now;
        current.finalHash = currentHash;
      } else {
        current.status = 'ready_to_apply';
      }
      return { review: { ...current }, openCount };
    }, options);
    if (archived && openCount === 0) await versions().publishBestEffort(review.docId, review.versionId, options);
    return result;
  }, options);
}

async function beginApply(inputPath, options = {}) {
  const absPath = normalizeMdPath(inputPath);
  const applyMode = options.applyMode === undefined ? 'agent' : String(options.applyMode);
  if (!['agent', 'manual'].includes(applyMode)) {
    throw new ReviewStoreError('INVALID_APPLY_MODE', `改稿模式无效: ${applyMode}`, {
      httpStatus: 400, details: { allowed: ['agent', 'manual'] },
    });
  }
  const defaultActor = applyMode === 'manual' ? 'user' : 'agent';
  const applyActor = options.applyActor === undefined ? defaultActor : String(options.applyActor).trim();
  if (!applyActor || applyActor.length > 80) {
    throw new ReviewStoreError('INVALID_APPLY_ACTOR', 'applyActor 必须是 1-80 字符的非空文本。', {
      httpStatus: 400,
    });
  }
  return withReviewTransaction(absPath, async () => {
    const result = await mutateReviews((data) => {
      const review = findByPath(data, absPath, true);
      if (!review) throwNotFound(absPath);
      if (options.expectedReviewId && review.id !== options.expectedReviewId) {
        throw new ReviewStoreError('REVIEW_SESSION_MISMATCH',
          `当前活动会话为 ${review.id}，不是请求的 ${options.expectedReviewId}。`, {
            httpStatus: 409, details: { expectedReviewId: options.expectedReviewId, review: { ...review } },
          });
      }
      if (review.status !== 'ready_to_apply') {
        throwStateError(`只有 ready_to_apply 状态可以开始改稿，当前为 ${review.status}。`, review);
      }
      const currentHash = currentHashOrNull(review.absPath);
      if (!currentHash || currentHash !== review.sourceHash) {
        return { conflict: sourceConflict(review, currentHash) };
      }
      review.status = 'applying';
      review.applyStartedAt = new Date().toISOString();
      review.applyMode = applyMode;
      review.applyActor = applyActor;
      // begin-apply 成功就是"领取"(规划 v3 规则②):没先 claim 也算领了
      if (applyMode === 'agent' && !review.claimedAt) {
        review.claimedAt = review.applyStartedAt;
        review.claimedBy = applyActor;
      }
      return { review: { ...review } };
    }, options);
    if (result.conflict) throwConflict(result.conflict);
    return result.review;
  }, options);
}

// 刚建的轮次(还在 reviewing、没有任何批注)可以撤掉:给「开轮 + 存第一条批注」这个组合用,批注没存成就不留空轮。
// 文档索引里分配出去的轮号不收回(轮号只增不减,跳号无害);版本目录一并删除。
async function discardFreshReview(reviewId, options = {}) {
  const review = findByRef(readReviewData(options), reviewId, false);
  if (!review) return false;
  return withReviewTransaction(review.absPath, async () => {
    const current = findByRef(readReviewData(options), reviewId, false);
    if (!current || current.status !== 'reviewing') return false;
    const hasNotes = memberAnnotations(current).length > 0;
    if (hasNotes) return false;
    await mutateReviews((data) => { delete data.reviews[reviewId]; return null; }, options);
    if (current.docId && current.versionId) {
      try { fs.rmSync(versions().versionDir(current.docId, current.versionId, options), { recursive: true, force: true }); } catch {}
    }
    return true;
  }, options);
}

// 智能体明确领取本轮(规划 v3 规则②):只有"已交出"的会话能领;领了之后界面才显示"AI 正在修改"。
// 领取是记在会话上的事实,不靠 wait 进程活着;重复领取只更新领取人与时间。
async function claimReview(inputPath, options = {}) {
  const absPath = normalizeMdPath(inputPath);
  const agent = String(options.agent === undefined ? 'agent' : options.agent).trim().slice(0, 80) || 'agent';
  return withReviewTransaction(absPath, () => mutateReviews((data) => {
    const review = findByPath(data, absPath, true);
    if (!review) throwNotFound(absPath);
    if (options.expectedReviewId && review.id !== options.expectedReviewId) {
      throw new ReviewStoreError('REVIEW_SESSION_MISMATCH',
        `当前活动会话为 ${review.id}，不是请求的 ${options.expectedReviewId}。`, {
          httpStatus: 409, details: { expectedReviewId: options.expectedReviewId, review: { ...review } },
        });
    }
    if (review.status === 'applying' && review.applyMode !== 'manual') return { ...review }; // 已在改,领取是多余的
    if (review.status !== 'ready_to_apply') {
      throwStateError(`只有用户已交出批注(ready_to_apply)的会话可以领取，当前为 ${review.status}。`, review);
    }
    review.claimedAt = new Date().toISOString();
    review.claimedBy = agent;
    return { ...review };
  }, options), options);
}

async function completeReview(inputPath, options = {}) {
  const absPath = normalizeMdPath(inputPath);
  return withReviewTransaction(absPath, async () => {
    const review = findByPath(readReviewData(options), absPath, true);
    if (!review) throwNotFound(absPath);
    if (options.expectedReviewId && review.id !== options.expectedReviewId) {
      throw new ReviewStoreError('REVIEW_SESSION_MISMATCH',
        `当前活动会话为 ${review.id}，不是请求的 ${options.expectedReviewId}。`, {
          httpStatus: 409, details: { expectedReviewId: options.expectedReviewId, review: { ...review } },
        });
    }
    if (review.status !== 'applying') {
      throwStateError(`只有 applying 状态可以完成改稿，当前为 ${review.status}。`, review);
    }
    if (options.expectedApplyMode && review.applyMode !== options.expectedApplyMode) {
      throwStateError(
        `只有 ${options.expectedApplyMode} 改稿模式可以从此入口完成，当前为 ${review.applyMode || 'unknown'}。`,
        review,
      );
    }
    const openCount = countOpenForReview(review);
    if (openCount > 0) {
      throw new ReviewStoreError('OPEN_ANNOTATIONS', `仍有 ${openCount} 条 open 批注，不能完成审阅。`, {
        httpStatus: 409, details: { review: { ...review }, openCount },
      });
    }
    const summary = typeof options.summary === 'string' && options.summary.trim() ? options.summary.trim() : review.summary;
    // 终态第一步:固化完成稿与处理结果(规则⑤第 4 节);写不下就不推进终态,智能体重试 complete 即可。
    // 独立手工修改轮没有发生任何写入时没有 versionId → 不产生事件。旧会话(上线前)没有留底 → 跳过。
    const kind = review.applyMode === 'manual' && review.round === 'manual-edit' ? 'manual' : 'review';
    const archived = Boolean(review.docId && review.versionId);
    if (archived) await versions().stageTerminal({ ...review, summary }, kind, memberAnnotations(review), options);
    const completed = await mutateReviews((data) => {
      const current = findByPath(data, absPath, true);
      if (!current || current.status !== 'applying') throwStateError('会话状态已变化,请重试。', current);
      current.status = 'complete';
      current.completedAt = new Date().toISOString();
      current.finalHash = sha256File(current.absPath);
      // 改稿摘要(跨端规则第 7 节):随新版一起推到手机,告诉用户这一轮改了什么、哪些没采纳
      if (summary) current.summary = summary;
      return { ...current };
    }, options);
    if (archived) await versions().publishBestEffort(review.docId, review.versionId, options);
    return completed;
  }, options);
}

// 用户在 App 里点「定稿并关闭」:本轮已 complete 的会话记为 finalized,
// 让后台挂着的 mdreview wait 得到"审阅结束"信号,智能体据此停止等待。
async function finalizeReview(ref, options = {}) {
  const initial = findByRef(readReviewData(options), ref, false);
  if (!initial) throwNotFound(ref);
  return withReviewTransaction(initial.absPath, () => mutateReviews((data) => {
      const review = findByRef(data, ref, false);
      if (!review) throwNotFound(ref);
      if (review.status !== 'complete') {
        throwStateError(`只有 complete 状态可以定稿，当前为 ${review.status}。`, review);
      }
      const active = findByPath(data, review.absPath, true);
      if (active && active.id !== review.id) {
        throwStateError(`文档已有新的活动会话(${active.id}),请在最新一轮里定稿。`, review);
      }
      const now = new Date().toISOString();
      review.outcome = 'finalized';
      review.finalized = true;
      review.finalizedAt = now;
      return { ...review };
    }, options), options);
}

// 用户在 complete/cancelled 之后进入编辑模式:直接开一轮 applying/manual 的
// "手工修改轮",把写者身份记进会话——智能体此时 mdreview open 会看到用户正在改,
// 不会把文档重新冻结、把用户踢出编辑器。
async function beginManualEdit(inputPath, options = {}) {
  const absPath = normalizeMdPath(inputPath);
  return withReviewTransaction(absPath, async () => {
    const sourceHash = sha256File(absPath);
    const now = new Date().toISOString();
    // 独立手工修改轮也有文档身份(规则⑤第 2 节);原稿在第一次受控写入前留底(document-service),没写就不产生事件
    const lineage = sortNewestFirst(Object.values(readReviewData(options).reviews).filter((item) => item && item.absPath === absPath && item.docId));
    const manualDocId = await versions().ensureDocId(absPath, lineage, options);
    return mutateReviews((data) => {
      const active = findByPath(data, absPath, true);
      if (active) {
        if (active.status === 'applying' && active.applyMode === 'manual') return { ...active };
        throwStateError(`文档已有活动审阅会话(${active.status}),不能开始手工修改。`, active);
      }
      if (countOpenAnnotations(absPath) > 0) {
        throw new ReviewStoreError('OPEN_ANNOTATIONS', '仍有 open 批注,请先在审阅轮里处理。', { httpStatus: 409 });
      }
      const id = `r${crypto.randomBytes(12).toString('hex')}`;
      const review = {
        id,
        docId: manualDocId,
        absPath,
        file: path.basename(absPath),
        sourceHash,
        status: 'applying',
        applyMode: 'manual',
        applyActor: options.applyActor || '我(本机)',
        round: 'manual-edit',
        createdAt: now,
        lastOpenedAt: now,
        submittedAt: now,
        applyStartedAt: now,
      };
      data.reviews[id] = review;
      return { ...review };
    }, options);
  }, options);
}

async function unlockReview(inputPath, reason, options = {}) {
  if (!reason || !String(reason).trim()) {
    throw new ReviewStoreError('REASON_REQUIRED', '人工解锁必须提供 --reason。', { httpStatus: 400 });
  }
  const absPath = resolvePathBestEffort(inputPath);
  return withReviewTransaction(absPath, async () => {
    const now = new Date().toISOString();
    const text = String(reason).trim();
    const existing = findByPath(readReviewData(options), absPath, true);
    if (!existing) throwNotFound(absPath);
    // 作废也是终态:固化当时的成员(就是此刻 open 的那些),写不下就不作废
    if (existing.docId && existing.versionId) {
      const members = memberAnnotations(existing).filter((note) => annotationStatus(note) === 'open');
      await versions().stageTerminal({ ...existing, memberAnnotationIds: members.map((note) => note.id) }, 'cancelled', members, options);
    }
    const review = await mutateReviews((data) => {
      const active = findByPath(data, absPath, true);
      if (!active) throwNotFound(absPath);
      active.status = 'cancelled';
      active.cancelledAt = now;
      active.cancelReason = text;
      return { ...active };
    }, options);
    // 这一轮没处理完的 open 批注随会话一起作废(保留在 sidecar 里能看),否则之后进不了手工修改、完成也会被卡
    if (fs.existsSync(sidecarFor(absPath))) {
      await mutateAnnotations(absPath, (data) => {
        for (const annotation of data.annotations) {
          if (annotationStatus(annotation) !== 'open') continue;
          if (annotation.reviewSessionId && annotation.reviewSessionId !== review.id) continue;
          annotation.status = 'cancelled';
          annotation.cancelledAt = now;
          annotation.cancelReason = `会话人工解锁: ${text}`;
        }
      }, options);
    }
    if (existing.docId && existing.versionId) await versions().publishBestEffort(existing.docId, existing.versionId, options);
    return review;
  }, options);
}

// 启动时清理审阅索引:文件已不存在的会话(活动的且一天没碰过 → 取消;已结束的 → 删),结束超过 90 天的会话删掉。
// 索引会无限增长(实测 349 条、102 条指向已删文件),不清理每次读写都变慢。
const PRUNE_FINISHED_DAYS = 90;
function prunePlan(data, now) {
  const stale = (review) => now - Date.parse(review.lastOpenedAt || review.createdAt || 0) > 24 * 60 * 60 * 1000;
  const finishedAt = (review) => Date.parse(review.finalizedAt || review.completedAt || review.cancelledAt || review.lastOpenedAt || review.createdAt || 0);
  const remove = [];
  const cancel = [];
  for (const [id, review] of Object.entries(data.reviews)) {
    if (!review || typeof review !== 'object') { remove.push(id); continue; }
    const active = ACTIVE_REVIEW_STATES.has(review.status);
    const exists = typeof review.absPath === 'string' && fs.existsSync(review.absPath);
    if (!exists) {
      if (active) { if (stale(review)) cancel.push(id); } else remove.push(id);
      continue;
    }
    if (!active && now - finishedAt(review) > PRUNE_FINISHED_DAYS * 24 * 60 * 60 * 1000) remove.push(id);
  }
  return { remove, cancel };
}
async function pruneReviews(options = {}) {
  const now = Date.now();
  // 先不加锁看一遍:没什么可清就不碰索引文件(服务一启动就写索引,会和刚起的测试夹具、备份工具抢文件)
  const preview = prunePlan(readReviewData(options), now);
  if (!preview.remove.length && !preview.cancel.length) return { removed: 0, cancelled: 0 };
  const summary = { removed: 0, cancelled: 0 };
  await mutateReviews((data) => {
    const plan = prunePlan(data, now);
    for (const id of plan.remove) { delete data.reviews[id]; summary.removed += 1; }
    for (const id of plan.cancel) {
      const review = data.reviews[id];
      review.status = 'cancelled';
      review.cancelledAt = new Date(now).toISOString();
      review.cancelReason = '文件已不存在(启动时清理)';
      summary.cancelled += 1;
    }
    return summary;
  }, options);
  return summary;
}

function readPort(options = {}) {
  const portFile = getPaths(options).port;
  let raw;
  try { raw = fs.readFileSync(portFile, 'utf8').trim(); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

async function writePort(port, options = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ReviewStoreError('INVALID_PORT', `端口无效: ${port}`, { httpStatus: 400 });
  }
  ensureDataDir(options);
  const portFile = getPaths(options).port;
  return withFileLock(portFile, () => atomicWriteFile(portFile, `${port}\n`, { mode: 0o600 }));
}

module.exports = {
  APPLY_HINT,
  ACTIVE_REVIEW_STATES,
  pruneReviews,
  TERMINAL_REVIEW_STATES,
  ReviewStoreError,
  getDataDir,
  getPaths,
  ensureDataDir,
  readJsonStrict,
  atomicWriteFile,
  atomicWriteJson,
  withFileLock,
  withReviewTransaction,
  mutateJson,
  sha256File,
  normalizeMdPath,
  resolvePathBestEffort,
  sidecarFor,
  annotationStatus,
  readAnnotations,
  mutateAnnotations,
  countOpenAnnotations,
  countOpenForReview,
  memberAnnotations,
  listReviews,
  getReviewById,
  getReviewByPath,
  mutateReviews,
  mutateReviewById,
  finalizeReview,
  beginManualEdit,
  openReview,
  submitReview,
  beginApply,
  completeReview,
  claimReview,
  discardFreshReview,
  unlockReview,
  assertReviewUnchanged,
  markConflict,
  readPort,
  writePort,
};
