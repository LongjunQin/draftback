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
const { ensureService, stopOwnedService, ownedDataDirectory, migrateLegacyDataDir, requestHealth } = require('./service');
const { spawn } = require('child_process');
const { exportDocx, findPandoc } = require('./export-docx');
const { migrateFromLegacyNames } = require('./user-data-migration');

// 产品名:英文 Draftback(包名、数据目录),中文界面一律叫「回稿」(Finder / Dock 里的名字由 Info.plist 本地化决定)。
// 用户数据目录显式固定为 Draftback,并在任何东西碰它之前,把旧名字(MDTurn)目录里的设置和本地存储复制过来。
const DISPLAY_NAME = '回稿';
app.setName('Draftback');
if (process.platform === 'win32') app.setAppUserModelId('app.draftback.mac');
{
  const userDataDir = path.join(app.getPath('appData'), 'Draftback');
  try {
    const migration = migrateFromLegacyNames(app.getPath('appData'), userDataDir);
    if (migration.migrated) console.log(`[回稿] 已从旧版数据目录迁移: ${migration.copied.join(', ')}`);
  } catch (error) {
    console.error('[回稿] 旧版数据目录迁移失败(不影响使用):', error && error.message);
  }
  app.setPath('userData', userDataDir);
}

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
// 封面颜色(方案 C 的 6 种;2026-10-17 用户定默认淡绿);打开「程序坞图标跟着封面换」时,程序坞图标用同色的那一张。
// macOS 只让正在运行的程序换程序坞图标:退出后程序坞和访达里仍是安装包里的淡绿图标。
const COVERS = ['green', 'mist', 'lavender', 'gold', 'orange', 'black'];
function coverOf(settings) { return COVERS.includes(settings.cover) ? settings.cover : 'green'; }
// 窗口打底色:页面画出来之前先露出的颜色,用封面皮面的颜色(日间压暗 6%;夜读往暖黑里压 64%,和 desktop-skin.css 一致),免得先闪一下灰
const COVER_WINDOW_COLORS = {
  green: ['#b4c5a5', '#575846'], mist: ['#71889c', '#3d4143'], lavender: ['#8c82a4', '#483e46'],
  gold: ['#c6b48f', '#5e523e'], orange: ['#c16430', '#5c3319'], black: ['#29292d', '#221d18'],
};
function windowBackgroundColor() {
  const colors = COVER_WINDOW_COLORS[coverOf(readSettings())];
  return nativeTheme.shouldUseDarkColors ? colors[1] : colors[0];
}
function applyDockIcon(settings = readSettings()) {
  if (process.platform !== 'darwin' || !app.dock) return;
  const cover = settings.dockIconFollowsCover === true ? coverOf(settings) : 'green';
  const file = cover === 'green' ? path.join(__dirname, 'dock-icon.png') : path.join(__dirname, 'dock-icons', `${cover}.png`);
  try { app.dock.setIcon(file); } catch {}
}
function applyAppearance(value) {
  const appearance = APPEARANCES.includes(value) ? value : 'system';
  // themeSource 会同时改变渲染进程的 prefers-color-scheme,页面样式随之切换,不必重载
  nativeTheme.themeSource = appearance;
  return appearance;
}

const OPEN_FILES_CHANNEL = 'draftback:open-files';
const COMMAND_CHANNEL = 'draftback:command';
const ACTIVATE_REVIEW_CHANNEL = 'draftback:activate-review';

let mainWindow = null;
let serviceOrigin = null;
let rendererReady = false;
let pendingOpenFiles = [];
let connecting = null;
let activeService = null;
let pendingOwnedProcess = null; // 已 spawn、尚未通过健康检查的内置服务子进程
let syncHelper = null; // Draftback Sync.app(原生辅助程序,负责与 iCloud 同步;跨端规则第 12 节)

// 打包后在 Draftback.app/Contents/Helpers/ 里;开发时用 mac-sync/scripts/build.sh 的产物;也可用环境变量指定
function syncHelperExecutable() {
  if (process.platform !== 'darwin') return null;
  const relative = path.join('Draftback Sync.app', 'Contents', 'MacOS', 'Draftback Sync');
  const candidates = [
    process.env.DRAFTBACK_SYNC_HELPER,
    app.isPackaged ? path.join(process.resourcesPath, '..', 'Helpers', relative) : null,
    path.join(__dirname, '..', 'mac-sync', 'build', relative),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function startSyncHelper() {
  if (syncHelper || process.env.DRAFTBACK_SYNC_DISABLED === '1' || readSettings().syncEnabled === false) return;
  const executable = syncHelperExecutable();
  if (!executable) return;
  try {
    const child = spawn(executable, [], {
      env: { ...process.env, DRAFTBACK_DATA_DIR: ownedDataDirectory(), DRAFTBACK_PARENT_PID: String(process.pid) },
      stdio: 'ignore',
      detached: false,
    });
    syncHelper = child;
    // 只清自己:快速「关 → 开」时,旧进程迟到的退出事件不能把新进程的句柄清掉
    child.on('exit', () => { if (syncHelper === child) syncHelper = null; });
    child.on('error', () => { if (syncHelper === child) syncHelper = null; });
  } catch {
    syncHelper = null;
  }
}

// 内置服务掉线(崩溃、被强退)时界面会悄悄失灵:每 10 秒探一次,连续 3 次不通就重启服务与同步程序并重载页面
const SERVICE_WATCH_INTERVAL_MS = 10_000;
let serviceWatchTimer = null;
let serviceMisses = 0;
function startServiceWatch() {
  if (serviceWatchTimer) return;
  serviceWatchTimer = setInterval(async () => {
    if (!activeService || connecting || !mainWindow || mainWindow.isDestroyed()) return;
    const healthy = await requestHealth(activeService.port, 2_000);
    if (healthy) { serviceMisses = 0; return; }
    serviceMisses += 1;
    if (serviceMisses < 3) return;
    serviceMisses = 0;
    console.error(`[回稿] 内置服务(端口 ${activeService.port})连续 3 次健康检查失败,重启`);
    stopOwnedService(activeService);
    activeService = null;
    stopSyncHelper();
    await connectAndLoad();
  }, SERVICE_WATCH_INTERVAL_MS);
  if (typeof serviceWatchTimer.unref === 'function') serviceWatchTimer.unref();
}

function stopSyncHelper() {
  if (syncHelper && syncHelper.exitCode === null) {
    try { syncHelper.kill(); } catch {}
  }
  syncHelper = null;
}

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
    <title>${DISPLAY_NAME} · 服务未就绪</title><style>
    :root{color-scheme:light dark}body{margin:0;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:#f5f5f7;color:#1d1d1f;display:grid;min-height:100vh;place-items:center}.card{width:min(560px,calc(100vw - 64px));
    padding:36px;border:1px solid #d2d2d7;border-radius:18px;background:#fff;box-shadow:0 18px 70px #0001}h1{font-size:24px;margin:0 0 12px}
    p{line-height:1.7;margin:8px 0;color:#515154}.detail{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
    padding:12px;border-radius:9px;background:#f5f5f7;overflow-wrap:anywhere}.hint{margin-top:18px;color:#6e6e73}
    @media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}.card{background:#2c2c2e;border-color:#48484a}.detail{background:#1c1c1e}p,.hint{color:#aeaeb2}}
    </style></head><body><main class="card"><h1>本地服务没有就绪</h1><p>${DISPLAY_NAME}无法连接本地审阅服务。</p>
    <p class="detail">${message}</p><p class="hint">请从“窗口”菜单选择“重新连接本地服务”重试。</p></main></body></html>`;
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function connectAndLoad() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      // 改名前的数据目录(~/.mdread)第一次启动时搬到 ~/.draftback;在起内置服务之前做,CLI 与服务才看到同一份数据
      try { const moved = migrateLegacyDataDir(); if (moved.migrated) console.log(`[回稿] 数据目录已从 ${moved.from} 搬到 ${ownedDataDirectory()}`); } catch (error) { console.error('[回稿] 数据目录搬迁失败:', error && error.message); }
      const service = await ensureService({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        executablePath: process.execPath,
        onSpawn: (child) => { pendingOwnedProcess = child; },
        preferredPort: readSettings().servicePort,
      });
      // 记下这次的端口,下次优先用它:页面本地存储(标签、草稿、偏好)按端口隔离
      if (readSettings().servicePort !== service.port) writeSettings({ servicePort: service.port });
      if (!service.ownedProcess && activeService && activeService.ownedProcess && activeService.port === service.port) {
        service.ownedProcess = activeService.ownedProcess;
      }
      activeService = service;
      pendingOwnedProcess = null;
      serviceMisses = 0;
      startSyncHelper();
      startServiceWatch();
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
    title: DISPLAY_NAME,
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: windowBackgroundColor(),
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
    windowOptions.trafficLightPosition = { x: 16, y: 15 }; // 工具栏 46 像素高(方案 C),红绿灯竖直居中
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
      detail: `关闭后这些修改会丢失(下次启动可能从草稿恢复)。先回到${DISPLAY_NAME}按 ⌘S 保存,或放弃修改。`,
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

// ---------- 命令行工具 mdreview(设置 › 命令行工具):给 AI 用的命令,装到 /usr/local/bin ----------
const CLI_PATH = '/usr/local/bin/mdreview';
function cliScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'draftback-server', 'mdreview.js')
    : path.join(__dirname, '..', 'mdreview.js');
}
const CliInstall = require('./cli-install');
function cliLauncher() { return CliInstall.launcherScript(process.execPath, cliScriptPath()); }
function cliStatus() {
  let text = '';
  try { text = fs.readFileSync(CLI_PATH, 'utf8'); } catch { return { installed: false, path: CLI_PATH, pointsTo: null }; }
  return { installed: true, path: CLI_PATH, ...CliInstall.describeInstalled(text, cliScriptPath()) };
}
async function installCli() {
  const script = cliLauncher();
  const dir = path.dirname(CLI_PATH);
  const done = () => (CliInstall.verifyInstalled(fs, CLI_PATH, script)
    ? { ok: true, ...cliStatus() }
    : { ok: false, message: '装完核对时发现 /usr/local/bin/mdreview 不是这份脚本(可能是目录或被替换了),请检查后再试。' });
  // 先在同一目录排他地写临时文件再改名替换:改名换掉的是目录项本身,旧的 mdreview 若是指向别处的符号链接,
  // 不会顺着链接把别人的文件改写掉;目标若是真正的目录,改名会失败
  const staged = path.join(dir, `.mdreview-draftback-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(staged, script, { mode: 0o755, flag: 'wx' });
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, CLI_PATH);
    return done();
  } catch (error) {
    try { fs.unlinkSync(staged); } catch {}
    if (!error || (error.code !== 'EACCES' && error.code !== 'EPERM')) return { ok: false, message: String(error && error.message || error) };
  }
  // /usr/local/bin 要管理员权限:内容先写到只有本程序控制的临时目录,再请系统弹出授权框完成同样的替换
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'draftback-cli-'));
  const tmp = path.join(tmpDir, 'mdreview');
  fs.writeFileSync(tmp, script, { mode: 0o755 });
  const command = CliInstall.privilegedInstallCommand({ tmpFile: tmp, dir, target: CLI_PATH });
  try {
    const ok = await new Promise((resolve) => {
      const child = spawn('/usr/bin/osascript', ['-e', command], { stdio: 'ignore' });
      child.on('exit', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
    return ok ? done() : { ok: false, message: '没有拿到管理员授权,或安装位置不对(见系统提示),命令没有装上。' };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function installIpc() {
  ipcMain.handle('draftback:pick-markdown', async (event) => {
    if (!isTrustedRenderer(event)) throw new Error('拒绝非${DISPLAY_NAME}页面调用文件选择器。');
    return pickMarkdownFiles();
  });
  ipcMain.handle('draftback:reveal-path', async (event, targetPath) => {
    if (!isTrustedRenderer(event) || typeof targetPath !== 'string' || targetPath.includes('\0') || !path.isAbsolute(targetPath)) {
      throw new Error('无效的本地路径。');
    }
    let realPath;
    try { realPath = fs.realpathSync(targetPath); } catch { throw new Error('路径不存在。'); }
    shell.showItemInFolder(realPath);
    return true;
  });
  ipcMain.handle('draftback:open-external', async (event, url) => {
    if (!isTrustedRenderer(event) || !isSafeExternalUrl(url)) throw new Error('只允许打开 http/https 外部链接。');
    await shell.openExternal(url);
    return true;
  });
  // 导出 PDF / 打印:都走 Chromium 的打印媒体(desktop.css 的 @media print 只留正文)。
  ipcMain.handle('draftback:export-pdf', async (event, payload) => {
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
  ipcMain.handle('draftback:print', async (event) => {
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
  ipcMain.handle('draftback:new-document', async (event, payload) => {
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
  ipcMain.handle('draftback:export-html', async (event, payload) => {
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
  ipcMain.handle('draftback:export-docx', async (event, payload) => {
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
  // 页面报来的状态:菜单逐项启用 / 勾选(动作表里的 when / checked)
  ipcMain.on('draftback:menu-state', (event, state) => {
    if (!isTrustedRenderer(event) || !state || typeof state !== 'object') return;
    menuState = state;
    refreshMenuState();
  });
  // 打开过的文档进系统「打开最近」(文件 › 打开最近,Dock 右键也有)
  const notedRecent = new Set();
  ipcMain.on('draftback:note-recent', (event, filePath) => {
    if (!isTrustedRenderer(event) || typeof filePath !== 'string' || !path.isAbsolute(filePath) || !/\.md$/i.test(filePath)) return;
    if (notedRecent.has(filePath)) return;
    notedRecent.add(filePath);
    try { app.addRecentDocument(filePath); } catch {}
  });
  ipcMain.handle('draftback:get-settings', async (event) => {
    if (!isTrustedRenderer(event)) throw new Error('拒绝非回稿页面读取设置。');
    const settings = readSettings();
    return {
      appearance: APPEARANCES.includes(settings.appearance) ? settings.appearance : 'system',
      cover: coverOf(settings),
      dockIconFollowsCover: settings.dockIconFollowsCover === true,
      syncEnabled: settings.syncEnabled !== false,
      syncHelperAvailable: Boolean(syncHelperExecutable()),
      syncHelperRunning: Boolean(syncHelper && syncHelper.exitCode === null),
      version: app.getVersion(),
      packaged: app.isPackaged,
      cli: cliStatus(),
    };
  });
  ipcMain.handle('draftback:set-appearance', async (event, value) => {
    if (!isTrustedRenderer(event)) throw new Error('拒绝无效的设置请求。');
    const appearance = applyAppearance(value);
    writeSettings({ appearance });
    refreshMenuState();
    return appearance;
  });
  ipcMain.handle('draftback:set-cover', async (event, value) => {
    if (!isTrustedRenderer(event) || !COVERS.includes(value)) throw new Error('拒绝无效的设置请求。');
    applyDockIcon(writeSettings({ cover: value }));
    return value;
  });
  ipcMain.handle('draftback:set-dock-icon-follows-cover', async (event, enabled) => {
    if (!isTrustedRenderer(event)) throw new Error('拒绝无效的设置请求。');
    applyDockIcon(writeSettings({ dockIconFollowsCover: Boolean(enabled) }));
    return Boolean(enabled);
  });
  ipcMain.handle('draftback:set-sync-enabled', async (event, enabled) => {
    if (!isTrustedRenderer(event)) throw new Error('拒绝无效的设置请求。');
    writeSettings({ syncEnabled: Boolean(enabled) });
    if (enabled) startSyncHelper(); else stopSyncHelper();
    return { syncEnabled: Boolean(enabled), running: Boolean(syncHelper && syncHelper.exitCode === null) };
  });
  ipcMain.handle('draftback:install-cli', async (event) => {
    if (!isTrustedRenderer(event)) throw new Error('拒绝无效的安装请求。');
    return installCli();
  });
  // 另存为副本 / 另存我的版本:只负责选位置,文件由本地服务写(不覆盖正在审阅的文件)
  ipcMain.handle('draftback:save-copy-dialog', async (event, payload) => {
    if (!isTrustedRenderer(event) || !mainWindow || mainWindow.isDestroyed()) throw new Error('拒绝无效的另存请求。');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: payload && payload.title ? String(payload.title).slice(0, 60) : '另存为副本',
      defaultPath: path.join(defaultDirectory(payload && payload.directory), `${safeFileStem(payload && payload.suggestedName, '副本')}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    return { ok: true, filePath: /\.md$/i.test(result.filePath) ? result.filePath : `${result.filePath}.md` };
  });
  // 稿件 › 导入批注文件…:选一个批次文件,读出文字交给页面(和拖进窗口走同一条路)
  ipcMain.handle('draftback:pick-batch-file', async (event) => {
    if (!isTrustedRenderer(event) || !mainWindow || mainWindow.isDestroyed()) throw new Error('拒绝无效的导入请求。');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入手机批注批次', buttonLabel: '导入', properties: ['openFile'],
      filters: [{ name: '批注批次', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
    const filePath = result.filePaths[0];
    const stat = fs.statSync(filePath);
    if (stat.size > 32 * 1024 * 1024) throw new Error('批次文件太大。');
    return { ok: true, name: path.basename(filePath), text: fs.readFileSync(filePath, 'utf8') };
  });
  ipcMain.handle('draftback:notify-review-complete', async (event, payload) => {
    if (!isTrustedRenderer(event) || !payload || typeof payload !== 'object') {
      throw new Error('拒绝无效的通知请求。');
    }
    const reviewId = typeof payload.reviewId === 'string' ? payload.reviewId.slice(0, 200) : '';
    const title = typeof payload.title === 'string' ? payload.title.slice(0, 180) : '';
    if (!reviewId || !title || !ElectronNotification.isSupported()) return false;
    const round = Number.isInteger(payload.round) ? payload.round : null;
    const counts = payload.counts && typeof payload.counts === 'object' ? payload.counts : null;
    const tail = counts && Number.isInteger(counts.applied) ? ` · 采纳 ${counts.applied} · 未采纳 ${Number(counts.wontfix) || 0}` : '';
    const notification = new ElectronNotification({
      title: `《${title}》${round ? `第 ${round} 轮` : ''}回稿`,
      body: `稿子回来了${tail}。点开看改了什么。`,
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

// ---------- 菜单栏:按动作表搭(static/desktop-actions.js,页面与菜单共用一张表) ----------
function loadActions() {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'draftback-server', 'static', 'desktop-actions.js') : null,
    path.join(__dirname, '..', 'static', 'desktop-actions.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return require(candidate); } catch (error) { console.error('[回稿] 动作表加载失败:', error && error.message); }
  }
  return null;
}
const Actions = loadActions();
let menuState = {};
let appMenu = null;

// 主进程自己处理的命令;其余交给页面
function runMenuCommand(command) {
  if (command === 'open') {
    if (sendRendererCommand('open')) return;
    void pickMarkdownFiles().then((paths) => queueOpenFiles(paths));
    return;
  }
  if (command === 'reconnect') { void connectAndLoad(); return; }
  if (command.startsWith('appearance:')) {
    const value = command.slice('appearance:'.length);
    writeSettings({ appearance: applyAppearance(value) });
    refreshMenuState();
    return;
  }
  sendRendererCommand(command);
}

function menuTemplateFrom(items) {
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (item.type === 'separator') { if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' }); continue; }
    if (item.devOnly && app.isPackaged) continue;
    if (item.mac && process.platform !== 'darwin') continue;
    const entry = { label: item.label };
    if (item.id) entry.id = item.id;
    if (item.role) entry.role = item.role;
    if (item.accelerator && !(process.platform !== 'darwin' && /(^|\+)Ctrl\+/.test(item.accelerator) && /CmdOrCtrl/.test(item.accelerator))) entry.accelerator = item.accelerator;
    if (item.submenu) entry.submenu = menuTemplateFrom(item.submenu);
    if (item.radio) {
      entry.type = 'radio';
      entry.checked = item.command === `appearance:${readSettings().appearance || 'system'}`;
    } else if (item.checked) {
      entry.type = 'checkbox';
      entry.checked = Actions.isChecked(item, menuState);
    }
    if (item.command && !item.role) {
      const command = item.command;
      entry.click = () => runMenuCommand(command);
      entry.enabled = Actions.isEnabled(item, menuState);
    }
    out.push(entry);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

function installMenu() {
  applyAppearance(readSettings().appearance);
  if (!Actions) {
    // 动作表缺失(开发环境路径不对等)时退回最小菜单,至少能打开文件与退出
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: '文件', submenu: [{ label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => runMenuCommand('open') }] },
      { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
    return;
  }
  const template = Actions.MENUS
    .filter((menu) => !(menu.mac && process.platform !== 'darwin'))
    .map((menu) => {
      const entry = { label: menu.label, submenu: menuTemplateFrom(menu.items) };
      if (menu.id === 'window') entry.role = 'window'; // 让 macOS 把打开的窗口列在这个菜单里
      if (menu.id === 'help') entry.role = 'help';
      return entry;
    });
  appMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(appMenu);
}

// 页面报来状态后,逐项改启用与勾选(菜单项是活的,不必重建)
function refreshMenuState() {
  if (!appMenu || !Actions) return;
  const appearance = readSettings().appearance || 'system';
  for (const item of Actions.flatten()) {
    if (!item.id) continue;
    const menuItem = appMenu.getMenuItemById(item.id);
    if (!menuItem) continue;
    if (item.radio) { menuItem.checked = item.command === `appearance:${appearance}`; continue; }
    if (item.command && !item.role) menuItem.enabled = Actions.isEnabled(item, menuState);
    if (item.checked) menuItem.checked = Actions.isChecked(item, menuState);
  }
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
    // Dock 图标在运行时显式设置:macOS 会缓存旧图标,换图标后光靠包里的 icns 不一定立刻生效;
    // 打开了「程序坞图标跟着封面换」就用封面颜色那一张
    applyDockIcon();
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
    if (serviceWatchTimer) { clearInterval(serviceWatchTimer); serviceWatchTimer = null; }
    stopSyncHelper();
    stopOwnedService(activeService);
    if (pendingOwnedProcess) stopOwnedService({ ownedProcess: pendingOwnedProcess });
    activeService = null;
    pendingOwnedProcess = null;
  });
}
