/*
 * 回稿卡与历史分轮(版本记录设计 v4 第 9 节;UI 方案 v2 第 3.2、3.4、3.8 节)。
 *
 * 数据来自版本事件(GET /api/app/document/versions?detail=1 里每个事件的 annotations / summary / counts),
 * 不读会继续变的旁注;事件缺失或没归档时从会话与旁注降级,并明说「这轮的处理记录没有归档」。
 * 没有轮次归属的旧批注归到「更早(未分轮)」。
 *
 * 纯逻辑、无 DOM:浏览器挂 window.DraftbackHistory,Node 里 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftbackHistory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TERMINAL = new Set(['complete', 'cancelled']);
  const UNARCHIVED_TEXT = '这轮的处理记录没有归档';

  function statusOf(note) {
    const value = String((note && note.status) || '').toLowerCase();
    if (['applied', 'wontfix', 'cancelled', 'open'].includes(value)) return value;
    if (note && (note.appliedAt || note.appliedBy || note.appliedNote)) return 'applied';
    return 'open';
  }

  function counts(notes) {
    const out = { applied: 0, wontfix: 0, cancelled: 0, open: 0, total: 0 };
    for (const note of notes || []) { out[statusOf(note)] += 1; out.total += 1; }
    return out;
  }

  /** 事件类型 → 历史列表里的标签(区分 AI 改 / 我自己改 / 零批注通过 / 作废 / 恢复) */
  function kindLabel(version) {
    const v = version || {};
    if (v.kind === 'review') return v.applyMode === 'manual' ? '我自己改' : 'AI 改稿';
    if (v.kind === 'manual') return '我自己改';
    if (v.kind === 'approved') return '通过 · 没有批注';
    if (v.kind === 'cancelled') return '作废';
    if (v.kind === 'restored') return `恢复到第 ${v.restoredFrom && v.restoredFrom.round ? v.restoredFrom.round : '?'} 轮改稿前`;
    return v.kind || '未知';
  }

  function kindIcon(version) {
    const v = version || {};
    if (v.kind === 'review') return v.applyMode === 'manual' ? 'ph-pencil-simple-line' : 'ph-robot';
    if (v.kind === 'manual') return 'ph-pencil-simple-line';
    if (v.kind === 'approved') return 'ph-check-circle';
    if (v.kind === 'cancelled') return 'ph-x-circle';
    if (v.kind === 'restored') return 'ph-clock-counter-clockwise';
    return 'ph-circle';
  }

  function archived(version) { return !!version && version.state !== 'corrupt' && !!version.files; }
  function canCompare(version) { return archived(version) && version.files.original === 'archived' && version.files.final === 'archived'; }
  function canRestore(version) { return archived(version) && version.files.original === 'archived' && ['review', 'manual', 'restored'].includes(version.kind); }
  function publishFailed(version) { return !!version && version.state === 'publish-failed'; }

  function memberNotes(version) {
    const notes = Array.isArray(version && version.annotations) ? version.annotations : null;
    if (!notes) return null;
    const members = Array.isArray(version.memberAnnotationIds) ? new Set(version.memberAnnotationIds) : null;
    return members ? notes.filter((note) => members.has(note.id)) : notes;
  }

  /** 逐条结果:你说了什么 / AI 怎么处理 */
  function resultItems(notes) {
    return (notes || []).map((note) => {
      const status = statusOf(note);
      const ai = status === 'applied' ? (note.appliedNote || '已处理(没有写说明)')
        : status === 'wontfix' ? (note.appliedNote ? `未采纳:${note.appliedNote}` : '未采纳(没有写理由)')
          : status === 'cancelled' ? (note.cancelReason ? `已作废:${note.cancelReason}` : '已作废')
            : '还没有处理';
      return {
        id: note.id, scope: note.scope === 'document' ? 'document' : 'text', quote: note.scope === 'document' ? '' : String(note.quote || ''),
        headingPath: Array.isArray(note.headingPath) ? note.headingPath : [], you: String(note.comment || ''), ai, status,
        appliedBy: note.appliedBy || null, createdAt: note.createdAt || null,
      };
    });
  }

  /**
   * 回稿卡:{ show, kind, title, subtitle, summary, counts, items, degraded, degradedText, canCompare, canRetryPublish, version }
   * 只在会话处于终态时显示;已定稿不显示卡(历史里看)。
   */
  function returnCard({ review, versions, annotations } = {}) {
    const r = review || {};
    if (!TERMINAL.has(r.status) || r.outcome === 'finalized') return { show: false };
    const list = Array.isArray(versions) ? versions : [];
    const version = list.find((v) => v.versionId === r.versionId) || list.find((v) => v.reviewId === r.id) || null;
    const round = (version && version.round) || r.round || null;
    const roundText = Number.isInteger(round) ? `第 ${round} 轮` : '这一轮';
    if (r.status === 'cancelled' || (version && version.kind === 'cancelled')) {
      return { show: true, kind: 'cancelled', title: `${roundText}已作废`, subtitle: when(version && version.completedAt || r.completedAt || r.updatedAt), summary: r.cancelReason || (version && version.summary) || '', counts: null, items: [], degraded: false, canCompare: false, version };
    }
    if (r.outcome === 'restored' || (version && version.kind === 'restored')) {
      const from = (version && version.restoredFrom) || r.restoredFrom || {};
      return {
        show: true, kind: 'restored', title: `已恢复到第 ${from.round || '?'} 轮改稿前`, subtitle: when(version && version.completedAt || r.completedAt),
        summary: '正文已换回那一轮改稿前的样子;恢复前的稿子留在历史里(这一轮的「原稿」),可以再恢复回来。附件不随恢复变化。',
        counts: null, items: [], degraded: false, canCompare: canCompare(version), restoreBackVersionId: version ? version.versionId : null, version,
      };
    }
    if (r.outcome === 'approved' || (version && version.kind === 'approved')) {
      return { show: true, kind: 'approved', title: `${roundText} · 通过,没有批注`, subtitle: when(version && version.completedAt || r.completedAt), summary: '', counts: null, items: [], degraded: false, canCompare: false, version };
    }
    // 回稿(AI 改或我自己改)
    const manual = r.applyMode === 'manual' || (version && version.applyMode === 'manual') || (version && version.kind === 'manual');
    const notes = memberNotes(version);
    const degraded = !version || notes === null || publishFailed(version);
    const fallbackNotes = degraded ? (Array.isArray(annotations) ? annotations : []).filter((note) => note.reviewSessionId === r.id || (!note.reviewSessionId && statusOf(note) !== 'open')) : [];
    const used = notes || fallbackNotes;
    const actor = (version && (version.applyActor || version.claimedBy)) || r.applyActor || r.claimedBy || null;
    return {
      show: true, kind: manual ? 'manual' : 'agent',
      title: manual ? `${roundText} · 我自己改完了` : `${roundText}回稿`,
      subtitle: [when((version && version.completedAt) || r.completedAt), actor && !manual ? actor : null].filter(Boolean).join(' · '),
      summary: (version && version.summary) || r.summary || '',
      counts: counts(used), items: resultItems(used),
      degraded, degradedText: degraded ? (publishFailed(version) ? `${UNARCHIVED_TEXT}(发布失败,可以重试)` : UNARCHIVED_TEXT) : '',
      canRetryPublish: publishFailed(version), canCompare: canCompare(version), version,
    };
  }

  /**
   * 历史按轮折叠:每轮一行「第 1 轮 · 10/13 · 采纳 5」。
   * 输入 { versions, annotations, review };输出 { rounds: [...], legacy: { count, items } | null }
   * 每轮:{ key, versionId, reviewId, round, seq, kind, label, icon, time, counts, summary, items, archived, degraded, canCompare, canRestore, current }
   */
  function buildRounds({ review, versions, annotations } = {}) {
    const r = review || {};
    const list = (Array.isArray(versions) ? versions : []).filter((v) => v && v.state !== 'corrupt');
    const notes = Array.isArray(annotations) ? annotations : [];
    const byReview = new Map();
    for (const note of notes) {
      if (!note || statusOf(note) === 'open') continue; // 未处理的在「本轮」列表里
      const key = note.reviewSessionId || '';
      if (!byReview.has(key)) byReview.set(key, []);
      byReview.get(key).push(note);
    }
    const rounds = [];
    const seen = new Set();
    for (const v of list) {
      seen.add(v.reviewId);
      const active = v.reviewId === r.id && !TERMINAL.has(r.status);
      if (active) continue; // 进行中的这一轮不进历史:它的批注在「本轮」列表里,时间线上才显示
      const members = memberNotes(v);
      const sidecarNotes = byReview.get(v.reviewId) || [];
      const items = members !== null ? members : sidecarNotes;
      rounds.push({
        key: v.versionId, versionId: v.versionId, reviewId: v.reviewId, round: v.round, seq: v.seq, kind: v.kind,
        label: active ? '进行中' : kindLabel(v), icon: kindIcon(v), time: v.completedAt || v.submittedAt || v.startedAt || null,
        counts: counts(items), summary: v.summary || '', items: resultItems(items), archived: true,
        degraded: !active && (members === null || publishFailed(v)), degradedText: publishFailed(v) ? `${UNARCHIVED_TEXT}(发布失败)` : UNARCHIVED_TEXT,
        canCompare: !active && canCompare(v), canRestore: !active && canRestore(v), restoredFrom: v.restoredFrom || null, current: v.reviewId === r.id, active,
      });
    }
    // 旁注里有、事件里没有的轮(上线前的旧会话,或事件被清理):标「未归档」
    for (const [key, items] of byReview) {
      if (!key || seen.has(key)) continue;
      const isCurrent = key === r.id;
      if (isCurrent && !TERMINAL.has(r.status)) continue;
      rounds.push({
        key: `unarchived:${key}`, versionId: null, reviewId: key, round: isCurrent ? r.round || null : null, seq: null, kind: 'unarchived',
        label: isCurrent && !TERMINAL.has(r.status) ? '进行中' : '未归档', icon: 'ph-archive', time: items.reduce((latest, n) => latestTime(latest, n.appliedAt || n.updatedAt || n.createdAt), null),
        counts: counts(items), summary: isCurrent ? r.summary || '' : '', items: resultItems(items), archived: false, degraded: true, degradedText: UNARCHIVED_TEXT,
        canCompare: false, canRestore: false, restoredFrom: null, current: isCurrent, active: isCurrent && !TERMINAL.has(r.status),
      });
    }
    rounds.sort((a, b) => (b.seq || 0) - (a.seq || 0) || Date.parse(b.time || 0) - Date.parse(a.time || 0));
    const legacyItems = byReview.get('') || [];
    return { rounds, legacy: legacyItems.length ? { count: legacyItems.length, items: resultItems(legacyItems) } : null };
  }

  /** 轮次时间线(状态区点开):按先后排,最后一项是当前 */
  function timeline({ review, versions } = {}) {
    const r = review || {};
    const list = (Array.isArray(versions) ? versions : []).filter((v) => v && v.state !== 'corrupt').slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const entries = list.map((v) => ({
      versionId: v.versionId, round: v.round, label: v.reviewId === r.id && !TERMINAL.has(r.status) ? '进行中' : kindLabel(v), icon: kindIcon(v),
      time: v.completedAt || v.submittedAt || v.startedAt || null, counts: v.counts || null, current: v.reviewId === r.id, pending: v.reviewId === r.id && !TERMINAL.has(r.status), degraded: publishFailed(v),
    }));
    if (r.id && !list.some((v) => v.reviewId === r.id) && r.round) {
      entries.push({ versionId: null, round: r.round, label: TERMINAL.has(r.status) ? '未归档' : '进行中', icon: 'ph-circle-dashed', time: r.createdAt || null, counts: null, current: true, pending: !TERMINAL.has(r.status), degraded: false });
    }
    return entries;
  }

  function when(value) {
    const parsed = Date.parse(value || '');
    if (!Number.isFinite(parsed)) return '';
    const d = new Date(parsed);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const date = `${d.getMonth() + 1}/${d.getDate()}`;
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return sameYear ? `${date} ${time}` : `${d.getFullYear()}/${date} ${time}`;
  }

  function latestTime(current, candidate) {
    const parsed = Date.parse(candidate || '');
    if (!Number.isFinite(parsed)) return current;
    return !current || parsed > Date.parse(current) ? new Date(parsed).toISOString() : current;
  }

  /** 恢复确认框文案(UI 方案 3.4) */
  function restoreConfirmText(round) {
    const n = Number.isInteger(round) ? round : '?';
    return `正文会换回第 ${n} 轮改稿前的样子。现在这一版会留在历史里(叫「第 ${n} 轮恢复前的稿子」),可以再恢复回来;附件不随恢复变化。`;
  }

  return Object.freeze({ statusOf, counts, kindLabel, kindIcon, returnCard, buildRounds, timeline, when, restoreConfirmText, UNARCHIVED_TEXT });
});
