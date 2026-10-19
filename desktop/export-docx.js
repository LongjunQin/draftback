'use strict';
/*
 * 导出 Word(.docx):交给 pandoc 转换。
 * 为什么用 pandoc:公式变成 Word 原生可编辑公式(不是图片),表格、脚注、代码块、图片都按 Word 的结构落地,
 * 这是自写转换器短期做不到的保真度。代价是用户机器上要装 pandoc(brew install pandoc);
 * 自用阶段可以接受,公开版再决定是随 App 附带 pandoc 还是改用纯 JS 转换器(路线图第四轮)。
 *
 * 读入按 GitHub 风格 Markdown 加三项扩展:$ 公式、中文行尾不插空格(east_asian_line_breaks)、
 * 文件头的 YAML 元数据块(作为标题等信息,不作为正文)。图片相对路径以源文件所在目录解析。
 *
 * 中文旁的加粗:「**设立背景。**聚变」按 GitHub 风格 Markdown 不算加粗,星号会原样进 Word。
 * 交给 pandoc 之前,把这种加粗边上的标点挪到星号外面(「**设立背景**。聚变」),只改临时副本,不动原文。
 * 阅读页用 static/markdown-cjk.js 解决同一个问题。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const INPUT_FORMAT = 'gfm+tex_math_dollars+east_asian_line_breaks+yaml_metadata_block+footnotes';

const CJK = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-퟿豈-﫿︐-︟︰-﹏＀-￯\u{20000}-\u{3ffff}]/u;
const SPACE_OR_PUNCT = /[\s\p{P}\p{S}]/u;

function fixCjkEmphasisLine(line) {
  if (!line.includes('**')) return line;
  // 行内代码与行内公式里的星号不算
  const masked = line.replace(/(`+)[^`]*?\1|\$[^$\n]+\$/g, (match) => '\0'.repeat(match.length));
  const marks = [];
  for (let i = 0; i + 1 < masked.length; i += 1) {
    if (masked[i] !== '*' || masked[i + 1] !== '*') continue;
    if (masked[i - 1] === '*' || masked[i + 2] === '*' || masked[i - 1] === '\\') { i += 1; continue; }
    marks.push(i);
    i += 1;
  }
  let out = line;
  // 按出现顺序两两配对;从后往前改,前面的位置不变
  for (let k = marks.length - (marks.length % 2) - 2; k >= 0; k -= 2) {
    const open = marks[k];
    const close = marks[k + 1];
    const inner = out.slice(open + 2, close);
    if (!inner || /^\s|\s$/.test(inner)) continue;
    const before = Array.from(out.slice(Math.max(0, open - 2), open)).pop() || '';
    const after = Array.from(out.slice(close + 2, close + 4))[0] || '';
    if (!CJK.test(inner) && !CJK.test(before) && !CJK.test(after)) continue;
    const trail = after && !SPACE_OR_PUNCT.test(after) ? (/[\p{P}\p{S}]+$/u.exec(inner) || [''])[0] : '';
    const lead = before && !SPACE_OR_PUNCT.test(before) ? (/^[\p{P}\p{S}]+/u.exec(inner) || [''])[0] : '';
    const core = inner.slice(lead.length, inner.length - trail.length);
    if ((!lead && !trail) || !core) continue;
    out = `${out.slice(0, open)}${lead}**${core}**${trail}${out.slice(close + 2)}`;
  }
  return out;
}

// 跳过文件头元数据、代码块、$$ 公式块,逐行整理
function fixCjkEmphasis(markdown) {
  const lines = markdown.split('\n');
  let fence = null;
  let math = false;
  let start = 0;
  if (lines[0] === '---') {
    const end = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'));
    if (end > 0) start = end + 1;
  }
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]; continue; }
    if (/^\s*\$\$/.test(line)) {
      if (!(/^\s*\$\$.*\$\$\s*$/.test(line) && line.trim().length > 4)) math = !math;
      continue;
    }
    if (math) continue;
    lines[i] = fixCjkEmphasisLine(line);
  }
  return lines.join('\n');
}

function findPandoc() {
  // 从 Finder 启动的 App 只有极简 PATH,常见安装位置要自己列全:Homebrew(Apple 芯片 / Intel)、MacPorts、pip/cabal 用户目录
  const home = require('os').homedir();
  const candidates = [
    process.env.DRAFTBACK_PANDOC,
    '/opt/homebrew/bin/pandoc',
    '/usr/local/bin/pandoc',
    '/opt/local/bin/pandoc',
    path.join(home, '.local', 'bin', 'pandoc'),
    path.join(home, '.cabal', 'bin', 'pandoc'),
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
  // 只有 UTF-8 能原样读回时才整理;要整理就写临时副本,原文不动
  // 读不出来就原样交给 pandoc,由它报错
  let text = '';
  let fixed = '';
  try {
    const raw = fs.readFileSync(sourcePath);
    text = raw.toString('utf8');
    fixed = Buffer.from(text, 'utf8').equals(raw) ? fixCjkEmphasis(text) : text;
  } catch {}
  let input = sourcePath;
  let tempDir = null;
  if (fixed !== text) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'draftback-docx-'));
    input = path.join(tempDir, path.basename(sourcePath));
    fs.writeFileSync(input, fixed);
  }
  const args = [
    input, '-o', outputPath,
    '--from', INPUT_FORMAT, '--to', 'docx',
    '--resource-path', resourceDir || path.dirname(sourcePath),
    '--wrap', 'none',
  ];
  try {
    await run(bin, args);
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  const stat = fs.statSync(outputPath);
  return { ok: true, filePath: outputPath, bytes: stat.size, pandoc: bin };
}

module.exports = { findPandoc, exportDocx, fixCjkEmphasis, INPUT_FORMAT };
