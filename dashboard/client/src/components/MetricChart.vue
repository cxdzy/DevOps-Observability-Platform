<script setup lang="ts">
import type { AnomalyPoint } from '@/types'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendPlainComponent, TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, onMounted, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { useTheme } from '@/composables/useTheme'
import { clockTime, localDateTime } from '@/lib/format'

use([LineChart, GridComponent, TooltipComponent, LegendPlainComponent, CanvasRenderer])

// sample-service metrics from the scored minutes the Overview already loads (last 6 hours).
const props = defineProps<{ points: AnomalyPoint[] }>()

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

// The same theme handling as AnomalyChart: colours are read from CSS when drawing and again
// when the theme changes, because canvas drawing cannot use CSS variables.
const { theme } = useTheme()

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`
}

function readPalette() {
  return {
    panel: cssVar('--panel', '#FFFFFF'),
    ink: cssVar('--ink', '#18181B'),
    muted: cssVar('--muted-foreground', '#52525B'),
    faint: cssVar('--faint', '#71717A'),
    line: cssVar('--line', '#E4E4E7'),
    chartline: cssVar('--chartline', '#18181B'),
    thresh: cssVar('--thresh', '#A1A1AA'),
    grid: cssVar('--grid', '#E4E4E7'),
  }
}

const palette = ref(readPalette())
watch(theme, () => { palette.value = readPalette() })

const MONO = '"Geist Mono", ui-monospace, monospace'
const fontReady = ref(0)
onMounted(() => {
  document.fonts?.load(`11px ${MONO}`).then(() => { fontReady.value++ }, () => {})
})

// Legend icon drawn as a filled path, the same as the Score entry in AnomalyChart.
const LINE_ICON = 'path://M0 0h24v2H0z'

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
    grid: { left: 48, right: 16, top: 32, bottom: 32 },
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
    xAxis: {
      type: 'time',
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
    <div class="h-[220px] w-full" role="img" :aria-label="`sample-service ${current.label.toLowerCase()} over the last 6 hours`">
      <VChart class="size-full" :option="option" autoresize />
    </div>
  </div>
</template>
