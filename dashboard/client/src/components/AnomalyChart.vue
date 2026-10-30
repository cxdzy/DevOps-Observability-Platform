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
import { clockTime, fixed, shortDate } from '@/lib/format'
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
    new Date(point.time).toLocaleString(),
    `Score: ${fixed(point.score)}`,
    `Threshold: ${fixed(point.threshold)}`,
    `Tier: ${tier}`,
  ].join('<br>')
}

const option = computed(() => {
  const score = props.points.map(p => [p.time, p.score])
  const threshold = props.points.map(p => [p.time, p.threshold])
  const flagged = FLAG_TIERS.map(tier => ({
    name: TIER_STYLE[tier].label,
    type: 'scatter',
    symbolSize: 8,
    itemStyle: { color: TIER_STYLE[tier].color },
    data: props.points
      .filter(p => p.is_anomaly === 1 && toTier(p.tier) === tier)
      .map(p => [p.time, p.score]),
  }))
  const selectedPoint = props.selected === null ? undefined : byTime.value.get(props.selected)

  return {
    animation: false,
    grid: { left: 48, right: 16, top: narrow.value ? 64 : 40, bottom: 40 },
    legend: {
      top: 0,
      data: ['Score', 'Threshold', ...FLAG_TIERS.map(t => TIER_STYLE[t].label)],
    },
    tooltip: { trigger: 'axis', formatter: tooltip },
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }],
    xAxis: {
      type: 'time',
      axisLabel: { formatter: (v: number) => axisLabel(v), hideOverlap: true },
    },
    yAxis: { type: 'value', scale: true, axisLabel: { formatter: (v: number) => v.toFixed(2) } },
    series: [
      {
        name: 'Score',
        type: 'line',
        data: score,
        showSymbol: false,
        lineStyle: { width: 1.5, color: '#0f172a' },
        itemStyle: { color: '#0f172a' },
      },
      {
        name: 'Threshold',
        type: 'line',
        data: threshold,
        step: 'end',
        showSymbol: false,
        lineStyle: { width: 1, type: 'dashed', color: '#9ca3af' },
        itemStyle: { color: '#9ca3af' },
      },
      ...flagged,
      {
        // Ring around the selected minute; left out of the legend.
        name: 'Selected',
        type: 'scatter',
        symbol: 'emptyCircle',
        symbolSize: 16,
        itemStyle: { color: '#7c3aed', borderWidth: 2 },
        tooltip: { show: false },
        data: selectedPoint ? [[selectedPoint.time, selectedPoint.score]] : [],
      },
    ],
  }
})

// Any click inside the plot selects the nearest minute, so a marker or a point on the line both work.
function onClick(event: { offsetX: number, offsetY: number }) {
  const instance = chart.value
  if (!instance || props.points.length === 0) return
  const pixel = [event.offsetX, event.offsetY]
  if (!instance.containPixel('grid', pixel)) return
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
    aria-label="Anomaly score over time with the detection threshold and flagged minutes coloured by tier"
  >
    <VChart ref="chart" class="size-full" :option="option" autoresize @zr:click="onClick" />
  </div>
</template>
