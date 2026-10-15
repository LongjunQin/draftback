/*
 * 稿子在谁手里(电脑版规划 v3 第 4.1 节规则①②④):状态区文案、主按钮与次按钮、「复制改稿指令」。
 * 纯逻辑,不碰 DOM(除了复制到剪贴板),Node 里可直接测;desktop.js 的 renderStatus / handlePrimaryAction 只负责照它画。
 * 新功能一律新开模块,不再往 desktop.js 里加(规划 v3 第 3 节)。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DraftbackHandoff = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  'use strict';

  const STALE_LISTENING_MS = 10 * 60 * 1000; // 有程序在听却迟迟没领取,提示重新复制指令
  const HIDDEN = Object.freeze({ hidden: true, label: '', action: '' });
  // AI 在改时主按钮的位置不空着:一个不能点的「改稿中…」(UI 方案 3.3),位置不跳
  const BUSY = Object.freeze({ hidden: false, disabled: true, label: '改稿中…', action: 'busy', title: 'AI 改完稿子会自己回来', icon: 'ph-sparkle' });
  function dateText(value) {
    const t = Date.parse(value || '');
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  function button(label, action, extra = {}) {
    return { hidden: false, disabled: false, label, action, title: '', ...extra };
  }

  /**
   * 输入:{ review, plain, mode, openCount, readOnly, encoding, remotePending, now }
   * 输出:{ status, text, detail, icon, primary, secondary }
   *   status 是给样式用的键(plain / reviewing / submitted / listening / claimed / applying / manual / complete / approved / finalized / conflict / cancelled)
   */
  function describe(input = {}) {
    const review = input.review || {};
    const count = Number(input.openCount) || 0;
    const now = Number(input.now) || Date.now();
    let view;
    if (input.plain) {
      view = input.mode === 'edit'
        ? { status: 'plain', text: '编辑中 · 直接保存到文件', detail: '保存前会核对文件是否被别的程序改过;编辑期间智能体不会冻结这篇文档。', icon: 'ph-pencil-simple-line', primary: HIDDEN, secondary: HIDDEN }
        : { status: 'plain', text: '普通阅读', detail: '划词写下第一条批注,就开始第 1 轮审阅并锁定原文;批注会交给 AI。', icon: 'ph-book-open', primary: HIDDEN, secondary: HIDDEN };
    } else if (review.status === 'reviewing') {
      view = {
        status: 'reviewing',
        text: `批注中 · ${count} 条`,
        detail: '原文已锁定。划词批注,批完点「交给 AI」(⌘↩);一条都没有就「通过 · 定稿」。',
        icon: 'ph-lock-key',
        primary: count > 0
          ? button(`交给 AI · ${count}`, 'submit', { title: `交出本轮 ${count} 条批注(⌘↩)`, icon: 'ph-sparkle' })
          : button('通过 · 定稿', 'approve', { title: '没有批注:记为通过并定稿,告诉 AI 这篇结束了', icon: 'ph-check-circle' }),
        secondary: HIDDEN,
      };
    } else if (review.status === 'ready_to_apply') {
      const agentState = review.agentState || 'none';
      const agent = (review.agent && review.agent.agent) || 'AI';
      const submittedAt = Date.parse(review.submittedAt || 0);
      const stale = Number.isFinite(submittedAt) && now - submittedAt > STALE_LISTENING_MS;
      if (agentState === 'claimed') {
        view = { status: 'claimed', text: 'AI 正在修改…', detail: `${review.claimedBy || agent} 已领取这一轮,改完会自动刷新;期间不能批注。`, icon: 'ph-robot', primary: BUSY, secondary: HIDDEN };
      } else if (agentState === 'listening') {
        view = {
          status: 'listening',
          text: `已交出 · ${agent} 在线,等待领取`,
          detail: stale ? 'AI 在线但还没开始,可以重新复制改稿指令贴给它。' : 'AI 收到后会领取并开始修改;超过 10 分钟没动静可以重新复制指令。',
          icon: 'ph-broadcast',
          primary: stale ? button('重新复制指令', 'copy-instruction', { title: 'AI 在线但还没开始,把改稿指令再贴给它', icon: 'ph-copy' }) : HIDDEN,
          secondary: button('我自己改', 'manual-edit', { title: '不等 AI,自己逐条处理批注', icon: 'ph-pencil-simple-line' }),
        };
      } else {
        view = {
          status: 'submitted',
          text: '已交出 · 还没有 AI 接入',
          detail: '没有程序在等这篇稿子。点「复制改稿指令」,贴给任何智能体(Claude Code、Codex…)就能接上。',
          icon: 'ph-paper-plane-tilt',
          primary: button('复制改稿指令', 'copy-instruction', { title: '把文件路径和要执行的命令复制到剪贴板', icon: 'ph-copy' }),
          secondary: button('我自己改', 'manual-edit', { title: '不交给 AI,自己逐条处理批注', icon: 'ph-pencil-simple-line' }),
        };
      }
    } else if (review.status === 'applying') {
      if (review.applyMode === 'manual') {
        view = review.round === 'manual-edit'
          ? { status: 'manual', text: '我自己改 · 改完点「提交修改」', detail: '这轮没有批注,你直接改;提交后本轮结束。期间智能体不会碰这篇文档。', icon: 'ph-pencil-simple-line', primary: button('提交修改', 'finish-manual', { icon: 'ph-check' }), secondary: HIDDEN }
          : { status: 'manual', text: '我自己改 · 逐条处理批注', detail: '所有未处理批注清零后才能提交。', icon: 'ph-pencil-simple-line', primary: button('提交修改', 'finish-manual', { icon: 'ph-check' }), secondary: HIDDEN };
      } else {
        view = { status: 'applying', text: 'AI 正在修改…', detail: `${review.applyActor || 'AI'} 正在按批注改稿,文档暂时只读,改完会自动刷新。`, icon: 'ph-robot', primary: BUSY, secondary: HIDDEN };
      }
    } else if (review.status === 'complete') {
      if (review.outcome === 'finalized') {
        const date = dateText(review.finalizedAt || review.completedAt);
        view = { status: 'finalized', text: date ? `已定稿 · ${date}` : '已定稿', detail: '这篇已结束。再划词批注会开始新一轮。', icon: 'ph-check-circle', primary: HIDDEN, secondary: HIDDEN };
      } else if (review.outcome === 'restored') {
        const round = review.restoredFrom && review.restoredFrom.round;
        view = { status: 'restored', text: `已恢复到第 ${round || '?'} 轮改稿前`, detail: '正文已换回那一轮改稿前的样子;恢复前的稿子留在历史里,可以再恢复回来。再划词批注会开始新一轮。', icon: 'ph-clock-counter-clockwise', primary: button('通过 · 定稿', 'finalize', { icon: 'ph-check-circle' }), secondary: HIDDEN };
      } else if (review.outcome === 'approved') {
        view = { status: 'approved', text: '已通过 · 没有批注', detail: '点「通过 · 定稿」告诉 AI 这篇结束;再划词批注会开始新一轮。', icon: 'ph-check-circle', primary: button('通过 · 定稿', 'finalize', { icon: 'ph-check-circle' }), secondary: HIDDEN };
      } else {
        view = { status: 'complete', text: '稿子回来了 · 已是最新版', detail: '看一遍改得对不对:再划词批注就开始下一轮;没问题就「通过 · 定稿」。', icon: 'ph-arrow-u-down-left', primary: button('通过 · 定稿', 'finalize', { title: '这版就是终稿,告诉 AI 这篇结束了', icon: 'ph-check-circle' }), secondary: HIDDEN };
      }
    } else if (review.status === 'conflict') {
      view = {
        status: 'conflict', text: '文件在外面被改了', icon: 'ph-warning-circle',
        detail: '审阅期间有别的程序改了这个文件,已停止写入。点「处理…」:以磁盘上的版本重新开始,或另存你的版本。',
        primary: button('处理…', 'resolve-conflict', { title: '以磁盘上的版本重新开始,或另存锁定时的版本', icon: 'ph-warning' }), secondary: HIDDEN,
      };
    } else if (review.status === 'cancelled') {
      view = { status: 'cancelled', text: '本轮已作废', detail: '本轮已人工结束。再划词批注会开始新一轮。', icon: 'ph-x-circle', primary: HIDDEN, secondary: HIDDEN };
    } else {
      view = { status: 'unknown', text: `未知状态:${review.status || 'unknown'}`, detail: '无法识别当前状态。', icon: 'ph-question', primary: HIDDEN, secondary: HIDDEN };
    }
    let text = view.text;
    if (input.editedSinceReturn && review.status === 'complete' && review.outcome !== 'finalized') {
      text = text.replace(' · 已是最新版', '') + ' · 已在最新版上编辑过';
      view.detail = `${view.detail} 回稿卡和对比说的是这一轮的完成稿;之后正文又改过。`;
    }
    if (input.remotePending) text += ' · 远程更新待同步';
    if (input.readOnly) text += ` · ${String(input.encoding || '非 UTF-8').toUpperCase()} 只读`;
    if (input.mode === 'edit' && !input.plain) view.secondary = HIDDEN;
    return { ...view, text };
  }

  /** 标签页角标与最近列表用的短标签 */
  function statusLabel(status, applyMode = '', outcome = '') {
    if (status === 'applying') return applyMode === 'manual' ? '我自己改' : 'AI 修改中';
    if (status === 'complete') return outcome === 'finalized' ? '已定稿' : outcome === 'approved' ? '已通过' : outcome === 'restored' ? '已恢复' : '稿子回来了';
    return ({ reviewing: '批注中', ready_to_apply: '已交出', conflict: '文件被改', cancelled: '已作废', plain: '普通阅读' })[status] || '未知状态';
  }

  /** 「复制改稿指令」的内容:贴给任何智能体都能接上这一轮 */
  function instructionText({ absPath, cliScript } = {}) {
    const file = String(absPath || '');
    const cli = cliScript ? `(命令 mdreview 通常在 /usr/local/bin;没有的话用 node "${cliScript}" 代替 mdreview)` : '';
    return [
      '请按回稿(Draftback)里的批注修改这篇文档:',
      file,
      '',
      `照这个顺序做${cli}:`,
      `1. mdreview claim "${file}"   领取这一轮,回稿会显示「AI 正在修改」`,
      `2. 读 ${file}.annotations.json 里 status=open 的批注;有歧义先逐条问我,一次一个问题`,
      `3. mdreview begin-apply "${file}"   改文件之前必须先跑,否则会判版本冲突`,
      '4. 按批注修改正文;每条在旁注文件里标 status=applied 或 wontfix,并写 appliedNote 说明怎么改的',
      `5. mdreview complete "${file}" --summary "这轮改了什么、哪些没采纳及原因"`,
      `6. mdreview wait "${file}"   后台挂起等我下一轮`,
      '',
    ].join('\n');
  }

  async function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 退回下面的办法 */ }
    try {
      if (typeof document === 'undefined') return false;
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed'; area.style.top = '-1000px';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (_) { return false; }
  }

  return { describe, statusLabel, instructionText, copyText, STALE_LISTENING_MS };
}));
