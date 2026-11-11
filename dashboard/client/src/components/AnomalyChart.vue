<script setup lang="ts">
import type { AnomalyPoint, ChartWindow, ZoomWindow } from '@/types'
import { CustomChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendPlainComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import { graphic, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useElementSize, useMediaQuery } from '@vueuse/core'
import { computed, onUnmounted, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { findEpisodes, isFlagged, MINUTE_MS, restartTimes, warmupRuns } from '@/components/MinuteStrip.vue'
import { useWheelScrollsPage } from '@/components/ResourceChart.vue'
import { hatchTile, LINE_ICON, MONO, useChartTheme, withAlpha } from '@/lib/chartTheme'
import { clockTime, fixed, localDateTime, shortDate } from '@/lib/format'
import { FLAG_TIERS, TIER_STYLE, toTier } from '@/lib/tier'

use([CustomChart, LineChart, ScatterChart, GridComponent, TooltipComponent, DataZoomInsideComponent, DataZoomSliderComponent, LegendPlainComponent, MarkLineComponent, CanvasRenderer])

const props = defineProps<{
  points: AnomalyPoint[]
  hours: number
  selected: number | null
  // Zoom window in percent of the loaded range; the view owns it.
  zoom: ZoomWindow
  // Times (ms) of early warnings, drawn as dashed vertical lines in the warn colour.
  warnings: number[]
}>()
const emit = defineEmits<{ select: [time: number], zoom: [window: ZoomWindow], window: [window: ChartWindow] }>()

// Pixel insets of the plot area as configured. ECharts 6 can move the plot edges inwards to keep
// axis labels inside the canvas, so the window event measures the drawn edges once the chart has
// rendered and uses these only until then.
const GRID_LEFT = 48
const GRID_RIGHT = 16

// The x axis covers the loaded range, so a zoom percent means the same times everywhere.
const axisRange = computed(() => {
  const pts = props.points
  const min = pts.length ? pts[0].time : 0
  const max = pts.length ? pts[pts.length - 1].time : 0
  return { min, max: max > min ? max : min + 60000 }
})

const chart = ref<InstanceType<typeof VChart> | null>(null)
// The chart's container; also the width the event lane under the chart must match.
const box = ref<HTMLElement | null>(null)

// On phones the legend wraps to two lines, so the plot starts lower.
const narrow = useMediaQuery('(max-width: 639px)')

// Theme colours and the font redraw come from lib/chartTheme.
const { palette, fontReady } = useChartTheme()

// Legend icon for the threshold: a dashed bar, 24 by 2, next to the solid LINE_ICON.
const DASHED_ICON = 'path://M0 0h5v2H0zM9 0h5v2H9zM18 0h6v2h-6z'

// An open chevron, drawn as an outline only so it reads as hollow.
const CHEVRON = 'path://M0 9L6 1L12 9'

const EW_NAME = 'Early warning, watch only'
const RESTART_NAME = 'Restart'
const WARMUP_NAME = 'Warm-up'

// The legend wraps to as many rows as the chart's width needs, and the plot starts below it. Rows
// are counted the way the ECharts legend lays them out: 25 px icon, 5 px gap, the text in the
// legend font, 10 px between items and rows, 5 px padding. One row puts the plot at 40 px and each
// further row adds 24 px. Without a measured width, phones assume two rows.
const LEGEND_FONT = '12px sans-serif'
const LEGEND_NAMES = ['Score', 'Threshold', ...FLAG_TIERS.map(t => TIER_STYLE[t].label), EW_NAME, RESTART_NAME, WARMUP_NAME]
const { width: boxWidth } = useElementSize(box)
let measure: CanvasRenderingContext2D | null = null
const legendRows = computed(() => {
  const max = boxWidth.value - 10
  measure ??= document.createElement('canvas').getContext('2d')
  if (max <= 0 || !measure) return narrow.value ? 2 : 1
  measure.font = LEGEND_FONT
  let rows = 1
  let x = 0
  for (const name of LEGEND_NAMES) {
    const w = 30 + Math.ceil(measure.measureText(name).width)
    if (x > 0 && x + w > max) {
      rows++
      x = 0
    }
    x += w + 10
  }
  return rows
})
const gridTop = computed(() => 40 + 24 * (legendRows.value - 1))
// The chart is 300 px tall (360 px from md), sized for one legend row (two on phones). Each extra
// row makes it taller by that row, so the plot keeps its height.
const wide = useMediaQuery('(min-width: 768px)')
const boxHeight = computed(() => `${(wide.value ? 360 : 300) + 24 * Math.max(0, legendRows.value - (narrow.value ? 2 : 1))}px`)

// The window the chart was last drawn with. Not reactive on purpose: the option is rebuilt for new
// data or a theme change and then takes the current window, but a zoom alone does not rebuild it.
let drawn: ZoomWindow = { ...props.zoom }

// Drag to pan only where the main pointer is a mouse, so a finger can still scroll the page.
const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches !== false

const byTime = computed(() => new Map(props.points.map(p => [p.time, p])))

function axisLabel(ms: number): string {
  return props.hours > 24 ? `${shortDate(ms)}\n${clockTime(ms)}` : clockTime(ms)
}

function sliderLabel(ms: number): string {
  const d = new Date(ms)
  return d.getHours() === 0 && d.getMinutes() === 0 ? shortDate(ms) : clockTime(ms)
}

function tooltip(params: unknown): string {
  const list = Array.isArray(params) ? params : [params]
  // The score series carries the minute; the band series hold ranges, not minutes.
  const first = (list.find(p => (p as { seriesName?: string }).seriesName === 'Score') ?? list[0]) as { value?: [number, number] } | undefined
  const point = first?.value ? byTime.value.get(first.value[0]) : undefined
  if (!point) return ''
  const tier = TIER_STYLE[toTier(point.tier)].label
  return [
    localDateTime(point.time),
    `Score: ${fixed(point.score)}`,
    `Threshold: ${fixed(point.threshold)}`,
    `Tier: ${tier}`,
    ...(point.early_warning === 1 ? ['Early warning, watch only'] : []),
    ...(point.warmup === 1 ? ['Warm-up after a restart'] : []),
  ].join('<br>')
}

// Warm-up minutes are never drawn as flagged.
const flaggedPoints = computed(() => props.points.filter(p => isFlagged(p) && p.score !== null))
const warningPoints = computed(() => props.points.filter(p => p.early_warning === 1 && p.score !== null))
const episodes = computed(() => findEpisodes(props.points))
const restarts = computed(() => restartTimes(props.points))
const warmups = computed(() => warmupRuns(props.points))

interface Rect { x: number, y: number, width: number, height: number }
interface CustomApi { value: (dim: number) => number, coord: (v: number[]) => number[] }
interface CustomParams { coordSys: Rect }

// A full-height band over the plot area between two times, with an optional solid top edge.
// Used for the lead band and the warm-up hatch; it is clipped to the plot area.
function bandRenderItem(fill: unknown, edge: string | null) {
  return (params: CustomParams, api: CustomApi) => {
    const a = api.coord([api.value(0), 0])[0]
    const b = api.coord([api.value(1), 0])[0]
    const cs = params.coordSys
    const rect = graphic.clipRectByRect({ x: Math.min(a, b), y: cs.y, width: Math.max(2, Math.abs(b - a)), height: cs.height }, cs)
    if (!rect) return null
    const children: unknown[] = [{ type: 'rect', shape: rect, style: { fill } }]
    if (edge) children.push({ type: 'rect', shape: { x: rect.x, y: rect.y, width: rect.width, height: 2 }, style: { fill: edge } })
    return { type: 'group', children }
  }
}

const option = computed(() => {
  const c = palette.value
  // Read so the option is rebuilt, and the canvas redrawn, when the font arrives.
  void fontReady.value
  const axisText = { color: c.faint, fontFamily: MONO, fontSize: 11 }
  const score = props.points.map(p => [p.time, p.score])
  const threshold = props.points.map(p => [p.time, p.threshold])
  const flagged = FLAG_TIERS.map(tier => ({
    name: TIER_STYLE[tier].label,
    type: 'scatter',
    symbol: TIER_STYLE[tier].symbol,
    symbolSize: 9,
    itemStyle: { color: c.tiers[tier], borderColor: c.panel, borderWidth: 1.5 },
    data: flaggedPoints.value
      .filter(p => toTier(p.tier) === tier)
      .map(p => [p.time, p.score]),
  }))
  const hatch = { image: hatchTile(c.faint), repeat: 'repeat' }
  const selectedPoint = props.selected === null ? undefined : byTime.value.get(props.selected)

  return {
    animation: false,
    // The bottom leaves room for the two-line time labels and the slider.
    grid: { left: GRID_LEFT, right: GRID_RIGHT, top: gridTop.value, bottom: 80 },
    legend: {
      top: 0,
      // Plain line icons for the two lines. The default line icon draws a symbol on top, which
      // ECharts fills with a fixed light colour (a white dot in dark mode).
      data: [
        { name: 'Score', icon: LINE_ICON, itemStyle: { color: c.chartline } },
        { name: 'Threshold', icon: DASHED_ICON, itemStyle: { color: c.thresh } },
        ...FLAG_TIERS.map(t => TIER_STYLE[t].label),
        { name: EW_NAME, icon: CHEVRON, itemStyle: { color: 'transparent', borderColor: c.warn, borderWidth: 1.5 } },
        { name: RESTART_NAME, icon: DASHED_ICON, itemStyle: { color: c.primary } },
        { name: WARMUP_NAME, icon: 'rect', itemStyle: { color: hatch, borderColor: c.faint, borderWidth: 0.5 } },
      ],
      // The same font the row count above measures.
      textStyle: { color: c.muted, fontSize: 12, fontFamily: 'sans-serif' },
      inactiveColor: c.thresh,
    },
    tooltip: {
      trigger: 'axis',
      formatter: tooltip,
      backgroundColor: c.panel,
      borderColor: c.line,
      borderWidth: 1,
      textStyle: { color: c.ink, fontSize: 12 },
      axisPointer: { lineStyle: { color: c.thresh } },
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
        // Room on both sides for the handle time labels, so the end label is not clipped.
        left: 64,
        right: 48,
        borderColor: c.line,
        backgroundColor: 'transparent',
        fillerColor: withAlpha(c.primary, 0.12),
        dataBackground: { lineStyle: { color: c.thresh }, areaStyle: { color: withAlpha(c.thresh, 0.2) } },
        selectedDataBackground: { lineStyle: { color: c.chartline }, areaStyle: { color: withAlpha(c.chartline, 0.15) } },
        handleStyle: { color: c.panel, borderColor: c.thresh },
        moveHandleStyle: { color: c.thresh },
        textStyle: { color: c.faint, fontFamily: MONO, fontSize: 11 },
        // Clock time only (the date at midnight), as on Resources: a date and time label is wider
        // than the room beside the handles and would be clipped at the canvas edge.
        labelFormatter: (v: number) => sliderLabel(v),
      },
    ],
    xAxis: {
      type: 'time',
      min: axisRange.value.min,
      max: axisRange.value.max,
      axisLine: { lineStyle: { color: c.grid } },
      axisTick: { lineStyle: { color: c.grid } },
      splitLine: { show: false },
      axisLabel: { ...axisText, formatter: (v: number) => axisLabel(v), hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: c.grid, type: [3, 4] } },
      axisLabel: { ...axisText, formatter: (v: number) => v.toFixed(2) },
    },
    series: [
      {
        name: 'Score',
        type: 'line',
        data: score,
        // Thins the drawn line on long ranges while keeping peaks; flagged minutes are separate series.
        sampling: 'lttb',
        showSymbol: false,
        lineStyle: { width: 1.5, color: c.chartline },
        itemStyle: { color: c.chartline },
        // Early warnings: dashed vertical lines in the warn colour.
        markLine: {
          silent: true,
          symbol: 'none',
          animation: false,
          label: { show: false },
          lineStyle: { color: c.warn, type: 'dashed', width: 1 },
          data: props.warnings.map(t => ({ xAxis: t })),
        },
        // Area under the line, fading from 12 percent to nothing.
        areaStyle: {
          origin: 'start',
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: withAlpha(c.chartline, 0.12) },
              { offset: 1, color: withAlpha(c.chartline, 0) },
            ],
          },
        },
      },
      {
        name: 'Threshold',
        type: 'line',
        data: threshold,
        step: 'end',
        showSymbol: false,
        lineStyle: { width: 1.5, type: [5, 4], color: c.thresh },
        itemStyle: { color: c.thresh },
      },
      ...flagged,
      {
        // Lead band: from the first warning minute to the first flag, or to the end of the run's
        // last minute. Named like the chevrons, so the legend entry shows and hides both.
        name: EW_NAME,
        type: 'custom',
        silent: true,
        z: 1,
        clip: true,
        tooltip: { show: false },
        renderItem: bandRenderItem(c.warnbg, c.warn),
        encode: { x: [0, 1] },
        data: episodes.value.map(e => [e.start, e.flagAt ?? e.end + MINUTE_MS]),
      },
      {
        // Warm-up minutes: a 45 degree hatch in faint.
        name: WARMUP_NAME,
        type: 'custom',
        silent: true,
        z: 1,
        clip: true,
        tooltip: { show: false },
        renderItem: bandRenderItem(hatch, null),
        encode: { x: [0, 1] },
        data: warmups.value.map(r => [r.start, r.end + MINUTE_MS]),
      },
      {
        // Hollow chevrons on warning minutes.
        name: EW_NAME,
        type: 'scatter',
        symbol: CHEVRON,
        symbolSize: 11,
        z: 4,
        itemStyle: { color: 'transparent', borderColor: c.warn, borderWidth: 1.5 },
        data: warningPoints.value.map(p => [p.time, p.score]),
      },
      {
        // Restart: a dashed primary line at the first minute of each warm-up run.
        name: RESTART_NAME,
        type: 'line',
        data: [],
        silent: true,
        itemStyle: { color: c.primary },
        lineStyle: { color: c.primary },
        markLine: {
          silent: true,
          symbol: 'none',
          animation: false,
          lineStyle: { color: c.primary, type: 'dashed', width: 1 },
          label: { show: true, formatter: RESTART_NAME, color: c.primary, fontSize: 11, position: 'insideEndTop' },
          data: restarts.value.map(t => ({ xAxis: t })),
        },
      },
      {
        // Ring around the selected minute; left out of the legend. A plain circle with a clear
        // fill, because ECharts fills its "empty" symbols with a fixed light colour.
        name: 'Selected',
        type: 'scatter',
        symbol: 'circle',
        symbolSize: 16,
        itemStyle: { color: 'transparent', borderColor: c.primary, borderWidth: 2 },
        tooltip: { show: false },
        data: selectedPoint ? [[selectedPoint.time, selectedPoint.score]] : [],
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

// The visible time range and the drawn plot edges, for the event lane under the chart. Sent again
// after every render (new data, zoom, resize, theme), but only when something changed.
let sent: ChartWindow | null = null
function emitWindow() {
  const { min, max } = axisRange.value
  const span = max - min
  const start = min + (span * drawn.start) / 100
  const end = min + (span * drawn.end) / 100
  let left = GRID_LEFT
  let right = GRID_RIGHT
  const instance = chart.value
  const width = box.value?.clientWidth ?? 0
  if (instance && width > 0) {
    try {
      const a = Number(instance.convertToPixel({ xAxisIndex: 0 }, start))
      const b = Number(instance.convertToPixel({ xAxisIndex: 0 }, end))
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
        left = a
        right = width - b
      }
    }
    catch {
      // Not drawn yet: keep the configured insets.
    }
  }
  const next = { start, end, left, right }
  if (sent && sent.start === start && sent.end === end && Math.abs(sent.left - left) < 0.5 && Math.abs(sent.right - right) < 0.5) return
  sent = next
  emit('window', next)
}
watch(axisRange, emitWindow, { immediate: true })

// A wheel, pinch, drag or slider move.
function onDataZoom() {
  const z = currentZoom()
  if (!z) return
  drawn = z
  if (!close(z, props.zoom)) emit('zoom', z)
  emitWindow()
}

// A toolbar button or a preset changed the window: one dataZoom action.
watch(() => props.zoom, (z) => {
  drawn = { ...z }
  const now = currentZoom()
  if (!now || !close(now, z)) chart.value?.dispatchAction({ type: 'dataZoom', dataZoomId: 'zi', start: z.start, end: z.end })
  // After the action, so the plot edges are measured on the new window.
  emitWindow()
}, { deep: true })

// The browser zooms the whole page on Ctrl + wheel; over the plot area ECharts uses it to zoom the
// chart, so the page zoom is stopped there only.
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
// A plain wheel over the chart scrolls the page.
useWheelScrollsPage(box)

const MARKER_HIT_PX = 8

// A click on a marker selects that flagged minute. Any other click inside the plot selects
// the nearest minute, so points on the line work too. On long ranges one pixel covers several
// minutes, which is why markers are matched by pixel distance first.
function onClick(event: { offsetX: number, offsetY: number }) {
  const instance = chart.value
  if (!instance || props.points.length === 0) return
  const pixel = [event.offsetX, event.offsetY]
  if (!instance.containPixel('grid', pixel)) return

  let marker: AnomalyPoint | null = null
  let best = MARKER_HIT_PX
  for (const p of flaggedPoints.value) {
    const [x, y] = instance.convertToPixel({ gridIndex: 0 }, [p.time, p.score]) as number[]
    const distance = Math.hypot(x - pixel[0], y - pixel[1])
    if (distance <= best) {
      best = distance
      marker = p
    }
  }
  if (marker) {
    emit('select', marker.time)
    return
  }

  const value = instance.convertFromPixel({ gridIndex: 0 }, pixel) as number[]
  const target = value[0]
  const pts = props.points
  let lo = 0
  let hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pts[mid].time < target) lo = mid + 1
    else hi = mid
  }
  const nearest = lo > 0 && target - pts[lo - 1].time < pts[lo].time - target ? pts[lo - 1] : pts[lo]
  emit('select', nearest.time)
}
</script>

<template>
  <div
    ref="box"
    class="w-full"
    :style="{ height: boxHeight }"
    role="img"
    aria-label="Anomaly score over time with the detection threshold and flagged minutes marked by tier (low circle, medium triangle, high diamond), early warnings as hollow chevrons with a shaded lead band, restarts as dashed lines and warm-up minutes hatched"
  >
    <VChart ref="chart" class="size-full" :option="option" autoresize @zr:click="onClick" @datazoom="onDataZoom" @finished="emitWindow" />
  </div>
</template>
