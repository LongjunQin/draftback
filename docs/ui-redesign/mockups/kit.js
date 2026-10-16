// 方案 C 效果图的共用零件:手机外框、状态栏、图标、火漆印。各页面用它拼出整屏。
const ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  outline: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  folder: '<path d="M3 7h6l2 2h10v10H3z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  diff: '<path d="M4 7h10M4 12h7M4 17h12"/><path d="M17 4v6M14 7h6" />',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14 5M4 12a8 8 0 0 1 14-5"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  warn: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  mac: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/><path d="M12 8v4l3 2"/>',
};
const icon = (name, size = 18, width = 2.2, extra = '') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICON[name]}</svg>`;
const seal = (size, extra = '') => `<svg width="${size}" height="${size}" style="flex: none; overflow: visible" ${extra}><use href="#seal-l"/></svg>`;

// 状态栏:时间、信号、Wi-Fi、电量;颜色跟着外层的 color 走
const statusBar = (style = '') => `<div class="status" style="${style}"><b>9:41</b><span class="status-r">
  <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>
  <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.2c2.4 0 4.6.9 6.2 2.5l1.2-1.2C13.4 1.5 10.8.4 8 .4S2.6 1.5.6 3.5l1.2 1.2C3.4 3.1 5.6 2.2 8 2.2zm0 3.6c1.4 0 2.7.5 3.7 1.5l1.2-1.2C11.6 4.8 9.9 4.1 8 4.1s-3.6.7-4.9 2l1.2 1.2c1-1 2.3-1.5 3.7-1.5zm0 3.5c.5 0 1 .2 1.3.5L8 11.6 6.7 9.8c.3-.3.8-.5 1.3-.5z"/></svg>
  <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="23" height="12" rx="3.5" stroke="currentColor" opacity=".45"/><rect x="2" y="2" width="20" height="9" rx="2.2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" opacity=".45"/></svg>
</span></div>`;

// 一台手机:screenClass 给屏幕加底色(比如 lt-deep 或 paper-c),wrapStyle 挂封面颜色变量
const phone = (inner, { screenClass = '', screenStyle = '', wrapStyle = '', night = false } = {}) =>
  `<div class="phone ${night ? 'night' : ''}" style="${wrapStyle}"><div class="screen ${screenClass}" style="${screenStyle}"><div class="island"></div>${inner}</div></div>`;

// 一组带说明的效果图
const shot = (caption, html) => `<div class="shot"><p class="caption">${caption}</p>${html}</div>`;
const shotW = (caption, html) => `<div class="shot wide"><p class="caption">${caption}</p>${html}</div>`;

// ---------- 手机读稿页的零件 ----------
// 上栏:返回、标题和状态、右边的大纲 / 批注 / 更多
const pTop = ({ title = '产品方案.md', sub = '', tone = '', badge = 0, right = ['outline', 'comment', 'more'], left = 'back' } = {}) => `
<header class="p-top lt"><div class="lt-ink">${statusBar()}</div>
  ${left ? `<button class="p-btn lt-press press" aria-label="返回">${icon(left, 18, 2.4)}</button>` : ''}
  <div class="mid"><div class="ttl lt-ink">${title}</div>${sub ? `<div class="sub lt-ink-soft">${tone ? `<i class="dot tone-${tone}"></i>` : ''}${sub}</div>` : ''}</div>
  <div style="display: flex; gap: 8px">${right.map((n) => `<button class="p-btn lt-press press">${icon(n, 16, 2.2)}${n === 'comment' && badge ? `<span class="sticker coral badge">${badge}</span>` : ''}</button>`).join('')}</div>
</header>`;
// 下栏:左边状态和说明,右边主要按钮
const pBottom = ({ line = '', detail = '', right = '', left = '' } = {}) => `
<footer class="p-bottom lt">${left}
  <div class="l">${line ? `<div class="line lt-ink">${line}</div>` : ''}${detail ? `<div class="detail lt-ink-soft">${detail}</div>` : ''}</div>
  ${right}<div class="home-ind lt-ink"></div>
</footer>`;
const tagBtn = (label, { ic = '', count = 0, kind = '' } = {}) =>
  `<button class="tag-btn ${kind}">${ic ? icon(ic, 15, 2.3) : ''}${label}${count ? `<span class="sticker coral" style="min-width: 20px; height: 20px; padding: 0 6px; font-size: 11.5px">${count}</span>` : ''}</button>`;
const sealBtn = (label = '盖章定稿', size = 62) => `<span class="lt-ink" style="flex: none; font-size: 13px; font-weight: 600">${label}</span>${seal(size)}`;
const showBtn = (on) => on
  ? `<button class="lt-deep lt-sunk" style="height: 34px; padding: 0 15px; border-radius: 17px; font-size: 13px">${icon('diff', 14, 2.2)}隐藏改动</button>`
  : `<button class="lt lt-raised" style="height: 34px; padding: 0 15px; border-radius: 17px; font-size: 13px">${icon('diff', 14, 2.2)}显示改动</button>`;

// 回稿卡:纸胶带贴着;采纳 / 未采纳是圆贴纸;「显示改动」是开关
const roundCard = ({ round = 3, when = '10/15 15:58 · Claude Code', ok = 2, no = 1, changes = 4, showing = false,
  sum = '按 3 条批注改了第二节的说法,删掉一段重复的背景。' } = {}) => `
<section class="rcard card-c" style="transform: rotate(-.4deg)">
  <span class="washi" style="--tape: rgba(244,178,160,.82); width: 96px; left: 50%; margin-left: -48px; top: -11px; transform: rotate(-2deg)"></span>
  <div class="head"><h2>第 ${round} 轮回稿</h2><span class="meta">${when}</span></div>
  <div class="chips"><span class="sticker mint chip" style="transform: rotate(-2deg)">采纳 ${ok}</span><span class="sticker coral chip" style="transform: rotate(1.5deg)">未采纳 ${no}</span><span class="link">逐条结果 ›</span></div>
  <p class="sum">${sum}</p>
  <div class="foot">${showBtn(showing)}<span style="font-size: 13px; color: var(--muted)">改了 ${changes} 处</span></div>
</section>`;

// 正文:同一篇「产品方案」的几种样子
const DOC = {
  intro: '回稿把同一份文档在 Mac 和 iPhone 之间来回传。这份说明讲清楚谁说了算、批注怎么走。',
  who: 'Mac 管原文、轮次和最终状态。手机管自己还没交出去的批注,强退也不会丢。云端只是邮筒,不做裁判。',
  how: '手机上写的每一条先存在手机里。点「交给 AI」才打包上传。Mac 收到后回一张回执。',
  oops: 'Mac 上的原文被别的程序改了,这批批注不会被采用。它们留在手机上,不会丢。',
};
const docClean = ({ h1 = true } = {}) => `<article class="doc">${h1 ? '<h1>产品方案</h1>' : ''}<p>${DOC.intro}</p>
  <h3>谁说了算</h3><p>${DOC.who}</p><h3>批注怎么走</h3><p>${DOC.how}</p><h3>出了岔子怎么办</h3><p>${DOC.oops}</p></article>`;
const docMarked = () => `<article class="doc"><h1>产品方案</h1><p>${DOC.intro}</p>
  <h3>谁说了算</h3><p>Mac 管原文、轮次和最终状态。手机管自己还没交出去的批注,强退也不会丢。<span class="mark">云端只是邮筒,不做裁判。</span></p>
  <h3>批注怎么走</h3><p>手机上写的每一条先存在手机里。点「交给 AI」才打包上传。<span class="mark">Mac 收到后回一张回执。</span></p><h3>出了岔子怎么办</h3><p>${DOC.oops}</p></article>`;
const docDiff = () => `<article class="doc">
  <div style="display: flex; gap: 14px; align-items: center; margin: -4px 0 14px; font-family: 'PingFang SC'; font-size: 12px; color: var(--muted)">
    <span><ins style="padding: 0 4px">新增</ins></span><span><del>删除</del></span><span style="border-left: 2.5px solid #74c19c; padding-left: 6px">改过</span></div>
  <h1>产品方案</h1><p>${DOC.intro}</p>
  <h3>谁说了算</h3><p class="changed">Mac 管原文、轮次和最终状态。手机管自己还没交出去的批注<ins>,强退也不会丢</ins>。云端只是邮筒,不做裁判。</p>
  <h3>批注怎么走</h3><p class="changed"><del>批注写好以后会立刻上传到云端,Mac 随时来取。</del><ins>手机上写的每一条先存在手机里。点「交给 AI」才打包上传。</ins>Mac 收到后回一张回执。</p>
  <h3>出了岔子怎么办</h3><p>${DOC.oops}</p></article>`;

// 底部弹出页
const sheet = (inner, { top = 330, cls = 'paper-c' } = {}) => `<div class="dim"></div><div class="sheet ${cls}" style="top: ${top}px"><div class="grab"></div>${inner}</div>`;
// iOS 键盘(示意)
const keyboard = () => {
  const row = (keys) => `<div class="row">${keys.split(' ').map((k) => `<span class="k">${k}</span>`).join('')}</div>`;
  return `<div class="kbd">${row('q w e r t y u i o p')}${row('a s d f g h j k l')}
  <div class="row"><span class="k w">⇧</span>${'z x c v b n m'.split(' ').map((k) => `<span class="k">${k}</span>`).join('')}<span class="k w">⌫</span></div>
  <div class="row"><span class="k w">123</span><span class="k w">🌐</span><span class="k sp">拼音</span><span class="k go">换行</span></div></div>`;
};
const alertBox = (title, msg, btn = '好') => `<div class="dim" style="background: rgba(10,15,25,.38)"></div><div class="alert"><div class="a-body"><b>${title}</b><p>${msg}</p></div><div class="a-btn">${btn}</div></div>`;

// ---------- Mac 窗口的零件 ----------
const PILL_TAPE = { back: 'rgba(178,222,198,.92)', turn: 'rgba(248,196,178,.92)', ai: 'rgba(206,198,240,.92)', conflict: 'rgba(240,170,160,.92)', idle: 'rgba(222,218,208,.92)' };
const macPill = (text, tone, ic = '') => `<div class="m-pill"><span class="washi" style="--tape: ${PILL_TAPE[tone]}"></span>${ic ? icon(ic, 14, 2.4) : ''}<span>${text}</span></div>`;
const macToggle = (state) => state === 'hide'
  ? `<button class="lt-deep lt-sunk" style="height: 34px; padding: 0 14px; border-radius: 17px; font-size: 13px">${icon('diff', 15, 2.2)}隐藏改动</button>`
  : state === 'show' ? `<button class="lt-press" style="height: 34px; padding: 0 14px; gap: 6px; border-radius: 17px; font-size: 13px; font-weight: 600">${icon('diff', 15, 2.2)}<span class="lt-ink">显示改动</span></button>` : '';
const macTop = ({ title = '产品方案.md', pill = '', toggle = '', mode = '阅读', right = '', confirm = '' } = {}) => `
<header class="m-top lt"><div class="lights"><i></i><i></i><i></i></div>
  <button class="m-btn lt-press press" style="margin-left: 8px" aria-label="收起稿件栏"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button>
  <div class="m-title lt-ink">${title}<span class="lt-ink-soft">${icon('down', 13, 2.6)}</span></div>
  <div style="flex: 1; display: flex; justify-content: center">${pill}</div>
  ${confirm || `${macToggle(toggle)}
  <button class="m-btn lt-press press" aria-label="查找">${icon('search', 15, 2.4)}</button>
  <button class="m-btn lt-press press" aria-label="导出或打印">${icon('send', 15, 2.2)}</button>
  <div class="m-seg lt-press">${['阅读', '编辑'].map((m) => `<span class="${m === mode ? 'on' : 'lt-ink-soft'}">${m}</span>`).join('')}</div>
  <button class="m-btn lt-press press" aria-label="显示或收起批注栏"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>
  ${right}`}
</header>`;
const macRow = (dot, title, sub, { cur = false, red = false, tail = '' } = {}) =>
  `<div class="m-row ${cur ? 'cur' : ''}"><i class="dot tone-${dot}"></i><div style="flex: 1; min-width: 0"><b>${title}</b><small class="${red ? 'red' : ''}">${sub}</small></div>${tail}</div>`;
const macSide = ({ tab = '稿件', body = '', foot = 'iCloud 已同步 · 13:07' } = {}) => `
<aside class="m-side paper-c"><div class="seg2">${['稿件', '大纲'].map((t) => `<span class="${t === tab ? 'on' : ''}">${t}</span>`).join('')}</div>${body}
  <div class="foot"><div class="btns"><span>打开… ⌘O</span><span>新建… ⌘N</span></div><div>${icon('cloud', 13, 2)} ${foot}</div></div></aside>`;
const macDocs = (current = '产品方案') => `
  <div class="m-gh"><i class="dot tone-turn" style="box-shadow: none"></i><span class="nm">轮到你</span><span class="n">3</span></div>
  ${macRow('back', '产品方案', '第 3 轮回稿 · 采纳 2 · 未采纳 1', { cur: current === '产品方案' })}
  ${macRow('turn', '跨端规则', '第 2 轮 · 2 条未交 · 10 分钟前', { cur: current === '跨端规则' })}
  ${macRow('conflict', '定价页', '文件在外面被改了 · 要处理', { red: true })}
  <div class="m-gh"><i class="dot tone-ai" style="box-shadow: none"></i><span class="nm">已交出</span><span class="n">1</span></div>
  ${macRow('ai', '发布说明', 'AI 正在修改 · 12 分钟', { tail: '<span class="spin" style="margin-top: 4px"></span>' })}
  <div class="m-gh"><i class="dot tone-idle" style="box-shadow: none"></i><span class="nm">最近打开</span><span class="n">2</span></div>
  ${macRow('done', '年度总结', '已定稿 · 10 月 12 日')}
  ${macRow('idle', '会议纪要', '普通文档 · 昨天')}`;
const macRight = (inner, hint = '', tab = '本轮', count = '') => `
<aside class="m-right"><div class="m-rh"><span class="t lt-ink">批注${count ? ` <span class="lt-ink-soft" style="font-weight: 600">${count}</span>` : ''}</span>
  <div class="m-seg lt-press" style="height: 30px">${['本轮', '历史'].map((t) => `<span class="${t === tab ? 'on' : 'lt-ink-soft'}" style="padding: 0 12px">${t}</span>`).join('')}</div></div>
  ${inner}${hint ? `<div class="m-hint lt-ink-soft">${hint}</div>` : ''}</aside>`;
const macRound = (open = false) => `
<section class="card-c" style="position: relative; padding: 16px 16px 12px; border-radius: 4px; transform: rotate(-.6deg)">
  <span class="washi" style="--tape: rgba(244,178,160,.82); width: 74px; left: 50%; margin-left: -37px; top: -10px; transform: rotate(2deg)"></span>
  <div style="display: flex; align-items: baseline; gap: 8px"><span class="serif" style="font-size: 16px; font-weight: 700; white-space: nowrap">第 3 轮回稿</span>
    <span class="link" style="margin-left: auto; font-size: 12px; white-space: nowrap">${open ? '收起 ⌃' : '展开 ⌄'}</span></div>
  <div style="margin-top: 3px; font-size: 11.5px; color: var(--muted)">10/15 15:58 · Claude Code</div>
  ${open ? `<div style="display: flex; align-items: center; gap: 8px; margin-top: 10px"><span class="sticker mint chip">采纳 2</span><span class="sticker coral chip">未采纳 1</span><span style="font-size: 12px; color: var(--muted)">改了 4 处</span></div>
    <p class="serif" style="margin: 10px 0 6px; font-size: 13.5px; line-height: 1.65; color: var(--text-2)">按 3 条批注改了第二节的说法,删掉一段重复的背景。</p>
    <div style="margin: 8px 0 2px; font-size: 12px; font-weight: 700; color: var(--muted)">逐条结果 3</div>
    <div class="res-m"><span class="sticker mint" style="width: 18px; height: 18px; font-size: 10px; vertical-align: -3px">✓</span> <span class="q">“手机管自己还没交出去的批注”</span><div class="you hand">你:这句再说清楚,强退也不会丢</div><div class="ai">AI:在这句后面补了「强退也不会丢」。</div></div>
    <div class="res-m"><span class="sticker mint" style="width: 18px; height: 18px; font-size: 10px; vertical-align: -3px">✓</span> <span class="q" style="color: #b07a1e">全篇 · 总体意见</span><div class="you hand">你:「批注怎么走」写得太简单</div><div class="ai">AI:改成三句:先存手机、交出才上传、Mac 回执。</div></div>
    <div class="res-m"><span class="sticker coral" style="width: 18px; height: 18px; font-size: 10px; vertical-align: -3px">✕</span> <span class="q">“云端只是邮筒”</span><div class="you hand">你:这个比喻换掉</div><div class="ai">AI:没改。前文已经用过这个比喻,换掉会前后对不上。</div></div>`
  : `<div style="margin-top: 9px; font-size: 13px; color: var(--text-2)"><span class="sticker mint" style="height: 20px; padding: 0 8px; font-size: 11px">采纳 2</span> <span class="sticker coral" style="height: 20px; padding: 0 8px; font-size: 11px">未采纳 1</span> <span style="margin-left: 4px; color: var(--muted)">改了 4 处</span></div>`}
</section>`;
const macNote = (q, c, f, actions = '修改 删除', rot = 0) => `<div class="m-note" style="transform: rotate(${rot}deg)">
  <span class="washi" style="--tape: rgba(178,222,198,.85); width: 60px; left: 50%; margin-left: -30px; top: -10px; transform: rotate(-3deg)"></span>
  <div class="q">${q}</div><div class="c hand">${c}</div><div class="f">${f}<span class="a">${actions.split(' ').map((a) => `<span style="${a === '删除' ? 'color: #c0553c' : ''}">${a}</span>`).join('')}</span></div></div>`;
const macDash = (label = '写总体意见', sub = '针对全篇') => `<div class="m-dash lt-press"><span class="lt-ink">${icon('comment', 14, 2.2)}</span><span class="lt-ink">${label}</span><span class="lt-ink-soft" style="font-weight: 400">${sub}</span></div>`;
const macDoc = (variant = 'clean') => variant === 'marked' ? `<article class="doc"><h1>产品方案</h1><p>${DOC.intro}</p>
  <h3>谁说了算</h3><p>Mac 管原文、轮次和最终状态。手机管自己还没交出去的批注,强退也不会丢。<span class="mark">云端只是邮筒,不做裁判。</span></p>
  <h3>批注怎么走</h3><p>手机上写的每一条先存在手机里。点「交给 AI」才打包上传。<span class="mark">Mac 收到后回一张回执。</span></p><h3>出了岔子怎么办</h3><p>${DOC.oops}</p></article>`
  : variant === 'diff' ? `<article class="doc"><h1>产品方案</h1><p>${DOC.intro}</p>
  <h3>谁说了算</h3><p class="changed">Mac 管原文、轮次和最终状态。手机管自己还没交出去的批注<ins>,强退也不会丢</ins>。云端只是邮筒,不做裁判。</p>
  <h3>批注怎么走</h3><p class="changed"><del>批注写好以后会立刻上传到云端,Mac 随时来取。</del><ins>手机上写的每一条先存在手机里。点「交给 AI」才打包上传。</ins>Mac 收到后回一张回执。</p>
  <h3>出了岔子怎么办</h3><p>${DOC.oops}</p></article>` : docClean();
const mac = (inner, { night = false, wrapStyle = '' } = {}) => `<div class="mac lt-deep ${night ? 'night' : ''}" style="${wrapStyle}">${inner}</div>`;
