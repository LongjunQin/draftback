'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_PORT = 8080;
const PORT_SCAN_COUNT = 11;
const HEALTH_TIMEOUT_MS = 700;
const READY_TIMEOUT_MS = 12_000;

function serverDirectory(options = {}) {
  if (options.serverDir) return path.resolve(options.serverDir);
  if (options.isPackaged) return path.join(options.resourcesPath, 'draftback-server');
  return path.resolve(__dirname, '..');
}

// 必须与 lib/review-store.js 的默认数据目录一致,CLI 与 App 才能共享会话。
function defaultDataDirectory(options = {}) { return path.join(options.homeDir || os.homedir(), '.draftback'); }
function ownedDataDirectory(options = {}) {
  const override = options.dataDir || process.env.DRAFTBACK_DATA_DIR;
  return path.resolve(override || defaultDataDirectory(options));
}

// 改名前的 ~/.mdread 整个搬到 ~/.draftback(与 lib/review-store.js 的做法一致;命名沿革见 docs/naming-history.md)。
// 只由主进程在启动内置服务之前显式调用一次——不放进 ownedDataDirectory,免得单元测试一碰就把真实数据目录搬了家。
const LEGACY_DATA_DIR_NAMES = ['.mdread'];
function migrateLegacyDataDir(options = {}) {
  const target = ownedDataDirectory(options);
  if (path.resolve(target) !== path.resolve(defaultDataDirectory(options)) || fs.existsSync(target)) return { migrated: false };
  for (const legacy of LEGACY_DATA_DIR_NAMES.map((name) => path.join(options.homeDir || os.homedir(), name))) {
    let stat;
    try { stat = fs.lstatSync(legacy); } catch { continue; }
    if (!stat.isDirectory()) continue;
    try { fs.renameSync(legacy, target); return { migrated: true, from: legacy }; } catch { return { migrated: false }; }
  }
  return { migrated: false };
}

function parsePort(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function readRecordedPort(filePath) {
  try {
    return parsePort(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function portFiles(options = {}) {
  return unique([
    path.join(ownedDataDirectory(options), 'port'),
  ]);
}

function candidatePorts(options = {}) {
  const recorded = (options.portFiles || portFiles(options))
    .map(readRecordedPort)
    .filter(Boolean);
  const ports = [...recorded];
  if (options.scanDefault !== false) {
    const base = parsePort(process.env.DRAFTBACK_PORT) || DEFAULT_PORT;
    const maximum = Math.min(base + PORT_SCAN_COUNT - 1, 65_535);
    for (let port = base; port <= maximum; port += 1) ports.push(port);
  }
  return unique(ports);
}

function requestHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/health',
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const valid = response.statusCode === 200 && payload && payload.ok === true &&
            payload.service === 'draftback-service' && payload.port === port;
          resolve(valid ? { port, payload } : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function findHealthyService(options = {}) {
  const ports = candidatePorts(options);
  const results = await Promise.all(ports.map((port) => requestHealth(port, options.healthTimeoutMs)));
  return results.find(Boolean) || null;
}

function startOwnedService(options = {}) {
  const directory = serverDirectory(options);
  const serverPath = path.join(directory, 'server.js');
  if (!fs.existsSync(serverPath)) {
    throw new Error(`内置服务文件不存在: ${serverPath}`);
  }
  const dataDir = ownedDataDirectory(options);
  fs.mkdirSync(dataDir, { recursive: true });
  const logFd = openServiceLog(dataDir);
  const spawnProcess = options.spawn || spawn;
  const executablePath = options.executablePath || process.execPath;
  const child = spawnProcess(executablePath, [serverPath], {
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DRAFTBACK_DATA_DIR: dataDir,
      DRAFTBACK_HOST: '127.0.0.1',
      // 优先用上次的端口:页面的本地存储(打开的标签、未保存草稿、阅读偏好)按"地址+端口"隔离,
      // 端口每次随机就等于每次清空;占用时服务自己往后找 10 个,都不行再退回随机端口(见 ensureService)
      DRAFTBACK_PORT: preferredPortValue(options.preferredPort),
      // 服务自己盯着主进程:主进程崩溃/被强退时服务随之退出,不留孤儿
      DRAFTBACK_PARENT_PID: String(process.pid),
    },
    detached: false,
    // 服务的输出写到数据目录 service.log:服务悄悄退出时这是唯一的线索
    stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
    windowsHide: true,
  });
  if (logFd !== null) child.once('spawn', () => { try { fs.closeSync(logFd); } catch {} });
  child.draftbackSpawnError = null;
  child.once('error', (error) => { child.draftbackSpawnError = error; });
  return { child, dataDir, portFile: path.join(dataDir, 'port') };
}

// 超过 2 MB 就从头来,不让日志无限长
function openServiceLog(dataDir) {
  const file = path.join(dataDir, 'service.log');
  try {
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    const fd = fs.openSync(file, size > 2 * 1024 * 1024 ? 'w' : 'a');
    fs.writeSync(fd, `\n===== ${new Date().toISOString()} 回稿启动内置服务 =====\n`);
    return fd;
  } catch {
    return null;
  }
}

function preferredPortValue(value) {
  const port = parsePort(value);
  return port && port >= 1024 ? String(port) : '0';
}

function stopOwnedService(service) {
  const child = service && service.ownedProcess;
  if (!child || child.exitCode !== null || child.killed) return false;
  try {
    child.kill();
    return true;
  } catch {
    return false;
  }
}

async function startAndAwaitService(options) {
  const started = (options.startService || startOwnedService)(options);
  const ownedProcess = started.child;
  // 健康检查通过之前子进程只存在于这里;调用方可借此记下它,以便此时退出也能把它杀掉
  if (ownedProcess && typeof options.onSpawn === 'function') options.onSpawn(ownedProcess);
  const discoveryOptions = {
    ...options,
    portFiles: [started.portFile],
    scanDefault: false,
  };

  const readyTimeoutMs = options.readyTimeoutMs || READY_TIMEOUT_MS;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs || 250));
    if (ownedProcess && ownedProcess.draftbackSpawnError) {
      throw new Error(`无法启动回稿内置服务: ${ownedProcess.draftbackSpawnError.message}`);
    }
    if (ownedProcess && ownedProcess.exitCode !== null) {
      const error = new Error(`回稿内置服务提前退出（代码 ${ownedProcess.exitCode}）。`);
      error.earlyExit = true;
      throw error;
    }
    const service = await findHealthyService(discoveryOptions);
    if (service) return { ...service, ...(ownedProcess ? { ownedProcess } : {}) };
  }
  if (ownedProcess) stopOwnedService({ ownedProcess });
  const seconds = Math.round(readyTimeoutMs / 100) / 10;
  throw new Error(`回稿内置服务在 ${seconds} 秒内没有就绪。`);
}

async function ensureService(options = {}) {
  const service = await findHealthyService(options);
  if (service) return service;
  try {
    return await startAndAwaitService(options);
  } catch (error) {
    // 上次的端口(连同后面 10 个)都被别的程序占了,服务起不来:退回系统随机端口再试一次
    if (!error.earlyExit || preferredPortValue(options.preferredPort) === '0') throw error;
    return startAndAwaitService({ ...options, preferredPort: null });
  }
}

module.exports = {
  DEFAULT_PORT,
  candidatePorts,
  ensureService,
  findHealthyService,
  migrateLegacyDataDir,
  ownedDataDirectory,
  parsePort,
  portFiles,
  requestHealth,
  serverDirectory,
  startOwnedService,
  stopOwnedService,
};
