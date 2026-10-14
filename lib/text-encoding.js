'use strict';
// 文档正文解码:MDTurn 只会写 UTF-8。不是 UTF-8 的文件(GBK、UTF-16)照样能看,但只读——
// 以前按 UTF-8 硬读会得到一串乱码,用户一保存乱码就覆盖了原文。

const BOM_UTF8 = [0xef, 0xbb, 0xbf];

function tryDecode(buffer, label, ignoreBOM) {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * @returns {{ content: string, encoding: string, readOnly: boolean, reason: string|null }}
 *   encoding:'utf-8' 可写;'gbk' / 'utf-16le' / 'utf-16be' / 'unknown' 只读
 */
function decodeText(buffer) {
  if (!buffer || !buffer.length) return { content: '', encoding: 'utf-8', readOnly: false, reason: null };
  // 保留 UTF-8 BOM 字符(与此前 buffer.toString('utf8') 行为一致,指纹按字节算不受影响)
  const utf8 = tryDecode(buffer, 'utf-8', true);
  if (utf8 !== null) return { content: utf8, encoding: 'utf-8', readOnly: false, reason: null };
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const text = tryDecode(buffer, 'utf-16le', false);
    if (text !== null) return { content: text, encoding: 'utf-16le', readOnly: true, reason: '文件是 UTF-16 编码' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const text = tryDecode(buffer, 'utf-16be', false);
    if (text !== null) return { content: text, encoding: 'utf-16be', readOnly: true, reason: '文件是 UTF-16 编码' };
  }
  const gbk = tryDecode(buffer, 'gbk', false);
  if (gbk !== null) return { content: gbk, encoding: 'gbk', readOnly: true, reason: '文件是 GBK 编码' };
  return { content: buffer.toString('utf8'), encoding: 'unknown', readOnly: true, reason: '文件不是 UTF-8 编码,无法识别' };
}

function readOnlyMessage(decoded) {
  return `${decoded.reason || '文件不是 UTF-8 编码'}。MDTurn 只按原样显示,不会改写它;要编辑请先用其他工具另存为 UTF-8。`;
}

module.exports = { decodeText, readOnlyMessage, BOM_UTF8 };
