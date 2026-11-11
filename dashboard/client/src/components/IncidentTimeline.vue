<script setup lang="ts">
import type { IncidentTimeline, TimelineStep } from '@/types'
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import ChartLoadError from '@/components/ChartLoadError.vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/composables/useApi'
import { clockTime } from '@/lib/format'
import type { Tier } from '@/lib/tier'
import { TIER_SHAPE, TIER_STYLE, toTier } from '@/lib/tier'

// ECharts stays out of the main chunk: the same async chart the Anomaly view uses, in its short form.
const AnomalyChart = defineAsyncComponent({
  loader: () => import('@/components/AnomalyChart.vue'),
  loadingComponent: Skeleton,
  errorComponent: ChartLoadError,
  delay: 0,
  timeout: 30000,
})

// tier is the incident's tier from the list, only used to word the message when there is no timeline.
const props = defineProps<{ start: number, job: string, tier?: string | null }>()

// The timeline starts from the open-incident record, which the explainer writes only for medium
// and high incidents (OPEN_MIN_TIER), so a low incident never has one.
const missingText = computed(() =>
  props.tier === 'low'
    ? 'No timeline for low-tier incidents. It is built from the open-incident record, which is kept only for medium and high incidents.'
    : 'No timeline for this incident. It is built from the open-incident record, which is kept only for medium and high incidents, and none was found for this start time.')

const timeline = ref<IncidentTimeline | null>(null)
const loading = ref(true)
// 'missing' is a 404: the incident is not in the stored data. 'failed' is any other failure.
const problem = ref<'missing' | 'failed' | null>(null)
// The step and the minute that are selected. They follow each other: a step selects the scored
// minute nearest to it, and a minute selects the nearest step.
const selected = ref<number | null>(null)
const selectedMinute = ref<number | null>(null)

// Each load gets a number and an abort controller. A response that is not the latest is ignored,
// and the previous request is cancelled, so a quick switch between incidents never shows old data.
let sequence = 0
let controller: AbortController | null = null

async function load() {
  controller?.abort()
  const mine = ++sequence
  const current = new AbortController()
  controller = current
  loading.value = true
  problem.value = null
  timeline.value = null
  selected.value = null
  selectedMinute.value = null
  try {
    const { data } = await api.get<IncidentTimeline>('/api/incidents/timeline', {
      params: { start: props.start, job: props.job },
      signal: current.signal,
    })
    if (mine !== sequence) return
    timeline.value = data
  }
  catch (error) {
    if (mine !== sequence) return
    const status = (error as { response?: { status?: number } }).response?.status
    problem.value = status === 404 ? 'missing' : 'failed'
  }
  finally {
    if (mine === sequence) loading.value = false
  }
}

watch(() => [props.start, props.job], load, { immediate: true })
onBeforeUnmount(() => {
  sequence++
  controller?.abort()
})

const steps = computed(() => timeline.value?.steps ?? [])
const points = computed(() => timeline.value?.points ?? [])
// Times of early warnings, for the dashed lines on the chart.
const warnings = computed(() => steps.value.filter(s => s.kind === 'early_warning' && s.time !== null).map(s => s.time as number))
const FULL = { start: 0, end: 100 }

function nearestMinute(time: number): number | null {
  let best: number | null = null
  for (const p of points.value) {
    if (best === null || Math.abs(p.time - time) < Math.abs(best - time)) best = p.time
  }
  return best
}

function pickStep(index: number) {
  const step = steps.value[index]
  selected.value = index
  if (step?.time != null) selectedMinute.value = nearestMinute(step.time)
}

function pickMinute(time: number) {
  selectedMinute.value = time
  let best = -1
  steps.value.forEach((s, i) => {
    if (s.time === null) return
    if (best === -1 || Math.abs(s.time - time) < Math.abs((steps.value[best].time as number) - time)) best = i
  })
  if (best !== -1) selected.value = best
}

// How a step is drawn: its colour, the icon in the node, and whether the node is dashed or hatched.
const CHEVRON = 'M2.5 8 6 4.5 9.5 8'
const DOT = 'M6 6h0'
const CHECK = 'M2.5 6.5 5 9l4.5-6'
const CROSS = 'M3 3l6 6M9 3l-6 6'
const DASH = 'M3 6h6'

// The flagged minute has its own tier; the opened incident has the incident's tier, which can be
// higher than the tier of its first minute.
function tierAt(step: TimelineStep): Tier {
  if (step.kind === 'incident_open') return toTier(timeline.value?.tier)
  const point = points.value.find(p => p.time === step.time)
  return toTier(point?.tier ?? timeline.value?.tier)
}

function look(step: TimelineStep) {
  switch (step.family) {
    case 'warn': return { color: 'var(--warn)', icon: CHEVRON, filled: false, dashed: false, hatch: false }
    case 'flag': {
      const tier = tierAt(step)
      const color = `var(${TIER_STYLE[tier].markerVar})`
      // The flagged minute shows its tier's shape; the opened incident is a dot in the same colour.
      return step.kind === 'first_flag' && tier !== 'none'
        ? { color, icon: TIER_SHAPE[tier], filled: true, dashed: false, hatch: false }
        : { color, icon: DOT, filled: false, dashed: false, hatch: false }
    }
    case 'worked': return { color: 'var(--okdot)', icon: CHECK, filled: false, dashed: false, hatch: false }
    case 'failed': return { color: 'var(--red)', icon: CROSS, filled: false, dashed: false, hatch: false }
    case 'not_run': return { color: 'var(--faint)', icon: DASH, filled: false, dashed: true, hatch: false }
    case 'warmup': return { color: 'var(--faint)', icon: DASH, filled: false, dashed: false, hatch: true }
    default: return { color: 'var(--faint)', icon: DOT, filled: false, dashed: false, hatch: false }
  }
}

const HATCH = 'repeating-linear-gradient(45deg, var(--faint) 0 1.5px, transparent 1.5px 4px)'

function nodeStyle(step: TimelineStep) {
  const l = look(step)
  return {
    border: `1.5px ${l.dashed ? 'dashed' : 'solid'} ${l.color}`,
    backgroundColor: 'var(--panel)',
    backgroundImage: l.hatch ? HATCH : undefined,
    color: l.color,
  }
}

function iconStyle(step: TimelineStep) {
  const l = look(step)
  return { fill: l.filled ? l.color : 'none', stroke: l.color }
}

const hasChart = computed(() => points.value.length > 0)
const rangeText = computed(() => (timeline.value ? `${clockTime(timeline.value.from)} to ${clockTime(timeline.value.to)}` : ''))
</script>

<template>
  <section aria-label="Incident timeline" class="flex flex-col gap-3">
    <div class="flex items-baseline justify-between gap-2">
      <h3 class="text-[13px] font-semibold">What happened, in order</h3>
      <span v-if="timeline && steps.length" class="text-xs text-muted-foreground">Select a step to find it on the chart</span>
    </div>

    <div v-if="loading" class="flex flex-col gap-2" role="status" aria-label="Loading the timeline">
      <Skeleton class="h-[240px] w-full rounded-lg bg-chip" />
      <Skeleton v-for="n in 4" :key="n" class="h-10 w-full rounded-lg bg-chip" />
    </div>

    <div v-else-if="problem === 'failed'" class="flex flex-col items-start gap-2 text-[13px]" role="alert">
      <p class="text-muted-foreground">The timeline could not be loaded. InfluxDB did not answer.</p>
      <Button variant="outline" class="min-h-9 border-border bg-transparent px-3.5 text-[13px] dark:border-border dark:bg-transparent" @click="load">
        Try again
      </Button>
    </div>

    <p v-else-if="problem === 'missing'" class="text-[13px] text-muted-foreground">
      {{ missingText }}
    </p>

    <p v-else-if="timeline && steps.length === 0" class="text-[13px] text-muted-foreground">No steps were recorded for this incident.</p>

    <template v-else-if="timeline">
      <div class="min-w-0">
        <p class="mb-1 text-xs text-muted-foreground">Score around the incident, <span class="font-mono">{{ rangeText }}</span></p>
        <AnomalyChart
          v-if="hasChart"
          compact
          :points="points"
          :hours="1"
          :selected="selectedMinute"
          :zoom="FULL"
          :warnings="warnings"
          @select="pickMinute"
        />
        <p v-else class="rounded-lg bg-chip px-3 py-6 text-center text-[13px] text-muted-foreground">No scored minutes in this window</p>
      </div>

      <ol class="m-0 list-none p-0">
        <li v-for="(step, i) in steps" :key="i" class="grid grid-cols-[44px_22px_minmax(0,1fr)] gap-x-2">
          <span class="pt-[11px] text-right font-mono text-xs text-muted-foreground">{{ step.time === null ? '' : clockTime(step.time) }}</span>
          <span class="relative flex justify-center">
            <span
              v-if="i < steps.length - 1"
              class="absolute top-[30px] -bottom-2 left-1/2 w-0 border-l-[1.5px] border-border"
              :class="steps[i + 1].family === 'not_run' ? 'border-dashed' : 'border-solid'"
              aria-hidden="true"
            />
            <span class="relative z-[1] mt-2 flex size-[22px] items-center justify-center rounded-full" :style="nodeStyle(step)" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path :d="look(step).icon" :style="iconStyle(step)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </span>
          <component
            :is="step.time === null ? 'div' : 'button'"
            :type="step.time === null ? undefined : 'button'"
            :aria-pressed="step.time === null ? undefined : selected === i"
            class="-mx-0.5 mt-0.5 mb-1.5 block w-full rounded-lg px-2.5 py-2 text-left text-[13px]"
            :class="[
              step.time === null ? '' : 'cursor-pointer hover:bg-chip',
              selected === i ? 'bg-navon ring-1 ring-navring hover:bg-navon' : '',
              step.family === 'not_run' ? 'text-muted-foreground' : 'text-foreground',
            ]"
            @click="step.time === null ? undefined : pickStep(i)"
          >
            <span class="flex flex-wrap items-center gap-1.5">
              <span class="font-semibold">{{ step.title }}</span>
              <span class="rounded-[5px] bg-chip px-1.5 font-mono text-[11px] text-chipfg">{{ step.source }}</span>
            </span>
            <span class="mt-0.5 block break-words text-muted-foreground">{{ step.detail }}</span>
          </component>
        </li>
      </ol>
    </template>
  </section>
</template>
