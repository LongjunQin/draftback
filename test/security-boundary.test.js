'use strict';

// 安全收口(路线图 v3 第 5.8 节)的服务端边界:
//   1. /desktop 下发内容安全策略,且与 static/desktop.html 里的 meta 一致;
//   2. 所有审阅接口拒绝来自其他站点的浏览器请求,CLI/App 自身请求照常;
//   3. /api/app/file 只提供文档目录树、主目录、临时目录内的文件,
//      主目录与临时目录下不进入隐藏目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const store = require('../lib/review-store');
const PROJECT = path.resolve(__dirname, '..');

async function stopChild(child, timeoutMs = 8000) {
  if (child.exitCode !== null) return true;
  if (process.platform === 'win32') {
    const { spawnSync } = require('child_process');
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...(options.headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if ((res.headers['content-type'] || '').includes('application/json')) {
          try { json = JSON.parse(text); } catch {}
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForPort(portFile, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (port > 0) return port;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('server port timeout');
}

function metaCsp() {
  const html = fs.readFileSync(path.join(PROJECT, 'static', 'desktop.html'), 'utf8');
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  return match ? match[1] : null;
}

test('安全边界:内容安全策略、跨站来源拒绝、文档资源访问范围', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-security-'));
  const dataDir = path.join(root, '.draftback');
  const docDir = path.join(root, 'docs', 'reports');
  const siblingDir = path.join(root, 'assets');
  fs.mkdirSync(docDir, { recursive: true });
  fs.mkdirSync(siblingDir, { recursive: true });
  const doc = path.join(docDir, '方案.md');
  fs.writeFileSync(doc, '# 方案\n\n![图](./图.svg)\n');
  fs.writeFileSync(path.join(docDir, '图.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(siblingDir, '上级.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  store.ensureDataDir({ dataDir });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT,
    env: { ...process.env, DRAFTBACK_DATA_DIR: dataDir, DRAFTBACK_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    await stopChild(child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const port = await waitForPort(store.getPaths({ dataDir }).port, child);

  // 1. 内容安全策略:服务端头与页面 meta 一致,且禁止内联脚本与外联。
  const page = await request(port, '/desktop');
  assert.equal(page.status, 200, stderr);
  const headerCsp = page.headers['content-security-policy'];
  assert.ok(headerCsp, '/desktop 必须下发 Content-Security-Policy');
  assert.equal(headerCsp, metaCsp(), '服务端策略必须与 desktop.html 的 meta 完全一致');
  assert.match(headerCsp, /script-src 'self'(;|$)/, '脚本只能来自本机静态文件,不允许内联');
  assert.match(headerCsp, /connect-src 'self'(;|$)/, '页面只能连回本机服务');
  assert.match(headerCsp, /frame-src 'none'/);
  assert.match(headerCsp, /object-src 'none'/);
  assert.ok(fs.existsSync(path.join(PROJECT, 'static', 'vendor', 'dompurify.min.js')), '净化库必须随静态文件发布');

  // 2. 跨站来源:浏览器里打开的网页不得代替用户提交批注;无来源(CLI/App)照常。
  const opened = await store.openReview(doc, { dataDir });
  const reviewId = opened.review.id;
  const note = { comment: '来自网页的批注', quote: '方案', clientRequestId: 'cross-site-1' };
  const crossOrigin = await request(port, `/api/annotations?r=${reviewId}`, {
    method: 'POST', body: note, headers: { Origin: 'https://evil.example' },
  });
  assert.equal(crossOrigin.status, 404, '外站 Origin 必须被拒绝');
  const crossSite = await request(port, `/api/annotations?r=${reviewId}`, {
    method: 'POST', body: note, headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 404, 'Sec-Fetch-Site: cross-site 必须被拒绝');
  const crossList = await request(port, '/api/reviews', { headers: { Origin: 'https://evil.example' } });
  assert.equal(crossList.status, 404, '审阅列表也不对外站开放');
  assert.equal(store.readAnnotations(doc).annotations.length, 0, '被拒绝的请求不得落盘');
  const sameOrigin = await request(port, `/api/annotations?r=${reviewId}`, {
    method: 'POST', body: note, headers: { Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(sameOrigin.status, 200, '本机页面的请求照常');
  const noOrigin = await request(port, '/api/reviews');
  assert.equal(noOrigin.status, 200, 'CLI 请求不带来源,照常');

  // 3. 文档资源访问范围。
  const file = (candidate) => request(port, `/api/app/file?r=${reviewId}&path=${encodeURIComponent(candidate)}`);
  assert.equal((await file('./图.svg')).status, 200, '文档同目录的图片可用');
  assert.equal((await file('../../assets/上级.svg')).status, 200, '临时目录内的上级目录资源可用');
  assert.equal((await file(path.join(siblingDir, '上级.svg'))).status, 200, '允许范围内的绝对路径可用');
  assert.equal((await file(path.join(dataDir, 'reviews.json'))).status, 404, '临时目录下的隐藏目录(.draftback)不可读');
  assert.equal((await file('../../.draftback/reviews.json')).status, 404, '相对路径绕进隐藏目录同样不可读');
  const hostsFile = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
  assert.equal((await file(hostsFile)).status, 404, '允许范围之外的系统文件不可读');
  assert.equal((await file('./不存在.svg')).status, 404);
});
