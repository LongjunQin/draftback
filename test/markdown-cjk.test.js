'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const markdownit = require('../static/vendor/markdown-it.min.js');
const cjk = require('../static/markdown-cjk.js');

const md = markdownit().use(cjk);
const plain = markdownit();

test('中文标点紧挨着的加粗、斜体能正常显示', () => {
  assert.equal(md.renderInline('**设立背景。**聚变与新能源联合实验室'), '<strong>设立背景。</strong>聚变与新能源联合实验室');
  assert.equal(md.renderInline('中文**“引用”**中文'), '中文<strong>“引用”</strong>中文');
  assert.equal(md.renderInline('*斜体。*后面'), '<em>斜体。</em>后面');
  assert.equal(md.renderInline('（**Joint Lab**）实验室'), '（<strong>Joint Lab</strong>）实验室');
  assert.equal(md.renderInline('这是**加粗**文字'), '这是<strong>加粗</strong>文字');
});

test('英文等其他文字照 CommonMark 不变', () => {
  for (const source of ['foo**bar.**baz', '**Hello.**World', 'a**b**c', 'a * b * c', '**bold**, then text', 'snake_case_name', '中文_下划线_中文']) {
    assert.equal(md.renderInline(source), plain.renderInline(source), source);
  }
});
