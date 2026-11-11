<script setup lang="ts">
import type { RemediationRow } from '@/types'
import { computed, ref, watch } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { clockTime, orDash, shortDate } from '@/lib/format'

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
// True while any load runs, so the Refresh button can spin for the timed polls too.
const refreshing = ref(false)

async function load() {
  const requested = hours.value
  refreshing.value = true
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
    refreshing.value = false
    if (requested === hours.value) loading.value = false
  }
}

const { refresh } = usePoll(load, 60000)

// Rows from the old range are never shown under the new one.
watch(hours, () => {
  rows.value = []
  loaded.value = false
  failed.value = false
  loading.value = true
  refresh()
})

const spinning = computed(() => loading.value || refreshing.value)

const ACTION_LABEL: Record<string, string> = { restart: 'Restart', rollback: 'Rollback' }
const actionLabel = (action: string | null) => (action ? (ACTION_LABEL[action] ?? action) : 'Restart')

// Three outcome families. ok: the action ran and the service came back. bad: the action ran and the
// service did not come back. quiet: the action did not run (safety rule, no answer or unknown value).
type Family = 'ok' | 'bad' | 'quiet'

const SKIPPED_TEXT: Record<string, string> = {
  skipped_cooldown: 'Skipped, cooldown',
  skipped_closed: 'Skipped, incident ended',
  skipped_simulated: 'Skipped, simulated',
  skipped_no_previous_image: 'Skipped, no previous image',
  skipped_no_deployment: 'Skipped, no deployment',
}
const SKIPPED_WHY: Record<string, string> = {
  skipped_cooldown: 'A recent action on the service is still in its cooldown, so nothing ran.',
  skipped_closed: 'The incident had already ended, so the service was left alone.',
  skipped_simulated: 'The deployment marker was simulated, not a real deployment, so nothing ran.',
  skipped_no_previous_image: 'There is no previous image to roll back to, so nothing ran.',
  skipped_no_deployment: 'No real deployment was found, so there is nothing to roll back.',
}

function familyOf(row: RemediationRow): Family {
  // service_up is carried on the row itself. A success without service_up 1 is not counted as worked.
  if (row.outcome === 'success') return row.service_up === 1 ? 'ok' : 'bad'
  if (row.outcome === 'failed') return 'bad'
  return 'quiet'
}

function outcomeText(row: RemediationRow): string {
  const rollback = row.action === 'rollback'
  const family = familyOf(row)
  if (family === 'ok') return rollback ? 'Rolled back, back up' : 'Restarted, back up'
  if (family === 'bad') return rollback ? 'Rolled back, not up' : 'Restarted, not up'
  switch (row.outcome) {
    case 'expired': return 'Expired'
    case 'rejected': return 'Rejected'
    default: return SKIPPED_TEXT[row.outcome ?? ''] ?? (row.outcome ?? 'Not recorded')
  }
}

function whyText(row: RemediationRow): string {
  const family = familyOf(row)
  if (family !== 'quiet') {
    const what = row.action === 'rollback' ? 'rollback' : 'restart'
    const how = row.mode === 'auto' ? ' ran automatically' : row.mode === 'approved' ? ' was approved on Telegram and ran' : ' ran'
    return family === 'ok'
      ? `The ${what}${how}, and the service was up 60 s later.`
      : `The ${what}${how}, but the service was not back 60 s later.`
  }
  switch (row.outcome) {
    case 'expired': return 'Nobody answered the question on Telegram, so nothing ran.'
    case 'rejected': return 'It was rejected on Telegram, so nothing ran.'
    default:
      if (row.outcome && SKIPPED_WHY[row.outcome]) return SKIPPED_WHY[row.outcome]
      return row.outcome ? `The outcome "${row.outcome}" is not recognised, so it is counted as not run.` : 'No outcome was logged, so it is counted as not run.'
  }
}

const workedCount = computed(() => rows.value.filter(r => familyOf(r) === 'ok').length)
const failedCount = computed(() => rows.value.filter(r => familyOf(r) === 'bad').length)
const ranCount = computed(() => workedCount.value + failedCount.value)
const notRunCount = computed(() => rows.value.length - ranCount.value)
const successRate = computed(() => (ranCount.value === 0 ? null : Math.round((workedCount.value / ranCount.value) * 100)))

type Filter = 'all' | 'ran' | 'not' | 'failed'
const filter = ref<Filter>('all')
const filters = computed<{ key: Filter, label: string }[]>(() => [
  { key: 'all', label: `All ${rows.value.length}` },
  { key: 'ran', label: `Ran ${ranCount.value}` },
  { key: 'not', label: `Not run ${notRunCount.value}` },
  { key: 'failed', label: `Failed ${failedCount.value}` },
])
const shown = computed(() => rows.value.filter((r) => {
  const family = familyOf(r)
  if (filter.value === 'ran') return family !== 'quiet'
  if (filter.value === 'not') return family === 'quiet'
  if (filter.value === 'failed') return family === 'bad'
  return true
}))

const FAMILIES: { family: Family, label: string, text: string }[] = [
  { family: 'ok', label: 'Ran and worked', text: 'The action ran and the service was up 60 s later.' },
  { family: 'bad', label: 'Ran and failed', text: 'The action ran but the service was not back. This is the only red outcome.' },
  { family: 'quiet', label: 'Not run', text: 'A safety rule stopped it, or nobody answered. Grey and dashed, always with the reason.' },
]
const PILL: Record<Family, string> = {
  ok: 'border-transparent bg-okbg text-ok',
  bad: 'border-transparent bg-tier-high-bg text-tier-high-fg',
  quiet: 'border-dashed border-input bg-transparent text-chipfg',
}

const card = 'rounded-xl border border-border p-4'
const bigNumber = 'mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]'
const cell = 'px-[18px] py-3'
const pill = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[13px] font-medium whitespace-nowrap'
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Remediation</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">Every restart and rollback request, and what happened to it</p>
    </div>
    <div class="flex flex-wrap items-center gap-2.5">
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
      <button
        type="button"
        class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3.5 text-[13px] font-medium hover:bg-chip pointer-coarse:min-h-11"
        :aria-busy="spinning"
        @click="refresh"
      >
        <svg class="size-3.5" :class="spinning ? 'animate-spin motion-reduce:animate-none' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
        {{ spinning ? 'Refreshing' : 'Refresh' }}
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
      Remediation data could not be refreshed. Showing the last loaded data.
    </p>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <section aria-label="Actions that ran" :class="card">
        <div class="text-[13px] text-muted-foreground">Actions that ran</div>
        <div class="mt-2">
          <span class="font-mono text-[28px] font-medium tracking-[-0.02em]">{{ ranCount }}</span>
          <span class="text-[13px] text-muted-foreground"> of {{ rows.length }} requests</span>
        </div>
        <div class="mt-0.5 text-xs text-muted-foreground">{{ workedCount }} came back up, {{ failedCount }} did not</div>
      </section>

      <section aria-label="Not run, by design" :class="card">
        <div class="text-[13px] text-muted-foreground">Not run, by design</div>
        <div :class="bigNumber">{{ notRunCount }}</div>
        <div class="mt-0.5 text-xs text-muted-foreground">safety rules or no answer, not failures</div>
      </section>

      <section aria-label="Success rate" :class="card">
        <div class="text-[13px] text-muted-foreground">Success rate</div>
        <div v-if="successRate !== null" :class="bigNumber">{{ successRate }}%</div>
        <div v-else class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">No actions ran</div>
        <div class="mt-0.5 text-xs text-muted-foreground">
          {{ successRate !== null ? 'of actions that ran, skips excluded' : `in the ${rangeText}` }}
        </div>
      </section>

      <section aria-label="Median time to answer" :class="card">
        <div class="text-[13px] text-muted-foreground">Median time to answer</div>
        <div class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">Not recorded yet</div>
        <div class="mt-1 text-xs text-muted-foreground">needs the Telegram question time (Phase 5 change)</div>
      </section>
    </div>

    <section aria-labelledby="restarts-title" class="overflow-hidden rounded-xl border border-border">
      <div class="flex flex-wrap items-center justify-between gap-2.5 px-[18px] py-3.5">
        <h2 id="restarts-title" class="text-[15px] font-semibold">Requests <span class="text-xs font-normal text-muted-foreground">newest first, {{ rangeText }}</span></h2>
        <div role="group" aria-label="Filter requests" class="flex flex-wrap gap-0.5 rounded-lg bg-chip p-[3px]">
          <button
            v-for="f in filters"
            :key="f.key"
            type="button"
            class="min-h-9 rounded-md px-2.5 text-[13px] md:min-h-8"
            :class="filter === f.key ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="filter === f.key"
            @click="filter = f.key"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
      <p v-if="rows.length === 0" class="border-t border-border px-[18px] py-10 text-center text-[13px] text-muted-foreground">
        No requests in this period. A restart or rollback request appears here as soon as it is sent to Telegram.
      </p>
      <p v-else-if="shown.length === 0" class="border-t border-border px-[18px] py-10 text-center text-[13px] text-muted-foreground">
        No requests match this filter in the {{ rangeText }}.
      </p>
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[860px] text-left">
          <thead class="bg-chip text-xs font-medium text-muted-foreground">
            <tr>
              <th scope="col" :class="cell" class="py-2 font-medium">Time</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Action</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Incident</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Outcome</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shown" :key="row.time" class="border-t border-border align-middle">
              <td :class="cell" class="font-mono text-[13px] whitespace-nowrap">{{ shortDate(row.time) }} {{ clockTime(row.time) }}</td>
              <td :class="cell">{{ actionLabel(row.action) }}</td>
              <td :class="cell">
                <span v-if="row.incident" class="flex flex-wrap items-center gap-2">
                  <TierBadge :tier="row.incident.tier" />
                  <span class="text-muted-foreground">{{ orDash(row.signal) }}<template v-if="row.minutes !== null">, {{ row.minutes }} min</template></span>
                </span>
                <span v-else class="text-muted-foreground">No incident matched</span>
              </td>
              <td :class="cell">
                <span :class="[pill, PILL[familyOf(row)]]">
                  <svg v-if="familyOf(row) === 'ok'" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l6 6L20 6" /></svg>
                  <svg v-else-if="familyOf(row) === 'bad'" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  <svg v-else class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
                  {{ outcomeText(row) }}
                </span>
              </td>
              <td :class="cell" class="min-w-[280px] text-[13px] text-muted-foreground">{{ whyText(row) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section aria-label="What the outcomes mean" class="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-4 rounded-xl bg-chip px-[18px] py-4">
      <div v-for="f in FAMILIES" :key="f.family" class="flex flex-col items-start gap-1.5">
        <span :class="[pill, PILL[f.family]]">
          <svg v-if="f.family === 'ok'" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l6 6L20 6" /></svg>
          <svg v-else-if="f.family === 'bad'" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          <svg v-else class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
          {{ f.label }}
        </span>
        <p class="text-[13px] text-chipfg">{{ f.text }}</p>
      </div>
    </section>
  </template>
</template>
