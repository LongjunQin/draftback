#!/usr/bin/env node
'use strict';

// 阅读与审阅分离的真实浏览器冒烟(路线图 v3 第一轮主线第 1 项,跨端规则第 8 节)。
//
//   1. 普通打开:不建会话、不加锁、不写 sidecar;状态条显示"普通阅读";划词不出批注按钮,只提示"开始审阅"。
//   2. 普通编辑:进入编辑即登记,期间 mdreview open 被拒;保存直接写文件并留覆盖前备份;退出编辑解除登记。
//   3. 开始审阅:同一标签转成审阅会话,状态条变"审阅中",划词出批注按钮。
//   4. 最近文件列表同时显示普通文档与审阅状态。
//
// 用法: node test/desktop-plain-document-smoke.js   (需要本机有 Google Chrome / Chromium)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../lib/review-store');
const documents = require('../lib/documents');
const { PROJECT, sleep, waitUntil, stopChild, startServer, startChrome } = require('./helpers/browser-smoke');

async function selectParagraph(cdp, selector) {
  return cdp.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return selection.toString();
  })()`);
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-plain-smoke-')));
  const dataDir = path.join(root, '.mdread');
  const docRoot = path.join(root, 'docs');
  const profileDir = path.join(root, 'chrome-profile');
  const source = path.join(docRoot, '普通文档.md');
  let server = null;
  let chrome = null;
  try {
    fs.mkdirSync(docRoot, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    // 原文故意带上编辑器"不认识"的内容:Front Matter、原始 HTML、公式、带 4 空格缩进与 * 标记的嵌套列表、
    // 尾随两空格硬换行。只改最后一段,其余必须字节不变(路线图 6.2 节的保真要求)。
    const ORIGINAL = [
      '---', 'title: 普通文档', 'tags: [a, b]', '---',
      '# 普通文档', '',
      '<p id="plain-para">这一段用来验证普通阅读时不能划词批注。</p>', '',
      '行内公式 $E=mc^2$ 与*强调*,还有尾随两空格硬换行  ', '续行。', '',
      '* 第一项', '* 第二项', '    * 子项甲', '    * 子项乙', '* 第三项', '',
      '## 第二节', '',
      '第二节正文。', '',
    ].join('\n');
    fs.writeFileSync(source, ORIGINAL, 'utf8');
    store.ensureDataDir({ dataDir });

    server = await startServer(dataDir);
    chrome = await startChrome(profileDir);
    await chrome.cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });
    await waitUntil('欢迎页就绪', () => chrome.cdp.evaluate(`document.readyState === 'complete' && !document.querySelector('#welcome').hidden`));
    assert.equal(await chrome.cdp.evaluate(`document.querySelectorAll('#welcomeRecent .recent-item').length`), 0, '新数据目录不应有最近文件');

    // 1. 普通打开(浏览器里没有原生选择框,App 走 prompt 输入路径)。
    chrome.cdp.nextPromptText = source;
    await chrome.cdp.evaluate(`document.querySelector('#welcomeOpenButton').click()`);
    await waitUntil('普通文档标签打开', () => chrome.cdp.evaluate(`(() => {
      const pill = document.querySelector('#reviewStatePill');
      return document.querySelector('#tabList .tab.active') && pill.dataset.status === 'plain' && document.querySelector('#plain-para');
    })()`));
    const plainUi = await chrome.cdp.evaluate(`({
      pill: document.querySelector('#reviewStateText').textContent,
      count: document.querySelector('#reviewCount').textContent,
      primary: document.querySelector('#primaryAction').textContent,
      primaryHidden: document.querySelector('#primaryAction').hidden,
      finalizeHidden: document.querySelector('#finalizeAction').hidden,
      docNoteHidden: document.querySelector('#docNoteButton').hidden,
      editEnabled: !document.querySelector('#editingModeButton').disabled,
      notesEmpty: document.querySelector('#openNotesList').textContent,
    })`);
    assert.match(plainUi.pill, /普通阅读/);
    assert.equal(plainUi.count, '未审阅');
    assert.equal(plainUi.primary, '开始审阅');
    assert.equal(plainUi.primaryHidden, false);
    assert.equal(plainUi.finalizeHidden, true);
    assert.equal(plainUi.docNoteHidden, true, '普通阅读不能写总体意见');
    assert.equal(plainUi.editEnabled, true);
    assert.match(plainUi.notesEmpty, /开始审阅/);
    assert.equal(await store.getReviewByPath(source, { dataDir, activeOnly: true }), null, '普通打开不得创建审阅会话');
    assert.equal(fs.existsSync(store.sidecarFor(source)), false, '普通打开不得创建 sidecar');
    assert.equal(fs.existsSync(`${source}.lock`), false, '普通打开不得留下锁目录');

    const selected = await selectParagraph(chrome.cdp, '#plain-para');
    assert.match(selected, /普通阅读/);
    await sleep(150);
    assert.equal(await chrome.cdp.evaluate(`document.querySelector('#annotateButton').hidden`), true, '普通阅读划词不得出现批注按钮');
    await waitUntil('划词提示去开始审阅', () => chrome.cdp.evaluate(`Array.from(document.querySelectorAll('#toastRegion *')).some((node) => node.textContent.includes('开始审阅'))`));

    // 2. 普通编辑:登记、拒绝冻结、直接保存、备份、解除登记。
    await chrome.cdp.evaluate(`document.querySelector('#editingModeButton').click()`);
    await waitUntil('进入普通编辑', () => chrome.cdp.evaluate(`(() => {
      const pane = document.querySelector('#editorPane');
      return !pane.hidden && document.querySelector('#reviewStatePill').dataset.status === 'plain' &&
        document.querySelector('#reviewStateText').textContent.includes('编辑中') &&
        !!(pane.querySelector('.ProseMirror') || pane.querySelector('.fallback-editor'));
    })()`));
    await waitUntil('编辑登记生效', () => documents.isEditing(source, { dataDir }));
    const refused = spawnSync(process.execPath, ['mdreview.js', 'open', source, '--no-open'], { cwd: PROJECT, env: { ...process.env, MDREAD_DATA_DIR: dataDir }, encoding: 'utf8' });
    assert.notEqual(refused.status, 0, '用户编辑中,智能体不得冻结文档');
    assert.match(refused.stderr, /USER_EDITING/);
    assert.equal(await store.getReviewByPath(source, { dataDir, activeOnly: true }), null);

    const editorSelector = await chrome.cdp.evaluate(`document.querySelector('#editorPane .ProseMirror') ? '#editorPane .ProseMirror' : '#editorPane .fallback-editor'`);
    await chrome.cdp.evaluate(`(() => {
      const editor = document.querySelector(${JSON.stringify(editorSelector)});
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor); range.collapse(false);
      selection.removeAllRanges(); selection.addRange(range);
    })()`);
    await chrome.cdp.send('Input.insertText', { text: '普通编辑新增的一句话。' });
    await waitUntil('编辑器识别到修改', () => chrome.cdp.evaluate(`!document.querySelector('#saveButton').disabled`));
    await chrome.cdp.evaluate(`document.querySelector('#saveButton').click()`);
    await waitUntil('保存完成', () => chrome.cdp.evaluate(`document.querySelector('#saveButton').disabled && document.querySelector('#editorSaveState').textContent.includes('已保存')`));
    const saved = fs.readFileSync(source, 'utf8');
    assert.match(saved, /普通编辑新增的一句话/, '普通编辑必须直接写回文件');
    assert.equal(saved, ORIGINAL.replace('第二节正文。', '第二节正文。普通编辑新增的一句话。'),
      '块级回写:只有被改的段落变化,Front Matter、HTML、公式、列表缩进与标记、硬换行全部字节一致');
    await waitUntil('保存提示列出改动与保留数', () => chrome.cdp.evaluate(`Array.from(document.querySelectorAll('#toastRegion *')).some((node) => /改动 1 处/.test(node.textContent))`));
    const backupsRoot = path.join(dataDir, 'backups', 'documents');
    assert.ok(fs.existsSync(backupsRoot) && fs.readdirSync(backupsRoot).length === 1, '覆盖前必须备份');
    assert.equal(await store.getReviewByPath(source, { dataDir, activeOnly: true }), null, '普通保存不得创建审阅会话');

    await chrome.cdp.evaluate(`document.querySelector('#readingModeButton').click()`);
    await waitUntil('回到普通阅读', () => chrome.cdp.evaluate(`!document.querySelector('#readerScroll').hidden && document.querySelector('#reviewStateText').textContent.includes('普通阅读')`));
    await waitUntil('编辑登记解除', () => !documents.isEditing(source, { dataDir }));
    assert.ok(await chrome.cdp.evaluate(`document.querySelector('#documentContent').textContent.includes('普通编辑新增的一句话')`), '阅读模式显示保存后的内容');

    // 3. 开始审阅:同一标签转成会话。
    await chrome.cdp.evaluate(`document.querySelector('#primaryAction').click()`);
    await waitUntil('转为审阅会话', () => chrome.cdp.evaluate(`(() => {
      const pill = document.querySelector('#reviewStatePill');
      return document.querySelectorAll('#tabList .tab').length === 1 && pill.dataset.status === 'reviewing' &&
        document.querySelector('#primaryAction').textContent === '完成本轮审阅' && document.querySelector('#plain-para');
    })()`));
    const review = await store.getReviewByPath(source, { dataDir, activeOnly: true });
    assert.ok(review && review.status === 'reviewing', '开始审阅后必须有活动会话');
    assert.equal(await chrome.cdp.evaluate(`document.querySelector('#tabList .tab.active').title`), source);
    await selectParagraph(chrome.cdp, '#plain-para');
    await waitUntil('审阅中划词出现批注按钮', () => chrome.cdp.evaluate(`!document.querySelector('#annotateButton').hidden`));
    assert.equal(await chrome.cdp.evaluate(`document.querySelector('#docNoteButton').hidden`), false);

    // 4. 最近文件列表。
    await chrome.cdp.evaluate(`document.querySelector('#filesModeButton').click()`);
    await waitUntil('最近文件显示审阅状态', () => chrome.cdp.evaluate(`(() => {
      const item = document.querySelector('#recentList .recent-item');
      return item && item.textContent.includes('普通文档.md') && item.textContent.includes('审阅中');
    })()`));

    const fatal = chrome.cdp.exceptions.filter((item) => !/favicon/i.test(item));
    assert.deepEqual(fatal, [], `页面不得抛出未处理异常:\n${fatal.join('\n')}`);
    console.log('PASS: 普通打开不建会话、划词只提示、编辑登记阻止冻结、直接保存并备份、开始审阅转会话、最近文件带状态。');
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
