'use strict';

// 智能体接手路径(电脑版规划 v3 第 4.1 节规则②):监听登记与领取分开记;
// wait 挂着=在听,交出后转为交棒,领取以 claim / begin-apply 为准;服务端摘要与事件带三档;CLI 真实跑一遍。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const store = require('../lib/review-store');
const presence = require('../lib/agent-presence');
const PROJECT = path.resolve(__dirname, '..');
const MDREVIEW = path.join(PROJECT, 'mdreview.js');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-presence-')));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, dataDir, docDir, options: { dataDir } };
}
function sidecar(doc, annotations) {
  fs.writeFileSync(`${doc}.annotations.json`, JSON.stringify({ version: 1, file: path.basename(doc), annotations }));
}

test('监听登记:登记即在听,90 秒没续期失效;交棒后 15 分钟内仍算在线;注销即离开', async (t) => {
  const f = fixture(t);
  const id = 'r_listen';
  assert.deepEqual(presence.describe(id, f.options), { listening: false });
  await presence.register(id, { agent: 'Claude Code' }, f.options);
  const now = Date.now();
  const live = presence.describe(id, f.options, now);
  assert.equal(live.listening, true);
  assert.equal(live.agent, 'Claude Code');
  assert.equal(live.handoff, false);
  assert.equal(presence.describe(id, f.options, now + presence.LISTEN_TTL_MS + 1000).listening, false, '没续期就失效');
  await presence.heartbeat(id, { agent: 'Claude Code' }, f.options);
  assert.equal(presence.describe(id, f.options, Date.now() + 60_000).listening, true, '续期后仍在线');

  await presence.handoff(id, { agent: 'Claude Code' }, f.options);
  const handed = presence.describe(id, f.options, Date.now() + presence.LISTEN_TTL_MS + 1000);
  assert.equal(handed.listening, true, '交棒后没有心跳也算在线');
  assert.equal(handed.handoff, true);
  assert.equal(presence.describe(id, f.options, Date.now() + presence.HANDOFF_MS + 1000).listening, false, '交棒过期回到没人在听');

  assert.equal(await presence.unregister(id, f.options), true);
  assert.equal(presence.describe(id, f.options).listening, false);
  assert.equal(await presence.unregister(id, f.options), false, '重复注销无害');
});

test('领取:只有已交出的会话能领;begin-apply 也算领取;三档随之变化', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '接手.md');
  fs.writeFileSync(doc, '# 接手\n');
  const { review } = await store.openReview(doc, f.options);
  await assert.rejects(() => store.claimReview(doc, { agent: 'Codex', ...f.options }), (error) => error.code === 'INVALID_STATE');
  assert.equal(presence.agentStateFor(review, { listening: false }), null, '批注中不适用三档');

  sidecar(doc, [{ id: 'n1', comment: '改', status: 'open' }]);
  const submitted = (await store.submitReview(review.id, f.options)).review;
  assert.equal(presence.withAgentState(submitted, f.options).agentState, 'none', '交出后没人在听');
  await presence.register(submitted.id, { agent: 'Codex' }, f.options);
  assert.equal(presence.withAgentState(submitted, f.options).agentState, 'listening');

  const claimed = await store.claimReview(doc, { agent: 'Codex', expectedReviewId: submitted.id, ...f.options });
  assert.equal(claimed.claimedBy, 'Codex');
  assert.ok(claimed.claimedAt);
  assert.equal(presence.withAgentState(claimed, f.options).agentState, 'claimed');
  await assert.rejects(() => store.claimReview(doc, { agent: 'x', expectedReviewId: 'other', ...f.options }), (error) => error.code === 'REVIEW_SESSION_MISMATCH');

  // 另一篇:不 claim 直接 begin-apply,也要记为领取
  const doc2 = path.join(f.docDir, '直接改.md');
  fs.writeFileSync(doc2, '# 直接改\n');
  const second = (await store.openReview(doc2, f.options)).review;
  sidecar(doc2, [{ id: 'n1', comment: '改', status: 'open' }]);
  await store.submitReview(second.id, f.options);
  const applying = await store.beginApply(doc2, { applyMode: 'agent', applyActor: 'Claude Code', ...f.options });
  assert.equal(applying.claimedBy, 'Claude Code');
  assert.equal(presence.agentStateFor(applying, { listening: false }), 'claimed');
  // 已在改的会话再 claim 不报错、不改状态
  const again = await store.claimReview(doc2, { agent: 'Codex', ...f.options });
  assert.equal(again.status, 'applying');
  assert.equal(again.claimedBy, 'Claude Code');
  // 用户自己改(manual)不算 AI 领取
  const doc3 = path.join(f.docDir, '自己改.md');
  fs.writeFileSync(doc3, '# 自己改\n');
  const third = (await store.openReview(doc3, f.options)).review;
  sidecar(doc3, [{ id: 'n1', comment: '改', status: 'open' }]);
  await store.submitReview(third.id, f.options);
  const manual = await store.beginApply(doc3, { applyMode: 'manual', ...f.options });
  assert.equal(manual.claimedAt, undefined);
  assert.equal(presence.agentStateFor(manual, { listening: true }), null);
});

function runNodeAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(label, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await sleep(100);
  }
}

test('mdreview wait 挂着时登记在听;用户交出后 wait 返回并转为交棒;claim 命令领取;再次 wait 清掉交棒', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '等待接手.md');
  fs.writeFileSync(doc, '# 等待接手\n');
  const env = { DRAFTBACK_DATA_DIR: f.dataDir, DRAFTBACK_WAIT_POLL_MS: '200', DRAFTBACK_AGENT: '测试智能体' };
  assert.equal((await runNodeAsync([MDREVIEW, 'open', doc, '--no-open'], env)).status, 0);
  const review = await store.getReviewByPath(doc, f.options);

  const waiting = runNodeAsync([MDREVIEW, 'wait', doc, '--timeout-minutes', '1'], env);
  const listening = await waitFor('wait 登记', () => { const who = presence.describe(review.id, f.options); return who.listening ? who : null; });
  assert.equal(listening.agent, '测试智能体');
  assert.equal(listening.handoff, false);

  sidecar(doc, [{ id: 'n1', comment: '改一下', status: 'open' }]);
  await store.submitReview(review.id, f.options);
  const result = await waiting;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mdreview claim/);
  const handed = presence.describe(review.id, f.options);
  assert.equal(handed.listening, true, 'wait 返回去读批注这段时间仍算在线');
  assert.equal(handed.handoff, true);
  const beforeClaim = await runNodeAsync([MDREVIEW, 'status', doc], env);
  assert.match(beforeClaim.stdout, /在听.*尚未领取/);

  const claim = await runNodeAsync([MDREVIEW, 'claim', doc], env);
  assert.equal(claim.status, 0, claim.stderr);
  const claimed = await store.getReviewByPath(doc, f.options);
  assert.equal(claimed.claimedBy, '测试智能体');
  assert.match((await runNodeAsync([MDREVIEW, 'status', doc], env)).stdout, /已领取\(测试智能体/);

  // 改完 complete,再挂 wait:登记回到"在听"(不是交棒)
  await store.beginApply(doc, { applyMode: 'agent', applyActor: '测试智能体', ...f.options });
  sidecar(doc, [{ id: 'n1', comment: '改一下', status: 'applied' }]);
  await store.completeReview(doc, f.options);
  const waiting2 = runNodeAsync([MDREVIEW, 'wait', doc, '--timeout-minutes', '1'], env);
  await waitFor('第二次 wait 登记', () => { const who = presence.describe(review.id, f.options); return who.listening && !who.handoff ? who : null; });
  // 用户定稿 → wait 返回并注销
  await store.finalizeReview(review.id, f.options);
  const result2 = await waiting2;
  assert.equal(result2.status, 0, result2.stderr);
  assert.equal(presence.describe(review.id, f.options).listening, false, '定稿后注销');
});

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(8000)]);
}

test('本地服务:摘要与 bundle 带三档;listen / unlisten / claim 路由;事件带 agentState', async (t) => {
  const f = fixture(t);
  const doc = path.join(f.docDir, '服务接手.md');
  fs.writeFileSync(doc, '# 服务接手\n');
  const child = spawn(process.execPath, ['server.js'], { cwd: PROJECT, env: { ...process.env, DRAFTBACK_DATA_DIR: f.dataDir, DRAFTBACK_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopChild(child));
  const portFile = store.getPaths(f.options).port;
  const port = await waitFor('服务端口', () => { try { const value = Number(fs.readFileSync(portFile, 'utf8').trim()); return value > 0 ? value : null; } catch { return null; } });

  const { review } = await store.openReview(doc, f.options);
  sidecar(doc, [{ id: 'n1', comment: '改', status: 'open' }]);
  await store.submitReview(review.id, f.options);

  const bundle = await request(port, `/api/app/bundle?r=${review.id}`);
  assert.equal(bundle.json.review.agentState, 'none');
  assert.equal(bundle.json.review.agent.listening, false);
  assert.ok(bundle.json.review.cliScript.endsWith('mdreview.js'));

  const bad = await request(port, '/api/app/review/listen', { method: 'POST', body: { reviewSessionId: 'nope', agent: 'x' } });
  assert.equal(bad.status, 404);
  const listened = await request(port, '/api/app/review/listen', { method: 'POST', body: { reviewSessionId: review.id, agent: 'Claude Code' } });
  assert.equal(listened.status, 200);
  assert.equal(listened.json.agent.listening, true);
  assert.equal((await request(port, `/api/app/bundle?r=${review.id}`)).json.review.agentState, 'listening');
  const listed = await request(port, '/api/reviews');
  assert.equal(listed.json.reviews.find((item) => item.id === review.id).agentState, 'listening');

  const handed = await request(port, '/api/app/review/listen', { method: 'POST', body: { reviewSessionId: review.id, agent: 'Claude Code', handoff: true } });
  assert.equal(handed.json.agent.handoff, true);

  const claimed = await request(port, `/api/app/review/claim?r=${review.id}`, { method: 'POST', body: { agent: 'Claude Code' } });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.review.agentState, 'claimed');
  assert.equal(claimed.json.review.claimedBy, 'Claude Code');

  const left = await request(port, '/api/app/review/unlisten', { method: 'POST', body: { reviewSessionId: review.id } });
  assert.equal(left.status, 200);
  assert.equal(left.json.agent.listening, false);
  assert.equal((await request(port, `/api/app/bundle?r=${review.id}`)).json.review.agentState, 'claimed', '领取是会话上的事实,不随监听消失');
});
