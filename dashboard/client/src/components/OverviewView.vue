<script setup lang="ts">
import type { ActivityItem, AnomalyPoint, Health, Incident, LatestAnomaly, NodeInfo, ServicesInfo } from '@/types'
import { computed, defineAsyncComponent, ref } from 'vue'
import ChartLoadError from '@/components/ChartLoadError.vue'
import ChartSkeleton from '@/components/ChartSkeleton.vue'
import NodeCard from '@/components/NodeCard.vue'
import RecentActivity from '@/components/RecentActivity.vue'
import ServicesTable from '@/components/ServicesTable.vue'
import TierBadge from '@/components/TierBadge.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { fixed, localDateTime } from '@/lib/format'
import { FLAG_TIERS, TIER_STYLE, toTier } from '@/lib/tier'

// ECharts is large, so the metric chart is downloaded only when it is first shown.
const MetricChart = defineAsyncComponent({
  loader: () => import('@/components/MetricChart.vue'),
  loadingComponent: ChartSkeleton,
  errorComponent: ChartLoadError,
  delay: 0,
  timeout: 30000,
})

const emit = defineEmits<{ refreshed: [ok: boolean] }>()

const HOURS = 6

// Each source keeps its last good value; failed says the latest load of it did not work.
function source<T>(initial: T) {
  return { data: ref(initial) as { value: T }, loaded: ref(false), failed: ref(false) }
}
const health = source<Health | null>(null)
const latest = source<LatestAnomaly | null>(null)
const incidents = source<Incident[]>([])
const points = source<AnomalyPoint[]>([])
const nodes = source<NodeInfo[]>([])
const services = source<ServicesInfo | null>(null)
const activity = source<ActivityItem[]>([])
const loading = ref(true)

function apply<T>(s: ReturnType<typeof source<T>>, result: PromiseSettledResult<{ data: T }>, valid: (v: unknown) => boolean) {
  s.failed.value = result.status === 'rejected' || !valid(result.value.data)
  if (!s.failed.value && result.status === 'fulfilled') {
    s.data.value = result.value.data
    s.loaded.value = true
  }
}

const isObject = (v: unknown) => typeof v === 'object' && v !== null
const isArray = (v: unknown) => Array.isArray(v)

async function load() {
  const params = { hours: HOURS }
  const [h, l, i, p, n, s, a] = await Promise.allSettled([
    api.get<Health>('/api/health'),
    api.get<LatestAnomaly>('/api/anomaly/latest'),
    api.get<Incident[]>('/api/incidents', { params }),
    api.get<AnomalyPoint[]>('/api/anomaly', { params }),
    api.get<NodeInfo[]>('/api/nodes'),
    api.get<ServicesInfo>('/api/services'),
    api.get<ActivityItem[]>('/api/activity'),
  ])
  apply(health, h, isObject)
  apply(latest, l, isObject)
  apply(incidents, i, isArray)
  apply(points, p, isArray)
  apply(nodes, n, isArray)
  apply(services, s, v => isObject(v) && isArray((v as ServicesInfo).expected) && isArray((v as ServicesInfo).containers))
  apply(activity, a, isArray)
  loading.value = false
  emit('refreshed', h.status === 'fulfilled')
}

// Every 30 seconds; a tick is skipped while the previous load is still running.
usePoll(load, 30000)

const greeting = computed(() => {
  const hour = new Date().getHours()
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
})

const mainNode = computed(() => nodes.data.value.find(n => n.key === 'main') ?? null)

// cAdvisor named no container at all, so which services run is not known.
const servicesUnknown = computed(() => services.data.value?.unknown === true)

// Services: expected containers that are running, and how many are expected.
const serviceCount = computed(() => {
  const s = services.data.value
  if (!s || s.unknown) return null
  const running = new Set(s.containers.map(c => c.name))
  return { up: s.expected.filter(e => running.has(e.name)).length, total: s.expected.length }
})

const openIncident = computed(() => incidents.data.value.some(i => i.status === 'open'))
const tierCounts = computed(() =>
  FLAG_TIERS.map(tier => ({ tier, count: incidents.data.value.filter(i => toTier(i.tier) === tier).length })),
)

// Normal unless an incident is open or an expected service is missing. Without incident or
// service data the status cannot be known, so it says so instead of claiming Normal.
const status = computed(() => {
  const count = serviceCount.value
  const known = incidents.loaded.value && count !== null
  if (openIncident.value) return { chip: 'Incident', ok: false, title: 'Incident open', line: 'See Incidents for the details' }
  if (count && count.up < count.total) {
    const missing = count.total - count.up
    return { chip: 'Attention', ok: false, title: `${missing} ${missing === 1 ? 'service' : 'services'} missing`, line: 'See the services table below' }
  }
  if (!known) {
    const line = servicesUnknown.value ? 'Container metrics are not available' : 'Incidents or services did not load'
    return { chip: 'Unknown', ok: null, title: 'No data', line }
  }
  return { chip: 'Normal', ok: true, title: 'All systems normal', line: 'No incident open, every service up' }
})

const hasScore = computed(() => latest.data.value !== null && latest.data.value.score !== undefined)

const reporting = computed(() => nodes.data.value.filter(n => n.up === true).length)

const chip = 'rounded-md px-2 py-px text-xs font-medium'
const card = 'rounded-xl border border-border p-4'
const bigNumber = 'mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]'
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

  <p v-if="health.failed.value" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    The API did not answer. Retrying in 30 s.
  </p>
  <p v-else-if="health.data.value && !health.data.value.influx" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
    InfluxDB did not answer. Scores, incidents and activity may be out of date.
  </p>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
    <template v-if="loading">
      <Skeleton v-for="n in 4" :key="n" class="h-[116px] rounded-xl" />
    </template>

    <template v-else>
      <section aria-label="Status" :class="card">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] text-muted-foreground">Status</span>
          <span
            :class="[chip, status.ok === true ? 'bg-okbg text-ok' : status.ok === false ? 'bg-tier-high-bg text-tier-high-fg' : 'bg-chip text-chipfg']"
          >{{ status.chip }}</span>
        </div>
        <div class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">{{ status.title }}</div>
        <div class="mt-1 text-xs text-muted-foreground">{{ status.line }}</div>
      </section>

      <section aria-label="Latest score" :class="card">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] text-muted-foreground">Latest score</span>
          <TierBadge v-if="hasScore && latest.data.value" :tier="latest.data.value.tier" />
        </div>
        <template v-if="hasScore && latest.data.value">
          <div :class="bigNumber">{{ fixed(latest.data.value.score) }}</div>
          <div class="mt-0.5 text-xs text-muted-foreground">
            threshold <span class="font-mono">{{ fixed(latest.data.value.threshold) }}</span><template v-if="latest.data.value.model">, model <span class="font-mono">{{ latest.data.value.model }}</span></template>
          </div>
          <div v-if="latest.data.value.time" class="text-xs text-muted-foreground">at <span class="font-mono">{{ localDateTime(latest.data.value.time) }}</span></div>
        </template>
        <p v-else-if="latest.failed.value" class="mt-2.5 text-[13px] text-muted-foreground">No data. Retrying in 30 s.</p>
        <p v-else class="mt-2.5 text-[13px] text-muted-foreground">No anomaly scores yet</p>
      </section>

      <section aria-label="Incidents in the last 6 hours" :class="card">
        <div class="text-[13px] text-muted-foreground">Incidents, last 6 h</div>
        <template v-if="incidents.loaded.value">
          <div :class="bigNumber">{{ incidents.data.value.length }}</div>
          <div class="mt-1 flex flex-wrap gap-1.5">
            <span v-for="c in tierCounts" :key="c.tier" class="rounded-md px-1.5 text-[11px] font-semibold" :class="TIER_STYLE[c.tier].badgeClass">
              {{ c.count }} {{ TIER_STYLE[c.tier].label }}
            </span>
          </div>
        </template>
        <p v-else class="mt-2.5 text-[13px] text-muted-foreground">No data. Retrying in 30 s.</p>
      </section>

      <section aria-label="Services up" :class="card">
        <div class="text-[13px] text-muted-foreground">Services up</div>
        <template v-if="serviceCount">
          <div class="mt-2">
            <span class="font-mono text-[28px] font-medium tracking-[-0.02em]">{{ serviceCount.up }}</span>
            <span class="text-[13px] text-muted-foreground"> of {{ serviceCount.total }}</span>
          </div>
          <div v-if="mainNode?.hostname" class="mt-0.5 text-xs text-muted-foreground">on <span class="font-mono">{{ mainNode.hostname }}</span></div>
        </template>
        <template v-else-if="servicesUnknown">
          <div class="mt-2 text-[22px] font-semibold tracking-[-0.02em]">No data</div>
          <div class="mt-1 text-xs text-muted-foreground">Container metrics are not available</div>
        </template>
        <p v-else class="mt-2.5 text-[13px] text-muted-foreground">No data. Retrying in 30 s.</p>
      </section>
    </template>
  </div>

  <section aria-labelledby="nodes-title" class="flex flex-col gap-3">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="nodes-title" class="text-[15px] font-semibold">Nodes</h2>
      <span v-if="nodes.loaded.value" class="text-xs text-muted-foreground">{{ reporting }} of {{ nodes.data.value.length }} reporting</span>
    </div>
    <div v-if="loading" class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-4">
      <Skeleton v-for="n in 2" :key="n" class="h-[220px] rounded-xl" />
    </div>
    <p v-else-if="nodes.failed.value && !nodes.loaded.value" class="rounded-xl border border-border p-4 text-[13px] text-muted-foreground" role="status">
      Prometheus did not answer. Retrying in 30 s.
    </p>
    <template v-else>
      <p v-if="nodes.failed.value" class="text-xs text-muted-foreground" role="status">Could not refresh. Showing the last loaded values.</p>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-4">
        <NodeCard v-for="node in nodes.data.value" :key="node.key" :node="node" />
      </div>
    </template>
  </section>

  <div class="flex flex-wrap items-stretch gap-4">
    <section aria-label="Service metrics" class="min-w-0 flex-[2_1_520px] rounded-xl border border-border px-[18px] py-4">
      <ChartSkeleton v-if="loading" />
      <p v-else-if="points.failed.value && !points.loaded.value" class="py-16 text-center text-[13px] text-muted-foreground" role="status">
        Metric data unavailable. Retrying in 30 s.
      </p>
      <p v-else-if="points.data.value.length === 0" class="py-16 text-center text-[13px] text-muted-foreground">
        No sample-service data in the last 6 hours
      </p>
      <MetricChart v-else :points="points.data.value" />
    </section>
    <RecentActivity
      class="min-w-0 flex-[1_1_300px]"
      :items="activity.data.value"
      :loading="loading"
      :failed="activity.failed.value"
      :loaded="activity.loaded.value"
    />
  </div>

  <!-- Shown instead of the table, which would otherwise list every expected service as missing. -->
  <section v-if="!loading && servicesUnknown" aria-labelledby="services-title" class="overflow-hidden rounded-xl border border-border">
    <h2 id="services-title" class="px-[18px] py-3.5 text-[15px] font-semibold">
      Services<template v-if="mainNode?.hostname"> on <span class="font-mono">{{ mainNode.hostname }}</span></template>
    </h2>
    <p class="mx-[18px] mb-4 rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
      Container metrics are not available. Check that cAdvisor is running.
    </p>
  </section>
  <ServicesTable
    v-else
    :services="services.data.value"
    :host="mainNode?.hostname ?? null"
    :loading="loading"
    :failed="services.failed.value"
  />
</template>
