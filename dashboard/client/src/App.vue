<script setup lang="ts">
import { onMounted } from 'vue'
import AppHeader from '@/components/AppHeader.vue'
import DashboardView from '@/components/DashboardView.vue'
import LoginPage from '@/components/LoginPage.vue'
import { useAuth } from '@/composables/useAuth'

// Shows the login page until /auth/me confirms a session. A 401 from any data call switches
// back to it; the URL hash is left alone, so the same tab opens after signing in again.
const { status, check } = useAuth()
onMounted(check)
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8">
    <p v-if="status === 'checking'" class="py-24 text-center text-sm text-muted-foreground">Loading...</p>
    <LoginPage v-else-if="status === 'signed-out'" />
    <template v-else>
      <AppHeader />
      <DashboardView />
    </template>
  </main>
</template>
