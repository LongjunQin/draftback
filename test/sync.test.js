'use strict';

// 跨端同步的 Mac 侧状态(跨端规则第 12 节):文档标识与轮次、待推送队列、推送内容、同步状态推进、
// 按文档标识匹配手机批次,以及 /api/app/sync/* 路由。云端读写在原生辅助程序里,这里不涉及。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const store = require('../lib/review-store');
const sync = require('../lib/sync');
const batches = require('../lib/batches');
const PROJECT = path.resolve(__dirname, '..');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-sync-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
function sidecar(doc, annotations) {
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: path.basename(doc), annotations }));
}

test('open 分配文档标识与轮次,同一路径后续轮次沿用 docId;旧会话没有 docId 不参与同步', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n\n正文。\n');
  const first = (await store.openReview(doc, f.options)).review;
  assert.match(first.docId, /^doc_[0-9a-f]{16}$/);
  assert.equal(first.round, 1);
  assert.equal(first.sync.state, 'never');
  assert.ok(first.sync.pushRequestedAt);

  sidecar(doc, []);
  await store.submitReview(first.id, f.options); // 无批注 → complete/approved
  const second = (await store.openReview(doc, f.options)).review;
  assert.notEqual(second.id, first.id);
  assert.equal(second.docId, first.docId, '同一路径沿用文档标识');
  assert.equal(second.round, 2);

  // 另一个路径 → 新 docId
  const other = path.join(f.docDir, '另一篇.md');
  fs.writeFileSync(other, '# 另一篇\n');
  assert.notEqual((await store.openReview(other, f.options)).review.docId, first.docId);
  assert.equal(sync.needsPush({ id: 'legacy', status: 'reviewing', sourceHash: 'x' }), false, '没有 docId 的旧会话不推');
});

test('待推送队列:open 后待推,推完清空;提交、改稿、完成各自再推一次;改稿期间不带正文', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '带图', '说明.md');
  fs.mkdirSync(path.join(f.docDir, '带图', 'images'), { recursive: true });
  fs.writeFileSync(path.join(f.docDir, '带图', 'images', 'a.png'), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(f.docDir, 'outside.png'), Buffer.from([9]));
  const body = '# 说明\n\n![示意](images/a.png)\n\n<img src="images/a.png?x=1">\n\n[外面](../outside.png) [网图](https://e.com/x.png) [本页](#top)\n\n正文。\n';
  fs.writeFileSync(doc, body);
  const { review } = await store.openReview(doc, f.options);

  let outbox = await sync.listOutbox(f.options);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].reviewId, review.id);
  assert.equal(outbox[0].status, 'reviewing');
  assert.equal(outbox[0].phoneState, 'reviewing');
  assert.equal(outbox[0].contentAvailable, true);
  assert.equal(outbox[0].contentHash, review.sourceHash);

  const payload = await sync.readPushPayload(review.id, f.options);
  assert.equal(payload.content, body);
  assert.deepEqual(payload.attachments.map((item) => item.relPath), ['images/a.png'], '目录树外、网址、锚点都不打包;同一文件只一次');
  assert.equal(payload.attachments[0].sha256, sha(Buffer.from([1, 2, 3, 4])));
  assert.equal(payload.attachments[0].included, true);

  await sync.markPushed(review.id, { signature: payload.signature, contentHash: payload.contentHash }, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 0, '推完就不再待推');
  assert.match(sync.describeSync(await store.getReviewById(review.id, f.options)), /已推到手机/);

  // 再 open 一次 = 要求再推
  await store.openReview(doc, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 1);
  await sync.markPushed(review.id, {}, f.options);

  // 用户提交 → 状态变了要推(手机显示"等待智能体"),正文仍可用
  sidecar(doc, [{ id: 'n1', comment: '改', status: 'open' }]);
  await store.submitReview(review.id, f.options);
  outbox = await sync.listOutbox(f.options);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].phoneState, 'waiting-agent');
  assert.equal(outbox[0].contentAvailable, true);
  await sync.markPushed(review.id, {}, f.options);

  // 改稿期间:只推状态,不带正文(磁盘上是半成品)
  await store.beginApply(doc, f.options);
  fs.writeFileSync(doc, body.replace('正文。', '正文(改)。'));
  outbox = await sync.listOutbox(f.options);
  assert.equal(outbox[0].phoneState, 'applying');
  assert.equal(outbox[0].contentAvailable, false);
  const partial = await sync.readPushPayload(review.id, f.options);
  assert.equal(partial.content, null);
  await sync.markPushed(review.id, {}, f.options);

  // 完成 → 新版 + 摘要
  sidecar(doc, [{ id: 'n1', comment: '改', status: 'applied', appliedNote: '已改' }]);
  const done = await store.completeReview(doc, { ...f.options, summary: '把"正文"改成了"正文(改)"。' });
  assert.equal(done.summary, '把"正文"改成了"正文(改)"。');
  outbox = await sync.listOutbox(f.options);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].phoneState, 'completed');
  assert.equal(outbox[0].contentHash, done.finalHash);
  assert.equal(outbox[0].summary, done.summary);
  const final = await sync.readPushPayload(review.id, f.options);
  assert.match(final.content, /正文\(改\)/);
  // 稿子回来带本轮处理结果(v2.4):与 Mac 回稿卡同一个函数算,数据来自版本事件
  assert.equal(final.results.applied, 1);
  assert.equal(final.results.wontfix, 0);
  assert.equal(final.results.items.length, 1);
  assert.deepEqual({ id: final.results.items[0].id, you: final.results.items[0].you, ai: final.results.items[0].ai, status: final.results.items[0].status },
    { id: 'n1', you: '改', ai: '已改', status: 'applied' });
  assert.equal(partial.results, null, '改稿中不带处理结果');
});

test('已交出三档(没人接入 / AI 在线 / 已领取)一变就再推;其他状态的签名不带三档', async (t) => {
  const f = fixture(t);
  const presence = require('../lib/agent-presence');
  const doc = path.join(f.docDir, '三档.md');
  fs.writeFileSync(doc, '# 三档\n\n正文。\n');
  const { review } = await store.openReview(doc, f.options);
  const reviewing = await store.getReviewById(review.id, f.options);
  assert.doesNotMatch(sync.pushSignature(reviewing, f.options), /\|(none|listening|claimed)$/, '批注中不带三档');
  await sync.markPushed(review.id, {}, f.options);

  sidecar(doc, [{ id: 'n1', comment: '改', status: 'open' }]);
  await store.submitReview(review.id, f.options);
  let outbox = await sync.listOutbox(f.options);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].agentState, 'none');
  await sync.markPushed(review.id, { signature: outbox[0].signature }, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 0);

  await presence.register(review.id, { agent: 'Claude' }, f.options);
  outbox = await sync.listOutbox(f.options);
  assert.equal(outbox.length, 1, 'AI 开始监听要再推');
  assert.equal(outbox[0].agentState, 'listening');
  const payload = await sync.readPushPayload(review.id, f.options);
  assert.equal(payload.agentState, 'listening', '推送载荷带三档');
  await sync.markPushed(review.id, { signature: payload.signature }, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 0, '续期不改三档,不重推');
  await presence.register(review.id, { agent: 'Claude' }, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 0);

  await presence.unregister(review.id, f.options);
  outbox = await sync.listOutbox(f.options);
  assert.equal(outbox[0].agentState, 'none', '监听没了要再推,手机不再显示在线');
  await sync.markPushed(review.id, { signature: outbox[0].signature }, f.options);

  await store.claimReview(doc, { agent: 'Claude', expectedReviewId: review.id, ...f.options });
  outbox = await sync.listOutbox(f.options);
  assert.equal(outbox[0].agentState, 'claimed', '领取要再推');
  assert.equal(outbox[0].phoneState, 'waiting-agent');
});

test('正文与会话指纹不一致时不推送;推送失败与批次/回执状态逐级记录', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '外改.md');
  fs.writeFileSync(doc, '# 外改\n');
  const { review } = await store.openReview(doc, f.options);
  fs.writeFileSync(doc, '# 外改\n\n被别的程序改了。\n');
  await assert.rejects(() => sync.readPushPayload(review.id, f.options), (error) => error.code === 'SOURCE_CHANGED');

  await sync.markPushError(review.id, '网络不可用', f.options);
  assert.match(sync.describeSync(await store.getReviewById(review.id, f.options)), /网络不可用/);
  await sync.markBatchReceived(review.id, { batchId: 'b1', accepted: true }, f.options);
  assert.equal((await store.getReviewById(review.id, f.options)).sync.state, 'batch-received');
  await sync.markReceiptSent(review.id, 'b1', f.options);
  const after = await store.getReviewById(review.id, f.options);
  assert.equal(after.sync.state, 'receipt-sent');
  assert.equal(after.sync.lastReceiptBatchId, 'b1');
  assert.match(sync.describeSync(after), /已向手机发回执/);

  await sync.requestPush(doc, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 1);
  await assert.rejects(() => sync.requestPush(path.join(f.docDir, '没有.md'), f.options), (error) => error.code === 'NO_ACTIVE_REVIEW' || error.code === 'INVALID_PATH' || error.httpStatus === 404);
});

test('会话结束后源文档再改:作废只推状态;完成从归档推完成稿,不拿工作稿冒充', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '收尾.md');
  fs.writeFileSync(doc, '# 收尾\n');
  const { review } = await store.openReview(doc, f.options);
  await store.unlockReview(doc, '测试', f.options); // → cancelled
  fs.writeFileSync(doc, '# 收尾\n\n作废后继续改。\n');
  const payload = await sync.readPushPayload(review.id, f.options);
  assert.equal(payload.contentAvailable, false, '作废的轮次只推状态(规则⑤事件表)');
  assert.equal(payload.content, null);
  assert.equal(payload.phoneState, 'cancelled');

  // 完成的轮次:改稿后 complete,之后用户再普通编辑 → 推送的仍是归档的完成稿
  const doc2 = path.join(f.docDir, '完成.md');
  fs.writeFileSync(doc2, '# 完成\n\n原文。\n');
  const second = (await store.openReview(doc2, f.options)).review;
  sidecar(doc2, [{ id: 'n1', comment: '改', status: 'open', reviewSessionId: second.id }]);
  await store.submitReview(second.id, f.options);
  await store.beginApply(doc2, { applyMode: 'agent', ...f.options });
  fs.writeFileSync(doc2, '# 完成\n\n改好的正文。\n');
  sidecar(doc2, [{ id: 'n1', comment: '改', status: 'applied', reviewSessionId: second.id }]);
  await store.completeReview(doc2, { summary: '改了一句', ...f.options });
  const archivedHash = sha(fs.readFileSync(doc2));
  fs.writeFileSync(doc2, '# 完成\n\n完成后又手痒改了一笔。\n');
  const done = await sync.readPushPayload(second.id, f.options);
  assert.equal(done.archived, true);
  assert.equal(done.contentHash, archivedHash);
  assert.match(done.content, /改好的正文/);
  assert.doesNotMatch(done.content, /手痒/);

  await sync.markPushError(review.id, '上次的错', f.options);
  const item = (await sync.listOutbox(f.options)).find((entry) => entry.reviewId === review.id);
  assert.equal(item.lastError, '上次的错', '队列条目带上次错误,辅助程序据此去重日志');
});

test('批次按文档标识匹配会话:两篇内容相同的文档不会串', async (t) => {
  const f = fixture(t);
  const a = path.join(f.docDir, 'A.md'); const b = path.join(f.docDir, 'B.md');
  fs.writeFileSync(a, '# 同\n正文\n'); fs.writeFileSync(b, '# 同\n正文\n');
  const ra = (await store.openReview(a, f.options)).review;
  const rb = (await store.openReview(b, f.options)).review;
  assert.equal(ra.sourceHash, rb.sourceHash);
  const batch = {
    version: 2, batchId: 'docid-batch-0001', docId: rb.docId, reviewId: rb.id, documentName: 'A.md', baseVersion: rb.sourceHash,
    completedAt: new Date().toISOString(), device: '测试 iPhone',
    annotations: [{ id: 'n-1', comment: '给 B 的批注', quote: '正文', anchorVersion: 3, lineStart: 2, lineEnd: 2, startTextOffset: 0, endTextOffset: 2, docId: rb.docId, reviewId: rb.id, baseVersion: rb.sourceHash }],
  };
  const result = await batches.importBatch(batch, f.options);
  assert.equal(result.receipt.accepted, true, result.receipt.message);
  assert.equal(result.review.id, rb.id, '文件名写错也按 docId 落到 B');
  assert.equal(store.readAnnotations(b).annotations.length, 1);
  assert.equal(store.readAnnotations(a).annotations.length, 0);
});

// ---------- 路由 ----------
function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function startServer(t, f) {
  const child = spawn(process.execPath, ['server.js'], { cwd: PROJECT, env: { ...process.env, DRAFTBACK_DATA_DIR: f.dataDir, DRAFTBACK_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); } });
  const portFile = store.getPaths({ dataDir: f.dataDir }).port;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try { const port = Number(fs.readFileSync(portFile, 'utf8').trim()); if (port > 0) return { port }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('server port timeout');
}

test('/api/app/sync/*:辅助程序取队列、取正文、报推送、送批次、报回执、心跳', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '路由.md');
  fs.writeFileSync(doc, '# 路由\n\n正文\n');
  const { review } = await store.openReview(doc, f.options);
  const { port } = await startServer(t, f);

  const outbox = await request(port, '/api/app/sync/outbox');
  assert.equal(outbox.status, 200, outbox.text);
  assert.equal(outbox.json.items.length, 1);
  assert.equal(outbox.json.helper, null);

  const payload = await request(port, `/api/app/sync/document?r=${review.id}`);
  assert.equal(payload.status, 200, payload.text);
  assert.equal(payload.json.content, '# 路由\n\n正文\n');

  const pushed = await request(port, '/api/app/sync/pushed', { method: 'POST', body: { reviewId: review.id, signature: payload.json.signature, contentHash: payload.json.contentHash } });
  assert.equal(pushed.status, 200, pushed.text);
  assert.equal(pushed.json.sync.state, 'pushed');
  assert.equal((await request(port, '/api/app/sync/outbox')).json.items.length, 0);

  const heartbeat = await request(port, '/api/app/sync/heartbeat', { method: 'POST', body: { account: 'iCloud 用户', accountStatus: 'available', environment: 'development', version: '0.1' } });
  assert.equal(heartbeat.status, 200);
  assert.equal((await request(port, '/api/app/sync/status')).json.helper.account, 'iCloud 用户');

  const batch = {
    version: 2, batchId: 'route-batch-0001', docId: review.docId, reviewId: review.id, documentName: '路由.md', baseVersion: review.sourceHash,
    completedAt: new Date().toISOString(), device: '测试 iPhone',
    annotations: [{ id: 'n-r1', comment: '路由批注', quote: '正文', anchorVersion: 3, lineStart: 3, lineEnd: 3, startTextOffset: 0, endTextOffset: 2, docId: review.docId, reviewId: review.id, baseVersion: review.sourceHash }],
  };
  const imported = await request(port, '/api/app/sync/batch', { method: 'POST', body: { batch } });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.json.receipt.accepted, true, imported.json.receipt.message);
  assert.equal((await store.getReviewById(review.id, f.options)).sync.state, 'batch-received');
  assert.equal((await store.getReviewById(review.id, f.options)).status, 'ready_to_apply');

  const receipt = await request(port, '/api/app/sync/receipt-sent', { method: 'POST', body: { reviewId: review.id, batchId: batch.batchId } });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.json.sync.state, 'receipt-sent');
  // 状态变了(ready_to_apply)→ 再次待推,手机才能显示"等待智能体"
  assert.equal((await request(port, '/api/app/sync/outbox')).json.items[0].phoneState, 'waiting-agent');
  assert.equal((await request(port, '/api/app/sync/nothing', { method: 'POST', body: {} })).status, 404);

  // 别的电脑发起的文档(这台 Mac 没见过这个标识):拒收但标明 documentKnown=false,同步程序据此不写回执
  const foreign = await request(port, '/api/app/sync/batch', { method: 'POST', body: { batch: { ...batch, batchId: 'b-foreign', docId: 'doc_0000000000000000', reviewId: 'r000000000000000000000000', baseVersion: 'e'.repeat(64), documentName: '别台电脑的稿.md', annotations: batch.annotations.map((n) => ({ ...n, docId: 'doc_0000000000000000', reviewId: 'r000000000000000000000000', baseVersion: 'e'.repeat(64) })) } } });
  assert.equal(foreign.json.receipt.reason, 'no-session');
  assert.equal(foreign.json.documentKnown, false);
});

test('云端容器更换后 /api/app/sync/reset 让保留期内的文档全部重新待推', async (t) => {
  const f = fixture(t);
  const a = path.join(f.docDir, '甲.md');
  const b = path.join(f.docDir, '乙.md');
  fs.writeFileSync(a, '# 甲\n');
  fs.writeFileSync(b, '# 乙\n');
  const { review: ra } = await store.openReview(a, f.options);
  const { review: rb } = await store.openReview(b, f.options);
  await sync.markPushed(ra.id, { signature: sync.pushSignature(ra), contentHash: ra.sourceHash }, f.options);
  await sync.markPushed(rb.id, { signature: sync.pushSignature(rb), contentHash: rb.sourceHash }, f.options);
  assert.equal((await sync.listOutbox(f.options)).length, 0, '都推过了,队列应为空');
  const result = await sync.requestPushAll(f.options);
  assert.equal(result.count, 2);
  const outbox = await sync.listOutbox(f.options);
  assert.deepEqual(outbox.map((item) => item.reviewId).sort(), [ra.id, rb.id].sort());
  assert.equal((await store.getReviewById(ra.id, f.options)).sync.state, 'never');
});
