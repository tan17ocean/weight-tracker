// 主题机制：与个人主页完全一致 —— localStorage key 为 blog-theme，
// 通过 document.documentElement[data-theme] 控制。同域（github.io 主域 + weight-tracker 子路径）
// 天然共用该 key，个人主页切换主题时体重站自动联动。
const KEY = 'blog-theme'

function apply(theme) {
  const el = document.documentElement
  if (theme === 'dark' || theme === 'light') {
    el.setAttribute('data-theme', theme)
  } else if (theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    el.setAttribute('data-theme', dark ? 'dark' : 'light')
  }
}

export function getTheme() {
  let t = null
  try { t = localStorage.getItem(KEY) } catch (e) { /* ignore */ }
  if (t !== 'light' && t !== 'dark' && t !== 'system') t = 'system'
  return t
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme) } catch (e) { /* ignore */ }
  apply(theme)
}

export function initTheme() {
  apply(getTheme())
  // 同域其他标签页（个人主页）切换主题时联动
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) apply(e.newValue || 'system')
  })
  // system 模式下跟随系统变化
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system') apply('system')
  })
  return getTheme()
}