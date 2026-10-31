<script setup lang="ts">
import type { AnomalyPoint } from '@/types'
import { LineChart, ScatterChart } from 'echarts/charts'
import {
  DataZoomInsideComponent,
  GridComponent,
  LegendPlainComponent,
  TooltipComponent,
} from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useMediaQuery } from '@vueuse/core'
import { computed, ref } from 'vue'
import VChart from 'vue-echarts'
import { LINE_ICON, MONO, useChartTheme, withAlpha } from '@/lib/chartTheme'
import { clockTime, fixed, localDateTime, shortDate } from '@/lib/format'
import { FLAG_TIERS, TIER_STYLE, toTier } from '@/lib/tier'

use([LineChart, ScatterChart, GridComponent, TooltipComponent, DataZoomInsideComponent, LegendPlainComponent, CanvasRenderer])

const props = defineProps<{
  points: AnomalyPoint[]
  hours: number
  selected: number | null
}>()
const emit = defineEmits<{ select: [time: number] }>()

const chart = ref<InstanceType<typeof VChart> | null>(null)

// On phones the legend wraps to two lines, so the plot starts lower.
const narrow = useMediaQuery('(max-width: 639px)')

// Theme colours and the font redraw come from lib/chartTheme.
const { palette, fontReady } = useChartTheme()

// Legend icon for the threshold: a dashed bar, 24 by 2, next to the solid LINE_ICON.
const DASHED_ICON = 'path://M0 0h5v2H0zM9 0h5v2H9zM18 0h6v2h-6z'

const byTime = computed(() => new Map(props.points.map(p => [p.time, p])))

function axisLabel(ms: number): string {
  return props.hours > 24 ? `${shortDate(ms)}\n${clockTime(ms)}` : clockTime(ms)
}

function tooltip(params: unknown): string {
  const list = Array.isArray(params) ? params : [params]
  const first = list[0] as { value?: [number, number] } | undefined
  const point = first?.value ? byTime.value.get(first.value[0]) : undefined
  if (!point) return ''
  const tier = TIER_STYLE[toTier(point.tier)].label
  return [
    localDateTime(point.time),
    `Score: ${fixed(point.score)}`,
    `Threshold: ${fixed(point.threshold)}`,
    `Tier: ${tier}`,
  ].join('<br>')
}

const flaggedPoints = computed(() => props.points.filter(p => p.is_anomaly === 1 && p.score !== null))

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
  const selectedPoint = props.selected === null ? undefined : byTime.value.get(props.selected)

  return {
    animation: false,
    grid: { left: 48, right: 16, top: narrow.value ? 64 : 40, bottom: 40 },
    legend: {
      top: 0,
      // Plain line icons for the two lines. The default line icon draws a symbol on top, which
      // ECharts fills with a fixed light colour (a white dot in dark mode).
      data: [
        { name: 'Score', icon: LINE_ICON, itemStyle: { color: c.chartline } },
        { name: 'Threshold', icon: DASHED_ICON, itemStyle: { color: c.thresh } },
        ...FLAG_TIERS.map(t => TIER_STYLE[t].label),
      ],
      textStyle: { color: c.muted, fontSize: 12 },
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
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }],
    xAxis: {
      type: 'time',
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
    class="h-[260px] w-full md:h-[320px]"
    role="img"
    aria-label="Anomaly score over time with the detection threshold and flagged minutes marked by tier: low circle, medium triangle, high diamond"
  >
    <VChart ref="chart" class="size-full" :option="option" autoresize @zr:click="onClick" />
  </div>
</template>
