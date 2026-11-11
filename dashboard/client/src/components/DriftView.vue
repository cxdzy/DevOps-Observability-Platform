<script setup lang="ts">
import type { DriftPromotion, DriftReference, DriftResponse, ZoomWindow } from '@/types'
import { CustomChart, LineChart, ScatterChart } from 'echarts/charts'
import { DataZoomInsideComponent, DataZoomSliderComponent, GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { graphic, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, onUnmounted, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import ChartToolbar from '@/components/ChartToolbar.vue'
import { useWheelScrollsPage } from '@/components/ResourceChart.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { cssVar, MONO, useChartTheme, withAlpha } from '@/lib/chartTheme'
import { clockTime, fixed, shortDate } from '@/lib/format'

use([CustomChart, LineChart, ScatterChart, GridComponent, TooltipComponent, DataZoomInsideComponent, DataZoomSliderComponent, MarkLineComponent, CanvasRenderer])

// ECharts is most of the bundle, so DashboardView loads this whole view (and with it the chart)
// only when the Drift page is first opened.
const emit = defineEmits<{ refreshed: [ok: boolean] }>()

const DAY_MS = 24 * 60 * 60 * 1000
// The same four ranges the server accepts.
const PRESETS = [
  { value: 7, label: '7 d', title: 'Last 7 days' },
  { value: 14, label: '14 d', title: 'Last 14 days' },
  { value: 30, label: '30 d', title: 'Last 30 days' },
  { value: 60, label: '60 d', title: 'Last 60 days' },
]
const FULL: ZoomWindow = { start: 0, end: 100 }
const HEXAGON = 'path://M12 1.5 21 6.75v10.5L12 22.5 3 17.25V6.75z'
const BAR_NAME = 'False alarm rate'
const REFERENCE_NAME = 'Normal memory level'
const PROMOTION_NAME = 'Model promoted'
const HOVER_NAME = 'Day'

const days = ref(30)
const data = ref<DriftResponse | null>(null)
const loading = ref(true)
const failed = ref(false)
const refreshing = ref(false)

async function load() {
  const requested = days.value
  refreshing.value = true
  try {
    const res = await api.get<DriftResponse>('/api/drift', { params: { days: requested } })
    // The range changed while this load ran; a reload for the new range follows.
    if (requested !== days.value) return
    const body = res.data
    if (typeof body !== 'object' || body === null || !Array.isArray(body.days) || !Array.isArray(body.reference) || !Array.isArray(body.promotions) || !Array.isArray(body.episodes)) {
      throw new Error('unexpected response')
    }
    data.value = body
    failed.value = false
    emit('refreshed', true)
  } catch {
    if (requested !== days.value) return
    failed.value = true
    emit('refreshed', false)
  } finally {
    refreshing.value = false
    if (requested === days.value) loading.value = false
  }
}

// The report is saved by hand and the reference moves every 30 minutes, so a slow poll is plenty.
const { refresh } = usePoll(load, 5 * 60 * 1000)

const zoom = ref<ZoomWindow>({ ...FULL })
// The time of the selected promotion. A time, not a list index, so a poll that adds or drops a
// promotion does not move the selection to another one.
const selectedPromotion = ref<number | null>(null)
function togglePromotion(time: number) {
  selectedPromotion.value = selectedPromotion.value === time ? null : time
}
// Rows of the old range are never shown under the new one.
watch(days, () => {
  data.value = null
  loading.value = true
  failed.value = false
  zoom.value = { ...FULL }
  selectedPromotion.value = null
  refresh()
})

const spinning = computed(() => loading.value || refreshing.value)

// ---------------------------------------------------------------- derived numbers

const dayList = computed(() => data.value?.days ?? [])
const reference = computed(() => data.value?.reference ?? [])
const promotions = computed(() => data.value?.promotions ?? [])
const episodes = computed(() => data.value?.episodes ?? [])
const threshold = computed(() => data.value?.episode_rate ?? 0.01)
const hasReport = computed(() => dayList.value.length > 0)
const hasChart = computed(() => hasReport.value || reference.value.length > 0 || promotions.value.length > 0)

function percent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return 'No data'
  const p = rate * 100
  return `${p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)}%`
}
const thresholdText = computed(() => `${Math.round(threshold.value * 1000) / 10}%`)

// Moments (promotions, the latest reference) are shown in the browser's local time, in the same
// format as the rest of the dashboard, with the zone abbreviation from Intl written once where they
// appear. Days (bars, episodes) are UTC days and keep their UTC dates.
function localStamp(ms: number): string {
  return `${shortDate(ms)} ${clockTime(ms)}`
}
function zoneName(ms: number = Date.now()): string {
  try {
    return new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}
const zone = zoneName()
const withZone = (text: string) => (zone ? `${text} (${zone})` : text)

// Days are UTC days, so their dates are written in UTC.
function utcDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
// "Episode n, <first day> to <last day>", the same on the chart band and in the list. end is the end
// of the last day, so the last day starts one day earlier.
function episodeLabel(n: number): string {
  const e = episodes.value[n - 1]
  if (!e) return `Episode ${n}`
  const first = utcDate(e.start)
  const last = utcDate(e.end - DAY_MS)
  return first === last ? `Episode ${n}, ${first}` : `Episode ${n}, ${first} to ${last}`
}
function version(v: string | null): string {
  return v ?? 'unknown'
}

const daysAbove = computed(() => dayList.value.filter(d => d.rate !== null && d.rate > threshold.value).length)
const daysWithRate = computed(() => dayList.value.filter(d => d.rate !== null).length)
const longestEpisode = computed(() => Math.max(0, ...episodes.value.map(e => e.days)))
const peakRate = computed(() => Math.max(0, ...episodes.value.map(e => e.peak_rate)))
const latestPromotion = computed(() => promotions.value[promotions.value.length - 1] ?? null)
const latest = computed<DriftReference | null>(() => data.value?.latest_reference ?? null)

function megabytes(v: number | null | undefined): string {
  return v === null || v === undefined ? 'No data' : `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} MB`
}

const rangeText = computed(() => {
  if (!data.value) return ''
  return `${utcDate(data.value.from)} to ${utcDate(data.value.to - DAY_MS)}`
})

function promotionTitle(p: DriftPromotion): string {
  return `${version(p.old_version)} to ${version(p.new_version)}`
}
function f1Text(p: DriftPromotion): string {
  if (p.old_f1 === null && p.new_f1 === null) return 'F1 not recorded'
  return `F1 ${p.old_f1 === null ? 'unknown' : fixed(p.old_f1, 3)} to ${p.new_f1 === null ? 'unknown' : fixed(p.new_f1, 3)}`
}
const chosen = computed(() => promotions.value.find(p => p.time === selectedPromotion.value) ?? null)

// ---------------------------------------------------------------- zoom

const span = computed(() => zoom.value.end - zoom.value.start)
const centre = computed(() => (zoom.value.start + zoom.value.end) / 2)
// The narrowest zoom is about two days.
const minSpan = computed(() => {
  const range = data.value ? data.value.to - data.value.from : days.value * DAY_MS
  return Math.min(50, (2 * DAY_MS / Math.max(range, DAY_MS)) * 100)
})
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

// The window the chart was last drawn with. Not reactive on purpose, as in ResourceChart: a zoom
// alone must not rebuild the option.
let drawn: ZoomWindow = { ...FULL }
const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches !== false

interface Rect { x: number, y: number, width: number, height: number }
interface CustomApi { value: (dim: number) => number, coord: (v: number[]) => number[] }
// dataIndexInside is the item's position among the items drawn in this pass, from 0.
interface CustomParams { coordSys: Rect, dataIndexInside: number }

// The top of the rate axis: a nice number above the largest rate, and never above 15 percent, so
// one very bad day does not flatten the rest. A taller bar is cut at the top and labelled.
const CAP = 0.15
const rateMax = computed(() => {
  const top = Math.max(0, ...dayList.value.map(d => d.rate ?? 0), threshold.value * 2)
  if (top * 1.1 > CAP) return CAP
  return [0.02, 0.05, 0.1, CAP].find(step => step >= top * 1.1) ?? CAP
})

function barRenderItem(fill: string, ink: string) {
  return (params: CustomParams, a: CustomApi) => {
    const rate = a.value(1)
    const left = a.coord([a.value(0), 0])
    const right = a.coord([a.value(0) + DAY_MS, 0])
    const top = a.coord([a.value(0), rate])
    const gap = Math.min(3, (right[0] - left[0]) * 0.15)
    const height = Math.max(rate > 0 ? 1.5 : 0, left[1] - top[1])
    if (height <= 0) return null
    const cs = params.coordSys
    const rect = graphic.clipRectByRect({ x: left[0] + gap, y: left[1] - height, width: Math.max(1, right[0] - left[0] - 2 * gap), height }, cs)
    if (!rect) return null
    const children: unknown[] = [{ type: 'rect', shape: { ...rect, r: 1.5 }, style: { fill } }]
    // A bar cut at the top of the axis says its real value.
    if (rate > rateMax.value) {
      children.push({
        type: 'text',
        x: rect.x + rect.width / 2,
        y: cs.y - 3,
        style: { text: percent(rate), fill: ink, font: `11px ${MONO}`, textAlign: 'center', textVerticalAlign: 'bottom' },
      })
    }
    return { type: 'group', children }
  }
}

// Chart labels are drawn only where they fit. A label is drawn when it lies fully inside its room
// (an episode band, or the plot width for a version label) and starts at least LABEL_GAP_PX after
// the right edge of the previous drawn label of the same kind; otherwise it is left out, and the
// lists below the chart carry the full text. Nothing is drawn past the plot edges, so nothing is
// clipped. ECharts calls renderItem once per item, in data order (oldest first), on every redraw,
// including zoom and resize, so the last drawn edge is reset at the first item.
const LABEL_GAP_PX = 8
const LABEL_PAD_PX = 4
const LABEL_FONT = '11px "Geist", system-ui, sans-serif'
const VERSION_FONT = `11px ${MONO}`
let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 7
  measureCtx.font = font
  return Math.ceil(measureCtx.measureText(text).width)
}

function bandRenderItem(fill: string, ink: string) {
  let lastRight = -Infinity
  return (params: CustomParams, a: CustomApi) => {
    if (params.dataIndexInside === 0) lastRight = -Infinity
    const left = a.coord([a.value(0), 0])[0]
    const right = a.coord([a.value(1), 0])[0]
    const cs = params.coordSys
    const rect = graphic.clipRectByRect({ x: Math.min(left, right), y: cs.y, width: Math.max(2, Math.abs(right - left)), height: cs.height }, cs)
    if (!rect) return null
    const children: object[] = [{ type: 'rect', shape: rect, style: { fill } }]
    const text = episodeLabel(Number(a.value(2)))
    const x = rect.x + LABEL_PAD_PX
    const width = textWidth(text, LABEL_FONT)
    if (width + 2 * LABEL_PAD_PX <= rect.width && x - lastRight >= LABEL_GAP_PX) {
      children.push({ type: 'text', x, y: rect.y + 4, style: { text, fill: ink, font: LABEL_FONT, textVerticalAlign: 'top' } })
      lastRight = x + width
    }
    return { type: 'group', children }
  }
}

// The version label above each promotion hexagon, centred on it, by the same rule. The hexagon sits
// HEXAGON_OFFSET_PX above the top of the plot (see the promotions series).
const HEXAGON_OFFSET_PX = 24
// The strip to the right of the plot that holds the limit label, so no bar or band can cover it.
const LIMIT_MARGIN_PX = 80
function versionRenderItem(ink: string) {
  let lastRight = -Infinity
  return (params: CustomParams, a: CustomApi) => {
    if (params.dataIndexInside === 0) lastRight = -Infinity
    const cs = params.coordSys
    const [x, y] = a.coord([a.value(0), 1])
    // The data holds the promotion's index, because a custom series reads every value as a number.
    const p = promotions.value[Number(a.value(2))]
    if (!p || !p.new_version) return null
    const text = `v${p.new_version.replace(/^v/i, '')}`
    const width = textWidth(text, VERSION_FONT)
    const left = x - width / 2
    const right = x + width / 2
    if (left < cs.x || right > cs.x + cs.width || left - lastRight < LABEL_GAP_PX) return null
    lastRight = right
    const size = Number(a.value(3)) || 16
    return { type: 'text', x, y: y - HEXAGON_OFFSET_PX - size / 2 - 4, style: { text, fill: ink, font: VERSION_FONT, textAlign: 'center', textVerticalAlign: 'bottom' } }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}

// The latest reference measured at or before the end of a day.
function referenceBy(end: number): DriftReference | null {
  let found: DriftReference | null = null
  for (const r of reference.value) {
    if (r.time > end) break
    if (r.memory_median !== null) found = r
  }
  return found
}

// One tooltip per day: the bar, the reference and any promotion of that day.
function tooltip(params: unknown): string {
  const list = (Array.isArray(params) ? params : [params]) as { seriesName?: string, value?: number[] }[]
  const hover = list.find(p => p.seriesName === HOVER_NAME)
  if (!hover?.value) return ''
  const start = Math.floor(hover.value[0] / DAY_MS) * DAY_MS
  const day = dayList.value.find(d => d.day === start)
  const rows = [`<b>${utcDate(start)}</b> (UTC day)`]
  if (day && day.rate !== null) {
    rows.push(`${BAR_NAME}: ${percent(day.rate)}`)
    if (day.false_alarms !== null && day.normal_minutes !== null) rows.push(`${day.false_alarms} false alarms in ${day.normal_minutes} normal minutes`)
  }
  else {
    rows.push('No saved report for this day')
  }
  const ref = referenceBy(start + DAY_MS)
  if (ref) rows.push(`${REFERENCE_NAME}: ${megabytes(ref.memory_median)}`)
  for (const p of promotions.value.filter(p => p.time >= start && p.time < start + DAY_MS)) {
    rows.push(`${PROMOTION_NAME} ${escapeHtml(promotionTitle(p))} at ${escapeHtml(withZone(localStamp(p.time)))}, ${escapeHtml(f1Text(p))}`)
  }
  return rows.join('<br>')
}

function axisDate(v: number): string {
  return utcDate(v)
}

const option = computed(() => {
  const c = palette.value
  void fontReady.value
  const axisText = { color: c.faint, fontFamily: MONO, fontSize: 11 }
  // Episode bands use the medium tier colours (DESIGN.md section 1): the marker colour at low opacity
  // and the badge text colour for the label.
  const bandFill = withAlpha(c.tiers.medium, 0.12)
  const bandInk = cssVar('--tier-medium-fg', '#B45309')
  const first = data.value?.from ?? 0
  const last = data.value?.to ?? 1
  const dayStarts: number[] = []
  for (let t = first; t < last; t += DAY_MS) dayStarts.push(t)
  const promoted = promotions.value.map(p => ({
    value: [p.time, 1, p.new_version ?? ''],
    symbolSize: p.time === selectedPromotion.value ? 22 : 16,
    itemStyle: { color: c.panel, borderColor: c.chartline, borderWidth: p.time === selectedPromotion.value ? 2.5 : 1.5 },
  }))
  return {
    animation: false,
    useUTC: true,
    grid: { left: 52, right: reference.value.length ? 56 + LIMIT_MARGIN_PX : LIMIT_MARGIN_PX, top: 56, bottom: 84 },
    tooltip: {
      trigger: 'axis',
      formatter: tooltip,
      confine: true,
      backgroundColor: c.panel,
      borderColor: c.line,
      borderWidth: 1,
      textStyle: { color: c.ink, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: c.thresh } },
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
        left: 52,
        right: reference.value.length ? 56 + LIMIT_MARGIN_PX : LIMIT_MARGIN_PX,
        borderColor: c.line,
        backgroundColor: 'transparent',
        fillerColor: withAlpha(c.primary, 0.12),
        dataBackground: { lineStyle: { color: c.thresh }, areaStyle: { color: withAlpha(c.thresh, 0.2) } },
        handleStyle: { color: c.panel, borderColor: c.thresh },
        moveHandleStyle: { color: c.thresh },
        textStyle: { color: c.faint, fontFamily: MONO, fontSize: 11 },
        labelFormatter: (v: number) => axisDate(v),
      },
    ],
    xAxis: {
      type: 'time',
      min: first,
      max: last,
      axisLine: { lineStyle: { color: c.grid } },
      axisTick: { lineStyle: { color: c.grid } },
      splitLine: { show: false },
      axisLabel: { ...axisText, formatter: (v: number) => axisDate(v), hideOverlap: true },
      // The bars are UTC days.
      name: 'UTC day',
      nameLocation: 'middle',
      nameGap: 26,
      nameTextStyle: { ...axisText },
    },
    yAxis: [
      {
        type: 'value',
        min: 0,
        max: rateMax.value,
        splitNumber: 3,
        axisLine: { show: false },
        splitLine: { lineStyle: { color: c.grid, type: [3, 4] } },
        axisLabel: { ...axisText, formatter: (v: number) => `${Math.round(v * 1000) / 10}%` },
      },
      {
        // The reference level, on its own axis in MB.
        type: 'value',
        show: reference.value.length > 0,
        min: 0,
        splitNumber: 3,
        position: 'right',
        // Moved outward so the limit label has the strip between the plot edge and these labels.
        offset: LIMIT_MARGIN_PX,
        axisLine: { show: false },
        splitLine: { show: false },
        axisLabel: { ...axisText, formatter: (v: number) => `${v} MB` },
      },
      // Room for the promotion hexagons above the plot.
      { type: 'value', show: false, min: 0, max: 1 },
    ],
    series: [
      {
        // Episode bands, behind everything else.
        name: 'Episode',
        type: 'custom',
        silent: true,
        z: 1,
        clip: true,
        tooltip: { show: false },
        renderItem: bandRenderItem(bandFill, bandInk),
        encode: { x: [0, 1] },
        data: episodes.value.map((e, i) => [e.start, e.end, i + 1]),
      },
      {
        // Guides: the episode threshold and a dashed line at each promotion.
        name: 'Guides',
        type: 'line',
        data: [],
        silent: true,
        tooltip: { show: false },
        markLine: {
          silent: true,
          symbol: 'none',
          animation: false,
          lineStyle: { color: c.thresh, type: 'dashed', width: 1 },
          label: { show: false },
          data: [
            { yAxis: threshold.value, label: { show: true, formatter: `${thresholdText.value} limit`, position: 'end', distance: 6, align: 'left', verticalAlign: 'middle', color: c.faint, fontSize: 11, fontFamily: MONO } },
            ...promotions.value.map(p => ({ xAxis: p.time })),
          ],
        },
      },
      {
        name: BAR_NAME,
        type: 'custom',
        silent: true,
        z: 2,
        clip: true,
        tooltip: { show: false },
        renderItem: barRenderItem(c.chartline, c.ink),
        encode: { x: 0, y: 1 },
        data: dayList.value.filter(d => d.rate !== null).map(d => [d.day, d.rate]),
      },
      {
        name: REFERENCE_NAME,
        type: 'line',
        yAxisIndex: 1,
        z: 3,
        step: 'end',
        showSymbol: false,
        silent: true,
        tooltip: { show: false },
        lineStyle: { width: 2, color: c.chartline },
        itemStyle: { color: c.chartline },
        data: reference.value.filter(r => r.memory_median !== null).map(r => [r.time, r.memory_median]),
      },
      {
        name: PROMOTION_NAME,
        type: 'scatter',
        yAxisIndex: 2,
        z: 4,
        symbol: HEXAGON,
        symbolOffset: [0, -HEXAGON_OFFSET_PX],
        cursor: 'pointer',
        tooltip: { show: false },
        label: { show: false },
        data: promoted,
      },
      {
        // The version labels above the hexagons, drawn only where they fit (versionRenderItem).
        name: 'Versions',
        type: 'custom',
        yAxisIndex: 2,
        z: 5,
        silent: true,
        clip: false,
        tooltip: { show: false },
        renderItem: versionRenderItem(c.ink),
        encode: { x: 0, y: 1 },
        data: promotions.value.map((p, i) => [p.time, 1, i, p.time === selectedPromotion.value ? 22 : 16]),
      },
      {
        // An invisible point in the middle of every day, so the tooltip always describes the day under the pointer.
        name: HOVER_NAME,
        type: 'line',
        z: 0,
        showSymbol: false,
        lineStyle: { width: 0, opacity: 0 },
        data: dayStarts.map(t => [t + DAY_MS / 2, 0]),
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

// A hexagon was clicked.
function onClick(params: { seriesName?: string, dataIndex?: number }) {
  if (params.seriesName === PROMOTION_NAME && typeof params.dataIndex === 'number') {
    const p = promotions.value[params.dataIndex]
    if (p) togglePromotion(p.time)
  }
}

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

const chartLabel = computed(() => {
  const parts = [`Daily false alarm rate for ${days.value} days`]
  if (episodes.value.length) parts.push(`${episodes.value.length} drift ${episodes.value.length === 1 ? 'episode' : 'episodes'} shaded`)
  if (promotions.value.length) parts.push(`${promotions.value.length} model ${promotions.value.length === 1 ? 'promotion' : 'promotions'} marked with hexagons`)
  if (reference.value.length) parts.push('the normal memory level as a line on the right axis')
  return `${parts.join(', ')}.`
})

const card = 'rounded-xl border border-border p-4'
const bigNumber = 'mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]'
const note = 'rounded-lg bg-chip p-3 text-[13px] text-chipfg'
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Drift</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">
        When normal behaviour changed, how the model reacted, and how it recovered.
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
      <Skeleton v-for="n in 4" :key="n" class="h-[116px] rounded-xl" />
    </div>
    <Skeleton class="h-[320px] rounded-xl" />
  </template>

  <p v-else-if="failed && !data" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    InfluxDB did not answer. Retrying in 5 min.
  </p>

  <template v-else-if="data">
    <p v-if="failed" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      Drift data could not be refreshed. Showing the last loaded data.
    </p>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <section aria-label="Days above the limit" :class="card">
        <div class="text-[13px] text-muted-foreground">Days above {{ thresholdText }}</div>
        <div v-if="hasReport" :class="bigNumber">{{ daysAbove }}</div>
        <div v-else class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">No data</div>
        <div class="mt-0.5 text-xs text-muted-foreground">{{ hasReport ? `of ${daysWithRate} days with a saved report` : 'no saved report in this range' }}</div>
      </section>

      <section aria-label="Drift episodes" :class="card">
        <div class="text-[13px] text-muted-foreground">Episodes</div>
        <div v-if="hasReport" :class="bigNumber">{{ episodes.length }}</div>
        <div v-else class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">No data</div>
        <div class="mt-0.5 text-xs text-muted-foreground">
          <template v-if="!hasReport">needs a saved report</template>
          <template v-else-if="episodes.length === 0">no run of days above the limit</template>
          <template v-else>longest {{ longestEpisode }} {{ longestEpisode === 1 ? 'day' : 'days' }}, peak {{ percent(peakRate) }}</template>
        </div>
      </section>

      <section aria-label="Model promotions" :class="card">
        <div class="text-[13px] text-muted-foreground">Promotions</div>
        <div :class="bigNumber">{{ promotions.length }}</div>
        <div class="mt-0.5 text-xs text-muted-foreground">
          {{ latestPromotion ? `latest ${promotionTitle(latestPromotion)}, ${withZone(localStamp(latestPromotion.time))}` : 'no new model in this range' }}
        </div>
      </section>

      <section aria-label="Latest reference level" :class="card">
        <div class="text-[13px] text-muted-foreground">Latest reference level</div>
        <div v-if="latest && latest.memory_median !== null" :class="bigNumber">{{ megabytes(latest.memory_median) }}</div>
        <div v-else class="mt-2.5 text-[22px] font-semibold tracking-[-0.02em]">No data</div>
        <div class="mt-0.5 text-xs text-muted-foreground">
          {{ latest && latest.memory_median !== null ? `normal memory, 99th percentile ${megabytes(latest.memory_p99)}, ${withZone(localStamp(latest.time))}` : 'the worker has not saved a reference yet' }}
        </div>
      </section>
    </div>

    <p v-if="!hasReport" :class="note" role="status">
      No saved report yet. Run detection_report.py --save on the server.
    </p>

    <section aria-labelledby="drift-chart-title" class="min-w-0 rounded-xl border border-border px-[18px] py-4">
      <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div class="min-w-0">
          <h2 id="drift-chart-title" class="text-[15px] font-semibold">False alarms per day, with model changes</h2>
          <p class="text-xs text-muted-foreground">Shaded bands are runs of days above {{ thresholdText }}. The line is what the model treats as normal memory.</p>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span class="inline-flex items-center gap-1.5"><span class="inline-block size-2.5 rounded-[2px] bg-chartline" aria-hidden="true" />False alarm rate</span>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-3 bg-chartline" aria-hidden="true" />Normal memory, right axis</span>
          <span class="inline-flex items-center gap-1.5">
            <svg class="size-3" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 21 6.75v10.5L12 22.5 3 17.25V6.75z" fill="var(--panel)" stroke="var(--chartline)" stroke-width="2.5" /></svg>
            Model promoted
          </span>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block size-2.5 rounded-[2px] bg-tier-medium-marker/15 ring-1 ring-tier-medium-marker/40" aria-hidden="true" />Episode</span>
        </div>
      </div>
      <p v-if="!hasChart" class="py-16 text-center text-[13px] text-muted-foreground">No reference or promotions in this range either.</p>
      <div v-else ref="box" class="h-[300px] w-full min-w-0 md:h-[340px]" role="img" :aria-label="chartLabel">
        <VChart ref="chart" class="size-full" :option="option" autoresize @click="onClick" @datazoom="onDataZoom" />
      </div>
    </section>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
      <section aria-labelledby="promotions-title" class="min-w-0 rounded-xl border border-border p-4">
        <h2 id="promotions-title" class="text-[15px] font-semibold">Model promotions</h2>
        <p class="mb-2 text-xs text-muted-foreground">Select one for the versions and the test F1 of the old and new model. Times are local{{ zone ? ` (${zone})` : '' }}.</p>
        <p v-if="promotions.length === 0" class="py-4 text-[13px] text-muted-foreground">No new model was promoted in this range.</p>
        <ul v-else class="flex flex-col gap-1">
          <li v-for="p in promotions" :key="p.time">
            <button
              type="button"
              class="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-chip pointer-coarse:min-h-11"
              :class="selectedPromotion === p.time ? 'bg-chip ring-1 ring-border' : ''"
              :aria-pressed="selectedPromotion === p.time"
              @click="togglePromotion(p.time)"
            >
              <span class="font-mono">{{ promotionTitle(p) }}</span>
              <span class="text-xs text-muted-foreground">{{ localStamp(p.time) }}</span>
            </button>
          </li>
        </ul>
        <p v-if="chosen" :class="[note, 'mt-2']" role="status">
          Promoted {{ promotionTitle(chosen) }} on {{ withZone(localStamp(chosen.time)) }}. {{ f1Text(chosen) }}, both measured on the same test minutes.
        </p>
      </section>

      <section aria-labelledby="episodes-title" class="min-w-0 rounded-xl border border-border p-4">
        <h2 id="episodes-title" class="text-[15px] font-semibold">Episodes</h2>
        <p class="mb-2 text-xs text-muted-foreground">Consecutive days with more than {{ thresholdText }} false alarms.</p>
        <p v-if="!hasReport" class="py-4 text-[13px] text-muted-foreground">Needs a saved report.</p>
        <p v-else-if="episodes.length === 0" class="py-4 text-[13px] text-muted-foreground">No episode in this range.</p>
        <ul v-else class="flex flex-col divide-y divide-border">
          <li v-for="(e, i) in episodes" :key="e.start" class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 text-[13px]">
            <span class="font-medium">{{ episodeLabel(i + 1) }}</span>
            <span class="w-full text-xs text-muted-foreground">{{ e.days }} {{ e.days === 1 ? 'day' : 'days' }}, peak {{ percent(e.peak_rate) }}, {{ e.false_alarms }} false alarms</span>
          </li>
        </ul>
      </section>

      <section aria-labelledby="meaning-title" class="min-w-0 rounded-xl border border-border p-4">
        <h2 id="meaning-title" class="text-[15px] font-semibold">What drift means here</h2>
        <div class="mt-2 flex flex-col gap-2 text-[13px] text-muted-foreground">
          <p>The model learns what normal looks like. When the system itself changes, for example a new server or a new runtime, normal moves and the model keeps flagging healthy minutes.</p>
          <p>That shows up as a run of days with many false alarms. The line is the normal level the worker measures; it steps when normal changes. A hexagon marks a night when the model was retrained and replaced.</p>
        </div>
      </section>
    </div>
  </template>
</template>
