<script setup lang="ts">
import type { Health, LatestAnomaly } from '@/types'
import { computed, ref } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { fixed, localDateTime } from '@/lib/format'

const emit = defineEmits<{ refreshed: [ok: boolean] }>()

const health = ref<Health | null>(null)
const anomaly = ref<LatestAnomaly | null>(null)
const loading = ref(true)
const failed = ref(false)
const anomalyFailed = ref(false)

async function load() {
  const [h, a] = await Promise.allSettled([
    api.get<Health>('/api/health'),
    api.get<LatestAnomaly>('/api/anomaly/latest'),
  ])
  failed.value = h.status === 'rejected'
  if (h.status === 'fulfilled') health.value = h.value.data
  anomalyFailed.value = a.status === 'rejected'
  if (a.status === 'fulfilled') anomaly.value = a.value.data
  loading.value = false
  emit('refreshed', h.status === 'fulfilled')
}

usePoll(load, 15000)

const hasAnomaly = computed(() => anomaly.value !== null && anomaly.value.score !== undefined)
const apiOk = computed(() => health.value?.status === 'ok')

const greeting = computed(() => {
  const hour = new Date().getHours()
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
})

const chip = 'rounded-md px-2 py-px text-xs font-medium'
const okChip = `${chip} bg-okbg text-ok`
const badChip = `${chip} bg-tier-high-bg text-tier-high-fg`
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <p class="text-[13px] text-muted-foreground">{{ greeting }}</p>
      <h1 class="mt-0.5 text-2xl font-semibold tracking-[-0.02em]">Overview</h1>
    </div>
    <a href="#incidents" class="inline-flex min-h-9 items-center rounded-lg border border-border px-3.5 text-[13px] font-medium text-foreground no-underline hover:bg-chip">
      Open incidents
    </a>
  </div>

  <p v-if="failed" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    The API did not answer. Retrying every 15 seconds.
  </p>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
    <template v-if="loading">
      <Skeleton v-for="n in 3" :key="n" class="h-[116px] rounded-xl" />
    </template>

    <template v-else>
      <section aria-label="API" class="rounded-xl border border-border p-4">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] text-muted-foreground">API</span>
          <span v-if="health" :class="apiOk && !failed ? okChip : badChip">{{ apiOk && !failed ? 'OK' : 'Down' }}</span>
        </div>
        <template v-if="health">
          <div class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">{{ apiOk && !failed ? 'Answering' : 'Not answering' }}</div>
          <div class="mt-1 text-xs text-muted-foreground">Last answer {{ localDateTime(Date.parse(health.time)) }}</div>
        </template>
        <div v-else class="mt-2.5 text-[13px] text-muted-foreground">No data</div>
      </section>

      <section aria-label="InfluxDB" class="rounded-xl border border-border p-4">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] text-muted-foreground">InfluxDB</span>
          <span v-if="health" :class="health.influx ? okChip : badChip">{{ health.influx ? 'Reachable' : 'Unreachable' }}</span>
        </div>
        <template v-if="health">
          <div class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">{{ health.influx ? 'Answering' : 'Not answering' }}</div>
          <div class="mt-1 text-xs text-muted-foreground">Metrics and scores are stored here</div>
        </template>
        <div v-else class="mt-2.5 text-[13px] text-muted-foreground">No data</div>
      </section>

      <section aria-label="Latest score" class="rounded-xl border border-border p-4">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] text-muted-foreground">Latest score</span>
          <TierBadge v-if="hasAnomaly && anomaly && !anomalyFailed" :tier="anomaly.tier" />
        </div>
        <p v-if="anomalyFailed" class="mt-2.5 text-[13px] text-muted-foreground">Anomaly data unavailable. Retrying every 15 seconds.</p>
        <template v-else-if="hasAnomaly && anomaly">
          <div class="mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]">{{ fixed(anomaly.score) }}</div>
          <div class="mt-0.5 text-xs text-muted-foreground">
            threshold <span class="font-mono">{{ fixed(anomaly.threshold) }}</span><template v-if="anomaly.time">, at <span class="font-mono">{{ localDateTime(anomaly.time) }}</span></template>
          </div>
        </template>
        <p v-else class="mt-2.5 text-[13px] text-muted-foreground">No anomaly scores yet</p>
      </section>
    </template>
  </div>
</template>
