/*
 * 动作表(UI 方案 v2 第 1.3 节「菜单栏」、第 3.8 节第 6 条「菜单与工具栏共用一张动作表」)。
 *
 * 一张表,三处用:
 *   - 主进程(desktop/main.js)按它搭菜单栏,并按页面报来的状态逐项启用 / 勾选;
 *   - 页面(desktop.js)按它匹配键盘快捷键,菜单点击与快捷键走同一个命令;
 *   - 「键盘快捷键一览」按它列出。
 *
 * 每一项:
 *   id           菜单项标识(主进程用它找菜单项改启用状态)
 *   label        菜单文字
 *   accelerator  Electron 写法的快捷键(CmdOrCtrl、Alt、Shift、Ctrl)
 *   command      交给页面的命令名;没有 command 的是系统 role 或主进程自己处理
 *   when         启用条件(见 isEnabled);缺省为总是可用
 *   checked      勾选条件(见 isChecked);有它的项是复选项
 *   keys         谁来响应键盘:'app'(缺省,页面在冒泡阶段处理)、'editor'(编辑器自带同一快捷键,页面不抢)、
 *                'capture-edit'(编辑模式下页面在捕获阶段先拦住,覆盖编辑器的默认键位)、'menu'(只由菜单响应)
 *   hidden       不进菜单,只做快捷键(例如 ⌘↩ 触发主按钮)
 *   devOnly      只在开发版出现
 *   mac          只在 macOS 出现
 *
 * 纯数据加几个纯函数:浏览器挂 window.DraftbackActions,Node / 主进程 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftbackActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SEP = Object.freeze({ type: 'separator' });

  const MENUS = [
    {
      id: 'app', label: '回稿', mac: true, items: [
        { role: 'about', label: '关于回稿' },
        SEP,
        { id: 'settings', label: '设置…', accelerator: 'CmdOrCtrl+,', command: 'settings' },
        SEP,
        { role: 'services', label: '服务' },
        SEP,
        { role: 'hide', label: '隐藏回稿' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        SEP,
        { role: 'quit', label: '退出回稿' },
      ],
    },
    {
      id: 'file', label: '文件', items: [
        { id: 'new', label: '新建 Markdown…', accelerator: 'CmdOrCtrl+N', command: 'new' },
        { id: 'open', label: '打开…', accelerator: 'CmdOrCtrl+O', command: 'open' },
        { id: 'open-recent', label: '打开最近', role: 'recentDocuments', mac: true, submenu: [{ role: 'clearRecentDocuments', label: '清除菜单' }] },
        { id: 'quick-open', label: '快速打开…', accelerator: 'Shift+CmdOrCtrl+O', command: 'quick-open' },
        SEP,
        { id: 'close-tab', label: '关闭标签页', accelerator: 'CmdOrCtrl+W', command: 'close-tab', when: 'hasDoc' },
        { id: 'save', label: '保存', accelerator: 'CmdOrCtrl+S', command: 'save', when: 'editing' },
        { id: 'save-copy', label: '另存为副本…', accelerator: 'Shift+CmdOrCtrl+S', command: 'save-copy', when: 'hasDoc' },
        { id: 'reveal', label: '在访达中显示', command: 'reveal', when: 'hasDoc' },
        SEP,
        {
          id: 'export', label: '导出', submenu: [
            { id: 'export-pdf', label: '为 PDF…', accelerator: 'Shift+CmdOrCtrl+E', command: 'export-pdf', when: 'hasDoc' },
            { id: 'export-html', label: '为 HTML…', command: 'export-html', when: 'hasDoc' },
            { id: 'export-docx', label: '为 Word…', command: 'export-docx', when: 'hasDoc' },
          ],
        },
        { id: 'print', label: '打印…', accelerator: 'CmdOrCtrl+P', command: 'print', when: 'hasDoc' },
      ],
    },
    {
      id: 'edit', label: '编辑', items: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        SEP,
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'selectAll', label: '全选' },
        SEP,
        { id: 'find', label: '查找…', accelerator: 'CmdOrCtrl+F', command: 'find', when: 'hasDoc' },
        { id: 'find-next', label: '查找下一个', accelerator: 'CmdOrCtrl+G', command: 'find-next', when: 'hasDoc' },
        { id: 'find-prev', label: '查找上一个', accelerator: 'Shift+CmdOrCtrl+G', command: 'find-prev', when: 'hasDoc' },
        { id: 'find-replace', label: '查找与替换…', accelerator: 'Alt+CmdOrCtrl+F', command: 'find-replace', when: 'editing' },
      ],
    },
    {
      // 格式:只在编辑模式可用(阅读时整组置灰)。⌥⌘0~6、⌘B、⌘I、⌥⌘C、⌘K 编辑器本来就有同样的键位,页面不抢
      id: 'format', label: '格式', items: [
        { id: 'format-paragraph', label: '正文', accelerator: 'Alt+CmdOrCtrl+0', command: 'format:paragraph', when: 'editing', keys: 'editor' },
        {
          id: 'format-heading', label: '标题', submenu: [1, 2, 3, 4, 5, 6].map((level) => (
            { id: `format-h${level}`, label: `标题 ${level}`, accelerator: `Alt+CmdOrCtrl+${level}`, command: `format:h${level}`, when: 'editing', keys: 'editor' }
          )),
        },
        SEP,
        { id: 'format-bold', label: '加粗', accelerator: 'CmdOrCtrl+B', command: 'format:bold', when: 'editing', keys: 'editor' },
        { id: 'format-italic', label: '斜体', accelerator: 'CmdOrCtrl+I', command: 'format:italic', when: 'editing', keys: 'editor' },
        { id: 'format-strike', label: '删除线', accelerator: 'Shift+CmdOrCtrl+X', command: 'format:strike', when: 'editing', keys: 'capture-edit' },
        { id: 'format-code', label: '行内代码', accelerator: 'Ctrl+`', command: 'format:code', when: 'editing', keys: 'capture-edit' },
        { id: 'format-link', label: '链接…', accelerator: 'CmdOrCtrl+K', command: 'format:link', when: 'editing', keys: 'editor' },
        SEP,
        { id: 'format-quote', label: '引用', accelerator: 'Alt+CmdOrCtrl+Q', command: 'format:quote', when: 'editing', keys: 'capture-edit' },
        { id: 'format-bullet', label: '无序列表', accelerator: 'Alt+CmdOrCtrl+U', command: 'format:bullet', when: 'editing', keys: 'capture-edit' },
        { id: 'format-ordered', label: '有序列表', accelerator: 'Alt+CmdOrCtrl+O', command: 'format:ordered', when: 'editing', keys: 'capture-edit' },
        { id: 'format-task', label: '任务列表', accelerator: 'Alt+CmdOrCtrl+X', command: 'format:task', when: 'editing', keys: 'capture-edit' },
        SEP,
        {
          id: 'format-insert', label: '插入', submenu: [
            { id: 'format-table', label: '表格', accelerator: 'Alt+CmdOrCtrl+T', command: 'format:table', when: 'editing', keys: 'capture-edit' },
            { id: 'format-codeblock', label: '代码块', accelerator: 'Alt+CmdOrCtrl+C', command: 'format:codeblock', when: 'editing', keys: 'editor' },
            { id: 'format-hr', label: '分割线', accelerator: 'Alt+CmdOrCtrl+-', command: 'format:hr', when: 'editing', keys: 'capture-edit' },
          ],
        },
      ],
    },
    {
      id: 'view', label: '显示', items: [
        { id: 'toggle-mode', label: '切换阅读与批注 / 编辑', accelerator: 'CmdOrCtrl+/', command: 'toggle-mode', when: 'canToggleMode' },
        SEP,
        { id: 'toggle-left', label: '显示稿件栏', accelerator: 'Ctrl+CmdOrCtrl+S', command: 'toggle-left', checked: 'leftShown' },
        { id: 'left-files', label: '稿件', accelerator: 'Ctrl+CmdOrCtrl+1', command: 'left-files', checked: 'leftFiles' },
        { id: 'left-outline', label: '大纲', accelerator: 'Ctrl+CmdOrCtrl+2', command: 'left-outline', checked: 'leftOutline' },
        { id: 'toggle-right', label: '显示批注栏', accelerator: 'Alt+CmdOrCtrl+I', command: 'toggle-right', checked: 'rightShown' },
        SEP,
        {
          id: 'appearance', label: '外观', submenu: [
            { id: 'appearance-system', label: '跟随系统', command: 'appearance:system', keys: 'menu', radio: true },
            { id: 'appearance-light', label: '浅色', command: 'appearance:light', keys: 'menu', radio: true },
            { id: 'appearance-dark', label: '深色', command: 'appearance:dark', keys: 'menu', radio: true },
          ],
        },
        SEP,
        { id: 'zoom-reset', label: '实际大小', accelerator: 'CmdOrCtrl+0', command: 'zoom-reset' },
        { id: 'zoom-in', label: '放大', accelerator: 'CmdOrCtrl+=', command: 'zoom-in' },
        { id: 'zoom-out', label: '缩小', accelerator: 'CmdOrCtrl+-', command: 'zoom-out' },
        SEP,
        { role: 'togglefullscreen', label: '进入全屏' },
        { role: 'reload', label: '重新载入(开发版)', devOnly: true },
        { role: 'toggleDevTools', label: '开发者工具(开发版)', accelerator: 'F12', devOnly: true },
      ],
    },
    {
      // 回稿独有的「稿件」菜单:按一轮的先后排
      id: 'draft', label: '稿件', items: [
        { id: 'annotate', label: '批注所选文字', accelerator: 'Alt+CmdOrCtrl+M', command: 'annotate', when: 'canAnnotate' },
        { id: 'doc-note', label: '写总体意见', accelerator: 'Shift+Alt+CmdOrCtrl+M', command: 'doc-note', when: 'canDocNote' },
        { id: 'note-prev', label: '上一条批注', accelerator: 'Alt+CmdOrCtrl+Up', command: 'note-prev', when: 'hasOpenNotes' },
        { id: 'note-next', label: '下一条批注', accelerator: 'Alt+CmdOrCtrl+Down', command: 'note-next', when: 'hasOpenNotes' },
        SEP,
        { id: 'submit', label: '交给 AI', accelerator: 'CmdOrCtrl+Enter', command: 'primary', when: 'canSubmit' },
        { id: 'manual-edit', label: '我自己改', command: 'manual-edit', when: 'canManualEdit' },
        { id: 'finish-manual', label: '提交修改', command: 'finish-manual', when: 'canFinishManual' },
        SEP,
        { id: 'show-return-card', label: '显示回稿卡', command: 'show-return-card', when: 'hasReturnCard' },
        { id: 'compare-toggle', label: '对比视图', accelerator: 'Shift+CmdOrCtrl+D', command: 'compare-toggle', when: 'canCompare', checked: 'compareOpen' },
        { id: 'compare-prev', label: '上一处改动', accelerator: 'Alt+CmdOrCtrl+Left', command: 'compare-prev', when: 'compareOpen' },
        { id: 'compare-next', label: '下一处改动', accelerator: 'Alt+CmdOrCtrl+Right', command: 'compare-next', when: 'compareOpen' },
        { id: 'restore-round', label: '恢复到某一轮改稿前…', command: 'restore-round', when: 'canRestore' },
        SEP,
        { id: 'finalize', label: '通过 · 定稿', command: 'finalize', when: 'canFinalize' },
        SEP,
        { id: 'timeline', label: '轮次与同步…', command: 'timeline', when: 'hasRounds' },
        { id: 'import-batch', label: '导入批注文件…', command: 'import-batch' },
      ],
    },
    {
      id: 'window', label: '窗口', items: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放', mac: true },
        SEP,
        { id: 'tab-prev', label: '显示上一个标签', accelerator: 'Shift+CmdOrCtrl+[', command: 'tab-prev', when: 'multiTabs' },
        { id: 'tab-next', label: '显示下一个标签', accelerator: 'Shift+CmdOrCtrl+]', command: 'tab-next', when: 'multiTabs' },
        SEP,
        { role: 'front', label: '前置全部窗口', mac: true },
        SEP,
        { id: 'reconnect', label: '重新连接本地服务', command: 'reconnect', keys: 'menu' },
      ],
    },
    {
      id: 'help', label: '帮助', items: [
        { id: 'help-guide', label: '回稿使用说明', command: 'help-guide' },
        { id: 'help-shortcuts', label: '键盘快捷键一览', command: 'help-shortcuts' },
        { id: 'help-ai', label: '给 AI 的说明(mdreview 命令)', command: 'help-ai' },
        SEP,
        { id: 'help-feedback', label: '反馈问题…', command: 'help-feedback' },
      ],
    },
  ];

  // 不进菜单、只做快捷键的动作(目前没有:⌘↩ 由「稿件 › 交给 AI」那一项响应,命令 primary 按当时的主按钮执行)
  const HIDDEN = [];

  /** 启用条件:页面报来的状态 → 这一项能不能点 */
  const CONDITIONS = {
    hasDoc: (s) => Boolean(s.hasDoc),
    editing: (s) => Boolean(s.hasDoc && s.mode === 'edit'),
    canToggleMode: (s) => Boolean(s.hasDoc && (s.mode === 'edit' || s.canEdit)),
    canAnnotate: (s) => Boolean(s.canAnnotate),
    canDocNote: (s) => Boolean(s.canDocNote),
    hasOpenNotes: (s) => Boolean(s.hasDoc && s.mode === 'read' && s.openNotes > 0),
    // 菜单里这一项叫「交给 AI」,只在主按钮就是「交给 AI」时可点;键盘 ⌘↩ 则总是按当时的主按钮执行
    canSubmit: (s) => s.primary === 'submit',
    canManualEdit: (s) => s.primary === 'manual-edit' || s.secondary === 'manual-edit',
    canFinishManual: (s) => s.primary === 'finish-manual',
    hasReturnCard: (s) => Boolean(s.returnCard),
    canCompare: (s) => Boolean(s.canCompare || s.compareOpen),
    compareOpen: (s) => Boolean(s.compareOpen),
    canRestore: (s) => Boolean(s.canRestore),
    canFinalize: (s) => s.primary === 'approve' || s.primary === 'finalize',
    hasRounds: (s) => Boolean(s.hasRounds),
    multiTabs: (s) => Number(s.tabs) > 1,
    leftShown: (s) => !s.leftCollapsed,
    leftFiles: (s) => s.leftMode === 'files',
    leftOutline: (s) => s.leftMode !== 'files',
    rightShown: (s) => !s.rightCollapsed,
  };

  function isEnabled(item, state) {
    if (!item || !item.when) return true;
    const test = CONDITIONS[item.when];
    return test ? test(state || {}) : true;
  }
  function isChecked(item, state) {
    if (!item || !item.checked) return false;
    const test = CONDITIONS[item.checked];
    return test ? test(state || {}) : false;
  }

  /** 摊平成一维列表(含子菜单里的项),便于按 id 或快捷键查找 */
  function flatten(menus = MENUS) {
    const out = [];
    const walk = (items, menuId) => {
      for (const item of items) {
        if (!item || item.type === 'separator') continue;
        if (item.submenu && !item.role) walk(item.submenu, menuId);
        else out.push({ ...item, menu: menuId });
      }
    };
    for (const menu of menus) walk(menu.items, menu.id);
    return out.concat(HIDDEN);
  }

  // ---------- 快捷键:Electron 写法 → 键盘事件匹配 ----------
  const KEY_CODES = {
    Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Enter: 'Enter', Return: 'Enter', Escape: 'Escape',
    '/': 'Slash', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote', ',': 'Comma', '.': 'Period', '\\': 'Backslash',
  };
  function parseAccelerator(accelerator, platform = 'darwin') {
    if (!accelerator) return null;
    const parts = String(accelerator).split('+');
    // 最后一个 + 可能就是按键本身(比如 "CmdOrCtrl+=" 不会有这个问题,但 "Shift+CmdOrCtrl+=" 也不会);按 + 切完取最后一段
    const keyName = parts.pop();
    const mods = { meta: false, ctrl: false, alt: false, shift: false };
    for (const part of parts) {
      if (part === 'CmdOrCtrl' || part === 'CommandOrControl') { if (platform === 'darwin') mods.meta = true; else mods.ctrl = true; }
      else if (part === 'Cmd' || part === 'Command') mods.meta = true;
      else if (part === 'Ctrl' || part === 'Control') mods.ctrl = true;
      else if (part === 'Alt' || part === 'Option') mods.alt = true;
      else if (part === 'Shift') mods.shift = true;
    }
    let code = KEY_CODES[keyName];
    if (!code && /^[A-Z]$/i.test(keyName)) code = `Key${keyName.toUpperCase()}`;
    if (!code && /^[0-9]$/.test(keyName)) code = `Digit${keyName}`;
    if (!code && /^F[0-9]{1,2}$/.test(keyName)) code = keyName;
    if (!code) return null;
    return { ...mods, code };
  }
  function matchesEvent(parsed, event) {
    if (!parsed || !event) return false;
    return event.code === parsed.code && Boolean(event.metaKey) === parsed.meta && Boolean(event.ctrlKey) === parsed.ctrl
      && Boolean(event.altKey) === parsed.alt && Boolean(event.shiftKey) === parsed.shift;
  }
  /** 键盘事件 → 动作表里的一项(只看有 command 的项) */
  function actionForEvent(event, platform = 'darwin', items = flatten()) {
    for (const item of items) {
      if (!item.command || !item.accelerator) continue;
      if (matchesEvent(parseAccelerator(item.accelerator, platform), event)) return item;
    }
    return null;
  }

  /** 给人看的快捷键:⌥⌘M 这种写法 */
  function displayAccelerator(accelerator, platform = 'darwin') {
    if (!accelerator) return '';
    const parts = String(accelerator).split('+');
    const keyName = parts.pop();
    const symbols = { Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Return: '↩', Escape: 'Esc' };
    const order = [];
    const has = (name) => parts.includes(name);
    if (platform === 'darwin') {
      if (has('Ctrl') || has('Control')) order.push('⌃');
      if (has('Alt') || has('Option')) order.push('⌥');
      if (has('Shift')) order.push('⇧');
      if (has('CmdOrCtrl') || has('CommandOrControl') || has('Cmd') || has('Command')) order.push('⌘');
      return order.join('') + (symbols[keyName] || keyName.toUpperCase());
    }
    return parts.map((p) => (p === 'CmdOrCtrl' ? 'Ctrl' : p)).concat(symbols[keyName] || keyName).join('+');
  }

  /** 「键盘快捷键一览」:按菜单分组,只列有快捷键的项 */
  function shortcutList(platform = 'darwin') {
    const groups = [];
    for (const menu of MENUS) {
      const rows = [];
      const walk = (items) => {
        for (const item of items) {
          if (!item || item.type === 'separator' || item.devOnly) continue;
          if (item.submenu && !item.role) { walk(item.submenu); continue; }
          if (item.accelerator) rows.push({ label: item.label, keys: displayAccelerator(item.accelerator, platform) });
        }
      };
      walk(menu.items);
      if (rows.length) groups.push({ menu: menu.label, rows });
    }
    groups.push({ menu: '批注与对话框', rows: [
      { label: '保存批注', keys: '⌘↩' }, { label: '关闭对话框 / 查找条 / 对比视图', keys: 'Esc' },
      { label: '查找条里:下一个 / 上一个', keys: '↩ / ⇧↩' }, { label: '替换框里:替换 / 全部替换', keys: '↩ / ⌘↩' },
    ] });
    return groups;
  }

  return Object.freeze({ MENUS, CONDITIONS, isEnabled, isChecked, flatten, parseAccelerator, matchesEvent, actionForEvent, displayAccelerator, shortcutList });
});
