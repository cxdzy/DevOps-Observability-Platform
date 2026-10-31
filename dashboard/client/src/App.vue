<script setup lang="ts">
import { onMounted } from 'vue'
import DashboardView from '@/components/DashboardView.vue'
import LoginPage from '@/components/LoginPage.vue'
import { useAuth } from '@/composables/useAuth'

// Shows the login page until /auth/me confirms a session. A 401 from any data call switches
// back to it; the URL hash is left alone, so the same view opens after signing in again.
const { status, check } = useAuth()
onMounted(check)
</script>

<template>
  <div class="min-h-dvh bg-background text-foreground">
    <p v-if="status === 'checking'" class="py-24 text-center text-sm text-muted-foreground">Loading...</p>
    <LoginPage v-else-if="status === 'signed-out'" />
    <DashboardView v-else />
  </div>
</template>
