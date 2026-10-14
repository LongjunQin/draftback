#!/usr/bin/env node
'use strict';

// 性能探针(路线图 v3 第一轮主线第 6 项"性能测量,拿到数据")。
//
// 在真实无头 Chrome 里驱动 /desktop,对同一组真实尺寸的文档测七个环节,输出一张表。
// 注意:这是渲染层(与 Electron 里同一套 HTML/JS)的数据,不含 Electron 进程启动与本地服务拉起;
// 冷启动那一项请用 App 实测补充。多跑几次取中位数,避免单次抖动。
//
// 用法: node test/desktop-performance-probe.js [--runs 3] [--out docs/performance/<日期>.md]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/review-store');
const { PROJECT, sleep, waitUntil, stopChild, startServer, startChrome } = require('./helpers/browser-smoke');

const args = process.argv.slice(2);
const runs = Math.max(1, Number(args[args.indexOf('--runs') + 1]) || 3);
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;

function bigDocument({ sections = 300, mermaid = 3 }) {
  const lines = ['# 大文档性能样本', ''];
  for (let index = 1; index <= sections; index += 1) {
    lines.push(`## 第 ${index} 章 标题文字`, '');
    lines.push(`这是第 ${index} 章的正文段落,包含**粗体**、*斜体*、\`行内代码\`与[链接](https://example.com/${index})。中文长句用来模拟真实方案里的叙述密度,每段大约一百字左右,这样整篇文档的字数才接近真实的项目方案和调研报告。`, '');
    if (index % 3 === 0) {
      lines.push('| 指标 | 数值 | 说明 |', '|---|---|---|');
      for (let row = 1; row <= 6; row += 1) lines.push(`| 指标 ${row} | ${row * index} | 表格单元格说明文字 |`);
      lines.push('');
    }
    if (index % 5 === 0) {
      lines.push('```javascript', `function section${index}() {`, `  return ${index} * 2; // 代码块高亮`, '}', '```', '');
    }
    if (index % 7 === 0) lines.push(`公式:$\\sum_{i=1}^{${index}} i^2$`, '');
    if (index % 4 === 0) lines.push('- 列表项一', '- 列表项二', '  - 嵌套项', '- 列表项三', '');
  }
  for (let index = 1; index <= mermaid; index += 1) {
    lines.push(`## 图 ${index}`, '', '```mermaid', 'graph TD', `  A${index}["开始"] --> B${index}["处理"]`, `  B${index} --> C${index}["结束"]`, '```', '');
  }
  return lines.join('\n');
}

const median = (values) => { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const now = () => performance.now();

async function timed(label, fn) {
  const start = now();
  await fn();
  return { label, ms: Math.round(now() - start) };
}

async function probeOnce(root, index) {
  const dataDir = path.join(root, `run-${index}`, '.draftback');
  const docRoot = path.join(root, `run-${index}`, 'docs');
  const profileDir = path.join(root, `run-${index}`, 'chrome-profile');
  fs.mkdirSync(docRoot, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  store.ensureDataDir({ dataDir });
  const big = path.join(docRoot, '大文档.md');
  const plain = path.join(docRoot, '无图表.md');
  const small = path.join(docRoot, '小文档.md');
  fs.writeFileSync(big, bigDocument({ sections: 300, mermaid: 3 }));
  fs.writeFileSync(plain, bigDocument({ sections: 300, mermaid: 0 }));
  fs.writeFileSync(small, '# 小文档\n\n<p id="small-para">小文档的一段正文,用来测划词与批注保存。</p>\n\n第二段。\n');
  const bigReview = await store.openReview(big, { dataDir });
  const plainReview = await store.openReview(plain, { dataDir });
  const smallReview = await store.openReview(small, { dataDir });
  const results = [];
  let server = null;
  let chrome = null;
  try {
    server = await startServer(dataDir);
    chrome = await startChrome(profileDir);
    results.push(await timed('页面加载到欢迎页就绪', async () => {
      await chrome.cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });
      await waitUntil('欢迎页', () => chrome.cdp.evaluate(`document.readyState === 'complete' && document.querySelectorAll('#welcomeRecent .recent-item').length >= 3`), 30000);
    }));
    const openById = async (id, marker) => {
      await chrome.cdp.evaluate(`window.__mdturnOpen = ${JSON.stringify(id)}`);
      await chrome.cdp.evaluate(`Array.from(document.querySelectorAll('#welcomeRecent .recent-item, #recentList .recent-item')).find((item) => item.textContent.includes(${JSON.stringify(marker)})).click()`);
    };
    results.push(await timed('打开大文档(300 章 + 3 张图表)到正文渲染完', async () => {
      await openById(bigReview.review.id, '大文档.md');
      await waitUntil('大文档渲染', () => chrome.cdp.evaluate(`!!document.querySelector('#documentContent .mermaid svg') && document.querySelector('#documentContent').textContent.includes('第 300 章')`), 60000);
    }));
    await chrome.cdp.evaluate(`document.querySelector('#filesModeButton').click()`);
    results.push(await timed('打开同尺寸无图表文档到渲染完', async () => {
      await openById(plainReview.review.id, '无图表.md');
      await waitUntil('无图表渲染', () => chrome.cdp.evaluate(`document.querySelector('#tabList .tab.active .tab-title').textContent.includes('无图表.md') && document.querySelector('#documentContent').textContent.includes('第 300 章')`), 60000);
    }));
    results.push(await timed('切回大文档标签(已渲染缓存)', async () => {
      await chrome.cdp.evaluate(`Array.from(document.querySelectorAll('#tabList .tab')).find((tab) => tab.textContent.includes('大文档.md')).click()`);
      await waitUntil('切换', () => chrome.cdp.evaluate(`document.querySelector('#tabList .tab.active .tab-title').textContent.includes('大文档.md') && document.querySelector('#documentContent').textContent.includes('第 300 章')`), 30000);
    }));
    results.push(await timed('大文档里划选一段到批注按钮出现', async () => {
      await chrome.cdp.evaluate(`(() => {
        const node = Array.from(document.querySelectorAll('#documentContent p')).find((p) => p.textContent.includes('第 150 章的正文'));
        node.scrollIntoView();
        const range = document.createRange(); range.selectNodeContents(node);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      })()`);
      await waitUntil('批注按钮', () => chrome.cdp.evaluate(`!document.querySelector('#annotateButton').hidden`), 10000);
    }));
    results.push(await timed('保存一条批注到右栏出现', async () => {
      await chrome.cdp.evaluate(`document.querySelector('#annotateButton').click()`);
      await waitUntil('批注框', () => chrome.cdp.evaluate(`!document.querySelector('#annotationDialog').hidden`), 10000);
      await chrome.cdp.evaluate(`(() => { const t = document.querySelector('#annotationText'); t.value = '性能探针批注'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#saveAnnotation').click(); })()`);
      await waitUntil('右栏', () => chrome.cdp.evaluate(`document.querySelector('#annotationDialog').hidden && document.querySelector('#openNotesList').textContent.includes('性能探针批注')`), 10000);
    }));
    await chrome.cdp.evaluate(`document.querySelector('#filesModeButton').click()`);
    await openById(smallReview.review.id, '小文档.md');
    await waitUntil('小文档', () => chrome.cdp.evaluate(`document.querySelector('#small-para')`), 10000);
    await chrome.cdp.evaluate(`document.querySelector('#editingModeButton').click()`);
    await waitUntil('确认框', () => chrome.cdp.evaluate(`!document.querySelector('#confirmDialog').hidden`), 10000);
    await chrome.cdp.evaluate(`document.querySelector('#confirmAccept').click()`);
    await waitUntil('编辑器', () => chrome.cdp.evaluate(`!document.querySelector('#editorPane').hidden && !!document.querySelector('#editorPane .ProseMirror')`), 20000);
    await chrome.cdp.evaluate(`(() => { const e = document.querySelector('#editorPane .ProseMirror'); e.focus(); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
    await sleep(200);
    results.push(await timed('编辑器输入一句话到识别为修改', async () => {
      await chrome.cdp.send('Input.insertText', { text: '输入延迟探针。' });
      await waitUntil('修改', () => chrome.cdp.evaluate(`!document.querySelector('#saveButton').disabled`), 10000);
    }));
    const memory = await chrome.cdp.evaluate(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null`);
    return { results, memoryMB: memory };
  } finally {
    if (chrome) { try { chrome.cdp.socket && chrome.cdp.socket.close(); } catch (_) {} await stopChild(chrome.child); }
    if (server) await stopChild(server.child);
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-perf-'));
  const all = [];
  try {
    for (let index = 0; index < runs; index += 1) {
      const outcome = await probeOnce(root, index);
      all.push(outcome);
      console.error(`第 ${index + 1}/${runs} 轮: ${outcome.results.map((item) => `${item.label}=${item.ms}ms`).join(', ')}; 堆内存 ${outcome.memoryMB}MB`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const labels = all[0].results.map((item) => item.label);
  const rows = labels.map((label, index) => {
    const values = all.map((outcome) => outcome.results[index].ms);
    return `| ${label} | ${median(values)} | ${Math.min(...values)} | ${Math.max(...values)} |`;
  });
  const memory = all.map((outcome) => outcome.memoryMB).filter((value) => value !== null);
  const table = [
    `# 渲染层性能探针 ${new Date().toISOString().slice(0, 10)}`,
    '',
    `环境:无头 Chrome(与 Electron 同一套渲染代码),${runs} 轮取中位数;样本文档 300 章约 6000 行,含表格、代码、公式、3 张 Mermaid 图。`,
    '不含 Electron 进程启动与本地服务拉起;App 冷启动请实测补充。',
    '',
    '| 环节 | 中位数(ms) | 最小 | 最大 |',
    '|---|---|---|---|',
    ...rows,
    '',
    memory.length ? `打开大文档后 JS 堆内存中位数:${median(memory)} MB` : '',
    '',
  ].join('\n');
  console.log(table);
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(PROJECT, outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(PROJECT, outFile), table, 'utf8');
    console.error(`已写入 ${outFile}`);
  }
}

main().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
