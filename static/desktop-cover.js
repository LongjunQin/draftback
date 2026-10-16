/*
 * 封面颜色(方案 C 的 6 种皮面颜色)在第一次绘制前就位:读上次的选择,挂到 <html data-cover>。
 * 真正的设置存在 Electron 的 settings.json(desktop.js 读到后会再挂一次并更新这里的缓存);这里只是避免先闪一下默认色。
 */
(function () {
  'use strict';
  var COVERS = ['mist', 'sage', 'lavender', 'gold', 'orange', 'black'];
  try {
    var saved = localStorage.getItem('draftback.cover');
    if (saved && COVERS.indexOf(saved) >= 0) document.documentElement.dataset.cover = saved;
  } catch (_) { /* 本地存储不可用时用默认的青雾蓝 */ }
}());
