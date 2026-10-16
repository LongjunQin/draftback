/*
 * 回稿(Draftback)iOS 阅读内核(WKWebView 内)。与桌面端共用同一套渲染库与锚点模块(desktop-anchor.js),
 * 批注锚点格式与 Mac 的 sidecar 完全一致,这样手机上的批注批次可以原样回到 Mac。
 *
 * 与原生侧的约定:
 *   原生 → 页面:window.DraftbackReader.load({ markdown, annotations, assets, fontScale })、setAnnotations(list)、
 *                 captureSelection()(编辑菜单的「批注」与底栏「批注这段」触发)、scrollToLine(n)、focusNote(id)、clearSelection()、
 *                 setFontScale(x)、toggleChanges()、scrollToTop();load 还可带 returnCard 与 previousMarkdown(回稿卡与「显示改动」)
 *   页面 → 原生:webkit.messageHandlers.draftback.postMessage({ type, ... })
 *                 type = ready | rendered { outline } | selection { anchor, quote } | selectionState { active } |
 *                        changesState { showing } | changesCount { count } | returnCard { action } | locateFailed | tap | error { message }
 */
(() => {
  'use strict';
  const content = document.getElementById('content');
  const empty = document.getElementById('empty');
  const Anchor = window.DraftbackAnchor;
  const post = (message) => {
    try { window.webkit.messageHandlers.draftback.postMessage(message); } catch (_) { /* 非 WKWebView 环境(调试)忽略 */ }
  };

  const purifier = window.DOMPurify;
  const PURIFY_OPTIONS = {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'template'],
    FORBID_ATTR: ['srcdoc', 'formaction'],
  };
  const sanitize = (html) => (purifier ? purifier.sanitize(html, PURIFY_OPTIONS) : html);

  function engine() {
    const texmath = window.texmath || window.markdownitTexmath || window['markdown-it-texmath'];
    const md = window.markdownit({
      html: !!purifier, linkify: true, breaks: false,
      highlight(source, language) {
        if (language === 'mermaid') return '';
        if (language && window.hljs && window.hljs.getLanguage(language)) {
          try { return `<pre class="hljs"><code class="language-${language}">${window.hljs.highlight(source, { language, ignoreIllegals: true }).value}</code></pre>`; } catch (_) {}
        }
        return '';
      },
    });
    if (texmath && window.katex) { try { md.use(texmath, { engine: window.katex, delimiters: 'dollars', katexOptions: { throwOnError: false, strict: false } }); } catch (_) {} }
    const htmlBlockRule = md.renderer.rules.html_block;
    md.renderer.rules.html_block = function htmlBlock(tokens, index, options, env, self) {
      const token = tokens[index];
      const html = htmlBlockRule ? htmlBlockRule.call(this, tokens, index, options, env, self) : token.content;
      if (!token.map || /^\s*<[A-Za-z][^>]*\bdata-line-start\s*=/i.test(html)) return html;
      return html.replace(/^(\s*<[A-Za-z][\w:-]*)(?=[\s>])/, `$1 data-line-start="${token.map[0] + 1}" data-line-end="${token.map[1]}"`);
    };
    const fenceRule = md.renderer.rules.fence;
    md.renderer.rules.fence = function fence(tokens, index, options, env, self) {
      const token = tokens[index];
      const html = fenceRule.call(this, tokens, index, options, env, self);
      if (!token.map || /\bdata-line-start\s*=/.test(html)) return html;
      return html.replace(/^(\s*<pre)(?=[\s>])/i, `$1 data-line-start="${token.map[0] + 1}" data-line-end="${token.map[1]}"`);
    };
    const originalRender = md.renderer.render.bind(md.renderer);
    md.renderer.render = function render(tokens, options, env) {
      for (const token of tokens) {
        if (token.map && (token.nesting === 1 || token.type === 'fence' || token.type === 'code_block')) {
          token.attrSet('data-line-start', String(token.map[0] + 1));
          token.attrSet('data-line-end', String(token.map[1]));
        }
      }
      return originalRender(tokens, options, env);
    };
    return md;
  }
  const md = engine();
  // 夜读是台灯下的纸(纸还是浅色):图表一律用浅色主题
  if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });

  const state = { annotations: [], assets: {}, rendered: false };

  // 紧凑列表项这类"自己带文字、肚子里又嵌子块"的元素:裸文字包进带行号的 span,否则无法批注(与桌面端一致)。
  function adoptBareInlineRuns(root) {
    const lineRangeOf = (node) => {
      if (node.dataset && node.dataset.lineStart) return [Number(node.dataset.lineStart), Number(node.dataset.lineEnd)];
      const mapped = node.querySelectorAll?.('[data-line-start]');
      if (!mapped || !mapped.length) return [NaN, NaN];
      return [Number(mapped[0].dataset.lineStart), Number(mapped[mapped.length - 1].dataset.lineEnd)];
    };
    const isMappedBlock = (node) => node.nodeType === Node.ELEMENT_NODE && (node.hasAttribute('data-line-start') || Boolean(node.querySelector('[data-line-start]')));
    root.querySelectorAll('[data-line-start]').forEach((host) => {
      if (!host.querySelector('[data-line-start]')) return;
      const hostStart = Number(host.dataset.lineStart), hostEnd = Number(host.dataset.lineEnd);
      const runs = []; let current = null, lastMapped = null;
      Array.from(host.childNodes).forEach((node) => {
        if (isMappedBlock(node)) { current = null; lastMapped = node; return; }
        if (!current) { current = { nodes: [], before: lastMapped, after: null }; runs.push(current); }
        current.nodes.push(node);
      });
      runs.forEach((run) => {
        const index = run.nodes.length ? Array.prototype.indexOf.call(host.childNodes, run.nodes[run.nodes.length - 1]) : -1;
        for (let i = index + 1; i >= 0 && i < host.childNodes.length; i += 1) { if (isMappedBlock(host.childNodes[i])) { run.after = host.childNodes[i]; break; } }
        if (!run.nodes.some((node) => (node.textContent || '').trim())) return;
        let start = run.before ? lineRangeOf(run.before)[1] + 1 : hostStart;
        let end = run.after ? lineRangeOf(run.after)[0] - 1 : hostEnd;
        if (!Number.isFinite(start)) start = hostStart; if (!Number.isFinite(end)) end = hostEnd;
        start = Math.min(Math.max(start, hostStart), hostEnd); end = Math.min(Math.max(end, hostStart), hostEnd);
        if (end < start) { start = Math.min(start, end); end = start; }
        const wrapper = document.createElement('span'); wrapper.className = 'md-inline-run';
        wrapper.dataset.lineStart = String(start); wrapper.dataset.lineEnd = String(end);
        run.nodes[0].parentNode.insertBefore(wrapper, run.nodes[0]);
        run.nodes.forEach((node) => wrapper.appendChild(node));
      });
    });
  }

  function leafBlocks() { return Array.from(content.querySelectorAll('[data-line-start]')).filter((el) => !el.querySelector('[data-line-start]')); }
  function descriptors(leaves) { return leaves.map((el, index) => ({ key: index, lineStart: Number(el.dataset.lineStart), lineEnd: Number(el.dataset.lineEnd), text: el.textContent || '' })); }

  function outline() {
    return Array.from(content.querySelectorAll('h1,h2,h3')).map((heading, index) => {
      if (!heading.id) heading.id = `draftback-h-${index}`;
      return { id: heading.id, level: Number(heading.tagName.slice(1)), text: heading.textContent.trim(), line: Number(heading.dataset.lineStart || 0) };
    });
  }

  // Front Matter(---/+++ 包住的元数据)不属于正文:阅读时替换成同样行数的空行,行号不变、批注锚点不受影响。
  const FRONT_MATTER = /^(---|\+\+\+)[ \t]*\r?\n[\s\S]*?\r?\n\1[ \t]*(?:\r?\n|$)/;
  function blankFrontMatter(text) {
    const match = String(text || '').match(FRONT_MATTER);
    if (!match) return String(text || '');
    const lines = match[0].split('\n').length - 1;
    return '\n'.repeat(lines) + text.slice(match[0].length);
  }
  // 手机屏窄,表格按内容自动分列时,短单元格(如"版本指纹")会被挤成一字一行。
  // 短单元格不折行,长单元格照常换行;整表过宽时由表格自身横向滚动(见 reader.css)。
  function keepShortCellsTogether(root) {
    root.querySelectorAll('th, td').forEach((cell) => {
      let width = 0;
      for (const ch of cell.textContent.trim()) width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
      if (width && width <= 12) cell.classList.add('md-cell-short');
    });
  }
  // 渲染后的统一处理:短单元格不折行、本地图片换成随文档到达的数据、站外链接才可点、Mermaid 代码换成图表占位
  function decorate(target) {
    keepShortCellsTogether(target);
    target.querySelectorAll('img[src]').forEach((image) => {
      const src = image.getAttribute('src') || '';
      if (/^(https?:|data:)/i.test(src)) return;
      const key = decodeURIComponent(src.replace(/^\.\//, '').replace(/[?#].*$/, ''));
      const data = state.assets[key];
      if (data) { image.src = data; return; }
      const placeholder = document.createElement('span'); placeholder.className = 'md-missing-asset'; placeholder.textContent = `图片未随文档一起到达:${key}`;
      image.replaceWith(placeholder);
    });
    target.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (!/^https?:/i.test(href)) { link.removeAttribute('href'); }
    });
    const diagrams = [];
    target.querySelectorAll('code.language-mermaid').forEach((code) => {
      const parent = code.closest('pre') || code;
      const el = document.createElement('div'); el.className = 'mermaid'; el.textContent = code.textContent;
      parent.replaceWith(el); diagrams.push(el);
    });
    return diagrams;
  }

  async function render(markdown) {
    const target = document.createElement('div');
    target.innerHTML = sanitize(md.render(blankFrontMatter(markdown)));
    adoptBareInlineRuns(target);
    const diagrams = decorate(target);
    content.replaceChildren(...target.childNodes);
    empty.hidden = true;
    if (diagrams.length && window.mermaid) { try { await window.mermaid.run({ nodes: diagrams }); } catch (error) { console.warn('mermaid', error); } }
    state.rendered = true;
    renderMarkers();
    post({ type: 'rendered', outline: outline() });
  }

  // ---------- 批注高亮 ----------
  function textPoint(block, offset) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = offset; let node = walker.nextNode(); let last = null;
    while (node) {
      if (remaining <= node.data.length) return { node, offset: remaining };
      remaining -= node.data.length; last = node; node = walker.nextNode();
    }
    return last ? { node: last, offset: last.data.length } : null;
  }
  function rangeForSegment(block, segment) {
    const start = textPoint(block, segment.startTextOffset), end = textPoint(block, segment.endTextOffset);
    if (!start || !end) return null;
    const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    return range.collapsed ? null : range;
  }
  function renderMarkers(focusId = null) {
    if (!(globalThis.CSS && CSS.highlights && globalThis.Highlight)) return;
    CSS.highlights.delete('draftback-open'); CSS.highlights.delete('draftback-focus');
    if (!state.rendered || !Anchor) return;
    const leaves = leafBlocks(); const blocks = descriptors(leaves);
    const open = [], focus = [];
    for (const note of state.annotations) {
      if ((Anchor.effectiveStatus ? Anchor.effectiveStatus(note) : (note.status || 'open')) !== 'open' || note.scope === 'document') continue;
      let resolved = null;
      try { resolved = Anchor.resolveAnchor(note, blocks); } catch (_) { resolved = null; }
      if (!resolved || !resolved.matched || !Array.isArray(resolved.segments)) continue;
      for (const segment of resolved.segments) {
        const block = leaves[segment.blockIndex]; if (!block) continue;
        const range = rangeForSegment(block, segment); if (!range) continue;
        open.push(range); if (note.id === focusId) focus.push(range);
      }
    }
    if (open.length) CSS.highlights.set('draftback-open', new Highlight(...open));
    if (focus.length) { CSS.highlights.set('draftback-focus', new Highlight(...focus)); focus[0].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  // ---------- 划词 → 锚点(与桌面端算法一致) ----------
  function textOffset(block, container, offset) {
    try { const range = document.createRange(); range.selectNodeContents(block); range.setEnd(container, offset); return (range.cloneContents().textContent || '').length; } catch { return null; }
  }
  function intersect(range, block) {
    try {
      if (!range.intersectsNode(block)) return null;
      const blockRange = document.createRange(); blockRange.selectNodeContents(block);
      const out = document.createRange();
      if (range.compareBoundaryPoints(Range.START_TO_START, blockRange) >= 0) out.setStart(range.startContainer, range.startOffset); else out.setStart(blockRange.startContainer, blockRange.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, blockRange) <= 0) out.setEnd(range.endContainer, range.endOffset); else out.setEnd(blockRange.endContainer, blockRange.endOffset);
      return !out.collapsed && out.toString().trim() ? out : null;
    } catch { return null; }
  }
  function headingPathFor(block) {
    const stack = [];
    content.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => {
      if (block.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING) {
        const level = Number(heading.tagName.slice(1));
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, text: heading.textContent.trim() });
      }
    });
    return stack.map((item) => item.text);
  }
  function figureRefOf(block, quote) {
    for (const text of [quote || '', block ? block.textContent || '' : '']) {
      const match = text.match(/(图|表|Figure|Fig\.?|Table)\s*[\d０-９][\d０-９.\-—－]*/i);
      if (match) return match[0].replace(/\s+/g, ' ').trim();
    }
    return null;
  }
  function captureSelection() {
    const selection = window.getSelection();
    if (!state.rendered || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;
    return anchorForRange(range, selection.toString());
  }
  // 一段正文范围 → 锚点(与桌面端算法一致);划词与「复制到本轮」共用
  function anchorForRange(range, quoteText) {
    const leaves = leafBlocks(); const picked = [];
    leaves.forEach((block, index) => { const part = intersect(range, block); if (part) picked.push({ block, index, part }); });
    if (!picked.length) return null;
    const first = picked[0], last = picked[picked.length - 1];
    const start = textOffset(first.block, first.part.startContainer, first.part.startOffset);
    const end = textOffset(last.block, last.part.endContainer, last.part.endOffset);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    try {
      const anchor = Anchor.createAnchorFromBlocks(descriptors(leaves), { blockIndex: first.index, offset: start }, { blockIndex: last.index, offset: end },
        { headingPath: headingPathFor(first.block), figureRef: figureRefOf(first.block, quoteText) });
      return { anchor, quote: quoteText };
    } catch (error) { post({ type: 'error', message: `锚点失败:${error.message}` }); return null; }
  }

  // ---------- 回稿卡与「显示改动」(UI 方案 4.4;2026-10-15 用户定:默认干净稿,同一个按钮显示 / 隐藏改动) ----------
  // 原生给:returnCard { title, meta, summary, note } 与 previousMarkdown(手机换新版前留的上一版)。
  // 对比用与 Mac 对比视图同一套算法(desktop-diff.js);对比视图只读,在正文之外单独画,批注锚点不受影响。
  const cardEl = document.getElementById('returnCard');
  // 定稿以后标题旁边的火漆印与日期:原生给 stamp { date } 才显示
  const stampEl = document.getElementById('stamp');
  function renderStamp(stamp) {
    const date = stamp && typeof stamp.date === 'string' ? stamp.date : '';
    stampEl.hidden = !date;
    stampEl.querySelector('span').textContent = date ? `${date} 定稿` : '';
  }
  const changesEl = document.getElementById('changes');
  const Diff = window.DraftbackDiff;
  const dmp = window.diff_match_patch ? new window.diff_match_patch() : null;
  // generation:每次 load 加一;异步画对比时每次 await 之后核对,过期的任务不许再动页面(新正文到了,旧对比不能把它藏起来)
  const changes = { previous: null, current: '', showing: false, painted: false, result: null, toggle: null, count: null, generation: 0, summary: null, more: null };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function escapeHtml(value) { return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

  function diffResult() {
    if (changes.result || changes.previous == null || !Diff || !dmp) return changes.result;
    try { changes.result = Diff.diffDocuments(md, dmp, changes.previous, changes.current); } catch (error) { post({ type: 'error', message: `对比失败:${error.message}` }); changes.result = null; }
    return changes.result;
  }

  function renderReturnCard(card) {
    cardEl.replaceChildren();
    changes.toggle = null;
    if (!card) { cardEl.hidden = true; return; }
    const head = el('div', 'rc-head');
    head.append(el('span', 'rc-icon', '↩'), el('h2', 'rc-title', card.title || '稿子回来了'));
    cardEl.append(head);
    if (card.meta) cardEl.append(el('div', 'rc-meta', card.meta));
    if (card.counts) {
      // 与 Mac 回稿卡一样的计数徽标;「逐条结果」由原生弹半屏列表
      const chips = el('div', 'rc-chips');
      chips.append(el('span', 'rc-chip applied', `采纳 ${card.counts.applied}`), el('span', 'rc-chip wontfix', `未采纳 ${card.counts.wontfix}`));
      if (card.hasResults) {
        const list = el('button', 'rc-results', '逐条结果'); list.type = 'button';
        list.addEventListener('click', () => post({ type: 'returnCard', action: 'results' }));
        chips.append(list);
      }
      cardEl.append(chips);
    }
    if (card.summary) {
      const summary = el('p', 'rc-summary clamped', card.summary);
      cardEl.append(summary);
      const more = el('button', 'rc-more', '展开'); more.type = 'button'; more.hidden = true;
      more.addEventListener('click', () => {
        const open = summary.classList.toggle('clamped') === false;
        more.textContent = open ? '收起' : '展开';
      });
      cardEl.append(more);
      changes.summary = summary; changes.more = more;
      requestAnimationFrame(measureSummary);
    }
    if (changes.previous != null && Diff && dmp) {
      if (card.note) cardEl.append(el('div', 'rc-note', card.note));
      const actions = el('div', 'rc-actions');
      const toggle = el('button', 'rc-toggle'); toggle.type = 'button';
      toggle.addEventListener('click', () => setShowingChanges(!changes.showing));
      actions.append(toggle);
      const count = el('span', 'rc-count'); actions.append(count);
      cardEl.append(actions);
      changes.toggle = toggle; changes.countEl = count;
      paintToggle();
      // 改了几处:正文画完再算,不挡首屏
      setTimeout(() => {
        const result = diffResult();
        if (result && changes.countEl === count) { changes.count = result.changes; count.textContent = result.changes ? `改了 ${result.changes} 处` : '没有改动'; post({ type: 'changesCount', count: result.changes }); }
      }, 300);
    }
    cardEl.hidden = false;
  }

  // 摘要超过 4 行才出「展开」;字号或宽度变了要重新量
  function measureSummary() {
    const { summary, more } = changes;
    if (!summary || !more || !summary.isConnected) return;
    if (!summary.classList.contains('clamped')) { more.hidden = false; return; }
    more.hidden = summary.scrollHeight <= summary.clientHeight + 2;
  }
  window.addEventListener('resize', () => requestAnimationFrame(measureSummary));

  function paintToggle() {
    if (!changes.toggle) return;
    changes.toggle.textContent = changes.showing ? '隐藏改动' : '显示改动';
    changes.toggle.classList.toggle('showing', changes.showing);
    changes.toggle.setAttribute('aria-pressed', String(changes.showing));
  }

  // 元数据(Front Matter)、引用定义、空隙渲染出来是空的:按源码显示才看得见增删(与 Mac 对比视图一致)
  const SOURCE_ONLY = new Set(['front_matter', 'reference', 'gap', 'blank']);
  function changeBlock(text, className, type) {
    const box = el('div', className);
    if (SOURCE_ONLY.has(type) || !String(text).trim()) {
      box.append(el('pre', 'diff-inline diff-source-block', text));
      return box;
    }
    box.innerHTML = sanitize(md.render(blankFrontMatter(text)));
    decorate(box);
    return box;
  }
  function inlineBlock(item) {
    const box = el('div', 'diff-replace');
    const body = el(item.source ? 'pre' : 'p', 'diff-inline');
    body.innerHTML = item.inline.map(([op, text]) => (op === 0 ? escapeHtml(text) : op < 0 ? `<del class="diff-del">${escapeHtml(text)}</del>` : `<ins class="diff-ins">${escapeHtml(text)}</ins>`)).join('');
    box.append(body);
    return box;
  }
  async function paintChanges(generation) {
    const result = diffResult();
    if (!result) { changesEl.replaceChildren(el('p', 'diff-empty', '没能算出改动。')); return; }
    const refsNew = Diff.referenceDefinitions(result.newBlocks), refsOld = Diff.referenceDefinitions(result.oldBlocks);
    const frag = document.createDocumentFragment();
    const legend = el('div', 'diff-legend');
    legend.append(el('span', 'legend-insert', '新增'), el('span', 'legend-delete', '删除'), el('span', 'legend-replace', '改过'));
    frag.append(legend);
    for (const hunk of result.hunks) {
      if (hunk.kind === 'equal') { frag.append(changeBlock(refsNew ? `${hunk.text}\n\n${refsNew}` : hunk.text, 'diff-equal')); continue; }
      for (const item of hunk.items) {
        const node = el('div', `diff-change diff-${item.kind}-item`);
        const source = SOURCE_ONLY.has(item.type);
        if (item.kind === 'insert') node.append(changeBlock(refsNew && !source ? `${item.newText}\n\n${refsNew}` : item.newText, 'diff-insert', item.type));
        else if (item.kind === 'delete') node.append(changeBlock(refsOld && !source ? `${item.oldText}\n\n${refsOld}` : item.oldText, 'diff-delete', item.type));
        else if (item.inline) node.append(inlineBlock(item));
        else node.append(changeBlock(item.oldText, 'diff-delete', item.type), changeBlock(item.newText, 'diff-insert', item.type));
        frag.append(node);
      }
    }
    if (generation !== changes.generation) return false;
    changesEl.replaceChildren(frag);
    const diagrams = Array.from(changesEl.querySelectorAll('.mermaid'));
    if (diagrams.length && window.mermaid) { try { await window.mermaid.run({ nodes: diagrams }); } catch (_) {} }
    if (generation !== changes.generation) return false;
    changes.painted = true;
    return true;
  }

  async function setShowingChanges(showing) {
    if (showing && (changes.previous == null || !Diff || !dmp)) return;
    const generation = changes.generation;
    window.getSelection()?.removeAllRanges();
    if (showing && !changes.painted && !(await paintChanges(generation))) return;
    if (generation !== changes.generation) return; // 画的时候换了正文:作废
    changes.showing = showing;
    changesEl.hidden = !showing;
    content.hidden = showing;
    paintToggle();
    if (showing) changesEl.querySelector('.diff-change')?.scrollIntoView({ block: 'center' });
    else cardEl.scrollIntoView({ block: 'start' });
    post({ type: 'changesState', showing });
  }

  // 在正文里找一段引文,返回所有出现处的范围。引文与正文用同一种规范化(连续空白算一个空格),
  // 再按对照表换回原文偏移;whole 为假时只比前 40 个字(逐条结果定位用)
  function rangesForQuote(quote, whole) {
    const wanted = String(quote || '').replace(/\s+/g, ' ').trim();
    if (!wanted) return [];
    const probe = whole ? wanted : wanted.slice(0, 40);
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes = []; let raw = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push({ node, start: raw.length }); raw += node.data; }
    let flat = ''; const map = []; let lastSpace = true;
    for (let i = 0; i < raw.length; i += 1) {
      const space = /\s/.test(raw[i]);
      if (space && lastSpace) continue;
      flat += space ? ' ' : raw[i]; map.push(i); lastSpace = space;
    }
    // 起点取「从这里开始」的节点,终点取「到这里为止」的节点(落在两个节点交界时不跨进下一段)
    const startPoint = (offset) => {
      const hit = nodes.find((item) => offset >= item.start && offset < item.start + item.node.data.length);
      return hit ? { node: hit.node, offset: offset - hit.start } : null;
    };
    const endPoint = (offset) => {
      const hit = nodes.find((item) => offset > item.start && offset <= item.start + item.node.data.length);
      return hit ? { node: hit.node, offset: offset - hit.start } : null;
    };
    const ranges = [];
    for (let at = flat.indexOf(probe); at >= 0; at = flat.indexOf(probe, at + 1)) {
      const start = startPoint(map[at]), end = endPoint(map[at + probe.length - 1] + 1);
      if (!start || !end) continue;
      const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
      ranges.push(range);
    }
    return ranges;
  }

  // 逐条结果点一条:在正文里找到那句引文,滚过去并闪一下;找不到(被改掉了)告诉原生
  function locateQuote(quote) {
    if (changes.showing) void setShowingChanges(false);
    const range = rangesForQuote(quote, false)[0];
    if (!range) { post({ type: 'locateFailed' }); return false; }
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (globalThis.CSS && CSS.highlights && globalThis.Highlight) {
      CSS.highlights.set('draftback-locate', new Highlight(range));
      setTimeout(() => CSS.highlights.delete('draftback-locate'), 2200);
    }
    return true;
  }

  // 选区有没有:有就立刻报(底栏换成「批注这段」),没了等 0.2 秒再报(拖动选区时不闪)
  let selectionActive = false, selectionTimer = null;
  function selectionInContent() {
    const selection = window.getSelection();
    if (!state.rendered || !selection || selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    return content.contains(range.commonAncestorContainer) && Boolean(selection.toString().trim());
  }
  // 点正文(不是链接、按钮,也没在选字):告诉原生,往下读时收起的上下栏放出来。
  // 监听挂在正文与对比视图上,不挂 document:iOS 上点普通文字时,只有自己或祖先(body 以下)挂了监听才会派发 click
  const onTap = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('a, button, input, summary')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    post({ type: 'tap' });
  };
  content.addEventListener('click', onTap);
  changesEl.addEventListener('click', onTap);

  document.addEventListener('selectionchange', () => {
    const active = selectionInContent();
    clearTimeout(selectionTimer);
    if (active) {
      if (!selectionActive) { selectionActive = true; post({ type: 'selectionState', active: true }); }
      return;
    }
    selectionTimer = setTimeout(() => {
      if (selectionActive && !selectionInContent()) { selectionActive = false; post({ type: 'selectionState', active: false }); }
    }, 200);
  });

  function setFontScale(value) {
    const scale = Number(value);
    if (Number.isFinite(scale) && scale > 0.5 && scale < 4) document.documentElement.style.setProperty('--font-scale', String(scale));
    requestAnimationFrame(measureSummary);
  }

  window.DraftbackReader = Object.freeze({
    load(payload) {
      setFontScale(payload.fontScale);
      changes.previous = typeof payload.previousMarkdown === 'string' ? payload.previousMarkdown : null;
      changes.current = String(payload.markdown || '');
      changes.generation += 1;
      changes.showing = false; changes.painted = false; changes.result = null; changes.count = null; changes.summary = null; changes.more = null;
      changesEl.hidden = true; changesEl.replaceChildren(); content.hidden = false;
      renderReturnCard(payload.returnCard || null);
      renderStamp(payload.stamp || null);
      state.annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
      state.assets = payload.assets && typeof payload.assets === 'object' ? payload.assets : {};
      return render(String(payload.markdown || ''));
    },
    setAnnotations(list) { state.annotations = Array.isArray(list) ? list : []; renderMarkers(); },
    captureSelection() { const captured = captureSelection(); if (captured) post({ type: 'selection', ...captured }); else post({ type: 'selection', anchor: null }); return captured; },
    clearSelection() { window.getSelection()?.removeAllRanges(); },
    scrollToHeading(id) { document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
    scrollToLine(line) {
      const target = leafBlocks().find((el) => Number(el.dataset.lineEnd) >= line) || null;
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    focusNote(id) { if (changes.showing) void setShowingChanges(false); renderMarkers(id); },
    setFontScale,
    toggleChanges() { return setShowingChanges(!changes.showing); },
    locateQuote(quote) { return locateQuote(quote); },
    // 「复制到本轮」:引文在本轮正文里还在就重新算锚点。出现不止一处时按原来所在的章节挑;
    // 找不到、或挑不出唯一一处,返回 null(原生改成总体意见,不默认挂到第一处)
    anchorForQuote(quote, headingPath) {
      if (!state.rendered) return null;
      let ranges = rangesForQuote(quote, true);
      if (ranges.length > 1) {
        const wanted = JSON.stringify((Array.isArray(headingPath) ? headingPath : []).map((text) => String(text).replace(/\s+/g, ' ').trim()));
        ranges = ranges.filter((range) => {
          const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
          const block = element && element.closest('[data-line-start]');
          return block && JSON.stringify(headingPathFor(block).map((text) => text.replace(/\s+/g, ' ').trim())) === wanted;
        });
      }
      if (ranges.length !== 1) return null;
      const result = anchorForRange(ranges[0], String(quote));
      return result ? result.anchor : null;
    },
    scrollToTop() { (cardEl.hidden ? content : cardEl).scrollIntoView({ block: 'start' }); },
    outline,
  });
  post({ type: 'ready' });
})();
