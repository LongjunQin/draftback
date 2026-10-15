/*
 * 轮次对比(版本记录设计 v4 第 8 节):比较一轮的原稿与完成稿,给独立只读对比视图用。
 *
 * 规矩:
 *   - 以源文为准、覆盖全部源文:Front Matter、块间空隙(含引用链接定义)都切成块,块文本按原始字节比较,
 *     不用渲染 HTML 当块身份;所有块按原顺序拼回去必须等于原文。
 *   - 块级对齐用最长公共子序列(LCS);规模超过上限时先用"两边都只出现一次"的块当锚点分段,段内再 LCS。
 *   - 改动块内做字级对比(diff-match-patch);代码块 / 公式 / Mermaid / 原始 HTML 退化为逐行源码差异,保留空白;
 *     表格行数相同按字级(落在单元格上),行数变了就整表删旧加新。
 *   - 结果只有三种:新增、删除、替换;段落移动显示为删旧加新。
 *
 * 纯函数、无 DOM:浏览器挂 window.DraftbackDiff,Node 里 module.exports;markdown-it 与 diff_match_patch 由调用方注入。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftbackDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FRONT_MATTER = /^(---|\+\+\+)[ \t]*\r?\n[\s\S]*?\r?\n\1[ \t]*(?:\r?\n|$)/;
  const LCS_CELL_LIMIT = 4_000_000;    // n × m 超过这个数就先按锚点分段
  const GROUP_PAIR_LIMIT = 40;         // 一个改动组里两边都不超过这个数才做相似度配对,否则按位置配
  const INLINE_CHAR_LIMIT = 20_000;    // 单块超过这个长度不做字级对比,整块替换
  const PAIR_SIMILARITY = 0.3;         // 低于这个相似度不算"同一块改过",而是删旧加新
  const SOURCE_TYPES = new Set(['fence', 'code_block', 'math_block', 'html_block', 'table']);
  const REF_DEFINITION = /^[ ]{0,3}\[[^\]]+\]:[ \t]*\S/;

  const isBlank = (text) => !/\S/.test(text);

  // ---------- 切块 ----------

  /** 把源文切成首尾相接的块;blocks.map(b => b.text).join('\n') === text */
  function splitBlocks(md, text) {
    const source = String(text || '');
    const blocks = [];
    let body = source;
    let lineOffset = 0;
    const fm = source.match(FRONT_MATTER);
    if (fm) {
      const fmText = fm[0].endsWith('\n') ? fm[0].slice(0, -1) : fm[0]; // 只去掉最后的 \n,\r 留在行尾,与 split('\n') 的行一致
      blocks.push({ kind: 'frontmatter', type: 'front_matter', text: fmText, startLine: 0, endLine: fmText.split('\n').length });
      lineOffset = blocks[0].endLine;
      if (fm[0].length === fmText.length) return blocks; // 没有结尾换行:整篇就是 Front Matter
      body = source.slice(fm[0].length);
    }
    const lines = body.split('\n');
    let tokens = [];
    try { tokens = md.parse(body, {}); } catch { tokens = []; }
    let cursor = 0;
    const pushGap = (from, to) => {
      if (to <= from) return;
      // 空隙里有内容(引用链接定义等)时,前后的空行单独成块,内容块身份不受空行数影响
      let head = from, tail = to;
      while (head < tail && isBlank(lines[head])) head += 1;
      if (head === tail) { blocks.push({ kind: 'gap', type: 'blank', text: lines.slice(from, to).join('\n'), startLine: lineOffset + from, endLine: lineOffset + to }); return; }
      while (tail > head && isBlank(lines[tail - 1])) tail -= 1;
      if (head > from) blocks.push({ kind: 'gap', type: 'blank', text: lines.slice(from, head).join('\n'), startLine: lineOffset + from, endLine: lineOffset + head });
      const gapText = lines.slice(head, tail).join('\n');
      blocks.push({ kind: 'gap', type: REF_DEFINITION.test(gapText) ? 'reference' : 'gap', text: gapText, startLine: lineOffset + head, endLine: lineOffset + tail });
      if (tail < to) blocks.push({ kind: 'gap', type: 'blank', text: lines.slice(tail, to).join('\n'), startLine: lineOffset + tail, endLine: lineOffset + to });
    };
    for (const token of tokens) {
      if (token.level !== 0 || token.nesting < 0 || !token.map || token.type === 'inline') continue;
      const [start, rawEnd] = token.map;
      const end = Math.min(rawEnd, lines.length);
      if (start < cursor || end <= start) continue;
      pushGap(cursor, start);
      // markdown-it 的 map 常把块后面的空行也算进去;把尾部空行剥出来当空隙,块身份更稳。
      // 代码块例外:未闭合围栏会一直延伸到文末,里面的空白行是代码内容,剥掉会漏报空白修改
      const type = token.type.replace(/_open$/, '');
      let bodyEnd = end;
      if (type !== 'fence' && type !== 'code_block') while (bodyEnd > start + 1 && isBlank(lines[bodyEnd - 1])) bodyEnd -= 1;
      blocks.push({ kind: 'block', type, text: lines.slice(start, bodyEnd).join('\n'), startLine: lineOffset + start, endLine: lineOffset + bodyEnd });
      pushGap(bodyEnd, end);
      cursor = end;
    }
    pushGap(cursor, lines.length);
    return blocks;
  }

  function blockKey(block) {
    if (block.kind === 'gap' && block.type === 'blank') return '\u0000blank';
    return block.text;
  }

  // ---------- 对齐 ----------

  function lcsPairs(a, b, lo1, hi1, lo2, hi2) {
    const n = hi1 - lo1, m = hi2 - lo2;
    const width = m + 1;
    const dp = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      const ka = a[lo1 + i];
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] = ka === b[lo2 + j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    const pairs = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[lo1 + i] === b[lo2 + j]) { pairs.push([lo1 + i, lo2 + j]); i += 1; j += 1; }
      else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i += 1;
      else j += 1;
    }
    return pairs;
  }

  /** 两边都只出现一次的块作锚点,取其最长递增子序列保证顺序 */
  function anchorPairs(a, b, lo1, hi1, lo2, hi2) {
    const countA = new Map(), countB = new Map();
    for (let i = lo1; i < hi1; i += 1) countA.set(a[i], (countA.get(a[i]) || 0) + 1);
    for (let j = lo2; j < hi2; j += 1) countB.set(b[j], (countB.get(b[j]) || 0) + 1);
    const posB = new Map();
    for (let j = lo2; j < hi2; j += 1) if (countB.get(b[j]) === 1 && countA.get(b[j]) === 1 && b[j] !== '\u0000blank') posB.set(b[j], j);
    const candidates = [];
    for (let i = lo1; i < hi1; i += 1) if (posB.has(a[i])) candidates.push([i, posB.get(a[i])]);
    // 按 j 的最长递增子序列(patience)
    const tails = [], tailIdx = [], prev = new Array(candidates.length).fill(-1);
    for (let k = 0; k < candidates.length; k += 1) {
      const j = candidates[k][1];
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < j) lo = mid + 1; else hi = mid; }
      tails[lo] = j; tailIdx[lo] = k; prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
    }
    const out = [];
    for (let k = tailIdx.length ? tailIdx[tailIdx.length - 1] : -1; k >= 0; k = prev[k]) out.push(candidates[k]);
    return out.reverse();
  }

  function alignRange(a, b, lo1, hi1, lo2, hi2, out, depth) {
    if (hi1 <= lo1 || hi2 <= lo2) return;
    if ((hi1 - lo1) * (hi2 - lo2) <= LCS_CELL_LIMIT) { for (const p of lcsPairs(a, b, lo1, hi1, lo2, hi2)) out.push(p); return; }
    const anchors = depth < 12 ? anchorPairs(a, b, lo1, hi1, lo2, hi2) : [];
    if (!anchors.length) {
      // 没有锚点又超上限:只对齐首尾完全相同的块,中间按位置配
      let head = 0;
      while (lo1 + head < hi1 && lo2 + head < hi2 && a[lo1 + head] === b[lo2 + head]) { out.push([lo1 + head, lo2 + head]); head += 1; }
      let tail = 0;
      while (hi1 - 1 - tail >= lo1 + head && hi2 - 1 - tail >= lo2 + head && a[hi1 - 1 - tail] === b[hi2 - 1 - tail]) { tail += 1; }
      for (let t = tail; t >= 1; t -= 1) out.push([hi1 - t, hi2 - t]);
      return;
    }
    let c1 = lo1, c2 = lo2;
    for (const [i, j] of anchors) {
      alignRange(a, b, c1, i, c2, j, out, depth + 1);
      out.push([i, j]);
      c1 = i + 1; c2 = j + 1;
    }
    alignRange(a, b, c1, hi1, c2, hi2, out, depth + 1);
  }

  function alignBlocks(oldBlocks, newBlocks) {
    const a = oldBlocks.map(blockKey), b = newBlocks.map(blockKey);
    const pairs = [];
    alignRange(a, b, 0, a.length, 0, b.length, pairs, 0);
    pairs.sort((x, y) => x[0] - y[0]);
    return pairs;
  }

  // ---------- 改动组内配对 ----------

  function bigrams(text) {
    const set = new Map();
    const s = String(text);
    for (let i = 0; i + 1 < s.length; i += 1) { const g = s.slice(i, i + 2); set.set(g, (set.get(g) || 0) + 1); }
    return set;
  }

  function similarity(x, y, gx, gy) {
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;
    // 长度差太大时相似度上限已低于门槛,不用数二元组
    if ((2 * Math.min(x.length, y.length)) / (x.length + y.length) < PAIR_SIMILARITY) return 0;
    gx = gx || bigrams(x); gy = gy || bigrams(y);
    let common = 0;
    for (const [g, c] of gx) if (gy.has(g)) common += Math.min(c, gy.get(g));
    return (2 * common) / ((x.length - 1) + (y.length - 1));
  }
  const PAIR_CHAR_BUDGET = 400_000; // 一个改动组里参与相似度配对的总字符数上限,超过按位置配

  /** 组内配对:相似度加权的顺序对齐;两边都大时按位置配 */
  function pairGroup(oldBlocks, newBlocks) {
    const n = oldBlocks.length, m = newBlocks.length;
    const pairs = [];
    if (!n || !m) return pairs;
    const chars = oldBlocks.reduce((t, b) => t + b.text.length, 0) + newBlocks.reduce((t, b) => t + b.text.length, 0);
    const huge = oldBlocks.some((b) => b.text.length > INLINE_CHAR_LIMIT) || newBlocks.some((b) => b.text.length > INLINE_CHAR_LIMIT);
    if (n > GROUP_PAIR_LIMIT || m > GROUP_PAIR_LIMIT || chars > PAIR_CHAR_BUDGET || huge) {
      for (let k = 0; k < Math.min(n, m); k += 1) pairs.push([k, k]);
      return pairs;
    }
    const gOld = oldBlocks.map((b) => bigrams(b.text)), gNew = newBlocks.map((b) => bigrams(b.text));
    const sim = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => {
      const s = oldBlocks[i].type === newBlocks[j].type || (oldBlocks[i].kind === 'block' && newBlocks[j].kind === 'block') ? similarity(oldBlocks[i].text, newBlocks[j].text, gOld[i], gNew[j]) : 0;
      return s >= PAIR_SIMILARITY ? s : 0;
    }));
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], sim[i][j] > 0 ? dp[i + 1][j + 1] + sim[i][j] : -1);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (sim[i][j] > 0 && dp[i][j] === dp[i + 1][j + 1] + sim[i][j]) { pairs.push([i, j]); i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
      else j += 1;
    }
    return pairs;
  }

  // ---------- 块内对比 ----------

  function lineDiff(dmp, oldText, newText) {
    const packed = dmp.diff_linesToChars_(oldText, newText);
    const diffs = dmp.diff_main(packed.chars1, packed.chars2, false);
    dmp.diff_charsToLines_(diffs, packed.lineArray);
    return diffs;
  }

  /** 表格一行的单元格数:去掉代码跨度与转义竖线后数分隔符 */
  function tableColumns(line) {
    const cleaned = line.replace(/`[^`]*`/g, 'x').replace(/\\\|/g, 'x').trim().replace(/^\|/, '').replace(/\|$/, '');
    return cleaned.split('|').length;
  }
  function sameTableShape(oldText, newText) {
    const a = oldText.split('\n'), b = newText.split('\n');
    if (a.length !== b.length) return false;
    return a.every((line, i) => tableColumns(line) === tableColumns(b[i]));
  }

  // diff-match-patch 按 UTF-16 码元比较,会把表情等代理对拆开;先把增补平面字符映射到私用区单字符,比完再还原
  const ASTRAL = /[\uD800-\uDBFF]/;
  function protectAstral(a, b) {
    if (!ASTRAL.test(a) && !ASTRAL.test(b)) return { a, b, decode: (text) => text };
    const used = new Set();
    for (const ch of a + b) { const cp = ch.codePointAt(0); if (cp >= 0xE000 && cp <= 0xF8FF) used.add(cp); }
    const map = new Map(); const back = new Map();
    let next = 0xE000;
    const encode = (text) => Array.from(text).map((ch) => {
      if (ch.length < 2) return ch;
      if (!map.has(ch)) {
        while (used.has(next)) next += 1;
        if (next > 0xF8FF) return ch;
        const code = String.fromCharCode(next); map.set(ch, code); back.set(code, ch); next += 1;
      }
      return map.get(ch);
    }).join('');
    const decode = (text) => text.replace(/[\uE000-\uF8FF]/g, (code) => back.get(code) || code);
    return { a: encode(a), b: encode(b), decode };
  }
  function charDiff(dmp, oldText, newText) {
    const guarded = protectAstral(oldText, newText);
    const diffs = dmp.diff_main(guarded.a, guarded.b, false);
    dmp.diff_cleanupSemantic(diffs);
    return diffs.map(([op, text]) => [op, guarded.decode(text)]);
  }

  function inlineDiff(dmp, type, oldText, newText) {
    if (oldText.length > INLINE_CHAR_LIMIT || newText.length > INLINE_CHAR_LIMIT) return null;
    if (type === 'table') {
      if (!sameTableShape(oldText, newText)) return null; // 行列变了:显示旧表、新表
      return charDiff(dmp, oldText, newText);
    }
    if (SOURCE_TYPES.has(type)) return lineDiff(dmp, oldText, newText);
    return charDiff(dmp, oldText, newText);
  }

  // ---------- 主入口 ----------

  function lineCount(blocks) { return blocks.reduce((total, block) => total + block.text.split('\n').length, 0); }

  /**
   * 返回 { hunks, changes, stats, oldBlocks, newBlocks }
   *   hunk = { kind: 'equal', text, blocks } | { kind: 'change', index, items: [{ index, kind: replace|insert|delete, type, oldText, newText, inline, source }] }
   *   changes = 改动块总数(每个 item 一个序号,「上一处 / 下一处」按它跳)
   *   inline 是 diff-match-patch 的 [[op, text], …];source=true 表示按源码逐行显示(代码、公式、HTML)。
   */
  function diffDocuments(md, dmp, oldText, newText) {
    const started = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const oldBlocks = splitBlocks(md, oldText);
    const newBlocks = splitBlocks(md, newText);
    const isBlankGap = (b) => b.kind === 'gap' && b.type === 'blank';
    // 空行不参与对齐:否则"删一段、改一段、加一段"会被中间的空行切成几个小组,配不上对;空行只跟着相邻的未改块走
    const oldC = [], newC = [];
    oldBlocks.forEach((b, i) => { if (!isBlankGap(b)) oldC.push(i); });
    newBlocks.forEach((b, j) => { if (!isBlankGap(b)) newC.push(j); });
    const pairs = alignBlocks(oldC.map((i) => oldBlocks[i]), newC.map((j) => newBlocks[j]));
    const hunks = [];
    const stats = { inserted: 0, deleted: 0, replaced: 0 };
    let changes = 0;
    let equalRun = [];
    const flushEqual = () => {
      if (!equalRun.length) return;
      hunks.push({ kind: 'equal', blocks: equalRun, text: equalRun.map((b) => b.text).join('\n') });
      equalRun = [];
    };
    const pushChange = (olds, news) => {
      if (!olds.length && !news.length) return;
      flushEqual();
      const items = [];
      const paired = pairGroup(olds, news);
      const usedOld = new Set(), usedNew = new Set();
      let oi = 0, ni = 0;
      const emitPending = (toOld, toNew) => {
        while (oi < toOld) { if (!usedOld.has(oi)) { items.push({ kind: 'delete', type: olds[oi].type, oldText: olds[oi].text, newText: null, inline: null, source: SOURCE_TYPES.has(olds[oi].type) }); stats.deleted += 1; } oi += 1; }
        while (ni < toNew) { if (!usedNew.has(ni)) { items.push({ kind: 'insert', type: news[ni].type, oldText: null, newText: news[ni].text, inline: null, source: SOURCE_TYPES.has(news[ni].type) }); stats.inserted += 1; } ni += 1; }
      };
      for (const [a, b] of paired) { usedOld.add(a); usedNew.add(b); }
      // 「上一处 / 下一处」按改动块跳:每个改动块一个序号;相邻的改动块合在一个组里渲染
      const flushItems = () => {
        if (!items.length) return;
        const first = changes;
        for (const item of items) { item.index = changes; changes += 1; }
        hunks.push({ kind: 'change', index: first, items: items.splice(0) });
      };
      for (const [a, b] of paired) {
        emitPending(a, b);
        oi = a + 1; ni = b + 1;
        if (olds[a].text === news[b].text) { flushItems(); hunks.push({ kind: 'equal', blocks: [news[b]], text: news[b].text }); continue; } // 位置配对配到了没改的块
        const type = news[b].type;
        const inline = inlineDiff(dmp, type, olds[a].text, news[b].text);
        items.push({ kind: 'replace', type, oldText: olds[a].text, newText: news[b].text, inline, source: SOURCE_TYPES.has(type) });
        stats.replaced += 1;
      }
      emitPending(olds.length, news.length);
      flushItems();
    };
    let fullNew = 0;   // 新稿完整块表里消费到哪
    const takeBlanksUpTo = (limit) => { while (fullNew < limit) { if (isBlankGap(newBlocks[fullNew])) equalRun.push(newBlocks[fullNew]); fullNew += 1; } };
    let oi = 0, ni = 0; // 内容块下标
    const consume = (a, b) => {
      // a / b 是下一对相等块的内容下标(或末尾);之前的内容块都是改动
      const firstChangedNew = ni < b ? newC[ni] : (b < newC.length ? newC[b] : newBlocks.length);
      takeBlanksUpTo(firstChangedNew);
      pushChange(oldC.slice(oi, a).map((i) => oldBlocks[i]), newC.slice(ni, b).map((j) => newBlocks[j]));
      const matchedFull = b < newC.length ? newC[b] : newBlocks.length;
      takeBlanksUpTo(matchedFull);
      if (b < newC.length) { equalRun.push(newBlocks[matchedFull]); fullNew = matchedFull + 1; }
      oi = a + 1; ni = b + 1;
    };
    for (const [a, b] of pairs) consume(a, b);
    consume(oldC.length, newC.length);
    takeBlanksUpTo(newBlocks.length);
    flushEqual();
    const ended = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    return { hunks, changes, stats, oldBlocks, newBlocks, lines: { old: lineCount(oldBlocks), new: lineCount(newBlocks) }, ms: ended - started };
  }

  /** 新稿里的引用链接定义:分块渲染时附在每块后面,引用式链接与图片才能解析 */
  function referenceDefinitions(blocks) {
    return blocks.filter((b) => b.kind === 'gap' && b.type === 'reference').map((b) => b.text).join('\n');
  }

  return Object.freeze({ splitBlocks, alignBlocks, pairGroup, similarity, inlineDiff, diffDocuments, referenceDefinitions, sameTableShape, protectAstral, SOURCE_TYPES, LCS_CELL_LIMIT, INLINE_CHAR_LIMIT });
});
