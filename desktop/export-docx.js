'use strict';
/*
 * 导出 Word(.docx):交给 pandoc 转换。
 * 为什么用 pandoc:公式变成 Word 原生可编辑公式(不是图片),表格、脚注、代码块、图片都按 Word 的结构落地,
 * 这是自写转换器短期做不到的保真度。代价是用户机器上要装 pandoc(brew install pandoc);
 * 自用阶段可以接受,公开版再决定是随 App 附带 pandoc 还是改用纯 JS 转换器(路线图第四轮)。
 *
 * 读入按 GitHub 风格 Markdown 加三项扩展:$ 公式、中文行尾不插空格(east_asian_line_breaks)、
 * 文件头的 YAML 元数据块(作为标题等信息,不作为正文)。图片相对路径以源文件所在目录解析。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const INPUT_FORMAT = 'gfm+tex_math_dollars+east_asian_line_breaks+yaml_metadata_block+footnotes';

function findPandoc() {
  const candidates = [
    process.env.MDTURN_PANDOC,
    '/opt/homebrew/bin/pandoc',
    '/usr/local/bin/pandoc',
    '/usr/bin/pandoc',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  const pathEntries = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of pathEntries) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: options.timeout || 120000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').trim();
        reject(new Error(detail || 'pandoc 执行失败'));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * 把 sourcePath(.md)转成 outputPath(.docx)。resourceDir 默认为源文件目录,用来解析图片相对路径。
 */
async function exportDocx({ sourcePath, outputPath, resourceDir, pandoc } = {}) {
  if (!sourcePath || !path.isAbsolute(sourcePath)) throw new Error('缺少源文件的绝对路径。');
  if (!outputPath || !/\.docx$/i.test(outputPath)) throw new Error('输出路径必须以 .docx 结尾。');
  const bin = pandoc || findPandoc();
  if (!bin) {
    const error = new Error('没有找到 pandoc,无法导出 Word。安装:brew install pandoc');
    error.code = 'NO_PANDOC';
    throw error;
  }
  const args = [
    sourcePath, '-o', outputPath,
    '--from', INPUT_FORMAT, '--to', 'docx',
    '--resource-path', resourceDir || path.dirname(sourcePath),
    '--wrap', 'none',
  ];
  await run(bin, args);
  const stat = fs.statSync(outputPath);
  return { ok: true, filePath: outputPath, bytes: stat.size, pandoc: bin };
}

module.exports = { findPandoc, exportDocx, INPUT_FORMAT };
