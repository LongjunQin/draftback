'use strict';

// 导出 Word:pandoc 在机器上时真转一份(中文连行、公式、表格、图片);没有 pandoc 时只验证报错清楚。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { findPandoc, exportDocx, fixCjkEmphasis } = require('../export-docx');

test('没有 pandoc 时给出明确的 NO_PANDOC 错误', async () => {
  await assert.rejects(
    () => exportDocx({ sourcePath: '/tmp/x.md', outputPath: '/tmp/x.docx', pandoc: '/nonexistent/pandoc' }),
    (error) => /pandoc/.test(error.message),
  );
  const saved = process.env.DRAFTBACK_PANDOC;
  const savedPath = process.env.PATH;
  process.env.DRAFTBACK_PANDOC = '/nonexistent/pandoc';
  process.env.PATH = '/nonexistent';
  try {
    if (!['/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc', '/usr/bin/pandoc'].some((p) => fs.existsSync(p))) {
      assert.equal(findPandoc(), null);
      await assert.rejects(() => exportDocx({ sourcePath: '/tmp/x.md', outputPath: '/tmp/x.docx' }), (error) => error.code === 'NO_PANDOC');
    }
  } finally {
    if (saved === undefined) delete process.env.DRAFTBACK_PANDOC; else process.env.DRAFTBACK_PANDOC = saved;
    process.env.PATH = savedPath;
  }
});

test('有 pandoc 时:中文行合并、公式、表格、同目录图片都进 docx', { skip: !findPandoc() && 'pandoc 未安装' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-docx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(root, 'pic.png'), png);
  const source = path.join(root, '方案.md');
  fs.writeFileSync(source, [
    '---', 'title: 方案', '---', '',
    '# 一级标题', '',
    '中文第一行', '中文第二行应当连成一段。', '',
    '公式 $E=mc^2$ 与块级', '', '$$\\int_0^1 x\\,dx$$', '',
    '| 列 | 值 |', '|---|---|', '| 甲 | 1 |', '',
    '![图](pic.png)', '',
    '```js', 'const a = 1;', '```', '',
  ].join('\n'));
  const output = path.join(root, '方案.docx');
  const result = await exportDocx({ sourcePath: source, outputPath: output });
  assert.equal(result.ok, true);
  assert.ok(result.bytes > 2000);
  const listing = execFileSync('unzip', ['-l', output], { encoding: 'utf8' });
  assert.match(listing, /word\/document\.xml/);
  assert.match(listing, /word\/media\//, '图片应打进 docx');
  const xml = execFileSync('unzip', ['-p', output, 'word/document.xml'], { encoding: 'utf8' });
  assert.match(xml, /中文第一行中文第二行应当连成一段/, '中文换行处不得插入空格');
  assert.match(xml, /<m:oMath/, '公式应是 Word 原生公式');
  assert.match(xml, /<w:tbl>/, '表格应是 Word 表格');
  assert.match(xml, /SourceCode/, '代码块应是代码样式');
  assert.match(xml, />const</);
});

test('中文旁的加粗:标点挪到星号外面,pandoc 才认得;英文、代码不动', () => {
  assert.equal(fixCjkEmphasis('**设立背景。**聚变与新能源联合实验室'), '**设立背景**。聚变与新能源联合实验室');
  assert.equal(fixCjkEmphasis('中文**“引用”**中文'), '中文“**引用**”中文');
  assert.equal(fixCjkEmphasis('普通**加粗**文字'), '普通**加粗**文字');
  assert.equal(fixCjkEmphasis('英文 foo**bar.**baz'), '英文 foo**bar.**baz');
  assert.equal(fixCjkEmphasis('代码 `a**b。**c` 不动'), '代码 `a**b。**c` 不动');
  assert.equal(fixCjkEmphasis('```\n**设立。**x\n```'), '```\n**设立。**x\n```');
});

test('有 pandoc 时:「**设立背景。**聚变」在 Word 里是加粗,没有星号,原文不变', { skip: !findPandoc() && 'pandoc 未安装' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-docx-cjk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, '建议书.md');
  const text = '**设立背景。**聚变与新能源联合实验室。\n\n**定位。**联合实验室是一个平台,普通**加粗**也行。\n';
  fs.writeFileSync(source, text);
  const output = path.join(root, '建议书.docx');
  await exportDocx({ sourcePath: source, outputPath: output });
  const xml = execFileSync('unzip', ['-p', output, 'word/document.xml'], { encoding: 'utf8' });
  assert.doesNotMatch(xml, /\*\*/, 'Word 里不应留下星号');
  assert.match(xml, /<w:b \/>[\s\S]*?设立背景/, '「设立背景」应加粗');
  assert.equal(fs.readFileSync(source, 'utf8'), text, '原文不动');
});
