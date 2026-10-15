'use strict';

// 左栏「稿件」按轮到谁分组(UI 方案 v2 第 3.2 节):四组的归属、行内副标题、未读蓝点、组内排序、最近打开最多 20 条。

const test = require('node:test');
const assert = require('node:assert/strict');
const Drafts = require('../static/desktop-drafts');

const NOW = Date.parse('2026-10-15T10:00:00+08:00');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const item = (file, latest, extra = {}) => ({ absPath: `/d/${file}`, file, exists: true, lastOpenedAt: at(30), latest, ...extra });

test('四组归属与行内副标题', () => {
  const items = [
    item('批注中.md', { id: 'a', status: 'reviewing', round: 3, openCount: 1, activityAt: at(5) }),
    item('回稿.md', { id: 'b', status: 'complete', round: 2, applied: 2, wontfix: 1, unread: true, activityAt: at(1) }),
    item('通过.md', { id: 'c', status: 'complete', outcome: 'approved', round: 1, activityAt: at(50) }),
    item('冲突.md', { id: 'd', status: 'conflict', round: 1, activityAt: at(2) }),
    item('没人接.md', { id: 'e', status: 'ready_to_apply', agentState: 'none', round: 1, activityAt: at(3) }),
    item('在线.md', { id: 'f', status: 'ready_to_apply', agentState: 'listening', round: 1, activityAt: at(4) }),
    item('AI改.md', { id: 'g', status: 'applying', applyMode: 'agent', round: 1, activityAt: at(2) }),
    item('我改.md', { id: 'h', status: 'applying', applyMode: 'manual', round: 1, openCount: 2, activityAt: at(6) }),
    item('定稿.md', { id: 'i', status: 'complete', outcome: 'finalized', round: 4, activityAt: at(100) }),
    item('作废.md', { id: 'j', status: 'cancelled', round: 1, activityAt: at(200) }),
    item('普通.md', null),
    item('编辑中.md', null, { editing: true }),
    item('不在了.md', null, { exists: false }),
  ];
  const groups = Drafts.groupDrafts(items, NOW);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.rows.map((r) => r.item.file)]));
  assert.deepEqual(groups.map((g) => g.label), ['轮到你', '已交出', '我在改', '最近打开']);
  assert.deepEqual(byKey.yours, ['回稿.md', '冲突.md', '批注中.md', '通过.md'], '按最后活动时间排');
  assert.deepEqual(byKey.handed, ['AI改.md', '没人接.md', '在线.md']);
  assert.deepEqual(byKey.mine, ['我改.md', '编辑中.md']);
  assert.deepEqual(new Set(byKey.recent), new Set(['定稿.md', '作废.md', '普通.md', '不在了.md']));
  const row = (file) => groups.flatMap((g) => g.rows).find((r) => r.item.file === file);
  assert.equal(row('批注中.md').subtitle, '第 3 轮 · 1 条未交 · 5 分钟前');
  assert.equal(row('回稿.md').subtitle, '第 2 轮回稿 · 采纳 2 · 未采纳 1');
  assert.equal(row('回稿.md').unread, true);
  assert.equal(row('回稿.md').dot, 'back');
  assert.equal(row('冲突.md').dot, 'conflict');
  assert.equal(row('没人接.md').subtitle, '已交出 · 还没有 AI 接入 · 3 分钟前');
  assert.equal(row('在线.md').subtitle, '已交出 · AI 在线,等待领取');
  assert.match(row('AI改.md').subtitle, /^AI 正在修改 · 2 分钟$/);
  assert.equal(row('AI改.md').dot, 'ai');
  assert.equal(row('我改.md').subtitle, '我自己改 · 剩 2 条');
  assert.equal(row('不在了.md').subtitle, '文件已不存在');
});

test('最近打开最多 20 条;欢迎页先列轮到你与已交出', () => {
  const many = Array.from({ length: 30 }, (_, i) => item(`普通${i}.md`, null, { lastOpenedAt: at(i) }));
  const recent = Drafts.groupDrafts(many, NOW).find((g) => g.key === 'recent');
  assert.equal(recent.rows.length, 20);
  assert.equal(recent.rows[0].item.file, '普通0.md', '最近打开按打开时间倒序');
  const welcome = Drafts.welcomeRows([...many, item('回稿.md', { status: 'complete', round: 1, activityAt: at(1) })], NOW);
  assert.equal(welcome[0].item.file, '回稿.md');
  assert.equal(Drafts.welcomeRows(many.slice(0, 3), NOW).length, 3, '没有轮到你的稿件时列最近打开');
});
