// 方案 C 的封面颜色(用户 2026-10-16 定 6 种;2026-10-17 改:默认淡绿,鼠尾草绿拿掉)。所有效果图和 App 图标共用。
// c1 → c2:皮面从上到下的颜色;ink:皮面上的字(浅色皮用深色字);shade:阴影和压痕的颜色(r,g,b)。
const THEMES = [
  { id: 'green', name: '淡绿', from: 'iPhone 15 一类的淡绿', c1: '#d3e2c6', c2: '#bfd2b0', shade: '50,70,40', ink: '#3d4a33' },
  { id: 'mist', name: '青雾蓝', from: 'iPhone 17', c1: '#8ba3b7', c2: '#7891a6', shade: '20,35,50' },
  { id: 'lavender', name: '薰衣草紫', from: 'iPhone 17', c1: '#ab9fc5', c2: '#958aaf', shade: '45,35,72' },
  { id: 'gold', name: '浅金', from: 'iPhone Air', c1: '#e6d6b6', c2: '#d3bf98', shade: '92,70,30', ink: '#5e4a28' },
  { id: 'orange', name: '星宇橙', from: 'iPhone 17 Pro', c1: '#e4824a', c2: '#cd6a33', shade: '100,40,10' },
  { id: 'black', name: '深空黑', from: 'iPhone Air', c1: '#414145', c2: '#2c2c30', shade: '0,0,0' },
];
const themeById = (id) => THEMES.find((t) => t.id === id);

// 把一种皮色写成 CSS 变量,挂在外层元素的 style 上
function themeVars(t) {
  const dark = Boolean(t.ink);
  return [
    `--c1: ${t.c1}`, `--c2: ${t.c2}`, `--shade: ${t.shade}`,
    `--ink: ${t.ink || '#f7f9fb'}`,
    `--ink-soft: ${dark ? t.ink + 'c4' : 'rgba(247,249,251,.82)'}`,
    `--ink-shadow: ${dark ? '0 1px 0 rgba(255,255,255,.35)' : `0 1px 1px rgba(${t.shade},.35)`}`,
  ].join('; ');
}
