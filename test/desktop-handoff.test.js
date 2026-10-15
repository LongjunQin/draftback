'use strict';

// 状态区与主按钮的逻辑(电脑版规划 v3 规则①②④):七种状态各显示什么、主按钮叫什么、什么时候出「复制改稿指令」。

const test = require('node:test');
const assert = require('node:assert/strict');
const Handoff = require('../static/desktop-handoff');

test('状态表:稿子在谁手里只有这几种,主按钮随之变化', () => {
  const plain = Handoff.describe({ plain: true, mode: 'read', review: { status: 'plain' } });
  assert.equal(plain.text, '普通阅读');
  assert.equal(plain.primary.hidden, true, '普通文档没有主按钮:划词批注即开轮');

  const reviewing = Handoff.describe({ review: { status: 'reviewing' }, openCount: 3 });
  assert.equal(reviewing.text, '批注中 · 3 条');
  assert.equal(reviewing.primary.label, '交给 AI · 3', '主按钮带未交条数(UI 方案 3.3)');
  assert.equal(reviewing.primary.icon, 'ph-sparkle');
  assert.equal(reviewing.primary.action, 'submit');
  const empty = Handoff.describe({ review: { status: 'reviewing' }, openCount: 0 });
  assert.equal(empty.primary.label, '通过 · 定稿');
  assert.equal(empty.primary.action, 'approve');

  const nobody = Handoff.describe({ review: { status: 'ready_to_apply', agentState: 'none' } });
  assert.equal(nobody.status, 'submitted');
  assert.match(nobody.text, /还没有 AI 接入/);
  assert.equal(nobody.primary.label, '复制改稿指令');
  assert.equal(nobody.secondary.label, '我自己改');

  const now = Date.now();
  const listening = Handoff.describe({ now, review: { status: 'ready_to_apply', agentState: 'listening', agent: { listening: true, agent: 'Claude Code' }, submittedAt: new Date(now - 60_000).toISOString() } });
  assert.equal(listening.status, 'listening');
  assert.match(listening.text, /Claude Code 在线,等待领取/);
  assert.equal(listening.primary.hidden, true, '刚交出、有人在听:不催');
  const staleListening = Handoff.describe({ now, review: { status: 'ready_to_apply', agentState: 'listening', agent: { listening: true, agent: 'Codex' }, submittedAt: new Date(now - 11 * 60_000).toISOString() } });
  assert.equal(staleListening.primary.label, '重新复制指令', '在听却超过 10 分钟没领取:让用户重新贴指令');

  const claimed = Handoff.describe({ review: { status: 'ready_to_apply', agentState: 'claimed', claimedBy: 'Codex' } });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.text, 'AI 正在修改…');
  assert.equal(claimed.primary.hidden, false, 'AI 在改时主按钮位置不空着');
  assert.equal(claimed.primary.disabled, true);
  assert.equal(claimed.primary.label, '改稿中…');
  assert.equal(claimed.secondary.hidden, true, '领取后不再提供「我自己改」');

  const applying = Handoff.describe({ review: { status: 'applying', applyMode: 'agent', applyActor: 'Claude Code' } });
  assert.equal(applying.text, 'AI 正在修改…');
  assert.match(applying.detail, /文档暂时只读/);
  const manual = Handoff.describe({ review: { status: 'applying', applyMode: 'manual' } });
  assert.equal(manual.primary.label, '提交修改');

  const back = Handoff.describe({ review: { status: 'complete' } });
  assert.match(back.text, /稿子回来了/);
  assert.equal(back.primary.label, '通过 · 定稿');
  assert.equal(back.primary.action, 'finalize');
  assert.equal(Handoff.describe({ review: { status: 'complete', outcome: 'finalized' } }).text, '已定稿');
  assert.equal(Handoff.describe({ review: { status: 'complete' }, editedSinceReturn: true }).text, '稿子回来了 · 已在最新版上编辑过', '回稿后又改过要说清楚');
  assert.equal(Handoff.describe({ review: { status: 'complete', outcome: 'finalized', finalizedAt: '2026-10-14T08:00:00Z' } }).text, '已定稿 · 10 月 14 日');
  assert.equal(Handoff.describe({ review: { status: 'complete', outcome: 'approved' } }).primary.action, 'finalize');
  assert.match(Handoff.describe({ review: { status: 'conflict' } }).text, /外面被改/);
  const conflict = Handoff.describe({ review: { status: 'conflict' } });
  assert.equal(conflict.primary.label, '处理…', '冲突时主按钮给两条路的入口');
  assert.equal(conflict.primary.action, 'resolve-conflict');
  assert.equal(Handoff.describe({ review: { status: 'cancelled' } }).text, '本轮已作废');

  const readOnly = Handoff.describe({ plain: true, mode: 'read', review: {}, readOnly: true, encoding: 'gbk' });
  assert.match(readOnly.text, /GBK 只读$/);
});

test('短标签与改稿指令', () => {
  assert.equal(Handoff.statusLabel('reviewing'), '批注中');
  assert.equal(Handoff.statusLabel('ready_to_apply'), '已交出');
  assert.equal(Handoff.statusLabel('applying', 'agent'), 'AI 修改中');
  assert.equal(Handoff.statusLabel('complete', '', 'finalized'), '已定稿');
  const text = Handoff.instructionText({ absPath: '/tmp/方案.md', cliScript: '/app/mdreview.js' });
  assert.match(text, /mdreview claim "\/tmp\/方案\.md"/);
  assert.match(text, /begin-apply/);
  assert.match(text, /complete .*--summary/);
  assert.match(text, /mdreview wait/);
  assert.match(text, /node "\/app\/mdreview\.js"/);
});
