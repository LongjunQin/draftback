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

test('提权命令:AppleScript 字符串里的引号与反斜杠都转义;先写同目录临时名再改名', () => {
  const command = Cli.privilegedInstallCommand({ tmpFile: '/tmp/x/mdreview', dir: '/usr/local/bin', staged: '/usr/local/bin/.mdreview-tmp', target: '/usr/local/bin/mdreview' });
  assert.match(command, /^do shell script ".*" with administrator privileges$/);
  assert.match(command, /mv -f '\/usr\/local\/bin\/\.mdreview-tmp' '\/usr\/local\/bin\/mdreview'/);
  const evil = Cli.privilegedInstallCommand({ tmpFile: EVIL, dir: '/d', staged: '/d/s', target: '/d/t' });
  // AppleScript 字面量里不得有未转义的双引号提前结束字符串
  const inner = evil.slice('do shell script "'.length, evil.length - '" with administrator privileges'.length);
  assert.doesNotMatch(inner.replace(/\\\\/g, '').replace(/\\"/g, ''), /"/);
});
