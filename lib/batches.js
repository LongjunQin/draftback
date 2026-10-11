'use strict';
/*
 * 手机批注批次导入(跨端规则第 6 节),同步传输层无关:
 * CloudKit 到位前,批次是一个 .mdturn-batch.json 文件(手机导出 → 隔空投送到 Mac → 导入);
 * CloudKit 到位后,同一个 importBatch 由同步模块调用,规则不变。
 *
 * 接收顺序(每一步不过就拒收,写回执,不动 sidecar 不改状态):
 *   1. 批次结构完整(version、batchId、baseVersion、annotations 数组)。
 *   2. 找到会话:显式指定文档路径,或按 baseVersion 匹配"审阅中且原文指纹相同"的活动会话。
 *   3. 会话仍在审阅中(否则 session-advanced)。
 *   4. 版本指纹与 Mac 当前原文一致(否则 version-mismatch)。
 *   5. 批次编号已见过 → 直接返回上次回执,不重复写入。
 *   6. 整批写入 sidecar(已存在的批注 id 跳过),会话进入待改稿(复用 submitReview),写回执。
 * 回执存在 <数据目录>/receipts/<batchId>.json,供同步层回传手机。
 */
const fs = require('fs');
const path = require('path');
const store = require('./review-store');

const { ReviewStoreError } = store;

function receiptsDir(options = {}) {
  const dir = path.join(store.getDataDir(options), 'receipts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function isSafeId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value); }

function readBatchFile(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new ReviewStoreError('BATCH_UNREADABLE', `批次文件无法读取或不是 JSON: ${file}`, { httpStatus: 400, cause: error });
  }
  return validateBatch(parsed);
}

function validateBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) throw new ReviewStoreError('BATCH_INVALID', '批次必须是 JSON 对象。', { httpStatus: 400 });
  if (batch.version !== 1) throw new ReviewStoreError('BATCH_INVALID', `不支持的批次版本: ${batch.version}`, { httpStatus: 400 });
  if (!isSafeId(batch.batchId)) throw new ReviewStoreError('BATCH_INVALID', '批次缺少有效的 batchId。', { httpStatus: 400 });
  if (typeof batch.baseVersion !== 'string' || !/^[0-9a-f]{64}$/i.test(batch.baseVersion)) throw new ReviewStoreError('BATCH_INVALID', '批次缺少有效的 baseVersion(SHA-256)。', { httpStatus: 400 });
  if (!Array.isArray(batch.annotations)) throw new ReviewStoreError('BATCH_INVALID', '批次缺少 annotations 数组。', { httpStatus: 400 });
  for (const note of batch.annotations) {
    if (!note || typeof note !== 'object' || typeof note.id !== 'string' || !note.id || typeof note.comment !== 'string' || !note.comment.trim()) {
      throw new ReviewStoreError('BATCH_INVALID', '批次里有批注缺少 id 或 comment,整批拒收(不能让智能体拿半份批注改稿)。', { httpStatus: 400 });
    }
  }
  return batch;
}

function receiptPath(batchId, options) { return path.join(receiptsDir(options), `${batchId}.json`); }

function readReceipt(batchId, options = {}) {
  try { return store.readJsonStrict(receiptPath(batchId, options)); } catch { return null; }
}

async function writeReceipt(receipt, options = {}) {
  await store.atomicWriteJson(receiptPath(receipt.batchId, options), receipt, { mode: 0o600 });
  return receipt;
}

function rejected(batch, reason, message, extra = {}) {
  return { batchId: batch.batchId, accepted: false, reason, message, receivedAt: new Date().toISOString(), ...extra };
}

async function findReview(batch, options = {}) {
  if (options.documentPath) {
    const review = await store.getReviewByPath(options.documentPath, { ...options, activeOnly: true });
    return review || null;
  }
  const reviews = await store.listReviews(options);
  const ACTIVE = new Set(['reviewing', 'ready_to_apply', 'applying', 'conflict']);
  const matching = reviews.filter((review) => review && ACTIVE.has(review.status) && review.sourceHash === batch.baseVersion.toLowerCase());
  // 优先仍在审阅中的会话;都不在审阅中时也返回(让调用方给出 session-advanced 的明确原因,而不是"没有会话")。
  const candidates = matching.some((review) => review.status === 'reviewing') ? matching.filter((review) => review.status === 'reviewing') : matching;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1 && typeof batch.documentName === 'string') {
    const byName = candidates.filter((review) => review.file === batch.documentName);
    if (byName.length === 1) return byName[0];
  }
  return candidates[0] || null;
}

/**
 * 导入一个批次。返回 { receipt, review }。拒收不抛错(回执里说明原因);结构损坏才抛错。
 */
async function importBatch(batch, options = {}) {
  validateBatch(batch);
  const prior = readReceipt(batch.batchId, options);
  if (prior) return { receipt: { ...prior, reused: true }, review: prior.reviewId ? await store.getReviewById(prior.reviewId, options) : null };

  const review = await findReview(batch, options);
  if (!review) {
    const receipt = rejected(batch, 'no-session', 'Mac 上没有与这个批次版本对应的审阅会话:文档可能已被修改,或从未在 Mac 上发起审阅。');
    return { receipt: await writeReceipt(receipt, options), review: null };
  }
  if (review.status !== 'reviewing') {
    const receipt = rejected(batch, 'session-advanced', `会话已不在审阅中(当前 ${review.status}),这批批注未被采用,请在下一轮重新提交。`, { reviewId: review.id });
    return { receipt: await writeReceipt(receipt, options), review };
  }
  if (review.sourceHash !== batch.baseVersion.toLowerCase()) {
    const receipt = rejected(batch, 'version-mismatch', '手机批注所依据的版本与 Mac 当前原文不一致,未写入。', { reviewId: review.id, currentVersion: review.sourceHash });
    return { receipt: await writeReceipt(receipt, options), review };
  }

  const acceptedIds = [];
  const skippedIds = [];
  await store.withReviewTransaction(review.absPath, async () => {
    await store.mutateAnnotations(review.absPath, (data) => {
      const existing = new Set(data.annotations.map((note) => note.id));
      for (const note of batch.annotations) {
        if (existing.has(note.id)) { skippedIds.push(note.id); continue; }
        const record = { ...note, status: 'open', reviewSessionId: review.id, receivedBatchId: batch.batchId, receivedAt: new Date().toISOString() };
        delete record.baseVersion;
        if (typeof record.createdBy !== 'string') record.createdBy = batch.device || 'iPhone';
        data.annotations.push(record);
        acceptedIds.push(note.id);
      }
    }, options);
    await store.mutateReviewById(review.id, (record) => {
      record.receivedBatches = Array.isArray(record.receivedBatches) ? record.receivedBatches : [];
      record.receivedBatches.push({ batchId: batch.batchId, device: batch.device || null, receivedAt: new Date().toISOString(), count: acceptedIds.length });
    }, options);
  }, options);

  // 整批落盘后才推进状态:待改稿(有批注)或审核通过(整批为空不会到这里,validate 允许空数组 → 视为"通过")。
  const submitted = await store.submitReview(review.id, options);
  const receipt = {
    batchId: batch.batchId, accepted: true, reviewId: review.id, documentPath: review.absPath,
    acceptedIds, skippedIds, status: submitted.review.status, receivedAt: new Date().toISOString(),
  };
  return { receipt: await writeReceipt(receipt, options), review: submitted.review };
}

async function importBatchFile(file, options = {}) {
  return importBatch(readBatchFile(path.resolve(file)), options);
}

module.exports = { validateBatch, readBatchFile, importBatch, importBatchFile, readReceipt };
