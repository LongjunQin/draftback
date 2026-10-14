'use strict';

const fs = require('fs');
const path = require('path');

// 产品改名(MDTurn → Draftback / 回稿)后,Electron 的用户数据目录跟着产品名变了。
// 首次以新名字启动时,把旧目录里值得留下的东西复制过来:设置(外观、上次用的本地端口)、
// 页面本地存储(打开的标签、未保存草稿、阅读缩放等偏好)。
// 不搬:缓存(几百 MB,会自动重建);Singleton* 单实例锁(复制过来会让新 App 以为已有实例在跑);任何符号链接。
// 复制而不是移动:旧目录原样留着,装回旧版立刻可用。
const LEGACY_PRODUCT_NAMES = ['MDTurn'];
const KEEP_ENTRIES = ['settings.json', 'Local Storage', 'IndexedDB', 'Preferences', 'Local State'];
const MARKER = '.migrated-from-legacy';

function isSymlink(target, fsImpl) {
  try { return fsImpl.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

function migrateUserData(fromDir, toDir, fsImpl = fs) {
  if (!fromDir || !toDir || path.resolve(fromDir) === path.resolve(toDir)) return { migrated: false, reason: 'same-directory' };
  if (!fsImpl.existsSync(fromDir)) return { migrated: false, reason: 'no-legacy-directory' };
  // Electron 可能在我们之前就建了一个空的新目录,所以不能只看新目录在不在:看标记和本地存储
  if (fsImpl.existsSync(path.join(toDir, MARKER))) return { migrated: false, reason: 'already-migrated' };
  if (fsImpl.existsSync(path.join(toDir, 'Local Storage'))) return { migrated: false, reason: 'target-in-use' };
  fsImpl.mkdirSync(toDir, { recursive: true });
  const copied = [];
  for (const name of KEEP_ENTRIES) {
    const source = path.join(fromDir, name);
    const target = path.join(toDir, name);
    if (!fsImpl.existsSync(source) || isSymlink(source, fsImpl) || fsImpl.existsSync(target)) continue;
    fsImpl.cpSync(source, target, { recursive: true, filter: (item) => !isSymlink(item, fsImpl) });
    copied.push(name);
  }
  fsImpl.writeFileSync(path.join(toDir, MARKER), `${JSON.stringify({ from: fromDir, at: new Date().toISOString(), copied })}\n`);
  return { migrated: true, copied };
}

function migrateFromLegacyNames(appDataDir, toDir, fsImpl = fs) {
  for (const name of LEGACY_PRODUCT_NAMES) {
    const result = migrateUserData(path.join(appDataDir, name), toDir, fsImpl);
    if (result.migrated || result.reason === 'already-migrated' || result.reason === 'target-in-use') return result;
  }
  return { migrated: false, reason: 'no-legacy-directory' };
}

module.exports = { KEEP_ENTRIES, LEGACY_PRODUCT_NAMES, MARKER, migrateFromLegacyNames, migrateUserData };
