/*
 * 块级局部回写(路线图 v3 第 6.2 节"编辑保存保真")。
 *
 * 所见即所得编辑器(Milkdown)保存时会把整篇文档重新序列化:没改过的段落也会被规范化改写
 * (列表符号、强调符号、换行、转义……),原始 HTML、公式、脚注等它不认识的内容更可能被改坏。
 *
 * 这里不让编辑器的输出直接落盘,而是做三方对比:
 *   O  = 用户打开时的原文
 *   N0 = 原文经编辑器"解析→序列化"但未做任何修改的结果(规范化基线)
 *   N1 = 编辑器当前内容序列化的结果
 * 把三者都切成顶层块,用"渲染后的 HTML"作为块的身份(对格式差异不敏感,对内容差异敏感):
 *   - N1 里与 N0 完全相同的块 = 用户没碰过 → 回写 O 里对应块的原始字节;
 *   - 用户改过/新增的块 → 用 N1 的序列化文本;
 *   - 列表块被改时再细到列表项:没碰的项保留原字节,改过的项换成新文本并沿用原来的标记与缩进;
 *   - Front Matter 不进编辑器,原样保留;行尾符与结尾换行沿用原文。
 * 不能对齐的情况(块数对不上等)退回整块替换,并在统计里标出来,由界面提示用户。
 *
 * 纯函数、无 DOM 依赖:浏览器里挂在 window.MDTurnPatch,Node 里 module.exports;
 * markdown-it 实例由调用方注入(渲染器与测试都用仓库自带的 vendor 版本)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MDTurnPatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FRONT_MATTER = /^(---|\+\+\+)[ \t]*\r?\n[\s\S]*?\r?\n\1[ \t]*(?:\r?\n|$)/;
  const LIST_TYPES = new Set(['bullet_list_open', 'ordered_list_open']);

  function splitFrontMatter(text) {
    const match = String(text).match(FRONT_MATTER);
    return match ? { frontMatter: match[0], body: text.slice(match[0].length) } : { frontMatter: '', body: String(text) };
  }

  function toLF(text) { return String(text).replace(/\r\n?/g, '\n'); }
  function eolOf(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }
  function renderKey(md, text) {
    try { return md.render(text).replace(/\s+/g, ' ').trim(); } catch { return `!${text}`; }
  }

  // 把一段 Markdown 切成顶层块;每块带行范围、类型、原始文本、渲染身份。
  function parseBlocks(md, text) {
    const lines = text.split('\n');
    const tokens = md.parse(text, {});
    const blocks = [];
    for (const token of tokens) {
      if (token.level !== 0 || token.nesting < 0 || !token.map || token.type === 'inline') continue;
      const [start, end] = token.map;
      if (blocks.length && start < blocks[blocks.length - 1].end) continue;
      const raw = lines.slice(start, end).join('\n');
      blocks.push({ start, end, type: token.type, markup: token.markup, text: raw, key: renderKey(md, raw) });
    }
    return { lines, blocks };
  }

  // 最长公共子序列对齐,返回 [i, j] 配对;配对之外的"空当"里若两侧数量相等,再按位置一一配成"修改"。
  function align(leftKeys, rightKeys) {
    const n = leftKeys.length, m = rightKeys.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = leftKeys[i] === rightKeys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const same = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (leftKeys[i] === rightKeys[j]) { same.push([i, j]); i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
      else j += 1;
    }
    const modified = [];
    let prevI = -1, prevJ = -1;
    const anchors = same.concat([[n, m]]);
    for (const [ai, aj] of anchors) {
      const gapLeft = ai - prevI - 1, gapRight = aj - prevJ - 1;
      if (gapLeft > 0 && gapLeft === gapRight) {
        for (let k = 1; k <= gapLeft; k += 1) modified.push([prevI + k, prevJ + k]);
      }
      prevI = ai; prevJ = aj;
    }
    return { same, modified };
  }

  function mapOf(pairs) { const map = new Map(); for (const [a, b] of pairs) map.set(b, a); return map; }

  // ---------- 列表项级别 ----------

  const ITEM_PREFIX = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;

  function listItems(md, listText) {
    const lines = listText.split('\n');
    const tokens = md.parse(listText, {});
    const items = [];
    for (const token of tokens) {
      if (token.type !== 'list_item_open' || token.level !== 1 || !token.map) continue;
      const [start, end] = token.map;
      const raw = lines.slice(start, end).join('\n');
      const first = lines[start] || '';
      const prefixMatch = first.match(ITEM_PREFIX);
      if (!prefixMatch) return null;
      const prefix = prefixMatch[0];
      const width = prefix.length;
      const contentLines = [first.slice(width)];
      for (let index = start + 1; index < end; index += 1) {
        const line = lines[index];
        contentLines.push(line.slice(Math.min(width, line.match(/^\s*/)[0].length)));
      }
      let content = contentLines.join('\n');
      const trailingBlank = content.match(/\n*$/)[0];
      content = content.slice(0, content.length - trailingBlank.length);
      items.push({ raw, prefix, width, content, trailingBlank, key: renderKey(md, content), end });
    }
    if (!items.length) return null;
    // 列表块的 map 可能把列表后的空行也算进来(松散列表):这部分不属于任何项,原样挂在列表尾部。
    const lastEnd = items[items.length - 1].end;
    items.post = lines.length > lastEnd ? `\n${lines.slice(lastEnd).join('\n')}` : '';
    return items;
  }

  function reindent(content, width, prefix) {
    const pad = ' '.repeat(width);
    const lines = content.split('\n');
    return prefix + lines.map((line, index) => (index === 0 ? line : (line ? pad + line : line))).join('\n');
  }

  function patchList(md, oText, n0Text, n1Text, stats, depth) {
    const o = listItems(md, oText), n0 = listItems(md, n0Text), n1 = listItems(md, n1Text);
    if (!o || !n0 || !n1 || !o.length || o.length !== n0.length || n0.length !== n1.length) return null;
    const out = [];
    for (let index = 0; index < n1.length; index += 1) {
      const item = n1[index], base = n0[index], orig = o[index];
      if (item.key === base.key) { out.push(orig.raw); continue; }
      stats.itemsModified += 1;
      const inner = patchSequence(md, orig.content, base.content, item.content, stats, depth + 1);
      out.push(reindent(inner, orig.width, orig.prefix) + orig.trailingBlank);
    }
    return out.join('\n') + o.post;
  }

  // ---------- 块序列 ----------

  function patchSequence(md, oText, n0Text, n1Text, stats, depth = 0) {
    const O = parseBlocks(md, oText), N0 = parseBlocks(md, n0Text), N1 = parseBlocks(md, n1Text);
    if (!O.blocks.length) { stats.fallback += 1; return n1Text; }
    const a01 = align(N0.blocks.map((b) => b.key), N1.blocks.map((b) => b.key));
    const aO0 = align(O.blocks.map((b) => b.key), N0.blocks.map((b) => b.key));
    const untouched = mapOf(a01.same);           // N1 index -> N0 index(用户没碰)
    const modifiedPairs = mapOf(a01.modified);   // N1 index -> N0 index(用户改过)
    const n0ToO = new Map();                     // N0 index -> O index(同身份或按位置配对的"有损"块)
    for (const [oi, ni] of aO0.same) n0ToO.set(ni, oi);
    const lossy = new Set();
    for (const [oi, ni] of aO0.modified) { n0ToO.set(ni, oi); lossy.add(oi); }
    if (depth === 0) stats.lossyBlocks = lossy.size;

    const used = new Set();
    const pieces = [];
    for (let index = 0; index < N1.blocks.length; index += 1) {
      const block = N1.blocks[index];
      if (untouched.has(index)) {
        const oi = n0ToO.get(untouched.get(index));
        if (oi !== undefined) { pieces.push({ from: 'O', oi, text: O.blocks[oi].text }); used.add(oi); stats.kept += 1; continue; }
        pieces.push({ from: 'N', text: block.text }); stats.unmatched += 1;
        continue;
      }
      if (modifiedPairs.has(index)) {
        const n0Index = modifiedPairs.get(index);
        const oi = n0ToO.get(n0Index);
        if (oi !== undefined) {
          used.add(oi);
          if (lossy.has(oi)) stats.lossyTouched += 1;
          if (LIST_TYPES.has(block.type) && O.blocks[oi].type === block.type && N0.blocks[n0Index].type === block.type) {
            const patched = patchList(md, O.blocks[oi].text, N0.blocks[n0Index].text, block.text, stats, depth);
            if (patched !== null) { pieces.push({ from: 'O', oi, text: patched, modified: true }); stats.modified += 1; continue; }
            stats.listFallback += 1;
          }
          pieces.push({ from: 'O', oi, text: block.text, modified: true }); stats.modified += 1;
          continue;
        }
      }
      pieces.push({ from: 'N', text: block.text }); stats.inserted += 1;
    }
    stats.deleted += O.blocks.filter((_, oi) => !used.has(oi)).length;

    // 块与块之间的"空当" = 空行 + markdown-it 不产 token 的行(链接引用定义 `[x]: url`、脚注定义 `[^1]: …`)。
    // 定义行在编辑器里看不见,用户不可能有意删它,所以必须原样保留:
    //   - 相邻两块都来自原文且在原文里也相邻 → 整个空当逐字节沿用(空行数、定义行都不变);
    //   - 否则两块之间一个空行,但前一块后面空当里的非空行仍紧跟着它写回;
    //   - 所在块被删掉、没机会写回的定义行,最后统一补在文末(位置变了但不丢)。
    const lastIndex = O.blocks.length - 1;
    const gapLines = (oi) => O.lines.slice(O.blocks[oi].end, oi < lastIndex ? O.blocks[oi + 1].start : O.lines.length);
    const nonBlank = (lines) => lines.filter((line) => line.trim() !== '');
    const emittedGaps = new Set();
    let out = '';
    const head = O.lines.slice(0, O.blocks[0].start);
    if (pieces.length && pieces[0].from === 'O' && pieces[0].oi === 0 && head.length) {
      out += `${head.join('\n')}\n`;
    } else if (nonBlank(head).length) {
      out += `${nonBlank(head).join('\n')}\n\n`;
    }
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      const prev = index > 0 ? pieces[index - 1] : null;
      if (prev) {
        if (prev.from === 'O' && piece.from === 'O' && piece.oi === prev.oi + 1) {
          out += `\n${gapLines(prev.oi).map((line) => `${line}\n`).join('')}`;
          emittedGaps.add(prev.oi);
        } else {
          if (prev.from === 'O' && prev.oi < lastIndex && !emittedGaps.has(prev.oi)) {
            const defs = nonBlank(gapLines(prev.oi));
            if (defs.length) out += `\n\n${defs.join('\n')}`;
            emittedGaps.add(prev.oi);
          }
          out += '\n\n';
        }
      }
      out += piece.text;
    }
    const last = pieces[pieces.length - 1];
    if (last && last.from === 'O' && last.oi === lastIndex && O.lines.length > O.blocks[lastIndex].end) {
      out += `\n${O.lines.slice(O.blocks[lastIndex].end).join('\n')}`;
      emittedGaps.add(lastIndex);
    } else if (last && last.from === 'O' && last.oi < lastIndex && !emittedGaps.has(last.oi)) {
      const defs = nonBlank(gapLines(last.oi));
      if (defs.length) out += `\n\n${defs.join('\n')}`;
      emittedGaps.add(last.oi);
    }
    const leftovers = [];
    for (let oi = 0; oi <= lastIndex; oi += 1) {
      if (!emittedGaps.has(oi)) leftovers.push(...nonBlank(gapLines(oi)));
    }
    if (leftovers.length) out += `\n\n${leftovers.join('\n')}`;
    if (depth === 0 && /\n$/.test(oText) && !/\n$/.test(out)) out += '\n';
    return out;
  }

  function emptyStats() {
    return { kept: 0, modified: 0, inserted: 0, deleted: 0, unmatched: 0, lossyBlocks: 0, lossyTouched: 0, itemsModified: 0, listFallback: 0, fallback: 0 };
  }

  // 主入口。original 可带 Front Matter;normalized / current 是编辑器输出(编辑器拿到的是去掉 Front Matter 的正文)。
  function patch(md, original, normalized, current) {
    const stats = emptyStats();
    const eol = eolOf(original);
    const { frontMatter, body } = splitFrontMatter(original);
    const stripped = (text) => splitFrontMatter(toLF(text)).body;
    const oBody = toLF(body);
    const n0 = stripped(normalized == null ? current : normalized);
    const n1 = stripped(current);
    let output;
    if (n1 === n0) {
      output = oBody; // 什么都没改(含撤销到底):原文一字节不动
    } else {
      output = patchSequence(md, oBody, n0, n1, stats, 0);
    }
    const text = frontMatter + (eol === '\n' ? output : output.replace(/\n/g, eol));
    return { text, stats, changed: text !== original };
  }

  return { patch, splitFrontMatter, parseBlocks, align };
});
