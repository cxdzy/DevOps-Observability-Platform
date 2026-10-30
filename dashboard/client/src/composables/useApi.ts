import axios from 'axios'
import { onMounted, onUnmounted } from 'vue'

export const api = axios.create({ timeout: 10000 })

// Runs load on mount and then every intervalMs. A tick is skipped while the previous
// load is still running. refresh() asks for a reload now, or right after the current one.
export function usePoll(load: () => Promise<void>, intervalMs: number) {
  let timer: number | undefined
  let running = false
  let queued = false

  async function run(force = false) {
    if (running) {
      if (force) queued = true
      return
    }
    running = true
    try {
      await load()
    } finally {
      running = false
    }
    if (queued) {
      queued = false
      run()
    }
  }

  onMounted(() => {
    run()
    timer = window.setInterval(() => run(), intervalMs)
  })
  onUnmounted(() => window.clearInterval(timer))

  return { refresh: () => run(true) }
}
