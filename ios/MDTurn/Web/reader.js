/*
 * MDTurn iOS 阅读内核(WKWebView 内)。与桌面端共用同一套渲染库与锚点模块(desktop-anchor.js),
 * 批注锚点格式与 Mac 的 sidecar 完全一致,这样手机上的批注批次可以原样回到 Mac。
 *
 * 与原生侧的约定:
 *   原生 → 页面:window.MDTurnReader.load({ markdown, annotations, assets })、setAnnotations(list)、
 *                 captureSelection()(由编辑菜单的「批注」触发)、scrollToLine(n)、focusNote(id)、clearSelection()
 *   页面 → 原生:webkit.messageHandlers.mdturn.postMessage({ type, ... })
 *                 type = ready | rendered { outline } | selection { anchor, quote } | noteTap { id } | error { message }
 */
(() => {
  'use strict';
  const content = document.getElementById('content');
  const empty = document.getElementById('empty');
  const Anchor = window.MDTurnAnchor;
  const post = (message) => {
    try { window.webkit.messageHandlers.mdturn.postMessage(message); } catch (_) { /* 非 WKWebView 环境(调试)忽略 */ }
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
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: prefersDark ? 'dark' : 'default' });

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
      if (!heading.id) heading.id = `mdturn-h-${index}`;
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
  async function render(markdown) {
    const target = document.createElement('div');
    target.innerHTML = sanitize(md.render(blankFrontMatter(markdown)));
    adoptBareInlineRuns(target);
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
    CSS.highlights.delete('mdturn-open'); CSS.highlights.delete('mdturn-focus');
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
    if (open.length) CSS.highlights.set('mdturn-open', new Highlight(...open));
    if (focus.length) { CSS.highlights.set('mdturn-focus', new Highlight(...focus)); focus[0].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
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
    const leaves = leafBlocks(); const picked = [];
    leaves.forEach((block, index) => { const part = intersect(range, block); if (part) picked.push({ block, index, part }); });
    if (!picked.length) return null;
    const first = picked[0], last = picked[picked.length - 1];
    const start = textOffset(first.block, first.part.startContainer, first.part.startOffset);
    const end = textOffset(last.block, last.part.endContainer, last.part.endOffset);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    try {
      const anchor = Anchor.createAnchorFromBlocks(descriptors(leaves), { blockIndex: first.index, offset: start }, { blockIndex: last.index, offset: end },
        { headingPath: headingPathFor(first.block), figureRef: figureRefOf(first.block, selection.toString()) });
      return { anchor, quote: selection.toString() };
    } catch (error) { post({ type: 'error', message: `锚点失败:${error.message}` }); return null; }
  }

  window.MDTurnReader = Object.freeze({
    load(payload) {
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
    focusNote(id) { renderMarkers(id); },
    outline,
  });
  post({ type: 'ready' });
})();
