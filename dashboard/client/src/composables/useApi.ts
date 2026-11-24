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
// A 403 with this code means the user still has an admin-set temporary password; the auth state
// then shows the Change password page. Other 403s (a viewer on an admin route) are left alone.
export const PASSWORD_CHANGE_REQUIRED = 'password_change_required'
let passwordChangeHandler: (() => void) | null = null
export function onPasswordChangeRequired(handler: () => void) {
  passwordChangeHandler = handler
}
api.interceptors.response.use(undefined, (error) => {
  const url: string = error?.config?.url ?? ''
  if (error?.response?.status === 401 && !url.startsWith('/auth/')) unauthorizedHandler?.()
  if (error?.response?.status === 403 && error?.response?.data?.code === PASSWORD_CHANGE_REQUIRED) passwordChangeHandler?.()
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

// ---- Forecast (GET /api/forecast). Every value can be null when the data does not have it.
export type ForecastState = 'ok' | 'no_limit' | 'not_enough_data' | 'warning' | 'restarting' | 'no_data'
export interface ContainerForecast {
  server: string
  server_name: string
  project: string
  container: string
  state: ForecastState
  reason: string | null
  est_minutes: number | null
  limit_mb: number | null
  level_mb: number | null
  slope_mb_per_min: number | null
  r2: number | null
  restarts: number | null
  oom: boolean | null
  since: string | null
  updated_at: string | null
}
export interface DiskForecast {
  server: string
  server_name: string
  mountpoint: string
  state: ForecastState
  reason: string | null
  est_hours: number | null
  used_pct: number | null
  slope_pct_per_hour: number | null
  r2: number | null
  since: string | null
  updated_at: string | null
}
export interface ForecastInfo {
  last_run_at: string | null
  containers: ContainerForecast[]
  disks: DiskForecast[]
}
export async function getForecast(): Promise<ForecastInfo> {
  const { data } = await api.get<ForecastInfo>('/api/forecast')
  if (!data || !Array.isArray(data.containers) || !Array.isArray(data.disks)) throw new Error('unexpected response')
  return data
}

// ---- Delete and restore in Settings (servers and projects). Delete needs the exact name.
export type RegistryKind = 'servers' | 'projects'
export interface DeletePreview {
  name: string
  status: string
  // Projects: the server name and what goes with the project. Servers: the projects still on it.
  serverName: string | null
  deployments: number
  links: number
  images: number
  projects: string[]
}
export async function getDeletePreview(kind: RegistryKind, key: string): Promise<DeletePreview> {
  const { data } = await api.get<Record<string, unknown>>(`/api/settings/${kind}/${encodeURIComponent(key)}/delete-preview`)
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  return {
    name: typeof data?.name === 'string' ? data.name : key,
    status: typeof data?.status === 'string' ? data.status : '',
    serverName: typeof data?.server_name === 'string' ? data.server_name : null,
    deployments: n(data?.deployments),
    links: n(data?.links),
    images: n(data?.images),
    projects: Array.isArray(data?.projects) ? data.projects.filter((p): p is string => typeof p === 'string') : [],
  }
}
// Resolves with the server's sentence about the targets file when it could not be written, else null.
export async function deleteRegistryItem(kind: RegistryKind, key: string, name: string): Promise<string | null> {
  const { data } = await api.post<{ targets_error?: string | null }>(`/api/settings/${kind}/${encodeURIComponent(key)}/delete`, { name })
  return typeof data?.targets_error === 'string' ? data.targets_error : null
}
export async function restoreRegistryItem(kind: RegistryKind, key: string): Promise<string | null> {
  const { data } = await api.post<{ targets_error?: string | null }>(`/api/settings/${kind}/${encodeURIComponent(key)}/restore`, {})
  return typeof data?.targets_error === 'string' ? data.targets_error : null
}
