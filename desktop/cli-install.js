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

/** 提权安装时交给 osascript 的那一句:写到同目录临时名再改名替换(不顺着旧符号链接改写别人的文件) */
function privilegedInstallCommand({ tmpFile, dir, staged, target }) {
  const command = `mkdir -p ${shellQuote(dir)} && cp ${shellQuote(tmpFile)} ${shellQuote(staged)} && chmod 755 ${shellQuote(staged)} && mv -f ${shellQuote(staged)} ${shellQuote(target)}`;
  return `do shell script ${appleScriptString(command)} with administrator privileges`;
}

module.exports = { shellQuote, appleScriptString, launcherScript, describeInstalled, privilegedInstallCommand };
