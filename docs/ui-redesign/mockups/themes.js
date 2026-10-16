// 方案 C 的皮面颜色候选(参考 iPhone 配色)。C-colors.html 和 C-themes.html 共用。
// c1 → c2:皮面从上到下的颜色;ink:皮面上的字(浅色皮用深色字);shade:阴影和压痕的颜色(r,g,b)。
const THEMES = [
  { group: 'iPhone 17', name: '青雾蓝', c1: '#8ba3b7', c2: '#7891a6', shade: '20,35,50' },
  { group: 'iPhone 17', name: '鼠尾草绿', c1: '#9fb099', c2: '#879983', shade: '30,48,28' },
  { group: 'iPhone 17', name: '薰衣草紫', c1: '#ab9fc5', c2: '#958aaf', shade: '45,35,72' },
  { group: 'iPhone Air', name: '天蓝', c1: '#bcd6e9', c2: '#a5c3da', shade: '30,62,92', ink: '#2c4a66' },
  { group: 'iPhone Air', name: '浅金', c1: '#e6d6b6', c2: '#d3bf98', shade: '92,70,30', ink: '#5e4a28' },
  { group: 'iPhone Air', name: '深空黑', c1: '#414145', c2: '#2c2c30', shade: '0,0,0' },
  { group: 'iPhone 17 Pro', name: '星宇橙', c1: '#e4824a', c2: '#cd6a33', shade: '100,40,10' },
  { group: 'iPhone 17 Pro', name: '深蓝', c1: '#4b5b76', c2: '#39475f', shade: '8,18,38' },
  { group: 'iPhone 17 Pro', name: '银色', c1: '#e4e4e2', c2: '#d0d0cd', shade: '40,42,46', ink: '#44474c' },
  { group: 'iPhone 16', name: '群青', c1: '#7e87cc', c2: '#6971b8', shade: '28,30,92' },
  { group: 'iPhone 16', name: '深青', c1: '#80b6af', c2: '#6aa099', shade: '18,60,55' },
  { group: 'iPhone 16', name: '粉色', c1: '#ebbac7', c2: '#dca3b3', shade: '110,40,60', ink: '#7a3a4e' },
];

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
