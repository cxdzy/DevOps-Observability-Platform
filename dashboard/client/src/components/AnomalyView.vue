<script setup lang="ts">
import type { AnomalyPoint, ChartWindow, EventItem, EventsResponse, Incident, StatusInfo, ZoomWindow } from '@/types'
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import ChartLoadError from '@/components/ChartLoadError.vue'
import ChartSkeleton from '@/components/ChartSkeleton.vue'
import ChartToolbar from '@/components/ChartToolbar.vue'
import EventLane from '@/components/EventLane.vue'
import PointDetail from '@/components/PointDetail.vue'
import StatusChip from '@/components/StatusChip.vue'
import SummaryCards from '@/components/SummaryCards.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { incidentAt } from '@/lib/incident'

// ECharts is most of the bundle, so the chart is downloaded only when this view first shows it.
const AnomalyChart = defineAsyncComponent({
  loader: () => import('@/components/AnomalyChart.vue'),
  loadingComponent: ChartSkeleton,
  errorComponent: ChartLoadError,
  delay: 0,
  timeout: 30000,
})

const props = defineProps<{
  points: AnomalyPoint[]
  incidents: Incident[]
  loading: boolean
  pointsFailed: boolean
  incidentsFailed: boolean
  pointsLoaded: boolean
  incidentsLoaded: boolean
}>()
// The same four ranges on every view, because the range is shared with the Incidents view.
const PRESETS = [
  { value: 6, label: '6 h', title: 'Last 6 hours' },
  { value: 24, label: '24 h', title: 'Last 24 hours' },
  { value: 72, label: '3 d', title: 'Last 3 days' },
  { value: 168, label: '7 d', title: 'Last 7 days' },
]
const FULL: ZoomWindow = { start: 0, end: 100 }

const hours = defineModel<number>('hours', { required: true })
const selected = defineModel<number | null>('selected', { required: true })

const point = computed(() =>
  selected.value === null ? null : props.points.find(p => p.time === selected.value) ?? null,
)
const incident = computed(() => (point.value ? incidentAt(props.incidents, point.value.time) : null))

// Status and events. Status is for the chip; events are for the lane and the warning lines.
const status = ref<StatusInfo | null>(null)
const statusFailed = ref(false)
const events = ref<EventItem[]>([])
const unavailable = ref<string[]>([])
const truncated = ref(false)
const eventsFailed = ref(false)
const eventsLoaded = ref(false)

async function load() {
  const wanted = hours.value
  const [s, e] = await Promise.allSettled([
    api.get<StatusInfo>('/api/status'),
    api.get<EventsResponse>('/api/events', { params: { hours: wanted } }),
  ])
  if (s.status === 'fulfilled' && typeof s.value.data === 'object' && s.value.data !== null && typeof s.value.data.state === 'string') {
    status.value = s.value.data
    statusFailed.value = false
  } else {
    statusFailed.value = true
  }
  // The range changed while this was loading; the queued load fetches the new one.
  if (wanted !== hours.value) return
  if (e.status === 'fulfilled' && Array.isArray(e.value.data?.events)) {
    events.value = e.value.data.events
    unavailable.value = Array.isArray(e.value.data.unavailable) ? e.value.data.unavailable : []
    truncated.value = e.value.data.truncated === true
    eventsFailed.value = false
    eventsLoaded.value = true
  } else {
    eventsFailed.value = true
  }
}

// Every 30 seconds, the same cycle as the scores.
const { refresh } = usePoll(load, 30000)

// Zoom state. A new range starts at the whole window, with no events of the old range.
const zoom = ref<ZoomWindow>({ ...FULL })
const laneWindow = ref<ChartWindow | null>(null)
watch(hours, () => {
  zoom.value = { ...FULL }
  events.value = []
  unavailable.value = []
  truncated.value = false
  eventsFailed.value = false
  eventsLoaded.value = false
  laneWindow.value = null
  refresh()
})

// The narrowest zoom is about 10 minutes of the loaded range.
const minSpan = computed(() => Math.min(50, Math.max(0.05, (10 / (hours.value * 60)) * 100)))
function setZoom(start: number, end: number) {
  let span = Math.max(minSpan.value, Math.min(100, end - start))
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
const atMin = computed(() => span.value <= minSpan.value + 0.001)
// Without a chart the zoom buttons do nothing, but the range presets stay usable, so a range
// with no data can still be left.
const noChart = computed(() => props.loading || props.points.length === 0)

const warnings = computed(() => events.value.filter(e => e.kind === 'early_warning').map(e => e.time))

const warning = 'rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg'
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-semibold tracking-[-0.02em]">Anomaly scores</h1>
        <StatusChip :status="status" :failed="statusFailed" />
      </div>
      <p class="mt-0.5 text-[13px] text-muted-foreground">One score per minute, local time</p>
    </div>
    <ChartToolbar
      v-model="hours"
      :presets="PRESETS"
      :at-full="noChart || atFull"
      :at-min="noChart || atMin"
      :at-start="noChart || zoom.start <= 0.01"
      :at-end="noChart || zoom.end >= 99.99"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @earlier="earlier"
      @later="later"
      @reset="reset"
    />
  </div>

  <template v-if="loading">
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <Skeleton v-for="n in 4" :key="n" class="h-[116px] rounded-xl" />
    </div>
    <ChartSkeleton />
  </template>

  <p v-else-if="pointsFailed && !pointsLoaded" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    Anomaly data unavailable. Retrying every 30 seconds.
  </p>

  <template v-else>
    <p v-if="pointsFailed" :class="warning" role="status">
      Anomaly data could not be refreshed. Showing the last loaded data.
    </p>

    <SummaryCards :points="points" :incidents="incidents" :incidents-failed="incidentsFailed && !incidentsLoaded" />

    <p v-if="incidentsFailed" :class="warning" role="status">
      {{ incidentsLoaded ? 'Incident details could not be refreshed. Showing the last loaded data.' : 'Incident details unavailable' }}
    </p>

    <div class="flex flex-wrap items-stretch gap-4">
      <section aria-label="Anomaly score chart" class="min-w-0 flex-[2_1_520px] rounded-xl border border-border px-[18px] py-4">
        <div class="mb-2">
          <h2 class="text-[15px] font-semibold">Score over time</h2>
          <p class="text-xs text-muted-foreground">Click a minute to see its details</p>
        </div>
        <p v-if="points.length === 0" class="py-16 text-center text-[13px] text-muted-foreground">No data in this range</p>
        <template v-else>
          <AnomalyChart
            :points="points"
            :hours="hours"
            :selected="selected"
            :zoom="zoom"
            :warnings="warnings"
            @select="selected = $event"
            @zoom="onChartZoom"
            @window="laneWindow = $event"
          />
          <p v-if="eventsFailed && !eventsLoaded" class="mt-2 text-xs text-muted-foreground" role="status">
            Events could not be loaded. Retrying in 30 s.
          </p>
          <EventLane v-else class="mt-2" :events="events" :window="laneWindow" :unavailable="unavailable" :truncated="truncated" />
        </template>
      </section>
      <PointDetail class="min-w-0 flex-[1_1_280px]" :point="point" :incident="incident" />
    </div>
  </template>
</template>
