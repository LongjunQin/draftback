'use strict';

/*
 * 跨端同步的 Mac 侧状态(跨端规则第 12 节)。
 *
 * 云端(CloudKit)的读写由随 App 打包的原生辅助程序 Draftback Sync.app 完成;这个模块只回答三个问题:
 *   1. 现在该推什么到手机(待推送队列,按会话索引里的状态与上次推送的签名算出来,不另存队列文件);
 *   2. 推一份文档要带什么(正文、附件清单、改稿摘要);
 *   3. 推完、收到批次、发完回执之后在会话上记什么(sync 字段:state / pushedSignature / 时间戳 / error)。
 * 辅助程序通过 server.js 的 /api/app/sync/* 调这些函数;CLI 的 mdreview status / push / sync-status 也用。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./review-store');
const presence = require('./agent-presence');

const SYNC_STATES = ['never', 'pushed', 'batch-pending', 'batch-received', 'receipt-sent'];
const ATTACHMENT_LIMIT = 20 * 1024 * 1024;
const ATTACHMENT_TOTAL_LIMIT = 100 * 1024 * 1024;
const RETENTION_DAYS = 30;
const LIVE_STATES = new Set(['reviewing', 'ready_to_apply']); // 正文不该被外部改动的阶段
const { ReviewStoreError } = store;

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

// 手机要显示的状态(跨端规则第 7 节),从 Mac 的会话状态机映射;手机不自己猜
function phoneState(review) {
  switch (review.status) {
    case 'reviewing': return 'reviewing';
    case 'ready_to_apply': return 'waiting-agent';
    case 'applying': return review.applyMode === 'manual' ? 'manual-editing' : 'applying';
    case 'complete': return review.outcome === 'finalized' ? 'finalized' : review.outcome === 'restored' ? 'restored' : 'completed';
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
  // 改稿期间磁盘上的文件正在变,不能把半成品推到手机;只推状态。作废的轮次只推状态(规则⑤第 4 节事件表)
  if (review.status === 'applying') return false;
  if (review.status === 'cancelled') return false;
  return true;
}
// 已交出的三档(规则②:none 没人在听 / listening 在线等待领取 / claimed 已领取);其他状态为空。
// 监听过期没有写入事件,所以每次算签名时现读登记:三档一变就要再推,手机才不会把过期的监听显示成在线
function agentStateOf(review, options = {}) {
  if (!review || (review.status !== 'ready_to_apply' && review.status !== 'applying')) return '';
  try { return presence.agentStateFor(review, presence.describe(review.id, options)) || ''; } catch { return ''; }
}
// 发布格式版本(跨端规则 v2.4 第 12 节):p3 起快照带 macProtocol 与处理结果;升级后保留期内每篇的最新一条各补推一次
const PUBLISH_FORMAT = 'p3';
const MAC_PROTOCOL = 3; // 这台 Mac 能收的批次协议(3 = 带意图的 next-round / finalize)

// 终态的正文归档能不能读到(归档缺失 / 损坏 → 只推状态;恢复回来要再推一次,所以进签名)。
// 与推送载荷同一个判断(readVersion:文件在、指纹对);按目录与三个文件的 inode、大小、修改时间、状态改变时间缓存
// (改权限只动状态改变时间),签名每 15 秒算一遍,文件没动就不重读、不重算指纹。
// 读的时候出错(没权限、变成了目录):这次当不可用、不缓存,下次再读;不让一篇的错误拖垮整个推送队列
const archiveCache = new Map();
function archiveAvailable(review, options = {}) {
  if (!review || review.status !== 'complete' || !review.docId || !review.versionId) return true;
  const versionStore = require('./version-store');
  const dir = versionStore.versionDir(review.docId, review.versionId, options);
  const stamp = (name) => {
    try { const st = fs.statSync(name ? path.join(dir, name) : dir); return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`; } catch { return '-'; }
  };
  const key = `${stamp('')}|${stamp('meta.json')}|${stamp('original.md')}|${stamp('final.md')}`;
  const cached = archiveCache.get(dir);
  if (cached && cached.key === key) return cached.value;
  let value = false;
  try {
    const meta = versionStore.readMetaFor(review.docId, review.versionId, options);
    const kind = meta && meta.kind ? meta.kind : (review.outcome === 'approved' ? 'approved' : 'review');
    value = Boolean(meta) && versionStore.readVersion(review.docId, review.versionId, kind === 'approved' ? 'original' : 'final', options).available;
  } catch (_) {
    archiveCache.delete(dir);
    return false;
  }
  archiveCache.set(dir, { key, value });
  if (archiveCache.size > 500) archiveCache.delete(archiveCache.keys().next().value);
  return value;
}

function pushSignature(review, options = {}) {
  const summaryHash = review.summary ? sha256(Buffer.from(review.summary, 'utf8')).slice(0, 16) : '';
  const parts = [contentHashFor(review), review.status, review.applyMode || '', review.outcome || '', review.round || 1, summaryHash, PUBLISH_FORMAT];
  if (!archiveAvailable(review, options)) parts.push('unarchived');
  const agent = agentStateOf(review, options);
  if (agent) parts.push(agent); // 只在已交出 / 改稿中追加,其他状态的旧签名不变,升级后不会把所有文档重推一遍
  // 在回稿里改过名:名字进签名,手机上的标题跟着变(同样只对改过名的文档追加)
  if (review.renamedAt) parts.push(`name:${review.file || ''}`);
  // 稿子回来带处理结果(v2.4):结果随版本事件固化、不再变,协议版本进签名即可;升级后保留期内的回稿各补推一次
  if (review.status === 'complete' && !review.outcome && review.versionId) parts.push(RESULTS_PROTOCOL);
  return parts.join('|');
}
// signature 可由调用方传入:同一次请求里一篇只算一遍签名
function needsPush(review, options = {}, signature = null) {
  if (!review || !review.docId) return false; // 旧会话(没有 docId)不参与同步
  const sync = review.sync || {};
  if (sync.republishRequired) return true; // 整体快照恢复后要重新发布一次(见 snapshot.forceRepublish)
  if (sync.pushedSignature !== (signature || pushSignature(review, options))) return true;
  return Boolean(sync.pushRequestedAt && (!sync.pushedAt || sync.pushRequestedAt > sync.pushedAt));
}
function withinRetention(review) {
  if (store.ACTIVE_REVIEW_STATES.has(review.status)) return true;
  const stamp = Date.parse(review.completedAt || review.cancelledAt || review.unlockedAt || review.createdAt || 0);
  return !Number.isFinite(stamp) || Date.now() - stamp < RETENTION_DAYS * 86400000;
}

function outboxItem(review, options = {}, signature = null) {
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
    agentState: agentStateOf(review, options) || null,
    macProtocol: MAC_PROTOCOL,
    signature: signature || pushSignature(review, options),
    openCount: store.countOpenAnnotations(review.absPath),
    lastError: (review.sync && review.sync.error) || null, // 辅助程序据此只在错误变化时写日志
  };
}

// 每个 docId 只推"最新一轮"的那个会话;手机上同一篇文档只有一条记录。"最新"与收批次同一个定义(review-store.latestReviewOf)
function latestPerDocument(reviews) {
  const byDoc = new Map();
  for (const review of reviews) {
    if (!review || !review.docId) continue;
    if (!byDoc.has(review.docId)) byDoc.set(review.docId, []);
    byDoc.get(review.docId).push(review);
  }
  return [...byDoc.values()].map((list) => store.latestReviewOf(list));
}

// iCloud 账号(跨端规则第 9 节):辅助程序随心跳报当前账号(用户记录名的指纹,不存原文);每篇推过的文档记下所属账号。
// 换了账号,属于旧账号的文档不推、不显示为待推送,等原账号登回来再续
function currentAccount(options = {}) {
  const helper = readHelperState(options);
  return helper && typeof helper.account === 'string' && helper.account ? helper.account : null;
}
// 这篇属于哪个账号:记在文档身份上(新开的轮次、我自己改、恢复都跟着文档走),会话上的只是补充
function ownerLookup(options = {}) {
  const documents = require('./version-store').readIndex(options).documents || {};
  return (review) => {
    const doc = review && review.docId ? documents[review.docId] : null;
    return (doc && doc.account) || (review && review.sync && review.sync.account) || null;
  };
}
function otherAccount(review, account, ownerOf) {
  const owner = ownerOf(review);
  return Boolean(owner && account && owner !== account);
}
// 账号未知:辅助程序报过账号以后又不知道了(iCloud 暂时不可用、刚换账号还没核对),一篇都不推,免得推进别的账号
function accountUnknown(options = {}) {
  const helper = readHelperState(options);
  return Boolean(helper && helper.accountEverKnown && !helper.account);
}

// 推送队列按篇隔离:一篇算签名出错,跳过这篇(下一轮再试),别的照推,收批次也不受影响
async function listOutbox(options = {}) {
  if (accountUnknown(options)) return [];
  const reviews = await store.listReviews(options);
  const account = currentAccount(options);
  const ownerOf = ownerLookup(options);
  const items = [];
  for (const review of latestPerDocument(reviews).filter(withinRetention)) {
    if (otherAccount(review, account, ownerOf)) continue;
    try {
      const signature = pushSignature(review, options);
      if (needsPush(review, options, signature)) items.push(outboxItem(review, options, signature));
    } catch (_) { /* 这篇下一轮再试 */ }
  }
  return items;
}

async function listSyncStatus(options = {}) {
  const reviews = await store.listReviews(options);
  const account = currentAccount(options);
  const ownerOf = ownerLookup(options);
  const items = [];
  for (const review of latestPerDocument(reviews).filter(withinRetention)) {
    try {
      const signature = pushSignature(review, options);
      const elsewhere = otherAccount(review, account, ownerOf);
      items.push({ ...outboxItem(review, options, signature), needsPush: !elsewhere && needsPush(review, options, signature), otherAccount: elsewhere,
        sync: review.sync || { state: 'never' }, absPath: review.absPath });
    } catch (error) {
      items.push({ docId: review.docId, reviewId: review.id, title: review.file, status: review.status, needsPush: true,
        sync: { ...(review.sync || { state: 'never' }), error: `读不到这篇的同步信息:${error.message}` }, absPath: review.absPath });
    }
  }
  return items;
}

// 文档里相对路径引用的本地图片与附件(跨端规则第 5 节):只打包文档目录树内的文件,单个 20 MB、总量 100 MB
// 地址可以写在尖括号里(允许空格):`![图](<a b.png>)`、`[ref]: <a b.png>`;第一组是尖括号里的,第二组是普通写法
const LINK_PATTERN = /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_SRC_PATTERN = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
// 引用式写法(`![图][ref]` + `[ref]: pic.png`):定义行里的地址也要打包(与归档清单 version-store.assetManifest 同一规则)
const REF_DEF_PATTERN = /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>\n]+)>|([^\s<>]+))/gm;
function referencedPaths(content) {
  const found = new Set();
  for (const pattern of [LINK_PATTERN, HTML_SRC_PATTERN, REF_DEF_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content))) {
      let target = (match[1] || match[2] || '').trim();
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
    if (/\.(md|markdown)$/i.test(relPath)) continue; // 指向其他 Markdown 的链接首版不打包(第 5 节)
    const abs = path.resolve(documentDir, relPath);
    const lexical = path.relative(documentDir, abs);
    if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) continue;
    let real;
    try { real = fs.realpathSync(abs); } catch {
      // 文件不在:记进清单(手机显示「图片未随文档一起到达」),不再悄悄跳过
      items.push({ relPath, bytes: 0, sha256: null, included: false, reason: '文件不在' });
      continue;
    }
    const relative = path.relative(rootReal, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let stat;
    try { stat = fs.statSync(real); } catch { continue; }
    if (!stat.isFile()) continue;
    const included = stat.size <= ATTACHMENT_LIMIT && total + stat.size <= ATTACHMENT_TOTAL_LIMIT;
    if (included) total += stat.size;
    items.push({ relPath, bytes: stat.size, sha256: sha256(fs.readFileSync(real)), included, reason: included ? null : '超过打包上限' });
  }
  return items;
}

// 稿子回来(AI 改 / 我自己改)的处理结果(跨端规则 v2.4 第 5 节):只从版本事件里固化的快照算,
// 与 Mac 回稿卡同一个函数(static/desktop-history.js 的 returnCard),手机与电脑说法一致;没有归档就不带
const RESULTS_PROTOCOL = 'results-v1';
const RESULT_TEXT_LIMIT = 600;          // 每个字段最多这么多字,超出截断并加「…」
const RESULT_BYTE_BUDGET = 300 * 1024;  // 整份结果 JSON 的 UTF-8 字节上限:CloudKit 记录非资产字段合计不能超过 1 MB
function resultsFor(review, options = {}) {
  if (!review || review.status !== 'complete' || review.outcome || !review.docId || !review.versionId) return null;
  const meta = require('./version-store').readMetaFor(review.docId, review.versionId, options);
  if (!meta) return null;
  const card = require('../static/desktop-history').returnCard({ review, versions: [{ ...meta, versionId: review.versionId }] });
  if (!card || !card.show || !card.counts || (card.kind !== 'agent' && card.kind !== 'manual')) return null;
  const clip = (value) => { const text = String(value || ''); return text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}…` : text; };
  // 计数按本轮全部成员;列表按字节预算放,放不下的标 truncated,手机说明"其余在 Mac 上看"
  const out = {
    applied: card.counts.applied, wontfix: card.counts.wontfix, total: card.counts.total,
    actor: card.kind === 'manual' ? null : (meta.applyActor || meta.claimedBy || review.applyActor || review.claimedBy || null),
    items: [], truncated: false,
  };
  let bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  for (const item of card.items) {
    const entry = { id: item.id, scope: item.scope, quote: clip(item.quote), you: clip(item.you), ai: clip(item.ai), status: item.status };
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    if (bytes + size > RESULT_BYTE_BUDGET) { out.truncated = true; break; }
    out.items.push(entry);
    bytes += size;
  }
  return out;
}

// 推一份文档要带的全部东西。进行中的轮次正文必须与会话记录的指纹一致,否则不推(外部改动交给冲突机制);
// 已结束的轮次按规则⑤第 4 节事件表从归档读(完成稿 / 零批注通过的原稿),不拿实时工作稿冒充归档稿
async function readPushPayload(reviewId, options = {}) {
  const review = await store.getReviewById(reviewId, options);
  if (!review) throw new ReviewStoreError('REVIEW_NOT_FOUND', `找不到审阅会话: ${reviewId || ''}`, { httpStatus: 404 });
  if (!review.docId) throw new ReviewStoreError('SYNC_NOT_APPLICABLE', '这是旧会话,没有文档标识,不参与同步。', { httpStatus: 409 });
  // 处理结果只跟着正文一起推:正文没推(非 UTF-8、归档缺失、作废)时也不推引文与双方说明
  const item = { ...outboxItem(review, options), revision: await revisionFor(review, options), results: null };
  if (!item.contentAvailable) return { ...item, content: null, attachments: [], summary: review.summary || null };
  if (review.status === 'complete' && review.versionId) {
    const versionStore = require('./version-store');
    // 按不可变的事件类型选归档:零批注通过后再定稿,outcome 会变成 finalized,但那一轮仍只有原稿
    const meta = versionStore.readMetaFor(review.docId, review.versionId, options);
    const kind = meta && meta.kind ? meta.kind : (review.outcome === 'approved' ? 'approved' : 'review');
    const which = kind === 'approved' ? 'original' : 'final';
    const archived = versionStore.readVersion(review.docId, review.versionId, which, options);
    if (archived.available) {
      const decoded = require('./text-encoding').decodeText(archived.buffer);
      if (decoded.encoding !== 'utf-8') {
        // 非 UTF-8 文档首版不同步正文(跨端规则 v2.3 第 5 节):只推状态与摘要
        return { ...item, content: null, contentAvailable: false, attachments: [], summary: review.summary || null, archived: true, encoding: decoded.encoding };
      }
      const text = decoded.content;
      return { ...item, contentHash: archived.hash, content: text, attachments: collectAttachments(review.absPath, text), archived: true, results: resultsFor(review, options) };
    }
    // 归档缺失(发布失败 / 损坏):只推状态与摘要
    return { ...item, content: null, contentAvailable: false, attachments: [], summary: review.summary || null, archived: false };
  }
  let content;
  try { content = fs.readFileSync(review.absPath); } catch (error) {
    throw new ReviewStoreError('SOURCE_READ_FAILED', `无法读取源文档: ${error.message}`, { httpStatus: 404 });
  }
  const hash = sha256(content);
  // 非 UTF-8 文档(GBK 等)不推正文,只推状态(跨端规则第 5 节;以前这里按 UTF-8 硬解,手机会收到乱码)
  const decoded = require('./text-encoding').decodeText(content);
  const statusOnly = decoded.encoding !== 'utf-8'
    ? { content: null, contentAvailable: false, attachments: [], encoding: decoded.encoding } : null;
  const text = statusOnly ? '' : decoded.content;
  if (hash !== item.contentHash) {
    // 会话还在进行(批注中 / 等待改稿)时,正文被别的程序改了就不推,交给冲突机制;
    // 会话已结束(完成 / 作废 / 冲突)后文件本来就可以继续改,手机只需要看到最新正文和状态,按实际指纹推
    if (LIVE_STATES.has(review.status)) {
      throw new ReviewStoreError('SOURCE_CHANGED', '源文档内容与会话记录的版本不一致,暂不推送。', { httpStatus: 409, details: { expected: item.contentHash, actual: hash } });
    }
    if (statusOnly) return { ...item, contentHash: hash, sourceChanged: true, ...statusOnly };
    return { ...item, contentHash: hash, sourceChanged: true, content: text, attachments: collectAttachments(review.absPath, text) };
  }
  if (statusOnly) return { ...item, ...statusOnly };
  return { ...item, content: text, attachments: collectAttachments(review.absPath, text) };
}

// 发布序号(跨端规则 v2.3 第 12 节):每次新的发布(签名变化)分配一个跨轮单调的 revision,记在会话上;
// 同一次发布重试沿用原值。没有文档身份索引的旧会话不带 revision。
async function revisionFor(review, options = {}) {
  if (!review.docId) return null;
  const versionStore = require('./version-store');
  if (!versionStore.getDocument(review.docId, options)) return null;
  // 在文档事务内把"最新状态的签名"和 revision 绑在一起:重读最新记录再分配,旧快照 / 并发请求拿不到更大的序号
  return store.withReviewTransaction(review.absPath, async () => {
    const current = await store.getReviewById(review.id, options);
    if (!current) return null;
    const sync = current.sync || {};
    const signature = pushSignature(current, options);
    if (Number.isInteger(sync.revision) && sync.revisionSignature === signature) return sync.revision;
    if (pushSignature(review, options) !== signature) {
      // 调用方拿的是旧快照:它要发的那一版已经过时,不给序号(调用方会在同一轮重新取载荷)
      throw new ReviewStoreError('PUSH_STALE', '会话状态已变化,请重新取推送载荷。', { httpStatus: 409 });
    }
    const revision = await versionStore.allocateRevision(current.docId, options);
    await updateSync(current.id, (state) => { state.revision = revision; state.revisionSignature = signature; }, options);
    return revision;
  }, options);
}

// pending 可由调用方传入(listSyncStatus 的条目没有 sourceHash,自己算会误判成"有新内容")
function describeSync(review, pending = undefined) {
  const sync = review && review.sync;
  if (!review || !review.docId) return '不参与同步(旧会话)';
  if (review.otherAccount) return '属于另一个 iCloud 账号:换回原账号后接着同步';
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
  const account = currentAccount(options);
  const pushed = await store.getReviewById(reviewId, options);
  // 第一次推上去时记下这篇属于哪个 iCloud 账号(记在文档身份上,以后每一轮都跟着);推上去的附件记录名累计下来,云端清理时一并删
  if (pushed && pushed.docId) {
    const names = Array.isArray(input.attachments) ? input.attachments.filter((name) => typeof name === 'string') : [];
    await require('./version-store').noteCloudOwnership(pushed.docId, account, names, options);
  }
  return updateSync(reviewId, (sync, review) => {
    const now = new Date().toISOString();
    if (!sync.account && account) sync.account = account;
    delete sync.republishRequired;
    sync.pushedSignature = typeof input.signature === 'string' && input.signature ? input.signature : pushSignature(review, options);
    sync.pushedHash = input.contentHash || contentHashFor(review);
    sync.pushedAt = now;
    sync.error = null;
    if (sync.state === 'never') sync.state = 'pushed';
    if (review.status === 'reviewing') sync.state = 'pushed'; // 新一轮推出去后,之前的批次/回执状态不再适用
  }, options);
}

// 辅助程序发现云端记录的 revision 比本地要发的新(迟到的发布):本次作废,抬高水位,不再重试
async function markPushSuperseded(reviewId, cloudRevision, signature, options = {}) {
  const review = await store.getReviewById(reviewId, options);
  if (review && review.docId) await require('./version-store').raiseRevisionFloor(review.docId, cloudRevision, options);
  // 只确认被跳过的那一次发布(按签名);当前状态若已前进,仍要推
  return updateSync(reviewId, (sync, current) => {
    if (sync.republishRequired) {
      // 整体快照恢复后的重新发布被云端更高的旧发布挡住:不算推过,作废这次的序号,下一次在抬高后的水位之上重新分配再推
      delete sync.revision; delete sync.revisionSignature;
      sync.supersededByRevision = Number(cloudRevision) || null;
      sync.error = null;
      return;
    }
    if (typeof signature === 'string' && signature) sync.pushedSignature = signature;
    sync.pushedAt = new Date().toISOString();
    sync.error = null;
    sync.supersededByRevision = Number(cloudRevision) || null;
    // 当前状态若已前进、还带着一个低于云端水位的序号:作废它,下一次取载荷在新水位之上重新分配
    if (pushSignature(current, options) !== signature && Number.isInteger(sync.revision) && sync.revision <= Number(cloudRevision)) {
      delete sync.revision; delete sync.revisionSignature;
    }
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

// 云端容器更换(改名)后由辅助程序调用:所有还在保留期内、参与同步的文档从头再推一遍,手机那边重新拉
async function requestPushAll(options = {}) {
  const now = new Date().toISOString();
  let count = 0;
  await store.mutateReviews((data) => {
    for (const review of latestPerDocument(Object.values(data.reviews))) {
      if (!withinRetention(review)) continue;
      review.sync = { ...(review.sync || {}), state: 'never', pushedSignature: null, pushedHash: null, pushedAt: null, pushRequestedAt: now, error: null };
      count += 1;
    }
    return count;
  }, options);
  return { count };
}

// 辅助程序的心跳(账号、上次轮询时间、错误),写在数据目录里,供 status / 界面显示"同步是否在跑"
function helperStatePath(options = {}) { return path.join(store.getDataDir(options), 'sync-helper.json'); }
function readHelperState(options = {}) {
  try { return store.readJsonStrict(helperStatePath(options), null); } catch { return null; }
}
async function writeHelperState(state, options = {}) {
  const previous = readHelperState(options);
  const reported = typeof state.account === 'string' && state.account ? state.account : null;
  const clean = {
    account: typeof state.account === 'string' ? state.account.slice(0, 120) : null,
    accountStatus: typeof state.accountStatus === 'string' ? state.accountStatus.slice(0, 60) : null,
    environment: typeof state.environment === 'string' ? state.environment.slice(0, 30) : null,
    lastPollAt: new Date().toISOString(),
    error: typeof state.error === 'string' && state.error ? state.error.slice(0, 500) : null,
    version: typeof state.version === 'string' ? state.version.slice(0, 30) : null,
    // 报过一次账号以后就一直记着「知道过」:之后账号又未知(暂时不可用、刚换号)时推送队列为空
    accountEverKnown: Boolean((previous && previous.accountEverKnown) || reported),
  };
  await store.atomicWriteJson(helperStatePath(options), clean, { mode: 0o600 });
  // 第一次知道账号(升级上来,只做一次):以前推过、还没记账号的文档都算这个账号的,以后换账号时才分得开
  if (reported && !(previous && previous.accountEverKnown)) await adoptAccount(reported, options);
  return clean;
}

async function adoptAccount(account, options = {}) {
  const docIds = new Set();
  await store.mutateReviews((data) => {
    for (const review of Object.values(data.reviews || {})) {
      if (!review || !review.docId || !review.sync || !review.sync.pushedAt) continue;
      if (!review.sync.account) review.sync.account = account;
      docIds.add(review.docId);
    }
    return null;
  }, options);
  const versionStore = require('./version-store');
  for (const docId of docIds) await versionStore.noteCloudOwnership(docId, account, [], options);
  return docIds.size;
}

// 云端清理(跨端规则第 9、12 节):定稿或作废满 30 天,辅助程序删掉云端这篇的记录(文档、附件、批次、回执)。
// 只列当前账号的、推过的、还没清过的最新一轮;手机上的本地副本留着,用户自己删
const CLOUD_CLEANUP_DAYS = 30;
function receiptBatchIds(options = {}) {
  const byDoc = new Map();
  let names = [];
  try { names = fs.readdirSync(path.join(store.getDataDir(options), 'receipts')).filter((name) => name.endsWith('.json')); } catch { return byDoc; }
  for (const name of names) {
    let receipt = null;
    try { receipt = JSON.parse(fs.readFileSync(path.join(store.getDataDir(options), 'receipts', name), 'utf8')); } catch { continue; }
    if (!receipt || typeof receipt.docId !== 'string' || typeof receipt.batchId !== 'string') continue;
    if (!byDoc.has(receipt.docId)) byDoc.set(receipt.docId, []);
    byDoc.get(receipt.docId).push(receipt.batchId);
  }
  return byDoc;
}
async function listCloudCleanup(options = {}) {
  if (accountUnknown(options)) return [];
  const reviews = await store.listReviews(options);
  const account = currentAccount(options);
  const ownerOf = ownerLookup(options);
  const documents = require('./version-store').readIndex(options).documents || {};
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const batchesByDoc = receiptBatchIds(options);
  return latestPerDocument(reviews)
    .filter((review) => {
      const state = review.sync || {};
      if (!state.pushedAt || state.cloudCleanedAt || otherAccount(review, account, ownerOf)) return false;
      const ended = review.status === 'cancelled' || (review.status === 'complete' && review.outcome === 'finalized');
      if (!ended) return false;
      const at = Date.parse(review.finalizedAt || review.cancelledAt || review.completedAt || '');
      return Number.isFinite(at) && now - at > CLOUD_CLEANUP_DAYS * 86400000;
    })
    .map((review) => ({ docId: review.docId, reviewId: review.id, title: review.file, batchIds: batchesByDoc.get(review.docId) || [],
      attachments: Array.isArray((documents[review.docId] || {}).cloudAttachments) ? documents[review.docId].cloudAttachments : [] }));
}
async function markCloudCleaned(reviewId, options = {}) {
  if (!reviewId) throw new ReviewStoreError('BAD_ARGUMENT', '缺少 reviewId。', { httpStatus: 400 });
  const review = await store.getReviewById(reviewId, options);
  if (review && review.docId) await require('./version-store').clearCloudAttachments(review.docId, options);
  return updateSync(reviewId, (sync) => { sync.cloudCleanedAt = new Date().toISOString(); }, options);
}

module.exports = {
  SYNC_STATES,
  ATTACHMENT_LIMIT,
  ATTACHMENT_TOTAL_LIMIT,
  RETENTION_DAYS,
  phoneState,
  pushSignature,
  needsPush,
  resultsFor,
  MAC_PROTOCOL,
  listOutbox,
  listSyncStatus,
  currentAccount,
  listCloudCleanup,
  markCloudCleaned,
  CLOUD_CLEANUP_DAYS,
  collectAttachments,
  referencedPaths,
  readPushPayload,
  describeSync,
  markPushed,
  markPushError,
  markPushSuperseded,
  revisionFor,
  markBatchReceived,
  markReceiptSent,
  requestPush,
  requestPushAll,
  readHelperState,
  writeHelperState,
};
