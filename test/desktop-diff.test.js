'use strict';

// 轮次对比(版本记录设计 v4 第 8 节、第 12 节第 9 项):新增一句、删一句、改一个数字、整段删除、表格单元格修改、
// 改引用链接 URL、改代码缩进各自标对;公式 / Mermaid 退化为源码差异;300 章样本首次 ≤ 300 ms;切块覆盖全部源文。

const test = require('node:test');
const assert = require('node:assert/strict');
const markdownit = require('../static/vendor/markdown-it.min.js');
const DiffMatchPatch = require('../static/vendor/diff-match-patch.js');
const Diff = require('../static/desktop-diff.js');

const md = markdownit({ html: true, linkify: true });
const dmp = new DiffMatchPatch();
const run = (a, b) => Diff.diffDocuments(md, dmp, a, b);
const changeItems = (result) => result.hunks.filter((h) => h.kind === 'change').flatMap((h) => h.items);
const joined = (blocks) => blocks.map((b) => b.text).join('\n');

const BASE = [
  '---', 'title: 对比小样', '---',
  '# 第一章', '',
  '第一段讲苹果。第二句讲香蕉。', '',
  '第二段里有 12 个数字。', '',
  '要删掉的整段。', '',
  '| 列 | 值 |', '|---|---|', '| 苹果 | 1 |', '| 香蕉 | 2 |', '',
  '```js', 'function a() {', 'return 1;', '}', '```', '',
  '看[文档][doc]。', '',
  '[doc]: https://old.example/x', '',
  '```mermaid', 'graph TD; A-->B;', '```', '',
].join('\n');

test('切块覆盖全部源文:拼回去逐字节相等(含 Front Matter、CRLF、无结尾换行、只有 Front Matter)', () => {
  for (const text of [BASE, BASE.replace(/\n/g, '\r\n'), BASE.trimEnd(), '---\na: 1\n---', '---\na: 1\n---\n', '', '只有一行', '\n\n\n']) {
    const blocks = Diff.splitBlocks(md, text);
    assert.equal(joined(blocks), text);
  }
  const blocks = Diff.splitBlocks(md, BASE);
  assert.equal(blocks[0].kind, 'frontmatter');
  assert.ok(blocks.some((b) => b.type === 'reference' && b.text.startsWith('[doc]:')), '引用链接定义是独立的块');
  assert.ok(blocks.some((b) => b.type === 'table'));
  assert.ok(blocks.some((b) => b.type === 'fence'));
});

test('新增一句、删一句、改一个数字:同一段落的替换带字级对比', () => {
  const added = run(BASE, BASE.replace('第二句讲香蕉。', '第二句讲香蕉。第三句讲樱桃。'));
  assert.equal(added.changes, 1);
  const [item] = changeItems(added);
  assert.equal(item.kind, 'replace');
  assert.deepEqual(item.inline.filter((d) => d[0] !== 0), [[1, '第三句讲樱桃。']]);

  const removed = run(BASE, BASE.replace('第二句讲香蕉。', ''));
  assert.deepEqual(changeItems(removed)[0].inline.filter((d) => d[0] !== 0), [[-1, '第二句讲香蕉。']]);

  const number = run(BASE, BASE.replace('12 个数字', '13 个数字'));
  const ops = changeItems(number)[0].inline.filter((d) => d[0] !== 0);
  assert.deepEqual(ops, [[-1, '2'], [1, '3']]);
  assert.equal(number.stats.replaced, 1);
});

test('整段删除是一个删除项;新增一段是一个新增项;段落移动显示为删旧加新', () => {
  const deleted = run(BASE, BASE.replace('要删掉的整段。\n\n', ''));
  assert.equal(deleted.changes, 1);
  assert.deepEqual(changeItems(deleted).map((i) => i.kind), ['delete']);
  assert.equal(changeItems(deleted)[0].oldText, '要删掉的整段。');

  const inserted = run(BASE, BASE.replace('要删掉的整段。', '要删掉的整段。\n\n新加的一段,和前面毫无关系。'));
  assert.deepEqual(changeItems(inserted).map((i) => i.kind), ['insert']);

  const moved = run(BASE, BASE.replace('要删掉的整段。\n\n', '').replace('# 第一章\n\n', '# 第一章\n\n要删掉的整段。\n\n'));
  const kinds = changeItems(moved).map((i) => i.kind);
  assert.ok(kinds.includes('insert') && kinds.includes('delete'), `移动 = 删旧加新: ${kinds}`);
  assert.equal(moved.stats.replaced, 0);
});

test('表格:改单元格按字级标在格子上;加一行则整表删旧加新', () => {
  const cell = run(BASE, BASE.replace('| 香蕉 | 2 |', '| 香蕉 | 5 |'));
  const [item] = changeItems(cell);
  assert.equal(item.type, 'table');
  assert.deepEqual(item.inline.filter((d) => d[0] !== 0), [[-1, '2'], [1, '5']]);

  const row = run(BASE, BASE.replace('| 香蕉 | 2 |', '| 香蕉 | 2 |\n| 樱桃 | 3 |'));
  const [tableItem] = changeItems(row);
  assert.equal(tableItem.kind, 'replace');
  assert.equal(tableItem.inline, null, '行数变了:不做字级,显示旧表、新表');
});

test('改引用链接 URL、改代码缩进各自标对;Mermaid 退化为源码逐行差异', () => {
  const link = run(BASE, BASE.replace('https://old.example/x', 'https://new.example/y'));
  assert.equal(link.changes, 1);
  const [item] = changeItems(link);
  assert.equal(item.type, 'reference');
  assert.ok(item.inline.some((d) => d[0] === 1 && d[1].includes('new')));

  const indent = run(BASE, BASE.replace('return 1;', '  return 1;'));
  const [code] = changeItems(indent);
  assert.equal(code.type, 'fence');
  assert.equal(code.source, true);
  assert.deepEqual(code.inline.filter((d) => d[0] !== 0), [[-1, 'return 1;\n'], [1, '  return 1;\n']], '代码按行比较,空白保留');

  const mermaid = run(BASE, BASE.replace('A-->B;', 'A-->C;'));
  const [graph] = changeItems(mermaid);
  assert.equal(graph.type, 'fence');
  assert.equal(graph.source, true);
  assert.ok(graph.inline.some((d) => d[0] === 1 && d[1] === 'graph TD; A-->C;\n'));
});

test('只改空行数不算改动;原文与完成稿相同没有改动;超长块整块替换', () => {
  assert.equal(run(BASE, BASE.replace('第一段讲苹果。第二句讲香蕉。\n\n', '第一段讲苹果。第二句讲香蕉。\n\n\n\n')).changes, 0);
  assert.equal(run(BASE, BASE).changes, 0);
  const big = 'x'.repeat(Diff.INLINE_CHAR_LIMIT + 1);
  const result = run(`${big}\n`, `${big}y\n`);
  assert.equal(changeItems(result)[0].kind, 'replace');
  assert.equal(changeItems(result)[0].inline, null);
});

test('300 章样本:首次计算 ≤ 300 ms,改动数与实际一致(超上限走锚点分段)', () => {
  const chapters = [];
  for (let c = 1; c <= 300; c += 1) {
    chapters.push(`## 第 ${c} 章 标题`, '');
    for (let p = 1; p <= 6; p += 1) chapters.push(`第 ${c} 章第 ${p} 段:这是一段足够长的正文,用来模拟真实书稿的段落长度,里面有数字 ${c * p} 和一些标点,句子重复两遍。这是一段足够长的正文,用来模拟真实书稿的段落长度。`, '');
    chapters.push('- 要点一', '- 要点二', '- 要点三', '');
  }
  const original = chapters.join('\n');
  let edited = original;
  const touched = [7, 42, 99, 150, 151, 199, 240, 280, 299, 300];
  for (const c of touched) edited = edited.replace(`第 ${c} 章第 3 段:这是`, `第 ${c} 章第 3 段:改过的`);
  edited = edited.replace('## 第 120 章 标题\n\n', '## 第 120 章 标题\n\n新增的开场白。\n\n');
  const blocks = Diff.splitBlocks(md, original).length;
  assert.ok(blocks * blocks > Diff.LCS_CELL_LIMIT, `样本要超过 LCS 上限才能验证分段:${blocks} 块`);
  const result = run(original, edited);
  assert.equal(result.changes, touched.length + 1, `改动数 ${result.changes}`);
  assert.equal(result.stats.replaced, touched.length);
  assert.equal(result.stats.inserted, 1);
  assert.ok(result.ms <= 300, `首次计算 ${result.ms.toFixed(0)} ms`);
});

test('Codex 审查修补:代码块尾部空白是内容;表格加列整表删旧加新;表情代理对不拆;无锚点退化不把未改块报成替换', () => {
  // 1. 未闭合围栏的末尾空白行
  const ws = run('```\na\n \n', '```\na\n\t\n');
  assert.equal(ws.changes, 1, '代码块里空白行从空格改成制表符是改动');
  assert.equal(run('```\na\n \n', '```\na\n').changes, 1, '删掉代码块末尾空行是改动');
  // 9. 行数相同但加了一列
  const table = run('| a | b |\n|---|---|\n| 1 | 2 |\n', '| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n');
  assert.equal(changeItems(table)[0].inline, null, '列数变了不做字级,显示旧表、新表');
  assert.equal(Diff.sameTableShape('| a \\| x | `b|c` |\n|---|---|', '| a | b |\n|---|---|'), true, '转义竖线与代码跨度里的竖线不算分隔符');
  // 13. 代理对
  const emoji = run('状态😀很好。\n', '状态😁很好。\n');
  const ops = changeItems(emoji)[0].inline;
  for (const [, text] of ops) assert.doesNotMatch(text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/, `不能拆开代理对: ${JSON.stringify(text)}`);
  assert.deepEqual(ops.filter((d) => d[0] !== 0), [[-1, '😀'], [1, '😁']]);
  // 12. 2001 个相同段落中间插入一段:只有一处新增,没有 oldText === newText 的替换
  const same = Array.from({ length: 2001 }, () => '同一段。').join('\n\n') + '\n';
  const parts = same.split('\n\n');
  parts.splice(1000, 0, '插进来的一段。');
  const inserted = run(same, parts.join('\n\n'));
  assert.equal(inserted.stats.inserted, 1);
  assert.equal(inserted.stats.replaced, 0, `未改块不能报成替换: ${JSON.stringify(inserted.stats)}`);
  assert.ok(changeItems(inserted).every((i) => i.oldText !== i.newText));
});

test('Codex 审查修补:超大块不做相似度配对(预算),直接按位置配,耗时可控', () => {
  const big = (ch) => Array.from({ length: 40 }, (_, i) => `${ch.repeat(50_000)}${i}`).join('\n\n') + '\n';
  const result = run(big('x'), big('y'));
  assert.equal(result.stats.replaced, 40);
  assert.ok(result.ms < 500, `超上限退化路径耗时 ${result.ms.toFixed(0)} ms`);
});
