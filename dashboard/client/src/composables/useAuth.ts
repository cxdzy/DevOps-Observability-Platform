import { ref } from 'vue'
import axios from 'axios'
import { api, onUnauthorized } from './useApi'

export interface Me {
  email: string
  role: 'admin' | 'viewer'
}

type Status = 'checking' | 'signed-out' | 'signed-in'

// One shared auth state for the whole app.
const status = ref<Status>('checking')
const me = ref<Me | null>(null)
const googleEnabled = ref(false)
const message = ref('')

const RETURN_HASH_KEY = 'dashboard.returnHash'
export const GENERIC_ERROR = 'Invalid email or password.'
export const RATE_LIMITED = 'Too many attempts, try again later'
export const GOOGLE_DENIED = 'Sign-in failed or this account is not allowed.'
const UNAVAILABLE = 'Sign-in is unavailable right now. Try again later.'

onUnauthorized(() => {
  me.value = null
  status.value = 'signed-out'
})

// The server sends a refused Google sign-in to /login?error=denied. Show the message,
// then put the address back to the page and tab the user started from.
function readRedirect() {
  const url = new URL(window.location.href)
  let saved: string | null = null
  try {
    saved = sessionStorage.getItem(RETURN_HASH_KEY)
    sessionStorage.removeItem(RETURN_HASH_KEY)
  } catch {
    saved = null
  }
  if (url.pathname === '/login') {
    if (url.searchParams.get('error') === 'denied') message.value = GOOGLE_DENIED
    history.replaceState(null, '', `/${saved ?? ''}`)
  } else if (saved && !window.location.hash) {
    history.replaceState(null, '', `/${saved}`)
  }
}

async function check() {
  readRedirect()
  const [config, session] = await Promise.allSettled([
    api.get<{ google: boolean }>('/auth/config'),
    api.get<Me>('/auth/me'),
  ])
  googleEnabled.value = config.status === 'fulfilled' && config.value.data.google === true
  if (session.status === 'fulfilled') {
    me.value = session.value.data
    status.value = 'signed-in'
  } else {
    status.value = 'signed-out'
  }
}

// Returns null on success, else the message to show.
async function login(email: string, password: string): Promise<string | null> {
  try {
    const { data } = await api.post<Me>('/auth/login', { email, password })
    me.value = data
    message.value = ''
    status.value = 'signed-in'
    return null
  } catch (err) {
    const code = axios.isAxiosError(err) ? err.response?.status : undefined
    if (code === 401) return GENERIC_ERROR
    if (code === 429) return RATE_LIMITED
    return UNAVAILABLE
  }
}

async function logout() {
  try {
    await api.post('/auth/logout', {})
  } finally {
    me.value = null
    status.value = 'signed-out'
  }
}

// Called just before leaving for Google, so the tab survives the round trip.
function rememberTab() {
  try {
    sessionStorage.setItem(RETURN_HASH_KEY, window.location.hash)
  } catch {
    // Without storage the user lands on the default tab.
  }
}

export function useAuth() {
  return { status, me, googleEnabled, message, check, login, logout, rememberTab }
}
