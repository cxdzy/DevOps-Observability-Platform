<script setup lang="ts">
import type { ContainerForecast } from '@/composables/useApi'
import type { ActivityItem, DeploymentRun, DeploymentsResponse, AnomalyPoint, ChartWindow, EventsResponse, Health, Incident, LatestAnomaly, NodeInfo, ProjectRow, ServicesInfo, StatusInfo, ZoomWindow } from '@/types'
import { computed, defineAsyncComponent, ref } from 'vue'
import ChartLoadError from '@/components/ChartLoadError.vue'
import ChartSkeleton from '@/components/ChartSkeleton.vue'
import ChartToolbar from '@/components/ChartToolbar.vue'
import EventLane from '@/components/EventLane.vue'
import ProjectsSection from '@/components/ProjectsSection.vue'
import RecentActivity from '@/components/RecentActivity.vue'
import ServersSection from '@/components/ServersSection.vue'
import ServicesTable from '@/components/ServicesTable.vue'
import StatusChip from '@/components/StatusChip.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, getForecast, usePoll } from '@/composables/useApi'
import { useAuth } from '@/composables/useAuth'
import { buildActivityRows, filterOptions, restartsLast24h } from '@/lib/overviewActivity'
import { containersCard, fleetSubtitle, incidentsNote, projectCards, projectsCard, statusCard } from '@/lib/overviewFleet'
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
const serviceStatus = source<StatusInfo | null>(null)
const events = source<EventsResponse>({ events: [], unavailable: [] })
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
  const [h, l, i, p, n, s, a, st, ev] = await Promise.allSettled([
    api.get<Health>('/api/health'),
    api.get<LatestAnomaly>('/api/anomaly/latest'),
    api.get<Incident[]>('/api/incidents', { params }),
    api.get<AnomalyPoint[]>('/api/anomaly', { params }),
    api.get<NodeInfo[]>('/api/nodes'),
    api.get<ServicesInfo>('/api/services'),
    api.get<ActivityItem[]>('/api/activity'),
    api.get<StatusInfo>('/api/status'),
    api.get<EventsResponse>('/api/events', { params }),
  ])
  apply(health, h, isObject)
  apply(latest, l, isObject)
  apply(incidents, i, isArray)
  apply(points, p, isArray)
  apply(nodes, n, isArray)
  apply(services, s, v => isObject(v) && isArray((v as ServicesInfo).expected) && isArray((v as ServicesInfo).containers))
  apply(activity, a, isArray)
  apply(serviceStatus, st, v => isObject(v) && typeof (v as StatusInfo).state === 'string')
  apply(events, ev, v => isObject(v) && isArray((v as EventsResponse).events))
  loading.value = false
  emit('refreshed', h.status === 'fulfilled')
}

// Every 30 seconds; a tick is skipped while the previous load is still running.
usePoll(load, 30000)

// Projects and the forecast have their own polls. The projects route queries Prometheus for each
// server, so it must not delay the summary cards. A forecast failure only means no forecast chip.
const projects = ref<ProjectRow[]>([])
const projectsLoading = ref(true)
const projectsLoaded = ref(false)
const projectsFailed = ref(false)
let runKeys = ''
async function loadProjects() {
  try {
    const res = await api.get<ProjectRow[]>('/api/projects')
    if (!Array.isArray(res.data)) throw new Error('unexpected response')
    projects.value = res.data.map(p => ({ ...p, containers: Array.isArray(p.containers) ? p.containers : [] }))
    projectsLoaded.value = true
    projectsFailed.value = false
    // Fetch detected deployments as soon as the image projects are known, not on the next tick.
    const keys = projects.value.filter(p => p.deploySource === 'image').map(p => p.key).join(',')
    if (keys !== runKeys) {
      runKeys = keys
      void loadRuns()
    }
  } catch {
    projectsFailed.value = true
  } finally {
    projectsLoading.value = false
  }
}
usePoll(loadProjects, 30000)

const forecasts = ref<ContainerForecast[]>([])
async function loadForecast() {
  try {
    forecasts.value = (await getForecast()).containers
  } catch {
    // Keep the last forecast; without one the rows simply show no chip.
  }
}
usePoll(loadForecast, 30000)

// Detected deployments of image projects for the activity list. Each project has its own request,
// and a failed one only leaves that project without detected rows.
const runsByProject = ref<Record<string, DeploymentRun[]>>({})
async function loadRuns() {
  const keys = projects.value.filter(p => p.deploySource === 'image').map(p => p.key)
  const next: Record<string, DeploymentRun[]> = {}
  await Promise.all(keys.map(async (key) => {
    try {
      const res = await api.get<DeploymentsResponse>('/api/deployments', { params: { project: key, days: 7 } })
      next[key] = Array.isArray(res.data?.runs) ? res.data.runs : []
    } catch {
      next[key] = runsByProject.value[key] ?? []
    }
  }))
  runsByProject.value = next
}
usePoll(loadRuns, 30000)

const { me } = useAuth()
const isAdmin = computed(() => me.value?.role === 'admin')

const cardList = computed(() => projectCards(projects.value, { latest: latest.data.value, incidents: incidents.data.value, forecasts: forecasts.value }))
// Expected platform services that are not running, from the services table data.
const missingServices = computed(() => {
  const s = services.data.value
  if (!s || s.unknown) return 0
  const running = new Set(s.containers.map(c => c.name))
  return s.expected.filter(e => !running.has(e.name)).length
})
const subtitle = computed(() => (projectsLoaded.value && nodes.loaded.value ?fleetSubtitle(projects.value, nodes.data.value.length) : ''))
const statusInfo = computed(() => statusCard({
  projects: projects.value,
  nodes: nodes.data.value,
  openIncident: openIncident.value,
  incidentsKnown: incidents.loaded.value && projectsLoaded.value && nodes.loaded.value,
  projectsKnown: projectsLoaded.value,
  missingServices: missingServices.value,
}))
const projectsInfo = computed(() => projectsCard(projects.value, isAdmin.value))
const containersInfo = computed(() => containersCard(nodes.data.value, services.data.value))
const activityRows = computed(() => buildActivityRows(activity.data.value, projects.value, runsByProject.value))
const activityOptions = computed(() => filterOptions(projects.value))
const restartsByProject = computed(() => Object.fromEntries(projects.value.map(p => [p.key, restartsLast24h(p)])))

// Zoom of the service chart; the narrowest window is about 10 minutes of the 6 hours.
const PRESETS = [{ value: HOURS, label: '6 h', title: 'Last 6 hours' }]
const FULL: ZoomWindow = { start: 0, end: 100 }
const MIN_SPAN = (10 / (HOURS * 60)) * 100
const chartHours = ref(HOURS)
const zoom = ref<ZoomWindow>({ ...FULL })
const laneWindow = ref<ChartWindow | null>(null)
function setZoom(start: number, end: number) {
  let span = Math.max(MIN_SPAN, Math.min(100, end - start))
  let s = Math.max(0, Math.min(100 - span, start))
  if (span >= 100) {
    s = 0
    span = 100
  }
  zoom.value = { start: s, end: s + span }
}
const span = computed(() => zoom.value.end - zoom.value.start)
const centre = computed(() => (zoom.value.start + zoom.value.end) / 2)
const zoomIn = () => setZoom(centre.value - span.value / 4, centre.value + span.value / 4)
const zoomOut = () => setZoom(centre.value - span.value, centre.value + span.value)
const earlier = () => setZoom(zoom.value.start - span.value / 4, zoom.value.end - span.value / 4)
const later = () => setZoom(zoom.value.start + span.value / 4, zoom.value.end + span.value / 4)
const reset = () => { zoom.value = { ...FULL } }
function onChartZoom(z: ZoomWindow) {
  if (Math.abs(z.start - zoom.value.start) < 0.01 && Math.abs(z.end - zoom.value.end) < 0.01) return
  zoom.value = { start: z.start, end: z.end }
}
const atFull = computed(() => zoom.value.start <= 0.01 && zoom.value.end >= 99.99)
const atMin = computed(() => span.value <= MIN_SPAN + 0.001)
const warnings = computed(() => events.data.value.events.filter(e => e.kind === 'early_warning').map(e => e.time))

const greeting = computed(() => {
  const hour = new Date().getHours()
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
})

const mainNode = computed(() => nodes.data.value.find(n => n.key === 'main') ?? null)

// cAdvisor named no container at all, so which services run is not known.
const servicesUnknown = computed(() => services.data.value?.unknown === true)

const openIncident = computed(() => incidents.data.value.some(i => i.status === 'open'))
const tierCounts = computed(() =>
  FLAG_TIERS.map(tier => ({ tier, count: incidents.data.value.filter(i => toTier(i.tier) === tier).length })),
)

const chip = 'rounded-md px-2 py-px text-xs font-medium'
const card = 'rounded-xl border border-border p-4'
const bigNumber = 'mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]'
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <p class="text-[13px] text-muted-foreground">{{ greeting }}</p>
      <div class="mt-0.5 flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-semibold tracking-[-0.02em]">Overview</h1>
        <StatusChip :status="serviceStatus.data.value" :failed="serviceStatus.failed.value" />
      </div>
      <p v-if="subtitle" class="mt-1 text-[13px] text-muted-foreground">{{ subtitle }}</p>
    </div>
    <a href="#incidents" class="inline-flex min-h-9 items-center rounded-lg border border-border px-3.5 text-[13px] font-medium text-foreground no-underline hover:bg-chip">
      Open incidents
    </a>
  </div>

  <StatusChip
    v-if="serviceStatus.failed.value || (serviceStatus.data.value && serviceStatus.data.value.state !== 'normal')"
    variant="banner"
    :status="serviceStatus.data.value"
    :failed="serviceStatus.failed.value"
  />

  <p v-if="health.failed.value" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    The API did not answer. Retrying in 30 s.
  </p>
  <p v-else-if="health.data.value && !health.data.value.influx" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
    InfluxDB did not answer. Scores, incidents and activity may be out of date.
  </p>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-4">
    <template v-if="loading">
      <Skeleton v-for="n in 4" :key="n" class="h-[132px] rounded-xl" />
    </template>

    <template v-else>
      <section aria-label="Status" :class="card">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] text-muted-foreground">Status</span>
          <span
            :class="[chip, statusInfo.ok === true ? 'bg-okbg text-ok' : statusInfo.ok === false ? 'bg-tier-high-bg text-tier-high-fg' : 'bg-chip text-chipfg']"
          >{{ statusInfo.chip }}</span>
        </div>
        <div class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">{{ statusInfo.title }}</div>
        <div class="mt-1 text-xs text-muted-foreground">{{ statusInfo.line }}</div>
      </section>

      <section aria-label="Projects" :class="card">
        <div class="text-[13px] text-muted-foreground">Projects</div>
        <template v-if="projectsLoaded">
          <div :class="bigNumber">{{ projectsInfo.count }}</div>
          <div class="mt-0.5 text-xs text-muted-foreground">{{ projectsInfo.line }}</div>
          <a v-if="projectsInfo.addHint" href="#settings" class="mt-1 inline-flex rounded text-xs text-muted-foreground underline underline-offset-3 hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:items-center">{{ projectsInfo.addHint }}</a>
        </template>
        <p v-else class="mt-2.5 text-[13px] text-muted-foreground">No data. Retrying in 30 s.</p>
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
          <div v-if="projectsLoaded" class="mt-1.5 text-xs text-muted-foreground">{{ incidentsNote(projects) }}</div>
        </template>
        <p v-else class="mt-2.5 text-[13px] text-muted-foreground">No data. Retrying in 30 s.</p>
      </section>

      <section aria-label="Containers running" :class="card">
        <div class="text-[13px] text-muted-foreground">Containers running</div>
        <template v-if="containersInfo.total !== null">
          <div :class="bigNumber">{{ containersInfo.total }}</div>
          <div v-for="line in containersInfo.lines" :key="line" class="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{{ line }}</div>
        </template>
        <p v-else class="mt-2.5 text-[13px] text-muted-foreground">No data. Retrying in 30 s.</p>
      </section>
    </template>
  </div>

  <ProjectsSection
    :projects="cardList"
    :loading="projectsLoading"
    :loaded="projectsLoaded"
    :failed="projectsFailed"
    :is-admin="isAdmin"
  />

  <div class="flex flex-wrap items-stretch gap-4">
    <section aria-label="Service metrics" class="min-w-0 flex-[2_1_520px] rounded-xl border border-border px-[18px] py-4">
      <ChartSkeleton v-if="loading" />
      <p v-else-if="points.failed.value && !points.loaded.value" class="py-16 text-center text-[13px] text-muted-foreground" role="status">
        Metric data unavailable. Retrying in 30 s.
      </p>
      <p v-else-if="points.data.value.length === 0" class="py-16 text-center text-[13px] text-muted-foreground">
        No sample-service data in the last 6 hours
      </p>
      <template v-else>
        <MetricChart
          :points="points.data.value"
          :zoom="zoom"
          :warnings="warnings"
          @zoom="onChartZoom"
          @window="laneWindow = $event"
        />
        <p v-if="events.failed.value && !events.loaded.value" class="mt-2 text-xs text-muted-foreground" role="status">
          Events could not be loaded. Retrying in 30 s.
        </p>
        <EventLane v-else class="mt-2" :events="events.data.value.events" :window="laneWindow" :unavailable="events.data.value.unavailable" :truncated="events.data.value.truncated === true" />
        <div class="mt-3 flex justify-end">
          <ChartToolbar
            v-model="chartHours"
            :presets="PRESETS"
            :at-full="atFull"
            :at-min="atMin"
            :at-start="zoom.start <= 0.01"
            :at-end="zoom.end >= 99.99"
            @zoom-in="zoomIn"
            @zoom-out="zoomOut"
            @earlier="earlier"
            @later="later"
            @reset="reset"
          />
        </div>
      </template>
    </section>
    <RecentActivity
      class="min-w-0 flex-[1_1_300px]"
      :rows="activityRows"
      :options="activityOptions"
      :restarts-by-project="restartsByProject"
      :loading="loading"
      :failed="activity.failed.value"
      :loaded="activity.loaded.value"
      :projects-failed="projectsFailed"
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

  <ServersSection
    :nodes="nodes.data.value"
    :projects="projects"
    :loading="loading"
    :failed="nodes.failed.value"
    :loaded="nodes.loaded.value"
  />
</template>
