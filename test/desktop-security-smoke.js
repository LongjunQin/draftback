#!/usr/bin/env node
'use strict';

// MDTurn 桌面页安全冒烟(真实无头 Chrome,无 npm 依赖)。
//
// 验证路线图 v3 第 5.8 节"安全收口"在真实浏览器里的效果:
//   - 文档夹带的 <script>、事件属性、javascript: 链接、<iframe>、<style> 不进入页面;
//   - 排版用途的原始 HTML(带 id 的 <p>、<b>、<details>)照常保留;
//   - Mermaid 在 strict 模式下仍能出图;
//   - 内容安全策略存在,且正常阅读与进入编辑模式都不触发策略告警。
//
// 用法: node test/desktop-security-smoke.js   (需要本机有 Google Chrome / Chromium)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('../lib/review-store');

const PROJECT = path.resolve(__dirname, '..');
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
    this.exceptions = []; this.consoleMessages = []; this.dialogs = [];
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
      await this.send('Page.handleJavaScriptDialog', { accept: true });
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
    cwd: PROJECT, env: { ...process.env, MDREAD_DATA_DIR: dataDir, MDREAD_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const portFile = store.getPaths({ dataDir }).port;
  const port = await waitUntil('md-read 隔离服务端口', async () => {
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

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-security-smoke-'));
  const dataDir = path.join(root, '.mdread');
  const docRoot = path.join(root, 'docs');
  const profileDir = path.join(root, 'chrome-profile');
  const source = path.join(docRoot, '夹带代码的方案.md');
  let server = null;
  let chrome = null;
  try {
    fs.mkdirSync(docRoot, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(source, [
      '# 夹带代码的方案',
      '',
      '<p id="keep-html">排版用途的 <b>原始 HTML</b> 必须保留。</p>',
      '',
      '<script>document.body.dataset.pwnedScript = "1";</script>',
      '',
      '<img id="hostile-img" src="x" onerror="document.body.dataset.pwnedHandler = \'1\'">',
      '',
      '<a id="js-link" href="javascript:document.body.dataset.pwnedLink = \'1\'">点我</a>',
      '',
      '<iframe id="hostile-frame" src="https://example.com/"></iframe>',
      '',
      '<style>body { display: none !important; }</style>',
      '',
      '<details id="keep-details"><summary>摘要</summary>折叠内容</details>',
      '',
      '## 图表',
      '',
      '```mermaid',
      'graph TD',
      '  A["开始"] --> B["结束"]',
      '```',
      '',
      '正文段落:公式 $E=mc^2$ 与 **粗体** 照常渲染。',
      '',
    ].join('\n'), 'utf8');
    const opened = await store.openReview(source, { dataDir });

    server = await startServer(dataDir);
    chrome = await startChrome(profileDir);
    await chrome.cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });

    await waitUntil('桌面首页最近审阅出现', () => chrome.cdp.evaluate(`(() => {
      const item = document.querySelector('#welcomeRecent .recent-item');
      return document.readyState === 'complete' && item && item.textContent.includes('夹带代码的方案.md');
    })()`));
    assert.ok(await chrome.cdp.evaluate(`!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`), '页面必须带内容安全策略 meta');
    assert.ok(await chrome.cdp.evaluate('!!window.DOMPurify && typeof window.DOMPurify.sanitize === "function"'), '净化库必须已加载');

    await chrome.cdp.evaluate(`document.querySelector('#welcomeRecent .recent-item').click()`);
    await waitUntil('文档渲染完成(图表已出)', () => chrome.cdp.evaluate(`(() => {
      const content = document.querySelector('#documentContent');
      return content && content.querySelector('#keep-html') && content.querySelector('.mermaid svg');
    })()`));

    const dom = await chrome.cdp.evaluate(`(() => {
      const content = document.querySelector('#documentContent');
      const img = content.querySelector('#hostile-img');
      const link = content.querySelector('#js-link');
      return {
        scripts: content.querySelectorAll('script').length,
        frames: content.querySelectorAll('iframe, object, embed').length,
        styles: Array.from(content.querySelectorAll('style')).filter((node) => !node.closest('.mermaid svg')).length,
        imgOnError: img ? img.getAttribute('onerror') : null,
        linkHref: link ? link.getAttribute('href') : null,
        keepHtml: !!content.querySelector('#keep-html b'),
        keepDetails: !!content.querySelector('#keep-details summary'),
        mermaidSvg: !!content.querySelector('.mermaid svg'),
        katex: !!content.querySelector('.katex'),
        bodyVisible: getComputedStyle(document.body).display !== 'none',
        pwned: { ...document.body.dataset },
        title: document.title,
      };
    })()`);
    assert.equal(dom.scripts, 0, '<script> 不得进入页面');
    assert.equal(dom.frames, 0, '<iframe>/<object>/<embed> 不得进入页面');
    assert.equal(dom.styles, 0, '文档级 <style> 不得进入页面');
    assert.equal(dom.imgOnError, null, '事件属性必须被剥掉');
    assert.ok(!dom.linkHref || !/^\s*javascript:/i.test(dom.linkHref), 'javascript: 链接必须被剥掉');
    assert.ok(dom.keepHtml, '排版用途的原始 HTML(带 id 的 <p>、<b>)必须保留');
    assert.ok(dom.keepDetails, '<details>/<summary> 必须保留');
    assert.ok(dom.mermaidSvg, 'Mermaid strict 模式仍要出图');
    assert.ok(dom.katex, '公式照常渲染');
    assert.ok(dom.bodyVisible, '文档不得通过 <style> 改掉整个应用的样式');
    assert.deepEqual(Object.keys(dom.pwned).filter((key) => key.startsWith('pwned')), [], '任何夹带代码都不得执行');
    assert.equal(chrome.cdp.dialogs.length, 0, '不得弹出任何脚本对话框');

    // 进入编辑模式(Milkdown)也不能触发内容安全策略告警。
    await chrome.cdp.evaluate(`document.querySelector('#editingModeButton').click()`);
    await waitUntil('进入编辑的确认框', () => chrome.cdp.evaluate(`(() => {
      const dialog = document.querySelector('#confirmDialog');
      const title = document.querySelector('#confirmTitle').textContent;
      return !dialog.hidden && (title.includes('手工修改') || title.includes('编辑'));
    })()`));
    await chrome.cdp.evaluate(`document.querySelector('#confirmAccept').click()`);
    await waitUntil('进入编辑模式', () => chrome.cdp.evaluate(`(() => {
      const pane = document.querySelector('#editorPane');
      return !pane.hidden && !!(pane.querySelector('.ProseMirror') || pane.querySelector('.milkdown') || pane.querySelector('.fallback-editor'));
    })()`));
    await sleep(300);

    const cspMessages = chrome.cdp.consoleMessages.filter((item) => /Content Security Policy|Content-Security-Policy|Refused to/i.test(item.text));
    assert.deepEqual(cspMessages, [], `阅读与编辑过程中不得触发内容安全策略告警:\n${cspMessages.map((item) => item.text).join('\n')}`);
    const fatal = chrome.cdp.exceptions.filter((item) => !/favicon/i.test(item));
    assert.deepEqual(fatal, [], `页面不得抛出未处理异常:\n${fatal.join('\n')}`);

    console.log('PASS: 夹带脚本不执行、排版 HTML 保留、Mermaid strict 出图、公式正常、无内容安全策略告警、编辑模式正常。');
  } finally {
    if (chrome) { try { chrome.cdp.socket && chrome.cdp.socket.close(); } catch (_) {} await stopChild(chrome.child); }
    if (server) await stopChild(server.child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
