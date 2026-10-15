/*
 * 独立只读对比视图(版本记录设计 v4 第 8 节;UI 方案 v2 第 3.4 节):比较一轮的原稿与完成稿。
 *
 * 为什么独立:批注锚点按正文字符偏移算,往批注用的正文里插删除线会污染下一轮坐标。
 * 所以对比在正文上方的一层只读视图里看,关掉就回到纯完成稿,阅读位置保留。
 *
 * 显示:改过的块左边绿线;新增浅绿底;删除原位灰色删除线;整段删除是一个删除线段落;替换 = 块内字级 del/ins;
 * 「上一处 / 下一处」在改动块之间跳。数据按需取(GET /api/app/version),结果按版本缓存。
 *
 * 只管这一层视图的 DOM;对比算法在 desktop-diff.js,渲染 Markdown 的函数由 desktop.js 注入。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftbackCompare = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEADING_TYPES = new Set(['heading']);

  function escapeHtml(value) { return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

  /**
   * create({ elements, md, dmp, Diff, renderMarkdown, loadVersion, onChange })
   *   elements: { view, title, meta, position, prev, next, close, scroll, content, note }
   *   renderMarkdown(root, source, tab) → Promise<boolean>(desktop.js 的渲染器,含净化与资源路径改写)
   *   loadVersion(docId, versionId, which) → Promise<{ available, content, hash, reason }>
   *   onChange({ open, tabId }) 视图开关时通知(desktop.js 收起图钉、恢复焦点)
   */
  function create(deps) {
    const { elements: el, md, dmp, Diff, renderMarkdown, loadVersion, onChange } = deps;
    const cache = new Map(); // `${docId}/${versionId}` → { result, originalHash, finalHash }
    let current = null;      // { tabId, docId, versionId, round, kind, changes, index, token }
    let loading = 0;

    function key(docId, versionId) { return `${docId}/${versionId}`; }
    function isOpen() { return !!current && !el.view.hidden; }
    function notify() { if (typeof onChange === 'function') onChange({ open: isOpen(), tabId: current ? current.tabId : null }); }

    async function compute(docId, versionId) {
      const k = key(docId, versionId);
      if (cache.has(k)) return cache.get(k);
      const [original, final] = await Promise.all([loadVersion(docId, versionId, 'original'), loadVersion(docId, versionId, 'final')]);
      if (!original.available || !final.available) {
        const reason = !original.available ? original.reason : final.reason;
        throw new Error(reason === 'unarchived' ? '这一轮没有归档,没法对比。' : reason === 'corrupt' ? '这一轮的留底已损坏,没法对比。' : '这一轮缺少原稿或完成稿的留底,没法对比。');
      }
      const result = Diff.diffDocuments(md, dmp, original.content, final.content);
      const entry = { result, originalHash: original.hash, finalHash: final.hash, refsNew: Diff.referenceDefinitions(result.newBlocks), refsOld: Diff.referenceDefinitions(result.oldBlocks) };
      cache.set(k, entry);
      return entry;
    }

    function inlineHtml(ops, sourceMode) {
      const parts = [];
      for (const [op, text] of ops) {
        const safe = escapeHtml(text);
        if (op === 0) parts.push(safe);
        else if (op < 0) parts.push(`<del class="diff-del">${safe}</del>`);
        else parts.push(`<ins class="diff-ins">${safe}</ins>`);
      }
      return parts.join('');
    }

    function headingLevel(text) { const m = /^(#{1,6})\s/.exec(text || ''); return m ? m[1].length : 0; }

    async function renderBlock(container, text, refs, tab, className) {
      const box = document.createElement('div');
      box.className = className;
      container.appendChild(box);
      const source = refs ? `${text}\n\n${refs}` : text;
      try { await renderMarkdown(box, source, tab, { interactive: false }); } catch { box.textContent = text; }
      return box;
    }

    function renderInline(container, item, className) {
      const box = document.createElement('div');
      box.className = `${className} diff-inline-block${item.source ? ' source' : ''}`;
      const level = HEADING_TYPES.has(item.type) ? headingLevel(item.newText || item.oldText) : 0;
      if (level) box.dataset.heading = String(level);
      box.dataset.blockType = item.type || '';
      const body = document.createElement(item.source ? 'pre' : 'p');
      body.className = 'diff-inline';
      body.innerHTML = inlineHtml(item.inline, item.source);
      box.appendChild(body);
      container.appendChild(box);
      return box;
    }

    async function paint(entry, tab, token) {
      const { result, refsNew, refsOld } = entry;
      const frag = document.createDocumentFragment();
      const jobs = [];
      for (const hunk of result.hunks) {
        if (hunk.kind === 'equal') {
          const box = document.createElement('div'); box.className = 'diff-equal'; frag.appendChild(box);
          jobs.push(renderMarkdown(box, refsNew ? `${hunk.text}\n\n${refsNew}` : hunk.text, tab, { interactive: false }).catch(() => { box.textContent = hunk.text; }));
          continue;
        }
        const group = document.createElement('section');
        group.className = 'diff-group';
        for (const item of hunk.items) {
          // 每个改动块一个可跳转的节点(「上一处 / 下一处」按块跳)
          const node = document.createElement('div');
          node.className = `diff-change diff-${item.kind}-item`; node.dataset.changeIndex = String(item.index);
          node.setAttribute('aria-label', `第 ${item.index + 1} 处改动`);
          if (item.kind === 'insert') jobs.push(renderBlock(node, item.newText, refsNew, tab, 'diff-insert'));
          else if (item.kind === 'delete') jobs.push(renderBlock(node, item.oldText, refsOld, tab, 'diff-delete'));
          else if (item.inline) renderInline(node, item, 'diff-replace');
          else {
            // 字级对比不可用(超长 / 表格结构变了):显示旧块、新块
            jobs.push(renderBlock(node, item.oldText, refsOld, tab, 'diff-delete'));
            jobs.push(renderBlock(node, item.newText, refsNew, tab, 'diff-insert'));
          }
          group.appendChild(node);
        }
        frag.appendChild(group);
      }
      await Promise.all(jobs);
      if (!current || current.token !== token) return false;
      el.content.replaceChildren(frag);
      return true;
    }

    function changeNodes() { return Array.from(el.content.querySelectorAll('.diff-change')); }

    function paintPosition() {
      if (!current) return;
      const nodes = changeNodes();
      nodes.forEach((node, i) => node.classList.toggle('current', i === current.index));
      el.position.textContent = current.changes ? `${Math.min(current.index + 1, current.changes)} / ${current.changes}` : '0 / 0';
      el.prev.disabled = !current.changes || current.index <= 0;
      el.next.disabled = !current.changes || current.index >= current.changes - 1;
    }

    function goTo(index, behavior = 'smooth') {
      if (!current || !current.changes) return;
      current.index = Math.max(0, Math.min(current.changes - 1, index));
      const node = changeNodes()[current.index];
      if (node) node.scrollIntoView({ behavior, block: 'center' });
      paintPosition();
    }

    function step(direction) { if (current) goTo(current.index + (direction < 0 ? -1 : 1)); }

    /** 定位到包含某段文字(被删或被改的原文)的第一处改动;找不到返回 false */
    function locateText(text) {
      if (!current || !text) return false;
      const needle = String(text).trim().slice(0, 80);
      if (!needle) return false;
      const nodes = changeNodes();
      const hit = nodes.findIndex((node) => (node.textContent || '').includes(needle));
      if (hit < 0) return false;
      goTo(hit);
      return true;
    }

    /**
     * open({ tab, docId, versionId, round, kind, currentHash, startIndex })
     * kind: review | manual | restored(标题文案不同);currentHash 用来判断正文是否在完成稿之后又编辑过
     */
    async function open(options) {
      const token = Symbol('compare');
      current = { tabId: options.tab.id, docId: options.docId, versionId: options.versionId, round: options.round, kind: options.kind || 'review', changes: 0, index: 0, token };
      el.view.hidden = false;
      el.content.replaceChildren();
      el.note.hidden = true;
      el.title.textContent = options.kind === 'restored' ? `恢复:恢复前 → 恢复后(第 ${options.round || '?'} 轮)` : `第 ${options.round || '?'} 轮改动`;
      el.meta.textContent = '正在比较…';
      el.position.textContent = '';
      el.prev.disabled = el.next.disabled = true;
      notify();
      loading += 1;
      try {
        const entry = await compute(options.docId, options.versionId);
        if (!current || current.token !== token) return;
        const painted = await paint(entry, options.tab, token);
        if (!painted) return;
        current.changes = entry.result.changes;
        const { stats } = entry.result;
        const parts = [];
        if (stats.replaced) parts.push(`改 ${stats.replaced}`);
        if (stats.inserted) parts.push(`增 ${stats.inserted}`);
        if (stats.deleted) parts.push(`删 ${stats.deleted}`);
        const label = options.kind === 'restored' ? '恢复前 → 恢复后' : '原稿 → 完成稿';
        el.meta.textContent = current.changes ? `${label} · ${current.changes} 处(${parts.join('、')})` : `${label} · 没有改动`;
        if (options.currentHash && entry.finalHash && options.currentHash !== entry.finalHash) {
          el.note.hidden = false;
          el.note.textContent = options.kind === 'restored' ? '这是恢复那一刻的对比;之后正文又编辑过,当前正文与它不同。' : `这是第 ${options.round || '?'} 轮完成稿的改动;之后正文又编辑过,当前正文与完成稿不同。`;
        }
        el.scroll.scrollTop = 0;
        if (current.changes) goTo(Number.isInteger(options.startIndex) ? options.startIndex : 0, 'auto');
        else paintPosition();
      } catch (error) {
        if (!current || current.token !== token) return;
        el.meta.textContent = error && error.message ? error.message : '没法对比。';
        el.content.replaceChildren();
        paintPosition();
      } finally { loading -= 1; }
    }

    function close() {
      if (!current && el.view.hidden) return;
      current = null;
      el.view.hidden = true;
      el.content.replaceChildren();
      notify();
    }

    function currentView() { return current ? { ...current } : null; }
    /** 回稿卡上的「改了几处」:算完给数,算不出给 null(不显示) */
    async function changeCount(docId, versionId) {
      try { return (await compute(docId, versionId)).result.changes; } catch { return null; }
    }
    function invalidate(docId, versionId) { if (docId && versionId) cache.delete(key(docId, versionId)); else cache.clear(); }

    el.prev.addEventListener('click', () => step(-1));
    el.next.addEventListener('click', () => step(1));
    el.close.addEventListener('click', () => close());

    return Object.freeze({ open, close, step, goTo, locateText, isOpen, current: currentView, invalidate, changeCount, inlineHtml });
  }

  return Object.freeze({ create });
});
