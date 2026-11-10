<script setup lang="ts">
import type { ResourceSeries, ZoomWindow } from '@/types'
import { LineChart } from 'echarts/charts'
import { DataZoomInsideComponent, DataZoomSliderComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { connect, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { MONO, useChartTheme, withAlpha } from '@/lib/chartTheme'
import { clockTime, localDateTime, shortDate } from '@/lib/format'

use([LineChart, GridComponent, TooltipComponent, DataZoomInsideComponent, DataZoomSliderComponent, CanvasRenderer])

// One history panel on the Resources page. Every panel on the page is in the same ECharts group,
// so zooming or panning one moves all of them; the page keeps the window and passes it back in.
const props = defineProps<{
  title: string
  description: string
  series: { name: string, data: ResourceSeries, colour: 'chartline' | 'series2' }[]
  // percent: 0 to 100; rate: bytes per second.
  kind: 'percent' | 'rate'
  // The loaded window in ms and the step between points.
  start: number
  end: number
  stepMs: number
  // Zoom window in percent of [start, end].
  zoom: ZoomWindow
  group: string
  // The slider under the chart; only the last panel shows it.
  slider?: boolean
}>()

const emit = defineEmits<{ zoom: [window: ZoomWindow] }>()

const { palette, fontReady } = useChartTheme()

// Bytes per second in decimal units.
function rate(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)} GB/s`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)} MB/s`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)} KB/s`
  return `${Math.round(v)} B/s`
}
function format(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return 'No data'
  return props.kind === 'percent' ? `${v.toFixed(1)}%` : rate(v)
}

// A gap longer than one and a half steps breaks the line instead of drawing across it.
function withGaps(data: ResourceSeries): ResourceSeries {
  const out: ResourceSeries = []
  for (let i = 0; i < data.length; i++) {
    if (i > 0 && data[i][0] - data[i - 1][0] > props.stepMs * 1.5) out.push([data[i - 1][0] + props.stepMs, null])
    out.push(data[i])
  }
  return out
}

const empty = computed(() => props.series.every(s => s.data.every(p => p[1] === null)))

// Latest value of each line for the legend.
const legend = computed(() =>
  props.series.map((s) => {
    let now: number | null = null
    for (let i = s.data.length - 1; i >= 0; i--) {
      if (s.data[i][1] !== null) {
        now = s.data[i][1]
        break
      }
    }
    return { name: s.name, colour: s.colour, now: format(now) }
  }),
)

const chart = ref<InstanceType<typeof VChart> | null>(null)

// The window the chart was last drawn with. Not reactive on purpose: the option is rebuilt for new
// data or a theme change, and then takes the current window, but a zoom alone does not rebuild it.
let drawn: ZoomWindow = { ...props.zoom }

// Drag to pan only where the main pointer is a mouse, so a finger can still scroll the page.
// Pinch zoom, the slider and the toolbar work everywhere.
const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches !== false

function tooltip(params: unknown): string {
  const list = (Array.isArray(params) ? params : [params]) as { seriesName?: string, value?: [number, number | null] }[]
  const first = list[0]
  if (!first?.value) return ''
  const rows = list.map(p => `${p.seriesName}: ${format(p.value ? p.value[1] : null)}`)
  return [localDateTime(first.value[0]), ...rows].join('<br>')
}

function axisTime(v: number): string {
  const d = new Date(v)
  return d.getHours() === 0 && d.getMinutes() === 0 ? shortDate(v) : clockTime(v)
}

const option = computed(() => {
  const c = palette.value
  void fontReady.value
  const axisText = { color: c.faint, fontFamily: MONO, fontSize: 11 }
  const colourOf = (k: 'chartline' | 'series2') => (k === 'chartline' ? c.chartline : c.series2)
  return {
    animation: false,
    grid: { left: 64, right: 12, top: 8, bottom: props.slider ? 64 : 24 },
    tooltip: {
      trigger: 'axis',
      formatter: tooltip,
      backgroundColor: c.panel,
      borderColor: c.line,
      borderWidth: 1,
      textStyle: { color: c.ink, fontSize: 12 },
      axisPointer: { lineStyle: { color: c.thresh } },
    },
    // The same two zooms with the same ids in every panel, so connect relays them by id. Only the
    // last panel shows its slider.
    dataZoom: [
      {
        id: 'zi',
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        start: drawn.start,
        end: drawn.end,
        moveOnMouseMove: finePointer,
        // A plain wheel scrolls the page; Ctrl + wheel (and a trackpad pinch, which arrives as
        // Ctrl + wheel) zooms.
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
      },
      {
        id: 'zs',
        type: 'slider',
        show: props.slider === true,
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
        labelFormatter: (v: number) => axisTime(v),
      },
    ],
    xAxis: {
      type: 'time',
      min: props.start,
      max: props.end,
      axisLine: { lineStyle: { color: c.grid } },
      axisTick: { lineStyle: { color: c.grid } },
      splitLine: { show: false },
      axisLabel: { ...axisText, formatter: (v: number) => axisTime(v), hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      min: 0,
      // Percent charts: fixed 0, 25, 50, 75, 100, so no label is squeezed in under 100.
      max: props.kind === 'percent' ? 100 : undefined,
      interval: props.kind === 'percent' ? 25 : undefined,
      splitNumber: props.kind === 'percent' ? undefined : 3,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: c.grid, type: [3, 4] } },
      axisLabel: { ...axisText, formatter: (v: number) => (props.kind === 'percent' ? `${v}%` : rate(v)) },
    },
    series: props.series.map((s, i) => ({
      name: s.name,
      type: 'line',
      data: withGaps(s.data),
      showSymbol: false,
      connectNulls: false,
      lineStyle: { width: 1.6, color: colourOf(s.colour) },
      itemStyle: { color: colourOf(s.colour) },
      // Area fill on the first line only.
      areaStyle: i === 0
        ? {
            origin: 'start',
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: withAlpha(colourOf(s.colour), 0.12) },
                { offset: 1, color: withAlpha(colourOf(s.colour), 0) },
              ],
            },
          }
        : undefined,
    })),
  }
})

const close = (a: ZoomWindow, b: ZoomWindow) => Math.abs(a.start - b.start) < 0.01 && Math.abs(a.end - b.end) < 0.01

function currentZoom(): ZoomWindow | null {
  const opt = chart.value?.getOption() as { dataZoom?: { start?: number, end?: number }[] } | undefined
  const dz = opt?.dataZoom?.[0]
  return dz && typeof dz.start === 'number' && typeof dz.end === 'number' ? { start: dz.start, end: dz.end } : null
}

// A wheel, pinch, drag or slider move, here or in a connected panel.
function onDataZoom() {
  const z = currentZoom()
  if (!z) return
  drawn = z
  if (!close(z, props.zoom)) emit('zoom', z)
}

// A toolbar button or a preset changed the window: one dataZoom action, which connect passes on
// to the other panels in the group. A panel that already shows the window does nothing.
watch(() => props.zoom, (z) => {
  drawn = { ...z }
  const now = currentZoom()
  if (now && close(now, z)) return
  chart.value?.dispatchAction({ type: 'dataZoom', dataZoomId: 'zi', start: z.start, end: z.end })
}, { deep: true })

onMounted(() => connect(props.group))

// The browser zooms the whole page on Ctrl + wheel. Over the plot area ECharts uses that wheel
// to zoom the chart, so the page zoom is stopped there only; a plain wheel and Ctrl + wheel
// outside the plot area are left alone. The listener is not passive, so preventDefault works.
const box = ref<HTMLElement | null>(null)
function onWheel(e: WheelEvent) {
  if (!e.ctrlKey || !box.value) return
  const rect = box.value.getBoundingClientRect()
  const point = [e.clientX - rect.left, e.clientY - rect.top]
  if (chart.value?.containPixel({ gridIndex: 0 }, point)) e.preventDefault()
}
watch(box, (el, old) => {
  old?.removeEventListener('wheel', onWheel)
  el?.addEventListener('wheel', onWheel, { passive: false })
})
onUnmounted(() => box.value?.removeEventListener('wheel', onWheel))
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 class="text-sm font-semibold">{{ title }}</h3>
      <span class="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span v-for="l in legend" :key="l.name" class="inline-flex items-center gap-1.5">
          <span class="inline-block h-0.5 w-3" :class="l.colour === 'chartline' ? 'bg-chartline' : 'bg-series2'" aria-hidden="true" />
          {{ l.name }} <span class="font-mono text-foreground">{{ l.now }}</span>
        </span>
      </span>
    </div>
    <p v-if="empty" class="flex h-[200px] items-center justify-center text-[13px] text-muted-foreground">No data in this window</p>
    <div v-else ref="box" :class="slider ? 'h-[240px]' : 'h-[200px]'" class="w-full" role="img" :aria-label="description">
      <VChart ref="chart" class="size-full" :option="option" :group="group" autoresize @datazoom="onDataZoom" />
    </div>
  </div>
</template>
