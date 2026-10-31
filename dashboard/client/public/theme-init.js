// Runs before the app loads so the page never flashes the wrong theme. Kept as a separate file
// because the Content Security Policy blocks inline scripts. useTheme.ts applies the same rule.
(function () {
  var saved = null
  try {
    saved = window.localStorage.getItem('theme')
  } catch (e) {
    saved = null
  }
  var dark = saved === 'dark' || saved === 'light'
    ? saved === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches
  var root = document.documentElement
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
})()
