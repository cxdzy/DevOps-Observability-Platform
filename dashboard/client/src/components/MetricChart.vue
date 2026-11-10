<script setup lang="ts">
import type { AnomalyPoint, ChartWindow, ZoomWindow } from '@/types'
import { LineChart } from 'echarts/charts'
import { DataZoomInsideComponent, DataZoomSliderComponent, GridComponent, LegendPlainComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, onUnmounted, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { useWheelScrollsPage } from '@/components/ResourceChart.vue'
import { LINE_ICON, MONO, useChartTheme, withAlpha } from '@/lib/chartTheme'
import { clockTime, localDateTime } from '@/lib/format'

use([LineChart, GridComponent, TooltipComponent, DataZoomInsideComponent, DataZoomSliderComponent, LegendPlainComponent, MarkLineComponent, CanvasRenderer])

// sample-service metrics from the scored minutes the Overview already loads (last 6 hours).
const props = defineProps<{
  points: AnomalyPoint[]
  // Zoom window in percent of the loaded range; the view owns it.
  zoom: ZoomWindow
  // Times (ms) of early warnings, drawn as dashed vertical lines in the warn colour.
  warnings: number[]
}>()
const emit = defineEmits<{ zoom: [window: ZoomWindow], window: [window: ChartWindow] }>()

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

// The window the chart was last drawn with. Not reactive on purpose: the option is rebuilt for new
// data, a metric change or a theme change and then takes the current window, but a zoom alone does
// not rebuild it.
let drawn: ZoomWindow = { ...props.zoom }

// Drag to pan only where the main pointer is a mouse, so a finger can still scroll the page.
const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches !== false

type Metric = 'cpu' | 'memory' | 'latency'
// cpu_rate is the share of one CPU core, shown in percent.
const METRICS: Record<Metric, { label: string, unit: string, digits: number, value: (p: AnomalyPoint) => number | null }> = {
  cpu: { label: 'CPU', unit: '% of a core', digits: 1, value: p => (p.cpu_rate === null ? null : p.cpu_rate * 100) },
  memory: { label: 'Memory', unit: 'MB', digits: 1, value: p => p.memory_mb },
  latency: { label: 'Latency', unit: 'ms', digits: 1, value: p => p.latency_ms },
}
const metric = ref<Metric>('memory')
const current = computed(() => METRICS[metric.value])

const latest = computed(() => {
  for (let i = props.points.length - 1; i >= 0; i--) {
    const v = current.value.value(props.points[i])
    if (v !== null) return v
  }
  return null
})

// The same theme handling as AnomalyChart, from lib/chartTheme.
const { palette, fontReady } = useChartTheme()

function tooltip(params: unknown): string {
  const list = Array.isArray(params) ? params : [params]
  const first = list[0] as { value?: [number, number | null] } | undefined
  if (!first?.value || first.value[1] === null) return ''
  return `${localDateTime(first.value[0])}<br>${current.value.label}: ${first.value[1].toFixed(current.value.digits)} ${current.value.unit}`
}

const option = computed(() => {
  const c = palette.value
  void fontReady.value
  const m = current.value
  const axisText = { color: c.faint, fontFamily: MONO, fontSize: 11 }
  return {
    animation: false,
    // The bottom leaves room for the time labels and the slider.
    grid: { left: GRID_LEFT, right: GRID_RIGHT, top: 32, bottom: 72 },
    legend: {
      top: 0,
      data: [{ name: m.label, icon: LINE_ICON, itemStyle: { color: c.chartline } }],
      textStyle: { color: c.muted, fontSize: 12 },
      inactiveColor: c.thresh,
      selectedMode: false,
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
        labelFormatter: (v: number) => clockTime(v),
      },
    ],
    xAxis: {
      type: 'time',
      min: axisRange.value.min,
      max: axisRange.value.max,
      axisLine: { lineStyle: { color: c.grid } },
      axisTick: { lineStyle: { color: c.grid } },
      splitLine: { show: false },
      axisLabel: { ...axisText, formatter: (v: number) => clockTime(v), hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: c.grid, type: [3, 4] } },
      axisLabel: axisText,
    },
    series: [
      {
        name: m.label,
        type: 'line',
        data: props.points.map(p => [p.time, m.value(p)]),
        sampling: 'lttb',
        showSymbol: false,
        lineStyle: { width: 1.75, color: c.chartline },
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
    ],
  }
})

const chart = ref<InstanceType<typeof VChart> | null>(null)
// The chart's container; also the width the event lane under the chart must match.
const box = ref<HTMLElement | null>(null)
const close = (a: ZoomWindow, b: ZoomWindow) => Math.abs(a.start - b.start) < 0.01 && Math.abs(a.end - b.end) < 0.01

function currentZoom(): ZoomWindow | null {
  const opt = chart.value?.getOption() as { dataZoom?: { start?: number, end?: number }[] } | undefined
  const dz = opt?.dataZoom?.[0]
  return dz && typeof dz.start === 'number' && typeof dz.end === 'number' ? { start: dz.start, end: dz.end } : null
}

// The visible time range and the drawn plot edges, for the event lane under the chart. Sent again
// after every render (new data, metric switch, zoom, resize, theme), but only when something changed.
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

// A toolbar button changed the window: one dataZoom action.
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
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2.5">
      <div>
        <h2 class="font-mono text-[15px] font-semibold">sample-service</h2>
        <p class="text-xs text-muted-foreground">{{ current.label }}, last 6 hours</p>
      </div>
      <div role="group" aria-label="Metric" class="flex gap-0.5 rounded-lg bg-chip p-[3px]">
        <button
          v-for="(m, key) in METRICS"
          :key="key"
          type="button"
          class="min-h-9 rounded-md px-3 text-[13px] md:min-h-8"
          :class="metric === key ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
          :aria-pressed="metric === key"
          @click="metric = key"
        >
          {{ m.label }}
        </button>
      </div>
    </div>
    <div class="flex items-baseline gap-2">
      <span class="font-mono text-2xl font-medium">{{ latest === null ? 'No data' : latest.toFixed(current.digits) }}</span>
      <span v-if="latest !== null" class="text-xs text-muted-foreground">{{ current.unit }}, latest minute</span>
    </div>
    <div ref="box" class="h-[260px] w-full" role="img" :aria-label="`sample-service ${current.label.toLowerCase()} over the last 6 hours`">
      <VChart ref="chart" class="size-full" :option="option" autoresize @datazoom="onDataZoom" @finished="emitWindow" />
    </div>
  </div>
</template>
