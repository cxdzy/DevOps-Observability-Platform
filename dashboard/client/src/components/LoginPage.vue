<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { useAuth } from '@/composables/useAuth'

const { googleEnabled, message, login, rememberTab } = useAuth()

const email = ref('')
const password = ref('')
const submitting = ref(false)
// A refused Google sign-in arrives here as a message from the auth state.
const error = ref(message.value)

async function submit() {
  if (submitting.value) return
  submitting.value = true
  error.value = ''
  const problem = await login(email.value, password.value)
  submitting.value = false
  if (problem) {
    error.value = problem
    password.value = ''
  }
}

const inputClass =
  'min-h-11 w-full rounded-lg border border-input bg-transparent px-3 font-normal text-foreground placeholder:text-muted-foreground disabled:opacity-50'
</script>

<template>
  <div class="flex min-h-dvh flex-col px-4 pt-4 pb-10 sm:px-6">
    <div class="flex justify-end">
      <ThemeToggle class="bg-card" />
    </div>

    <main class="flex flex-1 items-center justify-center pt-6">
      <div class="flex w-full max-w-[380px] flex-col gap-5">
        <div class="flex items-center gap-2.5">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
          </span>
          <span class="flex flex-col leading-tight">
            <span class="text-[15px] font-semibold">Observability</span>
            <span class="text-xs text-muted-foreground">Predictive monitoring and incident diagnosis</span>
          </span>
        </div>

        <div class="flex flex-col gap-4 rounded-[14px] bg-card p-6 ring-1 ring-border">
          <div>
            <h1 class="text-[22px] font-semibold tracking-[-0.02em]">Sign in</h1>
            <p class="mt-1 text-[13px] text-muted-foreground">Use an approved account.</p>
          </div>

          <p v-if="error" class="rounded-lg bg-tier-high-bg p-2.5 text-[13px] text-tier-high-fg" role="alert">
            {{ error }}
          </p>

          <template v-if="googleEnabled">
            <!-- A plain link: the browser leaves for Google and comes back to /auth/google/callback. -->
            <Button
              as="a"
              href="/auth/google"
              variant="outline"
              class="min-h-11 gap-2.5 border-input bg-transparent text-sm text-foreground dark:border-input dark:bg-transparent"
              @click="rememberTab"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 12h8" /></svg>
              Continue with Google
            </Button>
            <div class="flex items-center gap-3 text-xs text-muted-foreground">
              <span class="h-px flex-1 bg-border" aria-hidden="true" />
              or with email
              <span class="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
          </template>

          <form class="flex flex-col gap-4" @submit.prevent="submit">
            <label class="flex flex-col gap-1.5 text-[13px] font-medium">
              Email
              <input v-model="email" type="email" name="email" autocomplete="username" placeholder="you@example.com" required :disabled="submitting" :class="inputClass">
            </label>
            <label class="flex flex-col gap-1.5 text-[13px] font-medium">
              Password
              <input v-model="password" type="password" name="password" autocomplete="current-password" required :disabled="submitting" :class="inputClass">
            </label>
            <Button type="submit" class="min-h-11 text-sm" :disabled="submitting">{{ submitting ? 'Signing in...' : 'Sign in' }}</Button>
          </form>
        </div>

        <p class="text-xs text-muted-foreground">
          No sign-up. Ask the administrator for an account. Sessions end after 8 hours without activity.
        </p>
      </div>
    </main>
  </div>
</template>
