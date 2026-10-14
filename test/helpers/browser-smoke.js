'use strict';

// 真实无头 Chrome 冒烟测试的公共部分:隔离 draftback-service 服务、Chrome 启动、CDP 客户端。
// 被 desktop-security-smoke.js 与 desktop-plain-document-smoke.js 共用,无 npm 依赖。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('../../lib/review-store');

const PROJECT = path.resolve(__dirname, '..', '..');
const STEP_TIMEOUT = 12_000;
const POLL_INTERVAL = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('FAIL: 未找到 Google Chrome/Chromium,可用 CHROME_BIN 指定程序。');
  return found;
}

async function waitUntil(label, predicate, timeout = STEP_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`FAIL: 等待超时(${label})${lastError ? `: ${lastError.message}` : ''}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
  ]);
}

class CdpClient {
  constructor(url) {
    this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null;
    this.exceptions = []; this.consoleMessages = []; this.dialogs = []; this.nextPromptText = null;
  }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FAIL: CDP WebSocket 连接超时')), STEP_TIMEOUT);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('FAIL: CDP WebSocket 连接失败')); }, { once: true });
    });
    this.socket.addEventListener('message', (event) => { this.onMessage(event).catch(() => {}); });
    this.socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('FAIL: CDP WebSocket 提前关闭')); }
      this.pending.clear();
    });
  }
  async onMessage(event) {
    let text = event.data;
    if (typeof text !== 'string') {
      if (text instanceof ArrayBuffer) text = Buffer.from(text).toString('utf8');
      else if (ArrayBuffer.isView(text)) text = Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString('utf8');
      else if (text && typeof text.text === 'function') text = await text.text();
      else text = String(text);
    }
    const message = JSON.parse(text);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`FAIL: CDP ${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params && message.params.exceptionDetails;
      this.exceptions.push((detail && (detail.text || (detail.exception && detail.exception.description))) || 'unknown exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params) {
      this.consoleMessages.push({ type: message.params.type, text: (message.params.args || []).map((arg) => arg.value || arg.description || '').join(' ') });
    }
    if (message.method === 'Log.entryAdded' && message.params && message.params.entry) {
      this.consoleMessages.push({ type: message.params.entry.level, text: message.params.entry.text || '' });
    }
    if (message.method === 'Page.javascriptDialogOpening') {
      this.dialogs.push({ type: message.params.type, message: message.params.message });
      const params = { accept: true };
      if (this.nextPromptText !== null) { params.promptText = this.nextPromptText; this.nextPromptText = null; }
      await this.send('Page.handleJavaScriptDialog', params);
    }
  }
  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`FAIL: CDP 未连接,无法执行 ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`FAIL: CDP 命令超时: ${method}`)); }, STEP_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails;
      throw new Error(`FAIL: 页面脚本异常: ${(detail.exception && detail.exception.description) || detail.text || 'unknown'}`);
    }
    return response.result && response.result.value;
  }
}

async function startServer(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT, env: { ...process.env, DRAFTBACK_DATA_DIR: dataDir, DRAFTBACK_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const portFile = store.getPaths({ dataDir }).port;
  const port = await waitUntil('draftback-service 隔离服务端口', async () => {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      const value = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (!Number.isInteger(value) || value <= 0) return null;
      const response = await fetch(`http://127.0.0.1:${value}/api/health`);
      return response.ok ? value : null;
    } catch (_) { return null; }
  });
  return { child, port, stderr: () => stderr };
}

async function startChrome(profileDir) {
  const child = spawn(chromeExecutable(), [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-extensions', '--disable-sync', '--disable-translate', '--disable-gpu',
    '--disable-features=MediaRouter,OptimizationHints,Translate', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const port = await waitUntil('Chrome DevTools 端口', () => {
    if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}: ${stderr}`);
    try {
      const value = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch (_) { return null; }
  });
  const target = await waitUntil('Chrome 页面 target', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null;
    } catch (_) { return null; }
  });
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  return { child, cdp, stderr: () => stderr };
}


module.exports = { PROJECT, STEP_TIMEOUT, sleep, waitUntil, stopChild, CdpClient, startServer, startChrome, chromeExecutable };
