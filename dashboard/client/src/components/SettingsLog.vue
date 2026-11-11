<script setup lang="ts">
import type { SettingsLogRow } from '@/types'
import { computed, ref } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { toSettingsLogRow } from '@/types'

// The change log of Settings, newest first. Entries are read only here and on the server.
const emit = defineEmits<{ refreshed: [ok: boolean] }>()

const rows = ref<SettingsLogRow[]>([])
const loading = ref(true)
const failed = ref(false)
const limit = ref<50 | 200>(50)

async function load() {
  const wanted = limit.value
  try {
    const res = await api.get<unknown[]>('/api/settings/log', { params: { limit: wanted } })
    if (!Array.isArray(res.data)) throw new Error('unexpected response')
    if (wanted !== limit.value) return
    rows.value = res.data.map(toSettingsLogRow)
    failed.value = false
    emit('refreshed', true)
  } catch {
    if (wanted !== limit.value) return
    failed.value = true
    emit('refreshed', false)
  } finally {
    loading.value = false
  }
}
const { refresh } = usePoll(load, 30000)

function showMore() {
  limit.value = 200
  loading.value = true
  refresh()
}

// Time as "12 Nov 21:14", in the browser's time zone.
function when(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  return `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
}
function who(email: string): string {
  if (!email || email.toLowerCase() === 'system') return 'System'
  return email.split('@')[0]
}

// Colour by kind of change. The action text is the server's; the words decide the chip.
function kindClass(action: string): string {
  const a = action.toLowerCase()
  if (a.includes('archiv')) return 'border border-dashed border-idle text-chipfg'
  if (a.includes('test') || a.includes('active') || a.includes('activ')) return 'bg-tier-low-bg text-tier-low-fg'
  if (a.includes('edit') || a.includes('changed') || a.includes('update')) return 'bg-chip text-chipfg'
  return 'bg-okbg text-ok'
}

const canShowMore = computed(() => limit.value === 50 && rows.value.length >= 50)
</script>

<template>
  <section aria-label="Change log" class="overflow-hidden rounded-xl border border-border">
    <div class="overflow-x-auto">
      <div class="min-w-[760px]">
        <div class="grid grid-cols-[140px_120px_150px_minmax(0,1fr)] gap-3 bg-chip px-[18px] py-2 text-xs font-medium text-muted-foreground">
          <span>Time</span><span>Who</span><span>Change</span><span>What</span>
        </div>

        <div v-if="loading" class="flex flex-col gap-3 px-[18px] py-4" role="status" aria-label="Loading the change log">
          <Skeleton v-for="i in 4" :key="i" class="h-5 rounded-md" />
        </div>
        <div v-else-if="failed && rows.length === 0" class="flex flex-col items-start gap-3 border-t border-border px-[18px] py-4" role="alert">
          <p class="text-[13px] text-muted-foreground">The change log could not be loaded. Retrying in 30 s.</p>
          <button type="button" class="inline-flex min-h-9 items-center rounded-lg border border-border px-3.5 text-[13px] font-medium hover:bg-chip" @click="refresh">Retry now</button>
        </div>
        <p v-else-if="rows.length === 0" class="border-t border-border px-[18px] py-6 text-[13px] text-muted-foreground">
          Nothing has been logged yet. Changes to servers and projects appear here.
        </p>
        <template v-else>
          <div
            v-for="r in rows"
            :key="r.id"
            class="grid grid-cols-[140px_120px_150px_minmax(0,1fr)] items-center gap-3 border-t border-border px-[18px] py-[11px]"
          >
            <span class="font-mono text-[13px]">{{ when(r.at) }}</span>
            <span class="truncate" :title="r.userEmail">{{ who(r.userEmail) }}</span>
            <span class="w-max rounded-full px-2.5 py-0.5 text-xs font-semibold" :class="kindClass(r.action)">{{ r.action }}</span>
            <span class="min-w-0 text-[13px] text-chipfg">
              <span v-if="r.target" class="font-mono font-medium text-foreground">{{ r.target }}</span>
              <span v-if="r.target && r.detail">: </span>{{ r.detail }}
            </span>
          </div>
        </template>
      </div>
    </div>
    <div v-if="canShowMore" class="border-t border-border px-[18px] py-3">
      <button type="button" class="inline-flex min-h-9 items-center rounded-lg border border-border px-3.5 text-[13px] font-medium hover:bg-chip" @click="showMore">Show the last 200</button>
    </div>
  </section>
</template>
