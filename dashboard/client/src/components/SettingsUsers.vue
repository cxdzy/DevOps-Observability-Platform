<script setup lang="ts">
import type { ApiErrorInfo, SettingsUser } from '@/types'
import { computed, nextTick, onUnmounted, reactive, ref } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { useAuth } from '@/composables/useAuth'
import { apiError, toAccountInfo, toSettingsUser } from '@/types'

// The Users tab: who can sign in, Add user, and the row actions (role, disable or enable, reset
// password, sign out everywhere). Nothing is deleted. The server enforces every rule; the checks
// here only explain them. A temporary password is held in memory for the one panel that shows it
// and is cleared when the panel closes or the tab is left.
const emit = defineEmits<{ refreshed: [ok: boolean] }>()
const { me } = useAuth()

const GRID = 'grid grid-cols-[minmax(0,1.6fr)_80px_110px_90px_120px_70px_minmax(0,1.9fr)] gap-3'

const users = ref<SettingsUser[]>([])
const loading = ref(true)
const failed = ref(false)
async function load() {
  try {
    const res = await api.get<unknown[]>('/api/settings/users')
    if (!Array.isArray(res.data)) throw new Error('unexpected response')
    users.value = res.data.map(toSettingsUser)
    failed.value = false
    emit('refreshed', true)
  } catch {
    failed.value = true
    emit('refreshed', false)
  } finally {
    loading.value = false
  }
}
const { refresh } = usePoll(load, 30000)

// How this admin confirms a sensitive change: with their own password, or (Google only) by typing
// the email of the account being changed.
const myMethod = ref<'password' | 'google'>('password')
api.get('/api/account').then((res) => { myMethod.value = toAccountInfo(res.data).method }).catch(() => {})
const isSelf = (u: SettingsUser) => u.email === me.value?.email
function confirmLabel(targetEmail: string): string {
  return myMethod.value === 'password' ? 'Your password, to confirm' : `Type ${targetEmail} to confirm`
}

// Shown once: the temporary password of a user just added or reset.
const secret = ref<{ email: string, password: string, reason: 'added' | 'reset' } | null>(null)
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
const secretBox = ref<HTMLElement | null>(null)
function showSecret(email: string, password: string, reason: 'added' | 'reset') {
  secret.value = { email, password, reason }
  copyState.value = 'idle'
  nextTick(() => secretBox.value?.focus())
}
async function copySecret() {
  if (!secret.value) return
  try {
    await navigator.clipboard.writeText(secret.value.password)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'failed'
  }
}
function closeSecret() {
  secret.value = null
  copyState.value = 'idle'
}
onUnmounted(closeSecret)

const notice = ref('')

// Add user.
const adding = ref(false)
const addForm = reactive({ email: '', role: 'viewer' as 'viewer' | 'admin', method: 'google' as 'google' | 'password', confirm: '' })
const addError = ref<ApiErrorInfo | null>(null)
const addSaving = ref(false)
const addEmail = ref<HTMLInputElement | null>(null)
let addOpener: HTMLElement | null = null
function openAdd() {
  const el = document.activeElement
  addOpener = el instanceof HTMLElement ? el : null
  adding.value = true
  addError.value = null
  notice.value = ''
  nextTick(() => addEmail.value?.focus())
}
function closeAdd() {
  adding.value = false
  Object.assign(addForm, { email: '', role: 'viewer', method: 'google', confirm: '' })
  addError.value = null
  const el = addOpener
  addOpener = null
  nextTick(() => { if (el && el.isConnected) el.focus() })
}
function addFieldError(field: string): string | null {
  return addError.value?.field === field ? addError.value.message : null
}
const addFormError = computed(() => (addError.value && !addError.value.field ? addError.value.message : null))
async function saveUser() {
  if (addSaving.value) return
  addError.value = null
  if (addForm.role === 'admin' && !addForm.confirm) {
    addError.value = { message: myMethod.value === 'password' ? 'Type your own password to confirm a new admin.' : 'Type the new admin\'s email to confirm.', field: 'confirm' }
    return
  }
  addSaving.value = true
  try {
    const body: Record<string, string> = { email: addForm.email, role: addForm.role, method: addForm.method }
    if (addForm.role === 'admin') body.confirm = addForm.confirm
    const res = await api.post<{ user?: unknown, temporary_password?: string | null }>('/api/settings/users', body)
    const added = toSettingsUser(res.data?.user)
    const temp = res.data?.temporary_password
    adding.value = false
    Object.assign(addForm, { email: '', role: 'viewer', method: 'google', confirm: '' })
    addOpener = null
    notice.value = `${added.email} was added as ${added.role === 'admin' ? 'an admin' : 'a viewer'}.`
    if (typeof temp === 'string' && temp) showSecret(added.email, temp, 'added')
    refresh()
  } catch (err) {
    addError.value = apiError(err, 'The user could not be added. Try again.')
    addForm.confirm = ''
  } finally {
    addSaving.value = false
  }
}

// Row actions, each asked first in a short confirmation that says what it does.
type Action = 'make-admin' | 'make-viewer' | 'disable' | 'enable' | 'reset' | 'sign-out'
const pending = ref<{ user: SettingsUser, action: Action } | null>(null)
const pendingConfirm = ref('')
const pendingError = ref<ApiErrorInfo | null>(null)
const pendingSaving = ref(false)
const pendingCancel = ref<HTMLButtonElement | null>(null)
let actionOpener: HTMLElement | null = null

const ACTIONS: Record<Action, { title: (e: string) => string, text: string, button: string, confirm: boolean }> = {
  'make-admin': {
    title: e => `Make ${e} an admin?`,
    text: 'Admins can change servers, projects and users. Every session of this user ends now, so they sign in again with the new role.',
    button: 'Make admin',
    confirm: true,
  },
  'make-viewer': {
    title: e => `Make ${e} a viewer?`,
    text: 'Viewers can see every view but cannot open Settings. Every session of this user ends now.',
    button: 'Make viewer',
    confirm: false,
  },
  'disable': {
    title: e => `Disable ${e}?`,
    text: 'They can no longer sign in, and every session ends now. Nothing is deleted; you can enable the account again.',
    button: 'Disable user',
    confirm: false,
  },
  'enable': {
    title: e => `Enable ${e}?`,
    text: 'They can sign in again with the same method as before.',
    button: 'Enable user',
    confirm: false,
  },
  'reset': {
    title: e => `Reset the password of ${e}?`,
    text: 'A new temporary password is shown once. Every session of this user ends now, and they must choose a new password at the next sign-in.',
    button: 'Reset password',
    confirm: true,
  },
  'sign-out': {
    title: e => `Sign ${e} out everywhere?`,
    text: 'Every session of this user ends now. They can sign in again.',
    button: 'Sign out everywhere',
    confirm: false,
  },
}

function ask(user: SettingsUser, action: Action) {
  const el = document.activeElement
  actionOpener = el instanceof HTMLElement && el !== document.body ? el : null
  pending.value = { user, action }
  pendingConfirm.value = ''
  pendingError.value = null
  notice.value = ''
  nextTick(() => pendingCancel.value?.focus())
}
function closePending() {
  const el = actionOpener
  actionOpener = null
  pending.value = null
  pendingConfirm.value = ''
  pendingError.value = null
  nextTick(() => { if (el && el.isConnected) el.focus() })
}
async function runPending() {
  if (!pending.value || pendingSaving.value) return
  const { user, action } = pending.value
  if (ACTIONS[action].confirm && !pendingConfirm.value) {
    pendingError.value = { message: myMethod.value === 'password' ? 'Type your own password to confirm.' : `Type ${user.email} to confirm.`, field: 'confirm' }
    return
  }
  pendingSaving.value = true
  pendingError.value = null
  const base = `/api/settings/users/${encodeURIComponent(user.id)}`
  try {
    if (action === 'make-admin' || action === 'make-viewer') {
      const role = action === 'make-admin' ? 'admin' : 'viewer'
      await api.post(`${base}/role`, role === 'admin' ? { role, confirm: pendingConfirm.value } : { role })
      notice.value = `${user.email} is now ${role === 'admin' ? 'an admin' : 'a viewer'}. Their sessions were ended.`
    } else if (action === 'reset') {
      const res = await api.post<{ temporary_password?: string }>(`${base}/reset-password`, { confirm: pendingConfirm.value })
      notice.value = `The password of ${user.email} was reset. Their sessions were ended.`
      if (typeof res.data?.temporary_password === 'string') showSecret(user.email, res.data.temporary_password, 'reset')
    } else {
      await api.post(`${base}/${action}`, {})
      notice.value = action === 'disable'
        ? `${user.email} was disabled and signed out.`
        : action === 'enable' ? `${user.email} can sign in again.` : `${user.email} was signed out everywhere.`
    }
    actionOpener = null
    pending.value = null
    pendingConfirm.value = ''
    refresh()
  } catch (err) {
    pendingError.value = apiError(err, 'That did not work. Nothing was changed. Try again.')
    pendingConfirm.value = ''
  } finally {
    pendingSaving.value = false
  }
}
const pendingFieldError = computed(() => (pendingError.value?.field === 'confirm' ? pendingError.value.message : null))
const pendingFormError = computed(() => (pendingError.value && pendingError.value.field !== 'confirm' ? pendingError.value.message : null))

// "12 Nov 21:14" in the browser's time zone, or Never.
function when(ms: number | null): string {
  if (!ms) return 'Never'
  const d = new Date(ms)
  return `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

const shownCount = computed(() => {
  const active = users.value.filter(u => u.status === 'active').length
  return `${users.value.length} user${users.value.length === 1 ? '' : 's'}, ${active} active`
})

const inputClass = 'min-h-[38px] rounded-lg border bg-card px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground pointer-coarse:min-h-11'
const btn = 'inline-flex min-h-9 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium pointer-coarse:min-h-11'
const rowBtn = 'min-h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-chip hover:text-foreground pointer-coarse:min-h-11'
</script>

<template>
  <!-- One-time password. Shown above everything else, so it is not missed. -->
  <section
    v-if="secret"
    ref="secretBox"
    tabindex="-1"
    aria-labelledby="secret-title"
    class="flex flex-col gap-3 rounded-xl border border-primary p-[18px] ring-1 ring-primary"
  >
    <h2 id="secret-title" class="text-[15px] font-semibold">
      Temporary password for <span class="font-mono [overflow-wrap:anywhere]">{{ secret.email }}</span>
    </h2>
    <div class="flex flex-wrap items-center gap-2">
      <code class="min-w-0 rounded-lg bg-chip px-3 py-2 font-mono text-[15px] tracking-wide break-all select-all" aria-label="Temporary password">{{ secret.password }}</code>
      <button type="button" :class="btn" class="border border-border hover:bg-chip" @click="copySecret">Copy</button>
      <span class="text-xs" :class="copyState === 'failed' ? 'text-destructive' : 'text-ok'" role="status">
        {{ copyState === 'copied' ? 'Copied.' : copyState === 'failed' ? 'Copying did not work here. Select the text and copy it by hand.' : '' }}
      </span>
    </div>
    <p class="text-[13px] text-chipfg">
      Shown once. Give it to {{ secret.email }} in person or over a private channel. They must choose their own password at the first sign-in.
      It is not stored in readable form and cannot be shown again; if it is lost, reset the password again.
    </p>
    <div class="flex justify-end">
      <button type="button" :class="btn" class="bg-primary text-primary-foreground" @click="closeSecret">Close</button>
    </div>
  </section>

  <p v-if="notice" class="text-[13px] text-ok" role="status">{{ notice }}</p>

  <section aria-label="Users" class="overflow-hidden rounded-xl border border-border">
    <div class="flex flex-wrap items-center justify-between gap-3 px-[18px] py-3.5">
      <span class="text-[15px] font-semibold">Users</span>
      <span class="flex items-center gap-3">
        <span v-if="!loading && !failed" class="text-xs text-muted-foreground">{{ shownCount }}</span>
        <button v-if="!adding" type="button" :class="btn" class="bg-primary text-primary-foreground" @click="openAdd">Add user</button>
      </span>
    </div>
    <!-- relative: the sr-only labels inside are position absolute and must stay inside this scroll box -->
    <div class="relative overflow-x-auto">
      <div class="min-w-[960px]">
        <div :class="GRID" class="bg-chip px-[18px] py-2 text-xs font-medium text-muted-foreground">
          <span>Email</span><span>Role</span><span>Sign-in</span><span>Status</span><span>Last sign-in</span><span>Sessions</span><span>Actions</span>
        </div>
        <div v-if="loading" class="flex flex-col gap-3 px-[18px] py-4" role="status" aria-label="Loading users">
          <Skeleton v-for="i in 3" :key="i" class="h-9 rounded-md" />
        </div>
        <div v-else-if="failed && users.length === 0" class="flex flex-col items-start gap-3 border-t border-border px-[18px] py-4" role="alert">
          <p class="text-[13px] text-muted-foreground">The users could not be loaded. Retrying in 30 s.</p>
          <button type="button" :class="btn" class="border border-border hover:bg-chip" @click="refresh">Retry now</button>
        </div>
        <div v-for="u in users" :key="u.id" :class="[GRID, u.status === 'disabled' && 'text-muted-foreground']" class="items-center border-t border-border px-[18px] py-3">
          <span class="flex min-w-0 flex-col">
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span class="min-w-0 font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{{ u.email }}</span>
              <span v-if="isSelf(u)" class="rounded-md bg-chip px-1.5 text-xs text-chipfg">You</span>
            </span>
            <span v-if="u.mustChangePassword" class="text-xs text-muted-foreground">Must change the temporary password</span>
          </span>
          <span class="text-[13px]">{{ u.role === 'admin' ? 'Admin' : 'Viewer' }}</span>
          <span class="text-[13px]">{{ u.method === 'password' ? 'Password' : 'Google only' }}</span>
          <span
            class="w-fit rounded-[10px] px-2.5 py-0.5 text-xs leading-snug font-semibold"
            :class="u.status === 'active' ? 'bg-okbg text-ok' : 'border border-dashed border-input text-chipfg'"
          >{{ u.status === 'active' ? 'Active' : 'Disabled' }}</span>
          <span class="font-mono text-xs">{{ when(u.lastLoginAt) }}</span>
          <span class="font-mono text-[13px]">{{ u.sessions }}</span>
          <span v-if="isSelf(u)" class="text-xs text-muted-foreground">Your own account: change it in <a href="#account" class="underline">Account</a>.</span>
          <span v-else class="flex flex-wrap gap-1">
            <button type="button" :class="rowBtn" :aria-label="`${u.role === 'admin' ? 'Make viewer' : 'Make admin'}: ${u.email}`" @click="ask(u, u.role === 'admin' ? 'make-viewer' : 'make-admin')">
              {{ u.role === 'admin' ? 'Make viewer' : 'Make admin' }}
            </button>
            <button type="button" :class="rowBtn" :aria-label="`${u.status === 'active' ? 'Disable' : 'Enable'}: ${u.email}`" @click="ask(u, u.status === 'active' ? 'disable' : 'enable')">
              {{ u.status === 'active' ? 'Disable' : 'Enable' }}
            </button>
            <button v-if="u.method === 'password'" type="button" :class="rowBtn" :aria-label="`Reset password: ${u.email}`" @click="ask(u, 'reset')">Reset password</button>
            <button v-if="u.sessions > 0" type="button" :class="rowBtn" :aria-label="`Sign out everywhere: ${u.email}`" @click="ask(u, 'sign-out')">Sign out</button>
          </span>
        </div>
      </div>
    </div>
  </section>

  <!-- The confirmation of a row action. Focus starts on Cancel, the safe choice. -->
  <div
    v-if="pending"
    class="flex flex-col gap-3 rounded-xl border border-dashed border-input p-[18px]"
    role="alertdialog"
    aria-labelledby="user-action-title"
    aria-describedby="user-action-text"
    @keydown.esc.stop="closePending"
  >
    <span id="user-action-title" class="text-[15px] font-semibold [overflow-wrap:anywhere]">{{ ACTIONS[pending.action].title(pending.user.email) }}</span>
    <p id="user-action-text" class="text-[13px] text-chipfg">{{ ACTIONS[pending.action].text }}</p>
    <label v-if="ACTIONS[pending.action].confirm" class="flex max-w-[360px] flex-col gap-1.5 text-[13px] font-medium">
      {{ confirmLabel(pending.user.email) }}
      <input
        v-model="pendingConfirm"
        :type="myMethod === 'password' ? 'password' : 'email'"
        :autocomplete="myMethod === 'password' ? 'current-password' : 'off'"
        :class="[inputClass, pendingFieldError ? 'border-destructive' : 'border-input']"
        :aria-invalid="!!pendingFieldError"
        @keydown.enter.prevent="runPending"
      >
      <span v-if="pendingFieldError" class="text-xs font-normal text-destructive" role="alert">{{ pendingFieldError }}</span>
    </label>
    <p v-if="pendingFormError" class="text-[13px] text-destructive" role="alert">{{ pendingFormError }}</p>
    <div class="flex flex-wrap justify-end gap-2">
      <button ref="pendingCancel" type="button" :class="btn" class="border border-border hover:bg-chip" @click="closePending">Cancel</button>
      <button type="button" :class="btn" class="bg-primary text-primary-foreground disabled:opacity-50" :disabled="pendingSaving" @click="runPending">
        {{ pendingSaving ? 'Working' : ACTIONS[pending.action].button }}
      </button>
    </div>
  </div>

  <!-- Add user. -->
  <form
    v-if="adding"
    role="dialog"
    aria-labelledby="add-user-title"
    class="flex flex-col gap-4 rounded-xl border border-border p-[18px]"
    novalidate
    @submit.prevent="saveUser"
    @keydown.esc.stop="closeAdd"
  >
    <span id="add-user-title" class="text-[15px] font-semibold">Add user</span>
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-3.5">
      <label class="flex flex-col gap-1.5 text-[13px] font-medium">
        Email
        <input
          ref="addEmail"
          v-model="addForm.email"
          type="email"
          maxlength="254"
          autocomplete="off"
          spellcheck="false"
          placeholder="name@example.com"
          :class="[inputClass, addFieldError('email') ? 'border-destructive' : 'border-input']"
          :aria-invalid="!!addFieldError('email')"
        >
        <span v-if="addFieldError('email')" class="text-xs font-normal text-destructive" role="alert">{{ addFieldError('email') }}</span>
      </label>
      <fieldset class="flex flex-col gap-1.5 text-[13px]">
        <legend class="mb-1.5 font-medium">Role</legend>
        <label class="flex min-h-8 items-center gap-2 pointer-coarse:min-h-11"><input v-model="addForm.role" type="radio" value="viewer" class="size-4 accent-primary"> Viewer: sees every view, cannot open Settings</label>
        <label class="flex min-h-8 items-center gap-2 pointer-coarse:min-h-11"><input v-model="addForm.role" type="radio" value="admin" class="size-4 accent-primary"> Admin: can also change servers, projects and users</label>
        <span v-if="addFieldError('role')" class="text-xs text-destructive" role="alert">{{ addFieldError('role') }}</span>
      </fieldset>
      <fieldset class="flex flex-col gap-1.5 text-[13px]">
        <legend class="mb-1.5 font-medium">Sign-in method</legend>
        <label class="flex min-h-8 items-center gap-2 pointer-coarse:min-h-11"><input v-model="addForm.method" type="radio" value="google" class="size-4 accent-primary"> Google only</label>
        <label class="flex min-h-8 items-center gap-2 pointer-coarse:min-h-11"><input v-model="addForm.method" type="radio" value="password" class="size-4 accent-primary"> Password (a temporary one is made for you)</label>
        <span v-if="addFieldError('method')" class="text-xs text-destructive" role="alert">{{ addFieldError('method') }}</span>
      </fieldset>
    </div>
    <p class="text-xs text-muted-foreground">
      Google sign-in also needs this email added as a test user in Google Cloud Console while the consent screen is in Testing mode. The dashboard cannot do that.
    </p>
    <p v-if="addForm.method === 'password'" class="text-xs text-muted-foreground">
      The temporary password is shown once after saving. The user must change it at the first sign-in.
    </p>
    <label v-if="addForm.role === 'admin'" class="flex max-w-[360px] flex-col gap-1.5 text-[13px] font-medium">
      {{ confirmLabel(addForm.email.trim().toLowerCase() || 'the new email') }}
      <input
        v-model="addForm.confirm"
        :type="myMethod === 'password' ? 'password' : 'email'"
        :autocomplete="myMethod === 'password' ? 'current-password' : 'off'"
        :class="[inputClass, addFieldError('confirm') ? 'border-destructive' : 'border-input']"
        :aria-invalid="!!addFieldError('confirm')"
      >
      <span v-if="addFieldError('confirm')" class="text-xs font-normal text-destructive" role="alert">{{ addFieldError('confirm') }}</span>
      <span v-else class="text-xs font-normal text-muted-foreground">Adding an admin is the most sensitive change, so it is confirmed.</span>
    </label>
    <p v-if="addFormError" class="text-[13px] text-destructive" role="alert">{{ addFormError }}</p>
    <div class="flex flex-wrap justify-end gap-2 border-t border-border pt-3.5">
      <button type="button" :class="btn" class="border border-border hover:bg-chip" @click="closeAdd">Cancel</button>
      <button type="submit" :class="btn" class="bg-primary text-primary-foreground disabled:opacity-50" :disabled="addSaving">{{ addSaving ? 'Saving' : 'Add user' }}</button>
    </div>
  </form>
</template>
