/* 中日韩文字旁的强调(加粗、斜体):让「**设立背景。**聚变」这样的写法正常加粗。
 *
 * CommonMark 规定:收尾的 ** 前面是标点、后面紧跟文字时,不算收尾(开头同理)。英文里标点后总有空格,
 * 不受影响;中文标点后不空格,结果整段显示成星号。这里按 markdown-cjk-friendly 的思路放宽:
 * 标点另一侧挨着中日韩文字时,也算能开始 / 收尾。其他文字照 CommonMark 不变。
 * 用法:markdownit().use(window.draftbackCjkEmphasis)。Mac 与手机共用这一份(ios/scripts/sync-web.sh 拷过去)。
 */
(function (root) {
  'use strict';

  // 中日韩文字与全角标点:谚文字母、CJK 部首到统一汉字(含假名、注音、CJK 标点)、谚文音节、兼容汉字、竖排与全角形式、扩展 B 以后
  function isCjk(code) {
    return (code >= 0x1100 && code <= 0x11ff) || (code >= 0x2e80 && code <= 0x9fff)
      || (code >= 0xa960 && code <= 0xa97f) || (code >= 0xac00 && code <= 0xd7ff)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe1f)
      || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x20000 && code <= 0x3ffff);
  }

  function codeBefore(src, pos) {
    if (pos === 0) return 0x20;
    const low = src.charCodeAt(pos - 1);
    if ((low & 0xfc00) === 0xdc00 && pos >= 2) {
      const high = src.charCodeAt(pos - 2);
      if ((high & 0xfc00) === 0xd800) return 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
    }
    return (low & 0xf800) === 0xd800 ? 0xfffd : low;
  }

  function codeAt(src, pos, max) {
    if (pos >= max) return 0x20;
    const high = src.charCodeAt(pos);
    if ((high & 0xfc00) === 0xd800) {
      const low = src.charCodeAt(pos + 1);
      return (low & 0xfc00) === 0xdc00 ? 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00) : 0xfffd;
    }
    return (high & 0xf800) === 0xd800 ? 0xfffd : high;
  }

  function draftbackCjkEmphasis(md) {
    const State = md.inline.State;
    if (State.prototype.draftbackCjkEmphasis) return;
    const { isWhiteSpace, isMdAsciiPunct } = md.utils;
    const isPunct = (code) => isMdAsciiPunct(code)
      || (md.utils.isPunctCharCode ? md.utils.isPunctCharCode(code) : md.utils.isPunctChar(String.fromCodePoint(code)));
    // 与 markdown-it 的 scanDelims 相同,只在两处判断里多认「另一侧是中日韩文字」
    State.prototype.scanDelims = function scanDelims(start, canSplitWord) {
      const max = this.posMax;
      const marker = this.src.charCodeAt(start);
      const last = codeBefore(this.src, start);
      let pos = start;
      while (pos < max && this.src.charCodeAt(pos) === marker) pos += 1;
      const next = codeAt(this.src, pos, max);
      const lastPunct = isPunct(last);
      const nextPunct = isPunct(next);
      const lastSpace = isWhiteSpace(last);
      const nextSpace = isWhiteSpace(next);
      const leftFlanking = !nextSpace && (!nextPunct || lastSpace || lastPunct || isCjk(last));
      const rightFlanking = !lastSpace && (!lastPunct || nextSpace || nextPunct || isCjk(next));
      return {
        can_open: leftFlanking && (canSplitWord || !rightFlanking || lastPunct),
        can_close: rightFlanking && (canSplitWord || !leftFlanking || nextPunct),
        length: pos - start,
      };
    };
    State.prototype.draftbackCjkEmphasis = true;
  }

  if (typeof module === 'object' && module.exports) module.exports = draftbackCjkEmphasis;
  else root.draftbackCjkEmphasis = draftbackCjkEmphasis;
})(typeof window !== 'undefined' ? window : globalThis);
