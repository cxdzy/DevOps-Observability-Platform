<script setup lang="ts">
import { ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/composables/useAuth'

const { me, logout } = useAuth()
const leaving = ref(false)

async function signOut() {
  leaving.value = true
  try {
    await logout()
  } finally {
    leaving.value = false
  }
}
</script>

<template>
  <header class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-2xl font-semibold">Observability Dashboard</h1>
    <div v-if="me" class="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span class="min-w-0 truncate text-muted-foreground" :title="me.email">{{ me.email }}</span>
      <Badge variant="outline">{{ me.role === 'admin' ? 'Admin' : 'Viewer' }}</Badge>
      <Button variant="outline" size="sm" :disabled="leaving" @click="signOut">Log out</Button>
    </div>
  </header>
</template>
