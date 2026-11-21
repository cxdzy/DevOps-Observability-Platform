import type { Ref } from 'vue'
import axios from 'axios'
import { onMounted, onUnmounted, ref, watch } from 'vue'

export const api = axios.create({ timeout: 10000 })

// A 401 from any data call means the session ended; the auth state shows the login page.
// The /auth calls handle their own 401s.
let unauthorizedHandler: (() => void) | null = null
export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler
}
api.interceptors.response.use(undefined, (error) => {
  const url: string = error?.config?.url ?? ''
  if (error?.response?.status === 401 && !url.startsWith('/auth/')) unauthorizedHandler?.()
  return Promise.reject(error)
})

// Runs load on mount and then every intervalMs while enabled is true. A tick is skipped
// while the previous load is still running. refresh() asks for a reload now, or right after
// the current one. Becoming enabled again loads at once.
export function usePoll(load: () => Promise<void>, intervalMs: number, enabled: Ref<boolean> = ref(true)) {
  let timer: number | undefined
  let running = false
  let queued = false

  async function run(force = false) {
    if (!enabled.value) return
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

  watch(enabled, (on) => {
    if (on) run(true)
  })

  onMounted(() => {
    run()
    timer = window.setInterval(() => run(), intervalMs)
  })
  onUnmounted(() => window.clearInterval(timer))

  return { refresh: () => run(true) }
}

// POST /api/chat with the chat's follow-up context. A failed call rejects with { status, data }
// (status 0 when there was no response), the shape the chat store reads.
export const CHAT_TIMEOUT_MS = 100000
export async function postChat<T>(message: string, context: unknown): Promise<T> {
  try {
    const { data } = await api.post<T>('/api/chat', { message, context }, { timeout: CHAT_TIMEOUT_MS })
    return data
  } catch (err) {
    if (axios.isAxiosError(err)) {
      throw { status: err.response?.status ?? 0, data: err.response?.data ?? null, retryAfter: err.response?.headers?.['retry-after'] ?? null }
    }
    throw { status: 0, data: null }
  }
}
