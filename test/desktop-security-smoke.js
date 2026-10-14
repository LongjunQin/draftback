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
const store = require('../lib/review-store');
const { sleep, waitUntil, stopChild, startServer, startChrome } = require('./helpers/browser-smoke');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-security-smoke-'));
  const dataDir = path.join(root, '.draftback');
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
