import { createApp } from 'vue'
import App from './App.vue'
// Bundled fonts, latin only: the Content Security Policy allows fonts from this site only.
import '@fontsource/geist/latin-400.css'
import '@fontsource/geist/latin-500.css'
import '@fontsource/geist/latin-600.css'
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import './style.css'

// Stale chunks. A tab left open across a deploy still runs the old main bundle, whose lazily loaded
// chunks (charts, Evaluation, Drift) were replaced by the deploy, so the first import of one fails.
// Reloading fetches the new bundle. It reloads at most once a minute, guarded by a timestamp in
// sessionStorage, so a chunk that is really missing cannot cause a reload loop.
const RELOAD_KEY = 'stale-chunk-reload-at'
const RELOAD_GUARD_MS = 60_000
function reloadOnceForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
    if (Date.now() - last < RELOAD_GUARD_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    // Without sessionStorage there is no guard, so do not reload at all.
    return false
  }
  window.location.reload()
  return true
}
// The browser's wording for a failed dynamic import differs: Chrome, Firefox and Safari.
const STALE_IMPORT = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i
function isStaleImport(err: unknown): boolean {
  return STALE_IMPORT.test(err instanceof Error ? err.message : String(err ?? ''))
}

// Vite fires this when it cannot preload a chunk; preventDefault stops it rethrowing after a reload.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnceForStaleChunk()) event.preventDefault()
})
// A view loaded with defineAsyncComponent reports a failed import through the app error handler,
// and a plain import() that nobody catches ends up as an unhandled rejection.
window.addEventListener('unhandledrejection', (event) => {
  if (isStaleImport(event.reason)) reloadOnceForStaleChunk()
})

const app = createApp(App)
app.config.errorHandler = (err, _instance, info) => {
  if (isStaleImport(err) && reloadOnceForStaleChunk()) return
  console.error(err, info)
}
app.mount('#app')
