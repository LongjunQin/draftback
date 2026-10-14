'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MARKER, migrateFromLegacyNames, migrateUserData } = require('../user-data-migration');

function legacyFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-userdata-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'MDTurn');
  fs.mkdirSync(path.join(legacy, 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Local Storage', 'leveldb', '000003.log'), 'tabs');
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"appearance":"dark"}');
  fs.writeFileSync(path.join(legacy, 'Preferences'), '{}');
  fs.mkdirSync(path.join(legacy, 'Cache', 'Cache_Data'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Cache', 'Cache_Data', 'big'), 'x'.repeat(1024));
  fs.symlinkSync('host-1234', path.join(legacy, 'SingletonLock'));
  return { root, legacy, target: path.join(root, 'Draftback') };
}

test('改名后首次启动:只复制设置与本地存储,不搬缓存和单实例锁,旧目录原样保留', (context) => {
  const f = legacyFixture(context);
  const result = migrateFromLegacyNames(f.root, f.target);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.copied.sort(), ['Local Storage', 'Preferences', 'settings.json'].sort());
  assert.equal(fs.readFileSync(path.join(f.target, 'Local Storage', 'leveldb', '000003.log'), 'utf8'), 'tabs');
  assert.equal(fs.readFileSync(path.join(f.target, 'settings.json'), 'utf8'), '{"appearance":"dark"}');
  assert.equal(fs.existsSync(path.join(f.target, 'Cache')), false, '缓存不搬');
  assert.equal(fs.existsSync(path.join(f.target, 'SingletonLock')), false, '单实例锁不能复制');
  assert.ok(fs.existsSync(path.join(f.target, MARKER)));
  assert.ok(fs.existsSync(path.join(f.legacy, 'Local Storage')), '旧目录必须原样保留');
});

test('只迁一次;新目录已在用(有本地存储)或已有设置时不覆盖', (context) => {
  const f = legacyFixture(context);
  // Electron 抢先建了空目录、安装脚本预写了设置:照样迁移,但不覆盖已有的设置
  fs.mkdirSync(f.target, { recursive: true });
  fs.writeFileSync(path.join(f.target, 'settings.json'), '{"servicePort":54114}');
  const first = migrateUserData(f.legacy, f.target);
  assert.equal(first.migrated, true);
  assert.equal(fs.readFileSync(path.join(f.target, 'settings.json'), 'utf8'), '{"servicePort":54114}');
  assert.ok(first.copied.includes('Local Storage'));
  const second = migrateUserData(f.legacy, f.target);
  assert.deepEqual(second, { migrated: false, reason: 'already-migrated' });

  const fresh = path.join(f.root, 'InUse');
  fs.mkdirSync(path.join(fresh, 'Local Storage'), { recursive: true });
  assert.deepEqual(migrateUserData(f.legacy, fresh), { migrated: false, reason: 'target-in-use' });
});

test('没有旧目录时什么都不做', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-userdata-empty-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(migrateFromLegacyNames(root, path.join(root, 'Draftback')), { migrated: false, reason: 'no-legacy-directory' });
  assert.equal(fs.existsSync(path.join(root, 'Draftback')), false);
});
