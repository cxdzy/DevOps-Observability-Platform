<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted } from 'vue'
import DashboardView from '@/components/DashboardView.vue'
import LoginPage from '@/components/LoginPage.vue'
import { useAuth } from '@/composables/useAuth'

// Downloaded only when needed: the forced Change password page.
const AccountView = defineAsyncComponent(() => import('@/components/AccountView.vue'))

// Shows the login page until /auth/me confirms a session. A 401 from any data call switches
// back to it; the URL hash is left alone, so the same view opens after signing in again.
// While an admin-set temporary password has not been changed, the Change password page is shown
// instead of the dashboard (the server refuses every other route until then).
const { status, me, check } = useAuth()
const mustChange = computed(() => me.value?.must_change_password === true)
onMounted(check)
</script>

<template>
  <div class="min-h-dvh bg-background text-foreground">
    <p v-if="status === 'checking'" class="py-24 text-center text-sm text-muted-foreground">Loading...</p>
    <LoginPage v-else-if="status === 'signed-out'" />
    <AccountView v-else-if="mustChange" forced />
    <DashboardView v-else />
  </div>
</template>
