<script setup lang="ts">
import type { AccountInfo, ApiErrorInfo } from '@/types'
import { computed, onMounted, reactive, ref } from 'vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { api } from '@/composables/useApi'
import { useAuth } from '@/composables/useAuth'
import { apiError, toAccountInfo } from '@/types'

// The signed-in user's own account: profile, Change password and Sign out other sessions.
// forced: the page shown instead of the dashboard while an admin-set temporary password has not
// been changed. Then only the password form and Sign out are offered.
const props = defineProps<{ forced?: boolean }>()
const emit = defineEmits<{ refreshed: [ok: boolean] }>()

const { me, logout, passwordChanged } = useAuth()
const MIN_LENGTH = 12

const account = ref<AccountInfo | null>(null)
const loadFailed = ref(false)
async function load() {
  try {
    const res = await api.get<unknown>('/api/account')
    account.value = toAccountInfo(res.data)
    loadFailed.value = false
    emit('refreshed', true)
  } catch {
    loadFailed.value = true
    emit('refreshed', false)
  }
}
onMounted(load)

const hasPassword = computed(() => props.forced || account.value?.method === 'password')
const roleLabel = computed(() => (me.value?.role === 'admin' ? 'Admin' : 'Viewer'))

// Change password.
const form = reactive({ current: '', next: '', again: '' })
// 'again' is the repeat field, checked here only.
type FormError = { message: string, field: ApiErrorInfo['field'] | 'again' }
const error = ref<FormError | null>(null)
const saving = ref(false)
const done = ref('')

function fieldError(field: 'current_password' | 'new_password' | 'again'): string | null {
  return error.value?.field === field ? error.value.message : null
}
const formError = computed(() => (error.value && !error.value.field ? error.value.message : null))

// The same rules as the server, checked first so a mistake is shown without a round trip.
function localProblem(): FormError | null {
  if (!form.current) return { message: 'Enter your current password.', field: 'current_password' }
  if (form.next.length < MIN_LENGTH) return { message: `The new password must be at least ${MIN_LENGTH} characters.`, field: 'new_password' }
  if (form.next === form.current) return { message: 'The new password must be different from the current one.', field: 'new_password' }
  if (form.next !== form.again) return { message: 'The two new passwords do not match.', field: 'again' }
  return null
}

async function submit() {
  if (saving.value) return
  done.value = ''
  error.value = localProblem()
  if (error.value) return
  saving.value = true
  try {
    const res = await api.post<{ sessions_ended?: number }>('/api/account/password', { current_password: form.current, new_password: form.next })
    const ended = Number(res.data?.sessions_ended) || 0
    form.current = ''
    form.next = ''
    form.again = ''
    if (props.forced) {
      passwordChanged()
      return
    }
    done.value = ended
      ? `Your password was changed. ${ended} other session${ended === 1 ? ' was' : 's were'} signed out.`
      : 'Your password was changed.'
    load()
  } catch (err) {
    error.value = apiError(err, 'The password could not be changed. Try again.')
  } finally {
    saving.value = false
  }
}

// Sign out other sessions. This browser stays signed in.
const signingOut = ref(false)
const signOutText = ref('')
const signOutFailed = ref(false)
async function signOutOthers() {
  if (signingOut.value) return
  signingOut.value = true
  signOutText.value = ''
  try {
    const res = await api.post<{ sessions_ended?: number }>('/api/account/sign-out-others', {})
    const n = Number(res.data?.sessions_ended) || 0
    signOutFailed.value = false
    signOutText.value = n ? `${n} other session${n === 1 ? ' was' : 's were'} signed out. This one stays signed in.` : 'There were no other sessions. This one stays signed in.'
    load()
  } catch (err) {
    signOutFailed.value = true
    signOutText.value = apiError(err, 'The other sessions could not be signed out. Try again.').message
  } finally {
    signingOut.value = false
  }
}

const leaving = ref(false)
async function signOut() {
  leaving.value = true
  try {
    await logout()
  } finally {
    leaving.value = false
  }
}

const inputClass = 'min-h-11 w-full rounded-lg border bg-transparent px-3 font-normal text-foreground placeholder:text-muted-foreground'
const btn = 'inline-flex min-h-9 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium pointer-coarse:min-h-11'
</script>

<template>
  <div v-if="forced" class="flex min-h-dvh flex-col px-4 pt-4 pb-10 sm:px-6">
    <div class="flex justify-end">
      <ThemeToggle class="bg-card" />
    </div>
    <main class="flex flex-1 items-center justify-center pt-6">
      <div class="flex w-full max-w-[400px] flex-col gap-4 rounded-[14px] bg-card p-6 ring-1 ring-border">
        <div>
          <h1 class="text-[22px] font-semibold tracking-[-0.02em]">Change password</h1>
          <p class="mt-1 text-[13px] text-muted-foreground">
            You signed in as <span class="font-medium text-foreground">{{ me?.email }}</span> with a temporary password from an admin.
            Choose your own password to continue. It needs at least {{ MIN_LENGTH }} characters.
          </p>
        </div>
        <form class="flex flex-col gap-3.5" novalidate @submit.prevent="submit">
          <label class="flex flex-col gap-1.5 text-[13px] font-medium">
            Current password
            <input v-model="form.current" type="password" autocomplete="current-password" :class="[inputClass, fieldError('current_password') ? 'border-destructive' : 'border-input']" :aria-invalid="!!fieldError('current_password')">
            <span v-if="fieldError('current_password')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('current_password') }}</span>
          </label>
          <label class="flex flex-col gap-1.5 text-[13px] font-medium">
            New password
            <input v-model="form.next" type="password" autocomplete="new-password" :minlength="MIN_LENGTH" :class="[inputClass, fieldError('new_password') ? 'border-destructive' : 'border-input']" :aria-invalid="!!fieldError('new_password')">
            <span v-if="fieldError('new_password')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('new_password') }}</span>
          </label>
          <label class="flex flex-col gap-1.5 text-[13px] font-medium">
            New password again
            <input v-model="form.again" type="password" autocomplete="new-password" :class="[inputClass, fieldError('again') ? 'border-destructive' : 'border-input']" :aria-invalid="!!fieldError('again')">
            <span v-if="fieldError('again')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('again') }}</span>
          </label>
          <p v-if="formError" class="text-[13px] text-destructive" role="alert">{{ formError }}</p>
          <button type="submit" :class="btn" class="min-h-11 bg-primary text-primary-foreground disabled:opacity-50" :disabled="saving">
            {{ saving ? 'Saving' : 'Change password and continue' }}
          </button>
        </form>
        <button type="button" class="self-start rounded-md px-1 text-[13px] text-muted-foreground underline hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11" :disabled="leaving" @click="signOut">
          Sign out instead
        </button>
      </div>
    </main>
  </div>

  <template v-else>
    <div>
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Account</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">Your sign-in details, your password and your sessions.</p>
    </div>

    <section aria-label="Profile" class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3 rounded-xl border border-border p-[18px]">
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-xs text-muted-foreground">Email</span>
        <span class="font-mono text-[13px] [overflow-wrap:anywhere]">{{ me?.email }}</span>
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="text-xs text-muted-foreground">Role</span>
        <span class="text-[13px]">{{ roleLabel }}</span>
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="text-xs text-muted-foreground">Sign-in</span>
        <span class="text-[13px]">{{ account ? (account.method === 'password' ? 'Password or Google' : 'Google only') : loadFailed ? 'Not known' : 'Loading' }}</span>
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="text-xs text-muted-foreground">Signed-in sessions</span>
        <span class="text-[13px]">{{ account ? account.sessions : '-' }}</span>
      </div>
      <p v-if="loadFailed" class="col-span-full text-[13px] text-muted-foreground" role="alert">Your account details could not be loaded. Reload the page to try again.</p>
    </section>

    <section aria-labelledby="account-password" class="flex flex-col gap-4 rounded-xl border border-border p-[18px]">
      <div>
        <h2 id="account-password" class="text-[15px] font-semibold">Change password</h2>
        <p class="mt-0.5 text-[13px] text-muted-foreground">
          {{ hasPassword ? `At least ${MIN_LENGTH} characters. Your other sessions are signed out; this one stays.` : 'You sign in with Google only, so there is no password to change.' }}
        </p>
      </div>
      <form v-if="hasPassword" class="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3.5" novalidate @submit.prevent="submit">
        <label class="flex flex-col gap-1.5 text-[13px] font-medium">
          Current password
          <input v-model="form.current" type="password" autocomplete="current-password" :class="[inputClass, fieldError('current_password') ? 'border-destructive' : 'border-input']" :aria-invalid="!!fieldError('current_password')">
          <span v-if="fieldError('current_password')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('current_password') }}</span>
        </label>
        <label class="flex flex-col gap-1.5 text-[13px] font-medium">
          New password
          <input v-model="form.next" type="password" autocomplete="new-password" :minlength="MIN_LENGTH" :class="[inputClass, fieldError('new_password') ? 'border-destructive' : 'border-input']" :aria-invalid="!!fieldError('new_password')">
          <span v-if="fieldError('new_password')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('new_password') }}</span>
        </label>
        <label class="flex flex-col gap-1.5 text-[13px] font-medium">
          New password again
          <input v-model="form.again" type="password" autocomplete="new-password" :class="[inputClass, fieldError('again') ? 'border-destructive' : 'border-input']" :aria-invalid="!!fieldError('again')">
          <span v-if="fieldError('again')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('again') }}</span>
        </label>
        <div class="col-span-full flex flex-wrap items-center justify-between gap-2.5">
          <span>
            <span v-if="formError" class="text-[13px] text-destructive" role="alert">{{ formError }}</span>
            <span v-else-if="done" class="text-[13px] text-ok" role="status">{{ done }}</span>
          </span>
          <button type="submit" :class="btn" class="bg-primary text-primary-foreground disabled:opacity-50" :disabled="saving">{{ saving ? 'Saving' : 'Change password' }}</button>
        </div>
      </form>
    </section>

    <section aria-labelledby="account-sessions" class="flex flex-col gap-3 rounded-xl border border-border p-[18px]">
      <div>
        <h2 id="account-sessions" class="text-[15px] font-semibold">Other sessions</h2>
        <p class="mt-0.5 text-[13px] text-muted-foreground">Signs you out on every other browser and device. This browser stays signed in.</p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button type="button" :class="btn" class="border border-border hover:bg-chip disabled:opacity-50" :disabled="signingOut" @click="signOutOthers">
          {{ signingOut ? 'Signing out' : 'Sign out other sessions' }}
        </button>
        <span v-if="signOutText" class="text-[13px]" :class="signOutFailed ? 'text-destructive' : 'text-ok'" :role="signOutFailed ? 'alert' : 'status'">{{ signOutText }}</span>
      </div>
    </section>
  </template>
</template>
