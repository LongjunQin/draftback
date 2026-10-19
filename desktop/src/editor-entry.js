// 用 CrepeBuilder 按需装配功能(而非整包 Crepe):跳过 Latex,避免把 KaTeX
// 字体一并打进 vendor;其余功能与 Crepe 默认集一致。
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { toolbar } from '@milkdown/crepe/feature/toolbar';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { table } from '@milkdown/crepe/feature/table';
import { editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx, parserCtx, serializerCtx, commandsCtx, schemaCtx } from '@milkdown/kit/core';
import { replaceAll, $prose, $remark } from '@milkdown/kit/utils';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { keymap } from '@milkdown/kit/prose/keymap';
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip';
import {
  wrapInHeadingCommand, turnIntoTextCommand, toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand,
  wrapInBlockquoteCommand, wrapInBulletListCommand, wrapInOrderedListCommand, createCodeBlockCommand, insertHrCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand, insertTableCommand } from '@milkdown/kit/preset/gfm';
// 样式同样按功能逐个引入(不用聚合的 common/style.css,它会连带 KaTeX 字体)
import '@milkdown/crepe/theme/common/prosemirror.css';
import '@milkdown/crepe/theme/common/reset.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/code-mirror.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/image-block.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/toolbar.css';
import '@milkdown/crepe/theme/common/table.css';
import '@milkdown/crepe/theme/frame.css';

// 所见即所得编辑器(Milkdown Crepe):用户直接在渲染后的文档上修改,
// 保存时由编辑器把排版反推回 Markdown。对外接口与旧版 CodeMirror 入口一致,
// 但 create 返回的是句柄对象而非视图:Crepe 初始化是异步的,句柄先行占位。
function assertHandle(handle) {
  if (!handle || handle.__draftbackCrepe !== true) throw new TypeError('需要有效的 MDTurn 编辑器句柄。');
}

// ---------- 查找替换(编辑模式):在 ProseMirror 文档上找,高亮用装饰,不改正文 ----------
const findKey = new PluginKey('draftback-find');
const EMPTY_FIND = Object.freeze({ query: '', caseSensitive: false, matches: [], index: -1 });

function collectMatches(doc, query, caseSensitive) {
  const matches = [];
  if (!query) return matches;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const map = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) { for (let i = 0; i < child.text.length; i += 1) map.push(start + i); text += child.text; }
      else { map.push(start); text += '\uFFFC'; } // 行内图片、换行之类:占一个位,匹配不会跨过它
    });
    let hay = text, needle = query;
    if (!caseSensitive) {
      const lower = text.toLowerCase();
      if (lower.length === text.length) { hay = lower; needle = query.toLowerCase(); } // 大小写转换改了长度的极少数字符:按区分大小写找
    }
    for (let at = hay.indexOf(needle); at !== -1 && matches.length < 5000; at = hay.indexOf(needle, at + needle.length)) {
      matches.push({ from: map[at], to: map[at + needle.length - 1] + 1 });
    }
    return false;
  });
  return matches;
}

const findPlugin = $prose(() => new Plugin({
  key: findKey,
  state: {
    init: () => EMPTY_FIND,
    apply(tr, value, _old, newState) {
      const meta = tr.getMeta(findKey);
      if (meta) {
        if (meta.clear) return EMPTY_FIND;
        const query = meta.query !== undefined ? meta.query : value.query;
        const caseSensitive = meta.caseSensitive !== undefined ? meta.caseSensitive : value.caseSensitive;
        const matches = collectMatches(newState.doc, query, caseSensitive);
        let index = meta.index !== undefined ? meta.index : value.index;
        if (meta.after !== undefined) {
          const next = matches.findIndex((m) => m.from >= meta.after);
          index = next >= 0 ? next : 0;
        }
        if (!matches.length) index = -1; else index = Math.min(Math.max(index, 0), matches.length - 1);
        return { query, caseSensitive, matches, index };
      }
      if (tr.docChanged && value.query) {
        const matches = collectMatches(newState.doc, value.query, value.caseSensitive);
        return { ...value, matches, index: matches.length ? Math.min(Math.max(value.index, 0), matches.length - 1) : -1 };
      }
      return value;
    },
  },
  props: {
    decorations(state) {
      const value = findKey.getState(state);
      if (!value || !value.matches.length) return null;
      return DecorationSet.create(state.doc, value.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === value.index ? 'db-find-match db-find-current' : 'db-find-match' })));
    },
  },
}));

// ⌘K:插入或去掉链接(和格式条上的链接按钮是同一个命令)
const linkShortcut = $prose((ctx) => keymap({
  'Mod-k': () => { ctx.get(commandsCtx).call(toggleLinkCommand.key); return true; },
}));

// ---------- 图片:粘贴、拖入的图片交给宿主存盘(文档旁 images/),正文写相对路径 ----------
const imageUploadKey = new PluginKey('draftback-image-upload');
function imageFilesOf(list) { return Array.from(list || []).filter((file) => file && /^image\//.test(file.type)); }
// 剪贴板里有带文字的 HTML(Word、Excel、网页段落)时按原样粘贴:那张附带的图片只是排版快照,不是用户要的图
function htmlHasText(html) {
  if (!html) return false;
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  return text.length > 0;
}

function imagePastePlugin(uploadImage) {
  return $prose((ctx) => {
    const findPlaceholder = (state, id) => {
      const set = imageUploadKey.getState(state);
      const found = set ? set.find(undefined, undefined, (spec) => spec.id === id) : [];
      return found.length ? found[0].from : -1;
    };
    const insert = (view, files, pos) => {
      const id = Symbol('image-upload');
      view.dispatch(view.state.tr.setMeta(imageUploadKey, { add: { id, pos } }));
      (async () => {
        const schema = ctx.get(schemaCtx);
        const nodes = [];
        for (const file of files) {
          try {
            const src = await uploadImage(file);
            if (src) nodes.push(schema.nodes.image.createAndFill({ src, alt: '' }));
          } catch (error) { console.error('图片没能插入', error); }
        }
        if (view.isDestroyed) return; // 图片已经存好;编辑器没了就不插,用户回来再插
        const at = findPlaceholder(view.state, id);
        if (at < 0) return;
        const tr = view.state.tr.setMeta(imageUploadKey, { remove: { id } });
        if (nodes.length) tr.replaceWith(at, at, nodes);
        try { view.dispatch(tr); } catch (error) { console.warn('图片插入时编辑器已变化', error); }
      })();
    };
    return new Plugin({
      key: imageUploadKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          let next = set.map(tr.mapping, tr.doc);
          const action = tr.getMeta(imageUploadKey);
          if (action && action.add) {
            const widget = document.createElement('span');
            widget.className = 'db-image-uploading';
            widget.textContent = '正在插入图片…';
            next = next.add(tr.doc, [Decoration.widget(action.add.pos, widget, { id: action.add.id })]);
          }
          if (action && action.remove) next = next.remove(next.find(undefined, undefined, (spec) => spec.id === action.remove.id));
          return next;
        },
      },
      props: {
        decorations(state) { return imageUploadKey.getState(state); },
        handlePaste(view, event) {
          const files = imageFilesOf(event.clipboardData && event.clipboardData.files);
          if (!files.length || htmlHasText(event.clipboardData.getData('text/html'))) return false;
          insert(view, files, view.state.selection.from);
          return true;
        },
        handleDrop(view, event) {
          const files = imageFilesOf(event.dataTransfer && event.dataTransfer.files);
          if (!files.length) return false;
          const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
          insert(view, files, hit ? hit.pos : view.state.selection.from);
          return true;
        },
      },
    });
  });
}

function create(container, options = {}) {
  if (!(container instanceof Element)) throw new TypeError('create 需要一个 DOM Element 容器。');
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const uploadImage = typeof options.uploadImage === 'function' ? options.uploadImage : null;
  const resolveImageUrl = typeof options.resolveImageUrl === 'function' ? options.resolveImageUrl : (url) => url;
  const handle = {
    __draftbackCrepe: true,
    crepe: null,
    doc: String(options.doc ?? ''),
    pendingDoc: null,
    ready: false,
    destroyed: false,
  };
  const crepe = new CrepeBuilder({ root: container, defaultValue: handle.doc })
    .addFeature(cursor)
    .addFeature(listItem)
    .addFeature(linkTooltip, { inputPlaceholder: '粘贴或输入链接…' })
    .addFeature(imageBlock, {
      // 上传按钮选的图片同样存到文档旁 images/;相对路径经宿主换成可显示的地址(编辑态与阅读态看到同一张图)
      onUpload: async (file) => (uploadImage ? uploadImage(file) : ''),
      proxyDomURL: (url) => resolveImageUrl(url),
      blockUploadButton: '选择图片', blockUploadPlaceholderText: '或粘贴图片地址', blockConfirmButton: '确定',
      blockCaptionPlaceholderText: '图片说明', inlineUploadButton: '选择图片', inlineUploadPlaceholderText: '或粘贴图片地址',
    })
    .addFeature(blockEdit)
    .addFeature(placeholder, { text: '在这里书写正文……', mode: 'block' })
    .addFeature(toolbar)
    .addFeature(codeMirror)
    .addFeature(table);
  crepe.editor.config((ctx) => {
    // 反推 Markdown 时尽量贴近中文文档的常见写法,减少保存后的格式噪音
    ctx.update(remarkStringifyOptionsCtx, (current) => ({
      ...current, bullet: '-', rule: '-', fence: '`', listItemIndent: 'one',
    }));
    // 正文挂 markdown-body,让编辑态直接复用阅读态的整套排版规则
    ctx.update(editorViewOptionsCtx, (current) => ({
      ...current,
      attributes: { ...(current.attributes || {}), class: 'markdown-body' },
    }));
  });
  // 中文旁的加粗、斜体(「**设立背景。**聚变」):读入和存回都按中文放宽,与阅读页的 static/markdown-cjk.js 一致
  crepe.editor.use($remark('remarkCjkFriendly', () => remarkCjkFriendly));
  crepe.editor.use(findPlugin).use(linkShortcut);
  if (uploadImage) crepe.editor.use(imagePastePlugin(uploadImage));
  crepe.on((listener) => {
    listener.markdownUpdated((ctx, markdown, prevMarkdown) => {
      // ready 之前的事件是初始化期的规范化噪音(如补尾段落),不能算作用户修改
      if (handle.destroyed || !handle.ready || markdown === prevMarkdown) return;
      // 撤销回到打开时的样子:报原文(而不是编辑器规范化后的写法),界面才不会误报「有未保存的修改」
      const value = atBaseline(handle, ctx.get(editorViewCtx).state.doc) ? handle.baselineText : markdown;
      handle.doc = value;
      if (onChange) onChange(value);
    });
  });
  handle.crepe = crepe;
  handle.creation = crepe.create().then(() => {
    if (handle.destroyed) return crepe.destroy();
    handle.ready = true;
    markBaseline(handle);
    if (handle.pendingDoc != null) {
      const value = handle.pendingDoc;
      handle.pendingDoc = null;
      applyValue(handle, value);
    }
    return undefined;
  }).catch((error) => {
    console.error('MDTurn 编辑器初始化失败', error);
  });
  return handle;
}

// 基线:打开(或重置)那一刻的文档。没改过时对外一律给原文,改过才用编辑器序列化的写法
function markBaseline(handle) {
  handle.baselineText = handle.doc;
  handle.crepe.editor.action((ctx) => { handle.baselineDoc = ctx.get(editorViewCtx).state.doc; });
}
function atBaseline(handle, doc) { return Boolean(handle.baselineDoc && doc && doc.eq(handle.baselineDoc)); }

function applyValue(handle, value) {
  handle.doc = value;
  handle.crepe.editor.action(replaceAll(value, true));
  markBaseline(handle);
}

function setValue(handle, value) {
  assertHandle(handle);
  const nextValue = String(value ?? '');
  if (nextValue === handle.doc) return;
  if (!handle.ready) { handle.doc = nextValue; handle.pendingDoc = nextValue; return; }
  applyValue(handle, nextValue);
}

// 取当前正文:直接从编辑器现在的文档序列化,不等变更通知的 200 ms 防抖——
// 否则改完立刻 ⌘S 会存成旧内容(或被当成没改过)
function getValue(handle) {
  assertHandle(handle);
  if (!handle.ready || handle.destroyed) return handle.doc;
  try {
    return handle.crepe.editor.action((ctx) => {
      const doc = ctx.get(editorViewCtx).state.doc;
      if (atBaseline(handle, doc)) return handle.baselineText;
      const value = ctx.get(serializerCtx)(doc);
      handle.doc = value;
      return value;
    });
  } catch (_) { return handle.doc; }
}

function destroy(handle) {
  assertHandle(handle);
  handle.destroyed = true;
  if (handle.ready) { try { handle.crepe.destroy(); } catch (_) {} }
}

// 规范化基线:把一段 Markdown 走一遍"解析 → 序列化"但不做任何修改。
// 块级局部回写(static/markdown-patch.js)用它判断哪些块是编辑器自己的格式改写、哪些是用户真改了。
function normalize(handle, markdown) {
  assertHandle(handle);
  if (!handle.ready) return null;
  return handle.crepe.editor.action((ctx) => {
    const parser = ctx.get(parserCtx);
    const serializer = ctx.get(serializerCtx);
    return serializer(parser(String(markdown ?? '')));
  });
}

function focus(handle) {
  assertHandle(handle);
  if (!handle.ready) return;
  handle.crepe.editor.action((ctx) => { ctx.get(editorViewCtx).focus(); });
}

// 把一行 Markdown 源码剥成可检索的纯文本(标题井号、列表符、强调符、链接壳等)
function stripMarkdownLine(line) {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|(?:[-*+]|\d{1,3}[.)])\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

// 按"源文档第 N 行"定位:取该行(或其后首个非空行)的纯文本,在渲染文档里
// 搜到含它的段落块并滚动过去。所见即所得下没有稳定的行号映射,文本检索是
// 最稳的近似——批注和大纲都带原文引文,首行文本几乎总能命中。
function revealLine(handle, lineNumber) {
  assertHandle(handle);
  if (!handle.ready) return;
  const lines = handle.doc.split('\n');
  const bounded = Math.max(1, Math.min(lines.length, Number(lineNumber) || 1));
  let needle = '';
  for (let index = bounded - 1; index < lines.length && !needle; index += 1) {
    needle = stripMarkdownLine(lines[index]);
  }
  handle.crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    let position = null;
    if (needle) {
      view.state.doc.descendants((node, nodePosition) => {
        if (position != null) return false;
        if (node.isTextblock && node.textContent.includes(needle)) { position = nodePosition; return false; }
        return true;
      });
    }
    if (position != null) {
      const dom = view.nodeDOM(position);
      const element = dom instanceof Element ? dom : dom && dom.parentElement;
      if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    view.focus();
  });
}

// ---------- 查找替换的对外接口:返回 { count, index }(index 从 0 起,没有匹配为 -1) ----------
function findState(view) {
  const value = findKey.getState(view.state) || EMPTY_FIND;
  return { count: value.matches.length, index: value.index, query: value.query };
}
function scrollToCurrent(view) {
  const value = findKey.getState(view.state);
  if (!value || value.index < 0) return;
  const match = value.matches[value.index];
  try {
    const { node } = view.domAtPos(match.from);
    const element = node instanceof Element ? node : node && node.parentElement;
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // 代码块由 CodeMirror 自己画,看不到 ProseMirror 的命中高亮:整块闪一下提示「在这里」
    const block = element.closest('.milkdown-code-block, pre');
    if (block && view.dom.contains(block)) {
      block.classList.remove('db-find-in-block');
      void block.offsetWidth;
      block.classList.add('db-find-in-block');
      setTimeout(() => block.classList.remove('db-find-in-block'), 1400);
    }
  } catch (_) {}
}
function withView(handle, fn, fallback) {
  assertHandle(handle);
  if (!handle.ready) return fallback;
  return handle.crepe.editor.action((ctx) => fn(ctx.get(editorViewCtx)));
}
function find(handle, query, options = {}) {
  return withView(handle, (view) => {
    view.dispatch(view.state.tr.setMeta(findKey, { query: String(query || ''), caseSensitive: !!options.caseSensitive, index: 0 }));
    scrollToCurrent(view);
    return findState(view);
  }, { count: 0, index: -1, query: '' });
}
function findStep(handle, direction) {
  return withView(handle, (view) => {
    const value = findKey.getState(view.state);
    if (!value || !value.matches.length) return findState(view);
    const index = (value.index + (direction < 0 ? -1 : 1) + value.matches.length) % value.matches.length;
    view.dispatch(view.state.tr.setMeta(findKey, { index }));
    scrollToCurrent(view);
    return findState(view);
  }, { count: 0, index: -1, query: '' });
}
function replaceCurrent(handle, replacement) {
  return withView(handle, (view) => {
    const value = findKey.getState(view.state);
    if (!value || value.index < 0) return findState(view);
    const match = value.matches[value.index];
    const text = String(replacement ?? '');
    const tr = text ? view.state.tr.insertText(text, match.from, match.to) : view.state.tr.delete(match.from, match.to);
    // 替换后停在替换结束位置之后的下一处(文档变了,插件会按新文档重算匹配;不在刚换上的文字里再找)
    view.dispatch(tr.setMeta(findKey, { after: match.from + text.length }));
    scrollToCurrent(view);
    return findState(view);
  }, { count: 0, index: -1, query: '' });
}
function replaceAllMatches(handle, replacement) {
  return withView(handle, (view) => {
    const value = findKey.getState(view.state);
    if (!value || !value.matches.length) return { replaced: 0, ...findState(view) };
    const text = String(replacement ?? '');
    let tr = view.state.tr;
    for (let i = value.matches.length - 1; i >= 0; i -= 1) {
      const match = value.matches[i];
      tr = text ? tr.insertText(text, match.from, match.to) : tr.delete(match.from, match.to);
    }
    view.dispatch(tr.setMeta(findKey, { index: 0 }));
    return { replaced: value.matches.length, ...findState(view) };
  }, { replaced: 0, count: 0, index: -1, query: '' });
}
function clearFind(handle) {
  return withView(handle, (view) => { view.dispatch(view.state.tr.setMeta(findKey, { clear: true })); return true; }, false);
}
// ---------- 格式菜单(菜单栏「格式」与对应快捷键):按名字跑编辑器命令 ----------
function toggleTaskItem(view) {
  // 任务列表 = 无序列表项带 checked 属性;已经是任务项就去掉勾选框
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'list_item') {
      const pos = $from.before(depth);
      const checked = node.attrs.checked == null ? false : null;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked }));
      return true;
    }
  }
  return false;
}
function runFormat(handle, name) {
  assertHandle(handle);
  if (!handle.ready) return false;
  return handle.crepe.editor.action((ctx) => {
    const commands = ctx.get(commandsCtx);
    const view = ctx.get(editorViewCtx);
    const heading = /^h([1-6])$/.exec(name);
    let ok = false;
    if (heading) ok = commands.call(wrapInHeadingCommand.key, Number(heading[1]));
    else if (name === 'paragraph') ok = commands.call(turnIntoTextCommand.key);
    else if (name === 'bold') ok = commands.call(toggleStrongCommand.key);
    else if (name === 'italic') ok = commands.call(toggleEmphasisCommand.key);
    else if (name === 'strike') ok = commands.call(toggleStrikethroughCommand.key);
    else if (name === 'code') ok = commands.call(toggleInlineCodeCommand.key);
    else if (name === 'link') ok = commands.call(toggleLinkCommand.key);
    else if (name === 'quote') ok = commands.call(wrapInBlockquoteCommand.key);
    else if (name === 'bullet') ok = commands.call(wrapInBulletListCommand.key);
    else if (name === 'ordered') ok = commands.call(wrapInOrderedListCommand.key);
    else if (name === 'task') {
      if (!toggleTaskItem(view)) { commands.call(wrapInBulletListCommand.key); ok = toggleTaskItem(view); } else ok = true;
    }
    else if (name === 'table') ok = commands.call(insertTableCommand.key, { row: 3, col: 3 });
    else if (name === 'codeblock') ok = commands.call(createCodeBlockCommand.key);
    else if (name === 'hr') ok = commands.call(insertHrCommand.key);
    view.focus();
    return ok;
  });
}

function selectedText(handle) {
  return withView(handle, (view) => {
    const { from, to } = view.state.selection;
    return from === to ? '' : view.state.doc.textBetween(from, to, '\n');
  }, '');
}

Object.defineProperty(window, 'DraftbackEditor', {
  value: Object.freeze({ create, setValue, getValue, destroy, focus, revealLine, normalize, find, findStep, replaceCurrent, replaceAllMatches, clearFind, selectedText, runFormat }),
  configurable: false,
  enumerable: true,
  writable: false,
});
