'use strict';

// 设置 › 命令行工具:装到 /usr/local/bin 的启动脚本与提权命令,路径里有 $()、反引号、引号也只当文字(Codex 审查 P1)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Cli = require('../cli-install');

const EVIL = "/Apps/Draft$(printf INJECTED >&2)`printf TICK >&2`it's \"q\" \\back.app";

test('shell 单引号转义:bash 原样拿到路径,不执行任何东西', () => {
  const out = execFileSync('/bin/bash', ['-c', `printf %s ${Cli.shellQuote(EVIL)}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(out.toString(), EVIL);
});

test('启动脚本:App 路径里的特殊字符不会被展开,参数原样传给 mdreview.js', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeRuntime = path.join(dir, "运行 时$(x)'.sh");
  fs.writeFileSync(fakeRuntime, '#!/bin/bash\nprintf "%s|" "$ELECTRON_RUN_AS_NODE" "$@"\n', { mode: 0o755 });
  const script = path.join(dir, 'launcher');
  fs.writeFileSync(script, Cli.launcherScript(fakeRuntime, EVIL + '/mdreview.js'), { mode: 0o755 });
  const result = execFileSync(script, ['status', 'a b'], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.toString(), `1|${EVIL}/mdreview.js|status|a b|`);
  assert.deepEqual(Cli.describeInstalled(fs.readFileSync(script, 'utf8'), EVIL + '/mdreview.js').pointsTo, 'this-app');
  assert.equal(Cli.describeInstalled("exec node '/repo/mdreview.js' \"$@\"", '/App/mdreview.js').pointsTo, 'elsewhere');
});

test('提权命令:AppleScript 字符串里的引号与反斜杠都转义;暂存目录随机、私有', () => {
  const command = Cli.privilegedInstallCommand({ tmpFile: '/tmp/x/mdreview', dir: '/usr/local/bin', target: '/usr/local/bin/mdreview' });
  assert.match(command, /^do shell script ".*" with administrator privileges$/);
  assert.match(command, /mktemp -d '\/usr\/local\/bin'\/\.mdreview-install\.XXXXXX/);
  const evil = Cli.privilegedInstallCommand({ tmpFile: EVIL, dir: '/d', target: '/d/t' });
  // AppleScript 字面量里不得有未转义的双引号提前结束字符串
  const inner = evil.slice('do shell script "'.length, evil.length - '" with administrator privileges'.length);
  assert.doesNotMatch(inner.replace(/\\\\/g, '').replace(/\\"/g, ''), /"/);
});

// 提权那一段 shell 在普通权限下对临时目录跑一遍(Codex 审查 P1/P2):预置的链接骗不到它;指向目录的链接被换成文件;真正的目录拒绝
test('提权安装脚本:指向目录的旧链接被换成文件;目标是真目录时拒绝且不留暂存;装好的内容核对得上', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-cli-priv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const victimDir = path.join(root, 'victim'); fs.mkdirSync(victimDir);
  const src = path.join(root, 'src-mdreview'); const script = Cli.launcherScript('/App/Draftback', '/App/mdreview.js'); fs.writeFileSync(src, script);
  const target = path.join(bin, 'mdreview');
  fs.symlinkSync(victimDir, target);
  // 预先放一个「固定暂存名」的链接:新脚本用随机名,不会经过它
  const victimFile = path.join(root, 'victim-file'); fs.writeFileSync(victimFile, 'keep');
  fs.symlinkSync(victimFile, path.join(bin, `.mdreview-draftback-${process.pid}`));
  execFileSync('/bin/sh', ['-c', Cli.privilegedShellScript({ tmpFile: src, dir: bin, target })]);
  assert.equal(fs.lstatSync(target).isFile(), true, '链接被换成了真正的文件');
  assert.equal(Cli.verifyInstalled(fs, target, script), true);
  assert.deepEqual(fs.readdirSync(victimDir), [], '没有把文件放进链接指向的目录');
  assert.equal(fs.readFileSync(victimFile, 'utf8'), 'keep', '预置的链接目标没被改写');
  assert.equal(fs.readdirSync(bin).some((name) => name.startsWith('.mdreview-install.')), false, '暂存目录清掉了');
  // 目标是真正的目录:拒绝
  const target2 = path.join(bin, 'mdreview-dir'); fs.mkdirSync(target2);
  assert.throws(() => execFileSync('/bin/sh', ['-c', Cli.privilegedShellScript({ tmpFile: src, dir: bin, target: target2 })], { stdio: 'pipe' }));
  assert.equal(fs.statSync(target2).isDirectory(), true);
  assert.equal(fs.readdirSync(bin).some((name) => name.startsWith('.mdreview-install.')), false, '拒绝时也不留暂存');
  assert.equal(Cli.verifyInstalled(fs, target2, script), false);
});
