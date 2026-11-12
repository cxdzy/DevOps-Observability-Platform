<script setup lang="ts">
import type { LlmRecentCall, LlmResponse, ZoomWindow } from '@/types'
import { BarChart, LineChart } from 'echarts/charts'
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
import { localDateTime } from '@/lib/format'

use([BarChart, LineChart, GridComponent, TooltipComponent, DataZoomInsideComponent, DataZoomSliderComponent, CanvasRenderer])

// ECharts is most of the bundle, so DashboardView loads this whole view (and with it the charts)
// only when the LLM page is first opened.
const emit = defineEmits<{ refreshed: [ok: boolean] }>()

const DAY_MS = 24 * 60 * 60 * 1000
// The same three ranges the server accepts.
const PRESETS = [
  { value: 1, label: '24 h', title: 'Last 24 hours' },
  { value: 7, label: '7 d', title: 'Last 7 days' },
  { value: 30, label: '30 d', title: 'Last 30 days' },
]
const FULL: ZoomWindow = { start: 0, end: 100 }
const LLM_NAME = 'Written by the LLM'
const TEMPLATE_NAME = 'Template'
const MEDIAN_NAME = 'Median'
const P95_NAME = '95th percentile'

const days = ref(7)
const data = ref<LlmResponse | null>(null)
const loading = ref(true)
const failed = ref<string | null>(null)
const refreshing = ref(false)

async function load() {
  const requested = days.value
  refreshing.value = true
  try {
    const res = await api.get<LlmResponse>('/api/llm', { params: { days: requested } })
    // The range changed while this load ran; a reload for the new range follows.
    if (requested !== days.value) return
    const body = res.data
    if (typeof body !== 'object' || body === null || typeof body.explanations !== 'object' || body.explanations === null
      || !Array.isArray(body.explanations.daily) || typeof body.chat !== 'object' || body.chat === null
      || !Array.isArray(body.chat.daily) || !Array.isArray(body.recent)) {
      throw new Error('unexpected response')
    }
    data.value = body
    failed.value = null
    emit('refreshed', true)
  } catch (err) {
    if (requested !== days.value) return
    const status = (err as { response?: { status?: number } }).response?.status
    failed.value = status === 503 ? 'LLM logging is not configured on this server.' : 'The call log did not answer. Retrying in 1 min.'
    emit('refreshed', false)
  } finally {
    refreshing.value = false
    if (requested === days.value) loading.value = false
  }
}

const { refresh } = usePoll(load, 60 * 1000)

const zoom = ref<ZoomWindow>({ ...FULL })
// Rows of the old range are never shown under the new one.
watch(days, () => {
  data.value = null
  loading.value = true
  failed.value = null
  zoom.value = { ...FULL }
  refresh()
})

const spinning = computed(() => loading.value || refreshing.value)

// ---------------------------------------------------------------- derived numbers

const ex = computed(() => data.value?.explanations ?? null)
const chat = computed(() => data.value?.chat ?? null)
const recent = computed<LlmRecentCall[]>(() => data.value?.recent ?? [])
const daily = computed(() => ex.value?.daily ?? [])
const hasExplanations = computed(() => (ex.value?.total ?? 0) > 0)

function percent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return 'No data'
  const p = rate * 100
  return `${p >= 10 || Number.isInteger(p) ? p.toFixed(0) : p.toFixed(1)}%`
}
function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'No data'
  const s = ms / 1000
  return `${s >= 100 ? s.toFixed(0) : s.toFixed(1)} s`
}
function plain(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? 'No data' : String(Math.round(v))
}
function perSecond(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? 'No data' : `${v.toFixed(1)} tokens/s`
}

// Moments are shown in the browser's local time with the zone written once; days are UTC dates.
function zoneName(): string {
  try {
    return new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}
const zone = zoneName()
function utcDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
const rangeText = computed(() => (data.value ? `${utcDate(data.value.from)} to ${utcDate(data.value.to - DAY_MS)}` : ''))

const modelText = computed(() => {
  const models = ex.value?.models ?? []
  return models.length ? models.map(m => m.model ?? 'unknown').join(', ') : 'no model recorded'
})
const attemptsText = computed(() => {
  const list = ex.value?.attempts ?? []
  return list.length ? list.map(a => `${a.count} took ${a.attempts} ${a.attempts === 1 ? 'try' : 'tries'}`).join(', ') : 'no attempts recorded'
})

// The chat split bar. LLM answers use the second chart colour of the theme, every other kind the first, so the two
// read apart in both themes (the dH7 note: template or fallback #E6EDF3, LLM #6E7B89 in dark).
const KIND_LABEL: Record<string, string> = { llm: 'LLM answer', fallback: 'Fallback from the facts', template: 'Template answer' }
const kinds = computed(() => {
  const list = chat.value?.kinds ?? []
  const total = list.reduce((sum, k) => sum + k.count, 0)
  return list.map(k => ({ ...k, label: KIND_LABEL[k.kind] ?? k.kind, share: total > 0 ? k.count / total : 0, llm: k.kind === 'llm' }))
})

function callWho(c: LlmRecentCall): string {
  if (c.trace === 'chat') return c.kind === 'llm' ? 'Chat, LLM' : c.kind === 'fallback' ? 'Chat, fallback' : 'Chat'
  return c.source === 'llm' ? 'Explanation, LLM' : c.source === 'template' ? 'Explanation, template' : 'Explanation'
}
function callCheck(c: LlmRecentCall): string {
  if (c.trace === 'chat') return c.checkPassed === null ? 'No data' : c.checkPassed ? 'Passed' : 'Failed'
  if (c.source === 'llm') return c.attempts === null || c.attempts === 1 ? 'Passed' : `Passed on try ${c.attempts}`
  if (c.source === 'template') return c.rejected ? `Failed: ${c.rejected}` : 'Failed every try'
  return 'No data'
}
const isTemplateCall = (c: LlmRecentCall) => c.source === 'template' || c.kind === 'fallback'

// ---------------------------------------------------------------- zoom

const dayCount = computed(() => Math.max(1, daily.value.length))
const span = computed(() => zoom.value.end - zoom.value.start)
const centre = computed(() => (zoom.value.start + zoom.value.end) / 2)
// The narrowest zoom is about two days.
const minSpan = computed(() => Math.min(100, (2 / dayCount.value) * 100))
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
const noChart = computed(() => loading.value || !hasExplanations.value)

// ---------------------------------------------------------------- charts

const { palette, fontReady } = useChartTheme()
const countChart = ref<InstanceType<typeof VChart> | null>(null)
const latencyChart = ref<InstanceType<typeof VChart> | null>(null)
const countBox = ref<HTMLElement | null>(null)
const latencyBox = ref<HTMLElement | null>(null)

// The window the charts were last drawn with. Not reactive on purpose, as in DriftView: a zoom alone
// must not rebuild the options.
let drawn: ZoomWindow = { ...FULL }
const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches !== false

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}

const labels = computed(() => daily.value.map(d => utcDate(d.day)))

function baseOption(c: ReturnType<typeof useChartTheme>['palette']['value'], withSlider: boolean) {
  const axisText = { color: c.faint, fontFamily: MONO, fontSize: 11 }
  const inside = {
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
  }
  const slider = {
    id: 'zs',
    type: 'slider',
    xAxisIndex: 0,
    filterMode: 'none',
    start: drawn.start,
    end: drawn.end,
    height: 24,
    bottom: 8,
    left: 52,
    right: 16,
    borderColor: c.line,
    backgroundColor: 'transparent',
    fillerColor: withAlpha(c.primary, 0.12),
    dataBackground: { lineStyle: { color: c.thresh }, areaStyle: { color: withAlpha(c.thresh, 0.2) } },
    handleStyle: { color: c.panel, borderColor: c.thresh },
    moveHandleStyle: { color: c.thresh },
    textStyle: { color: c.faint, fontFamily: MONO, fontSize: 11 },
  }
  return {
    animation: false,
    grid: { left: 52, right: 16, top: 16, bottom: withSlider ? 84 : 40 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: c.panel,
      borderColor: c.line,
      borderWidth: 1,
      textStyle: { color: c.ink, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: c.thresh } },
    },
    dataZoom: withSlider ? [inside, slider] : [inside],
    xAxis: {
      type: 'category',
      data: labels.value,
      axisLine: { lineStyle: { color: c.grid } },
      axisTick: { show: false },
      axisLabel: { ...axisText, hideOverlap: true },
      name: 'UTC day',
      nameLocation: 'middle',
      nameGap: 26,
      nameTextStyle: { ...axisText },
    },
    axisText,
  }
}

type Tip = { dataIndex?: number }[]
function dayOf(params: unknown): { index: number, title: string } | null {
  const first = (Array.isArray(params) ? params : [params])[0] as Tip[number] | undefined
  const index = first?.dataIndex
  const d = typeof index === 'number' ? daily.value[index] : undefined
  return d && typeof index === 'number' ? { index, title: `<b>${escapeHtml(utcDate(d.day))}</b> (UTC day)` } : null
}

// Stacked daily counts: LLM solid, template hollow (the dH7 note: filled against outlined, in both themes).
const countOption = computed(() => {
  const c = palette.value
  void fontReady.value
  const { axisText, ...base } = baseOption(c, false)
  return {
    ...base,
    tooltip: {
      ...base.tooltip,
      formatter: (params: unknown) => {
        const hit = dayOf(params)
        const d = hit ? daily.value[hit.index] : undefined
        if (!hit || !d) return ''
        return [hit.title, `${LLM_NAME}: ${d.llm}`, `${TEMPLATE_NAME}: ${d.template}`, `First try: ${d.firstTry}`].join('<br>')
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      minInterval: 1,
      splitNumber: 3,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: c.grid, type: [3, 4] } },
      axisLabel: axisText,
    },
    series: [
      {
        name: LLM_NAME,
        type: 'bar',
        stack: 'calls',
        barMaxWidth: 32,
        itemStyle: { color: c.chartline },
        data: daily.value.map(d => d.llm),
      },
      {
        name: TEMPLATE_NAME,
        type: 'bar',
        stack: 'calls',
        barMaxWidth: 32,
        itemStyle: { color: c.panel, borderColor: c.chartline, borderWidth: 1.5 },
        data: daily.value.map(d => d.template),
      },
    ],
  }
})

// Median and 95th percentile time per day, in seconds. A day without explanations leaves a gap.
const latencyOption = computed(() => {
  const c = palette.value
  void fontReady.value
  const { axisText, ...base } = baseOption(c, true)
  const sec = (ms: number | null) => (ms === null ? null : ms / 1000)
  return {
    ...base,
    tooltip: {
      ...base.tooltip,
      formatter: (params: unknown) => {
        const hit = dayOf(params)
        const d = hit ? daily.value[hit.index] : undefined
        if (!hit || !d) return ''
        if (d.medianMs === null) return [hit.title, 'No explanations'].join('<br>')
        return [hit.title, `${MEDIAN_NAME}: ${seconds(d.medianMs)}`, `${P95_NAME}: ${seconds(d.p95Ms)}`, `${d.count} explanations`].join('<br>')
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      splitNumber: 3,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: c.grid, type: [3, 4] } },
      axisLabel: { ...axisText, formatter: (v: number) => `${v} s` },
    },
    series: [
      {
        name: P95_NAME,
        type: 'line',
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 1.5, color: c.thresh, type: 'dashed' },
        itemStyle: { color: c.thresh },
        data: daily.value.map(d => sec(d.p95Ms)),
      },
      {
        name: MEDIAN_NAME,
        type: 'line',
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2, color: c.chartline },
        itemStyle: { color: c.chartline },
        data: daily.value.map(d => sec(d.medianMs)),
      },
    ],
  }
})

const close = (a: ZoomWindow, b: ZoomWindow) => Math.abs(a.start - b.start) < 0.01 && Math.abs(a.end - b.end) < 0.01
type ChartRef = InstanceType<typeof VChart> | null
function zoomOf(chart: ChartRef): ZoomWindow | null {
  const opt = chart?.getOption() as { dataZoom?: { start?: number, end?: number }[] } | undefined
  const dz = opt?.dataZoom?.[0]
  return dz && typeof dz.start === 'number' && typeof dz.end === 'number' ? { start: dz.start, end: dz.end } : null
}

// A wheel, pinch, drag or slider move on either chart.
function onDataZoom(chart: ChartRef) {
  const z = zoomOf(chart)
  if (!z) return
  drawn = z
  if (!close(z, zoom.value)) zoom.value = z
}

// A toolbar button or the other chart changed the window. Both charts follow.
watch(zoom, (z) => {
  drawn = { ...z }
  for (const chart of [countChart.value, latencyChart.value]) {
    const now = zoomOf(chart)
    if (now && close(now, z)) continue
    chart?.dispatchAction({ type: 'dataZoom', dataZoomId: 'zi', start: z.start, end: z.end })
  }
}, { deep: true })

// The browser zooms the page on Ctrl + wheel; over the plot area the chart uses it instead.
function wheelHandler(box: typeof countBox, chart: typeof countChart) {
  return (e: WheelEvent) => {
    if (!e.ctrlKey || !box.value) return
    const rect = box.value.getBoundingClientRect()
    if (chart.value?.containPixel({ gridIndex: 0 }, [e.clientX - rect.left, e.clientY - rect.top])) e.preventDefault()
  }
}
const onCountWheel = wheelHandler(countBox, countChart)
const onLatencyWheel = wheelHandler(latencyBox, latencyChart)
watch(countBox, (el, old) => {
  old?.removeEventListener('wheel', onCountWheel)
  el?.addEventListener('wheel', onCountWheel, { passive: false })
})
watch(latencyBox, (el, old) => {
  old?.removeEventListener('wheel', onLatencyWheel)
  el?.addEventListener('wheel', onLatencyWheel, { passive: false })
})
onUnmounted(() => {
  countBox.value?.removeEventListener('wheel', onCountWheel)
  latencyBox.value?.removeEventListener('wheel', onLatencyWheel)
})
useWheelScrollsPage(countBox)
useWheelScrollsPage(latencyBox)

const countLabel = computed(() => `Explanations per day for ${days.value === 1 ? '24 hours' : `${days.value} days`}: ${ex.value?.llm ?? 0} written by the LLM and ${ex.value?.template ?? 0} from the template.`)
const latencyLabel = computed(() => `Median and 95th percentile time per explanation for each day. Median ${seconds(ex.value?.medianMs)}.`)

const card = 'rounded-xl border border-border p-4'
const bigNumber = 'mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]'
const noData = 'mt-2.5 text-[22px] font-semibold tracking-[-0.02em]'
const note = 'rounded-lg bg-chip p-3 text-[13px] text-chipfg'
const maxRejections = computed(() => Math.max(1, ...(ex.value?.rejections ?? []).map(r => r.count)))
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">LLM</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">
        Every call to the local model, from the call log in PostgreSQL. Explainer: {{ modelText }} on Ollama.
        <span v-if="rangeText">{{ rangeText }}, UTC days.</span>
      </p>
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

  <template v-if="loading">
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <Skeleton v-for="n in 5" :key="n" class="h-[116px] rounded-xl" />
    </div>
    <Skeleton class="h-[260px] rounded-xl" />
  </template>

  <p v-else-if="failed && !data" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    {{ failed }}
  </p>

  <template v-else-if="data && ex && chat">
    <p v-if="failed" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      The call log could not be refreshed. Showing the last loaded data.
    </p>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <section aria-label="Explanations" :class="card">
        <div class="text-[13px] text-muted-foreground">Explanations</div>
        <div v-if="hasExplanations" :class="bigNumber">{{ ex.total }}</div>
        <div v-else :class="noData">No data</div>
        <div class="mt-0.5 text-xs text-muted-foreground">{{ hasExplanations ? 'one per closed incident' : 'none written in this range' }}</div>
      </section>

      <section aria-label="Passed first try" :class="card">
        <div class="text-[13px] text-muted-foreground">Passed first try</div>
        <div v-if="ex.firstTryRate !== null" :class="bigNumber">{{ percent(ex.firstTryRate) }}</div>
        <div v-else :class="noData">No data</div>
        <div class="mt-0.5 text-xs text-muted-foreground">{{ ex.firstTryRate !== null ? `${ex.firstTry} of ${ex.total}, fact check on the first answer` : 'needs an explanation' }}</div>
      </section>

      <section aria-label="Used the template" :class="card">
        <div class="text-[13px] text-muted-foreground">Used the template</div>
        <div v-if="ex.templateRate !== null" :class="bigNumber">{{ percent(ex.templateRate) }}</div>
        <div v-else :class="noData">No data</div>
        <div class="mt-0.5 text-xs text-muted-foreground">{{ ex.templateRate !== null ? `${ex.template} of ${ex.total} failed both tries` : 'needs an explanation' }}</div>
      </section>

      <section aria-label="Median time" :class="card">
        <div class="text-[13px] text-muted-foreground">Median time</div>
        <div v-if="ex.medianMs !== null" :class="bigNumber">{{ seconds(ex.medianMs) }}</div>
        <div v-else :class="noData">No data</div>
        <div class="mt-0.5 text-xs text-muted-foreground">{{ ex.medianMs !== null ? `95th percentile ${seconds(ex.p95Ms)}, all tries together` : 'needs an explanation' }}</div>
      </section>

      <section aria-label="Median tokens" :class="card">
        <div class="text-[13px] text-muted-foreground">Median tokens</div>
        <div v-if="ex.medianTokens !== null" :class="bigNumber">{{ plain(ex.medianTokens) }}</div>
        <div v-else :class="noData">No data</div>
        <div class="mt-0.5 text-xs text-muted-foreground">per explanation, prompt and answer</div>
      </section>
    </div>

    <p :class="note" role="note">
      Explanation accuracy (E4, whether the signal named is the right one) is not stored yet, so it is not shown. The fact check below is the
      automatic check the explainer runs on every answer.
    </p>

    <section aria-labelledby="llm-count-title" class="min-w-0 rounded-xl border border-border px-[18px] py-4">
      <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div class="min-w-0">
          <h2 id="llm-count-title" class="text-[15px] font-semibold">Explanations per day</h2>
          <p class="text-xs text-muted-foreground">Dated by the start of the incident. Hollow bars are explanations that fell back to the fixed template. {{ attemptsText }}.</p>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span class="inline-flex items-center gap-1.5"><span class="inline-block size-2.5 rounded-[2px] bg-chartline" aria-hidden="true" />{{ LLM_NAME }}</span>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block size-2.5 rounded-[2px] border-[1.5px] border-chartline bg-card" aria-hidden="true" />{{ TEMPLATE_NAME }}</span>
        </div>
      </div>
      <p v-if="!hasExplanations" class="py-12 text-center text-[13px] text-muted-foreground">No explanations in this range.</p>
      <div v-else ref="countBox" class="h-[220px] w-full min-w-0" role="img" :aria-label="countLabel">
        <VChart ref="countChart" class="size-full" :option="countOption" autoresize @datazoom="onDataZoom(countChart)" />
      </div>
    </section>

    <section aria-labelledby="llm-latency-title" class="min-w-0 rounded-xl border border-border px-[18px] py-4">
      <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div class="min-w-0">
          <h2 id="llm-latency-title" class="text-[15px] font-semibold">Time per explanation</h2>
          <p class="text-xs text-muted-foreground">Model load, reading and writing together, all tries of one explanation added up.</p>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-3 bg-chartline" aria-hidden="true" />{{ MEDIAN_NAME }} <span class="font-mono text-foreground">{{ seconds(ex.medianMs) }}</span></span>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-3 border-t border-dashed border-thresh" aria-hidden="true" />{{ P95_NAME }} <span class="font-mono text-foreground">{{ seconds(ex.p95Ms) }}</span></span>
        </div>
      </div>
      <p v-if="!hasExplanations" class="py-12 text-center text-[13px] text-muted-foreground">No explanations in this range.</p>
      <div v-else ref="latencyBox" class="h-[260px] w-full min-w-0" role="img" :aria-label="latencyLabel">
        <VChart ref="latencyChart" class="size-full" :option="latencyOption" autoresize @datazoom="onDataZoom(latencyChart)" />
      </div>
    </section>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
      <section aria-labelledby="llm-rejections-title" class="min-w-0 rounded-xl border border-border p-4">
        <h2 id="llm-rejections-title" class="text-[15px] font-semibold">Why explanations fell back to the template</h2>
        <p class="mb-2 text-xs text-muted-foreground">The fact check of the last try of each explanation that fell back to the template. Numbers are shown as N.</p>
        <p v-if="ex.rejections.length === 0" class="py-4 text-[13px] text-muted-foreground">No rejected answer in this range.</p>
        <ol v-else class="flex flex-col gap-2.5">
          <li v-for="(r, i) in ex.rejections" :key="r.reason" class="text-[13px]">
            <div class="flex items-baseline justify-between gap-3">
              <span class="min-w-0"><span class="mr-1.5 font-mono text-xs text-faint">{{ i + 1 }}</span>{{ r.reason }}</span>
              <span class="shrink-0 font-mono">{{ r.count }}</span>
            </div>
            <div class="mt-1 h-1.5 rounded-full bg-chip" aria-hidden="true">
              <div class="h-full rounded-full bg-chartline" :style="{ width: `${Math.max(3, (r.count / maxRejections) * 100)}%` }" />
            </div>
          </li>
        </ol>
      </section>

      <section aria-labelledby="llm-chat-title" class="min-w-0 rounded-xl border border-border p-4">
        <h2 id="llm-chat-title" class="text-[15px] font-semibold">LLM replies and fallbacks</h2>
        <p class="mb-3 text-xs text-muted-foreground">Only questions that go to the model are logged. Commands and template replies never reach it, so they are not counted here.</p>
        <p v-if="chat.replies === 0" class="py-4 text-[13px] text-muted-foreground">No model answer in this range.</p>
        <template v-else>
          <div class="flex h-3 overflow-hidden rounded-full bg-chip" role="img" :aria-label="`Chat answers by kind: ${kinds.map(k => `${k.label} ${k.count}`).join(', ')}`">
            <div
              v-for="k in kinds"
              :key="k.kind"
              :class="k.llm ? 'bg-thresh' : 'bg-chartline'"
              :style="{ width: `${k.share * 100}%` }"
            />
          </div>
          <ul class="mt-2 flex flex-col gap-1 text-[13px]">
            <li v-for="k in kinds" :key="k.kind" class="flex items-center justify-between gap-3">
              <span class="inline-flex items-center gap-1.5"><span class="inline-block size-2.5 rounded-[2px]" :class="k.llm ? 'bg-thresh' : 'bg-chartline'" aria-hidden="true" />{{ k.label }}</span>
              <span class="font-mono">{{ k.count }} <span class="text-xs text-muted-foreground">{{ percent(k.share) }}</span></span>
            </li>
          </ul>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt class="text-muted-foreground">Answers</dt><dd class="text-right font-mono">{{ chat.replies }}</dd>
            <dt class="text-muted-foreground">Passed the fact check</dt><dd class="text-right font-mono">{{ percent(chat.checkRate) }}</dd>
            <dt class="text-muted-foreground">Median reply time</dt><dd class="text-right font-mono">{{ chat.medianReplyS === null ? 'No data' : `${chat.medianReplyS.toFixed(1)} s` }}</dd>
            <dt class="text-muted-foreground">Speed</dt><dd class="text-right font-mono">{{ perSecond(chat.medianTokS) }}</dd>
          </dl>
        </template>
      </section>
    </div>

    <section aria-labelledby="llm-recent-title" class="min-w-0 rounded-xl border border-border p-4">
      <h2 id="llm-recent-title" class="text-[15px] font-semibold">Recent calls</h2>
      <p class="mb-2 text-xs text-muted-foreground">The newest {{ recent.length }} in this range. Times are local{{ zone ? ` (${zone})` : '' }}. Prompts and answers are not shown.</p>
      <p v-if="recent.length === 0" class="py-4 text-[13px] text-muted-foreground">No call in this range.</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[640px] text-left text-[13px]">
          <thead>
            <tr class="border-b border-border text-xs text-muted-foreground">
              <th scope="col" class="py-1.5 pr-3 font-medium">Time</th>
              <th scope="col" class="py-1.5 pr-3 font-medium">Call</th>
              <th scope="col" class="py-1.5 pr-3 font-medium">Model</th>
              <th scope="col" class="py-1.5 pr-3 text-right font-medium">Tries</th>
              <th scope="col" class="py-1.5 pr-3 text-right font-medium">Duration</th>
              <th scope="col" class="py-1.5 pr-3 text-right font-medium">Tokens</th>
              <th scope="col" class="py-1.5 font-medium">Fact check</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="(c, i) in recent" :key="`${c.time}-${i}`">
              <td class="py-1.5 pr-3 font-mono text-xs">{{ localDateTime(c.time) }}</td>
              <td class="py-1.5 pr-3">
                <span
                  class="rounded-md px-1.5 py-px text-[11px] font-semibold"
                  :class="isTemplateCall(c) ? 'border border-dashed border-input text-chipfg' : 'bg-chartline text-card'"
                >{{ callWho(c) }}</span>
              </td>
              <td class="py-1.5 pr-3 font-mono text-xs">{{ c.model ?? 'No data' }}</td>
              <td class="py-1.5 pr-3 text-right font-mono">{{ c.attempts ?? '-' }}</td>
              <td class="py-1.5 pr-3 text-right font-mono">{{ seconds(c.latencyMs) }}</td>
              <td class="py-1.5 pr-3 text-right font-mono">{{ c.tokens ?? '-' }}</td>
              <td class="py-1.5 text-xs text-muted-foreground">{{ callCheck(c) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>
