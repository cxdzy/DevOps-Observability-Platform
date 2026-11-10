<script setup lang="ts">
import type { RemediationRow } from '@/types'
import { computed, ref, watch } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { clockTime, localDateTime, orDash, shortDate } from '@/lib/format'

const emit = defineEmits<{ refreshed: [ok: boolean] }>()

const RANGES = [
  { hours: 24, label: '24 h', title: 'Last 24 hours', text: 'last 24 hours' },
  { hours: 168, label: '7 d', title: 'Last 7 days', text: 'last 7 days' },
  { hours: 720, label: '30 d', title: 'Last 30 days', text: 'last 30 days' },
]
const hours = ref(168)
const rangeText = computed(() => RANGES.find(r => r.hours === hours.value)?.text ?? `last ${hours.value} hours`)

const rows = ref<RemediationRow[]>([])
const loading = ref(true)
const failed = ref(false)
const loaded = ref(false)
// Updated on every load, so relative times move on with the poll.
const now = ref(Date.now())

async function load() {
  const requested = hours.value
  try {
    const { data } = await api.get<RemediationRow[]>('/api/remediation', { params: { hours: requested } })
    // The range changed while this load ran; a reload for the new range follows.
    if (requested !== hours.value) return
    rows.value = Array.isArray(data) ? data : []
    failed.value = false
    loaded.value = true
    emit('refreshed', true)
  } catch {
    if (requested !== hours.value) return
    failed.value = true
    emit('refreshed', false)
  } finally {
    now.value = Date.now()
    if (requested === hours.value) loading.value = false
  }
}

const { refresh } = usePoll(load, 60000)

// Restarts from the old range are never shown under the new one.
watch(hours, () => {
  rows.value = []
  loaded.value = false
  failed.value = false
  loading.value = true
  refresh()
})

const MODE_LABEL: Record<string, string> = { auto: 'Automatic', approved: 'Approved' }
const modeLabel = (mode: string | null) => (mode ? (MODE_LABEL[mode] ?? mode) : '-')

const ACTION_LABEL: Record<string, string> = { restart: 'Restart', rollback: 'Rollback' }
const actionLabel = (action: string | null) => (action ? (ACTION_LABEL[action] ?? action) : 'Restart')

// Outcome text and tone. ran means the action was actually carried out.
const SKIPPED: Record<string, string> = {
  skipped_cooldown: 'Skipped, a recent action',
  skipped_closed: 'Skipped, incident had ended',
  skipped_simulated: 'Skipped, simulated deployment',
  skipped_no_previous_image: 'Skipped, no previous image',
  skipped_no_deployment: 'Skipped, no deployment found',
}
function outcomeInfo(row: RemediationRow): { text: string, tone: 'ok' | 'bad' | 'quiet' } {
  switch (row.outcome) {
    case 'success': return { text: row.action === 'rollback' ? 'Rolled back' : 'Restarted', tone: 'ok' }
    case 'failed': return { text: row.action === 'rollback' ? 'Rolled back, service not up' : 'Restarted, service not up', tone: 'bad' }
    case 'expired': return { text: 'No answer, expired', tone: 'quiet' }
    case 'rejected': return { text: 'Rejected', tone: 'quiet' }
    default: return { text: SKIPPED[row.outcome ?? ''] ?? (row.outcome ?? 'Not recorded'), tone: 'quiet' }
  }
}
const ran = (row: RemediationRow) => row.outcome === 'success' || row.outcome === 'failed'

const newest = computed(() => rows.value.find(ran) ?? null)
const ranCount = computed(() => rows.value.filter(ran).length)
const cameBack = computed(() => rows.value.filter(r => r.outcome === 'success' && r.service_up === 1).length)
const mode = computed(() => {
  const latest = rows.value.find(r => r.mode === 'auto' || r.mode === 'approved')
  if (latest?.mode === 'auto') return { title: 'Automatic', line: 'Acts without asking first' }
  if (latest?.mode === 'approved') return { title: 'Approval on Telegram', line: 'Asks on Telegram before acting' }
  return { title: 'Approval on Telegram', line: 'No action in this period to read it from' }
})

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round((now.value - ms) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const h = Math.round(minutes / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

const card = 'rounded-xl border border-border p-4'
const bigNumber = 'mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]'
const cell = 'px-[18px] py-3'
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Remediation</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">Restarts and rollbacks of sample-service, and whether it came back</p>
    </div>
    <div role="group" aria-label="Time range" class="flex gap-0.5 rounded-lg bg-chip p-[3px]">
      <button
        v-for="r in RANGES"
        :key="r.hours"
        type="button"
        class="min-h-9 rounded-md px-3 text-[13px] md:min-h-8"
        :class="hours === r.hours ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
        :aria-pressed="hours === r.hours"
        :title="r.title"
        @click="hours = r.hours"
      >
        {{ r.label }}
      </button>
    </div>
  </div>

  <template v-if="loading">
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <Skeleton v-for="n in 4" :key="n" class="h-[116px] rounded-xl" />
    </div>
    <Skeleton class="h-48 rounded-xl" />
  </template>

  <p v-else-if="failed && !loaded" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    InfluxDB did not answer. Retrying in 60 s.
  </p>

  <template v-else>
    <p v-if="failed" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      Restarts could not be refreshed. Showing the last loaded data.
    </p>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <section aria-label="Actions that ran" :class="card">
        <div class="text-[13px] text-muted-foreground">Actions that ran</div>
        <div :class="bigNumber">{{ ranCount }}</div>
        <div class="mt-0.5 text-xs text-muted-foreground">of {{ rows.length }} requests in the {{ rangeText }}</div>
      </section>

      <section aria-label="Came back up" :class="card">
        <div class="text-[13px] text-muted-foreground">Came back up</div>
        <div class="mt-2">
          <span class="font-mono text-[28px] font-medium tracking-[-0.02em]">{{ cameBack }}</span>
          <span class="text-[13px] text-muted-foreground"> of {{ ranCount }}</span>
        </div>
        <div class="mt-0.5 text-xs text-muted-foreground">checked after each action that ran</div>
      </section>

      <section aria-label="Last action" :class="card">
        <div class="text-[13px] text-muted-foreground">Last action</div>
        <template v-if="newest">
          <div class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">{{ ago(newest.time) }}</div>
          <div class="mt-1 text-xs text-muted-foreground">
            {{ actionLabel(newest.action) }}, {{ modeLabel(newest.mode).toLowerCase() }}, <span class="font-mono">{{ localDateTime(newest.time) }}</span>
          </div>
        </template>
        <template v-else>
          <div class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">None</div>
          <div class="mt-1 text-xs text-muted-foreground">in the {{ rangeText }}</div>
        </template>
      </section>

      <section aria-label="Mode" :class="card">
        <div class="text-[13px] text-muted-foreground">Mode</div>
        <div class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">{{ mode.title }}</div>
        <div class="mt-1 text-xs text-muted-foreground">{{ mode.line }}</div>
      </section>
    </div>

    <section aria-labelledby="restarts-title" class="overflow-hidden rounded-xl border border-border">
      <div class="flex flex-wrap items-center justify-between gap-2.5 px-[18px] py-3.5">
        <h2 id="restarts-title" class="text-[15px] font-semibold">Requests</h2>
        <span class="text-xs text-muted-foreground">newest first</span>
      </div>
      <p v-if="rows.length === 0" class="border-t border-border px-[18px] py-10 text-center text-[13px] text-muted-foreground">
        No requests in this period. A restart or rollback request appears here as soon as it is sent to Telegram.
      </p>
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[760px] text-left">
          <thead class="bg-chip text-xs font-medium text-muted-foreground">
            <tr>
              <th scope="col" :class="cell" class="py-2 font-medium">Time</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Action</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Incident</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Mode</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Outcome</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Service after</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.time" class="border-t border-border align-middle">
              <td :class="cell" class="font-mono text-[13px] whitespace-nowrap">{{ shortDate(row.time) }} {{ clockTime(row.time) }}</td>
              <td :class="cell">{{ actionLabel(row.action) }}</td>
              <td :class="cell">
                <span v-if="row.incident" class="flex flex-wrap items-center gap-2">
                  <TierBadge :tier="row.incident.tier" />
                  <span class="text-muted-foreground">{{ orDash(row.signal) }}<template v-if="row.minutes !== null">, {{ row.minutes }} min</template></span>
                </span>
                <span v-else class="text-muted-foreground">No matching incident</span>
              </td>
              <td :class="cell">{{ ran(row) ? modeLabel(row.mode) : '-' }}</td>
              <td :class="cell">
                <span class="inline-flex items-center gap-1.5" :class="outcomeInfo(row).tone === 'bad' ? 'text-tier-high-fg' : outcomeInfo(row).tone === 'quiet' ? 'text-muted-foreground' : ''">
                  <svg v-if="outcomeInfo(row).tone === 'ok'" class="size-3.5 text-ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l6 6L20 6" /></svg>
                  <svg v-else-if="outcomeInfo(row).tone === 'bad'" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  <svg v-else class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
                  {{ outcomeInfo(row).text }}
                </span>
              </td>
              <td :class="cell">
                <span v-if="!ran(row)" class="text-muted-foreground">-</span>
                <span v-else-if="row.service_up === 1" class="inline-flex items-center gap-1.5">
                  <span class="size-2 rounded-full bg-okdot" aria-hidden="true" />
                  Up after 60 s
                </span>
                <span v-else class="inline-flex items-center gap-1.5 text-tier-high-fg">
                  <span class="size-2 rounded-full bg-tier-high-marker" aria-hidden="true" />
                  Not up
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <p class="rounded-xl bg-chip px-[18px] py-3 text-[13px] text-chipfg">
      Every request is listed, including those nobody answered (expired), rejected or skipped. Only actions that ran count as restarts or rollbacks, and only those are checked for whether the service came back.
    </p>
  </template>
</template>
