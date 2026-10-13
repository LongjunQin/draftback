'use strict';

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification: ElectronNotification,
  shell,
} = require('electron');
const { markdownPathsFromArguments, normalizeMarkdownPath } = require('./open-files');
const { ensureService, stopOwnedService } = require('./service');
const { exportDocx, findPandoc } = require('./export-docx');

// 用户设置(外观等),存在 userData/settings.json;读写失败都不影响启动。
const APPEARANCES = ['system', 'light', 'dark'];
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function readSettings() {
  try { const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); return data && typeof data === 'object' ? data : {}; }
  catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2)); } catch {}
  return next;
}
function applyAppearance(value) {
  const appearance = APPEARANCES.includes(value) ? value : 'system';
  // themeSource 会同时改变渲染进程的 prefers-color-scheme,页面样式随之切换,不必重载
  nativeTheme.themeSource = appearance;
  return appearance;
}

const OPEN_FILES_CHANNEL = 'mdturn:open-files';
const COMMAND_CHANNEL = 'mdturn:command';
const ACTIVATE_REVIEW_CHANNEL = 'mdturn:activate-review';

let mainWindow = null;
let serviceOrigin = null;
let rendererReady = false;
let pendingOpenFiles = [];
let connecting = null;
let activeService = null;
let pendingOwnedProcess = null; // 已 spawn、尚未通过健康检查的内置服务子进程

app.setName('MDTurn');
if (process.platform === 'win32') app.setAppUserModelId('org.mdturn.desktop');

function queueOpenFiles(paths) {
  const validPaths = paths
    .map((candidate) => normalizeMarkdownPath(candidate))
    .filter(Boolean);
  pendingOpenFiles = [...new Set([...pendingOpenFiles, ...validPaths])];
  // 窗口已被关掉(macOS 上 App 仍在 Dock)时,Finder 双击 / 菜单打开 / 第二实例都不会触发 activate,
  // 这里自己把窗口建回来;排队的文件在页面加载完后送出。
  if (pendingOpenFiles.length && (!mainWindow || mainWindow.isDestroyed()) && app.isReady()) createWindow();
  else focusMainWindow();
  flushOpenFiles();
}

function flushOpenFiles() {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady || pendingOpenFiles.length === 0) return;
  const paths = pendingOpenFiles.slice();
  pendingOpenFiles = [];
  mainWindow.webContents.send(OPEN_FILES_CHANNEL, paths);
}

function sendRendererCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) return false;
  mainWindow.webContents.send(COMMAND_CHANNEL, command);
  return true;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isSafeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isTrustedRenderer(event) {
  if (!serviceOrigin || !event.senderFrame) return false;
  try {
    return new URL(event.senderFrame.url).origin === serviceOrigin;
  } catch {
    return false;
  }
}

async function pickMarkdownFiles() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开 Markdown 文档',
    buttonLabel: '打开',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: ['md'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths
    .map((filePath) => normalizeMarkdownPath(filePath))
    .filter(Boolean);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function showServiceError(error) {
  rendererReady = false;
  serviceOrigin = null;
  const message = escapeHtml(error && error.message ? error.message : '本地审阅服务不可用。');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>MDTurn · 服务未就绪</title><style>
    :root{color-scheme:light dark}body{margin:0;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:#f5f5f7;color:#1d1d1f;display:grid;min-height:100vh;place-items:center}.card{width:min(560px,calc(100vw - 64px));
    padding:36px;border:1px solid #d2d2d7;border-radius:18px;background:#fff;box-shadow:0 18px 70px #0001}h1{font-size:24px;margin:0 0 12px}
    p{line-height:1.7;margin:8px 0;color:#515154}.detail{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
    padding:12px;border-radius:9px;background:#f5f5f7;overflow-wrap:anywhere}.hint{margin-top:18px;color:#6e6e73}
    @media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}.card{background:#2c2c2e;border-color:#48484a}.detail{background:#1c1c1e}p,.hint{color:#aeaeb2}}
    </style></head><body><main class="card"><h1>本地服务没有就绪</h1><p>MDTurn 无法连接本地审阅服务。</p>
    <p class="detail">${message}</p><p class="hint">请从“窗口”菜单选择“重新连接本地服务”重试。</p></main></body></html>`;
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function connectAndLoad() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const service = await ensureService({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        executablePath: process.execPath,
        onSpawn: (child) => { pendingOwnedProcess = child; },
      });
      if (!service.ownedProcess && activeService && activeService.ownedProcess && activeService.port === service.port) {
        service.ownedProcess = activeService.ownedProcess;
      }
      activeService = service;
      pendingOwnedProcess = null;
      serviceOrigin = `http://127.0.0.1:${service.port}`;
      rendererReady = false;
      // 等服务就绪可能要几秒,期间用户可能已把窗口关了
      if (!mainWindow || mainWindow.isDestroyed()) return;
      await mainWindow.loadURL(`${serviceOrigin}/desktop`);
    } catch (error) {
      if (mainWindow && !mainWindow.isDestroyed()) await showServiceError(error);
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

function installNavigationGuards(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (serviceOrigin && targetUrl.startsWith(`${serviceOrigin}/`)) return;
    event.preventDefault();
    if (isSafeExternalUrl(targetUrl)) void shell.openExternal(targetUrl);
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const windowOptions = {
    title: 'MDTurn',
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d22' : '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 16, y: 18 };
  }
  mainWindow = new BrowserWindow(windowOptions);
  installNavigationGuards(mainWindow);
  // 渲染层在有未保存修改时用 beforeunload 拦住关闭;Electron 默认不弹任何提示,只是静默不关(⌘Q/关窗/刷新都像没反应)。
  // 这里替用户问一句,选"放弃"才真正关闭(preventDefault = 忽略 beforeunload 继续卸载)。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['取消', '放弃修改并关闭'],
      defaultId: 0,
      cancelId: 0,
      message: '有尚未保存的 Markdown 修改',
      detail: '关闭后这些修改会丢失(下次启动可能从草稿恢复)。先回到 MDTurn 按 ⌘S 保存,或放弃修改。',
    });
    if (choice === 1) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.webContents.on('did-start-loading', () => { rendererReady = false; });
  mainWindow.webContents.on('did-finish-load', () => {
    if (!serviceOrigin) return;
    rendererReady = true;
    flushOpenFiles();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
    serviceOrigin = null;
  });
  void connectAndLoad();
  return mainWindow;
}

function installIpc() {
  ipcMain.handle('mdturn:pick-markdown', async (event) => {
    if (!isTrustedRenderer(event)) throw new Error('拒绝非 MDTurn 页面调用文件选择器。');
    return pickMarkdownFiles();
  });
  ipcMain.handle('mdturn:reveal-path', async (event, targetPath) => {
    if (!isTrustedRenderer(event) || typeof targetPath !== 'string' || targetPath.includes('\0') || !path.isAbsolute(targetPath)) {
      throw new Error('无效的本地路径。');
    }
    let realPath;
    try { realPath = fs.realpathSync(targetPath); } catch { throw new Error('路径不存在。'); }
    shell.showItemInFolder(realPath);
    return true;
  });
  ipcMain.handle('mdturn:open-external', async (event, url) => {
    if (!isTrustedRenderer(event) || !isSafeExternalUrl(url)) throw new Error('只允许打开 http/https 外部链接。');
    await shell.openExternal(url);
    return true;
  });
  // 导出 PDF / 打印:都走 Chromium 的打印媒体(desktop.css 的 @media print 只留正文)。
  ipcMain.handle('mdturn:export-pdf', async (event, payload) => {
    if (!isTrustedRenderer(event) || !mainWindow || mainWindow.isDestroyed()) throw new Error('拒绝无效的导出请求。');
    const suggested = payload && typeof payload.suggestedName === 'string' ? payload.suggestedName.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) : 'document';
    const defaultDir = payload && typeof payload.directory === 'string' && path.isAbsolute(payload.directory) ? payload.directory : app.getPath('documents');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出为 PDF',
      defaultPath: path.join(defaultDir, `${suggested.replace(/\.md$/i, '')}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    const pdf = await mainWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      preferCSSPageSize: false,
    });
    await fs.promises.writeFile(result.filePath, pdf);
    shell.showItemInFolder(result.filePath);
    return { ok: true, filePath: result.filePath };
  });
  ipcMain.handle('mdturn:print', async (event) => {
    if (!isTrustedRenderer(event) || !mainWindow || mainWindow.isDestroyed()) throw new Error('拒绝无效的打印请求。');
    return new Promise((resolve) => {
      mainWindow.webContents.print({ printBackground: true }, (success, reason) => resolve({ ok: success, reason: reason || null }));
    });
  });
  function safeFileStem(value, fallback) {
    const stem = typeof value === 'string' ? value.replace(/\.(md|markdown)$/i, '').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) : '';
    return stem || fallback;
  }
  function defaultDirectory(value) {
    return typeof value === 'string' && path.isAbsolute(value) ? value : app.getPath('documents');
  }
  // 新建:只负责让用户选位置和文件名;真正建文件由本地服务完成(拒绝覆盖、计入最近文件)。
  ipcMain.handle('mdturn:new-document', async (event, payload) => {
    if (!isTrustedRenderer(event) || !mainWindow || mainWindow.isDestroyed()) throw new Error('拒绝无效的新建请求。');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '新建 Markdown 文档',
      defaultPath: path.join(defaultDirectory(payload && payload.directory), '未命名.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    const filePath = /\.md$/i.test(result.filePath) ? result.filePath : `${result.filePath}.md`;
    return { ok: true, filePath };
  });
  // 导出单文件 HTML:页面把正文、样式、图片都内联好,主进程只管存盘。
  ipcMain.handle('mdturn:export-html', async (event, payload) => {
    if (!isTrustedRenderer(event) || !mainWindow || mainWindow.isDestroyed()) throw new Error('拒绝无效的导出请求。');
    const html = payload && typeof payload.html === 'string' ? payload.html : '';
    if (!html || html.length > 64 * 1024 * 1024) throw new Error('没有可导出的内容,或内容过大。');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出为 HTML',
      defaultPath: path.join(defaultDirectory(payload.directory), `${safeFileStem(payload.suggestedName, 'document')}.html`),
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    await fs.promises.writeFile(result.filePath, html, 'utf8');
    shell.showItemInFolder(result.filePath);
    return { ok: true, filePath: result.filePath };
  });
  // 导出 Word:用 pandoc 从磁盘上的源文件转换(见 export-docx.js);没装 pandoc 时说明怎么装。
  ipcMain.handle('mdturn:export-docx', async (event, payload) => {
    if (!isTrustedRenderer(event) || !mainWindow || mainWindow.isDestroyed()) throw new Error('拒绝无效的导出请求。');
    const sourcePath = payload && typeof payload.sourcePath === 'string' ? payload.sourcePath : '';
    if (!path.isAbsolute(sourcePath) || !/\.md$/i.test(sourcePath) || !fs.existsSync(sourcePath)) throw new Error('找不到要导出的 Markdown 文件。');
    if (!findPandoc()) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info', title: '导出 Word 需要 pandoc',
        message: '导出 Word 由 pandoc 完成(公式会成为 Word 可编辑公式)。这台电脑上还没有它。',
        detail: '在终端运行:brew install pandoc\n装好后再导出一次即可。',
        buttons: ['好'],
      });
      return { ok: false, reason: 'no-pandoc' };
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出为 Word',
      defaultPath: path.join(path.dirname(sourcePath), `${safeFileStem(payload.suggestedName || path.basename(sourcePath), 'document')}.docx`),
      filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    const outputPath = /\.docx$/i.test(result.filePath) ? result.filePath : `${result.filePath}.docx`;
    try {
      await exportDocx({ sourcePath, outputPath });
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
    shell.showItemInFolder(outputPath);
    return { ok: true, filePath: outputPath };
  });
  ipcMain.handle('mdturn:notify-review-complete', async (event, payload) => {
    if (!isTrustedRenderer(event) || !payload || typeof payload !== 'object') {
      throw new Error('拒绝无效的通知请求。');
    }
    const reviewId = typeof payload.reviewId === 'string' ? payload.reviewId.slice(0, 200) : '';
    const title = typeof payload.title === 'string' ? payload.title.slice(0, 180) : '';
    if (!reviewId || !title || !ElectronNotification.isSupported()) return false;
    const notification = new ElectronNotification({
      title: 'MDTurn · 修改已完成',
      body: `《${title}》已更新到最新版本。`,
      silent: false,
    });
    notification.on('click', () => {
      focusMainWindow();
      if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
        mainWindow.webContents.send(ACTIVATE_REVIEW_CHANNEL, reviewId);
      }
    });
    notification.show();
    return true;
  });
}

function installMenu() {
  const appearance = applyAppearance(readSettings().appearance);
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: 'MDTurn',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  template.push({
      label: '文件',
      submenu: [
        {
          label: '新建 Markdown…',
          accelerator: 'CmdOrCtrl+N',
          click: () => { sendRendererCommand('new'); },
        },
        {
          label: '打开 Markdown…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            if (sendRendererCommand('open')) return;
            const paths = await pickMarkdownFiles();
            queueOpenFiles(paths);
          },
        },
        {
          label: '关闭当前标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => { sendRendererCommand('close-tab'); },
        },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => { sendRendererCommand('save'); },
        },
        { type: 'separator' },
        {
          label: '导出为 PDF…',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => { sendRendererCommand('export-pdf'); },
        },
        {
          label: '导出为 HTML…',
          click: () => { sendRendererCommand('export-html'); },
        },
        {
          label: '导出为 Word…',
          click: () => { sendRendererCommand('export-docx'); },
        },
        {
          label: '打印…',
          accelerator: 'CmdOrCtrl+P',
          click: () => { sendRendererCommand('print'); },
        },
      ],
    }, {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: '查找…', accelerator: 'CmdOrCtrl+F', click: () => { sendRendererCommand('find'); } },
        { label: '查找下一个', accelerator: 'CmdOrCtrl+G', click: () => { sendRendererCommand('find-next'); } },
        { label: '查找上一个', accelerator: 'CmdOrCtrl+Shift+G', click: () => { sendRendererCommand('find-prev'); } },
      ],
    }, {
      label: '显示',
      submenu: [
        {
          label: '外观',
          submenu: [
            { label: '跟随系统', type: 'radio', checked: appearance === 'system', click: () => { writeSettings({ appearance: applyAppearance('system') }); } },
            { label: '浅色', type: 'radio', checked: appearance === 'light', click: () => { writeSettings({ appearance: applyAppearance('light') }); } },
            { label: '深色', type: 'radio', checked: appearance === 'dark', click: () => { writeSettings({ appearance: applyAppearance('dark') }); } },
          ],
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '放大正文', accelerator: 'CmdOrCtrl+=', click: () => { sendRendererCommand('zoom-in'); } },
        { label: '缩小正文', accelerator: 'CmdOrCtrl+-', click: () => { sendRendererCommand('zoom-out'); } },
        { label: '重置正文缩放', accelerator: 'CmdOrCtrl+0', click: () => { sendRendererCommand('zoom-reset'); } },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    }, {
      label: '窗口',
      submenu: [
        {
          label: '重新连接本地服务',
          click: () => { void connectAndLoad(); },
        },
        { type: 'separator' },
        { role: 'minimize' },
        ...(process.platform === 'darwin' ? [{ role: 'zoom' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    });
  if (process.platform === 'win32') {
    template.push({ label: '帮助', submenu: [{ role: 'about' }] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  const markdownPath = normalizeMarkdownPath(filePath);
  if (markdownPath) queueOpenFiles([markdownPath]);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  pendingOpenFiles = markdownPathsFromArguments(process.argv.slice(1), process.cwd());
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    queueOpenFiles(markdownPathsFromArguments(commandLine.slice(1), workingDirectory));
    focusMainWindow();
  });
  app.whenReady().then(() => {
    applyAppearance(readSettings().appearance);
    // Dock 图标在运行时显式设置:macOS 会缓存旧图标,换图标后光靠包里的 icns 不一定立刻生效
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.setIcon(path.join(__dirname, 'dock-icon.png')); } catch {}
    }
    installIpc();
    installMenu();
    createWindow();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // 用 will-quit 而不是 before-quit:后者在窗口关闭之前触发,若用户在"未保存修改"提示里选了取消,
  // 服务已被杀、窗口却还在,之后保存只会报"服务不可达"。will-quit 只在所有窗口都已关闭后触发。
  app.on('will-quit', () => {
    stopOwnedService(activeService);
    if (pendingOwnedProcess) stopOwnedService({ ownedProcess: pendingOwnedProcess });
    activeService = null;
    pendingOwnedProcess = null;
  });
}
