(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const Anchor = window.DraftbackAnchor;
  const History = window.DraftbackHistory;   // 回稿卡与历史分轮的数据(规则⑤第三段)
  const Diff = window.DraftbackDiff;         // 轮次对比算法
  const Actions = window.DraftbackActions || null; // 动作表:菜单栏与快捷键共用
  const FEEDBACK_URL = 'https://github.com/LongjunQin/draftback/issues';
  const bridge = window.draftbackDesktop || null;
  const ACTIVE_REVIEW = new Set(['reviewing', 'ready_to_apply', 'applying', 'conflict']);

  const nodes = {
    shell: $('#appShell'), tabList: $('#tabList'), openTabButton: $('#openTabButton'), primaryAction: $('#primaryAction'), secondaryAction: $('#secondaryAction'), findButton: $('#findButton'),
    left: $('#leftSidebar'), right: $('#rightSidebar'), collapseLeft: $('#collapseLeft'), toggleLeftTop: $('#toggleLeftTop'),
    toggleRightTop: $('#toggleRightTop'), outlineMode: $('#outlineModeButton'), filesMode: $('#filesModeButton'),
    outlinePanel: $('#outlinePanel'), filesPanel: $('#filesPanel'), recentList: $('#recentList'), openFileButton: $('#openFileButton'),
    toolbar: $('#documentToolbar'), reviewState: $('#reviewStatePill'), reviewStateIcon: $('#reviewStateIcon'),
    reviewStateText: $('#reviewStateText'), readingMode: $('#readingModeButton'),
    editingMode: $('#editingModeButton'), readerPane: $('#readerPane'), welcome: $('#welcome'), welcomeOpen: $('#welcomeOpenButton'),
    welcomeNew: $('#welcomeNewButton'), newFileButton: $('#newFileButton'), exportMenuButton: $('#exportMenuButton'), exportMenu: $('#exportMenu'),
    welcomeRecent: $('#welcomeRecent'), readerScroll: $('#readerScroll'), content: $('#documentContent'), editorPane: $('#editorPane'),
    codeEditor: $('#codeEditor'), editorSaveState: $('#editorSaveState'), saveButton: $('#saveButton'),
    finishManual: $('#finishManualButton'), notesTotal: $('#notesTotal'), openNotesCount: $('#openNotesCount'),
    historyNotesCount: $('#historyNotesCount'), openNotesList: $('#openNotesList'), historyNotesList: $('#historyNotesList'),
    historySection: $('#historySection'), annotate: $('#annotateButton'), annotationOverlay: $('#annotationOverlay'),
    docNoteButton: $('#docNoteButton'),
    annotationDialog: $('#annotationDialog'), annotationDialogPanel: $('#annotationDialogPanel'),
    annotationDialogHandle: $('#annotationDialogDragHandle'),
    annotationTitle: $('#annotationDialogTitle'), annotationQuote: $('#annotationQuote'), annotationText: $('#annotationText'),
    annotationSave: $('#saveAnnotation'), annotationCancel: $('#cancelAnnotation'), annotationClose: $('#closeAnnotationDialog'),
    confirmDialog: $('#confirmDialog'), confirmTitle: $('#confirmTitle'), confirmMessage: $('#confirmMessage'),
    confirmAccept: $('#confirmAccept'), confirmCancel: $('#confirmCancel'), toastRegion: $('#toastRegion'),
    findBar: $('#findBar'), findInput: $('#findInput'), findCount: $('#findCount'), findPrev: $('#findPrev'), findNext: $('#findNext'), findClose: $('#findClose'),
    replaceRow: $('#replaceRow'), replaceInput: $('#replaceInput'), replaceOne: $('#replaceOne'), replaceAll: $('#replaceAll'),
    dropOverlay: $('#dropOverlay'),
    returnCard: $('#returnCard'), timelinePopover: $('#timelinePopover'),
    compareView: $('#compareView'), compareTitle: $('#compareTitle'), compareMeta: $('#compareMeta'), comparePosition: $('#comparePosition'),
    comparePrev: $('#comparePrev'), compareNext: $('#compareNext'), compareClose: $('#compareClose'), compareScroll: $('#compareScroll'),
    compareContent: $('#compareContent'), compareNote: $('#compareNote'),
    confirmAlt: $('#confirmAlt'),
    tabStrip: $('#tabStrip'), docTitleButton: $('#docTitleButton'), docTitleText: $('#docTitleText'), docInfoPopover: $('#docInfoPopover'),
    compareToggleButton: $('#compareToggleButton'), toolbarMoreButton: $('#toolbarMoreButton'), toolbarMoreMenu: $('#toolbarMoreMenu'),
    syncFooter: $('#syncFooter'), syncFooterText: $('#syncFooterText'), syncFooterIcon: $('#syncFooterIcon'),
    notesFooter: $('#notesFooter'), notesSectionHint: document.querySelector('.notes-section-hint'),
    notesCurrentTab: $('#notesCurrentTab'), notesHistoryTab: $('#notesHistoryTab'), currentPane: $('#currentPane'), openNotesSection: $('#openNotesSection'),
    quickOpen: $('#quickOpen'), quickOpenInput: $('#quickOpenInput'), quickOpenList: $('#quickOpenList'),
    settingsDialog: $('#settingsDialog'), settingsClose: $('#settingsClose'), appearanceSegment: $('#appearanceSegment'),
    zoomRange: $('#zoomRange'), zoomValue: $('#zoomValue'), zoomResetButton: $('#zoomResetButton'),
    syncToggle: $('#syncToggle'), syncStatusLine: $('#syncStatusLine'), syncDetailsButton: $('#syncDetailsButton'),
    cliStatusLine: $('#cliStatusLine'), cliInstallButton: $('#cliInstallButton'), aboutLine: $('#aboutLine'),
    aboutGuideButton: $('#aboutGuideButton'), aboutFeedbackButton: $('#aboutFeedbackButton'),
    infoDialog: $('#infoDialog'), infoTitle: $('#infoTitle'), infoBody: $('#infoBody'), infoClose: $('#infoClose'),
  };

  // 改名前的本地存储键 mdturn.*(标签、未保存草稿、阅读偏好)一次性搬到 draftback.*;命名沿革见 docs/naming-history.md
  (function migrateLegacyLocalStorage() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('mdturn.')) continue;
        const next = `draftback.${key.slice('mdturn.'.length)}`;
        if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key));
        localStorage.removeItem(key);
      }
    } catch (_) {}
  })();

  const state = {
    tabs: [],
    activeId: null,
    recents: [],
    leftMode: localStorage.getItem('draftback.leftMode') === 'files' ? 'files' : 'outline',
    leftCollapsed: localStorage.getItem('draftback.leftCollapsed') === '1',
    rightCollapsed: localStorage.getItem('draftback.rightCollapsed') === '1',
    readerZoom: Math.min(2.2, Math.max(0.6, parseFloat(localStorage.getItem('draftback.readerZoom')) || 1)),
    selectionFrame: null,
    nextRoundHintAt: 0,
    cachedAnchor: null,
    dialog: null,
    editorView: null,
    editorTabId: null,
    draftTimers: new Map(),
    draftWarningShown: false,
    renderingHistory: false,
    refreshBusy: false,
    outlineFrame: null,
    markerFrame: null,
    markerEntries: [],
    dialogDrag: null,
    eventSource: null,
    reconcileTimer: null,
    reconciling: false,
    remoteChanges: new Map(),
    remoteRefreshes: new Map(),
    remoteRetryTimers: new Map(),
    announcedCompletions: null,
    layoutObserver: null,
  };

  class ApiError extends Error {
    constructor(message, status = 0, code = '', details = null) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  async function requestJson(url, options = {}) {
    let response;
    try {
      response = await fetch(url, { cache: 'no-store', ...options });
    } catch (error) {
      throw new ApiError('本地回稿服务不可达。', 0, 'service_unavailable', { cause: error && error.message });
    }
    const type = response.headers.get('content-type') || '';
    let body = null;
    if (type.includes('application/json')) {
      try { body = await response.json(); }
      catch { throw new ApiError('服务返回了损坏的 JSON。', response.status, 'bad_json'); }
    } else {
      const text = await response.text();
      if (!response.ok || type.includes('text/html')) {
        throw new ApiError('服务返回了意外页面，请重启回稿后再试。', response.status, 'unexpected_response', { text: text.slice(0, 180) });
      }
    }
    if (!response.ok) {
      throw new ApiError((body && body.message) || `请求失败（HTTP ${response.status}）`, response.status,
        body && body.error, body && body.details);
    }
    if (!body || typeof body !== 'object') throw new ApiError('服务没有返回有效数据。', response.status, 'bad_response');
    return body;
  }

  function friendlyError(error, action = '操作') {
    if (!(error instanceof ApiError)) return `${action}失败：${error && error.message ? error.message : String(error)}`;
    if (error.code === 'source_conflict' || error.code === 'source_changed') {
      return `${action}未完成：文档版本已经变化。你的输入仍保留，请先处理版本冲突。`;
    }
    if (error.status === 409) {
      // 其余 409(普通编辑中被冻结、上一次写入未完成、幂等键冲突……)服务端的说明更准确,原样转达
      return `${action}未完成：${error.message || '与当前状态冲突。'}`;
    }
    if (error.code === 'review_read_only' || error.code === 'source_write_not_allowed' || error.status === 423) {
      return `${action}未完成：文档已被重新冻结（通常是智能体开启了新一轮审阅）。你的修改仍保留在编辑器里，没有丢失；可复制留用，或等这一轮结束后再改。`;
    }
    if (error.status === 404) return `${action}未完成：文档或审阅会话已经失效。`;
    if (error.status === 0) return `${action}未完成：本地服务不可达。`;
    return error.message || `${action}失败。`;
  }

  // 提示条(UI 方案 2.4):底部居中,同时最多一条,新的替换旧的;可带一个动作按钮(如「撤销」)
  function toast(message, kind = '', options = {}) {
    dismissToast();
    const item = document.createElement('div');
    item.className = `toast${kind ? ` ${kind}` : ''}`;
    if (options.tag) item.dataset.tag = options.tag;
    const text = document.createElement('span'); text.className = 'toast-text'; text.textContent = message;
    item.appendChild(text);
    if (options.action) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'toast-action'; button.textContent = options.action.label;
      button.addEventListener('click', () => { dismissToast(); void options.action.run(); });
      item.appendChild(button);
    }
    nodes.toastRegion.appendChild(item);
    item.__timer = setTimeout(() => item.remove(), options.duration || (kind === 'error' ? 5200 : 3000));
    return item;
  }
  function dismissToast(tag = null) {
    nodes.toastRegion.querySelectorAll('.toast').forEach((node) => {
      if (tag && node.dataset.tag !== tag) return;
      clearTimeout(node.__timer); node.remove();
    });
  }

  function requestId(prefix = 'req') {
    const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`;
  }

  function activeTab() { return state.tabs.find((tab) => tab.id === state.activeId) || null; }
  function tabByPath(sourceFile) { return state.tabs.find((tab) => tab.review && tab.review.sourceFile === sourceFile) || null; }
  function isPlain(tab) { return !!tab && tab.kind === 'document'; }
  function editingToken() {
    if (!state.editingToken) state.editingToken = `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    return state.editingToken;
  }
  function effectiveStatus(note) { return Anchor ? Anchor.effectiveStatus(note) : (note.status || 'open'); }
  function openAnnotations(tab) { return (tab && tab.annotations || []).filter((note) => effectiveStatus(note) === 'open'); }
  function isDocNote(note) { return !!note && note.scope === 'document'; }

  // 普通文档载荷(/api/app/document*)→ 与审阅 bundle 同形的结构:review 字段是一个 status='plain' 的占位对象,
  // 这样标签页、状态条、编辑器的代码路径可以复用;真正的区别只在 kind 与几处分支。
  function normalizeDocument(payload) {
    const document = payload.document || {};
    const source = payload.source || {};
    return {
      kind: 'document',
      review: {
        id: document.id, status: 'plain', sourceFile: document.absPath, absPath: document.absPath,
        file: document.file, title: document.title || document.file, directory: document.directory,
        docId: payload.docId || null, // 会话被清理后仍能按文档身份看历史、对比、恢复
      },
      source: { content: String(source.content || ''), hash: source.hash, revision: 0, readOnly: Boolean(source.readOnly), readOnlyReason: source.readOnlyReason || '', encoding: source.encoding || 'utf-8', mtimeMs: source.mtimeMs || null },
      annotations: [],
      activeReview: payload.activeReview || null,
      editing: payload.editing || null,
    };
  }

  function normalizeBundle(bundle) {
    if (bundle && bundle.kind === 'document') return bundle;
    if (bundle && bundle.document && !bundle.review) return normalizeDocument(bundle);
    const review = bundle.review || {};
    const source = bundle.source && typeof bundle.source === 'object'
      ? bundle.source
      : { content: String(bundle.source || ''), hash: review.workingHash || review.sourceHash };
    const annotations = Array.isArray(bundle.annotations)
      ? bundle.annotations
      : (bundle.annotations && Array.isArray(bundle.annotations.annotations) ? bundle.annotations.annotations : []);
    review.sourceFile = review.sourceFile || review.absPath;
    review.title = review.title || review.file || (review.sourceFile || '').split('/').pop() || 'Markdown';
    return { review, source, annotations };
  }

  async function fetchBundle(reviewId) {
    return normalizeBundle(await requestJson(`/api/app/bundle?r=${encodeURIComponent(reviewId)}`));
  }

  async function fetchDocument(filePath) {
    return normalizeDocument(await requestJson(`/api/app/document?path=${encodeURIComponent(filePath)}`));
  }

  async function fetchTabBundle(tab) {
    return isPlain(tab) ? fetchDocument(tab.review.sourceFile) : fetchBundle(tab.id);
  }

  function makeTab(bundle) {
    const normalized = normalizeBundle(bundle);
    const { review, source, annotations } = normalized;
    const tab = {
      id: review.id,
      kind: normalized.kind === 'document' ? 'document' : 'review',
      review,
      source: source.content || '',
      sourceMeta: sourceMetaOf(source),
      sourceHash: source.hash || review.workingHash || review.sourceHash,
      revision: Number(source.revision || review.sourceRevision || 0),
      annotations,
      mode: 'read',
      dirty: false,
      saveRequestId: null,
      scrollTop: 0,
      renderedHash: null,
      outline: [],
      focusedNoteId: null,
      historyOpen: false,
      versions: null,        // 版本事件列表(GET /api/app/document/versions?detail=1),回稿卡与历史分轮的数据源
      versionsKey: '',
      versionsRetryAt: 0,
      openRounds: new Set(), // 历史里展开着的轮
      autoCompare: null,     // 稿子刚回来:等版本记录到了自动打开对比视图(一次)
    };
    const draft = readDraft(tab.id, tab.sourceHash);
    if (draft && draft.content !== tab.source) {
      tab.editorDraft = draft.content;
      tab.dirty = true;
      tab.mode = 'edit';
    }
    return tab;
  }

  // 编码与只读信息(GBK / UTF-16 只读显示):tab.source 是正文字符串,这些放在 tab.sourceMeta
  function sourceMetaOf(source = {}) {
    return { readOnly: Boolean(source.readOnly), readOnlyReason: source.readOnlyReason || '', encoding: source.encoding || 'utf-8', mtimeMs: Number(source.mtimeMs) || null };
  }
  function isReadOnly(tab) { return Boolean(tab && tab.sourceMeta && tab.sourceMeta.readOnly); }

  function draftKey(tabId) { return `draftback.draft.${tabId}`; }

  // localStorage 配额被大草稿占满时 setItem 会抛错;界面偏好这类小东西写不进去也不能让打开/关闭标签中断
  function storeLocal(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }

  function readDraft(tabId, sourceHash) {
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey(tabId)) || 'null');
      if (draft && draft.sourceHash === sourceHash && typeof draft.content === 'string') return draft;
    } catch {}
    return null;
  }

  function persistDraft(tab) {
    if (!tab || !tab.dirty || typeof tab.editorDraft !== 'string') return;
    try {
      localStorage.setItem(draftKey(tab.id), JSON.stringify({
        sourceHash: tab.sourceHash,
        content: tab.editorDraft,
        savedAt: new Date().toISOString(),
      }));
    } catch {
      if (!state.draftWarningShown) {
        state.draftWarningShown = true;
        toast('这篇文档的草稿较大，自动恢复空间不足。请尽快点击“保存”。', 'error');
      }
    }
  }

  function scheduleDraft(tab) {
    const prior = state.draftTimers.get(tab.id);
    if (prior) clearTimeout(prior);
    state.draftTimers.set(tab.id, setTimeout(() => {
      state.draftTimers.delete(tab.id);
      persistDraft(tab);
    }, 220));
  }

  function clearDraft(tab) {
    if (!tab) return;
    const timer = state.draftTimers.get(tab.id);
    if (timer) clearTimeout(timer);
    state.draftTimers.delete(tab.id);
    try { localStorage.removeItem(draftKey(tab.id)); } catch {}
  }

  function persistTabs() {
    const payload = {
      activeId: state.activeId,
      tabs: state.tabs.map((tab) => ({ id: tab.id, path: tab.review.sourceFile, kind: tab.kind })),
    };
    storeLocal('draftback.tabs', JSON.stringify(payload));
  }

  async function restoreTabs() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('draftback.tabs') || '{}'); }
    catch { saved = {}; }
    const entries = Array.isArray(saved.tabs) ? saved.tabs.slice(0, 10) : [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string') continue;
      try {
        const bundle = entry.kind === 'document' ? await fetchDocument(entry.path) : await fetchBundle(entry.id);
        state.tabs.push(makeTab(bundle));
      } catch (_) {}
    }
    state.activeId = state.tabs.some((tab) => tab.id === saved.activeId)
      ? saved.activeId
      : (state.tabs[0] && state.tabs[0].id) || null;
  }

  // 返回审阅摘要(供 reconcileOpenReviews 对账);同时刷新"最近文件"列表(普通打开 ∪ 审阅)。
  async function refreshRecents() {
    let reviews = [];
    try {
      const result = await requestJson('/api/reviews');
      reviews = Array.isArray(result.reviews) ? result.reviews : [];
    } catch (error) {
      nodes.recentList.replaceChildren(emptyBlock(friendlyError(error, '读取最近审阅'), 'recent-empty'));
    }
    try {
      const recent = await requestJson('/api/app/recent');
      state.recents = Array.isArray(recent.items) ? recent.items : [];
      renderRecents();
    } catch (error) {
      nodes.recentList.replaceChildren(emptyBlock(friendlyError(error, '读取最近文件'), 'recent-empty'));
    }
    return reviews;
  }

  function emptyBlock(text, className = 'notes-empty') {
    const item = document.createElement('div'); item.className = className; item.textContent = text; return item;
  }

  function formatDirectory(value) {
    const parts = String(value || '').split('/').filter(Boolean);
    if (parts.length <= 2) return `/${parts.join('/')}`;
    return `…/${parts.slice(-2).join('/')}`;
  }

  function formatRelativeTime(value) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time)) return '';
    const diff = Date.now() - time;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
    if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(time));
  }

  const Drafts = window.DraftbackDrafts;
  function draftRow(row) {
    const { item } = row;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'recent-item draft-row';
    button.title = item.absPath;
    const dot = document.createElement('span'); dot.className = `draft-dot ${row.dot}`; dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.className = 'draft-text';
    const title = document.createElement('strong'); title.textContent = item.file || 'Markdown';
    const meta = document.createElement('span'); meta.textContent = row.subtitle;
    text.append(title, meta);
    button.append(dot, text);
    if (row.unread) { const unread = document.createElement('span'); unread.className = 'draft-unread'; unread.title = '稿子回来了,还没看'; button.appendChild(unread); }
    const active = activeTab();
    if (active && active.review.sourceFile === item.absPath) button.classList.add('current');
    button.disabled = !item.exists;
    button.addEventListener('click', () => (item.activeReview ? openReviewId(item.activeReview.id) : openDocumentPath(item.absPath)));
    return button;
  }
  function renderRecents() {
    const now = Date.now();
    nodes.recentList.replaceChildren();
    nodes.welcomeRecent.replaceChildren();
    if (!state.recents.length) {
      nodes.recentList.appendChild(emptyBlock('还没有稿件。打开一篇 Markdown 后会出现在这里。', 'recent-empty'));
      return;
    }
    for (const group of Drafts.groupDrafts(state.recents, now)) {
      const section = document.createElement('section'); section.className = 'draft-group'; section.dataset.group = group.key;
      const heading = document.createElement('div'); heading.className = 'draft-group-heading';
      const label = document.createElement('span'); label.textContent = group.label;
      const count = document.createElement('span'); count.textContent = String(group.rows.length);
      heading.append(label, count);
      section.appendChild(heading);
      group.rows.forEach((row) => section.appendChild(draftRow(row)));
      nodes.recentList.appendChild(section);
    }
    const welcome = Drafts.welcomeRows(state.recents, now);
    welcome.forEach((row) => nodes.welcomeRecent.appendChild(draftRow(row)));
  }

  // 回稿后看过就记一笔,左栏的未读蓝点消失
  function markSeenIfReturned(tab) {
    if (!tab || isPlain(tab) || tab.review.status !== 'complete' || tab.review.outcome || tab.review.applyMode === 'manual') return;
    const key = `${tab.id}:${tab.review.completedAt || ''}`;
    if (state.seenMarked && state.seenMarked.has(key)) return;
    (state.seenMarked = state.seenMarked || new Set()).add(key);
    const entry = state.recents.find((item) => item.latest && item.latest.id === tab.id && item.latest.unread);
    void requestJson(`/api/app/review/seen?r=${encodeURIComponent(tab.id)}`, { method: 'POST' })
      .then(() => { if (entry) void refreshRecents(); })
      .catch(() => {});
  }

  const Handoff = window.DraftbackHandoff;
  // 能划词批注的状态:批注中;以及普通文档、稿子回来后、本轮作废后——这三种在首次成功保存批注时自动开轮(规则③)
  const ANNOTATABLE = new Set(['plain', 'reviewing', 'complete', 'cancelled']);

  function statusLabel(status, applyMode = '', outcome = '') {
    return Handoff.statusLabel(status, applyMode, outcome);
  }

  async function chooseMarkdown() {
    let paths = [];
    if (bridge && typeof bridge.pickMarkdown === 'function') {
      try { paths = await bridge.pickMarkdown(); }
      catch (error) { toast(`打开文件失败：${error.message || error}`, 'error'); }
    } else {
      const candidate = window.prompt('请输入 Markdown 文件的绝对路径：');
      if (candidate) paths = [candidate];
    }
    await openPaths(paths);
  }

  async function openPaths(paths) {
    for (const filePath of Array.isArray(paths) ? paths : []) {
      if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.md')) continue;
      await openDocumentPath(filePath);
    }
  }

  // 普通打开:不建会话、不冻结。文档已有活动审阅会话(通常是智能体 mdreview open 建的)时直接进那个会话。
  async function openDocumentPath(filePath) {
    try {
      const payload = await requestJson('/api/app/document/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
      });
      // 有活动会话进活动会话;没有活动会话但有审阅记录(稿子回来了 / 已通过 / 已恢复 / 已定稿 / 已作废)进最新一轮,
      // 回稿卡、历史、对比视图才看得到。只有从没审阅过的文档才按普通文档打开。
      const session = (payload.activeReview && payload.activeReview.id) ? payload.activeReview : (payload.latestReview && payload.latestReview.id ? payload.latestReview : null);
      if (session) {
        await openReviewId(session.id);
        await refreshRecents();
        return;
      }
      upsertTab(normalizeDocument(payload), { activate: true });
      await refreshRecents();
    } catch (error) { toast(friendlyError(error, '打开文档'), 'error'); }
  }

  async function setEditing(tab, editing) {
    if (!tab || !isPlain(tab)) return;
    try {
      await requestJson('/api/app/document/editing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: tab.review.sourceFile, editing, token: editingToken() }),
      });
      tab.editingRegistered = editing;
    } catch (error) { if (editing) toast(friendlyError(error, '登记编辑状态'), 'error'); }
  }

  async function openReviewPath(filePath) {
    try {
      const result = await requestJson('/api/app/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
      });
      const bundle = await fetchBundle(result.review.id);
      upsertTab(bundle, { activate: true });
      await refreshRecents();
    } catch (error) { toast(friendlyError(error, '打开文档'), 'error'); }
  }

  async function openReviewId(reviewId) {
    const existing = state.tabs.find((tab) => tab.id === reviewId);
    if (existing) return activateTab(existing.id);
    try {
      const bundle = await fetchBundle(reviewId);
      upsertTab(bundle, { activate: true });
    } catch (error) { toast(friendlyError(error, '打开审阅'), 'error'); }
  }

  function upsertTab(bundle, options = {}) {
    const next = makeTab(bundle);
    const byPath = tabByPath(next.review.sourceFile);
    const byId = state.tabs.find((tab) => tab.id === next.id);
    const existing = byId || byPath;
    if (existing) {
      if (existing.dirty) {
        if (existing.id !== next.id) toast('这个文档还有未保存的编辑，暂未切换到新一轮。', 'error');
        state.activeId = existing.id;
        persistTabs();
        renderApp();
        return existing;
      }
      const index = state.tabs.indexOf(existing);
      if (existing.editingRegistered && existing.id !== next.id) void setEditing(existing, false);
      // Reopening the same session may preserve its view.  A new review round
      // for the same file must always return to frozen read mode instead of
      // inheriting an old edit-mode tab.
      if (existing.id === next.id) {
        next.mode = existing.mode;
        next.scrollTop = existing.scrollTop;
        next.editingRegistered = existing.editingRegistered; // 否则关标签时不会注销编辑登记,智能体一直被 USER_EDITING 挡住
      }
      state.tabs.splice(index, 1, next);
    } else {
      state.tabs.push(next);
    }
    if (options.activate !== false) state.activeId = next.id;
    persistTabs();
    renderApp();
    return next;
  }

  function applyBundleToTab(tab, bundle, options = {}) {
    const normalized = normalizeBundle(bundle);
    const changed = normalized.source.hash !== tab.sourceHash;
    tab.review = normalized.review;
    tab.annotations = normalized.annotations;
    tab.revision = Number(normalized.source.revision || normalized.review.sourceRevision || tab.revision || 0);
    tab.sourceMeta = sourceMetaOf(normalized.source);
    if (changed || options.forceSource) {
      tab.source = normalized.source.content;
      tab.sourceHash = normalized.source.hash;
      tab.renderedHash = null;
      // 编辑器正开着这篇(且没有未保存修改)时,把新正文灌进去;否则编辑器里还是旧文,
      // 下次保存会把别处(智能体、VS Code)的改动当成"用户修改"覆盖回去。
      if (changed && state.editorTabId === tab.id && !tab.dirty) syncEditorToSource(tab);
    }
    tab.remotePending = null;
    if (tab.id === state.activeId) renderApp(); else renderTabs();
    return { tab, normalized, changed };
  }

  function syncEditorToSource(tab) {
    if (state.editorView && window.DraftbackEditor && state.editorView.__draftbackFallback !== true) {
      try { window.DraftbackEditor.setValue(state.editorView, editorBody(tab.source)); return; } catch (_) {}
    }
    destroyEditor(); // 退化编辑器或灌入失败:销毁后由 renderEditor 按新正文重建
  }

  async function refreshTab(tab, options = {}) {
    if (!tab || tab.dirty) return tab;
    try {
      const bundle = await fetchTabBundle(tab);
      if (isPlain(tab) && bundle.activeReview && bundle.activeReview.id) {
        // 别处(通常是智能体)已为这篇文档建了审阅会话:把普通标签换成会话标签。
        await queueRemoteReviewChange(bundle.activeReview.id, { reason: 'document-now-reviewing', forceSource: true });
        return tab;
      }
      applyBundleToTab(tab, bundle, options);
      return tab;
    } catch (error) {
      if (!options.silent) toast(friendlyError(error, '刷新文档'), 'error');
      if (options.throwOnError) throw error;
      return tab;
    }
  }

  function reviewNeedsRefresh(tab, summary) {
    if (!tab || !summary || tab.dirty) return false;
    if (summary.status !== tab.review.status || (summary.applyMode || '') !== (tab.review.applyMode || '')) return true;
    if ((summary.agentState || null) !== (tab.review.agentState || null)) return true;
    if (Number.isInteger(summary.openCount) && summary.openCount !== openAnnotations(tab).length) return true;
    const remoteHash = summary.workingHash || summary.finalHash || summary.currentHash;
    if (remoteHash && remoteHash !== tab.sourceHash) return true;
    const remoteRevision = Number(summary.sourceRevision || 0);
    return remoteRevision > Number(tab.revision || 0);
  }

  function completionHistory() {
    if (state.announcedCompletions) return state.announcedCompletions;
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('draftback.announcedCompletions') || '[]'); } catch (_) {}
    state.announcedCompletions = new Set(Array.isArray(saved) ? saved.filter((item) => typeof item === 'string') : []);
    return state.announcedCompletions;
  }

  function completionKey(review) {
    if (!review || review.status !== 'complete' || !review.id) return null;
    const token = review.completedAt || review.finalHash || review.workingHash || review.sourceRevision || 'complete';
    return `${review.id}:${token}`;
  }

  function markCompletionAnnounced(review) {
    const key = completionKey(review);
    if (!key) return false;
    const history = completionHistory();
    if (history.has(key)) return false;
    history.add(key);
    const recent = [...history].slice(-80);
    state.announcedCompletions = new Set(recent);
    try { localStorage.setItem('draftback.announcedCompletions', JSON.stringify(recent)); } catch (_) {}
    return true;
  }

  function isVerifiedAgentCompletion(review, options = {}, priorStatus = '', priorMode = '') {
    if (!review || review.status !== 'complete') return false;
    if (review.applyMode === 'manual') return false;
    if (review.applyMode === 'agent') return true;
    if (options.reason === 'agent-complete') return true;
    return priorStatus === 'applying' && priorMode !== 'manual';
  }

  function completionCounts(review) {
    const tab = state.tabs.find((candidate) => candidate.id === review.id);
    const members = tab ? tab.annotations.filter((note) => note.reviewSessionId === review.id) : [];
    if (!members.length) return null;
    return { applied: members.filter((note) => effectiveStatus(note) === 'applied').length, wontfix: members.filter((note) => effectiveStatus(note) === 'wontfix').length };
  }
  async function announceAgentCompletion(review) {
    if (!review || !markCompletionAnnounced(review)) return;
    const title = review.title || review.file || '当前文档';
    const counts = completionCounts(review);
    const round = Number.isInteger(review.round) ? `第 ${review.round} 轮` : '';
    const message = `《${title}》${round}回稿${counts ? ` · 采纳 ${counts.applied} · 未采纳 ${counts.wontfix}` : ''}。已换成最新版。`;
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      toast(message);
      return;
    }
    if (bridge && typeof bridge.notifyReviewComplete === 'function') {
      try {
        const shown = await bridge.notifyReviewComplete({ reviewId: review.id, title, round: Number.isInteger(review.round) ? review.round : null, counts });
        if (shown) return;
      } catch (_) {}
    }
    toast(message);
  }

  function mergeRemoteChange(previous = {}, next = {}) {
    return {
      forceSource: previous.forceSource === true || next.forceSource === true,
      reason: next.reason || previous.reason || 'review-changed',
      attempt: Math.max(Number(previous.attempt || 0), Number(next.attempt || 0)),
    };
  }

  function markRemotePending(tab, reviewId, options = {}, error = null) {
    if (!tab) return;
    const first = !tab.remotePending;
    tab.remotePending = {
      reviewId,
      forceSource: options.forceSource === true,
      reason: options.reason || 'review-changed',
      failed: Boolean(error),
    };
    if (tab.id === state.activeId) renderStatus(tab); else renderTabs();
    if (first) {
      const title = tab.review.title || tab.review.file || '当前文档';
      toast(error
        ? `《${title}》有远程更新，暂时未能同步，回稿会自动重试。`
        : `《${title}》有远程更新。未保存草稿已保护，保存后会立即同步。`);
    }
  }

  function clearRemoteRetry(reviewId) {
    const timer = state.remoteRetryTimers.get(reviewId);
    if (timer) clearTimeout(timer);
    state.remoteRetryTimers.delete(reviewId);
  }

  function scheduleRemoteRetry(reviewId, options = {}) {
    if (state.remoteRetryTimers.has(reviewId) || Number(options.attempt || 0) > 5) return;
    const delay = Math.min(16_000, 1000 * (2 ** Math.max(0, Number(options.attempt || 0) - 1)));
    const timer = setTimeout(() => {
      state.remoteRetryTimers.delete(reviewId);
      void queueRemoteReviewChange(reviewId, options);
    }, delay);
    state.remoteRetryTimers.set(reviewId, timer);
  }

  async function applyRemoteReviewChangeNow(reviewId, options = {}) {
    let bundle;
    try {
      bundle = await fetchBundle(reviewId);
    } catch (error) {
      const tab = state.tabs.find((candidate) => candidate.id === reviewId);
      markRemotePending(tab, reviewId, options, error);
      scheduleRemoteRetry(reviewId, { ...options, attempt: Number(options.attempt || 0) + 1 });
      return;
    }

    clearRemoteRetry(reviewId);
    const normalized = normalizeBundle(bundle);
    let tab = state.tabs.find((candidate) => candidate.id === reviewId);
    if (!tab) {
      const sameFile = tabByPath(normalized.review.sourceFile);
      if (sameFile && sameFile.dirty) {
        markRemotePending(sameFile, reviewId, options);
        return;
      }
      if (sameFile) {
        const wasActive = sameFile.id === state.activeId;
        tab = upsertTab(normalized, { activate: wasActive });
      } else {
        await refreshRecents();
        if (isVerifiedAgentCompletion(normalized.review, options)) {
          await announceAgentCompletion(normalized.review);
        }
        return;
      }
    }

    if (tab.dirty) {
      markRemotePending(tab, reviewId, options);
      return;
    }
    if (tab.id === state.activeId && tab.mode === 'read') tab.scrollTop = nodes.readerScroll.scrollTop;
    const priorStatus = tab.review.status;
    const priorMode = tab.review.applyMode;
    applyBundleToTab(tab, normalized, { forceSource: options.forceSource === true });
    await refreshRecents();
    if (isVerifiedAgentCompletion(tab.review, options, priorStatus, priorMode)) {
      // 稿子回来是一个时刻:正在看这篇就默认打开对比视图一次(等版本记录到了再开,见 maybeAutoCompare);
      // 只在从非完成态转入时触发,同一次完成再刷新不重开——用户关掉了就是关掉了
      const key = completionKey(tab.review);
      if (tab.id === state.activeId && tab.mode === 'read' && priorStatus !== 'complete' && key && !autoComparedKeys().has(key)) {
        autoComparedKeys().add(key); tab.autoCompare = key; renderNotes(tab);
      }
      await announceAgentCompletion(tab.review);
    }
  }

  function queueRemoteReviewChange(reviewId, options = {}) {
    if (typeof reviewId !== 'string' || !reviewId) return Promise.resolve();
    clearRemoteRetry(reviewId);
    state.remoteChanges.set(reviewId, mergeRemoteChange(state.remoteChanges.get(reviewId), options));
    if (state.remoteRefreshes.has(reviewId)) return state.remoteRefreshes.get(reviewId);
    const task = (async () => {
      while (state.remoteChanges.has(reviewId)) {
        const pending = state.remoteChanges.get(reviewId);
        state.remoteChanges.delete(reviewId);
        await applyRemoteReviewChangeNow(reviewId, pending);
      }
    })().finally(() => state.remoteRefreshes.delete(reviewId));
    state.remoteRefreshes.set(reviewId, task);
    return task;
  }

  async function reconcileOpenReviews() {
    if (state.reconciling) return;
    state.reconciling = true;
    try {
      const reviews = await refreshRecents();
      const summaries = new Map(reviews.map((review) => [review.id || review.sessionId, review]));
      const latestByPath = new Map(reviews.map((review) => [review.sourceFile || review.absPath, review]));
      const updates = [];
      const ACTIVE = new Set(['reviewing', 'ready_to_apply', 'applying', 'conflict']);
      for (const tab of state.tabs.slice()) {
        const summary = summaries.get(tab.id);
        const latest = latestByPath.get(tab.review.sourceFile);
        if (isPlain(tab)) {
          if (latest && ACTIVE.has(latest.status)) {
            updates.push(queueRemoteReviewChange(latest.id || latest.sessionId, { reason: 'document-now-reviewing', forceSource: true }));
          } else if (!tab.dirty) {
            updates.push(refreshTab(tab, { silent: true }));
          }
          continue;
        }
        if (latest && (latest.id || latest.sessionId) !== tab.id) {
          updates.push(queueRemoteReviewChange(latest.id || latest.sessionId, {
            reason: 'reconcile-new-round', forceSource: true,
          }));
          continue;
        }
        if (!summary) {
          updates.push(queueRemoteReviewChange(tab.id, { reason: 'reconcile-probe' }));
          continue;
        }
        if (!reviewNeedsRefresh(tab, summary)) continue;
        updates.push(queueRemoteReviewChange(tab.id, {
          reason: 'reconcile',
          forceSource: summary.status === 'complete' ||
            Boolean((summary.workingHash || summary.finalHash) && (summary.workingHash || summary.finalHash) !== tab.sourceHash),
        }));
      }
      await Promise.allSettled(updates);
    } finally {
      state.reconciling = false;
    }
  }

  function handleReviewEvent(event) {
    let payload;
    try { payload = JSON.parse(event.data || '{}'); } catch { return; }
    const reviewId = payload.reviewSessionId || payload.reviewId || payload.sessionId;
    if (typeof reviewId !== 'string' || !reviewId) return;
    // CLI 的 mdreview open 走事件流直接把标签打开——不依赖 macOS 的"打开文件"事件,
    // 两条通道任一条通就能进文档。
    if (payload.reason === 'cli-open') {
      if (state.tabs.some((tab) => tab.id === reviewId)) activateTab(reviewId);
      else void openReviewId(reviewId);
      return;
    }
    void queueRemoteReviewChange(reviewId, {
      reason: payload.reason || 'review-changed',
      forceSource: ['agent-complete', 'manual-complete', 'review-approved', 'review-completed', 'complete'].includes(payload.reason),
    });
  }

  function installReviewEvents() {
    if (typeof EventSource === 'function') {
      state.eventSource = new EventSource('/api/app/events');
      state.eventSource.addEventListener('review-changed', handleReviewEvent);
      state.eventSource.addEventListener('open', () => { void reconcileOpenReviews(); });
      state.eventSource.addEventListener('error', () => {
        // EventSource reconnects automatically; persisted review state remains authoritative.
      });
    }
    state.reconcileTimer = setInterval(() => { void reconcileOpenReviews(); }, 60_000);
    state.presenceTimer = setInterval(() => {
      const tab = activeTab();
      if (tab && !isPlain(tab) && tab.review.status === 'ready_to_apply' && !tab.dirty) void refreshTab(tab, { silent: true });
    }, 30_000);
  }

  function activateTab(id) {
    const current = activeTab();
    if (current) {
      current.scrollTop = nodes.readerScroll.scrollTop;
      captureEditorValue(current);
    }
    if (!state.tabs.some((tab) => tab.id === id)) return;
    state.activeId = id;
    state.cachedAnchor = null;
    nodes.annotate.hidden = true;
    persistTabs();
    renderApp();
    void refreshTab(activeTab(), { silent: true });
  }

  async function closeTab(id) {
    const tab = state.tabs.find((item) => item.id === id);
    if (!tab) return;
    if (!nodes.annotationDialog.hidden && state.dialog && state.dialog.tabId === id) {
      toast('请先保存或取消正在编辑的批注。', 'error');
      return;
    }
    captureEditorValue(tab);
    if (tab.dirty) {
      const discard = await confirmAction('舍弃未保存的修改？', '关闭标签页会丢失尚未保存的 Markdown 修改。', '舍弃并关闭');
      if (!discard) return;
      clearDraft(tab);
    }
    if (tab.editingRegistered) void setEditing(tab, false);
    if (Compare.isOpen() && Compare.current().tabId === id) Compare.close();
    const index = state.tabs.indexOf(tab);
    state.tabs.splice(index, 1);
    if (state.editorTabId === id) destroyEditor();
    if (state.activeId === id) state.activeId = (state.tabs[index] || state.tabs[index - 1] || {}).id || null;
    persistTabs();
    renderApp();
  }

  function commandBlocked() {
    if (!nodes.annotationDialog.hidden) {
      toast('请先保存或取消正在编辑的批注。', 'error');
      return true;
    }
    if (!nodes.confirmDialog.hidden) {
      toast('请先完成当前确认操作。', 'error');
      return true;
    }
    return false;
  }

  function applyReaderZoom() {
    nodes.content.style.zoom = state.readerZoom === 1 ? '' : String(state.readerZoom);
    // 编辑态正文经 CSS 变量吃同一个缩放值(元素是异步创建的,变量天然免时序问题)
    document.documentElement.style.setProperty('--reader-zoom', String(state.readerZoom));
    scheduleMarkerPositions();
  }

  function setReaderZoom(next) {
    const zoom = Math.min(2.2, Math.max(0.6, next));
    if (zoom === state.readerZoom) return;
    state.readerZoom = zoom;
    storeLocal('draftback.readerZoom', String(zoom));
    applyReaderZoom();
  }

  const PLATFORM = (bridge && bridge.platform) || (/Mac/i.test(navigator.platform || '') ? 'darwin' : 'other');
  const ACTION_ITEMS = Actions ? Actions.flatten() : [];
  // 只在条件满足时才接管的快捷键
  const KEY_GUARDS = {
    'compare-prev': () => Compare.isOpen(),
    'compare-next': () => Compare.isOpen(),
    'note-prev': () => { const tab = activeTab(); return !!tab && tab.mode === 'read' && !Compare.isOpen(); },
    'note-next': () => { const tab = activeTab(); return !!tab && tab.mode === 'read' && !Compare.isOpen(); },
    primary: () => !nodes.primaryAction.hidden && !nodes.primaryAction.disabled,
  };

  // 对话框开着时仍然可以用的命令(不动正文与会话)
  const MODAL_SAFE_COMMANDS = new Set(['zoom-in', 'zoom-out', 'zoom-reset', 'help-shortcuts', 'help-feedback']);
  function handleDesktopCommand(command) {
    if (typeof command !== 'string' || !command) return;
    if (modalOpen() && !MODAL_SAFE_COMMANDS.has(command)) {
      if (!nodes.quickOpen.hidden || !nodes.settingsDialog.hidden || !nodes.infoDialog.hidden) closePanels();
      else { commandBlocked(); return; }
    }
    if (command === 'open') {
      void chooseMarkdown();
      return;
    }
    if (command === 'save') {
      if (!nodes.annotationDialog.hidden || !nodes.confirmDialog.hidden) return;
      void saveSource();
      return;
    }
    if (command === 'close-tab') {
      const tab = activeTab();
      if (tab) void closeTab(tab.id);
      return;
    }
    if (command === 'zoom-in') { setReaderZoom(state.readerZoom * 1.1); return; }
    if (command === 'zoom-out') { setReaderZoom(state.readerZoom / 1.1); return; }
    if (command === 'zoom-reset') { setReaderZoom(1); return; }
    if (command === 'find') { openFind(); return; }
    if (command === 'find-next') { stepFind(1); return; }
    if (command === 'find-prev') { stepFind(-1); return; }
    if (command === 'export-pdf') { void exportPdf(); return; }
    if (command === 'export-html') { void exportHtml(); return; }
    if (command === 'export-docx') { void exportDocx(); return; }
    if (command === 'new') { void newDocument(); return; }
    const dialogOpen = !nodes.annotationDialog.hidden || !nodes.confirmDialog.hidden;
    if (command.startsWith('compare-') && dialogOpen) return; // 对话框开着时菜单发来的对比命令也不动它背后的视图
    if (command === 'compare-toggle') { toggleCompare(); return; }
    if (command === 'compare-prev' || command === 'compare-next') {
      if (!Compare.isOpen()) { toggleCompare(); return; }
      Compare.step(command === 'compare-prev' ? -1 : 1); return;
    }
    if (command === 'show-return-card') {
      const tab = activeTab();
      if (!tab || nodes.returnCard.hidden) { toast('现在没有回稿卡:稿子回来、通过或恢复后才会出现。'); return; }
      toggleRight(false); nodes.returnCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
    }
    if (command === 'restore-round') {
      const tab = activeTab();
      if (!tab || isPlain(tab)) { toast('普通文档没有轮次,没有可恢复的改稿。'); return; }
      tab.historyOpen = true; toggleRight(false); renderNotes(tab);
      nodes.historyNotesList.scrollTop = 0;
      toast('在右栏「历史」里选一轮,点「恢复到这轮改稿前」。'); return;
    }
    if (command === 'timeline') { toggleTimeline(); return; }
    if (command === 'print') { void printDocument(); return; }
    if (command === 'find-replace') { openFind({ replace: true }); return; }
    if (command === 'quick-open') { openQuickOpen(); return; }
    if (command === 'save-copy') { void saveCopy(); return; }
    if (command === 'reveal') { revealActive(); return; }
    if (command === 'settings') { void openSettings(); return; }
    if (command === 'toggle-mode') { void toggleMode(); return; }
    if (command === 'toggle-left') { toggleLeft(); return; }
    if (command === 'toggle-right') { toggleRight(); return; }
    if (command === 'left-files') { toggleLeft(false); setLeftMode('files'); return; }
    if (command === 'left-outline') { toggleLeft(false); setLeftMode('outline'); return; }
    if (command === 'annotate') { annotateSelection(); return; }
    if (command === 'doc-note') { openDocNote(); return; }
    if (command === 'note-prev' || command === 'note-next') { stepNote(command === 'note-prev' ? -1 : 1); return; }
    if (command === 'primary') { handlePrimaryAction(); return; }
    if (command === 'manual-edit') { void runAction('manual-edit'); return; }
    if (command === 'finish-manual') { void finishManualApply(); return; }
    if (command === 'finalize') {
      const action = nodes.primaryAction.dataset.action;
      if (action === 'approve' || action === 'finalize') void runAction(action);
      return;
    }
    if (command === 'tab-prev' || command === 'tab-next') { stepTab(command === 'tab-prev' ? -1 : 1); return; }
    if (command === 'import-batch') { void importBatchFromMenu(); return; }
    if (command === 'help-guide') { void openHelp('guide'); return; }
    if (command === 'help-ai') { void openHelp('ai'); return; }
    if (command === 'help-shortcuts') { showShortcuts(); return; }
    if (command === 'help-feedback') { openFeedback(); return; }
    if (command.startsWith('format:')) { runFormat(command.slice('format:'.length)); return; }
    if (command.startsWith('appearance:') && bridge && typeof bridge.setAppearance === 'function') { void bridge.setAppearance(command.slice('appearance:'.length)); }
  }

  // ---------- 新建 ----------
  // 外壳只负责让用户选位置;文件由本地服务创建(已存在绝不覆盖,而是直接打开它),建好即进入编辑。
  async function newDocument() {
    if (commandBlocked()) return;
    let filePath = '';
    if (bridge && typeof bridge.newDocument === 'function') {
      try {
        const picked = await bridge.newDocument({ directory: posixDir(activeTab()?.review.sourceFile || '') });
        if (!picked || !picked.ok) return;
        filePath = picked.filePath;
      } catch (error) { toast(`新建失败:${error.message || error}`, 'error'); return; }
    } else {
      filePath = window.prompt('请输入要新建的 Markdown 文件绝对路径：') || '';
      if (!filePath.trim()) return;
    }
    try {
      const payload = await requestJson('/api/app/document/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
      });
      upsertTab(normalizeDocument(payload), { activate: true });
      await refreshRecents();
      await enterEditMode();
      toast(`已新建《${payload.document.file}》。`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { toast('这个文件已经存在,未覆盖,已直接打开它。'); await openDocumentPath(filePath); return; }
      toast(friendlyError(error, '新建文档'), 'error');
    }
  }

  // ---------- 导出 HTML(单文件) ----------
  // 正文取当前渲染结果;样式只带 desktop.css 里 :root 变量与 .markdown-body 规则(浅色),
  // 代码高亮与公式样式整份内联,公式字体内联成 data: URI;图片读回来内联。文件可脱离回稿单独打开与发送。
  async function fetchAsDataUrl(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  function collectExportCss() {
    const parts = [];
    for (const sheet of Array.from(document.styleSheets)) {
      if (!/desktop\.css/.test(sheet.href || '')) continue;
      let rules; try { rules = Array.from(sheet.cssRules); } catch { continue; }
      for (const rule of rules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        if (rule.selectorText === ':root' || /\.markdown-body/.test(rule.selectorText)) parts.push(rule.cssText);
      }
    }
    return parts.join('\n');
  }
  async function katexCssInlined() {
    let css = await (await fetch('/static/vendor/katex.min.css', { cache: 'no-store' })).text();
    const fonts = Array.from(new Set(Array.from(css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g), (m) => m[1])));
    const data = new Map();
    await Promise.all(fonts.map(async (name) => { try { data.set(name, await fetchAsDataUrl(`/static/vendor/fonts/${name}`)); } catch (_) {} }));
    // 每个 @font-face 只留 woff2 一种来源,其余(woff/ttf)去掉
    css = css.replace(/src:url\(fonts\/([^)]+\.woff2)\) format\("woff2"\)[^;}]*/g, (whole, name) => (data.has(name) ? `src:url(${data.get(name)}) format("woff2")` : whole));
    return css;
  }
  function escapeHtml(value) { return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
  async function buildStandaloneHtml(tab) {
    const article = document.getElementById('documentContent').cloneNode(true);
    article.removeAttribute('id');
    // 导出的是干净的正文:不带阅读缩放、批注图钉、查找高亮这些界面状态
    article.removeAttribute('style');
    article.querySelectorAll('.note-pin, mark.search-hit').forEach((el) => {
      if (el.tagName === 'MARK') el.replaceWith(...el.childNodes); else el.remove();
    });
    article.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
    await Promise.all(Array.from(article.querySelectorAll('img[src]')).map(async (image) => {
      const src = image.getAttribute('src') || '';
      if (!src.startsWith('/api/app/file')) return;
      try { image.setAttribute('src', await fetchAsDataUrl(src)); }
      catch (_) { image.setAttribute('src', image.dataset.sourceSrc || src); }
      image.removeAttribute('loading');
    }));
    article.querySelectorAll('a[href]').forEach((link) => {
      if (link.dataset.sourceHref) { link.setAttribute('href', link.dataset.sourceHref); link.removeAttribute('target'); link.removeAttribute('rel'); }
    });
    const vendor = [await (await fetch('/static/vendor/highlight-github.min.css', { cache: 'no-store' })).text()];
    if (article.querySelector('.katex')) vendor.push(await katexCssInlined());
    const title = tab.review.title || 'Markdown';
    return [
      '<!doctype html>', '<html lang="zh-CN">', '<head>', '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="generator" content="Draftback">',
      `<title>${escapeHtml(title)}</title>`,
      `<style>${vendor.join('\n')}</style>`,
      `<style>${collectExportCss()}</style>`,
      '<style>html{background:#ffffff}body{margin:0;padding:40px 24px;background:#ffffff;color:var(--text)}.markdown-body{max-width:820px;margin:0 auto}@media print{body{padding:0}}</style>',
      '</head>', '<body>', `<article class="markdown-body">${article.innerHTML}</article>`, '</body>', '</html>',
    ].join('\n');
  }
  async function exportHtml() {
    const tab = activeTab();
    if (!tab) { toast('先打开一篇文档再导出。', 'error'); return; }
    if (tab.mode === 'edit') { toast('请先回到阅读模式再导出 HTML。', 'error'); return; }
    let html;
    try { html = await buildStandaloneHtml(tab); }
    catch (error) { toast(`生成 HTML 失败:${error.message || error}`, 'error'); return; }
    const suggestedName = (tab.review.title || 'document').replace(/\.md$/i, '');
    if (bridge && typeof bridge.exportHtml === 'function') {
      try {
        const result = await bridge.exportHtml({ html, suggestedName, directory: posixDir(tab.review.sourceFile || '') });
        if (result && result.ok) toast('HTML 已导出。');
      } catch (error) { toast(`导出 HTML 失败:${error.message || error}`, 'error'); }
      return;
    }
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${suggestedName}.html`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    toast('HTML 已导出。');
  }

  // ---------- 导出 Word ----------
  // 从磁盘上的源文件转换(由主进程调 pandoc),所以要先保存。
  async function exportDocx() {
    const tab = activeTab();
    if (!tab) { toast('先打开一篇文档再导出。', 'error'); return; }
    if (tab.mode === 'edit') captureEditorValue(tab);
    if (tab.dirty) { toast('有未保存的修改,请先按 ⌘S 保存,再导出 Word。', 'error'); return; }
    if (!bridge || typeof bridge.exportDocx !== 'function') { toast('导出 Word 需要在回稿应用里使用。', 'error'); return; }
    try {
      const result = await bridge.exportDocx({ sourcePath: tab.review.sourceFile, suggestedName: tab.review.title || 'document' });
      if (result && result.ok) toast('Word 已导出。');
      else if (result && result.error) toast(`导出 Word 失败:${result.error}`, 'error');
    } catch (error) { toast(`导出 Word 失败:${error.message || error}`, 'error'); }
  }

  // ---------- 导出菜单 ----------
  function toggleExportMenu(force) {
    const open = typeof force === 'boolean' ? force : nodes.exportMenu.hidden;
    nodes.exportMenu.hidden = !open;
    nodes.exportMenuButton.setAttribute('aria-expanded', String(open));
    if (open) { const first = nodes.exportMenu.querySelector('button'); if (first) first.focus(); }
  }
  function toggleToolbarMore(force) {
    const open = typeof force === 'boolean' ? force : nodes.toolbarMoreMenu.hidden;
    nodes.toolbarMoreMenu.hidden = !open;
    nodes.toolbarMoreButton.setAttribute('aria-expanded', String(open));
  }
  function installExportMenu() {
    nodes.toolbarMoreButton.addEventListener('click', (event) => { event.stopPropagation(); toggleToolbarMore(); });
    nodes.toolbarMoreMenu.addEventListener('click', (event) => {
      const item = event.target.closest('button[data-command]');
      if (!item) return;
      toggleToolbarMore(false);
      handleDesktopCommand(item.dataset.command);
    });
    document.addEventListener('click', (event) => { if (!nodes.toolbarMoreMenu.hidden && !event.target.closest('#toolbarMoreMenu, #toolbarMoreButton')) toggleToolbarMore(false); });
    nodes.exportMenuButton.addEventListener('click', (event) => { event.stopPropagation(); toggleExportMenu(); });
    nodes.exportMenu.addEventListener('click', (event) => {
      const item = event.target.closest('button[data-command]');
      if (!item) return;
      toggleExportMenu(false);
      handleDesktopCommand(item.dataset.command);
    });
    document.addEventListener('click', (event) => { if (!nodes.exportMenu.hidden && !event.target.closest('#exportMenu, #exportMenuButton')) toggleExportMenu(false); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !nodes.exportMenu.hidden) { toggleExportMenu(false); nodes.exportMenuButton.focus(); } });
  }

  // ---------- 查找(阅读模式,正文内) ----------
  const find = { query: '', ranges: [], index: -1 };
  function findSupported() { return !!(globalThis.CSS && CSS.highlights && globalThis.Highlight); }
  // 编辑模式的查找替换走编辑器(ProseMirror 文档),阅读模式在渲染后的正文里找
  function editorFindReady() {
    return !!(state.editorView && window.DraftbackEditor && state.editorView.__draftbackFallback !== true && typeof window.DraftbackEditor.find === 'function');
  }
  function inEditFind() { const tab = activeTab(); return !!tab && tab.mode === 'edit' && editorFindReady(); }
  function openFind(options = {}) {
    const tab = activeTab();
    if (!tab) return;
    const editing = tab.mode === 'edit';
    if (editing && !editorFindReady()) { toast('编辑器还没准备好,稍后再试。'); return; }
    if (options.replace && !editing) { toast('替换只在编辑模式里可用。先点「编辑」(⌘/)。'); }
    nodes.findBar.hidden = false;
    nodes.replaceRow.hidden = !editing;
    const selected = editing ? window.DraftbackEditor.selectedText(state.editorView).trim() : String(window.getSelection() || '').trim();
    if (selected && selected.length <= 80 && !selected.includes('\n')) nodes.findInput.value = selected;
    nodes.findInput.focus(); nodes.findInput.select();
    runFind();
  }
  function closeFind() {
    const editing = inEditFind();
    nodes.findBar.hidden = true;
    clearFind();
    if (editing) window.DraftbackEditor.focus(state.editorView);
    else nodes.readerScroll.focus?.();
  }
  function clearFind() {
    if (editorFindReady()) window.DraftbackEditor.clearFind(state.editorView);
    find.ranges = []; find.index = -1; find.query = '';
    if (findSupported()) { CSS.highlights.delete('draftback-find'); CSS.highlights.delete('draftback-find-current'); }
    nodes.findCount.textContent = '0 / 0'; nodes.findBar.classList.remove('no-match');
  }
  function textNodesOf(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement && node.parentElement.closest('script, style, .note-pin') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes_ = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes_.push(node);
    return nodes_;
  }
  // 跨文本节点匹配:把正文拼成一串,记录每个字符落在哪个节点的哪个偏移。
  function showEditorFind(result) {
    const count = result ? result.count : 0;
    nodes.findCount.textContent = count ? `${result.index + 1} / ${count}` : '0 / 0';
    nodes.findBar.classList.toggle('no-match', Boolean(nodes.findInput.value) && !count);
    nodes.replaceOne.disabled = !count; nodes.replaceAll.disabled = !count;
  }
  function runFind() {
    const query = nodes.findInput.value;
    const tab = activeTab();
    if (inEditFind()) { showEditorFind(window.DraftbackEditor.find(state.editorView, query)); return; }
    if (!tab || tab.mode !== 'read' || !query) { clearFind(); return; }
    const textNodes = textNodesOf(nodes.content);
    const pieces = []; let whole = '';
    for (const node of textNodes) { pieces.push({ node, start: whole.length, end: whole.length + node.data.length }); whole += node.data; }
    const haystack = whole.toLowerCase(); const needle = query.toLowerCase();
    const ranges = [];
    const locate = (offset) => {
      let low = 0, high = pieces.length - 1;
      while (low < high) { const mid = (low + high) >> 1; if (pieces[mid].end <= offset) low = mid + 1; else high = mid; }
      return pieces[low];
    };
    for (let at = haystack.indexOf(needle); at !== -1 && ranges.length < 2000; at = haystack.indexOf(needle, at + needle.length)) {
      const from = locate(at), to = locate(at + needle.length - 1);
      if (!from || !to) break;
      const range = document.createRange();
      range.setStart(from.node, at - from.start); range.setEnd(to.node, at + needle.length - to.start);
      ranges.push(range);
    }
    const keepIndex = find.query === query ? find.index : -1;
    find.query = query; find.ranges = ranges;
    find.index = ranges.length ? Math.min(Math.max(keepIndex, 0), ranges.length - 1) : -1;
    if (findSupported()) CSS.highlights.set('draftback-find', new Highlight(...ranges));
    nodes.findBar.classList.toggle('no-match', !ranges.length);
    highlightCurrentFind(true);
  }
  function highlightCurrentFind(scroll) {
    if (!find.ranges.length || find.index < 0) {
      if (findSupported()) CSS.highlights.delete('draftback-find-current');
      nodes.findCount.textContent = `0 / ${find.ranges.length}`; return;
    }
    const current = find.ranges[find.index];
    if (findSupported()) CSS.highlights.set('draftback-find-current', new Highlight(current));
    nodes.findCount.textContent = `${find.index + 1} / ${find.ranges.length}`;
    if (scroll) {
      const rect = current.getBoundingClientRect();
      const host = nodes.readerScroll.getBoundingClientRect();
      if (rect.top < host.top + 40 || rect.bottom > host.bottom - 40) {
        nodes.readerScroll.scrollTop += rect.top - host.top - host.height / 3;
      }
    }
  }
  function stepFind(direction) {
    if (nodes.findBar.hidden) { openFind(); return; }
    if (inEditFind()) { showEditorFind(window.DraftbackEditor.findStep(state.editorView, direction)); return; }
    if (!find.ranges.length) { runFind(); if (!find.ranges.length) return; }
    find.index = (find.index + direction + find.ranges.length) % find.ranges.length;
    highlightCurrentFind(true);
  }

  function replaceCurrentMatch() {
    if (!inEditFind()) return;
    showEditorFind(window.DraftbackEditor.replaceCurrent(state.editorView, nodes.replaceInput.value));
  }
  function replaceAllMatches() {
    if (!inEditFind()) return;
    const result = window.DraftbackEditor.replaceAllMatches(state.editorView, nodes.replaceInput.value);
    showEditorFind(result);
    toast(result.replaced ? `已替换 ${result.replaced} 处(⌘Z 可撤销)。` : '没有可替换的地方。');
  }

  // ---------- 导出 PDF / 打印 ----------
  // 折叠块在关闭状态下不会被打印,导出前临时展开,结束后恢复。
  let reopenedDetails = [];
  function expandDetailsForPrint() {
    reopenedDetails = Array.from(nodes.content.querySelectorAll('details:not([open])'));
    reopenedDetails.forEach((node) => { node.open = true; });
  }
  function restoreDetailsAfterPrint() {
    reopenedDetails.forEach((node) => { node.open = false; });
    reopenedDetails = [];
  }
  window.addEventListener('beforeprint', expandDetailsForPrint);
  window.addEventListener('afterprint', restoreDetailsAfterPrint);

  async function exportPdf() {
    const tab = activeTab();
    if (!tab) { toast('先打开一篇文档再导出。', 'error'); return; }
    if (tab.mode === 'edit') { toast('请先回到阅读模式再导出 PDF。', 'error'); return; }
    if (!bridge || typeof bridge.exportPdf !== 'function') { window.print(); return; }
    const wasHidden = nodes.findBar.hidden; nodes.findBar.hidden = true;
    expandDetailsForPrint();
    try {
      const result = await bridge.exportPdf({ suggestedName: tab.review.title || 'document', directory: posixDir(tab.review.sourceFile || '') });
      if (result && result.ok) toast('PDF 已导出。');
    } catch (error) { toast(`导出 PDF 失败:${error.message || error}`, 'error'); }
    finally { nodes.findBar.hidden = wasHidden; restoreDetailsAfterPrint(); }
  }
  async function printDocument() {
    const tab = activeTab();
    if (!tab) { toast('先打开一篇文档再打印。', 'error'); return; }
    if (tab.mode === 'edit') { toast('请先回到阅读模式再打印。', 'error'); return; }
    if (!bridge || typeof bridge.print !== 'function') { window.print(); return; }
    expandDetailsForPrint();
    try { await bridge.print(); } catch (error) { toast(`打印失败:${error.message || error}`, 'error'); }
    finally { restoreDetailsAfterPrint(); }
  }

  // 手机导出的批注批次(.draftback-batch.json)拖进窗口即导入;结果以提示显示,会话标签随事件流自动刷新。
  // 批次文件由页面读出内容再提交:拖放即授权,服务不必按路径去读受保护的「下载」文件夹。
  async function importBatchFile(file) {
    let batch;
    try { batch = JSON.parse(await file.text()); }
    catch (_) { toast(`《${file.name}》不是有效的批注批次文件。`, 'error'); return; }
    try {
      const active = activeTab();
      const result = await requestJson('/api/app/batch/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch, documentPath: active ? active.review.sourceFile : null }),
      });
      const receipt = result.receipt || {};
      if (receipt.accepted && receipt.converted) {
        toast(`这份批次没有轮次身份,已把 ${receipt.acceptedIds.length} 条转为本轮新批注(保留来源)。`);
        if (result.review && result.review.id) void queueRemoteReviewChange(result.review.id, { reason: 'batch-imported' });
      } else if (receipt.accepted) {
        toast(`已接收手机批注 ${receipt.acceptedIds.length} 条${receipt.skippedIds && receipt.skippedIds.length ? `,跳过重复 ${receipt.skippedIds.length} 条` : ''}。`);
        if (result.review && result.review.id) void queueRemoteReviewChange(result.review.id, { reason: 'batch-imported' });
      } else {
        toast(`批次未被采用(${receipt.reason}):${receipt.message}`, 'error');
      }
    } catch (error) { toast(friendlyError(error, '导入批注批次'), 'error'); }
  }

  // ---------- 拖放打开 ----------
  function installDragAndDrop() {
    let depth = 0;
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    window.addEventListener('dragenter', (event) => { if (!hasFiles(event)) return; event.preventDefault(); depth += 1; nodes.dropOverlay.hidden = false; });
    window.addEventListener('dragover', (event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
    window.addEventListener('dragleave', (event) => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) nodes.dropOverlay.hidden = true; });
    window.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); depth = 0; nodes.dropOverlay.hidden = true;
      const files = Array.from(event.dataTransfer.files || []);
      const batchFiles = files.filter((file) => /\.draftback-batch\.json$/i.test(file.name));
      const docFiles = files.filter((file) => /\.md$/i.test(file.name)); // 服务端只认 .md,别的后缀要给提示而不是静默吞掉
      const markdown = !docFiles.length ? []
        : bridge && typeof bridge.pathsForFiles === 'function' ? bridge.pathsForFiles(docFiles) : docFiles.map((file) => file.path).filter(Boolean);
      batchFiles.forEach((file) => void importBatchFile(file));
      if (!markdown.length && !batchFiles.length) { toast('只能打开 .md 文件或 .draftback-batch.json 批注批次。', 'error'); return; }
      if (markdown.length) void openPaths(markdown);
    });
  }

  function renderTabs() {
    nodes.shell.classList.toggle('multi-tab', state.tabs.length > 1);
    nodes.tabList.replaceChildren();
    state.tabs.forEach((tab) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `tab${tab.id === state.activeId ? ' active' : ''}`;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab.id === state.activeId));
      button.title = tab.review.sourceFile || tab.review.title;
      const title = document.createElement('span'); title.className = 'tab-title'; title.textContent = tab.review.title || 'Markdown';
      const dot = document.createElement('span'); dot.className = `tab-state ${tab.review.status || ''}${tab.review.applyMode === 'manual' ? ' manual' : ''}`;
      dot.title = tab.remotePending
        ? `${statusLabel(tab.review.status, tab.review.applyMode, tab.review.outcome)}（有远程更新待同步）`
        : statusLabel(tab.review.status, tab.review.applyMode, tab.review.outcome);
      const close = document.createElement('span'); close.className = 'tab-close'; close.setAttribute('role', 'button');
      close.setAttribute('aria-label', `关闭 ${tab.review.title || '文档'}`); close.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
      close.addEventListener('pointerdown', (event) => event.stopPropagation());
      close.addEventListener('click', (event) => { event.stopPropagation(); void closeTab(tab.id); });
      button.append(title, dot, close);
      button.addEventListener('click', () => activateTab(tab.id));
      nodes.tabList.appendChild(button);
      if (tab.id === state.activeId) {
        requestAnimationFrame(() => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      }
    });
  }

  function renderApp() {
    renderLayoutState();
    renderTabs();
    const tab = activeTab();
    nodes.shell.classList.toggle('no-doc', !tab);
    renderDocTitle(tab);
    if (!tab) {
      destroyEditor();
      clearMarkerOverlay();
      nodes.reviewState.hidden = true; nodes.compareToggleButton.hidden = true;
      nodes.readerPane.hidden = false;
      nodes.welcome.hidden = false;
      nodes.readerScroll.hidden = true;
      nodes.editorPane.hidden = true;
      nodes.primaryAction.hidden = true;
      nodes.secondaryAction.hidden = true;
      renderOutline([]);
      renderNotes(null);
      publishMenuState();
      return;
    }

    nodes.reviewState.hidden = false;
    nodes.welcome.hidden = true;
    renderStatus(tab);
    markSeenIfReturned(tab);
    renderNotes(tab);
    if (tab.mode === 'edit') { if (Compare.isOpen()) Compare.close(); renderEditor(tab); }
    else renderReader(tab);
    publishMenuState();
    if (bridge && typeof bridge.noteRecent === 'function' && tab.review.sourceFile) { try { bridge.noteRecent(tab.review.sourceFile); } catch (_) {} }
  }

  function renderLayoutState() {
    nodes.shell.classList.toggle('left-collapsed', state.leftCollapsed);
    nodes.shell.classList.toggle('right-collapsed', state.rightCollapsed);
    nodes.shell.classList.toggle('multi-tab', state.tabs.length > 1);
    // 没有打开文档时大纲是空的:左栏显示稿件(不改用户的选择)
    const leftMode = activeTab() ? state.leftMode : 'files';
    nodes.outlineMode.classList.toggle('active', leftMode === 'outline');
    nodes.filesMode.classList.toggle('active', leftMode === 'files');
    nodes.outlineMode.setAttribute('aria-selected', String(leftMode === 'outline'));
    nodes.filesMode.setAttribute('aria-selected', String(leftMode === 'files'));
    nodes.outlinePanel.hidden = leftMode !== 'outline';
    nodes.filesPanel.hidden = leftMode !== 'files';
    publishMenuState();
  }

  function setLeftMode(mode) {
    state.leftMode = mode === 'files' ? 'files' : 'outline';
    state.leftCollapsed = false;
    storeLocal('draftback.leftMode', state.leftMode);
    storeLocal('draftback.leftCollapsed', '0');
    renderLayoutState();
  }

  function toggleLeft(force) {
    state.leftCollapsed = typeof force === 'boolean' ? force : !state.leftCollapsed;
    storeLocal('draftback.leftCollapsed', state.leftCollapsed ? '1' : '0');
    renderLayoutState();
    requestAnimationFrame(scheduleMarkerPositions);
  }

  const NARROW_WIDTH = 1280;
  function applyNarrowLayout() {
    const narrow = window.innerWidth < NARROW_WIDTH;
    if (narrow === Boolean(state.narrow)) return;
    if (narrow) { state.wideRightCollapsed = state.rightCollapsed; state.rightCollapsed = true; }
    else if (typeof state.wideRightCollapsed === 'boolean') state.rightCollapsed = state.wideRightCollapsed;
    state.narrow = narrow;
    renderLayoutState();
    requestAnimationFrame(scheduleMarkerPositions);
  }
  function toggleRight(force) {
    state.rightCollapsed = typeof force === 'boolean' ? force : !state.rightCollapsed;
    // 窄窗口里打开的批注栏浮在稿纸上,只是临时的;偏好只记宽窗口下的选择
    if (!state.narrow) storeLocal('draftback.rightCollapsed', state.rightCollapsed ? '1' : '0');
    renderLayoutState();
    requestAnimationFrame(scheduleMarkerPositions);
  }

  function paintAction(node, spec) {
    node.hidden = !spec || spec.hidden;
    if (node.hidden) { node.dataset.action = ''; return; }
    node.disabled = Boolean(spec.disabled);
    node.replaceChildren();
    if (spec.icon) { const icon = document.createElement('i'); icon.className = `ph ${spec.icon}`; icon.setAttribute('aria-hidden', 'true'); node.appendChild(icon); }
    node.appendChild(document.createTextNode(spec.label));
    node.title = spec.title || '';
    node.dataset.action = spec.action;
  }

  function renderStatus(tab) {
    const review = tab.review;
    const view = Handoff.describe({
      review, plain: isPlain(tab), mode: tab.mode, openCount: openAnnotations(tab).length,
      readOnly: isReadOnly(tab), encoding: tab.sourceMeta && tab.sourceMeta.encoding,
      remotePending: Boolean(tab.remotePending),
    });
    nodes.reviewState.dataset.status = view.status;
    nodes.reviewStateText.textContent = view.text;
    nodes.reviewStateIcon.className = `ph ${view.icon}`;
    nodes.reviewState.title = (tab.remotePending ? `${view.detail}当前草稿不会被覆盖，保存或退出编辑后将立即同步。` : view.detail) +
      (isReadOnly(tab) ? ` ${tab.sourceMeta.readOnlyReason || ''}` : '');
    nodes.readingMode.classList.toggle('active', tab.mode !== 'edit');
    nodes.editingMode.classList.toggle('active', tab.mode === 'edit');
    nodes.editingMode.disabled = review.status === 'conflict' || (review.status === 'applying' && review.applyMode !== 'manual') || isReadOnly(tab);
    paintAction(nodes.primaryAction, view.primary);
    paintAction(nodes.secondaryAction, view.secondary);
    publishMenuState();
  }

  function renderReader(tab) {
    destroyEditor();
    tab.mode = 'read';
    if (Compare.isOpen() && Compare.current().tabId !== tab.id) Compare.close();
    nodes.readerPane.hidden = false;
    nodes.readerScroll.hidden = false;
    nodes.editorPane.hidden = true;
    if (tab.renderedHash !== tab.sourceHash || nodes.content.dataset.tabId !== tab.id) {
      const refreshing = nodes.content.dataset.tabId === tab.id && Boolean(tab.renderedOnce);
      void renderMarkdown(nodes.content, tab.source, tab, { interactive: true }).then((rendered) => {
        if (!rendered || activeTab()?.id !== tab.id || tab.mode !== 'read') return;
        tab.renderedOnce = true;
        if (refreshing) { nodes.content.classList.remove('content-refresh'); void nodes.content.offsetWidth; nodes.content.classList.add('content-refresh'); }
        tab.renderedHash = tab.sourceHash;
        nodes.content.dataset.tabId = tab.id;
        buildOutline(tab);
        renderMarkers(tab);
        if (!nodes.findBar.hidden) runFind();
        requestAnimationFrame(() => {
          nodes.readerScroll.scrollTop = tab.scrollTop || 0;
          updateOutlineActive();
          scheduleMarkerPositions();
        });
      });
    } else {
      renderOutline(tab.outline);
      renderMarkers(tab);
      requestAnimationFrame(() => {
        nodes.readerScroll.scrollTop = tab.scrollTop || nodes.readerScroll.scrollTop;
        updateOutlineActive();
        scheduleMarkerPositions();
      });
    }
  }

  function statusCanAnnotate(tab) { return !!tab && tab.mode === 'read' && ANNOTATABLE.has(tab.review.status) && !isReadOnly(tab); }

  // 文档里夹带的原始 HTML 只保留排版用途(<br>、<img>、<details>、带 id 的 <p> 等);
  // 脚本、事件属性、<style>、<iframe>/<object>/<form>、javascript: 链接一律剥掉。
  // 风险在文档内容而不在来源:智能体抓网页写出的文档同样可能夹带代码。
  // DOMPurify 缺席时退回 html:false,原始 HTML 按文本显示——宁可难看,不可执行。
  const purifier = window.DOMPurify && typeof window.DOMPurify.sanitize === 'function' ? window.DOMPurify : null;
  const PURIFY_OPTIONS = Object.freeze({
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'template'],
    FORBID_ATTR: ['srcdoc', 'formaction'],
  });
  function sanitizeHtml(html) { return purifier ? purifier.sanitize(html, PURIFY_OPTIONS) : html; }

  function markdownEngine() {
    const texmath = window.texmath || window.markdownitTexmath || window['markdown-it-texmath'];
    const engine = window.markdownit({
      html: Boolean(purifier), linkify: true, breaks: false,
      highlight(source, language) {
        if (language === 'mermaid') return '';
        if (language && window.hljs && window.hljs.getLanguage(language)) {
          try { return `<pre class="hljs"><code class="language-${language}">${window.hljs.highlight(source, { language, ignoreIllegals: true }).value}</code></pre>`; }
          catch (_) {}
        }
        return '';
      },
    });
    if (texmath && window.katex) {
      try { engine.use(texmath, { engine: window.katex, delimiters: 'dollars', katexOptions: { throwOnError: false, strict: false } }); }
      catch (_) {}
    }
    engine.core.ruler.after('inline', 'draftback-task-list', (core) => {
      const tokens = core.tokens;
      for (let i = 2; i < tokens.length; i += 1) {
        const inline = tokens[i];
        if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
        const first = inline.children && inline.children[0];
        const match = first && first.type === 'text' ? /^\[([ xX])\][ \u00a0]/.exec(first.content) : null;
        if (!match) continue;
        first.content = first.content.slice(match[0].length);
        const checked = match[1] !== ' ';
        const box = new core.Token('html_inline', '', 0);
        // 「[ ] 」原文仍留在正文文字里(只是看不见):批注锚点按文字偏移算,去掉它旧批注会错位
        const marker = match[0].replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
        box.content = `<span class="task-check${checked ? ' checked' : ''}" role="img" aria-label="${checked ? '已完成' : '未完成'}"><span class="task-marker">${marker}</span></span>`;
        inline.children.unshift(box);
        tokens[i - 2].attrJoin('class', 'task-list-item');
        for (let j = i - 3; j >= 0; j -= 1) {
          const t = tokens[j];
          if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === tokens[i - 2].level - 1) { t.attrJoin('class', 'contains-task-list'); break; }
        }
      }
    });
    const htmlBlockRule = engine.renderer.rules.html_block;
    engine.renderer.rules.html_block = function htmlBlock(tokens, index, options, env, self) {
      const token = tokens[index];
      const html = htmlBlockRule ? htmlBlockRule.call(this, tokens, index, options, env, self) : token.content;
      if (!token.map || /^\s*<[A-Za-z][^>]*\bdata-line-start\s*=/i.test(html)) return html;
      const start = token.map[0] + 1, end = token.map[1];
      return html.replace(/^(\s*<[A-Za-z][\w:-]*)(?=[\s>])/, `$1 data-line-start="${start}" data-line-end="${end}"`);
    };
    const fenceRule = engine.renderer.rules.fence;
    engine.renderer.rules.fence = function fence(tokens, index, options, env, self) {
      const token = tokens[index];
      const html = fenceRule.call(this, tokens, index, options, env, self);
      // markdown-it bypasses token attributes when highlight() returns a full
      // <pre> block.  Restore the source-line map so fenced code remains
      // selectable for annotations without changing the highlighted markup.
      if (!token.map || /\bdata-line-start\s*=/.test(html)) return html;
      const start = token.map[0] + 1, end = token.map[1];
      return html.replace(/^(\s*<pre)(?=[\s>])/i, `$1 data-line-start="${start}" data-line-end="${end}"`);
    };
    const originalRender = engine.renderer.render.bind(engine.renderer);
    engine.renderer.render = function render(tokens, options, env) {
      for (const token of tokens) {
        if (token.map && (token.nesting === 1 || token.type === 'fence' || token.type === 'code_block')) {
          token.attrSet('data-line-start', String(token.map[0] + 1));
          token.attrSet('data-line-end', String(token.map[1]));
        }
      }
      return originalRender(tokens, options, env);
    };
    return engine;
  }

  const md = markdownEngine();
  // 独立只读对比视图(规则⑤第三段):算法与 DOM 都在各自模块里,这里只注入渲染器与取版本正文的接口
  const Compare = window.DraftbackCompare.create({
    elements: {
      view: nodes.compareView, title: nodes.compareTitle, meta: nodes.compareMeta, position: nodes.comparePosition, prev: nodes.comparePrev,
      next: nodes.compareNext, close: nodes.compareClose, scroll: nodes.compareScroll, content: nodes.compareContent, note: nodes.compareNote,
    },
    md, dmp: new window.diff_match_patch(), Diff, renderMarkdown,
    loadVersion: (docId, versionId, which) => requestJson(`/api/app/version?docId=${encodeURIComponent(docId)}&versionId=${encodeURIComponent(versionId)}&which=${which}`),
    onChange: ({ open }) => {
      publishMenuState();
      renderCompareToggle(activeTab());
      nodes.readerPane.classList.toggle('compare-open', open);
      nodes.annotate.hidden = true;
      if (open) { toggleTimeline(false); window.getSelection()?.removeAllRanges(); }
      else { nodes.readerScroll.setAttribute('tabindex', '-1'); nodes.readerScroll.focus({ preventScroll: true }); }
    },
  });
  // strict:图表文字经 Mermaid 自带的净化,不允许 HTML 标签与点击脚本进入 SVG。
  const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: prefersDark ? 'dark' : 'default' });
  // 外观切换(系统或「显示 → 外观」菜单)后,样式随变量立刻变,Mermaid 图要按新主题重画一次
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: event.matches ? 'dark' : 'default' });
      // 只有含 Mermaid 图的文档需要重画(其余全靠 CSS 变量),避免无谓的整页重渲染
      const tab = activeTab();
      if (tab && tab.mode === 'read' && nodes.content.querySelector('.mermaid')) { tab.renderedHash = null; renderReader(tab); }
    });
  }

  function posixDir(value) { const index = value.lastIndexOf('/'); return index < 0 ? '' : value.slice(0, index); }
  function posixJoin(base, relative) {
    const parts = `${base}/${String(relative || '').replace(/^\.\//, '')}`.split('/');
    const out = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return out.join('/');
  }
  function absoluteJoin(baseFile, relative) {
    const leading = String(baseFile || '').startsWith('/');
    const joined = posixJoin(posixDir(baseFile), relative);
    return leading ? `/${joined}` : joined;
  }

  // 紧凑列表项这类"自己带文字、肚子里又嵌子块"的元素(如带子列表的 li),
  // 裸露在块里的行内文字不属于任何叶子块,划词批注会静默失效。把每段裸
  // 文字包进带行号的 span,使其成为可批注的叶子块;行号取前后相邻已映射
  // 子块的行号夹逼推断。
  function adoptBareInlineRuns(root) {
    const lineRangeOf = (node) => {
      if (node.dataset && node.dataset.lineStart) return [Number(node.dataset.lineStart), Number(node.dataset.lineEnd)];
      const mapped = node.querySelectorAll?.('[data-line-start]');
      if (!mapped || !mapped.length) return [NaN, NaN];
      return [Number(mapped[0].dataset.lineStart), Number(mapped[mapped.length - 1].dataset.lineEnd)];
    };
    const isMappedBlock = (node) => node.nodeType === Node.ELEMENT_NODE
      && (node.hasAttribute('data-line-start') || Boolean(node.querySelector('[data-line-start]')));
    $$('[data-line-start]', root).forEach((host) => {
      if (!host.querySelector('[data-line-start]')) return;
      const hostStart = Number(host.dataset.lineStart), hostEnd = Number(host.dataset.lineEnd);
      const runs = [];
      let current = null, lastMapped = null;
      Array.from(host.childNodes).forEach((node) => {
        if (isMappedBlock(node)) { current = null; lastMapped = node; return; }
        if (!current) { current = { nodes: [], before: lastMapped, after: null }; runs.push(current); }
        current.nodes.push(node);
      });
      runs.forEach((run) => {
        const index = run.nodes.length ? Array.prototype.indexOf.call(host.childNodes, run.nodes[run.nodes.length - 1]) : -1;
        for (let i = index + 1; i >= 0 && i < host.childNodes.length; i += 1) {
          if (isMappedBlock(host.childNodes[i])) { run.after = host.childNodes[i]; break; }
        }
        if (!run.nodes.some((node) => (node.textContent || '').trim())) return;
        let start = run.before ? lineRangeOf(run.before)[1] + 1 : hostStart;
        let end = run.after ? lineRangeOf(run.after)[0] - 1 : hostEnd;
        if (!Number.isFinite(start)) start = hostStart;
        if (!Number.isFinite(end)) end = hostEnd;
        start = Math.min(Math.max(start, hostStart), hostEnd);
        end = Math.min(Math.max(end, hostStart), hostEnd);
        if (end < start) { start = Math.min(start, end); end = start; }
        const wrapper = document.createElement('span');
        wrapper.className = 'md-inline-run';
        wrapper.dataset.lineStart = String(start);
        wrapper.dataset.lineEnd = String(end);
        run.nodes[0].parentNode.insertBefore(wrapper, run.nodes[0]);
        run.nodes.forEach((node) => wrapper.appendChild(node));
      });
    });
  }

  // Front Matter(---/+++ 包住的元数据)不属于正文:阅读时替换成同样行数的空行,行号不变、批注锚点不受影响。
  const FRONT_MATTER = /^(---|\+\+\+)[ \t]*\r?\n[\s\S]*?\r?\n\1[ \t]*(?:\r?\n|$)/;
  function blankFrontMatter(text) {
    const match = String(text || '').match(FRONT_MATTER);
    if (!match) return String(text || '');
    const lines = match[0].split('\n').length - 1;
    return '\n'.repeat(lines) + text.slice(match[0].length);
  }
  // 文档旁资源(图片、附件)的归属:审阅标签按会话 id 取,普通打开的文档没有会话,按文档路径取
  function assetOwnerQuery(tab) {
    return isPlain(tab) ? `d=${encodeURIComponent(tab.review.sourceFile)}` : `r=${encodeURIComponent(tab.id)}`;
  }
  async function renderMarkdown(root, source, tab, options = {}) {
    const renderToken = Symbol('mdturn-render');
    root.__mdturnRenderToken = renderToken;
    const target = document.createElement('div');
    target.innerHTML = sanitizeHtml(md.render(blankFrontMatter(source || '')));
    adoptBareInlineRuns(target);
    target.querySelectorAll('img[src]').forEach((image) => {
      const src = image.getAttribute('src') || '';
      if (/^(https?:|data:)/i.test(src)) return;
      const localPath = localAssetPath(src);
      image.dataset.sourceSrc = src;
      image.src = `/api/app/file?${assetOwnerQuery(tab)}&path=${encodeURIComponent(localPath)}`;
      image.loading = 'lazy';
    });
    target.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        link.addEventListener('click', (event) => {
          if (!bridge || typeof bridge.openExternal !== 'function') return;
          event.preventDefault(); void bridge.openExternal(href);
        });
      } else if (/^(mailto:|tel:|#)/i.test(href)) {
        // Keep local anchors native. Electron blocks mail/tel navigation by default.
      } else if (/\.md(?:[?#]|$)/i.test(href) && options.interactive) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          const clean = href.replace(/[?#].*$/, '');
          // 普通打开,不冻结目标文档;它若已有审阅会话,openDocumentPath 会自动进入那个会话
          void openDocumentPath(resolveDocumentPath(tab.review.sourceFile, clean));
        });
      } else {
        link.dataset.sourceHref = href;
        link.href = `/api/app/file?${assetOwnerQuery(tab)}&path=${encodeURIComponent(localAssetPath(href))}`;
        link.target = '_blank'; link.rel = 'noopener';
      }
    });
    await renderMermaid(target);
    if (root.__mdturnRenderToken !== renderToken) return false;
    root.replaceChildren(...target.childNodes);
    if (root === nodes.content) {
      root.querySelectorAll('img').forEach((image) => {
        image.addEventListener('load', scheduleMarkerPositions, { once: true });
      });
    }
    return true;
  }

  function localAssetPath(value) {
    const raw = String(value || '').replace(/[?#].*$/, '');
    if (/^file:\/\//i.test(raw)) {
      try { return decodeURIComponent(new URL(raw).pathname); } catch { return raw.replace(/^file:\/\//i, ''); }
    }
    try { return decodeURIComponent(raw); } catch { return raw; }
  }

  function resolveDocumentPath(baseFile, value) {
    const local = localAssetPath(value);
    return local.startsWith('/') ? local : absoluteJoin(baseFile, local);
  }

  async function renderMermaid(root) {
    const diagrams = [];
    root.querySelectorAll('code.language-mermaid').forEach((code) => {
      const parent = code.closest('pre') || code;
      const element = document.createElement('div'); element.className = 'mermaid'; element.textContent = code.textContent;
      parent.replaceWith(element); diagrams.push(element);
    });
    if (diagrams.length && window.mermaid) {
      try { await window.mermaid.run({ nodes: diagrams }); }
      catch (error) { console.warn('Mermaid render failed:', error); }
    }
  }

  function cleanBlockText(block) {
    const copy = block.cloneNode(true);
    copy.querySelectorAll('.note-pin').forEach((pin) => pin.remove());
    return copy.textContent || '';
  }

  function mappedLeafBlocks(root = nodes.content) {
    return $$('[data-line-start]', root).filter((element) => !element.querySelector('[data-line-start]'));
  }

  function blockDescriptors(leaves) {
    return leaves.map((element, index) => ({
      key: index,
      lineStart: Number(element.dataset.lineStart),
      lineEnd: Number(element.dataset.lineEnd),
      text: cleanBlockText(element),
    }));
  }

  function buildOutline(tab) {
    const headings = $$('h1,h2', nodes.content);
    tab.outline = headings.map((heading, index) => {
      const copy = heading.cloneNode(true); copy.querySelectorAll('.note-pin').forEach((pin) => pin.remove());
      const text = copy.textContent.trim();
      const id = `mdturn-heading-${tab.id}-${index}`;
      heading.id = id;
      return {
        id,
        level: heading.tagName === 'H1' ? 1 : 2,
        text,
        lineStart: Number(heading.dataset.lineStart) || 1,
      };
    });
    renderOutline(tab.outline);
  }

  function setOutlineActive(id) {
    $$('.outline-link', nodes.outlinePanel).forEach((button) => {
      const active = button.dataset.headingId === id;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    });
  }

  function updateOutlineActive() {
    state.outlineFrame = null;
    const tab = activeTab();
    if (!tab || tab.mode === 'edit' || !tab.outline.length) return;
    const threshold = nodes.readerScroll.getBoundingClientRect().top + 112;
    let current = tab.outline[0];
    for (const item of tab.outline) {
      const heading = document.getElementById(item.id);
      if (heading && heading.getBoundingClientRect().top <= threshold) current = item;
      else if (heading) break;
    }
    setOutlineActive(current.id);
  }

  function scheduleOutlineUpdate() {
    if (state.outlineFrame !== null) return;
    state.outlineFrame = requestAnimationFrame(updateOutlineActive);
  }

  // 本轮每节的批注数:按批注记下的章节路径,从最深的一级往上找到大纲里有的那一级;总体意见算在第一个标题上
  function outlineCounts(outline) {
    const tab = activeTab();
    const counts = new Map();
    if (!tab || isPlain(tab) || !outline || !outline.length) return counts;
    const texts = new Set(outline.map((item) => item.text));
    for (const note of openAnnotations(tab)) {
      let key = null;
      if (isDocNote(note)) key = outline[0].text;
      else {
        const path = Array.isArray(note.headingPath) ? note.headingPath : [];
        for (let i = path.length - 1; i >= 0 && !key; i -= 1) if (texts.has(path[i])) key = path[i];
      }
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function renderOutline(outline) {
    nodes.outlinePanel.replaceChildren();
    const counts = outlineCounts(outline);
    if (!outline || !outline.length) {
      nodes.outlinePanel.appendChild(emptyBlock(activeTab() ? '这篇文档没有一级或二级标题。' : '打开文档后，这里会显示文章结构。', 'outline-empty'));
      return;
    }
    const fragment = document.createDocumentFragment();
    let h1Index = 0;
    outline.forEach((item) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = `outline-link h${item.level}`;
      button.dataset.headingId = item.id;
      if (item.level === 1) h1Index += 1;
      const number = document.createElement('span'); number.className = 'outline-number'; number.textContent = item.level === 1 ? String(h1Index) : '';
      const text = document.createElement('span'); text.className = 'outline-text'; text.textContent = item.text;
      button.append(number, text);
      const count = counts.get(item.text);
      if (count) { const badge = document.createElement('span'); badge.className = 'outline-count'; badge.textContent = String(count); badge.title = `本轮这一节有 ${count} 条批注`; button.appendChild(badge); counts.delete(item.text); }
      button.addEventListener('click', () => {
        const tab = activeTab();
        setOutlineActive(item.id);
        if (tab?.mode === 'edit' && window.DraftbackEditor && state.editorView && typeof window.DraftbackEditor.revealLine === 'function') {
          // 编辑器里不含 Front Matter,大纲行号是按整篇源文算的,要减去 Front Matter 占的行数
          const frontMatterLines = (splitFrontMatter(tab.source).frontMatter.match(/\n/g) || []).length;
          window.DraftbackEditor.revealLine(state.editorView, Math.max(1, item.lineStart - frontMatterLines));
          return;
        }
        const target = document.getElementById(item.id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      fragment.appendChild(button);
    });
    nodes.outlinePanel.appendChild(fragment);
  }

  function headingPathFor(block) {
    if (!block) return [];
    const stack = [];
    $$('h1,h2,h3,h4,h5,h6', nodes.content).forEach((heading) => {
      if (block.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING) {
        const level = Number(heading.tagName.slice(1));
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        const copy = heading.cloneNode(true); copy.querySelectorAll('.note-pin').forEach((pin) => pin.remove());
        stack.push({ level, text: copy.textContent.trim() });
      }
    });
    return stack.map((item) => item.text);
  }

  function figureRefOf(block, quote) {
    const candidates = [quote || '', block ? cleanBlockText(block) : ''];
    for (const text of candidates) {
      const match = text.match(/(图|表|Figure|Fig\.?|Table)\s*[\d０-９][\d０-９.\-—－]*/i);
      if (match) return match[0].replace(/\s+/g, ' ').trim();
    }
    return null;
  }

  function textOffset(block, container, offset) {
    try {
      const range = document.createRange();
      range.selectNodeContents(block);
      range.setEnd(container, offset);
      const fragment = range.cloneContents();
      fragment.querySelectorAll?.('.note-pin').forEach((pin) => pin.remove());
      return (fragment.textContent || '').length;
    } catch { return null; }
  }

  function intersectRangeWithBlock(range, block) {
    try {
      if (!range.intersectsNode(block)) return null;
      const blockRange = document.createRange(); blockRange.selectNodeContents(block);
      const intersection = document.createRange();
      if (range.compareBoundaryPoints(Range.START_TO_START, blockRange) >= 0) intersection.setStart(range.startContainer, range.startOffset);
      else intersection.setStart(blockRange.startContainer, blockRange.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, blockRange) <= 0) intersection.setEnd(range.endContainer, range.endOffset);
      else intersection.setEnd(blockRange.endContainer, blockRange.endOffset);
      return !intersection.collapsed && intersection.toString().trim() ? intersection : null;
    } catch { return null; }
  }

  function captureSelectionAnchor() {
    const tab = activeTab();
    const selection = window.getSelection();
    if (!statusCanAnnotate(tab) || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    if (nodes.content.dataset.tabId !== tab.id) return null;
    const range = selection.getRangeAt(0);
    if (!nodes.content.contains(range.startContainer) || !nodes.content.contains(range.endContainer)) return null;
    const leaves = mappedLeafBlocks();
    const selected = [];
    leaves.forEach((block, index) => {
      const intersection = intersectRangeWithBlock(range, block);
      if (intersection) selected.push({ block, index, intersection });
    });
    if (!selected.length) return null;
    const first = selected[0], last = selected[selected.length - 1];
    const start = textOffset(first.block, first.intersection.startContainer, first.intersection.startOffset);
    const end = textOffset(last.block, last.intersection.endContainer, last.intersection.endOffset);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    try {
      return Anchor.createAnchorFromBlocks(
        blockDescriptors(leaves),
        { blockIndex: first.index, offset: start },
        { blockIndex: last.index, offset: end },
        {
          headingPath: headingPathFor(first.block),
          figureRef: figureRefOf(first.block, selection.toString()),
          reviewSessionId: tab.id,
        },
      );
    } catch (error) {
      console.warn('Anchor capture failed:', error);
      return null;
    }
  }

  function positionAnnotateButton(range) {
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const left = Math.min(window.innerWidth - 92, Math.max(12, rect.right + 10));
    const top = Math.min(window.innerHeight - 52, Math.max(68, rect.bottom + 8));
    nodes.annotate.style.left = `${left}px`; nodes.annotate.style.top = `${top}px`;
  }

  function handleSelectionChange() {
    if (state.selectionFrame) cancelAnimationFrame(state.selectionFrame);
    state.selectionFrame = requestAnimationFrame(() => {
      state.selectionFrame = null;
      if (!nodes.annotationDialog.hidden) return;
      const anchor = captureSelectionAnchor();
      const selection = window.getSelection();
      if (!anchor || !selection || !selection.rangeCount) {
        nodes.annotate.hidden = true;
        return;
      }
      state.cachedAnchor = anchor;
      positionAnnotateButton(selection.getRangeAt(0));
      nodes.annotate.hidden = false;
    });
  }

  function textPoint(block, offset) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) { return node.parentElement && node.parentElement.closest('.note-pin') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
    });
    let remaining = Math.max(0, Number(offset) || 0), node = walker.nextNode(), last = null;
    while (node) {
      last = node;
      if (remaining <= node.data.length) return { node, offset: remaining };
      remaining -= node.data.length;
      node = walker.nextNode();
    }
    return last ? { node: last, offset: last.data.length } : { node: block, offset: 0 };
  }

  function rangeForSegment(block, segment) {
    const start = textPoint(block, segment.startTextOffset), end = textPoint(block, segment.endTextOffset);
    try {
      const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
      return range.collapsed ? null : range;
    } catch { return null; }
  }

  function clearMarkerOverlay() {
    if (state.markerFrame) cancelAnimationFrame(state.markerFrame);
    state.markerFrame = null;
    state.markerEntries = [];
    if (nodes.annotationOverlay) nodes.annotationOverlay.replaceChildren();
  }

  function markerClientRect(entry) {
    if (entry.range) {
      try {
        const start = entry.range.cloneRange();
        start.collapse(true);
        const collapsedRects = start.getClientRects();
        if (collapsedRects.length) return collapsedRects[0];
        const selectedRects = entry.range.getClientRects();
        if (selectedRects.length) return selectedRects[0];
      } catch (_) {}
    }
    return entry.block && entry.block.getBoundingClientRect ? entry.block.getBoundingClientRect() : null;
  }

  function renderPinContent(button, notes) {
    button.__mdturnNotes = notes;
    button.title = `${notes.length} 条批注:${notes.map((note) => String(note.comment || '').slice(0, 24)).join(' / ')}`;
    button.setAttribute('aria-label', `打开这一行的 ${notes.length} 条批注`);
    button.textContent = String(notes.length);
  }

  function positionMarkerPins() {
    state.markerFrame = null;
    const tab = activeTab();
    if (!tab || tab.mode !== 'read' || !nodes.annotationOverlay || nodes.readerScroll.hidden) return;
    const overlayRect = nodes.annotationOverlay.getBoundingClientRect();
    const contentRect = nodes.content.getBoundingClientRect();
    // 圆钉放在版心右侧 22 像素(UI 方案 3.2),不压在正文上;窗口太窄时贴着右边
    const pinLeft = Math.min(contentRect.right - overlayRect.left + 12, Math.max(4, overlayRect.width - 26));
    const positions = [];
    state.markerEntries.forEach((entry) => {
      entry.button.hidden = false;
      renderPinContent(entry.button, entry.baseNotes);
      const rect = markerClientRect(entry);
      if (!rect || rect.bottom < overlayRect.top || rect.top > overlayRect.bottom) {
        entry.button.hidden = true;
        return;
      }
      const left = pinLeft;
      const lineHeight = rect.height || 24;
      const top = Math.min(Math.max(4, rect.top - overlayRect.top + (lineHeight - 20) / 2), Math.max(4, overlayRect.height - 24));
      positions.push({ entry, left, top });
    });

    positions.sort((a, b) => a.top - b.top || a.left - b.left);
    const clusters = [];
    positions.forEach((position) => {
      const nearby = clusters.find((cluster) => Math.abs(cluster.top - position.top) < 16);
      if (nearby) {
        nearby.notes.push(...position.entry.baseNotes);
        position.entry.button.hidden = true;
        renderPinContent(nearby.entry.button, nearby.notes);
        return;
      }
      clusters.push({ ...position, notes: position.entry.baseNotes.slice() });
      position.entry.button.style.left = `${Math.round(position.left)}px`;
      position.entry.button.style.top = `${Math.round(position.top)}px`;
    });
  }

  function scheduleMarkerPositions() {
    if (state.markerFrame) cancelAnimationFrame(state.markerFrame);
    state.markerFrame = requestAnimationFrame(positionMarkerPins);
  }

  function renderMarkers(tab) {
    if (nodes.content.dataset.tabId && nodes.content.dataset.tabId !== tab.id) return;
    nodes.content.querySelectorAll('.note-pin').forEach((pin) => pin.remove());
    nodes.content.querySelectorAll('.legacy-note-block').forEach((block) => block.classList.remove('legacy-note-block'));
    clearMarkerOverlay();
    if (globalThis.CSS && CSS.highlights) CSS.highlights.delete('draftback-open');
    const open = openAnnotations(tab);
    if (!open.length) return;
    const leaves = mappedLeafBlocks();
    const descriptors = blockDescriptors(leaves);
    const ranges = [];
    const groups = new Map();
    open.forEach((note) => {
      const resolved = Anchor.resolveAnchor(note, descriptors);
      if (!resolved.matched || !resolved.segments.length) return;
      let markerRange = null;
      resolved.segments.forEach((segment) => {
        const block = leaves[segment.blockIndex]; if (!block) return;
        const range = rangeForSegment(block, segment);
        if (range) {
          ranges.push(range);
          if (!markerRange) markerRange = range;
        }
      });
      // Prefer the exact quote/offset range for every annotation that can be
      // resolved precisely, including legacy annotations upgraded at read
      // time.  Whole-block tinting is only a last-resort fallback for browsers
      // without CSS Highlights or genuinely line-range-only legacy records.
      if (!globalThis.CSS || !CSS.highlights || resolved.method === 'line-range') {
        resolved.blockIndexes.forEach((index) => leaves[index] && leaves[index].classList.add('legacy-note-block'));
      }
      const key = `${resolved.startBlockIndex}:${resolved.start.offset}`;
      if (!groups.has(key)) groups.set(key, {
        block: leaves[resolved.startBlockIndex],
        range: markerRange,
        notes: [],
      });
      groups.get(key).notes.push(note);
    });
    if (ranges.length && globalThis.Highlight && CSS.highlights) CSS.highlights.set('draftback-open', new Highlight(...ranges));
    groups.forEach(({ block, range, notes }) => {
      if (!block) return;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'note-pin';
      renderPinContent(button, notes);
      button.addEventListener('click', () => {
        const currentNotes = button.__mdturnNotes || notes;
        if (currentNotes[0]) focusNote(currentNotes[0].id);
      });
      nodes.annotationOverlay.appendChild(button);
      state.markerEntries.push({ button, block, range, baseNotes: notes.slice() });
    });
    scheduleMarkerPositions();
  }

  function notesFooterText(tab) {
    if (!tab) return '';
    const review = tab.review;
    const next = Number.isInteger(review.round) ? review.round + 1 : null;
    if (isPlain(tab)) return '划词写下第一条批注,就开始第 1 轮。⌥⌘M 批注所选文字。';
    if (review.status === 'reviewing') return '⌥⌘M 批注 · ⌘↩ 交给 AI · ⌥⌘↓ 下一条批注';
    if (review.status === 'ready_to_apply' || (review.status === 'applying' && review.applyMode !== 'manual')) return 'AI 改完稿子会自己回来;这期间不能批注。';
    if (review.status === 'applying') return '对照批注逐条处理;改完点「提交修改」。';
    if (review.status === 'conflict') return '文件在外面被改了:点工具栏的「处理…」。';
    if (review.status === 'complete' && review.outcome === 'finalized') return '这篇已定稿。再划词批注会开始新一轮。';
    return `要继续改:直接在正文划词批注,自动开始${next ? `第 ${next} 轮` : '下一轮'}。`;
  }
  function renderNotesPane(tab) {
    nodes.notesFooter.textContent = notesFooterText(tab);
    nodes.notesFooter.hidden = !nodes.notesFooter.textContent;
    if (nodes.notesSectionHint) nodes.notesSectionHint.hidden = !(tab && tab.review.status === 'reviewing');
    const history = Boolean(tab && tab.historyOpen);
    nodes.currentPane.hidden = history; nodes.historySection.hidden = !history;
    nodes.notesCurrentTab.classList.toggle('active', !history); nodes.notesHistoryTab.classList.toggle('active', history);
    nodes.notesCurrentTab.setAttribute('aria-selected', String(!history)); nodes.notesHistoryTab.setAttribute('aria-selected', String(history));
  }
  function showNotesPane(pane) {
    const tab = activeTab();
    if (!tab) return;
    tab.historyOpen = pane === 'history';
    renderNotes(tab);
  }

  function renderNotes(tab) {
    nodes.openNotesList.replaceChildren(); nodes.historyNotesList.replaceChildren();
    nodes.docNoteButton.hidden = !tab || tab.mode !== 'read' || !ANNOTATABLE.has(tab.review.status) || isReadOnly(tab);
    const openSection = nodes.openNotesSection;
    renderNotesPane(tab);
    if (!tab || isPlain(tab)) {
      nodes.returnCard.hidden = true; nodes.returnCard.replaceChildren(); openSection.hidden = false;
      nodes.notesTotal.textContent = '0'; nodes.openNotesCount.textContent = '0'; nodes.historyNotesCount.textContent = '0';
      nodes.openNotesList.appendChild(emptyBlock(tab
        ? '还没有批注。划词写下第一条,就开始第 1 轮审阅并锁定原文;批注会交给 AI。'
        : '打开文档后，这里会显示当前轮次的批注。'));
      // 普通文档也可能有历史(会话被 90 天清理,版本记录还在):按文档身份显示
      if (tab && tab.review.docId) {
        void ensureVersions(tab);
        const grouped = History.buildRounds({ review: tab.review, versions: tab.versions || [], annotations: [] });
        nodes.historyNotesCount.textContent = grouped.rounds.length ? `${grouped.rounds.length} 轮` : '0';
        if (!grouped.rounds.length) nodes.historyNotesList.appendChild(emptyBlock('还没有历史。'));
        else grouped.rounds.forEach((round) => nodes.historyNotesList.appendChild(roundGroup(tab, round)));
      }
      return;
    }
    void ensureVersions(tab);
    const organized = Anchor.organizeAnnotations(tab.annotations, { historyExpanded: Boolean(tab.historyOpen) });
    const versions = tab.versions || [];
    // 回稿卡(规则⑤第三段):稿子回来 / 通过 / 恢复 / 作废时右栏顶部;数据来自版本事件,不读会继续变的旁注
    const card = History.returnCard({ review: tab.review, versions, annotations: tab.annotations });
    renderReturnCard(tab, card);
    nodes.notesTotal.textContent = String(organized.totalCount);
    nodes.openNotesCount.textContent = String(organized.open.count);
    // 总体意见(scope=document)固定置顶,组内仍保持最新在前。
    const openItems = organized.open.items.slice()
      .sort((left, right) => (isDocNote(right) ? 1 : 0) - (isDocNote(left) ? 1 : 0));
    openSection.hidden = card.show && !openItems.length;
    if (!openItems.length) nodes.openNotesList.appendChild(emptyBlock('本轮还没有批注。选中正文可划词批注；针对全篇的意见请点上方“写总体意见”。'));
    else openItems.forEach((note) => nodes.openNotesList.appendChild(noteCard(tab, note, false)));
    // 历史按轮折叠:每轮一行「第 N 轮 · 类型 · 采纳 a · 未采纳 b」;没有轮次归属的旧批注归「更早(未分轮)」
    const grouped = History.buildRounds({ review: tab.review, versions, annotations: tab.annotations });
    const roundCount = grouped.rounds.length + (grouped.legacy ? 1 : 0);
    nodes.historyNotesCount.textContent = roundCount ? `${roundCount} 轮` : '0';
    if (!roundCount) nodes.historyNotesList.appendChild(emptyBlock('还没有历史。走完第一轮后,这里按轮显示当时的批注、处理结果,以及「显示改动」「恢复到这轮改稿前」。'));
    else {
      grouped.rounds.forEach((round) => nodes.historyNotesList.appendChild(roundGroup(tab, round)));
      if (grouped.legacy) nodes.historyNotesList.appendChild(legacyGroup(tab, grouped.legacy));
    }
    maybeAutoCompare(tab, card);
    renderCompareToggle(tab);
  }

  // ---------- 版本记录(回稿卡、历史分轮、时间线、对比视图共用) ----------

  function versionsKey(review) {
    return [review.id, review.status, review.outcome || '', review.completedAt || '', review.versionId || '', review.updatedAt || '', review.round || ''].join('|');
  }

  async function ensureVersions(tab, options = {}) {
    if (!tab || !tab.review.docId) { if (tab) tab.versions = []; return; }
    const key = versionsKey(tab.review);
    if (!options.force && (tab.versionsKey === key || Date.now() < tab.versionsRetryAt)) return;
    tab.versionsKey = key;
    // 请求代次:状态变化会连发请求,只有最后一次的响应才能落盘,晚到的旧响应不覆盖新归档
    const seq = (tab.versionsSeq || 0) + 1;
    tab.versionsSeq = seq;
    try {
      const result = await requestJson(`/api/app/document/versions?docId=${encodeURIComponent(tab.review.docId)}&detail=1`);
      if (tab.versionsSeq !== seq) return;
      tab.versions = Array.isArray(result.versions) ? result.versions : [];
    } catch (error) {
      if (tab.versionsSeq !== seq) return;
      tab.versions = tab.versions || [];
      tab.versionsKey = '';
      tab.versionsRetryAt = Date.now() + 10_000;
      console.warn('读取版本记录失败', error);
      return;
    }
    if (activeTab() === tab) { renderNotes(tab); if (!nodes.timelinePopover.hidden) renderTimeline(tab); }
  }

  function el(tag, className = '', text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
  }
  function icon(name) { const node = document.createElement('i'); node.className = `ph ${name}`; node.setAttribute('aria-hidden', 'true'); return node; }
  function smallButton(text, handler, className = '') {
    const button = el('button', className, text); button.type = 'button';
    button.addEventListener('click', (event) => { event.stopPropagation(); void handler(); });
    return button;
  }

  function renderReturnCard(tab, card) {
    const root = nodes.returnCard;
    root.replaceChildren();
    root.hidden = !card.show;
    if (!card.show) return;
    root.dataset.kind = card.kind;
    const head = el('div', 'return-card-head');
    const title = document.createElement('h3');
    title.append(icon(card.kind === 'restored' ? 'ph-clock-counter-clockwise' : card.kind === 'cancelled' ? 'ph-x-circle' : card.kind === 'approved' ? 'ph-check-circle' : card.kind === 'manual' ? 'ph-pencil-simple-line' : 'ph-arrow-u-down-left'), document.createTextNode(card.title));
    head.appendChild(title);
    root.appendChild(head);
    if (card.subtitle) root.appendChild(el('p', 'return-card-sub', card.subtitle));
    const version = card.version;
    if (card.counts) {
      const badges = el('div', 'return-badges');
      badges.appendChild(el('span', 'return-badge applied', `采纳 ${card.counts.applied}`));
      badges.appendChild(el('span', 'return-badge wontfix', `未采纳 ${card.counts.wontfix}`));
      if (card.counts.cancelled) badges.appendChild(el('span', 'return-badge wontfix', `作废 ${card.counts.cancelled}`));
      if (card.counts.open) badges.appendChild(el('span', 'return-badge wontfix', `未处理 ${card.counts.open}`));
      if (card.canCompare && version) {
        const changes = el('span', 'return-badge changes', '改动处数…');
        badges.appendChild(changes);
        // 改动处数来自对比计算(UI 方案 3.8 第 5 条),算完再填;不显示「AI 用时」
        void Compare.changeCount(tab.review.docId, version.versionId).then((count) => {
          if (!changes.isConnected) return;
          if (count === null) changes.remove(); else changes.textContent = count ? `改了 ${count} 处` : '正文没有改动';
        });
      }
      root.appendChild(badges);
    }
    if (card.summary) {
      const summary = el('p', 'return-summary', card.summary);
      const long = card.summary.split('\n').length > 6 || card.summary.length > 260;
      if (long && !tab.summaryExpanded) {
        summary.classList.add('clamped');
        root.appendChild(summary);
        root.appendChild(smallButton('展开全文', () => { tab.summaryExpanded = true; renderNotes(tab); }, 'return-more'));
      } else root.appendChild(summary);
    }
    if (card.degraded) {
      const warn = el('div', 'return-degraded');
      warn.append(icon('ph-warning'), document.createTextNode(card.degradedText));
      root.appendChild(warn);
    }
    const actions = el('div', 'return-actions');
    if (card.canCompare && version) {
      const button = smallButton('', () => openCompareFor(tab, { versionId: version.versionId, round: version.round, kind: version.kind }), 'primary-button');
      button.append(icon('ph-git-diff'), document.createTextNode(card.kind === 'restored' ? '对比恢复前后' : '显示改动'));
      button.title = '打开独立的只读对比视图(⇧⌘D)';
      actions.appendChild(button);
    }
    if (card.canRetryPublish && version) actions.appendChild(smallButton('重试发布', () => retryPublish(tab, version.versionId), 'secondary-button'));
    if (card.kind === 'restored' && card.restoreBackVersionId) {
      actions.appendChild(smallButton('恢复到恢复前的稿子', () => restoreToRound(tab, { versionId: card.restoreBackVersionId, round: version ? version.round : null }, { back: true }), 'secondary-button'));
    }
    if (actions.childElementCount) root.appendChild(actions);
    if (card.kind === 'agent' || card.kind === 'manual') root.appendChild(el('p', 'return-hint', '处理说明是改稿者的自述,正文差异才是复核依据。再划词批注就开始下一轮;没问题就「通过 · 定稿」。'));
    else if (card.kind === 'approved' || card.kind === 'restored') root.appendChild(el('p', 'return-hint', '再划词批注会开始新一轮;没问题就「通过 · 定稿」。'));
    if (card.items.length) {
      const heading = el('div', 'result-heading');
      heading.append(el('span', '', '逐条结果'), el('span', '', String(card.items.length)));
      root.appendChild(heading);
      const list = el('div', 'result-list');
      const roundLike = version ? { versionId: version.versionId, round: version.round, kind: version.kind, canCompare: card.canCompare } : null;
      card.items.forEach((item) => list.appendChild(resultItem(tab, item, roundLike, card.kind === 'manual' ? '我' : 'AI')));
      root.appendChild(list);
    }
  }

  function resultItem(tab, item, round, actorLabel = 'AI') {
    const node = el('div', `result-item ${item.status}`);
    node.dataset.noteId = item.id;
    const mark = el('span', 'result-mark', item.status === 'applied' ? '✓' : item.status === 'wontfix' ? '✕' : item.status === 'cancelled' ? '–' : '…');
    mark.title = item.status === 'applied' ? '已采纳' : item.status === 'wontfix' ? '未采纳' : item.status === 'cancelled' ? '已作废' : '未处理';
    node.appendChild(mark);
    const quote = el('p', 'result-quote');
    if (item.scope === 'document') { quote.classList.add('doc-scope'); quote.textContent = '全篇 · 总体意见'; }
    else quote.textContent = `“${item.quote.slice(0, 120)}”`;
    node.appendChild(quote);
    const you = el('p', 'result-you'); you.append(el('b', '', '你'), document.createTextNode(item.you)); node.appendChild(you);
    const ai = el('p', 'result-ai'); ai.append(el('b', '', actorLabel), document.createTextNode(item.ai)); node.appendChild(ai);
    node.addEventListener('click', () => { void focusResultItem(tab, item, round); });
    return node;
  }

  // 点逐条结果:原文还在就定位到正文;被删或改写了就打开对比视图定位到原稿(UI 方案 3.8 第 3 条),不把旧圆钉硬挂到完成稿
  async function focusResultItem(tab, item, round) {
    const note = tab.annotations.find((candidate) => candidate.id === item.id);
    if (note && tab.mode === 'read' && !Compare.isOpen()) {
      if (isDocNote(note)) { focusNote(note.id, { scrollOnly: true }); return; }
      const leaves = mappedLeafBlocks();
      const resolved = Anchor.resolveAnchor(note, blockDescriptors(leaves));
      if (resolved.matched) { focusNote(note.id, { scrollOnly: true }); return; }
    }
    if (round && round.canCompare && item.quote) {
      if (!(await openCompareFor(tab, round))) return;
      if (!Compare.locateText(item.quote)) toast('这条引用的文字在对比里没找到,可能已被改写。');
      return;
    }
    if (note) focusNote(note.id, { scrollOnly: true });
    else toast('这条批注引用的文字已不在当前稿里。');
  }

  function roundGroup(tab, round) {
    const details = document.createElement('details');
    details.className = 'round-group'; details.dataset.kind = round.kind;
    if (round.versionId) details.dataset.versionId = round.versionId;
    if (round.degraded) details.dataset.degraded = '1';
    details.open = tab.openRounds.has(round.key);
    details.addEventListener('toggle', () => { if (details.open) tab.openRounds.add(round.key); else tab.openRounds.delete(round.key); });
    const summary = document.createElement('summary');
    const main = el('div');
    main.appendChild(el('strong', '', Number.isInteger(round.round) ? `第 ${round.round} 轮` : '未知轮次'));
    const counts = round.counts.total ? ` · 采纳 ${round.counts.applied} · 未采纳 ${round.counts.wontfix}${round.counts.cancelled ? ` · 作废 ${round.counts.cancelled}` : ''}` : '';
    main.appendChild(el('span', 'round-sub', `${round.label}${counts}`));
    summary.append(icon(round.icon), main, el('span', 'round-time', History.when(round.time)));
    details.appendChild(summary);
    const body = el('div', 'round-body');
    if (round.summary) body.appendChild(el('p', 'round-summary', round.summary));
    if (round.degraded && !round.active) body.appendChild(el('p', 'round-degraded', round.degradedText));
    const actions = el('div', 'round-actions');
    if (round.canCompare) actions.appendChild(smallButton(round.kind === 'restored' ? '对比恢复前后' : '显示改动', () => openCompareFor(tab, round)));
    if (round.canRetryPublish) actions.appendChild(smallButton('重试发布', () => retryPublish(tab, round.versionId)));
    if (round.canRestore) {
      const blocked = ACTIVE_REVIEW.has(tab.review.status) ? '这篇还有进行中的一轮,先走完或作废再恢复' : tab.mode !== 'read' || tab.dirty ? '先退出编辑再恢复' : '';
      const label = round.kind === 'restored' ? '恢复到恢复前的稿子' : '恢复到这轮改稿前';
      const button = smallButton(label, () => restoreToRound(tab, round, { back: round.kind === 'restored' }), 'danger-ish');
      if (blocked) { button.disabled = true; button.title = blocked; }
      actions.appendChild(button);
    }
    if (actions.childElementCount) body.appendChild(actions);
    if (round.items.length) {
      const list = el('div', 'result-list');
      round.items.forEach((item) => list.appendChild(resultItem(tab, item, round, round.kind === 'manual' || (round.kind === 'review' && round.label === '我自己改') ? '我' : 'AI')));
      body.appendChild(list);
    } else if (round.active) body.appendChild(el('p', 'round-empty', '进行中:本轮批注在上面的列表里。'));
    else if (round.kind === 'approved') body.appendChild(el('p', 'round-empty', '这轮没有批注,直接通过。'));
    else if (round.kind === 'restored') body.appendChild(el('p', 'round-empty', `正文换回了第 ${round.restoredFrom && round.restoredFrom.round ? round.restoredFrom.round : '?'} 轮改稿前;这一轮的「原稿」就是恢复前的稿子。`));
    else body.appendChild(el('p', 'round-empty', '这轮没有批注记录。'));
    details.appendChild(body);
    return details;
  }

  function legacyGroup(tab, legacy) {
    const details = document.createElement('details');
    details.className = 'round-group legacy-group'; details.dataset.kind = 'legacy';
    details.open = tab.openRounds.has('legacy');
    details.addEventListener('toggle', () => { if (details.open) tab.openRounds.add('legacy'); else tab.openRounds.delete('legacy'); });
    const summary = document.createElement('summary');
    const main = el('div');
    main.appendChild(el('strong', '', '更早(未分轮)'));
    main.appendChild(el('span', 'round-sub', `${legacy.count} 条旧批注,没有轮次归属`));
    summary.append(icon('ph-archive'), main, el('span', 'round-time', ''));
    details.appendChild(summary);
    const body = el('div', 'round-body');
    const list = el('div', 'result-list');
    legacy.items.forEach((item) => list.appendChild(resultItem(tab, item, null)));
    body.appendChild(list);
    details.appendChild(body);
    return details;
  }

  async function openCompareFor(tab, round, options = {}) {
    if (!tab || !round || !round.versionId || !tab.review.docId) return false;
    if (tab.mode !== 'read') { toast('先回到阅读模式再看改动。'); return false; }
    await Compare.open({
      tab, docId: tab.review.docId, versionId: round.versionId, round: round.round, kind: round.kind === 'restored' ? 'restored' : 'review',
      currentHash: tab.sourceHash, startIndex: options.startIndex,
    });
    return true;
  }

  function toggleCompare() {
    if (Compare.isOpen()) { Compare.close(); return; }
    const tab = activeTab();
    if (!tab) return;
    if (isPlain(tab) && !tab.review.docId) { toast('普通文档没有轮次,没有可对比的改动。'); return; }
    const versions = tab.versions || [];
    const card = History.returnCard({ review: tab.review, versions, annotations: tab.annotations });
    let target = card.show && card.canCompare && card.version ? { versionId: card.version.versionId, round: card.version.round, kind: card.version.kind } : null;
    if (!target) target = History.buildRounds({ review: tab.review, versions, annotations: tab.annotations }).rounds.find((round) => round.canCompare) || null;
    if (!target) { toast('还没有可对比的轮次:稿子回来后才有原稿与完成稿。'); return; }
    void openCompareFor(tab, target);
  }

  function autoComparedKeys() { if (!state.autoCompared) state.autoCompared = new Set(); return state.autoCompared; }

  function maybeAutoCompare(tab, card) {
    if (!tab.autoCompare || !tab.versions || activeTab() !== tab || tab.mode !== 'read') return;
    if (tab.autoCompare !== completionKey(tab.review)) { tab.autoCompare = null; return; }
    if (!card.show || !card.canCompare || !card.version) return;
    tab.autoCompare = null;
    if (!Compare.isOpen()) void openCompareFor(tab, { versionId: card.version.versionId, round: card.version.round, kind: card.version.kind });
  }

  async function restoreToRound(tab, round, options = {}) {
    if (!tab || !tab.review.docId || !round || !round.versionId) return;
    if (ACTIVE_REVIEW.has(tab.review.status)) { toast('这篇还有进行中的一轮,先走完或作废再恢复。', 'error'); return; }
    if (tab.mode !== 'read' || tab.dirty) { toast('先退出编辑再恢复。', 'error'); return; }
    const roundNo = Number.isInteger(round.round) ? round.round : '?';
    const title = options.back ? '恢复到恢复前的稿子？' : `恢复到第 ${roundNo} 轮改稿前？`;
    const message = options.back
      ? `正文会换回第 ${roundNo} 轮恢复之前的样子。现在这一版同样留在历史里,可以再恢复回来;附件不随恢复变化。`
      : History.restoreConfirmText(round.round);
    if (!(await confirmAction(title, message, '恢复'))) return;
    try {
      const result = await requestJson('/api/app/document/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId: tab.review.docId, toVersionId: round.versionId, expectedCurrentHash: tab.sourceHash, expectedLatestReviewId: isPlain(tab) ? undefined : tab.review.id, clientRequestId: requestId('restore') }),
      });
      Compare.close();
      await openReviewId(result.reviewId);
      toast(options.back ? '已恢复到恢复前的稿子。' : `已恢复到第 ${(result.restoredFrom && result.restoredFrom.round) || roundNo} 轮改稿前;恢复前的稿子留在历史里。`);
      void refreshRecents();
    } catch (error) {
      toast(friendlyError(error, '恢复'), 'error');
      void refreshTab(tab, { silent: true });
    }
  }

  async function retryPublish(tab, versionId) {
    try {
      await requestJson('/api/app/document/archive-retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId: tab.review.docId, versionId }) });
      Compare.invalidate(tab.review.docId, versionId);
      toast('这一轮的记录已重新发布。');
      await ensureVersions(tab, { force: true });
    } catch (error) { toast(friendlyError(error, '重试发布'), 'error'); }
  }

  // ---------- 轮次时间线(状态区点开) ----------

  function renderTimeline(tab) {
    const root = nodes.timelinePopover;
    root.replaceChildren();
    root.appendChild(el('div', 'timeline-title', '轮次时间线'));
    if (!tab || (isPlain(tab) && !tab.review.docId)) { root.appendChild(el('div', 'timeline-empty', '普通文档没有轮次。划词写下第一条批注就开始第 1 轮。')); return; }
    const entries = History.timeline({ review: tab.review, versions: tab.versions || [] });
    if (!entries.length) { root.appendChild(el('div', 'timeline-empty', '还没有轮次记录。')); return; }
    entries.forEach((entry) => {
      const item = el('div', `timeline-item${entry.current ? ' current' : ''}${entry.degraded ? ' degraded' : ''}`);
      item.appendChild(icon(entry.icon));
      item.appendChild(el('strong', '', Number.isInteger(entry.round) ? `第 ${entry.round} 轮` : '未知轮次'));
      item.appendChild(el('span', 'timeline-time', History.when(entry.time)));
      const counts = entry.counts && entry.counts.total ? ` · 采纳 ${entry.counts.applied} · 未采纳 ${entry.counts.wontfix}` : '';
      item.appendChild(el('span', 'timeline-sub', `${entry.label}${counts}${entry.degraded ? ' · 发布失败' : ''}`));
      if (entry.versionId) {
        item.addEventListener('click', () => {
          tab.historyOpen = true; tab.openRounds.add(entry.versionId);
          toggleTimeline(false); toggleRight(false); renderNotes(tab);
          const target = nodes.historyNotesList.querySelector(`.round-group[data-version-id="${CSS.escape(entry.versionId)}"]`);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
      root.appendChild(item);
    });
  }

  function toggleTimeline(force) {
    const open = typeof force === 'boolean' ? force : nodes.timelinePopover.hidden;
    if (open === !nodes.timelinePopover.hidden) return;
    nodes.timelinePopover.hidden = !open;
    nodes.reviewState.setAttribute('aria-expanded', String(open));
    if (open) { const tab = activeTab(); renderTimeline(tab); if (tab) void ensureVersions(tab); }
  }

  function noteCard(tab, note, historical) {
    const card = document.createElement('article');
    card.className = `note-card${tab.focusedNoteId === note.id ? ' focused' : ''}`; card.dataset.noteId = note.id;
    const quote = document.createElement('p'); quote.className = 'note-quote';
    if (isDocNote(note)) { quote.classList.add('doc-scope'); quote.textContent = '总体意见'; }
    else quote.textContent = String(note.quote || '').slice(0, 150);
    const comment = document.createElement('p'); comment.className = 'note-comment'; comment.textContent = note.comment || '';
    const footer = document.createElement('div'); footer.className = 'note-footer';
    const location = document.createElement('div'); location.className = 'note-location';
    const where = isDocNote(note) ? '全篇' : Array.isArray(note.headingPath) && note.headingPath.length ? note.headingPath[note.headingPath.length - 1] : '正文';
    const author = note.author && note.author !== '我(本机)' ? `${note.author} · ` : '';
    location.textContent = `${author}${where} · ${formatRelativeTime(note.createdAt || note.updatedAt)}`;
    location.title = Array.isArray(note.headingPath) ? note.headingPath.join(' › ') : '';
    footer.appendChild(location);
    card.append(quote, comment, footer);
    if (historical) {
      const status = document.createElement('div'); const effective = effectiveStatus(note);
      status.className = `note-status-badge${effective === 'wontfix' || effective === 'cancelled' ? ' wontfix' : ''}`;
      status.textContent = effective === 'wontfix' ? '本轮未修改' : effective === 'cancelled' ? '已作废(会话解锁)' : '已处理';
      card.appendChild(status);
      const resolvedNote = note.appliedNote || (effective === 'cancelled' ? note.cancelReason : '');
      if (resolvedNote) { const applied = document.createElement('div'); applied.className = 'applied-note'; applied.textContent = resolvedNote; card.appendChild(applied); }
    } else {
      const actions = document.createElement('div'); actions.className = 'note-actions';
      if (tab.review.status === 'reviewing') {
        actions.append(actionButton('修改', () => openAnnotationDialog({ note })), actionButton('删除', () => deleteNote(note), 'danger'));
      } else if (tab.review.status === 'applying' && tab.review.applyMode === 'manual') {
        actions.append(actionButton('不改', () => resolveNote(note, 'wontfix'), 'skip'), actionButton('标记已处理', () => resolveNote(note, 'applied'), 'resolve'));
      }
      if (actions.childElementCount) footer.appendChild(actions);
    }
    card.addEventListener('click', (event) => { if (!event.target.closest('button')) focusNote(note.id, { scrollOnly: historical }); });
    return card;
  }

  function actionButton(text, handler, className = '') {
    const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = text;
    button.addEventListener('click', (event) => { event.stopPropagation(); void handler(); }); return button;
  }

  function focusNote(noteId, options = {}) {
    const tab = activeTab(); if (!tab) return;
    tab.focusedNoteId = noteId; toggleRight(false); renderNotes(tab);
    const note = tab.annotations.find((item) => item.id === noteId); if (!note) return;
    if (tab.mode === 'edit') {
      const line = Math.max(1, Number(note.lineStart) || 1);
      if (window.DraftbackEditor && state.editorView && typeof window.DraftbackEditor.revealLine === 'function') {
        window.DraftbackEditor.revealLine(state.editorView, line);
      } else if (state.editorView && state.editorView.__draftbackFallback === true) {
        const value = state.editorView.value || '';
        const position = value.split('\n').slice(0, line - 1).reduce((total, part) => total + part.length + 1, 0);
        state.editorView.focus(); state.editorView.setSelectionRange(position, position);
      }
    } else if (isDocNote(note)) {
      nodes.readerScroll.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      const leaves = mappedLeafBlocks(); const resolved = Anchor.resolveAnchor(note, blockDescriptors(leaves));
      if (resolved.matched && leaves[resolved.startBlockIndex]) {
        leaves[resolved.startBlockIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    requestAnimationFrame(() => {
      const card = nodes.right.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`); if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    if (!options.scrollOnly) setTimeout(() => { tab.focusedNoteId = null; renderNotes(tab); }, 2600);
  }

  function orderedOpenNotes(tab) {
    const notes = openAnnotations(tab);
    const descriptors = blockDescriptors(mappedLeafBlocks());
    const keyed = notes.map((note, index) => {
      if (isDocNote(note)) return { note, block: -1, start: index };
      const resolved = Anchor.resolveAnchor(note, descriptors);
      return { note, block: resolved.matched ? resolved.startBlockIndex : Number.MAX_SAFE_INTEGER, start: resolved.matched ? resolved.globalStart : index };
    });
    keyed.sort((a, b) => a.block - b.block || a.start - b.start);
    return keyed.map((entry) => entry.note);
  }
  function stepNote(direction) {
    const tab = activeTab();
    if (!tab || isPlain(tab) || tab.mode !== 'read') return;
    const notes = orderedOpenNotes(tab);
    if (!notes.length) { toast('本轮还没有批注。'); return; }
    const current = notes.findIndex((note) => note.id === state.navNoteId);
    const next = current < 0 ? (direction > 0 ? 0 : notes.length - 1) : (current + (direction > 0 ? 1 : -1) + notes.length) % notes.length;
    state.navNoteId = notes[next].id;
    focusNote(notes[next].id, { scrollOnly: true });
  }
  function annotateSelection() {
    const tab = activeTab();
    if (!tab || tab.mode !== 'read') { toast('批注在阅读模式里写。先切到「阅读与批注」(⌘/)。'); return; }
    if (!statusCanAnnotate(tab)) { toast('现在这一轮不能批注。'); return; }
    const anchor = captureSelectionAnchor() || state.cachedAnchor;
    if (!anchor) { toast('先在正文里选中要批注的文字。'); return; }
    openAnnotationDialog({ anchor });
  }
  function openDocNote() {
    const tab = activeTab();
    if (!tab || tab.mode !== 'read' || !ANNOTATABLE.has(tab.review.status) || isReadOnly(tab)) { toast('现在不能写总体意见。'); return; }
    openAnnotationDialog({ scope: 'document' });
  }

  function openAnnotationDialog({ anchor = null, note = null, scope = null }) {
    const tab = activeTab(); if (!tab || tab.mode !== 'read' || !ANNOTATABLE.has(tab.review.status)) return;
    const docScope = scope === 'document' || isDocNote(note);
    state.dialog = {
      tabId: tab.id,
      sourceHash: tab.sourceHash,
      anchor: note || docScope ? null : anchor,
      scope: docScope ? 'document' : null,
      noteId: note && note.id,
      requestId: note ? null : requestId('annotation'),
    };
    nodes.annotationTitle.textContent = docScope
      ? (note ? '编辑总体意见' : '写总体意见')
      : (note ? '编辑批注' : '添加批注');
    nodes.annotationQuote.hidden = docScope;
    nodes.annotationQuote.textContent = docScope ? '' : `“${((note || anchor || {}).quote) || ''}”`;
    nodes.annotationText.placeholder = docScope
      ? '对整篇文档的意见：整体结构、方向、要不要重写、想先讨论什么……'
      : '这段内容哪里需要修改？希望补充什么？';
    nodes.annotationText.value = note ? note.comment || '' : '';
    nodes.annotationText.dataset.initial = nodes.annotationText.value;
    nodes.annotationSave.textContent = note ? '保存修改' : '保存批注';
    nodes.annotationDialog.hidden = false;
    requestAnimationFrame(() => {
      restoreAnnotationDialogPosition();
      setTimeout(() => nodes.annotationText.focus(), 30);
    });
  }

  // Esc / 点遮罩:有没保存的文字时不直接扔掉,提醒用「取消」按钮明确放弃
  function dismissAnnotationDialog() {
    const current = nodes.annotationText.value;
    if (current.trim() && current !== (nodes.annotationText.dataset.initial || '')) {
      toast('批注还没有保存：点「保存批注」保留，或点「取消」放弃。', 'error');
      return;
    }
    closeAnnotationDialog();
  }

  function closeAnnotationDialog(options = {}) {
    endAnnotationDialogDrag();
    nodes.annotationDialog.hidden = true;
    nodes.annotationSave.disabled = false;
    nodes.annotationSave.textContent = '保存批注';
    if (!options.keepState) state.dialog = null;
  }

  function dialogPositionKey() { return 'draftback.annotationDialogPosition'; }

  function clampAnnotationDialog(left, top) {
    const panel = nodes.annotationDialogPanel;
    const width = panel.offsetWidth || 560;
    const height = panel.offsetHeight || 420;
    const margin = 8;
    return {
      left: Math.min(Math.max(margin, Number(left) || margin), Math.max(margin, window.innerWidth - width - margin)),
      top: Math.min(Math.max(margin, Number(top) || margin), Math.max(margin, window.innerHeight - height - margin)),
    };
  }

  function setAnnotationDialogPosition(left, top, options = {}) {
    const position = clampAnnotationDialog(left, top);
    const panel = nodes.annotationDialogPanel;
    panel.style.setProperty('--annotation-dialog-left', `${Math.round(position.left)}px`);
    panel.style.setProperty('--annotation-dialog-top', `${Math.round(position.top)}px`);
    panel.style.setProperty('--annotation-dialog-translate-x', '0px');
    panel.style.setProperty('--annotation-dialog-translate-y', '0px');
    if (options.persist !== false) {
      try { localStorage.setItem(dialogPositionKey(), JSON.stringify(position)); } catch (_) {}
    }
    return position;
  }

  function resetAnnotationDialogPosition() {
    const panel = nodes.annotationDialogPanel;
    panel.style.removeProperty('--annotation-dialog-left');
    panel.style.removeProperty('--annotation-dialog-top');
    panel.style.removeProperty('--annotation-dialog-translate-x');
    panel.style.removeProperty('--annotation-dialog-translate-y');
    try { localStorage.removeItem(dialogPositionKey()); } catch (_) {}
  }

  function restoreAnnotationDialogPosition() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(dialogPositionKey()) || 'null'); } catch (_) {}
    if (stored && Number.isFinite(stored.left) && Number.isFinite(stored.top)) {
      setAnnotationDialogPosition(stored.left, stored.top, { persist: false });
    } else {
      resetAnnotationDialogPosition();
    }
  }

  function beginAnnotationDialogDrag(event) {
    if (event.button !== 0 || event.target.closest('.dialog-close')) return;
    const panel = nodes.annotationDialogPanel;
    const rect = panel.getBoundingClientRect();
    setAnnotationDialogPosition(rect.left, rect.top, { persist: false });
    state.dialogDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    panel.classList.add('is-dragging');
    try { nodes.annotationDialogHandle.setPointerCapture(event.pointerId); } catch (_) {}
    event.preventDefault();
  }

  function moveAnnotationDialog(event) {
    if (!state.dialogDrag || event.pointerId !== state.dialogDrag.pointerId) return;
    setAnnotationDialogPosition(
      event.clientX - state.dialogDrag.offsetX,
      event.clientY - state.dialogDrag.offsetY,
      { persist: false },
    );
    event.preventDefault();
  }

  function endAnnotationDialogDrag(event = null) {
    if (!state.dialogDrag || (event && event.pointerId !== state.dialogDrag.pointerId)) return;
    const pointerId = state.dialogDrag.pointerId;
    state.dialogDrag = null;
    nodes.annotationDialogPanel.classList.remove('is-dragging');
    try { nodes.annotationDialogHandle.releasePointerCapture(pointerId); } catch (_) {}
    if (!nodes.annotationDialog.hidden) {
      const rect = nodes.annotationDialogPanel.getBoundingClientRect();
      setAnnotationDialogPosition(rect.left, rect.top);
    }
  }

  function keepAnnotationDialogInView() {
    if (nodes.annotationDialog.hidden) return;
    const rect = nodes.annotationDialogPanel.getBoundingClientRect();
    setAnnotationDialogPosition(rect.left, rect.top, { persist: false });
  }

  async function saveAnnotation() {
    const dialog = state.dialog;
    let tab = dialog && state.tabs.find((candidate) => candidate.id === dialog.tabId);
    const comment = nodes.annotationText.value.trim();
    if (!tab || !dialog || !comment) return toast('批注内容不能为空。', 'error');
    if (tab.sourceHash !== dialog.sourceHash) {
      return toast('这条批注对应的文档状态已经变化，请关闭弹窗后重新选择。', 'error');
    }
    nodes.annotationSave.disabled = true; nodes.annotationSave.textContent = '保存中…';
    try {
      let result;
      if (tab.review.status !== 'reviewing' && !dialog.noteId) {
        // 规则③:首次成功保存一条批注或总体意见才算开轮。普通文档开第 1 轮并锁定原文,稿子回来 / 作废后开下一轮。
        // 开轮与存批注在服务端合成一步:批注没存成就不留空轮。只选字、打开输入框又取消,都走不到这里。
        if (tab.dirty && !(await saveSource(tab))) throw new Error('请先保存编辑中的内容。');
        const wasPlain = isPlain(tab);
        const payload = { ...dialog.anchor, comment, author: '我(本机)', clientRequestId: dialog.requestId };
        if (dialog.scope === 'document') payload.scope = 'document';
        result = await requestJson('/api/app/review/open-annotate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tab.review.sourceFile, note: payload }),
        });
        const bundle = await fetchBundle(result.review.id);
        const next = upsertTab(bundle, { activate: true });
        closeAnnotationDialog();
        window.getSelection()?.removeAllRanges(); state.cachedAnchor = null; nodes.annotate.hidden = true;
        renderApp(); renderTabs(); void refreshRecents();
        toast(wasPlain ? '原文已锁定,开始第 1 轮审阅;批注已保存,批完点「交给 AI」。' : `已开始第 ${(next && next.review.round) || ''} 轮审阅,批注已保存。`);
        return;
      }
      if (dialog.noteId) {
        result = await requestJson(`/api/annotations?r=${encodeURIComponent(tab.id)}&id=${encodeURIComponent(dialog.noteId)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment }),
        });
        const current = tab.annotations.find((item) => item.id === dialog.noteId);
        if (current) Object.assign(current, result.note || {}, { comment });
      } else {
        const payload = {
          ...dialog.anchor,
          comment,
          author: '我(本机)',
          clientRequestId: dialog.requestId,
          reviewSessionId: tab.id,
          sourceHash: tab.review.sourceHash,
        };
        if (dialog.scope === 'document') payload.scope = 'document';
        result = await requestJson(`/api/annotations?r=${encodeURIComponent(tab.id)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (result.note && !tab.annotations.some((item) => item.id === result.note.id)) tab.annotations.push(result.note);
      }
      closeAnnotationDialog();
      window.getSelection()?.removeAllRanges(); state.cachedAnchor = null; nodes.annotate.hidden = true;
      if (tab.id === state.activeId) {
        renderMarkers(tab); renderNotes(tab); renderStatus(tab);
      }
      renderTabs();
      toast(dialog.noteId ? '批注已更新。' : '批注已保存。');
    } catch (error) {
      nodes.annotationSave.disabled = false;
      nodes.annotationSave.textContent = dialog.noteId ? '保存修改' : '保存批注';
      toast(friendlyError(error, dialog.noteId ? '修改批注' : '保存批注'), 'error');
      void refreshTab(tab, { silent: true });
    }
  }

  async function deleteNote(note) {
    const tab = activeTab(); if (!tab) return;
    try {
      await requestJson(`/api/annotations?r=${encodeURIComponent(tab.id)}&id=${encodeURIComponent(note.id)}`, { method: 'DELETE' });
      tab.annotations = tab.annotations.filter((item) => item.id !== note.id);
      renderMarkers(tab); renderNotes(tab); renderStatus(tab); publishMenuState();
      toast('已删除这条批注。', '', { tag: 'undo-delete', duration: 5000, action: { label: '撤销', run: () => undoDeleteNote(tab, note) } });
    } catch (error) { toast(friendlyError(error, '删除批注'), 'error'); }
  }

  async function undoDeleteNote(tab, note) {
    try {
      await requestJson(`/api/app/annotation/restore?r=${encodeURIComponent(tab.id)}&id=${encodeURIComponent(note.id)}`, { method: 'POST' });
      await refreshTab(tab, { silent: true });
      toast('已放回这条批注。');
    } catch (error) {
      toast(error instanceof ApiError && error.status === 409 ? '这一轮已交出,批注不能再放回。' : friendlyError(error, '撤销删除'), 'error');
    }
  }

  async function resolveNote(note, status) {
    const tab = activeTab(); if (!tab) return;
    captureEditorValue(tab);
    // A note is not considered handled until the corresponding source edits
    // are safely on disk.  This prevents a crash or failed save from leaving a
    // green "已处理" record while the Markdown still contains the old text.
    if (tab.dirty && !(await saveSource(tab))) return;
    try {
      const result = await requestJson(`/api/app/annotation?r=${encodeURIComponent(tab.id)}&id=${encodeURIComponent(note.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          appliedNote: status === 'applied' ? '由我在回稿中手工修改并确认。' : '由我在回稿中确认本轮不修改。',
          expectedSourceHash: tab.sourceHash,
          expectedRevision: tab.revision,
        }),
      });
      const current = tab.annotations.find((item) => item.id === note.id);
      if (current) Object.assign(current, result.annotation || {}, { status });
      renderNotes(tab); renderStatus(tab); renderMarkers(tab);
      toast(status === 'applied' ? '已标记为处理完成。' : '已记录为本轮不修改。');
    } catch (error) { toast(friendlyError(error, '更新批注状态'), 'error'); }
  }

  const Patcher = window.DraftbackPatch || null;
  function splitFrontMatter(text) {
    return Patcher ? Patcher.splitFrontMatter(String(text || '')) : { frontMatter: '', body: String(text || '') };
  }
  // 编辑器拿到的是去掉 Front Matter 的正文;对外(草稿、保存)的值一律把 Front Matter 原样接回去。
  function editorBody(text) { return splitFrontMatter(text).body; }
  function withFrontMatter(tab, body) { return splitFrontMatter(tab.source).frontMatter + body; }

  function captureEditorValue(tab) {
    if (!tab || state.editorTabId !== tab.id || !state.editorView) return;
    const value = withFrontMatter(tab, getEditorValue());
    if (value !== tab.source) { tab.editorDraft = value; tab.dirty = true; }
  }

  function getEditorValue() {
    if (!state.editorView) return '';
    if (window.DraftbackEditor && state.editorView.__draftbackFallback !== true) return window.DraftbackEditor.getValue(state.editorView);
    return state.editorView.value || '';
  }

  function createEditor(tab) {
    destroyEditor();
    nodes.codeEditor.replaceChildren();
    const doc = editorBody(tab.editorDraft != null ? tab.editorDraft : tab.source);
    if (window.DraftbackEditor) {
      state.editorView = window.DraftbackEditor.create(nodes.codeEditor, {
        doc, onChange: (value) => editorChanged(tab, withFrontMatter(tab, value)),
        uploadImage: (file) => uploadImageFor(tab, file),
        resolveImageUrl: (url) => editorImageUrl(tab, url),
      });
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = doc; textarea.className = 'fallback-editor'; textarea.__draftbackFallback = true;
      textarea.addEventListener('input', () => editorChanged(tab, withFrontMatter(tab, textarea.value)));
      nodes.codeEditor.appendChild(textarea); state.editorView = textarea;
    }
    state.editorTabId = tab.id;
  }

  // 粘贴、拖入、选择的图片存到文档旁的 images/(服务端负责命名与不覆盖),正文里写相对路径
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
      reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }
  async function uploadImageFor(tab, file) {
    if (!file) return '';
    if (file.size > 20 * 1024 * 1024) { toast('图片超过 20 MB,请先压缩再插入。', 'error'); return ''; }
    try {
      const data = await readFileAsBase64(file);
      const result = await requestJson('/api/app/document/image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: tab.review.sourceFile, name: file.name || 'image', type: file.type, data }),
      });
      toast(`图片已存到文档旁的 ${result.relPath}`);
      return result.relPath;
    } catch (error) { toast(friendlyError(error, '插入图片'), 'error'); return ''; }
  }
  // 编辑器里显示图片:相对路径经本地服务读(和阅读模式同一个地址),网络图片与 data: 原样
  function editorImageUrl(tab, url) {
    const value = String(url || '');
    if (!value || /^(https?:|data:|blob:)/i.test(value)) return value;
    return `/api/app/file?${assetOwnerQuery(tab)}&path=${encodeURIComponent(localAssetPath(value))}`;
  }

  function destroyEditor() {
    if (state.editorView && window.DraftbackEditor && state.editorView.__draftbackFallback !== true) {
      try { window.DraftbackEditor.destroy(state.editorView); } catch (_) {}
    }
    state.editorView = null; state.editorTabId = null; nodes.codeEditor.replaceChildren();
  }

  function editorChanged(tab, value) {
    if (tab.id !== state.activeId) return;
    tab.editorDraft = value; tab.dirty = value !== tab.source;
    if (tab.dirty && !tab.saveRequestId) tab.saveRequestId = requestId('source');
    if (tab.dirty) scheduleDraft(tab); else clearDraft(tab);
    updateSaveState(tab);
    if (!tab.dirty && tab.remotePending) {
      const pending = tab.remotePending;
      void queueRemoteReviewChange(pending.reviewId || tab.id, pending);
    }
  }

  function renderEditor(tab) {
    clearMarkerOverlay();
    if (!nodes.findBar.hidden) { nodes.findBar.hidden = true; clearFind(); }
    tab.mode = 'edit';
    nodes.readerPane.hidden = true; nodes.editorPane.hidden = false;
    if (state.editorTabId !== tab.id) createEditor(tab);
    updateSaveState(tab);
    // 「提交修改」只有一个家:工具栏右边的主按钮(编辑条里不再重复一个)
    nodes.finishManual.hidden = true;
    renderOutline(tab.outline);
  }

  function updateSaveState(tab, mode = '') {
    nodes.editorSaveState.className = `save-state${mode ? ` ${mode}` : (tab.dirty ? ' dirty' : '')}`;
    nodes.editorSaveState.textContent = mode === 'saving' ? '保存中…' : mode === 'error' ? '保存失败，修改仍在编辑器中' : tab.dirty ? '有未保存的修改' : '所有更改均已保存';
    nodes.saveButton.disabled = mode === 'saving' || !tab.dirty;
  }

  async function saveSource(tab = activeTab()) {
    if (!tab) return false;
    if (tab.mode === 'edit') captureEditorValue(tab);
    if (!tab.dirty) return true;
    if (tab.mode !== 'edit') {
      tab.mode = 'edit'; renderApp();
      toast('仍有未保存的修改，已返回编辑模式。', 'error');
      return false;
    }
    const edited = tab.editorDraft != null ? tab.editorDraft : withFrontMatter(tab, getEditorValue());
    const writeback = patchForSave(tab, edited);
    if (writeback.needsConfirm && !(await confirmWriteback(writeback))) { updateSaveState(tab); return false; }
    const content = writeback.text;
    const idempotencyKey = tab.saveRequestId || requestId('source'); tab.saveRequestId = idempotencyKey;
    updateSaveState(tab, 'saving');
    try {
      const result = isPlain(tab)
        ? await requestJson('/api/app/document', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: tab.review.sourceFile, content, expectedHash: tab.sourceHash, clientRequestId: idempotencyKey }),
        })
        : await requestJson(`/api/app/source?r=${encodeURIComponent(tab.id)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, expectedHash: tab.sourceHash, clientRequestId: idempotencyKey }),
        });
      tab.source = content;
      tab.sourceHash = result.currentHash || result.hash || (result.review && result.review.workingHash) || tab.sourceHash;
      tab.revision = Number(result.currentRevision ?? result.revision ?? tab.revision);
      if (result.review) tab.review = { ...tab.review, ...result.review };
      tab.dirty = false; tab.editorDraft = null; tab.saveRequestId = null; tab.renderedHash = null;
      clearDraft(tab);
      if (state.editorTabId === tab.id && state.editorView && window.DraftbackEditor && state.editorView.__draftbackFallback !== true) {
        // 编辑器里的内容按回写后的正文重置,下次保存以这一版为原文。
        try { window.DraftbackEditor.setValue(state.editorView, editorBody(content)); } catch (_) {}
      }
      updateSaveState(tab); renderTabs();
      toast(writeback.summary);
      if (tab.remotePending) {
        const pending = tab.remotePending;
        void queueRemoteReviewChange(pending.reviewId || tab.id, pending);
      }
      return true;
    } catch (error) {
      updateSaveState(tab, 'error');
      toast(friendlyError(error, '保存 Markdown'), 'error');
      return false;
    }
  }

  // 块级局部回写:只把用户真改过的块写回文件,其余块保持原文字节(static/markdown-patch.js)。
  function patchForSave(tab, edited) {
    const live = state.editorTabId === tab.id && state.editorView && window.DraftbackEditor && state.editorView.__draftbackFallback !== true;
    if (!Patcher || !live || typeof window.DraftbackEditor.normalize !== 'function') {
      return { text: edited, summary: 'Markdown 已保存。', stats: null };
    }
    let normalized = null;
    try { normalized = window.DraftbackEditor.normalize(state.editorView, editorBody(tab.source)); } catch (_) { normalized = null; }
    if (typeof normalized !== 'string') return { text: edited, summary: 'Markdown 已保存。', stats: null };
    let result;
    try { result = Patcher.patch(md, tab.source, normalized, editorBody(edited)); }
    catch (error) { console.warn('块级回写失败,退回整篇保存', error); return { text: edited, summary: 'Markdown 已保存(整篇写入)。', stats: null }; }
    const s = result.stats;
    const touched = s.modified + s.inserted + s.deleted;
    const summary = `已保存:改动 ${touched} 处,其余 ${s.kept} 处原样保留。`;
    const risky = s.lossyTouched + s.listFallback + s.fallback + s.unmatched;
    if (!risky) return { text: result.text, summary, stats: s };
    const reasons = [];
    if (s.lossyTouched) reasons.push(`${s.lossyTouched} 处含编辑器无法无损表示的内容(原始 HTML、公式、脚注等),将按编辑器的写法改写`);
    if (s.listFallback) reasons.push(`${s.listFallback} 个列表增删了项,整个列表将按编辑器的写法重排`);
    if (s.fallback || s.unmatched) reasons.push(`${s.fallback + s.unmatched} 处无法与原文对齐,将整段改写`);
    return { text: result.text, summary, stats: s, needsConfirm: reasons };
  }

  async function confirmWriteback(writeback) {
    if (!writeback || !writeback.needsConfirm) return true;
    const s = writeback.stats;
    return confirmAction(
      '保存会改写你没改过的内容',
      `本次保存:改动 ${s.modified + s.inserted + s.deleted} 处,保留 ${s.kept} 处。其中:\n${writeback.needsConfirm.map((item) => `• ${item}`).join('\n')}\n\n继续保存,或取消后把这些段落改回去再保存。`,
      '仍然保存',
    );
  }

  async function enterEditMode() {
    let tab = activeTab(); if (!tab) return;
    if (isReadOnly(tab)) { toast(tab.sourceMeta.readOnlyReason || '文件不是 UTF-8 编码,只读。'); return; }
    if (isPlain(tab)) {
      await setEditing(tab, true);
      tab.mode = 'edit'; persistTabs(); renderApp();
      setTimeout(() => { if (window.DraftbackEditor && state.editorView) window.DraftbackEditor.focus(state.editorView); }, 60);
      return;
    }
    const review = tab.review;
    if (review.status === 'conflict' || (review.status === 'applying' && review.applyMode !== 'manual')) return;
    if (review.status === 'reviewing') {
      const count = openAnnotations(tab).length;
      const round = Number.isInteger(review.round) ? `第 ${review.round} 轮` : '这一轮';
      const choice = await chooseAction('原文已锁定',
        count
          ? `这篇正在${round}批注中。要直接改原文,选「我自己改」:${count} 条批注交出,你对照右栏逐条处理后提交。只想另外改一份,选「另存为副本」:原稿和批注都不动。`
          : `这篇正在${round}批注中,还没有批注。选「我自己改」:这一轮记为通过,然后进入编辑。只想另外改一份,选「另存为副本」。`,
        { accept: '我自己改', alt: '另存为副本…' });
      if (choice === 'alt') { await saveCopy(tab); return; }
      if (choice !== 'accept') return;
      // The edit-entry dialog above is already the user's confirmation.  Do
      // not immediately ask the same question a second time inside
      // submitReview().
      const submitted = await submitReview(tab, { silentSuccess: true, skipConfirm: true });
      if (!submitted) return;
      tab = activeTab();
    }
    if (tab.review.status === 'complete' || tab.review.status === 'cancelled') {
      // 终态之后进编辑 = 开一轮"手工修改轮"(applying/manual),把写者身份记进会话,
      // 智能体此时 mdreview open 会看到用户正在改,不会把文档重新冻结。
      try {
        const result = await requestJson(`/api/app/review/manual-edit?r=${encodeURIComponent(tab.id)}`, { method: 'POST' });
        const bundle = await fetchBundle(result.review.id);
        tab = upsertTab(bundle, { activate: true });
      } catch (error) { toast(friendlyError(error, '进入编辑'), 'error'); return; }
    }
    if (tab.review.status === 'ready_to_apply') {
      try {
        const result = await requestJson(`/api/app/review/begin-apply?r=${encodeURIComponent(tab.id)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manual' }),
        });
        tab.review = result.review; tab.sourceHash = tab.review.workingHash || tab.sourceHash;
      } catch (error) { toast(friendlyError(error, '开始手工修改'), 'error'); return; }
    }
    tab.mode = 'edit';
    if (tab.review.status === 'applying') { state.leftCollapsed = true; state.rightCollapsed = false; }
    persistTabs(); renderApp();
    setTimeout(() => { if (window.DraftbackEditor && state.editorView) window.DraftbackEditor.focus(state.editorView); }, 60);
  }

  async function enterReadMode() {
    const tab = activeTab(); if (!tab) return;
    captureEditorValue(tab);
    if (tab.dirty && !(await saveSource(tab))) return;
    tab.mode = 'read'; persistTabs(); renderApp();
    if (isPlain(tab)) await setEditing(tab, false);
  }

  async function submitReview(tab, options = {}) {
    dismissToast('undo-delete');
    const count = openAnnotations(tab).length;
    if (!options.skipConfirm) {
      const accepted = await confirmAction(
        count ? '完成本轮审阅？' : '审核通过，定稿？',
        count
          ? `提交后原文继续保持只读，等待 Agent 或你手工处理 ${count} 条批注。`
          : '全文没有任何批注，将记录为“审核通过”，本轮结束。若想让智能体重写或先讨论，请取消，在右栏写一条总体意见再提交。',
        count ? '完成本轮审阅' : '通过并定稿',
      );
      if (!accepted) return false;
    }
    nodes.primaryAction.disabled = true; nodes.primaryAction.textContent = '提交中…';
    try {
      const result = await requestJson(`/api/review/submit?r=${encodeURIComponent(tab.id)}`, { method: 'POST' });
      tab.review = result.review;
      if (!options.silentSuccess) toast(tab.review.status === 'complete' ? '本轮审核通过。' : `已交给 AI · ${count} 条批注。`);
      renderApp(); void refreshRecents(); return true;
    } catch (error) { toast(friendlyError(error, '提交审阅'), 'error'); void refreshTab(tab, { silent: true }); return false; }
    finally { nodes.primaryAction.disabled = false; }
  }

  async function finishManualApply() {
    const tab = activeTab(); if (!tab) return;
    if (openAnnotations(tab).length) return toast(`仍有 ${openAnnotations(tab).length} 条未处理批注，请逐条确认后再提交。`, 'error');
    if (!(await saveSource(tab))) return;
    const accepted = await confirmAction('提交本轮修改？', '源 Markdown 已保存，提交后本轮会进入完成状态，可以开始下一轮审阅。', '提交修改');
    if (!accepted) return;
    try {
      const result = await requestJson(`/api/app/review/complete?r=${encodeURIComponent(tab.id)}`, { method: 'POST' });
      tab.review = result.review; tab.mode = 'read'; tab.renderedHash = null; destroyEditor();
      renderApp(); void refreshRecents(); toast('本轮手工修改已完成。');
    } catch (error) { toast(friendlyError(error, '提交修改'), 'error'); }
  }

  async function finalizeReviewTab(tab, options = {}) {
    if (!tab || tab.review.status !== 'complete') return false;
    if (!options.skipConfirm) {
      const accepted = await confirmAction('通过并定稿？',
        '把这一版记为终稿:正在等待的 AI 会收到"审阅结束"。以后再划词批注,会开始新的一轮。',
        '通过 · 定稿');
      if (!accepted) return false;
    }
    nodes.primaryAction.disabled = true;
    try {
      const result = await requestJson(`/api/app/review/finalize?r=${encodeURIComponent(tab.id)}`, { method: 'POST' });
      tab.review = result.review;
      renderApp(); void refreshRecents();
      toast('已定稿，AI 已收到通知。');
      return true;
    } catch (error) { toast(friendlyError(error, '定稿'), 'error'); void refreshTab(tab, { silent: true }); return false; }
    finally { nodes.primaryAction.disabled = false; }
  }

  // 零批注时的「通过 · 定稿」:确认一次,然后记为通过并直接定稿(它告诉 AI 这篇结束了)
  async function approveAndFinalize(tab) {
    const accepted = await confirmAction('通过并定稿？',
      '全文没有任何批注:记为通过并定稿,AI 会收到"审阅结束"。若想让 AI 重写或先讨论，请取消，写一条总体意见再交出。',
      '通过 · 定稿');
    if (!accepted) return;
    const submitted = await submitReview(tab, { skipConfirm: true, silentSuccess: true });
    if (!submitted) return;
    const current = activeTab();
    if (current && current.review.status === 'complete') await finalizeReviewTab(current, { skipConfirm: true });
  }

  async function copyInstruction(tab) {
    const text = Handoff.instructionText({ absPath: tab.review.sourceFile, cliScript: tab.review.cliScript });
    const ok = await Handoff.copyText(text);
    toast(ok ? '改稿指令已复制。贴给任何智能体(Claude Code、Codex…),它就能接上这一轮。' : '没能复制到剪贴板,请检查系统权限。', ok ? 'info' : 'error');
  }

  // ---------- 工具栏左边:文档名,点开看字数等(UI 方案 3.2) ----------
  function renderDocTitle(tab) {
    nodes.docTitleButton.hidden = !tab;
    if (!tab) { toggleDocInfo(false); return; }
    nodes.docTitleText.textContent = tab.review.title || tab.review.file || '文档';
    nodes.docTitleButton.title = tab.review.sourceFile || '';
  }
  function docStats(text) {
    const body = splitFrontMatter(String(text || '')).body;
    const prose = body.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]+>/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    const cjk = (prose.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const words = (prose.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g) || []).length;
    const paragraphs = body.split(/\n\s*\n/).filter((part) => part.trim() && !/^\s*(---|\*\*\*)\s*$/.test(part)).length;
    return { cjk, words, total: cjk + words, paragraphs };
  }
  function toggleDocInfo(force) {
    const open = typeof force === 'boolean' ? force : nodes.docInfoPopover.hidden;
    nodes.docInfoPopover.hidden = !open;
    nodes.docTitleButton.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const tab = activeTab();
    if (!tab) { nodes.docInfoPopover.hidden = true; return; }
    const stats = docStats(tab.mode === 'edit' && tab.editorDraft != null ? tab.editorDraft : tab.source);
    const root = nodes.docInfoPopover;
    root.replaceChildren();
    const name = document.createElement('div'); name.className = 'doc-info-name'; name.textContent = tab.review.sourceFile || tab.review.title;
    root.appendChild(name);
    const rows = [
      ['字数', `${stats.total.toLocaleString('zh-CN')}${stats.cjk && stats.words ? `(中文 ${stats.cjk.toLocaleString('zh-CN')} 字 · 英文 ${stats.words.toLocaleString('zh-CN')} 词)` : ''}`],
      ['段落', String(stats.paragraphs)],
      ['本轮批注', isPlain(tab) ? '还没开始审阅' : `${openAnnotations(tab).length} 条未处理`],
      ['最后修改', tab.sourceMeta && tab.sourceMeta.mtimeMs ? formatRelativeTime(new Date(tab.sourceMeta.mtimeMs).toISOString()) : '—'],
    ];
    const table = document.createElement('dl'); table.className = 'doc-info-table';
    rows.forEach(([label, value]) => { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = value; table.append(dt, dd); });
    root.appendChild(table);
    const actions = document.createElement('div'); actions.className = 'doc-info-actions';
    const reveal = document.createElement('button'); reveal.type = 'button'; reveal.className = 'secondary-button compact-button'; reveal.textContent = '在访达中显示';
    reveal.addEventListener('click', () => { toggleDocInfo(false); revealActive(); });
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary-button compact-button'; copy.textContent = '另存为副本…';
    copy.addEventListener('click', () => { toggleDocInfo(false); void saveCopy(); });
    actions.append(reveal, copy);
    root.appendChild(actions);
  }

  // 工具栏上的「对比视图」开关:只在有可对比的一轮时出现(情境层)
  function renderCompareToggle(tab) {
    if (!tab) { nodes.compareToggleButton.hidden = true; return; }
    const versions = tab.versions || [];
    const reviewTab = !isPlain(tab);
    const card = reviewTab ? History.returnCard({ review: tab.review, versions, annotations: tab.annotations }) : { show: false };
    const available = Compare.isOpen() || Boolean(card.show && card.canCompare);
    nodes.compareToggleButton.hidden = !available || tab.mode !== 'read';
    nodes.compareToggleButton.classList.toggle('active', Compare.isOpen());
    nodes.compareToggleButton.setAttribute('aria-pressed', String(Compare.isOpen()));
  }

  // 左栏底部:iCloud 一行(点开到设置)
  async function renderSyncFooter() {
    let text = 'iCloud', icon = 'ph-cloud', tone = '';
    try {
      const settings = state.settings || (bridge && typeof bridge.getSettings === 'function' ? await bridge.getSettings().catch(() => null) : null);
      if (settings) state.settings = settings;
      if (settings && !settings.syncHelperAvailable) { text = '这个安装包不带同步'; icon = 'ph-cloud-slash'; tone = 'muted'; }
      else if (settings && !settings.syncEnabled) { text = 'iCloud 同步已关闭'; icon = 'ph-cloud-slash'; tone = 'muted'; }
      else {
        const status = await requestJson('/api/app/sync/status');
        const helper = status.helper;
        const last = helper ? Date.parse(helper.lastPollAt || '') : NaN;
        if (!helper) { text = '同步程序没有运行'; icon = 'ph-cloud-slash'; tone = 'warn'; }
        else if (helper.accountStatus && helper.accountStatus !== 'available') { text = '未登录 iCloud'; icon = 'ph-cloud-slash'; tone = 'warn'; }
        else if (helper.error) { text = 'iCloud 同步出错'; icon = 'ph-cloud-warning'; tone = 'warn'; }
        else if (!Number.isFinite(last) || Date.now() - last > 3 * 60 * 1000) { text = '同步程序没有在运行'; icon = 'ph-cloud-slash'; tone = 'warn'; }
        else { text = `iCloud 已同步 · ${formatRelativeTime(helper.lastPollAt)}`; icon = 'ph-cloud-check'; }
      }
    } catch (_) { text = '读不到同步状态'; icon = 'ph-cloud-slash'; tone = 'warn'; }
    nodes.syncFooterText.textContent = text;
    nodes.syncFooterIcon.className = `ph ${icon}`;
    nodes.syncFooter.dataset.tone = tone;
  }

  // ---------- 快速打开(⇧⌘O):只搜打开着的标签与最近文件,键盘一秒切换 ----------
  function quickOpenItems(query) {
    const seen = new Set();
    const items = [];
    for (const tab of state.tabs) {
      const filePath = tab.review.sourceFile;
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      items.push({ path: filePath, file: filePath.split('/').pop(), directory: posixDir(filePath), note: '已打开', tabId: tab.id, order: 0 });
    }
    state.recents.forEach((item, index) => {
      if (!item.absPath || seen.has(item.absPath) || !item.exists) return;
      seen.add(item.absPath);
      const active = item.activeReview;
      const note = active ? statusLabel(active.status, active.applyMode) : item.lastReview ? statusLabel(item.lastReview.status, item.lastReview.applyMode, item.lastReview.outcome) : '普通文档';
      items.push({ path: item.absPath, file: item.file, directory: item.directory, note, order: 1 + index });
    });
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return items.slice(0, 30);
    return items
      .map((item) => {
        const name = item.file.toLowerCase();
        const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : item.directory.toLowerCase().includes(needle) ? 2 : -1;
        return { item, score };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score || a.item.order - b.item.order)
      .slice(0, 30)
      .map((entry) => entry.item);
  }
  function renderQuickOpen() {
    const items = quickOpenItems(nodes.quickOpenInput.value);
    state.quickOpenItems = items;
    state.quickOpenIndex = Math.min(Math.max(state.quickOpenIndex || 0, 0), Math.max(0, items.length - 1));
    nodes.quickOpenList.replaceChildren();
    if (!items.length) { nodes.quickOpenList.appendChild(emptyBlock('没有匹配的文档。快速打开只搜打开着的和最近打开过的。', 'quick-open-empty')); return; }
    items.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button'; row.className = `quick-open-item${index === state.quickOpenIndex ? ' active' : ''}`;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === state.quickOpenIndex));
      const name = document.createElement('strong'); name.textContent = item.file;
      const meta = document.createElement('span'); meta.textContent = `${formatDirectory(item.directory)} · ${item.note}`;
      row.append(name, meta);
      row.addEventListener('click', () => { state.quickOpenIndex = index; void chooseQuickOpen(); });
      nodes.quickOpenList.appendChild(row);
    });
    const active = nodes.quickOpenList.querySelector('.quick-open-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  function openQuickOpen() {
    closePanels();
    nodes.quickOpen.hidden = false;
    nodes.quickOpenInput.value = '';
    state.quickOpenIndex = 0;
    renderQuickOpen();
    setTimeout(() => nodes.quickOpenInput.focus(), 20);
    void refreshRecents().then(() => { if (!nodes.quickOpen.hidden) renderQuickOpen(); });
  }
  async function chooseQuickOpen() {
    const item = (state.quickOpenItems || [])[state.quickOpenIndex || 0];
    if (!item) return;
    closePanels();
    if (item.tabId) activateTab(item.tabId);
    else await openDocumentPath(item.path);
  }

  // ---------- 设置(⌘,):外观、正文字号、iCloud 同步、命令行工具、关于 ----------
  async function openSettings() {
    closePanels();
    nodes.settingsDialog.hidden = false;
    renderZoomSetting();
    let settings = null;
    if (bridge && typeof bridge.getSettings === 'function') { try { settings = await bridge.getSettings(); } catch (_) {} }
    state.settings = settings;
    const appearance = settings ? settings.appearance : 'system';
    nodes.appearanceSegment.querySelectorAll('button').forEach((button) => {
      const on = button.dataset.appearance === appearance;
      button.classList.toggle('active', on); button.setAttribute('aria-checked', String(on));
      button.disabled = !settings;
    });
    nodes.syncToggle.checked = settings ? settings.syncEnabled : true;
    nodes.syncToggle.disabled = !settings || !settings.syncHelperAvailable;
    void renderSyncStatusLine();
    renderCliStatus(settings && settings.cli);
    nodes.aboutLine.textContent = settings ? `回稿 ${settings.version}${settings.packaged ? '' : '(开发版)'}` : '回稿(浏览器预览,部分设置不可用)';
    setTimeout(() => nodes.settingsClose.focus(), 20);
  }
  function renderZoomSetting() {
    const percent = Math.round(state.readerZoom * 100);
    nodes.zoomRange.value = String(percent);
    nodes.zoomValue.textContent = `${percent}%`;
  }
  async function renderSyncStatusLine() {
    const settings = state.settings;
    if (settings && !settings.syncHelperAvailable) { nodes.syncStatusLine.textContent = '这个安装包没有带同步程序,手机收不到稿子。'; return; }
    if (settings && !settings.syncEnabled) { nodes.syncStatusLine.textContent = '同步已关闭:新的稿子不会推到手机,手机上的批注也收不到。'; return; }
    try {
      const status = await requestJson('/api/app/sync/status');
      nodes.syncStatusLine.textContent = describeSyncHelper(status.helper);
    } catch (_) { nodes.syncStatusLine.textContent = '读不到同步状态。'; }
  }
  function describeSyncHelper(helper) {
    if (!helper) return '同步程序还没有运行过。';
    const last = Date.parse(helper.lastPollAt || '');
    const stale = !Number.isFinite(last) || Date.now() - last > 3 * 60 * 1000;
    if (helper.accountStatus && helper.accountStatus !== 'available') return '没有登录 iCloud:手机收不到稿子。请在系统设置里登录 iCloud。';
    if (helper.error) return `同步出错:${helper.error}`;
    if (stale) return `同步程序没有在运行(最后一次 ${Number.isFinite(last) ? formatRelativeTime(helper.lastPollAt) : '未知'})。`;
    return `iCloud 已登录 · 最近同步 ${formatRelativeTime(helper.lastPollAt)}`;
  }
  function renderCliStatus(cli) {
    if (!cli) { nodes.cliStatusLine.textContent = '只有在回稿 App 里才能安装。'; nodes.cliInstallButton.disabled = true; return; }
    nodes.cliInstallButton.disabled = false;
    if (!cli.installed) { nodes.cliStatusLine.textContent = '还没有安装。'; nodes.cliInstallButton.textContent = '安装 mdreview 到 /usr/local/bin'; return; }
    if (cli.pointsTo === 'this-app') { nodes.cliStatusLine.textContent = `已安装 · ${cli.path}`; nodes.cliInstallButton.textContent = '重新安装'; return; }
    nodes.cliStatusLine.textContent = `已安装,但指向别处:${cli.target || cli.path}`;
    nodes.cliInstallButton.textContent = '改为指向这个回稿';
  }
  async function installCliFromSettings() {
    if (!bridge || typeof bridge.installCli !== 'function') return;
    const cli = state.settings && state.settings.cli;
    if (cli && cli.installed && cli.pointsTo !== 'this-app') {
      const ok = await confirmAction('替换现有的 mdreview?', `现在的 mdreview 指向:${cli.target || cli.path}。替换后,AI 用的命令改为这个回稿自带的版本。`, '替换');
      if (!ok) return;
    }
    nodes.cliInstallButton.disabled = true;
    try {
      const result = await bridge.installCli();
      if (result && result.ok) { toast('mdreview 已装好。AI 现在可以用它接手你的批注。'); renderCliStatus(result); if (state.settings) state.settings.cli = result; }
      else toast(`没有装上:${(result && result.message) || '原因未知'}`, 'error');
    } catch (error) { toast(`没有装上:${error.message || error}`, 'error'); }
    finally { nodes.cliInstallButton.disabled = false; }
  }
  async function showSyncDetails() {
    closePanels();
    openInfo('轮次与同步');
    try {
      const status = await requestJson('/api/app/sync/status');
      const body = nodes.infoBody;
      body.replaceChildren();
      const head = document.createElement('p'); head.className = 'settings-note'; head.textContent = describeSyncHelper(status.helper);
      body.appendChild(head);
      const reviews = Array.isArray(status.reviews) ? status.reviews : [];
      if (!reviews.length) { body.appendChild(emptyBlock('还没有推到手机的稿子。开始审阅的稿子会自动推过去。')); return; }
      const table = document.createElement('table'); table.className = 'info-table';
      const header = document.createElement('tr');
      ['稿件', '轮次', '状态', '手机'].forEach((text) => { const th = document.createElement('th'); th.textContent = text; header.appendChild(th); });
      table.appendChild(header);
      reviews.slice(0, 60).forEach((item) => {
        const row = document.createElement('tr');
        const cells = [item.title || String(item.absPath || '').split('/').pop(), Number.isInteger(item.round) ? `第 ${item.round} 轮` : '—',
          statusLabel(item.status, item.applyMode, item.outcome), describePush(item.sync)];
        cells.forEach((text) => { const td = document.createElement('td'); td.textContent = text; row.appendChild(td); });
        table.appendChild(row);
      });
      body.appendChild(table);
    } catch (error) { nodes.infoBody.replaceChildren(emptyBlock(friendlyError(error, '读取同步状态'))); }
  }
  function describePush(sync) {
    if (!sync) return '没有推送';
    if (sync.error) return `推送出错:${sync.error}`;
    if (sync.state === 'batch-received') return `已收到手机批注 · ${formatRelativeTime(sync.batchReceivedAt || sync.pushedAt)}`;
    if (sync.state === 'receipt-sent') return `已回执给手机 · ${formatRelativeTime(sync.receiptSentAt || sync.pushedAt)}`;
    if (sync.pushedAt && (!sync.pushRequestedAt || sync.pushedAt >= sync.pushRequestedAt)) return `已推到手机 · ${formatRelativeTime(sync.pushedAt)}`;
    if (sync.pushRequestedAt) return '等待推到手机';
    return '没有推送';
  }
  function showShortcuts() {
    closePanels();
    openInfo('键盘快捷键一览');
    const body = nodes.infoBody;
    body.replaceChildren();
    if (!Actions) { body.appendChild(emptyBlock('快捷键表没有加载。')); return; }
    for (const group of Actions.shortcutList(PLATFORM)) {
      const heading = document.createElement('h3'); heading.className = 'info-heading'; heading.textContent = group.menu;
      const table = document.createElement('table'); table.className = 'info-table shortcuts';
      group.rows.forEach((row) => {
        const tr = document.createElement('tr');
        const name = document.createElement('td'); name.textContent = row.label;
        const keys = document.createElement('td'); const kbd = document.createElement('kbd'); kbd.textContent = row.keys; keys.appendChild(kbd);
        tr.append(name, keys); table.appendChild(tr);
      });
      body.append(heading, table);
    }
  }
  function openInfo(title) {
    nodes.infoTitle.textContent = title;
    nodes.infoBody.replaceChildren(emptyBlock('正在读取…'));
    nodes.infoDialog.hidden = false;
    setTimeout(() => nodes.infoClose.focus(), 20);
  }
  function closePanels() {
    const wasOpen = !nodes.quickOpen.hidden || !nodes.settingsDialog.hidden || !nodes.infoDialog.hidden;
    nodes.quickOpen.hidden = true; nodes.settingsDialog.hidden = true; nodes.infoDialog.hidden = true;
    if (wasOpen) publishMenuState();
  }

  // ---------- 菜单栏状态:页面把当前能做什么报给主进程,菜单逐项启用 / 勾选 ----------
  function menuState() {
    const tab = activeTab();
    const versions = tab && tab.versions ? tab.versions : [];
    const reviewTab = tab && !isPlain(tab);
    const card = reviewTab ? History.returnCard({ review: tab.review, versions, annotations: tab.annotations }) : { show: false };
    const rounds = tab && (reviewTab || tab.review.docId) ? History.buildRounds({ review: tab.review, versions, annotations: reviewTab ? tab.annotations : [] }).rounds : [];
    return {
      hasDoc: Boolean(tab), mode: tab ? tab.mode : null, plain: Boolean(tab && isPlain(tab)), dirty: Boolean(tab && tab.dirty),
      canEdit: Boolean(tab) && !nodes.editingMode.disabled,
      canAnnotate: statusCanAnnotate(tab) && !Compare.isOpen(),
      canDocNote: Boolean(tab && tab.mode === 'read' && ANNOTATABLE.has(tab.review.status) && !isReadOnly(tab)),
      openNotes: tab ? openAnnotations(tab).length : 0,
      primary: nodes.primaryAction.hidden ? null : nodes.primaryAction.dataset.action || null,
      secondary: nodes.secondaryAction.hidden ? null : nodes.secondaryAction.dataset.action || null,
      returnCard: Boolean(card.show),
      canCompare: Boolean((card.show && card.canCompare) || rounds.some((round) => round.canCompare)),
      compareOpen: Compare.isOpen(),
      canRestore: Boolean(tab && tab.mode === 'read' && !tab.dirty && !ACTIVE_REVIEW.has(tab.review.status) && rounds.some((round) => round.canRestore)),
      hasRounds: Boolean(tab && (reviewTab || tab.review.docId)),
      tabs: state.tabs.length, leftMode: state.leftMode, leftCollapsed: state.leftCollapsed, rightCollapsed: state.rightCollapsed,
    };
  }
  function publishMenuState() {
    if (!bridge || typeof bridge.setMenuState !== 'function') return;
    if (state.menuStateFrame) cancelAnimationFrame(state.menuStateFrame);
    state.menuStateFrame = requestAnimationFrame(() => {
      state.menuStateFrame = 0;
      try { bridge.setMenuState(menuState()); } catch (_) {}
    });
  }

  // ---------- 另存为副本(⇧⌘S):新文件、新文档身份,不带原稿的批注与历史 ----------
  async function pickCopyPath(tab, title, suggestion) {
    const directory = posixDir(tab.review.sourceFile || '');
    if (bridge && typeof bridge.saveCopyDialog === 'function') {
      const picked = await bridge.saveCopyDialog({ title, suggestedName: suggestion, directory });
      return picked && picked.ok ? picked.filePath : '';
    }
    const typed = window.prompt('另存为(请输入 .md 文件的绝对路径):', `${directory}/${suggestion}.md`);
    return typed ? typed.trim() : '';
  }
  function copyStem(tab) { return String(tab.review.file || tab.review.title || '文档').replace(/\.(md|markdown)$/i, ''); }
  async function saveCopy(tab = activeTab()) {
    if (!tab) return;
    if (tab.mode === 'edit') captureEditorValue(tab);
    let content = tab.source;
    if (tab.mode === 'edit' && tab.dirty && tab.editorDraft != null) {
      const writeback = patchForSave(tab, tab.editorDraft);
      if (writeback.needsConfirm && !(await confirmWriteback(writeback))) return;
      content = writeback.text;
    }
    let filePath = '';
    try { filePath = await pickCopyPath(tab, '另存为副本', `${copyStem(tab)} 副本`); }
    catch (error) { toast(`另存失败:${error.message || error}`, 'error'); return; }
    if (!filePath) return;
    try {
      const payload = await requestJson('/api/app/document/copy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content, sourcePath: tab.review.sourceFile }),
      });
      upsertTab(normalizeDocument(payload), { activate: true });
      await refreshRecents();
      toast(`已另存为《${payload.document.file}》。原稿${isPlain(tab) ? '' : '和批注'}都没有动。`);
    } catch (error) { toast(friendlyError(error, '另存为副本'), 'error'); }
  }

  // ---------- 冲突处理(状态区「文件在外面被改了」时主按钮「处理…」):只给两条路 ----------
  async function resolveConflict(tab = activeTab()) {
    if (!tab || tab.review.status !== 'conflict') return;
    const count = openAnnotations(tab).length;
    const choice = await chooseAction('文件在外面被改了',
      `审阅期间有别的程序改了这个文件。\n\n「以磁盘上的版本重新开始」:这一轮${count ? `的 ${count} 条批注` : ''}作废(留在历史里),之后划词按磁盘上的正文开新一轮。\n\n「另存我的版本」:把这一轮锁定时的原稿存成新文件${count ? `,${count} 条批注一起带过去` : ''};磁盘上的文件不动,这一轮在原文件上作废。`,
      { accept: '以磁盘上的版本重新开始', alt: '另存我的版本…' });
    if (choice === 'accept') {
      try {
        await requestJson(`/api/app/review/restart-from-disk?r=${encodeURIComponent(tab.id)}`, { method: 'POST' });
        await refreshTab(tab, { silent: true, forceSource: true });
        toast('已按磁盘上的版本重新开始。划词批注就开始新一轮。');
      } catch (error) { toast(friendlyError(error, '处理冲突'), 'error'); }
    } else if (choice === 'alt') {
      let filePath = '';
      try { filePath = await pickCopyPath(tab, '另存我的版本', `${copyStem(tab)} 我的版本`); }
      catch (error) { toast(`另存失败:${error.message || error}`, 'error'); return; }
      if (!filePath) return;
      try {
        const result = await requestJson(`/api/app/review/fork?r=${encodeURIComponent(tab.id)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
        });
        await refreshTab(tab, { silent: true, forceSource: true });
        await openReviewId(result.reviewId);
        toast(`已另存为《${result.absPath.split('/').pop()}》${result.carried ? `,带过去 ${result.carried} 条批注` : ''}。原文件这一轮已作废。`);
      } catch (error) { toast(friendlyError(error, '另存我的版本'), 'error'); }
    }
  }

  // ---------- 帮助、导入、访达 ----------
  async function openHelp(name) {
    try {
      const result = await requestJson('/api/app/help/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      await openDocumentPath(result.path);
    } catch (error) { toast(friendlyError(error, '打开说明'), 'error'); }
  }
  function openFeedback() {
    if (bridge && typeof bridge.openExternal === 'function') void bridge.openExternal(FEEDBACK_URL);
    else window.open(FEEDBACK_URL, '_blank', 'noopener');
  }
  async function importBatchFromMenu() {
    if (bridge && typeof bridge.pickBatchFile === 'function') {
      try {
        const picked = await bridge.pickBatchFile();
        if (!picked || !picked.ok) return;
        await importBatchFile({ name: picked.name, text: async () => picked.text });
      } catch (error) { toast(`导入失败:${error.message || error}`, 'error'); }
      return;
    }
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', () => { if (input.files && input.files[0]) void importBatchFile(input.files[0]); });
    input.click();
  }
  function revealActive() {
    const tab = activeTab();
    if (!tab) return;
    if (bridge && typeof bridge.revealPath === 'function') void bridge.revealPath(tab.review.sourceFile).catch((error) => toast(`没能在访达中显示:${error.message || error}`, 'error'));
    else toast(tab.review.sourceFile);
  }
  function stepTab(direction) {
    if (state.tabs.length < 2) return;
    const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
    const next = state.tabs[(index + direction + state.tabs.length) % state.tabs.length];
    if (next) activateTab(next.id);
  }
  async function toggleMode() {
    const tab = activeTab();
    if (!tab) return;
    if (tab.mode === 'edit') await enterReadMode();
    else if (!nodes.editingMode.disabled) await enterEditMode();
    else toast('现在这一轮不能编辑。');
  }
  function runFormat(name) {
    const tab = activeTab();
    if (!tab || tab.mode !== 'edit' || !editorFindReady() || typeof window.DraftbackEditor.runFormat !== 'function') return;
    window.DraftbackEditor.runFormat(state.editorView, name);
  }

  async function runAction(action) {
    const tab = activeTab(); if (!tab || !action) return;
    if (action === 'resolve-conflict') return resolveConflict(tab);
    if (action === 'busy') return undefined;
    if (action === 'submit') return submitReview(tab, { skipConfirm: true });
    if (action === 'approve') return approveAndFinalize(tab);
    if (action === 'finalize') return finalizeReviewTab(tab);
    if (action === 'copy-instruction') return copyInstruction(tab);
    if (action === 'manual-edit') return enterEditMode();
    if (action === 'finish-manual') return finishManualApply();
  }

  function handlePrimaryAction() {
    if (nodes.primaryAction.hidden || nodes.primaryAction.disabled) return;
    void runAction(nodes.primaryAction.dataset.action);
  }
  function handleSecondaryAction() {
    if (nodes.secondaryAction.hidden || nodes.secondaryAction.disabled) return;
    void runAction(nodes.secondaryAction.dataset.action);
  }

  // 确认框:主按钮、可选的第二个选择、取消。返回 'accept' | 'alt' | null(取消或 Esc)
  function chooseAction(title, message, { accept = '确认', alt = null, cancel = '取消' } = {}) {
    if (state.confirmFinish) state.confirmFinish(null);
    nodes.confirmTitle.textContent = title; nodes.confirmMessage.textContent = message;
    nodes.confirmAccept.textContent = accept; nodes.confirmCancel.textContent = cancel;
    nodes.confirmAlt.hidden = !alt; nodes.confirmAlt.textContent = alt || '';
    nodes.confirmDialog.hidden = false;
    return new Promise((resolve) => {
      const finish = (value) => {
        nodes.confirmDialog.hidden = true;
        nodes.confirmAccept.removeEventListener('click', onAccept); nodes.confirmCancel.removeEventListener('click', onCancel);
        nodes.confirmAlt.removeEventListener('click', onAlt);
        state.confirmFinish = null;
        publishMenuState();
        resolve(value);
      };
      const onAccept = () => finish('accept'), onCancel = () => finish(null), onAlt = () => finish('alt');
      nodes.confirmAccept.addEventListener('click', onAccept); nodes.confirmCancel.addEventListener('click', onCancel);
      nodes.confirmAlt.addEventListener('click', onAlt);
      state.confirmFinish = finish;
      setTimeout(() => nodes.confirmAccept.focus(), 20);
    });
  }
  async function confirmAction(title, message, acceptText = '确认') {
    return (await chooseAction(title, message, { accept: acceptText })) === 'accept';
  }
  // 有对话框或面板挡在前面时,菜单命令与快捷键不动它背后的东西
  function modalOpen() {
    return !nodes.annotationDialog.hidden || !nodes.confirmDialog.hidden || !nodes.quickOpen.hidden || !nodes.settingsDialog.hidden || !nodes.infoDialog.hidden;
  }

  function installEvents() {
    nodes.openTabButton.addEventListener('click', chooseMarkdown);
    nodes.openFileButton.addEventListener('click', chooseMarkdown);
    nodes.welcomeOpen.addEventListener('click', chooseMarkdown);
    nodes.welcomeNew.addEventListener('click', () => { void newDocument(); });
    nodes.newFileButton.addEventListener('click', () => { void newDocument(); });
    installExportMenu();
    nodes.outlineMode.addEventListener('click', () => setLeftMode('outline'));
    nodes.filesMode.addEventListener('click', () => setLeftMode('files'));
    nodes.collapseLeft.addEventListener('click', () => toggleLeft(true));
    nodes.toggleLeftTop.addEventListener('click', () => toggleLeft(false));
    nodes.toggleRightTop.addEventListener('click', () => toggleRight());
    nodes.notesCurrentTab.addEventListener('click', () => showNotesPane('current'));
    nodes.notesHistoryTab.addEventListener('click', () => showNotesPane('history'));
    nodes.docTitleButton.addEventListener('click', (event) => { event.stopPropagation(); toggleDocInfo(); });
    nodes.compareToggleButton.addEventListener('click', () => toggleCompare());
    nodes.syncFooter.addEventListener('click', () => { void openSettings(); });
    document.addEventListener('click', (event) => { if (!nodes.docInfoPopover.hidden && !event.target.closest('#docInfoPopover, #docTitleButton')) toggleDocInfo(false); });
    nodes.readingMode.addEventListener('click', () => { void enterReadMode(); });
    nodes.editingMode.addEventListener('click', enterEditMode);
    nodes.primaryAction.addEventListener('click', handlePrimaryAction);
    nodes.secondaryAction.addEventListener('click', handleSecondaryAction);
    nodes.findButton.addEventListener('click', () => openFind());
    nodes.reviewState.addEventListener('click', (event) => { event.stopPropagation(); toggleTimeline(); });
    document.addEventListener('click', (event) => { if (!nodes.timelinePopover.hidden && !event.target.closest('#timelinePopover, #reviewStatePill')) toggleTimeline(false); });
    nodes.finishManual.addEventListener('click', finishManualApply);
    nodes.saveButton.addEventListener('click', () => saveSource());
    nodes.annotationSave.addEventListener('click', saveAnnotation);
    nodes.docNoteButton.addEventListener('click', () => openAnnotationDialog({ scope: 'document' }));
    nodes.annotationCancel.addEventListener('click', () => closeAnnotationDialog());
    nodes.annotationClose.addEventListener('click', () => closeAnnotationDialog());
    nodes.annotationDialog.addEventListener('pointerdown', (event) => { if (event.target === nodes.annotationDialog) dismissAnnotationDialog(); });
    nodes.annotationDialogHandle.addEventListener('pointerdown', beginAnnotationDialogDrag);
    nodes.annotationDialogHandle.addEventListener('pointermove', moveAnnotationDialog);
    nodes.annotationDialogHandle.addEventListener('pointerup', endAnnotationDialogDrag);
    nodes.annotationDialogHandle.addEventListener('pointercancel', endAnnotationDialogDrag);
    nodes.annotationDialogHandle.addEventListener('dblclick', (event) => {
      if (!event.target.closest('.dialog-close')) resetAnnotationDialogPosition();
    });
    document.addEventListener('selectionchange', handleSelectionChange);
    nodes.annotate.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const anchor = captureSelectionAnchor() || state.cachedAnchor;
      if (anchor) openAnnotationDialog({ anchor });
      else { nodes.annotate.hidden = true; toast('没有识别到有效文字选区，请重新选择。', 'error'); }
    });
    nodes.annotate.addEventListener('click', (event) => { if (!nodes.annotationDialog.hidden) return; event.preventDefault(); const anchor = state.cachedAnchor; if (anchor) openAnnotationDialog({ anchor }); });
    nodes.readerScroll.addEventListener('scroll', () => {
      nodes.annotate.hidden = true;
      const tab = activeTab();
      if (tab) tab.scrollTop = nodes.readerScroll.scrollTop;
      scheduleOutlineUpdate();
      scheduleMarkerPositions();
    }, { passive: true });
    nodes.readerPane.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setReaderZoom(state.readerZoom * Math.exp(-event.deltaY * 0.01));
    }, { passive: false });
    // 编辑模式同样支持触摸板双指缩放,与阅读模式共用同一缩放值
    nodes.editorPane.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setReaderZoom(state.readerZoom * Math.exp(-event.deltaY * 0.01));
    }, { passive: false });
    window.addEventListener('focus', () => { void reconcileOpenReviews(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void reconcileOpenReviews();
    });
    window.addEventListener('pageshow', () => { void reconcileOpenReviews(); });
    window.addEventListener('resize', () => {
      applyNarrowLayout();
      keepAnnotationDialogInView();
      scheduleMarkerPositions();
    });
    if (typeof ResizeObserver === 'function') {
      state.layoutObserver = new ResizeObserver(() => scheduleMarkerPositions());
      state.layoutObserver.observe(nodes.readerPane);
      state.layoutObserver.observe(nodes.content);
    }
    if (document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(() => scheduleMarkerPositions()).catch(() => {});
    }
    // 快捷键按动作表匹配(菜单栏显示同一张表);菜单项点击与快捷键走同一个命令。
    // 页面先拿到按键:这里处理了(preventDefault)菜单就不会再触发一次。
    document.addEventListener('keydown', (event) => {
      if (!Actions || modalOpen()) return;
      const tab = activeTab();
      if (!tab || tab.mode !== 'edit' || !event.target || !event.target.closest || !event.target.closest('#codeEditor')) return;
      const item = Actions.actionForEvent(event, PLATFORM, ACTION_ITEMS);
      if (!item || item.keys !== 'capture-edit') return;
      // 编辑模式下的格式键(⇧⌘X、⌥⌘Q、⌥⌘U、⌥⌘O、⌥⌘X、⌥⌘T、⌥⌘-、⌃`)先于编辑器默认键位
      event.preventDefault(); event.stopPropagation();
      handleDesktopCommand(item.command);
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (event.isComposing || event.keyCode === 229) return; // 输入法在取消候选词,不是要关东西
        if (!nodes.annotationDialog.hidden) dismissAnnotationDialog();
        else if (!nodes.confirmDialog.hidden) { if (state.confirmFinish) state.confirmFinish(null); }
        else if (!nodes.quickOpen.hidden || !nodes.settingsDialog.hidden || !nodes.infoDialog.hidden) closePanels();
        else if (!nodes.timelinePopover.hidden) toggleTimeline(false);
        else if (Compare.isOpen()) Compare.close();
        else if (!nodes.findBar.hidden) closeFind();
        else if (activeTab() && activeTab().mode === 'edit') { /* 交给编辑器:这里清空选区会让光标消失 */ }
        else { nodes.annotate.hidden = true; window.getSelection()?.removeAllRanges(); }
        return;
      }
      if (!Actions) return;
      const item = Actions.actionForEvent(event, PLATFORM, ACTION_ITEMS);
      if (!item || (item.keys && item.keys !== 'app')) return;
      if (event.defaultPrevented) return; // 编辑器或输入框已经处理(比如代码块里的 ⌘↩)
      if (modalOpen()) {
        // 对话框里的按键交给对话框;⌘O、⌘W 给一句提示,别让菜单在背后打开或关掉东西
        if (item.command === 'open' || item.command === 'close-tab') { event.preventDefault(); commandBlocked(); }
        else if (MODAL_SAFE_COMMANDS.has(item.command)) { event.preventDefault(); handleDesktopCommand(item.command); }
        else event.preventDefault();
        return;
      }
      const guard = KEY_GUARDS[item.command];
      if (guard && !guard()) return; // 不该响应时让按键照常(比如对比视图没开时的 ⌥⌘←)
      event.preventDefault();
      handleDesktopCommand(item.command);
    });
    nodes.quickOpenInput.addEventListener('input', () => { state.quickOpenIndex = 0; renderQuickOpen(); });
    nodes.quickOpenInput.addEventListener('keydown', (event) => {
      const count = (state.quickOpenItems || []).length;
      if (event.key === 'ArrowDown') { event.preventDefault(); if (count) { state.quickOpenIndex = (state.quickOpenIndex + 1) % count; renderQuickOpen(); } }
      else if (event.key === 'ArrowUp') { event.preventDefault(); if (count) { state.quickOpenIndex = (state.quickOpenIndex - 1 + count) % count; renderQuickOpen(); } }
      else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void chooseQuickOpen(); }
    });
    [nodes.quickOpen, nodes.settingsDialog, nodes.infoDialog].forEach((backdrop) => {
      backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) closePanels(); });
    });
    nodes.settingsClose.addEventListener('click', closePanels);
    nodes.infoClose.addEventListener('click', closePanels);
    nodes.appearanceSegment.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-appearance]');
      if (!button || !bridge || typeof bridge.setAppearance !== 'function') return;
      try { await bridge.setAppearance(button.dataset.appearance); } catch (_) {}
      nodes.appearanceSegment.querySelectorAll('button').forEach((node) => {
        const on = node === button; node.classList.toggle('active', on); node.setAttribute('aria-checked', String(on));
      });
      if (state.settings) state.settings.appearance = button.dataset.appearance;
    });
    nodes.zoomRange.addEventListener('input', () => { setReaderZoom(Number(nodes.zoomRange.value) / 100); nodes.zoomValue.textContent = `${nodes.zoomRange.value}%`; });
    nodes.zoomResetButton.addEventListener('click', () => { setReaderZoom(1); renderZoomSetting(); });
    nodes.syncToggle.addEventListener('change', async () => {
      if (!bridge || typeof bridge.setSyncEnabled !== 'function') return;
      try { await bridge.setSyncEnabled(nodes.syncToggle.checked); if (state.settings) state.settings.syncEnabled = nodes.syncToggle.checked; }
      catch (error) { toast(`没能更改同步设置:${error.message || error}`, 'error'); }
      void renderSyncStatusLine();
    });
    nodes.syncDetailsButton.addEventListener('click', () => { void showSyncDetails(); });
    nodes.cliInstallButton.addEventListener('click', () => { void installCliFromSettings(); });
    nodes.aboutGuideButton.addEventListener('click', () => { closePanels(); void openHelp('guide'); });
    nodes.aboutFeedbackButton.addEventListener('click', openFeedback);
    nodes.annotationText.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void saveAnnotation(); }
    });
    nodes.findInput.addEventListener('input', runFind);
    nodes.findInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); stepFind(event.shiftKey ? -1 : 1); }
      else if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
    });
    nodes.findNext.addEventListener('click', () => stepFind(1));
    nodes.findPrev.addEventListener('click', () => stepFind(-1));
    nodes.findClose.addEventListener('click', closeFind);
    nodes.replaceOne.addEventListener('click', replaceCurrentMatch);
    nodes.replaceAll.addEventListener('click', replaceAllMatches);
    nodes.replaceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); if (event.metaKey || event.ctrlKey) replaceAllMatches(); else replaceCurrentMatch(); }
      else if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
    });
    installDragAndDrop();
    window.addEventListener('beforeunload', (event) => {
      if (state.eventSource) state.eventSource.close();
      if (state.reconcileTimer) clearInterval(state.reconcileTimer);
      if (state.layoutObserver) state.layoutObserver.disconnect();
      state.remoteRetryTimers.forEach((timer) => clearTimeout(timer));
      state.remoteRetryTimers.clear();
      state.tabs.forEach((tab) => { if (tab.dirty) persistDraft(tab); });
      if (!state.tabs.some((tab) => tab.dirty)) return;
      event.preventDefault(); event.returnValue = '';
    });
    if (bridge && typeof bridge.onOpenFiles === 'function') bridge.onOpenFiles((paths) => void openPaths(paths));
    if (bridge && typeof bridge.onCommand === 'function') bridge.onCommand(handleDesktopCommand);
    if (bridge && typeof bridge.onActivateReview === 'function') {
      bridge.onActivateReview((reviewId) => {
        if (state.tabs.some((tab) => tab.id === reviewId)) activateTab(reviewId);
        else void openReviewId(reviewId);
      });
    }
  }

  // App 关闭或页面重载时尽力解除编辑登记(服务重启也会清空,这里只是让智能体更早拿到解锁)。
  window.addEventListener('pagehide', () => {
    for (const tab of state.tabs) {
      if (!tab.editingRegistered) continue;
      try {
        fetch('/api/app/document/editing', {
          method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: tab.review.sourceFile, editing: false, token: editingToken() }),
        }).catch(() => {});
      } catch (_) {}
    }
  });

  async function init() {
    installEvents();
    applyNarrowLayout();
    void renderSyncFooter();
    setInterval(() => { void renderSyncFooter(); }, 60_000);
    window.addEventListener('focus', () => { void renderSyncFooter(); });
    renderLayoutState();
    applyReaderZoom();
    await refreshRecents();
    await restoreTabs();
    renderApp();
    installReviewEvents();
    await reconcileOpenReviews();
  }

  void init();
})();
