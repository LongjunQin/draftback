/*
 * 左栏「稿件」(UI 方案 v2 第 3.2 节):按轮到谁分四组。
 *   轮到你   批注中、稿子回来了、已通过、已恢复、文件在外面被改了(这些都等你批、定稿或处理)
 *   已交出   三档:没人接入 / 在线等待领取 / AI 正在修改
 *   我在改   我自己改(手工修改中)、普通文档正在编辑
 *   最近打开 已定稿、已作废、普通文档,按最后打开时间,最多 20 条
 * 同一篇只出现一次(服务端已按路径取最新一轮);前三组按最后活动时间排。
 *
 * 纯逻辑,输入是 /api/app/recent 的 items;浏览器挂 window.DraftbackDrafts,Node 里 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftbackDrafts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RECENT_LIMIT = 20;
  const GROUPS = [
    { key: 'yours', label: '轮到你' },
    { key: 'handed', label: '已交出' },
    { key: 'mine', label: '我在改' },
    { key: 'recent', label: '最近打开' },
  ];

  function pad(n) { return String(n).padStart(2, '0'); }
  function clock(value, now) {
    const t = Date.parse(value || '');
    if (!Number.isFinite(t)) return '';
    const d = new Date(t), n = new Date(now);
    const diff = now - t;
    if (diff >= 0 && diff < 60_000) return '刚刚';
    if (diff >= 0 && diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
    if (d.toDateString() === n.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const y = new Date(now - 86_400_000);
    if (d.toDateString() === y.toDateString()) return '昨天';
    return d.getFullYear() === n.getFullYear() ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  function duration(value, now) {
    const t = Date.parse(value || '');
    if (!Number.isFinite(t)) return '';
    const minutes = Math.max(0, Math.round((now - t) / 60_000));
    if (minutes < 1) return '刚开始';
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
  }
  function roundText(latest) { return Number.isInteger(latest && latest.round) ? `第 ${latest.round} 轮` : '这一轮'; }

  /** 一行:{ group, dot, subtitle, unread, activity } */
  function describeItem(item, now = Date.now()) {
    const latest = item.latest || null;
    const activity = (latest && latest.activityAt) || item.lastOpenedAt || null;
    if (!item.exists) return { group: 'recent', dot: 'idle', subtitle: '文件已不存在', unread: false, activity };
    if (!latest) {
      if (item.editing) return { group: 'mine', dot: 'mine', subtitle: `编辑中 · ${clock(item.lastOpenedAt, now)}`, unread: false, activity };
      return { group: 'recent', dot: 'idle', subtitle: `普通文档 · ${clock(item.lastOpenedAt, now)}`, unread: false, activity };
    }
    const r = roundText(latest);
    const open = Number(latest.openCount) || 0;
    switch (latest.status) {
      case 'reviewing':
        return { group: 'yours', dot: 'turn', subtitle: `${r} · ${open ? `${open} 条未交` : '还没有批注'} · ${clock(activity, now)}`, unread: false, activity };
      case 'conflict':
        return { group: 'yours', dot: 'conflict', subtitle: '文件在外面被改了 · 要处理', unread: false, activity };
      case 'ready_to_apply': {
        if (latest.agentState === 'claimed') return { group: 'handed', dot: 'ai', subtitle: `AI 正在修改 · ${duration(activity, now)}`, unread: false, activity };
        if (latest.agentState === 'listening') return { group: 'handed', dot: 'waiting', subtitle: `已交出 · AI 在线,等待领取`, unread: false, activity };
        return { group: 'handed', dot: 'waiting', subtitle: `已交出 · 还没有 AI 接入 · ${clock(activity, now)}`, unread: false, activity };
      }
      case 'applying':
        if (latest.applyMode === 'manual') return { group: 'mine', dot: 'mine', subtitle: open ? `我自己改 · 剩 ${open} 条` : '我自己改 · 改完点「提交修改」', unread: false, activity };
        return { group: 'handed', dot: 'ai', subtitle: `AI 正在修改 · ${duration(activity, now)}`, unread: false, activity };
      case 'complete': {
        if (latest.outcome === 'finalized') return { group: 'recent', dot: 'done', subtitle: `已定稿 · ${clock(activity, now)}`, unread: false, activity };
        if (latest.outcome === 'approved') return { group: 'yours', dot: 'back', subtitle: `${r} · 已通过,没有批注`, unread: false, activity };
        if (latest.outcome === 'restored') return { group: 'yours', dot: 'back', subtitle: `${r} · 已恢复到改稿前`, unread: false, activity };
        if (latest.applyMode === 'manual') return { group: 'yours', dot: 'back', subtitle: `${r} · 我自己改完了`, unread: false, activity };
        const counts = latest.applied || latest.wontfix ? ` · 采纳 ${latest.applied || 0} · 未采纳 ${latest.wontfix || 0}` : '';
        return { group: 'yours', dot: 'back', subtitle: `${r}回稿${counts}`, unread: Boolean(latest.unread), activity };
      }
      case 'cancelled':
        return { group: 'recent', dot: 'idle', subtitle: `已作废 · ${clock(activity, now)}`, unread: false, activity };
      default:
        return { group: 'recent', dot: 'idle', subtitle: `${clock(item.lastOpenedAt, now)}`, unread: false, activity };
    }
  }

  /** 分组:[{ key, label, rows: [{ item, dot, subtitle, unread }] }],空组不出现 */
  function groupDrafts(items, now = Date.now()) {
    const buckets = new Map(GROUPS.map((group) => [group.key, []]));
    for (const item of items || []) {
      if (!item || !item.absPath) continue;
      const row = { item, ...describeItem(item, now) };
      buckets.get(row.group).push(row);
    }
    const byActivity = (a, b) => (Date.parse(b.activity || 0) || 0) - (Date.parse(a.activity || 0) || 0);
    const byOpened = (a, b) => String(b.item.lastOpenedAt || '').localeCompare(String(a.item.lastOpenedAt || ''));
    return GROUPS.map((group) => {
      let rows = buckets.get(group.key);
      rows = group.key === 'recent' ? rows.sort(byOpened).slice(0, RECENT_LIMIT) : rows.sort(byActivity);
      return { key: group.key, label: group.label, rows };
    }).filter((group) => group.rows.length);
  }

  /** 欢迎页:先列轮到你的前几条,没有就列最近打开 */
  function welcomeRows(items, now = Date.now(), limit = 5) {
    const groups = groupDrafts(items, now);
    const yours = groups.find((g) => g.key === 'yours');
    const handed = groups.find((g) => g.key === 'handed');
    const first = [...(yours ? yours.rows : []), ...(handed ? handed.rows : [])];
    if (first.length) return first.slice(0, limit);
    const all = groups.flatMap((g) => g.rows);
    return all.slice(0, limit);
  }

  return Object.freeze({ GROUPS, describeItem, groupDrafts, welcomeRows, clock, duration });
});
