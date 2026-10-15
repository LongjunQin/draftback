'use strict';
// 命令行工具 mdreview 的安装脚本内容(设置 › 命令行工具)。纯函数,主进程用,也单独测。
// 路径一律用 shell 单引号转义:单引号里 $()、反引号、变量都不展开;交给 AppleScript 的字符串再按它的规则转义。

function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function appleScriptString(value) { return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

/** 启动脚本:用 App 自带的运行时跑 mdreview.js(ELECTRON_RUN_AS_NODE),用户电脑上不必另装 Node */
function launcherScript(execPath, scriptPath) {
  return [
    '#!/bin/bash',
    '# 回稿(Draftback)审阅命令:由回稿「设置 › 命令行工具」安装,指向 App 自带的 mdreview.js',
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(scriptPath)} "$@"`,
    '',
  ].join('\n');
}

/** 已装的 mdreview 指向哪里:this-app / elsewhere / unknown */
function describeInstalled(text, targetScript) {
  const body = String(text || '');
  const match = /["']([^"']*mdreview\.js)["']/.exec(body);
  const mine = body.includes(shellQuote(targetScript)) || body.includes(JSON.stringify(targetScript));
  const pointsTo = mine ? 'this-app' : /mdreview\.js/.test(body) ? 'elsewhere' : 'unknown';
  return { pointsTo, target: match ? match[1] : null };
}

/**
 * 提权安装时交给 osascript 的那一句。在目标目录里由提权进程自己用 mktemp -d 建一个随机、私有的暂存目录
 * (不用固定名字:别人预先放好的同名链接骗不到它),写好后先删掉旧的目录项(rm 删的是链接本身,不跟着链接走),
 * 再改名放到位;目标若是真正的目录就拒绝。
 */
function privilegedShellScript({ tmpFile, dir, target }) {
  const T = shellQuote(target);
  return [
    'set -e',
    `mkdir -p ${shellQuote(dir)}`,
    `d=$(mktemp -d ${shellQuote(dir)}/.mdreview-install.XXXXXX)`,
    `cp ${shellQuote(tmpFile)} "$d/mdreview"`,
    'chmod 755 "$d/mdreview"',
    `if [ -d ${T} ] && [ ! -L ${T} ]; then rm -rf "$d"; echo 'mdreview 的位置是一个目录' >&2; exit 3; fi`,
    `rm -f ${T}`,
    `mv -f "$d/mdreview" ${T}`,
    'rmdir "$d"',
  ].join('; ');
}
function privilegedInstallCommand(options) {
  return `do shell script ${appleScriptString(privilegedShellScript(options))} with administrator privileges`;
}

/** 装好以后核对:目标是普通文件(不是链接或目录),内容就是这份启动脚本 */
function verifyInstalled(fs, target, script) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) return false;
    return fs.readFileSync(target, 'utf8') === script;
  } catch { return false; }
}

module.exports = { shellQuote, appleScriptString, launcherScript, describeInstalled, privilegedShellScript, privilegedInstallCommand, verifyInstalled };
