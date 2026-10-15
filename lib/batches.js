'use strict';
/*
 * 手机批注批次导入(跨端规则 v2.3 第 6 节;版本记录设计 v4 第 7 节)。同步层无关:
 * CloudKit 的批次由同步模块调用 importBatch;手机独立文件导出的 .draftback-batch.json 只能显式转为本轮新批注。
 *
 * 接收顺序(每一步不过就拒收、写回执、不动 sidecar 不改状态):
 *   1. 批次编号已有定稿回执 → 原样返回;有未完成的导入记录 → 先按记录收敛(崩溃重放)。
 *   2. 身份:version 2,外层与每条批注都带 { docId, reviewId, baseVersion } 且一致;缺 → missing-identity。
 *   3. 按 docId 定位文档;有 docId 禁止跨文档按指纹 / 文件名回退;找不到 → no-session。
 *   4. 对照最新一轮(含终态)的身份:不是最新一轮 → round-advanced(指纹相同也拒)。
 *   5. 会话仍在批注中(否则 session-advanced)。
 *   6. 版本指纹与 Mac 实际文件一致(否则 version-mismatch)。
 *   7. 同一把文档锁、同一个可恢复事务:先落导入记录(目标身份、输入、算好的接受 / 跳过列表),
 *      再写旁注、固定成员并交出(锁内版本的 submitReview)、定稿回执。重放按记录补齐阶段,不重算结果。
 * 回执存在 <数据目录>/receipts/<batchId>.json,导入记录在 <数据目录>/imports/<batchId>.json。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./review-store');

const { ReviewStoreError } = store;
const IDENTITY_KEYS = ['docId', 'reviewId', 'baseVersion'];

function receiptsDir(options = {}) {
  const dir = path.join(store.getDataDir(options), 'receipts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function importsDir(options = {}) {
  const dir = path.join(store.getDataDir(options), 'imports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function isSafeId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value); }
function isHash(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value); }

function readBatchFile(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new ReviewStoreError('BATCH_UNREADABLE', `批次文件无法读取或不是 JSON: ${file}`, { httpStatus: 400, cause: error });
  }
  return validateBatch(parsed);
}

const INTENTS = new Set(['next-round', 'finalize']);
const TERMINAL_STATUSES = new Set(['complete', 'cancelled']);

/**
 * 结构校验:坏结构整批抛错(不能让智能体拿半份批注改稿);身份是否齐全在 importBatch 里判,拒收而不是抛错。
 * 版本(跨端规则 v2.4 第 6.9 条):1 = 手机独立文件;2 = 逐条身份;3 = 带意图(next-round / finalize)。
 * 意图只在 version 3:version 3 必带已知意图,version 2 带意图也算无效——旧 Mac 不认 3 会整批拒收,不会把意图当普通交出。
 */
function validateBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) throw new ReviewStoreError('BATCH_INVALID', '批次必须是 JSON 对象。', { httpStatus: 400 });
  if (batch.version !== 1 && batch.version !== 2 && batch.version !== 3) throw new ReviewStoreError('BATCH_INVALID', `不支持的批次版本: ${batch.version}`, { httpStatus: 400 });
  if (!isSafeId(batch.batchId)) throw new ReviewStoreError('BATCH_INVALID', '批次缺少有效的 batchId。', { httpStatus: 400 });
  if (!isHash(batch.baseVersion)) throw new ReviewStoreError('BATCH_INVALID', '批次缺少有效的 baseVersion(SHA-256)。', { httpStatus: 400 });
  if (!Array.isArray(batch.annotations)) throw new ReviewStoreError('BATCH_INVALID', '批次缺少 annotations 数组(载荷不完整,整批拒绝)。', { httpStatus: 400 });
  for (const note of batch.annotations) {
    if (!note || typeof note !== 'object' || typeof note.id !== 'string' || !note.id || typeof note.comment !== 'string' || !note.comment.trim()) {
      throw new ReviewStoreError('BATCH_INVALID', '批次里有批注缺少 id 或 comment,整批拒收(不能让智能体拿半份批注改稿)。', { httpStatus: 400 });
    }
  }
  const hasIntent = batch.intent !== undefined && batch.intent !== null;
  if (batch.version === 3) {
    if (!INTENTS.has(batch.intent)) throw new ReviewStoreError('BATCH_INVALID', `version 3 批次的意图无效: ${batch.intent}`, { httpStatus: 400 });
    if (batch.intent === 'finalize' && batch.annotations.length) throw new ReviewStoreError('BATCH_INVALID', '定稿请求不能带批注。', { httpStatus: 400 });
    if (batch.intent === 'next-round') {
      if (!batch.annotations.length) throw new ReviewStoreError('BATCH_INVALID', '开下一轮的批次至少要有一条批注。', { httpStatus: 400 });
      if (batch.annotations.some((note) => note.intent !== 'next-round')) {
        throw new ReviewStoreError('BATCH_INVALID', '开下一轮的批次只能带"为下一轮写的"批注(旧批注要先复制到本轮)。', { httpStatus: 400 });
      }
    }
  } else if (hasIntent) {
    throw new ReviewStoreError('BATCH_INVALID', `version ${batch.version} 批次不能带意图(带意图的是 version 3)。`, { httpStatus: 400 });
  }
  return batch;
}

/** 身份是否齐全:version 2 / 3、外层三项、每条批注三项且与外层一致 */
function identityProblem(batch) {
  if (batch.version !== 2 && batch.version !== 3) return `批次协议是 version ${batch.version},需要 version 2 或 3(逐条带身份)`;
  if (!batch.docId || typeof batch.docId !== 'string') return '批次缺少 docId';
  if (!batch.reviewId || typeof batch.reviewId !== 'string') return '批次缺少 reviewId';
  for (const note of batch.annotations) {
    for (const key of IDENTITY_KEYS) {
      if (typeof note[key] !== 'string' || !note[key]) return `批注 ${note.id} 缺少 ${key}`;
    }
    if (note.docId !== batch.docId || note.reviewId !== batch.reviewId || note.baseVersion.toLowerCase() !== batch.baseVersion.toLowerCase()) {
      return `批注 ${note.id} 的身份与批次外层不一致(可能是旧轮的批注被打包进了新轮)`;
    }
  }
  return null;
}

function receiptPath(batchId, options) { return path.join(receiptsDir(options), `${batchId}.json`); }
function importPath(batchId, options) { return path.join(importsDir(options), `${batchId}.json`); }

function readReceipt(batchId, options = {}) {
  try { return store.readJsonStrict(receiptPath(batchId, options)); } catch { return null; }
}
async function writeReceipt(receipt, options = {}) {
  await store.atomicWriteJson(receiptPath(receipt.batchId, options), receipt, { mode: 0o600 });
  return receipt;
}
function readImport(batchId, options = {}) {
  try { return store.readJsonStrict(importPath(batchId, options)); } catch { return null; }
}
async function writeImport(record, options = {}) {
  await store.atomicWriteJson(importPath(record.batchId, options), record, { mode: 0o600 });
  return record;
}
function removeImport(batchId, options = {}) {
  try { fs.unlinkSync(importPath(batchId, options)); } catch {}
}
/** 这篇文档有没有未收敛的导入记录(有就不得改稿、不得开新轮) */
function pendingImportFor(absPath, options = {}) {
  let names = [];
  try { names = fs.readdirSync(importsDir(options)).filter((name) => name.endsWith('.json')); } catch { return null; }
  for (const name of names) {
    const record = readImport(name.slice(0, -5), options);
    if (record && record.absPath === absPath && record.stage !== 'done') return record;
  }
  return null;
}

/** 别的入口(写批注、开轮、领取、定稿……)动手前调用:这篇有在途的导入就先收敛它(锁外调用) */
async function settlePendingImportFor(absPath, options = {}) {
  const record = pendingImportFor(absPath, options);
  if (!record) return null;
  return resumeImport(record, options);
}

function rejected(batch, reason, message, extra = {}) {
  return {
    batchId: batch.batchId, accepted: false, reason, message, receivedAt: new Date().toISOString(),
    batchDocId: batch.docId || null, batchReviewId: batch.reviewId || null, baseVersion: String(batch.baseVersion || '').toLowerCase(),
    intent: batch.intent || null,
    ...extra,
  };
}

/** 按 docId 找这篇文档最新的一轮(含终态、我自己改、恢复):与推送同一个定义(review-store.latestReviewOf) */
async function latestReviewForDoc(docId, options = {}) {
  const reviews = (await store.listReviews(options)).filter((review) => review && review.docId === docId);
  return store.latestReviewOf(reviews);
}

/** 已有定稿回执:原样返回,先收掉残留的导入日志(回执是提交点) */
async function reuseReceipt(prior, options) {
  removeImport(prior.batchId, options);
  return { receipt: { ...prior, reused: true }, review: prior.reviewId ? await store.getReviewById(prior.reviewId, options) : null };
}

/**
 * 导入一个批次。返回 { receipt, review, documentKnown }。拒收不抛错(回执里说明原因);结构损坏才抛错。
 * options.asNewNotes + options.documentPath:把没有身份的旧批次转为指定文档当前轮的新批注(显式入口)。
 * 所有接受 / 拒收都在这篇文档的锁里判断与落回执(跨端规则 v2.4 第 6.9 条「所有批次共用的入口规则」)。
 */
async function importBatch(batch, options = {}) {
  validateBatch(batch);
  if (options.asNewNotes) return convertToNewNotes(batch, options);

  // 1. 已有定稿回执 → 原样返回;未收敛的导入记录 → 先收敛
  const prior = readReceipt(batch.batchId, options);
  if (prior) return reuseReceipt(prior, options);
  const pending = readImport(batch.batchId, options);
  if (pending && pending.stage !== 'done') return resumeImport(pending, options);

  // 2. 身份(同一批次内容固定,结论也固定;这类批次从不会被接受,不存在覆盖接受回执的问题)
  const problem = identityProblem(batch);
  if (problem) {
    const receipt = rejected(batch, 'missing-identity', `批次缺少轮次身份(${problem}),未写入。请更新手机上的回稿后重新提交。`);
    const documentKnown = Boolean(batch.docId) && (await store.listReviews(options)).some((item) => item && item.docId === batch.docId);
    return { receipt: documentKnown ? await writeReceipt(receipt, options) : receipt, review: null, documentKnown };
  }

  // 3. 定位文档(不跨文档回退)
  const located = await latestReviewForDoc(batch.docId, options);
  if (!located) {
    // 这类拒收不落盘:这台 Mac 从没见过这个文档标识(别的电脑发起的审阅),同步程序据此不回执、不打扰手机
    return { receipt: rejected(batch, 'no-session', 'Mac 上没有这个文档标识对应的审阅会话:从未在这台 Mac 上发起审阅。'), review: null, documentKnown: false };
  }
  return store.withReviewTransaction(located.absPath, () => decideLocked(batch, options), options);
}

async function decideLocked(batch, options) {
  // 锁内复查:同一批次并发重投,后到的直接拿已定稿回执或接着在途记录走,不得把接受回执覆盖成拒收
  const lockedPrior = readReceipt(batch.batchId, options);
  if (lockedPrior) return reuseReceipt(lockedPrior, options);
  const lockedPending = readImport(batch.batchId, options);
  if (lockedPending && lockedPending.stage !== 'done') return finishImport(lockedPending, options);
  // 别的批次在这篇文档上还没收敛:先收敛它,再判这一批(否则会越过它)
  let latest = await latestReviewForDoc(batch.docId, options);
  const other = latest ? pendingImportFor(latest.absPath, options) : null;
  if (other && other.batchId !== batch.batchId) {
    await finishImport(other, options);
    latest = await latestReviewForDoc(batch.docId, options);
  }
  // 4. 最新一轮的身份
  if (!latest || latest.id !== batch.reviewId) {
    const round = latest && Number.isInteger(latest.round) ? `第 ${latest.round} 轮` : '新的一轮';
    const receipt = rejected(batch, 'round-advanced',
      `轮次已推进:这批批注对应第 ${roundLabel(batch, latest)} 轮,Mac 上已是${round},请在手机上打开最新一轮再提交。`,
      { reviewId: latest ? latest.id : null, latestRound: latest && Number.isInteger(latest.round) ? latest.round : null });
    return { receipt: await writeReceipt(receipt, options), review: latest };
  }
  if (batch.intent === 'next-round') return beginNextRound(batch, latest, options);
  if (batch.intent === 'finalize') return beginFinalize(batch, latest, options);

  // 5. 状态(普通 version 2 交出)
  const current = latest;
  if (current.status !== 'reviewing') {
    const receipt = rejected(batch, 'session-advanced', `会话已不在批注中(当前 ${current.status}),这批批注未被采用,请在下一轮重新提交。`, { reviewId: current.id });
    return { receipt: await writeReceipt(receipt, options), review: current };
  }
  // 6. 实际文件指纹
  let actualHash = null;
  try { actualHash = store.sha256File(current.absPath); } catch {}
  const base = batch.baseVersion.toLowerCase();
  if (!actualHash || actualHash !== base || current.sourceHash !== base) {
    const receipt = rejected(batch, 'version-mismatch', '手机批注所依据的版本与 Mac 当前原文不一致,未写入。', { reviewId: current.id, currentVersion: actualHash || current.sourceHash });
    return { receipt: await writeReceipt(receipt, options), review: current };
  }
  // 7. 导入记录 → 写旁注、固定成员并交出 → 定稿回执
  const record = {
    batchId: batch.batchId, docId: batch.docId, reviewId: current.id, absPath: current.absPath, baseVersion: base,
    device: batch.device || null, batch, ...splitAccepted(batch, current.absPath), stage: 'prepared', createdAt: new Date().toISOString(),
  };
  await writeImport(record, options);
  return finishImport(record, options);
}

function splitAccepted(batch, absPath) {
  const existing = new Set(store.readAnnotations(absPath).annotations.map((note) => note.id));
  const acceptedIds = [];
  const skippedIds = [];
  const seen = new Set();
  for (const note of batch.annotations) {
    if (existing.has(note.id) || seen.has(note.id)) { skippedIds.push(note.id); continue; }
    seen.add(note.id);
    acceptedIds.push(note.id);
  }
  return { acceptedIds, skippedIds };
}

function editingProblem(absPath, options) {
  const editing = require('./documents').isEditing(absPath, options);
  return editing ? ['user-editing', 'Mac 上正在编辑这篇文档,手机交来的这批没有采用。等 Mac 上退出编辑后再交。'] : null;
}
function hashProblem(absPath, base) {
  let actualHash = null;
  try { actualHash = store.sha256File(absPath); } catch {}
  return actualHash === base ? null : ['version-mismatch', 'Mac 上的原文和手机上看到的不一样了(改过),这批没有采用。先在 Mac 上看过。'];
}

/** next-round:刚结束那一轮(终态)之后开下一轮、收批注、交出;日志先落 reserved(预留新一轮的会话标识) */
async function beginNextRound(batch, latest, options) {
  if (!TERMINAL_STATUSES.has(latest.status)) {
    const receipt = rejected(batch, 'session-advanced', `这一轮还没结束(当前 ${latest.status}),不能从手机开下一轮。`, { reviewId: latest.id });
    return { receipt: await writeReceipt(receipt, options), review: latest };
  }
  const base = batch.baseVersion.toLowerCase();
  const problem = editingProblem(latest.absPath, options) || hashProblem(latest.absPath, base);
  if (problem) {
    const receipt = rejected(batch, problem[0], problem[1], { reviewId: latest.id });
    return { receipt: await writeReceipt(receipt, options), review: latest };
  }
  const record = {
    batchId: batch.batchId, docId: batch.docId, intent: 'next-round', previousReviewId: latest.id,
    reviewId: `r${crypto.randomBytes(12).toString('hex')}`, absPath: latest.absPath, baseVersion: base,
    device: batch.device || null, batch, ...splitAccepted(batch, latest.absPath), stage: 'reserved', createdAt: new Date().toISOString(),
  };
  await writeImport(record, options);
  return finishImport(record, options);
}

/** finalize:手机定稿;批注中且 Mac 上没有未处理批注时先零批注交出(记为通过)再定稿 */
async function beginFinalize(batch, latest, options) {
  const base = batch.baseVersion.toLowerCase();
  const problem = editingProblem(latest.absPath, options) || hashProblem(latest.absPath, base);
  if (problem) {
    const receipt = rejected(batch, problem[0], problem[1], { reviewId: latest.id });
    return { receipt: await writeReceipt(receipt, options), review: latest };
  }
  const open = store.readAnnotations(latest.absPath).annotations.filter((note) => store.annotationStatus(note) === 'open').length;
  if (open > 0 && !(latest.status === 'complete' && latest.outcome === 'finalized')) {
    const receipt = rejected(batch, 'has-open-notes', `Mac 上这篇还有 ${open} 条没处理的批注,这次没有定稿。先在 Mac 上处理,或让它们进下一轮。`, { reviewId: latest.id });
    return { receipt: await writeReceipt(receipt, options), review: latest };
  }
  let stage = null;
  if (latest.status === 'complete') stage = latest.outcome === 'finalized' ? 'finalized' : 'finalizing';
  else if (latest.status === 'reviewing') stage = 'approving';
  if (!stage) {
    const receipt = rejected(batch, 'session-advanced', latest.status === 'cancelled' ? '这一轮已作废,不能定稿。' : `这一轮当前 ${latest.status},不能定稿。`, { reviewId: latest.id });
    return { receipt: await writeReceipt(receipt, options), review: latest };
  }
  const record = {
    batchId: batch.batchId, docId: batch.docId, intent: 'finalize', reviewId: latest.id, absPath: latest.absPath, baseVersion: base,
    device: batch.device || null, batch, acceptedIds: [], skippedIds: [], stage, createdAt: new Date().toISOString(),
  };
  await writeImport(record, options);
  return finishImport(record, options);
}

/** next-round 重放时决定拒收:删掉本事务建的、没有会话引用的留底(轮号不回收) */
async function discardOrphanVersion(record, options) {
  if (await store.getReviewById(record.reviewId, options)) return;
  const found = require('./version-store').findVersionByReviewId(record.absPath, record.reviewId, options);
  if (!found) return;
  try { fs.rmSync(require('./version-store').versionDir(found.docId, found.versionId, options), { recursive: true, force: true }); } catch {}
}

function roundLabel(batch, latest) {
  const round = Number.isInteger(batch.round) ? batch.round : null;
  return round !== null ? round : `${String(batch.reviewId).slice(0, 8)}…`;
}

async function rejectRecord(record, reason, message, options) {
  const receipt = rejected(record.batch, reason, message, { reviewId: record.previousReviewId || record.reviewId });
  await writeReceipt(receipt, options);
  record.stage = 'done';
  await writeImport(record, options);
  removeImport(record.batchId, options);
  return { receipt, review: await latestReviewForDoc(record.docId, options) };
}

/** 导入记录的后半段(在文档锁内调用):每一步推进 stage,重放时跳过已完成的;接受回执是提交点 */
async function finishImport(record, options = {}) {
  if (record.intent === 'finalize') return finishFinalize(record, options);
  const { batch } = record;
  const now = new Date().toISOString();
  if (record.stage === 'reserved') {
    // next-round 开轮:按预留的会话标识找;没有才开(重新核对最新一轮、终态、编辑、指纹)
    if (!(await store.getReviewById(record.reviewId, options))) {
      const latest = await latestReviewForDoc(record.docId, options);
      let problem = null;
      if (!latest || latest.id !== record.previousReviewId) problem = ['round-advanced', 'Mac 上已经开了新的一轮,这批没有采用。请在手机上打开最新一轮再批。'];
      else if (!TERMINAL_STATUSES.has(latest.status)) problem = ['session-advanced', '这一轮还没结束,不能从手机开下一轮。'];
      else problem = editingProblem(record.absPath, options) || hashProblem(record.absPath, record.baseVersion);
      if (problem) {
        await discardOrphanVersion(record, options);
        return rejectRecord(record, problem[0], problem[1], options);
      }
      try {
        await store.openReviewLocked(record.absPath, { ...options, reserveReviewId: record.reviewId, openedByBatch: record.batchId, importBatchId: record.batchId });
      } catch (error) {
        if (error && error.code === 'USER_EDITING') {
          await discardOrphanVersion(record, options);
          return rejectRecord(record, 'user-editing', 'Mac 上正在编辑这篇文档,手机交来的这批没有采用。等 Mac 上退出编辑后再交。', options);
        }
        throw error; // 留着日志,下次重放接着来
      }
    }
    // 迟到批注接管单独做一步(幂等):开轮写了会话、接管之前崩溃,重放时会话已在,这一步也不能跳过
    await store.adoptLateNotes(record.absPath, record.reviewId, options);
    record.stage = 'prepared';
    await writeImport(record, options);
  }
  if (record.stage === 'prepared') {
    const accepted = new Set(record.acceptedIds);
    await store.mutateAnnotations(record.absPath, (data) => {
      const present = new Set(data.annotations.map((note) => note.id));
      for (const note of batch.annotations) {
        if (!accepted.has(note.id) || present.has(note.id)) continue;
        const copy = { ...note, status: 'open', reviewSessionId: record.reviewId, receivedBatchId: batch.batchId, receivedAt: now };
        delete copy.baseVersion; delete copy.docId; delete copy.reviewId; delete copy.intent;
        if (record.intent === 'next-round') copy.openedNextRoundFrom = record.previousReviewId;
        if (typeof copy.createdBy !== 'string') copy.createdBy = batch.device || 'iPhone';
        data.annotations.push(copy);
        present.add(note.id); // 同一批次里重复的新 ID 只落一条,与回执一致
      }
    }, options);
    await store.mutateReviewById(record.reviewId, (review) => {
      review.receivedBatches = Array.isArray(review.receivedBatches) ? review.receivedBatches : [];
      if (!review.receivedBatches.some((item) => item.batchId === batch.batchId)) {
        review.receivedBatches.push({ batchId: batch.batchId, device: batch.device || null, receivedAt: now, count: record.acceptedIds.length, intent: record.intent || null });
      }
      return { ...review };
    }, options);
    record.stage = 'notes';
    await writeImport(record, options);
  }
  let review = await store.getReviewById(record.reviewId, options);
  if (record.stage === 'notes') {
    // 整批落盘后才推进状态:固定本轮成员并交出(有批注 → 已交出;整批为空或全部去重 → 零批注通过)
    if (review && review.status === 'reviewing') {
      review = (await store.submitReviewLocked(record.reviewId, { ...options, fromImport: true })).review;
      record.submittedByThisBatch = true;
    } else if (review) {
      // 重放时会话已不在批注中:只有本批次的批注都进了这一轮的成员集才算交出成功,否则是被别的交出越过了
      const members = new Set(Array.isArray(review.memberAnnotationIds) ? review.memberAnnotationIds : []);
      record.submittedByThisBatch = record.acceptedIds.every((id) => members.has(id));
    }
    record.stage = 'submitted';
    record.resultStatus = review ? review.status : null;
    await writeImport(record, options);
  }
  if (record.submittedByThisBatch === false) {
    const receipt = rejected(batch, 'session-advanced', '这批批注落盘时会话已被别的交出推进,未进入本轮;它们会进入下一轮,请在手机上确认。', { reviewId: record.reviewId });
    await writeReceipt(receipt, options);
    record.stage = 'done';
    await writeImport(record, options);
    removeImport(batch.batchId, options);
    return { receipt, review };
  }
  const receipt = {
    batchId: batch.batchId, accepted: true, reviewId: record.reviewId, documentPath: record.absPath,
    batchDocId: batch.docId, batchReviewId: batch.reviewId, baseVersion: record.baseVersion,
    intent: record.intent || null, targetReviewId: record.reviewId, round: review && Number.isInteger(review.round) ? review.round : null,
    acceptedIds: record.acceptedIds, skippedIds: record.skippedIds, status: record.resultStatus || (review && review.status) || null,
    receivedAt: record.createdAt,
  };
  await writeReceipt(receipt, options);
  record.stage = 'done';
  await writeImport(record, options);
  removeImport(batch.batchId, options);
  return { receipt, review };
}

/** 还没真正定稿时(含重放)锁内复核:最新一轮、Mac 编辑、原文指纹、未处理批注 */
async function finalizeProblem(record, options) {
  const latest = await latestReviewForDoc(record.docId, options);
  if (!latest || latest.id !== record.reviewId) return ['round-advanced', '这篇在 Mac 上已经有新的一轮,这次没有定稿。'];
  if (latest.status === 'complete' && latest.outcome === 'finalized') return null; // 已经定稿:幂等
  const problem = editingProblem(record.absPath, options) || hashProblem(record.absPath, record.baseVersion);
  if (problem) return problem;
  const open = store.readAnnotations(record.absPath).annotations.filter((note) => store.annotationStatus(note) === 'open').length;
  return open > 0 ? ['has-open-notes', `Mac 上这篇还有 ${open} 条没处理的批注,这次没有定稿。`] : null;
}

/** 手机定稿:approving(批注中先零批注交出)→ finalizing → 定稿回执;已定稿不重写时间 */
async function finishFinalize(record, options = {}) {
  if (record.stage === 'approving') {
    const review = await store.getReviewById(record.reviewId, options);
    if (review && review.status === 'reviewing') {
      const problem = await finalizeProblem(record, options);
      if (problem) return rejectRecord(record, problem[0], problem[1], options);
      await store.submitReviewLocked(record.reviewId, { ...options, fromImport: true }); // 零批注 → 通过(approved)
    }
    record.stage = 'finalizing';
    await writeImport(record, options);
  }
  if (record.stage === 'finalizing') {
    const review = await store.getReviewById(record.reviewId, options);
    if (!review || review.status !== 'complete') return rejectRecord(record, 'session-advanced', `这一轮当前 ${review ? review.status : '不在了'},不能定稿。`, options);
    // 重放也要复核:日志落盘后、定稿前崩溃,期间正文可能被改过
    const problem = await finalizeProblem(record, options);
    if (problem) return rejectRecord(record, problem[0], problem[1], options);
    await store.finalizeReviewLocked(record.reviewId, options);
    record.stage = 'finalized';
    await writeImport(record, options);
  }
  const review = await store.getReviewById(record.reviewId, options);
  const receipt = {
    batchId: record.batchId, accepted: true, reviewId: record.reviewId, documentPath: record.absPath,
    batchDocId: record.batch.docId, batchReviewId: record.batch.reviewId, baseVersion: record.baseVersion,
    intent: 'finalize', targetReviewId: record.reviewId, round: review && Number.isInteger(review.round) ? review.round : null,
    acceptedIds: [], skippedIds: [], status: review ? review.status : null, outcome: review ? review.outcome || null : null,
    receivedAt: record.createdAt,
  };
  await writeReceipt(receipt, options);
  record.stage = 'done';
  await writeImport(record, options);
  removeImport(record.batchId, options);
  return { receipt, review };
}

/** 崩溃重放:在文档锁内按记录补齐剩下的阶段,最后定稿原回执;接受列表以记录为准 */
async function resumeImport(record, options = {}) {
  return store.withReviewTransaction(record.absPath, async () => {
    const prior = readReceipt(record.batchId, options);
    if (prior) return reuseReceipt(prior, options);
    const fresh = readImport(record.batchId, options);
    if (!fresh || fresh.stage === 'done') { removeImport(record.batchId, options); return { receipt: null, review: null }; }
    return finishImport(fresh, options);
  }, options);
}

/** 显式入口:把没有身份的旧批次(手机独立文件导出 / 拖进窗口)转为指定文档当前轮的新批注;新 ID、保留来源;不冒充任何一轮 */
async function convertToNewNotes(batch, options = {}) {
  if (!options.documentPath) throw new ReviewStoreError('BAD_ARGUMENT', '转为新批注需要指定文档路径。', { httpStatus: 400 });
  const review = await store.getReviewByPath(options.documentPath, { ...options, activeOnly: true });
  if (!review || review.status !== 'reviewing') {
    const receipt = rejected(batch, 'session-advanced', '这篇文档当前不在批注中,不能把旧批注转进来;先在回稿里划词批注开一轮。', { reviewId: review ? review.id : null });
    return { receipt, review, converted: true };
  }
  return store.withReviewTransaction(review.absPath, async () => {
    const current = await store.getReviewById(review.id, options);
    if (!current || current.status !== 'reviewing') {
      return { receipt: rejected(batch, 'session-advanced', '这篇文档刚刚已经交出,旧批注没有转进来;等下一轮再转。', { reviewId: review.id }), review: current, converted: true };
    }
    let actualHash = null;
    try { actualHash = store.sha256File(current.absPath); } catch {}
    if (actualHash !== current.sourceHash) {
      return { receipt: rejected(batch, 'version-mismatch', '这篇文档的正文已在外面被改过,先处理冲突再转旧批注。', { reviewId: review.id }), review: current, converted: true };
    }
    if (pendingImportFor(current.absPath, options)) {
      return { receipt: rejected(batch, 'import-pending', '这篇文档有手机批次导入还没收敛,先 mdreview import-resume。', { reviewId: review.id }), review: current, converted: true };
    }
    const now = new Date().toISOString();
    const acceptedIds = [];
    const mapping = [];
    await store.mutateAnnotations(review.absPath, (data) => {
      const existingSources = new Set(data.annotations.map((note) => note.sourceAnnotationId).filter(Boolean));
      for (const note of batch.annotations) {
        const key = `${batch.batchId}:${note.id}`;
        if (existingSources.has(key)) continue; // 同一批次再转一次不重复
        existingSources.add(key); // 批次内重复的 ID 也只转一条
        const id = `n${crypto.randomBytes(12).toString('hex')}`;
        const copy = { ...note, id, status: 'open', reviewSessionId: review.id, createdAt: now,
          sourceAnnotationId: key, receivedBatchId: batch.batchId, receivedAt: now, convertedFrom: 'batch-without-identity' };
        delete copy.baseVersion; delete copy.docId; delete copy.reviewId;
        if (typeof copy.createdBy !== 'string') copy.createdBy = batch.device || 'iPhone';
        data.annotations.push(copy);
        acceptedIds.push(id);
        mapping.push({ from: note.id, to: id });
      }
    }, options);
    const receipt = { batchId: batch.batchId, accepted: true, converted: true, reviewId: review.id, documentPath: review.absPath, acceptedIds, skippedIds: [], mapping, receivedAt: now };
    return { receipt, review: await store.getReviewById(review.id, options), converted: true };
  }, options);
}

async function importBatchFile(file, options = {}) {
  return importBatch(readBatchFile(path.resolve(file)), options);
}

/** 启动或排查用:把所有未收敛的导入记录收敛掉 */
async function resumePendingImports(options = {}) {
  let names = [];
  try { names = fs.readdirSync(importsDir(options)).filter((name) => name.endsWith('.json')); } catch { return []; }
  const results = [];
  for (const name of names) {
    const record = readImport(name.slice(0, -5), options);
    if (!record || record.stage === 'done') { removeImport(name.slice(0, -5), options); continue; }
    try { results.push(await resumeImport(record, options)); } catch (error) { results.push({ batchId: record.batchId, error: error.message }); }
  }
  return results;
}

module.exports = { validateBatch, identityProblem, readBatchFile, importBatch, importBatchFile, readReceipt, readImport, pendingImportFor, settlePendingImportFor, resumePendingImports, INTENTS };
