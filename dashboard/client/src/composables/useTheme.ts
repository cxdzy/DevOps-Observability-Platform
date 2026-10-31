import { ref } from 'vue'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'theme'

function savedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// The class goes on <html> before the ref changes, so anything that reads colours from CSS
// when the ref changes (the chart) already sees the new theme.
function apply(value: Theme) {
  const root = document.documentElement
  root.classList.toggle('dark', value === 'dark')
  root.style.colorScheme = value
}

// One shared theme for the whole app. public/theme-init.js has already set the class on load.
const theme = ref<Theme>(savedTheme() ?? systemTheme())
apply(theme.value)

// Until the user picks a theme, follow the browser setting.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (savedTheme()) return
  const next = systemTheme()
  apply(next)
  theme.value = next
})

function toggle() {
  const next: Theme = theme.value === 'dark' ? 'light' : 'dark'
  apply(next)
  theme.value = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Without storage the choice lasts until the page is reloaded.
  }
}

export function useTheme() {
  return { theme, toggle }
}
