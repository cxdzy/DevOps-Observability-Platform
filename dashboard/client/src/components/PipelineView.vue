<script setup lang="ts">
import type { DeploymentRun, DeploymentsResponse, ProjectRow, ZoomWindow } from '@/types'
import { BarChart } from 'echarts/charts'
import { DataZoomInsideComponent, DataZoomSliderComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, onUnmounted, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import ChartToolbar from '@/components/ChartToolbar.vue'
import { useWheelScrollsPage } from '@/components/ResourceChart.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { MONO, useChartTheme, withAlpha } from '@/lib/chartTheme'
import { clockTime, shortDate } from '@/lib/format'
import { toMs } from '@/types'

use([BarChart, GridComponent, TooltipComponent, DataZoomInsideComponent, DataZoomSliderComponent, CanvasRenderer])

// Deployments of one project: the latest one, what a rollback would do, deployments per week and
// the runs. ECharts is most of the bundle, so DashboardView loads this view only when it is opened.
const props = defineProps<{ query: string }>()
const emit = defineEmits<{ 'refreshed': [ok: boolean], 'update:query': [query: string] }>()

const REPO_URL = 'https://github.com/cxdzy/devops-observability-platform'
const PRESETS = [
  { value: 7, label: '7 d', title: 'Last 7 days' },
  { value: 30, label: '30 d', title: 'Last 30 days' },
  { value: 90, label: '90 d', title: 'Last 90 days' },
]
const FULL: ZoomWindow = { start: 0, end: 100 }
const BAR_NAME = 'Deployments'

const days = ref(30)
const projects = ref<ProjectRow[]>([])
const data = ref<DeploymentsResponse | null>(null)
const loading = ref(true)
const failed = ref(false)
const refreshing = ref(false)

// ---------------------------------------------------------------- project switch, kept in the hash

function projectFromQuery(query: string): string | null {
  return new URLSearchParams(query).get('project') || null
}
const picked = ref<string | null>(projectFromQuery(props.query))
watch(() => props.query, (query) => {
  picked.value = projectFromQuery(query)
  if (listLoaded) dropUnknown()
})

// The chosen project, or the first one when none (or an unknown one) is chosen.
const project = computed(() => projects.value.find(p => p.key === picked.value) ?? projects.value[0] ?? null)

function choose(key: string) {
  picked.value = key
  const query = `project=${encodeURIComponent(key)}`
  const hash = `#pipeline?${query}`
  if (window.location.hash !== hash) history.replaceState(null, '', hash)
  if (props.query !== query) emit('update:query', query)
}

// A key in the hash that is not a registered project is dropped, so a copied link names the
// project that is shown.
function dropUnknown() {
  if (!picked.value || projects.value.some(p => p.key === picked.value)) return
  picked.value = null
  if (window.location.hash.startsWith('#pipeline?')) history.replaceState(null, '', '#pipeline')
  if (props.query !== '') emit('update:query', '')
}

// ---------------------------------------------------------------- loading

let listLoaded = false
async function load() {
  const range = days.value
  let stale = false
  refreshing.value = true
  try {
    if (!listLoaded || projects.value.length === 0) {
      const list = await api.get<ProjectRow[]>('/api/projects')
      if (!Array.isArray(list.data)) throw new Error('unexpected response')
      projects.value = list.data
      listLoaded = true
      dropUnknown()
    }
    const key = project.value?.key
    if (!key) {
      data.value = null
      failed.value = false
      emit('refreshed', true)
      return
    }
    const res = await api.get<DeploymentsResponse>('/api/deployments', { params: { project: key, days: range } })
    // The project or range changed while this load ran; a reload for the new choice follows, and
    // the skeleton stays until it answers.
    if (range !== days.value || key !== project.value?.key) {
      stale = true
      return
    }
    const body = res.data
    if (typeof body !== 'object' || body === null || !Array.isArray(body.runs) || !Array.isArray(body.weeks)) {
      throw new Error('unexpected response')
    }
    data.value = body
    failed.value = false
    emit('refreshed', true)
  } catch {
    failed.value = true
    emit('refreshed', false)
  } finally {
    refreshing.value = false
    if (!stale) loading.value = false
  }
}
const { refresh } = usePoll(load, 60 * 1000)

const zoom = ref<ZoomWindow>({ ...FULL })
// Rows of the old project or range are never shown under the new one.
watch([days, () => project.value?.key], () => {
  data.value = null
  loading.value = true
  failed.value = false
  zoom.value = { ...FULL }
  refresh()
})
const spinning = computed(() => loading.value || refreshing.value)

// ---------------------------------------------------------------- display

function zoneName(): string {
  try {
    return new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}
const zone = zoneName()
const zoneSuffix = zone ? ` (${zone})` : ''
function stamp(value: number | string | null | undefined): string {
  const ms = toMs(value)
  return ms === null ? 'No data' : `${shortDate(ms)} ${clockTime(ms)}`
}
// Weeks start on a UTC day, so their dates are written in UTC.
function weekLabel(value: number | string): string {
  const ms = toMs(value)
  return ms === null ? 'No data' : new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

const SHA = /^[0-9a-f]{7,40}$/
// A commit link is built only from a ref that really is a commit hash.
function commitUrl(run: DeploymentRun): string | null {
  return run.source === 'ci' && SHA.test(run.ref) ? `${REPO_URL}/commit/${run.ref}` : null
}
const RUN_ID = /^\d+$/
// An Actions link is built only from a run id that is all digits.
function runUrl(run: DeploymentRun): string | null {
  const id = run.runId
  return run.source === 'ci' && typeof id === 'string' && RUN_ID.test(id) ? `${REPO_URL}/actions/runs/${id}` : null
}
function shortSha(ref: string): string {
  return SHA.test(ref) ? ref.slice(0, 7) : ref
}
function sourceText(run: DeploymentRun): string {
  return run.source === 'ci' ? 'Verified' : 'Detected'
}

const runs = computed(() => data.value?.runs ?? [])
const weeks = computed(() => data.value?.weeks ?? [])
const latest = computed(() => data.value?.latest ?? null)
const rollback = computed(() => data.value?.rollback ?? null)
const total = computed(() => weeks.value.reduce((sum, w) => sum + (w.count || 0), 0))
const hasChart = computed(() => weeks.value.length > 0)

const ROLLBACK_TITLE: Record<string, string> = {
  n8n: 'If a rollback were approved now',
  own_pipeline: 'Rollback handled elsewhere',
  none: 'No rollback',
}
const rollbackTitle = computed(() => ROLLBACK_TITLE[rollback.value?.mode ?? ''] ?? 'Rollback')
// A rollback that can be asked for now is amber. One this platform cannot do, or not right now,
// is drawn dashed.
const rollbackClass = computed(() => {
  const rb = rollback.value
  if (rb?.mode === 'n8n' && rb.ready === true) return 'bg-tier-medium-bg text-tier-medium-fg'
  if (rb?.mode === 'own_pipeline' || rb?.mode === 'none' || (rb?.mode === 'n8n' && rb.ready === false)) return 'border border-dashed border-input text-chipfg'
  return 'bg-chip text-foreground'
})

// ---------------------------------------------------------------- zoom

const span = computed(() => zoom.value.end - zoom.value.start)
const centre = computed(() => (zoom.value.start + zoom.value.end) / 2)
// The narrowest zoom is about two weeks.
const minSpan = computed(() => Math.min(100, 200 / Math.max(weeks.value.length, 1)))
function setZoom(start: number, end: number) {
  let s = Math.max(minSpan.value, Math.min(100, end - start))
  let from = Math.max(0, Math.min(100 - s, start))
  if (s >= 100) {
    from = 0
    s = 100
  }
  zoom.value = { start: from, end: from + s }
}
const zoomIn = () => setZoom(centre.value - span.value / 4, centre.value + span.value / 4)
const zoomOut = () => setZoom(centre.value - span.value, centre.value + span.value)
const earlier = () => setZoom(zoom.value.start - span.value / 4, zoom.value.end - span.value / 4)
const later = () => setZoom(zoom.value.start + span.value / 4, zoom.value.end + span.value / 4)
const reset = () => { zoom.value = { ...FULL } }
const atFull = computed(() => zoom.value.start <= 0.01 && zoom.value.end >= 99.99)
const atMin = computed(() => span.value <= minSpan.value + 0.001)
const noChart = computed(() => loading.value || !hasChart.value)

// ---------------------------------------------------------------- chart

const { palette, fontReady } = useChartTheme()
const chart = ref<InstanceType<typeof VChart> | null>(null)
const box = ref<HTMLElement | null>(null)
// The window the chart was last drawn with. Not reactive on purpose: a zoom alone must not rebuild the option.
let drawn: ZoomWindow = { ...FULL }
const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches !== false

function tooltip(params: unknown): string {
  const list = (Array.isArray(params) ? params : [params]) as { dataIndex?: number }[]
  const i = list[0]?.dataIndex
  const w = typeof i === 'number' ? weeks.value[i] : undefined
  if (!w) return ''
  return `Week of ${weekLabel(w.week)} (UTC)<br>${w.count} ${w.count === 1 ? 'deployment' : 'deployments'}`
}

const option = computed(() => {
  const c = palette.value
  void fontReady.value
  const axisText = { color: c.faint, fontFamily: MONO, fontSize: 11 }
  const labels = weeks.value.map(w => weekLabel(w.week))
  const top = Math.max(1, ...weeks.value.map(w => w.count || 0))
  return {
    animation: false,
    grid: { left: 44, right: 16, top: 24, bottom: 84 },
    tooltip: {
      trigger: 'axis',
      formatter: tooltip,
      confine: true,
      backgroundColor: c.panel,
      borderColor: c.line,
      borderWidth: 1,
      textStyle: { color: c.ink, fontSize: 12 },
      axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(c.thresh, 0.15) } },
    },
    dataZoom: [
      {
        id: 'zi',
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        start: drawn.start,
        end: drawn.end,
        moveOnMouseMove: finePointer,
        // A plain wheel scrolls the page; Ctrl + wheel (and a trackpad pinch) zooms.
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
      },
      {
        id: 'zs',
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        start: drawn.start,
        end: drawn.end,
        height: 24,
        bottom: 8,
        left: 44,
        right: 16,
        borderColor: c.line,
        backgroundColor: 'transparent',
        fillerColor: withAlpha(c.primary, 0.12),
        dataBackground: { lineStyle: { color: c.thresh }, areaStyle: { color: withAlpha(c.thresh, 0.2) } },
        handleStyle: { color: c.panel, borderColor: c.thresh },
        moveHandleStyle: { color: c.thresh },
        textStyle: { color: c.faint, fontFamily: MONO, fontSize: 11 },
      },
    ],
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: c.grid } },
      axisTick: { alignWithLabel: true, lineStyle: { color: c.grid } },
      axisLabel: { ...axisText, hideOverlap: true },
      name: 'Week starting (UTC)',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { ...axisText },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: Math.max(2, top),
      minInterval: 1,
      splitNumber: 3,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: c.grid, type: [3, 4] } },
      axisLabel: { ...axisText },
    },
    series: [
      {
        name: BAR_NAME,
        type: 'bar',
        barMaxWidth: 36,
        itemStyle: { color: c.chartline, borderRadius: [2, 2, 0, 0] },
        label: { show: true, position: 'top', color: c.ink, fontFamily: MONO, fontSize: 11, formatter: (p: { value: number }) => (p.value ? String(p.value) : '') },
        data: weeks.value.map(w => w.count || 0),
      },
    ],
  }
})

const close = (a: ZoomWindow, b: ZoomWindow) => Math.abs(a.start - b.start) < 0.01 && Math.abs(a.end - b.end) < 0.01

function currentZoom(): ZoomWindow | null {
  const opt = chart.value?.getOption() as { dataZoom?: { start?: number, end?: number }[] } | undefined
  const dz = opt?.dataZoom?.[0]
  return dz && typeof dz.start === 'number' && typeof dz.end === 'number' ? { start: dz.start, end: dz.end } : null
}

// A wheel, pinch, drag or slider move.
function onDataZoom() {
  const z = currentZoom()
  if (!z) return
  drawn = z
  if (!close(z, zoom.value)) zoom.value = z
}

// A toolbar button changed the window.
watch(zoom, (z) => {
  drawn = { ...z }
  const now = currentZoom()
  if (now && close(now, z)) return
  chart.value?.dispatchAction({ type: 'dataZoom', dataZoomId: 'zi', start: z.start, end: z.end })
}, { deep: true })

// The browser zooms the page on Ctrl + wheel; over the plot area the chart uses it instead.
function onWheel(e: WheelEvent) {
  if (!e.ctrlKey || !box.value) return
  const rect = box.value.getBoundingClientRect()
  if (chart.value?.containPixel({ gridIndex: 0 }, [e.clientX - rect.left, e.clientY - rect.top])) e.preventDefault()
}
watch(box, (el, old) => {
  old?.removeEventListener('wheel', onWheel)
  el?.addEventListener('wheel', onWheel, { passive: false })
})
onUnmounted(() => box.value?.removeEventListener('wheel', onWheel))
useWheelScrollsPage(box)

const chartLabel = computed(() => `Deployments per week for ${days.value} days, ${total.value} in total.`)

const card = 'rounded-xl border border-border p-4'
const cell = 'px-3 py-2 align-top'
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Pipeline</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">Deployments of one project. CI projects list their verified runs; other projects list image changes the platform detected.</p>
    </div>
    <div class="flex flex-wrap items-start justify-end gap-2.5">
      <ChartToolbar
        v-model="days"
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
      <button
        type="button"
        class="inline-flex min-h-8 items-center gap-2 rounded-lg border border-border px-3 text-xs hover:bg-chip pointer-coarse:min-h-11"
        :aria-busy="spinning"
        @click="refresh"
      >
        <svg class="size-3.5" :class="spinning ? 'animate-spin motion-reduce:animate-none' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
        {{ spinning ? 'Refreshing' : 'Refresh' }}
      </button>
    </div>
  </div>

  <div v-if="projects.length > 1" role="group" aria-label="Project" class="flex w-max max-w-full flex-wrap gap-0.5 rounded-lg bg-chip p-[3px]">
    <button
      v-for="p in projects"
      :key="p.key"
      type="button"
      class="inline-flex min-h-8 items-center rounded-md px-3 font-mono text-[13px] pointer-coarse:min-h-11"
      :class="project?.key === p.key ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
      :aria-pressed="project?.key === p.key"
      @click="choose(p.key)"
    >
      {{ p.name }}
    </button>
  </div>

  <template v-if="loading">
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
      <Skeleton class="h-[130px] rounded-xl" />
      <Skeleton class="h-[130px] rounded-xl" />
    </div>
    <Skeleton class="h-[320px] rounded-xl" />
  </template>

  <p v-else-if="failed && !data" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    The deployments could not be loaded. Retrying in 1 min.
  </p>

  <p v-else-if="!project" class="rounded-lg bg-chip p-3 text-[13px] text-chipfg" role="status">
    No projects are registered yet. An admin can add one in Settings.
  </p>

  <template v-else-if="data">
    <p v-if="failed" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      Deployments could not be refreshed. Showing the last loaded data.
    </p>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
      <section aria-label="Latest deployment" :class="card">
        <div class="text-[13px] text-muted-foreground">Latest deployment of <span class="font-mono">{{ project.name }}</span></div>
        <template v-if="latest">
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <span class="rounded-full px-2.5 py-0.5 text-xs font-semibold" :class="latest.source === 'ci' ? 'bg-foreground text-card' : 'bg-chip text-chipfg'">{{ sourceText(latest) }}</span>
            <a v-if="commitUrl(latest)" :href="commitUrl(latest) as string" target="_blank" rel="noopener noreferrer" class="font-mono text-[15px] font-medium underline">{{ shortSha(latest.ref) }}<span class="sr-only"> commit, opens in a new tab</span></a>
            <span v-else-if="latest.source === 'ci'" class="font-mono text-[15px] font-medium">{{ shortSha(latest.ref) }}</span>
            <span v-else class="font-mono text-[13px] [overflow-wrap:anywhere]">
              <template v-if="latest.previousRef">{{ latest.previousRef }} to </template>{{ latest.ref }}
            </span>
          </div>
          <p v-if="latest.detail" class="mt-1 text-[13px] [overflow-wrap:anywhere]">{{ latest.detail }}</p>
          <a v-if="runUrl(latest)" :href="runUrl(latest) as string" target="_blank" rel="noopener noreferrer" class="mt-1 inline-block text-xs text-muted-foreground underline">Actions run {{ latest.runId }}<span class="sr-only">, opens in a new tab</span></a>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ stamp(latest.at) }}{{ zoneSuffix }}</p>
        </template>
        <div v-else class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">No data</div>
        <p v-if="!latest" class="mt-0.5 text-xs text-muted-foreground">no deployment has been recorded for this project</p>
      </section>

      <section aria-label="Rollback" class="rounded-xl p-4 text-[13px]" :class="rollbackClass">
        <div class="font-medium">{{ rollbackTitle }}</div>
        <p class="mt-1">{{ rollback?.text || 'No data' }}</p>
      </section>
    </div>

    <p class="text-xs text-muted-foreground">Stage times are kept in the project's CI and are not stored here.</p>

    <section aria-labelledby="pipeline-chart-title" class="min-w-0 rounded-xl border border-border px-[18px] py-4">
      <div class="mb-2">
        <h2 id="pipeline-chart-title" class="text-[15px] font-semibold">Deployments per week</h2>
        <p class="text-xs text-muted-foreground">{{ total }} {{ total === 1 ? 'deployment' : 'deployments' }} in the last {{ days }} days. Weeks start on a UTC day.</p>
      </div>
      <p v-if="!hasChart" class="py-16 text-center text-[13px] text-muted-foreground">No deployments in this range.</p>
      <div v-else ref="box" class="h-[260px] w-full min-w-0 md:h-[300px]" role="img" :aria-label="chartLabel">
        <VChart ref="chart" class="size-full" :option="option" autoresize @datazoom="onDataZoom" />
      </div>
    </section>

    <section aria-labelledby="pipeline-runs-title" class="min-w-0 overflow-hidden rounded-xl border border-border">
      <h2 id="pipeline-runs-title" class="px-4 py-3 text-[15px] font-semibold">Runs</h2>
      <p v-if="runs.length === 0" class="border-t border-border px-4 py-6 text-[13px] text-muted-foreground">No deployments in the last {{ days }} days.</p>
      <div v-else class="relative overflow-x-auto">
        <table class="w-full min-w-[560px] border-collapse text-left text-[13px]">
          <caption class="sr-only">Deployments of {{ project.name }}, newest first. Times are local{{ zoneSuffix }}.</caption>
          <thead>
            <tr class="bg-chip text-xs font-medium text-muted-foreground">
              <th scope="col" :class="cell" class="font-medium">Time{{ zoneSuffix }}</th>
              <th scope="col" :class="cell" class="font-medium">Change</th>
              <th scope="col" :class="cell" class="font-medium">Detail</th>
              <th scope="col" :class="cell" class="font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in runs" :key="`${r.at}-${r.ref}-${i}`" class="border-t border-border">
              <td :class="cell" class="font-mono whitespace-nowrap">{{ stamp(r.at) }}</td>
              <td :class="cell" class="font-mono [overflow-wrap:anywhere]">
                <a v-if="commitUrl(r)" :href="commitUrl(r) as string" target="_blank" rel="noopener noreferrer" class="underline">{{ shortSha(r.ref) }}<span class="sr-only"> commit, opens in a new tab</span></a>
                <template v-else-if="r.source === 'ci'">{{ shortSha(r.ref) }}</template>
                <template v-else><template v-if="r.previousRef">{{ r.previousRef }} to </template>{{ r.ref }}</template>
              </td>
              <td :class="cell" class="[overflow-wrap:anywhere]">
                {{ r.detail || '' }}
                <a v-if="runUrl(r)" :href="runUrl(r) as string" target="_blank" rel="noopener noreferrer" class="block w-fit text-xs text-muted-foreground underline">Actions run {{ r.runId }}<span class="sr-only">, opens in a new tab</span></a>
              </td>
              <td :class="cell">
                <span class="rounded-full px-2.5 py-0.5 text-xs font-semibold" :class="r.source === 'ci' ? 'bg-foreground text-card' : 'bg-chip text-chipfg'">{{ sourceText(r) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>
