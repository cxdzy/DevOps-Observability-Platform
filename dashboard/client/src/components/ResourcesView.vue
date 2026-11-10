<script setup lang="ts">
import type { ResourcesInfo, ZoomWindow } from '@/types'
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import ChartLoadError from '@/components/ChartLoadError.vue'
import ChartSkeleton from '@/components/ChartSkeleton.vue'
import ChartToolbar from '@/components/ChartToolbar.vue'
import ResourceGauge from '@/components/ResourceGauge.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { clockTime, shortDate } from '@/lib/format'

// ECharts is large, so the history charts are downloaded only when they are first shown.
const ResourceChart = defineAsyncComponent({
  loader: () => import('@/components/ResourceChart.vue'),
  loadingComponent: ChartSkeleton,
  errorComponent: ChartLoadError,
  delay: 0,
  timeout: 30000,
})

const emit = defineEmits<{ refreshed: [ok: boolean] }>()

type NodeKey = 'main' | 'old'

// The windows /api/resources accepts.
const PRESETS = [
  { value: 1, label: '1 h', title: 'Last hour' },
  { value: 6, label: '6 h', title: 'Last 6 hours' },
  { value: 24, label: '24 h', title: 'Last 24 hours' },
  { value: 72, label: '3 d', title: 'Last 3 days' },
  { value: 168, label: '7 d', title: 'Last 7 days' },
]
// All four charts share this ECharts group, so zoom and pan move them together.
const GROUP = 'resources-history'
// The narrowest zoom, in percent of the window (about 10 of the 360 points).
const MIN_SPAN = 3
const FULL: ZoomWindow = { start: 0, end: 100 }

const node = ref<NodeKey>('main')
const hours = ref(6)
const data = ref<ResourcesInfo | null>(null)
const loading = ref(true)
const failed = ref(false)
const zoom = ref<ZoomWindow>({ ...FULL })
// Both servers with their status, from the last answer. The names are the fixed display names
// from the server until the first answer arrives.
const nodes = ref<{ key: NodeKey, displayName: string, up: boolean | null }[]>([
  { key: 'main', displayName: 'fyp-main', up: null },
  { key: 'old', displayName: 'staging', up: null },
])

function valid(v: unknown): v is ResourcesInfo {
  const r = v as ResourcesInfo
  return typeof r === 'object' && r !== null && typeof r.now === 'object' && typeof r.facts === 'object' && typeof r.history === 'object' && Array.isArray(r.nodes)
}

async function load() {
  const wanted = { node: node.value, hours: hours.value }
  loading.value = true
  try {
    const res = await api.get<ResourcesInfo>('/api/resources', { params: wanted })
    // The selection changed while this was loading; the queued load fetches the new one.
    if (wanted.node !== node.value || wanted.hours !== hours.value) return
    if (!valid(res.data)) throw new Error('unexpected response')
    data.value = res.data
    nodes.value = res.data.nodes
    failed.value = false
    emit('refreshed', true)
  } catch {
    if (wanted.node !== node.value || wanted.hours !== hours.value) return
    failed.value = true
    emit('refreshed', false)
  } finally {
    loading.value = false
  }
}

// Every 30 seconds; a tick is skipped while the previous load is still running.
const { refresh } = usePoll(load, 30000)

// Another server shows nothing of the old one while it loads. A new window keeps the gauges and
// starts the charts at the whole window.
watch(node, () => {
  data.value = null
  failed.value = false
  zoom.value = { ...FULL }
  refresh()
})
watch(hours, () => {
  zoom.value = { ...FULL }
  refresh()
})

// The Refresh button spins while a load runs, including the 30 second ones.
const spinning = computed(() => loading.value)

// Zoom controls. Each one computes the next window from the current one.
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

// Formatting. Memory and disk sizes in binary gigabytes.
function gib(bytes: number | null): string {
  if (bytes === null) return 'No data'
  const g = bytes / 1024 ** 3
  return g >= 100 ? g.toFixed(0) : g.toFixed(1).replace(/\.0$/, '')
}
function uptime(seconds: number | null): string {
  if (seconds === null || seconds < 0) return 'No data'
  const hoursUp = seconds / 3600
  if (hoursUp < 1) return `${Math.max(1, Math.round(seconds / 60))} min`
  if (hoursUp < 48) return `${Math.round(hoursUp)} h`
  const days = hoursUp / 24
  if (days < 14) return `${days.toFixed(1)} days`
  return `${(days / 7).toFixed(1)} weeks`
}
const pct = (share: number | null) => (share === null ? null : share * 100)
// Both ends of the shown window. The date is included when the loaded window is 24 h or longer,
// or the two ends fall on different calendar days, so 24 h never reads "01:10 to 01:10".
function rangeLabel(from: number, to: number): string {
  const a = new Date(from)
  const b = new Date(to)
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const withDate = hours.value >= 24 || !sameDay
  const stamp = (ms: number) => (withDate ? `${shortDate(ms)} ${clockTime(ms)}` : clockTime(ms))
  return `Showing ${stamp(from)} to ${stamp(to)}`
}

const nodeLine = computed(() => {
  const d = data.value
  if (!d) return ''
  const place = [d.provider, d.location].filter(Boolean).join(' ')
  return [d.displayName, d.hostname, place, `${d.role.toLowerCase()} server`].filter(Boolean).join(', ')
})

const gauges = computed(() => {
  const d = data.value
  if (!d) return []
  const { now, facts } = d
  const used = (share: number | null, total: number | null) => (share === null || total === null ? null : share * total)
  const sizes = (share: number | null, total: number | null) =>
    share === null || total === null ? 'Size not reported' : `${gib(used(share, total))} of ${gib(total)} GiB`
  let swapDetail = sizes(now.swapUsed, facts.swapTotalBytes)
  if (facts.swapTotalBytes === 0) swapDetail = 'No swap on this server'
  else if (facts.swapTotalBytes === null) swapDetail = 'Swap not reported'
  return [
    { label: 'CPU busy', percent: pct(now.cpuBusy), detail: facts.cores === null ? 'Cores not reported' : `of ${facts.cores} ${facts.cores === 1 ? 'core' : 'cores'}` },
    { label: 'System load', percent: pct(now.loadPerCore), detail: '1 min load per core' },
    { label: 'Memory used', percent: pct(now.memoryUsed), detail: sizes(now.memoryUsed, facts.memoryTotalBytes) },
    { label: 'Swap used', percent: pct(now.swapUsed), detail: swapDetail },
    { label: 'Root disk used', percent: pct(now.diskUsed), detail: sizes(now.diskUsed, facts.rootSizeBytes) },
  ]
})

function barClass(p: number) {
  return p >= 90 ? 'bg-red' : p >= 70 ? 'bg-amber' : 'bg-okdot'
}
const pressure = computed(() => {
  const p = data.value?.now.pressure
  if (!p) return []
  return [
    { label: 'CPU', value: p.cpu },
    { label: 'Memory', value: p.memory },
    { label: 'I/O', value: p.io },
  ].map(r => ({
    ...r,
    text: r.value === null ? 'No data' : `${r.value.toFixed(1)}%`,
    // The bar is to scale: 100 percent is waiting the whole minute. Any value above 0 shows a sliver.
    width: r.value === null ? 0 : r.value > 0 ? Math.max(2, Math.min(100, r.value)) : 0,
  }))
})

const facts = computed(() => {
  const f = data.value?.facts
  if (!f) return []
  return [
    { label: 'CPU cores', value: f.cores === null ? 'No data' : String(f.cores) },
    { label: 'Memory', value: f.memoryTotalBytes === null ? 'No data' : `${gib(f.memoryTotalBytes)} GiB` },
    { label: 'Swap', value: f.swapTotalBytes === null ? 'No data' : f.swapTotalBytes === 0 ? 'None' : `${gib(f.swapTotalBytes)} GiB` },
    { label: 'Root disk', value: f.rootSizeBytes === null ? 'No data' : `${gib(f.rootSizeBytes)} GiB` },
    { label: 'Containers', value: f.containers === null ? 'No data' : `${f.containers} running` },
    { label: 'Up for', value: uptime(f.uptimeSeconds) },
  ]
})

const charts = computed(() => {
  const h = data.value?.history
  if (!h) return []
  return [
    { title: 'CPU busy', kind: 'percent' as const, description: 'CPU busy percent', series: [{ name: 'Busy', data: h.cpu, colour: 'chartline' as const }] },
    { title: 'Memory used', kind: 'percent' as const, description: 'Memory used percent', series: [{ name: 'Used', data: h.memory, colour: 'chartline' as const }] },
    {
      title: 'Network',
      kind: 'rate' as const,
      description: 'Network in and out in bytes per second',
      series: [{ name: 'In', data: h.networkIn, colour: 'chartline' as const }, { name: 'Out', data: h.networkOut, colour: 'series2' as const }],
    },
    {
      title: 'Disk',
      kind: 'rate' as const,
      description: 'Disk write and read in bytes per second',
      series: [{ name: 'Write', data: h.diskWrite, colour: 'chartline' as const }, { name: 'Read', data: h.diskRead, colour: 'series2' as const }],
    },
  ]
})

const visible = computed(() => {
  const d = data.value
  if (!d) return null
  const len = d.end - d.start
  return { from: d.start + (len * zoom.value.start) / 100, to: d.start + (len * zoom.value.end) / 100 }
})
const rangeText = computed(() => (visible.value ? rangeLabel(visible.value.from, visible.value.to) : ''))
const atMin = computed(() => span.value <= MIN_SPAN + 0.01)

function dotClass(up: boolean | null) {
  return up === true ? 'bg-okdot' : up === false ? 'bg-red' : 'border-2 border-idle'
}
// The node exporter's state in words; the dot only repeats it.
function upText(up: boolean | null) {
  return up === true ? 'up' : up === false ? 'down' : 'status unknown'
}
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Resources</h1>
      <p class="mt-0.5 min-h-5 font-mono text-[13px] text-muted-foreground">{{ nodeLine }}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Server" class="flex gap-0.5 rounded-lg bg-chip p-[3px]">
        <button
          v-for="n in nodes"
          :key="n.key"
          type="button"
          class="inline-flex min-h-[30px] items-center gap-[7px] rounded-md px-3 font-mono text-[13px] pointer-coarse:min-h-11"
          :class="node === n.key ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
          :aria-pressed="node === n.key"
          :aria-label="`${n.displayName}, ${upText(n.up)}`"
          :title="`${n.displayName}, ${upText(n.up)}`"
          @click="node = n.key"
        >
          <span class="size-2 shrink-0 rounded-full" :class="dotClass(n.up)" aria-hidden="true" />
          {{ n.displayName }}
        </button>
      </div>
      <button
        type="button"
        class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3.5 text-[13px] font-medium hover:bg-chip pointer-coarse:min-h-11"
        :aria-busy="spinning"
        @click="refresh"
      >
        <svg class="size-3.5" :class="spinning ? 'animate-spin' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
        {{ spinning ? 'Refreshing' : 'Refresh' }}
      </button>
    </div>
  </div>

  <div v-if="failed && !data" class="flex flex-col items-start gap-3 rounded-xl border border-border p-4" role="alert">
    <p class="text-[13px] text-muted-foreground">Prometheus did not answer. Retrying in 30 s.</p>
    <button type="button" class="min-h-9 rounded-lg border border-border px-3.5 text-[13px] font-medium hover:bg-chip pointer-coarse:min-h-11" @click="refresh">
      Retry now
    </button>
  </div>

  <template v-else>
    <p v-if="failed" class="text-xs text-muted-foreground" role="status">Could not refresh. Showing the last loaded values. Retrying in 30 s.</p>

    <section aria-labelledby="now-title" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="now-title" class="text-[15px] font-semibold">Right now</h2>
        <span class="text-xs text-muted-foreground">Amber from 70 percent, red from 90 percent</span>
      </div>

      <!-- Below 480 px: the Pressure card takes a full row, then the gauges two per row. -->
      <div v-if="!data" class="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-3 max-[480px]:grid-cols-2">
        <Skeleton v-for="n in 6" :key="n" class="h-[136px] rounded-xl first:max-[480px]:col-span-2" />
      </div>
      <div v-else class="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-3 max-[480px]:grid-cols-2">
        <div class="flex min-w-0 flex-col gap-2 rounded-xl border border-border px-3.5 py-3 max-[480px]:col-span-2">
          <div class="text-[13px] text-muted-foreground">Pressure</div>
          <div v-for="p in pressure" :key="p.label" class="grid grid-cols-[44px_1fr_auto] items-center gap-2 text-xs">
            <span class="text-muted-foreground">{{ p.label }}</span>
            <span class="h-1.5 overflow-hidden rounded-full bg-track" role="img" :aria-label="p.value === null ? `${p.label} pressure, no data` : `${p.label} pressure ${p.text}`">
              <span class="block h-1.5 rounded-full" :class="barClass(p.value ?? 0)" :style="{ width: `${p.width}%` }" />
            </span>
            <span class="font-mono" :class="p.value === null ? 'text-muted-foreground' : ''">{{ p.text }}</span>
          </div>
          <div class="mt-auto text-[11px] text-faint">Time spent waiting, last 1 min</div>
        </div>
        <ResourceGauge v-for="g in gauges" :key="g.label" :label="g.label" :percent="g.percent" :detail="g.detail" />
      </div>

      <Skeleton v-if="!data" class="h-[62px] rounded-xl" />
      <dl v-else class="grid grid-cols-[repeat(auto-fit,minmax(min(140px,100%),1fr))] overflow-hidden rounded-xl border border-border">
        <div v-for="f in facts" :key="f.label" class="-mb-px -mr-px border-r border-b border-border px-3.5 py-2.5">
          <dt class="text-xs text-muted-foreground">{{ f.label }}</dt>
          <dd class="mt-0.5 font-mono text-[15px]" :class="f.value === 'No data' ? 'text-muted-foreground' : ''">{{ f.value }}</dd>
        </div>
      </dl>
    </section>

    <section aria-labelledby="history-title" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2.5">
        <div>
          <h2 id="history-title" class="text-[15px] font-semibold">History</h2>
          <p class="text-xs text-muted-foreground">
            <span v-if="rangeText" class="font-mono">{{ rangeText }}</span><template v-if="rangeText">. </template>Zoom applies to all four charts.
          </p>
        </div>
        <ChartToolbar
          v-model="hours"
          :presets="PRESETS"
          :at-full="atFull"
          :at-min="atMin"
          :at-start="zoom.start <= 0.01"
          :at-end="zoom.end >= 99.99"
          :inactive="!data"
          @zoom-in="zoomIn"
          @zoom-out="zoomOut"
          @earlier="earlier"
          @later="later"
          @reset="reset"
        />
      </div>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(440px,100%),1fr))] gap-4">
        <template v-if="!data">
          <Skeleton v-for="n in 4" :key="n" class="h-[240px] rounded-xl" />
        </template>
        <template v-else>
          <div v-for="(c, i) in charts" :key="c.title" class="min-w-0 rounded-xl border border-border px-4 py-3.5">
            <ResourceChart
              :title="c.title"
              :description="`${c.description}${rangeText ? `, ${rangeText.toLowerCase()}` : ''}`"
              :series="c.series"
              :kind="c.kind"
              :start="data.start"
              :end="data.end"
              :step-ms="data.stepSeconds * 1000"
              :zoom="zoom"
              :group="GROUP"
              :slider="i === charts.length - 1"
              @zoom="onChartZoom"
            />
          </div>
        </template>
      </div>
    </section>

    <p class="text-xs text-muted-foreground">
      Read live from Prometheus for both servers. The staging server is not stored in InfluxDB, so its history only reaches back as far as Prometheus keeps data (15 days).
    </p>
  </template>
</template>
