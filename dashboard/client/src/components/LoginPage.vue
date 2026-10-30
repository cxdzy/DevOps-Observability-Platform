<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
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
  'border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-lg border bg-transparent px-3 text-sm outline-none focus-visible:ring-3 disabled:opacity-50'
</script>

<template>
  <div class="flex flex-1 items-center justify-center py-8">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle class="text-xl">Observability Dashboard</CardTitle>
        <CardDescription>Sign in to continue</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <p v-if="error" class="rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800" role="alert">
          {{ error }}
        </p>

        <form class="flex flex-col gap-3" @submit.prevent="submit">
          <label class="flex flex-col gap-1.5 text-sm">
            <span>Email</span>
            <input v-model="email" type="email" name="email" autocomplete="username" required :disabled="submitting" :class="inputClass">
          </label>
          <label class="flex flex-col gap-1.5 text-sm">
            <span>Password</span>
            <input v-model="password" type="password" name="password" autocomplete="current-password" required :disabled="submitting" :class="inputClass">
          </label>
          <Button type="submit" :disabled="submitting">{{ submitting ? 'Signing in...' : 'Sign in' }}</Button>
        </form>

        <template v-if="googleEnabled">
          <div class="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator class="flex-1" />
            <span>or</span>
            <Separator class="flex-1" />
          </div>
          <!-- A plain link: the browser leaves for Google and comes back to /auth/google/callback. -->
          <Button as="a" href="/auth/google" variant="outline" @click="rememberTab">Continue with Google</Button>
        </template>
      </CardContent>
    </Card>
  </div>
</template>
