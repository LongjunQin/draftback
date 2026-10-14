'use strict';

/*
 * 跨端同步的 Mac 侧状态(跨端规则第 12 节)。
 *
 * 云端(CloudKit)的读写由随 App 打包的原生辅助程序 MDTurn Sync.app 完成;这个模块只回答三个问题:
 *   1. 现在该推什么到手机(待推送队列,按会话索引里的状态与上次推送的签名算出来,不另存队列文件);
 *   2. 推一份文档要带什么(正文、附件清单、改稿摘要);
 *   3. 推完、收到批次、发完回执之后在会话上记什么(sync 字段:state / pushedSignature / 时间戳 / error)。
 * 辅助程序通过 server.js 的 /api/app/sync/* 调这些函数;CLI 的 mdreview status / push / sync-status 也用。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./review-store');

const SYNC_STATES = ['never', 'pushed', 'batch-pending', 'batch-received', 'receipt-sent'];
const ATTACHMENT_LIMIT = 20 * 1024 * 1024;
const ATTACHMENT_TOTAL_LIMIT = 100 * 1024 * 1024;
const RETENTION_DAYS = 30;
const { ReviewStoreError } = store;

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

// 手机要显示的状态(跨端规则第 7 节),从 Mac 的会话状态机映射;手机不自己猜
function phoneState(review) {
  switch (review.status) {
    case 'reviewing': return 'reviewing';
    case 'ready_to_apply': return 'waiting-agent';
    case 'applying': return review.applyMode === 'manual' ? 'manual-editing' : 'applying';
    case 'complete': return review.outcome === 'finalized' ? 'finalized' : 'completed';
    case 'conflict': return 'conflict';
    case 'cancelled': return 'cancelled';
    default: return review.status || 'unknown';
  }
}

// 推送内容的指纹:只要正文、状态、轮次、摘要任一变化,就要再推一次
function contentHashFor(review) {
  if (review.status === 'complete') return review.finalHash || review.sourceHash;
  return review.sourceHash;
}
function contentAvailable(review) {
  // 改稿期间磁盘上的文件正在变,不能把半成品推到手机;只推状态
  return review.status !== 'applying';
}
function pushSignature(review) {
  const summaryHash = review.summary ? sha256(Buffer.from(review.summary, 'utf8')).slice(0, 16) : '';
  return [contentHashFor(review), review.status, review.applyMode || '', review.outcome || '', review.round || 1, summaryHash].join('|');
}
function needsPush(review) {
  if (!review || !review.docId) return false; // 旧会话(没有 docId)不参与同步
  const sync = review.sync || {};
  if (sync.pushedSignature !== pushSignature(review)) return true;
  return Boolean(sync.pushRequestedAt && (!sync.pushedAt || sync.pushRequestedAt > sync.pushedAt));
}
function withinRetention(review) {
  if (store.ACTIVE_REVIEW_STATES.has(review.status)) return true;
  const stamp = Date.parse(review.completedAt || review.cancelledAt || review.unlockedAt || review.createdAt || 0);
  return !Number.isFinite(stamp) || Date.now() - stamp < RETENTION_DAYS * 86400000;
}

function outboxItem(review) {
  return {
    docId: review.docId,
    reviewId: review.id,
    round: review.round || 1,
    title: review.file,
    status: review.status,
    applyMode: review.applyMode || null,
    outcome: review.outcome || null,
    phoneState: phoneState(review),
    contentHash: contentHashFor(review),
    contentAvailable: contentAvailable(review),
    summary: review.summary || null,
    signature: pushSignature(review),
    openCount: store.countOpenAnnotations(review.absPath),
  };
}

// 每个 docId 只推"最新一轮"的那个会话;手机上同一篇文档只有一条记录,轮次递增
function latestPerDocument(reviews) {
  const byDoc = new Map();
  for (const review of reviews) {
    if (!review || !review.docId) continue;
    const prior = byDoc.get(review.docId);
    if (!prior || (review.round || 0) > (prior.round || 0) || (review.createdAt || '') > (prior.createdAt || '')) byDoc.set(review.docId, review);
  }
  return [...byDoc.values()];
}

async function listOutbox(options = {}) {
  const reviews = await store.listReviews(options);
  return latestPerDocument(reviews)
    .filter((review) => withinRetention(review) && needsPush(review))
    .map(outboxItem);
}

async function listSyncStatus(options = {}) {
  const reviews = await store.listReviews(options);
  return latestPerDocument(reviews)
    .filter(withinRetention)
    .map((review) => ({ ...outboxItem(review), needsPush: needsPush(review), sync: review.sync || { state: 'never' }, absPath: review.absPath }));
}

// 文档里相对路径引用的本地图片与附件(跨端规则第 5 节):只打包文档目录树内的文件,单个 20 MB、总量 100 MB
const LINK_PATTERN = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_SRC_PATTERN = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
function referencedPaths(content) {
  const found = new Set();
  for (const pattern of [LINK_PATTERN, HTML_SRC_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content))) {
      let target = match[1].trim();
      if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      target = target.replace(/[?#].*$/, '');
      try { target = decodeURIComponent(target); } catch {}
      if (target) found.add(target);
    }
  }
  return [...found];
}
function collectAttachments(absPath, content) {
  const documentDir = path.dirname(absPath);
  let rootReal = documentDir;
  try { rootReal = fs.realpathSync(documentDir); } catch {}
  const items = [];
  let total = 0;
  for (const relPath of referencedPaths(content)) {
    if (path.isAbsolute(relPath)) continue;
    const abs = path.resolve(documentDir, relPath);
    let real;
    try { real = fs.realpathSync(abs); } catch { continue; }
    const relative = path.relative(rootReal, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let stat;
    try { stat = fs.statSync(real); } catch { continue; }
    if (!stat.isFile()) continue;
    if (/\.(md|markdown)$/i.test(relPath)) continue; // 指向其他 Markdown 的链接首版不打包(第 5 节)
    const included = stat.size <= ATTACHMENT_LIMIT && total + stat.size <= ATTACHMENT_TOTAL_LIMIT;
    if (included) total += stat.size;
    items.push({ relPath, bytes: stat.size, sha256: sha256(fs.readFileSync(real)), included, reason: included ? null : '超过打包上限' });
  }
  return items;
}

// 推一份文档要带的全部东西。正文必须与会话记录的指纹一致,否则不推(外部改动交给冲突机制)
async function readPushPayload(reviewId, options = {}) {
  const review = await store.getReviewById(reviewId, options);
  if (!review) throw new ReviewStoreError('REVIEW_NOT_FOUND', `找不到审阅会话: ${reviewId || ''}`, { httpStatus: 404 });
  if (!review.docId) throw new ReviewStoreError('SYNC_NOT_APPLICABLE', '这是旧会话,没有文档标识,不参与同步。', { httpStatus: 409 });
  const item = outboxItem(review);
  if (!item.contentAvailable) return { ...item, content: null, attachments: [], summary: review.summary || null };
  let content;
  try { content = fs.readFileSync(review.absPath); } catch (error) {
    throw new ReviewStoreError('SOURCE_READ_FAILED', `无法读取源文档: ${error.message}`, { httpStatus: 404 });
  }
  const hash = sha256(content);
  if (hash !== item.contentHash) {
    throw new ReviewStoreError('SOURCE_CHANGED', '源文档内容与会话记录的版本不一致,暂不推送。', { httpStatus: 409, details: { expected: item.contentHash, actual: hash } });
  }
  const text = content.toString('utf8');
  return { ...item, content: text, attachments: collectAttachments(review.absPath, text) };
}

// pending 可由调用方传入(listSyncStatus 的条目没有 sourceHash,自己算会误判成"有新内容")
function describeSync(review, pending = undefined) {
  const sync = review && review.sync;
  if (!review || !review.docId) return '不参与同步(旧会话)';
  const needs = typeof pending === 'boolean' ? pending : needsPush(review);
  if (!sync || sync.state === 'never') {
    let pending = needs ? '等待推到手机' : '未推送';
    if (sync && sync.error) pending += `;上次推送失败: ${sync.error}`;
    return pending;
  }
  const when = (value) => (value ? value.replace('T', ' ').slice(0, 16) : '');
  const labels = {
    pushed: `已推到手机(${when(sync.pushedAt)})`,
    'batch-pending': '手机已提交,等待 Mac 接收',
    'batch-received': `已收到手机批注(${when(sync.lastBatchAt)})`,
    'receipt-sent': `已向手机发回执(${when(sync.lastReceiptAt)})`,
  };
  let text = labels[sync.state] || sync.state;
  if (needs) text += ',有新内容待推送';
  if (sync.error) text += `;上次推送失败: ${sync.error}`;
  return text;
}

function updateSync(reviewId, mutate, options = {}) {
  return store.mutateReviewById(reviewId, (review) => {
    review.sync = { ...(review.sync || { state: 'never' }) };
    mutate(review.sync, review);
    if (!SYNC_STATES.includes(review.sync.state)) review.sync.state = 'never';
    return { ...review };
  }, options);
}

async function markPushed(reviewId, input = {}, options = {}) {
  if (!reviewId) throw new ReviewStoreError('BAD_ARGUMENT', '缺少 reviewId。', { httpStatus: 400 });
  return updateSync(reviewId, (sync, review) => {
    const now = new Date().toISOString();
    sync.pushedSignature = typeof input.signature === 'string' && input.signature ? input.signature : pushSignature(review);
    sync.pushedHash = input.contentHash || contentHashFor(review);
    sync.pushedAt = now;
    sync.error = null;
    if (sync.state === 'never') sync.state = 'pushed';
    if (review.status === 'reviewing') sync.state = 'pushed'; // 新一轮推出去后,之前的批次/回执状态不再适用
  }, options);
}

async function markPushError(reviewId, message, options = {}) {
  if (!reviewId) throw new ReviewStoreError('BAD_ARGUMENT', '缺少 reviewId。', { httpStatus: 400 });
  return updateSync(reviewId, (sync) => {
    sync.error = String(message || '未知错误').slice(0, 500);
    sync.errorAt = new Date().toISOString();
  }, options);
}

async function markBatchReceived(reviewId, receipt = {}, options = {}) {
  return updateSync(reviewId, (sync) => {
    sync.state = 'batch-received';
    sync.lastBatchAt = new Date().toISOString();
    sync.lastBatchId = receipt.batchId || null;
    sync.lastBatchAccepted = receipt.accepted !== false;
  }, options);
}

async function markReceiptSent(reviewId, batchId, options = {}) {
  return updateSync(reviewId, (sync) => {
    sync.state = 'receipt-sent';
    sync.lastReceiptAt = new Date().toISOString();
    sync.lastReceiptBatchId = batchId || sync.lastBatchId || null;
  }, options);
}

// mdreview push:强制再推一次(open/complete 已自动推,这里给"手机上没看到"时用)
async function requestPush(inputPath, options = {}) {
  const review = await store.getReviewByPath(inputPath, options);
  if (!review) throw new ReviewStoreError('NO_ACTIVE_REVIEW', `该文档没有审阅会话,请先 mdreview open: ${inputPath}`, { httpStatus: 404 });
  if (!review.docId) throw new ReviewStoreError('SYNC_NOT_APPLICABLE', '这是旧会话,没有文档标识;重新 mdreview open 一次即可获得。', { httpStatus: 409 });
  return updateSync(review.id, (sync) => { sync.pushRequestedAt = new Date().toISOString(); }, options);
}

// 辅助程序的心跳(账号、上次轮询时间、错误),写在数据目录里,供 status / 界面显示"同步是否在跑"
function helperStatePath(options = {}) { return path.join(store.getDataDir(options), 'sync-helper.json'); }
function readHelperState(options = {}) {
  try { return store.readJsonStrict(helperStatePath(options), null); } catch { return null; }
}
async function writeHelperState(state, options = {}) {
  const clean = {
    account: typeof state.account === 'string' ? state.account.slice(0, 120) : null,
    accountStatus: typeof state.accountStatus === 'string' ? state.accountStatus.slice(0, 60) : null,
    environment: typeof state.environment === 'string' ? state.environment.slice(0, 30) : null,
    lastPollAt: new Date().toISOString(),
    error: typeof state.error === 'string' && state.error ? state.error.slice(0, 500) : null,
    version: typeof state.version === 'string' ? state.version.slice(0, 30) : null,
  };
  await store.atomicWriteJson(helperStatePath(options), clean, { mode: 0o600 });
  return clean;
}

module.exports = {
  SYNC_STATES,
  ATTACHMENT_LIMIT,
  ATTACHMENT_TOTAL_LIMIT,
  RETENTION_DAYS,
  phoneState,
  pushSignature,
  needsPush,
  listOutbox,
  listSyncStatus,
  collectAttachments,
  referencedPaths,
  readPushPayload,
  describeSync,
  markPushed,
  markPushError,
  markBatchReceived,
  markReceiptSent,
  requestPush,
  readHelperState,
  writeHelperState,
};
