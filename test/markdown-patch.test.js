'use strict';

// 块级局部回写的三个小样(路线图 v3 第 6.2 节)+ 若干边界。
// 规范化基线 n0 模拟 Milkdown 的改写:列表符 * → -、缩进 4 → 2、强调 * → _、硬换行两空格 → 反斜杠、
// 原始 HTML 被转义、公式美元号被转义。只要用户没碰的块,输出必须与原文字节一致。

const test = require('node:test');
const assert = require('node:assert/strict');
const markdownit = require('../static/vendor/markdown-it.min.js');
const Patch = require('../static/markdown-patch.js');

const md = markdownit({ html: true, linkify: true });
const run = (original, normalized, current) => Patch.patch(md, original, normalized, current);

const ORIGINAL = [
  '---',
  'title: 小样一',
  'tags: [a, b]',
  '---',
  '# 标题',
  '',
  '第一段有*强调*和尾随两空格硬换行  ',
  '第二行。',
  '',
  '',
  '<div class="callout">原始 <b>HTML</b> 块</div>',
  '',
  '行内公式 $E=mc^2$ 与块公式:',
  '',
  '$$',
  '\\int_0^1 x\\,dx',
  '$$',
  '',
  '\t制表符开头的段落　全角空格结尾　',
  '',
  '最后一段。',
  '',
].join('\n');

// 编辑器对原文的规范化(未做修改):Front Matter 已由调用方剥离。
const NORMALIZED = [
  '# 标题',
  '',
  '第一段有_强调_和尾随两空格硬换行\\',
  '第二行。',
  '',
  '&#x3C;div class="callout">原始 **HTML** 块&#x3C;/div>',
  '',
  '行内公式 \\$E=mc^2\\$ 与块公式:',
  '',
  '\\$\\$',
  '\\int\\_0^1 x\\,dx',
  '\\$\\$',
  '',
  '制表符开头的段落 全角空格结尾',
  '',
  '最后一段。',
  '',
].join('\n');

test('小样①:只改一个字,Front Matter、HTML、公式、特殊空白所在的块字节一致', () => {
  const current = NORMALIZED.replace('最后一段。', '最后一段改了。');
  const result = run(ORIGINAL, NORMALIZED, current);
  assert.equal(result.text, ORIGINAL.replace('最后一段。', '最后一段改了。'));
  assert.equal(result.stats.modified, 1);
  assert.equal(result.stats.inserted + result.stats.deleted + result.stats.fallback, 0);
  assert.ok(result.stats.lossyBlocks >= 3, '编辑器改写了 HTML、公式等块,应被识别为有损块');
  assert.equal(result.stats.lossyTouched, 0);
});

test('小样①补:改的是有损块本身(HTML 块)时,只有该块换成编辑器文本,并计入 lossyTouched', () => {
  const current = NORMALIZED.replace('原始 **HTML** 块', '原始 **HTML** 块改了');
  const result = run(ORIGINAL, NORMALIZED, current);
  const expected = ORIGINAL.replace('<div class="callout">原始 <b>HTML</b> 块</div>', '&#x3C;div class="callout">原始 **HTML** 块改了&#x3C;/div>');
  assert.equal(result.text, expected);
  assert.equal(result.stats.lossyTouched, 1);
});

const LIST_ORIGINAL = [
  '# 清单',
  '',
  '1. 第一项',
  '',
  '3. 第三项(编号故意跳号)',
  '    * 子项甲',
  '    * 子项乙',
  '',
  '      子项乙的续行段落',
  '    * 子项丙',
  '7. 第七项',
  '',
  '尾段。',
  '',
].join('\n');

const LIST_NORMALIZED = [
  '# 清单',
  '',
  '1. 第一项',
  '',
  '2. 第三项(编号故意跳号)',
  '   - 子项甲',
  '   - 子项乙',
  '',
  '     子项乙的续行段落',
  '   - 子项丙',
  '3. 第七项',
  '',
  '尾段。',
  '',
].join('\n');

test('小样②:嵌套列表内改文字,未受影响的编号、缩进、空行、续行原样保留', () => {
  const current = LIST_NORMALIZED.replace('子项乙的续行段落', '子项乙的续行段落改了');
  const result = run(LIST_ORIGINAL, LIST_NORMALIZED, current);
  assert.equal(result.text, LIST_ORIGINAL.replace('子项乙的续行段落', '子项乙的续行段落改了'));
  assert.equal(result.stats.itemsModified, 2, '外层第二项与内层第二项各计一次');
  assert.equal(result.stats.listFallback, 0);
});

test('小样②补:改外层项首行文字,其余项字节一致;增删项时整列表退回编辑器文本并标记', () => {
  const current = LIST_NORMALIZED.replace('第七项', '第七项改了');
  const result = run(LIST_ORIGINAL, LIST_NORMALIZED, current);
  assert.equal(result.text, LIST_ORIGINAL.replace('第七项', '第七项改了'));

  const added = LIST_NORMALIZED.replace('3. 第七项', '3. 第七项\n4. 新增第八项');
  const fallback = run(LIST_ORIGINAL, LIST_NORMALIZED, added);
  assert.equal(fallback.stats.listFallback, 1);
  assert.match(fallback.text, /新增第八项/);
  assert.match(fallback.text, /^# 清单\n\n/, '列表之外的块不受影响');
  assert.match(fallback.text, /\n\n尾段。\n$/);
});

const DUP_ORIGINAL = ['开头。', '', '重复的段落。', '', '重复的段落。', '', '结尾。', ''].join('\n');

test('小样③:拆段、合段、跨块修改与撤销;相同文本的段落不会回写到错误位置', () => {
  // 拆段:第二块拆成两块。
  const split = DUP_ORIGINAL.replace('重复的段落。\n\n重复的段落。', '重复的段落。\n\n新插入的一段。\n\n重复的段落。');
  const splitResult = run(DUP_ORIGINAL, DUP_ORIGINAL, split);
  assert.equal(splitResult.text, split);
  assert.equal(splitResult.stats.inserted, 1);

  // 合段:把结尾并进前一段。
  const merged = ['开头。', '', '重复的段落。', '', '重复的段落。结尾。', ''].join('\n');
  const mergedResult = run(DUP_ORIGINAL, DUP_ORIGINAL, merged);
  assert.equal(mergedResult.text, merged);
  assert.equal(mergedResult.stats.kept, 2);

  // 跨块修改:同时改第一段与最后一段。
  const cross = DUP_ORIGINAL.replace('开头。', '开头改。').replace('结尾。', '结尾改。');
  const crossResult = run(DUP_ORIGINAL, DUP_ORIGINAL, cross);
  assert.equal(crossResult.text, cross);
  assert.equal(crossResult.stats.modified, 2);
  assert.equal(crossResult.stats.kept, 2);

  // 只改第二个"重复的段落",第一个不动;只改第一个,第二个不动。
  const second = ['开头。', '', '重复的段落。', '', '重复的段落(改)。', '', '结尾。', ''].join('\n');
  assert.equal(run(DUP_ORIGINAL, DUP_ORIGINAL, second).text, second);
  const first = ['开头。', '', '重复的段落(改)。', '', '重复的段落。', '', '结尾。', ''].join('\n');
  assert.equal(run(DUP_ORIGINAL, DUP_ORIGINAL, first).text, first);

  // 撤销到底:编辑器内容回到基线 → 输出与原文字节一致,即使基线与原文格式不同。
  const styled = DUP_ORIGINAL.replace('开头。', '**开头。**');
  const undo = run(styled, DUP_ORIGINAL.replace('开头。', '__开头。__'), DUP_ORIGINAL.replace('开头。', '__开头。__'));
  assert.equal(undo.text, styled);
  assert.equal(undo.changed, false);
});

test('边界:CRLF 行尾、无结尾换行、删除块、首尾空行都按原文保留', () => {
  const crlf = '# 甲\r\n\r\n段一\r\n\r\n段二\r\n';
  const crlfResult = run(crlf, '# 甲\n\n段一\n\n段二\n', '# 甲\n\n段一改\n\n段二\n');
  assert.equal(crlfResult.text, '# 甲\r\n\r\n段一改\r\n\r\n段二\r\n');

  const noTrailing = '段一\n\n段二';
  assert.equal(run(noTrailing, noTrailing + '\n', '段一\n\n段二改\n').text, '段一\n\n段二改');

  const deleted = run('段一\n\n段二\n\n段三\n', '段一\n\n段二\n\n段三\n', '段一\n\n段三\n');
  assert.equal(deleted.text, '段一\n\n段三\n');
  assert.equal(deleted.stats.deleted, 1);

  const padded = '\n\n段一\n\n段二\n\n\n';
  assert.equal(run(padded, '段一\n\n段二\n', '段一\n\n段二\n').changed, false);
  assert.equal(run(padded, '段一\n\n段二\n', '段一改\n\n段二\n').text, '\n\n段一改\n\n段二\n\n\n');
});
