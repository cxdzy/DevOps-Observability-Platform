<script setup lang="ts">
import type { IncidentTimeline, TimelineKind, TimelineStep } from '@/types'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
// size 'large' is for a hall screen (Exhibition mode): 24 px body text, 20 px times and a taller
// chart. Its sizes are multiples of --u when an ancestor sets it (one design pixel there), and plain
// pixels otherwise. readonly draws the steps as plain list items instead of buttons, with no
// selection. Both are off by default, which leaves the timeline exactly as it was.
const props = defineProps<{ start: number, job: string, tier?: string | null, size?: 'normal' | 'large', readonly?: boolean }>()
// A step is a button only when it has a time and the timeline is not read-only.
const isButton = (step: TimelineStep) => step.time !== null && !props.readonly

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
// Read-only (the exhibition screen) has nobody to press Try again, so a failed load retries by
// itself after this delay.
const RETRY_MS = 30_000
let retryTimer: ReturnType<typeof setTimeout> | null = null
function clearRetry() {
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = null
}

async function load() {
  clearRetry()
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
    if (problem.value === 'failed' && props.readonly) retryTimer = setTimeout(load, RETRY_MS)
  }
  finally {
    if (mine === sequence) loading.value = false
  }
}

watch(() => [props.start, props.job], load, { immediate: true })
onBeforeUnmount(() => {
  sequence++
  clearRetry()
  controller?.abort()
})

const steps = computed(() => timeline.value?.steps ?? [])

// ---- Fit for the exhibition card (size large and readonly only) ----
// The exhibition stage is a fixed 1920 x 1080 design, so the room for the steps is a known number
// of design pixels and nothing is measured. The card's content box is about 815 design px tall, or
// FIT_CARD (750) when the one-line error notice above the screens is shown. FIT_FIXED is the
// heading, the score caption, the chart (FIT_CHART) and the gaps above the list. A step is
// budgeted at FIT_ROW px: the title on one line and the detail clamped to two lines, all in the
// large 24 px type. The list uses one column when the steps fit in it, two columns (filled in time
// order, first column first) when they fit in two, and otherwise the short list: the first flagged
// minute, the actions (whose detail carries the result, back up or still down), the close and the
// explanation, then one line that says how many steps were left out.
// Six steps in one column do not fit next to a usable chart at this type: six rows take about
// 610 px, which leaves under 50 px for the chart. So one column holds 4 steps, two columns start
// at 5 and the short list at 9.
const fit = computed(() => props.size === 'large' && !!props.readonly)
const FIT_CARD = 750
const FIT_CHART = 240
const FIT_FIXED = 98 + FIT_CHART
const FIT_ROW = 102
const FIT_ROWS_PER_COLUMN = Math.floor((FIT_CARD - FIT_FIXED) / FIT_ROW)
const SHORT_KINDS: TimelineKind[] = ['first_flag', 'action', 'incident_closed', 'explanation']
const layout = computed(() => {
  const all = steps.value
  const capacity = FIT_ROWS_PER_COLUMN * 2
  if (!fit.value || all.length <= capacity) {
    return { shown: all, hidden: 0, columns: fit.value && all.length > FIT_ROWS_PER_COLUMN ? 2 : 1 }
  }
  let shown = all.filter(s => SHORT_KINDS.includes(s.kind))
  // Only the first flagged minute is kept of that kind.
  const firstFlag = shown.findIndex(s => s.kind === 'first_flag')
  shown = shown.filter((s, i) => s.kind !== 'first_flag' || i === firstFlag)
  // One slot is taken by the closing line. When there are too many actions the oldest go first:
  // first those that did not run, then those that ran. The last action, which carries the final
  // result, is always kept.
  const room = capacity - 1
  while (shown.length > room) {
    const actions = shown.filter(s => s.kind === 'action')
    const last = actions[actions.length - 1]
    const drop = actions.find(s => s !== last && s.family === 'not_run') ?? actions.find(s => s !== last)
    shown.splice(drop ? shown.indexOf(drop) : shown.length - 1, 1)
  }
  return { shown, hidden: all.length - shown.length, columns: 2 }
})
// The server ends an action's detail with its result, "Back up 60 s later." or "Still down 60 s
// later." (actionStep in dashboard/server/timeline.js). With the detail clamped to two lines that
// sentence would be cut off, so the fitted card puts it first.
const RESULT_AT_END = /^(.*?)\s*((?:Back up|Still down) [^.]*\.)$/
function detailText(step: TimelineStep): string {
  if (!fit.value || step.kind !== 'action') return step.detail
  const match = step.detail.match(RESULT_AT_END)
  return match && match[1] ? `${match[2]} ${match[1]}` : step.detail
}
const shownSteps = computed(() => layout.value.shown)
const hiddenCount = computed(() => layout.value.hidden)
// Rows per column when there are two columns, so the grid fills the first column top to bottom.
const gridRows = computed(() => Math.ceil((shownSteps.value.length + (hiddenCount.value > 0 ? 1 : 0)) / 2))
// A step draws a line to the next one, except at the end of a column and at the end of the list.
function hasLine(i: number): boolean {
  const last = shownSteps.value.length - 1
  if (i >= last) return false
  if (layout.value.columns === 2 && (i + 1) % gridRows.value === 0) return false
  return true
}

// ---- Spare height (exhibition card only) ----
// The budget above decides which steps are shown at the smallest chart. After the steps are laid
// out, the height left below them is measured and given to the chart, which grows up to half the
// card. If at least FIT_THREE_LINES px is still left after that, each detail may use three lines
// instead of two; should that overflow, the chart gives the height back, or the details go back to
// two lines. Sizes are read in layout pixels, so the scale of the exhibition stage does not matter.
const FIT_THREE_LINES = 120
const rootEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const chartHeight = ref(FIT_CHART)
const detailLines = ref(2)
// Distance from the bottom of the step list to the bottom of the card, in layout pixels. Negative
// when the list runs past the card.
function spareBelowList(): number | null {
  const root = rootEl.value
  const list = listEl.value
  if (!root || !list || root.offsetHeight === 0) return null
  const rootBox = root.getBoundingClientRect()
  const scale = rootBox.height / root.offsetHeight || 1
  return (rootBox.bottom - list.getBoundingClientRect().bottom) / scale
}
let fitRun = 0
async function fitSpare() {
  if (!fit.value) return
  const mine = ++fitRun
  chartHeight.value = FIT_CHART
  detailLines.value = 2
  await nextTick()
  const spare = spareBelowList()
  const root = rootEl.value
  if (mine !== fitRun || spare === null || !root) return
  const half = Math.floor(root.offsetHeight / 2)
  const grow = Math.max(0, Math.min(Math.floor(spare), half - FIT_CHART))
  chartHeight.value = FIT_CHART + grow
  if (spare - grow < FIT_THREE_LINES) return
  detailLines.value = 3
  await nextTick()
  const after = spareBelowList()
  if (mine !== fitRun || after === null || after >= 0) return
  const shrunk = chartHeight.value + Math.floor(after)
  if (shrunk >= FIT_CHART) chartHeight.value = shrunk
  else {
    detailLines.value = 2
    chartHeight.value = FIT_CHART + grow
  }
}
// The card height changes only when the notice above the screens appears or goes, and the steps
// change only when new data arrives, so this runs rarely. The chart resizes itself.
let observer: ResizeObserver | null = null
let observedHeight = 0
onMounted(() => {
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => {
    const h = rootEl.value?.offsetHeight ?? 0
    if (h !== observedHeight) {
      observedHeight = h
      void fitSpare()
    }
  })
  if (rootEl.value) observer.observe(rootEl.value)
})
onBeforeUnmount(() => observer?.disconnect())
watch([shownSteps, () => timeline.value], () => { void fitSpare() }, { flush: 'post' })

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
  if (props.readonly) return
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

// The accessible name of a step button: its time, title and detail, for example "23:26, Approved,
// the service was restarted (approved on Telegram). Back up 60 s later." Steps without a time are
// not buttons and read "After the incident" before their title instead.
function stepName(step: TimelineStep): string {
  const detail = step.detail ? `, ${step.detail.charAt(0).toLowerCase()}${step.detail.slice(1)}` : ''
  return `${step.time === null ? 'After the incident' : clockTime(step.time)}, ${step.title}${detail}`
}

const hasChart = computed(() => points.value.length > 0)
const rangeText = computed(() => (timeline.value ? `${clockTime(timeline.value.from)} to ${clockTime(timeline.value.to)}` : ''))
</script>

<template>
  <section ref="rootEl" aria-label="Incident timeline" class="flex flex-col gap-3" :class="[size === 'large' ? 'tl-large' : '', fit ? 'tl-fit min-h-0 flex-1' : '']" :style="fit ? { '--tl-lines': String(detailLines) } : undefined">
    <div class="flex items-baseline justify-between gap-2">
      <h3 class="tl-body text-[13px] font-semibold">What happened, in order</h3>
      <span v-if="timeline && steps.length && !readonly" class="tl-small text-xs text-muted-foreground">Select a step to find it on the chart</span>
    </div>

    <div v-if="loading" class="flex flex-col gap-2" role="status" aria-label="Loading the timeline">
      <Skeleton class="h-[240px] w-full rounded-lg bg-chip" />
      <Skeleton v-for="n in 4" :key="n" class="h-10 w-full rounded-lg bg-chip" />
    </div>

    <div v-else-if="problem === 'failed'" class="tl-body flex flex-col items-start gap-2 text-[13px]" role="alert">
      <p v-if="readonly" class="text-muted-foreground">Could not be loaded, retrying in 30 s</p>
      <p v-else class="text-muted-foreground">The timeline could not be loaded. InfluxDB did not answer.</p>
      <Button v-if="!readonly" variant="outline" class="min-h-9 border-border bg-transparent px-3.5 text-[13px] dark:border-border dark:bg-transparent" @click="load">
        Try again
      </Button>
    </div>

    <p v-else-if="problem === 'missing'" class="tl-body text-[13px] text-muted-foreground">
      {{ missingText }}
    </p>

    <p v-else-if="timeline && steps.length === 0" class="tl-body text-[13px] text-muted-foreground">No steps were recorded for this incident.</p>

    <template v-else-if="timeline">
      <div class="min-w-0">
        <p class="tl-small mb-1 text-xs text-muted-foreground">Score around the incident, <span class="font-mono">{{ rangeText }}</span></p>
        <!-- The large chart fills this box, which sets its height; the normal chart sets its own. -->
        <div v-if="hasChart" class="tl-chart" :class="fit ? 'pointer-events-none' : ''" :style="fit ? { height: `calc(${chartHeight} * var(--tu))` } : undefined">
          <AnomalyChart
            compact
            :size="size"
            :points="points"
            :hours="1"
            :selected="selectedMinute"
            :zoom="FULL"
            :warnings="warnings"
            @select="pickMinute"
          />
        </div>
        <p v-else class="tl-body rounded-lg bg-chip px-3 py-6 text-center text-[13px] text-muted-foreground">No scored minutes in this window</p>
      </div>

      <ol
        ref="listEl"
        class="m-0 list-none p-0"
        :class="fit && layout.columns === 2 ? 'tl-cols' : ''"
        :style="fit && layout.columns === 2 ? { gridTemplateRows: `repeat(${gridRows}, auto)` } : undefined"
      >
        <li v-for="(step, i) in shownSteps" :key="i" class="tl-row grid grid-cols-[44px_22px_minmax(0,1fr)] gap-x-2">
          <!-- The time is part of each step's accessible name below, so this column is hidden from it. -->
          <span class="tl-time pt-[11px] text-right font-mono text-xs text-muted-foreground" aria-hidden="true">{{ step.time === null ? '' : clockTime(step.time) }}</span>
          <span class="relative flex justify-center">
            <span
              v-if="hasLine(i)"
              class="tl-line absolute top-[30px] -bottom-2 left-1/2 w-0 border-l-[1.5px] border-border"
              :class="shownSteps[i + 1].family === 'not_run' ? 'border-dashed' : 'border-solid'"
              aria-hidden="true"
            />
            <span class="tl-node relative z-[1] mt-2 flex size-[22px] items-center justify-center rounded-full" :style="nodeStyle(step)" aria-hidden="true">
              <svg class="tl-icon" width="12" height="12" viewBox="0 0 12 12">
                <path :d="look(step).icon" :style="iconStyle(step)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </span>
          <component
            :is="isButton(step) ? 'button' : 'div'"
            :type="isButton(step) ? 'button' : undefined"
            :aria-pressed="isButton(step) ? selected === i : undefined"
            :aria-label="isButton(step) ? stepName(step) : undefined"
            class="tl-body tl-step -mx-0.5 mt-0.5 mb-1.5 block w-full rounded-lg px-2.5 py-2 text-left text-[13px]"
            :class="[
              isButton(step) ? 'cursor-pointer hover:bg-chip' : '',
              selected === i ? 'bg-navon ring-1 ring-navring hover:bg-navon' : '',
              step.family === 'not_run' ? 'text-muted-foreground' : 'text-foreground',
            ]"
            @click="isButton(step) ? pickStep(i) : undefined"
          >
            <span class="tl-head flex flex-wrap items-center gap-1.5">
              <span v-if="step.time === null" class="sr-only">After the incident,</span>
              <!-- A read-only step is not a button, so its time is read out here instead. -->
              <span v-else-if="readonly" class="sr-only">{{ clockTime(step.time) }},</span>
              <span class="tl-title font-semibold" :title="fit ? step.title : undefined">{{ step.title }}</span>
              <span v-if="!fit" class="tl-source rounded-[5px] bg-chip px-1.5 font-mono text-[11px] text-chipfg">{{ step.source }}</span>
            </span>
            <span class="tl-detail mt-0.5 block break-words text-muted-foreground">{{ detailText(step) }}</span>
          </component>
        </li>
        <li v-if="hiddenCount > 0" class="tl-body tl-more text-muted-foreground">and {{ hiddenCount }} more {{ hiddenCount === 1 ? 'step' : 'steps' }} on the Incidents page</li>
      </ol>
    </template>
  </section>
</template>

<style scoped>
/* The large size. One unit is --u when an ancestor sets it (Exhibition mode), else 1 px. These
   rules apply only under .tl-large, so the normal timeline is unchanged. */
.tl-large { --tu: var(--u, 1px); gap: calc(16 * var(--tu)); }
.tl-large .tl-body { font-size: calc(24 * var(--tu)); line-height: 1.35; }
.tl-large .tl-small { font-size: calc(20 * var(--tu)); }
.tl-large .tl-source { font-size: calc(18 * var(--tu)); }
.tl-large .tl-chart { height: calc(380 * var(--tu)); }
.tl-large .tl-row { grid-template-columns: calc(76 * var(--tu)) calc(36 * var(--tu)) minmax(0, 1fr); column-gap: calc(14 * var(--tu)); }
.tl-large .tl-time { font-size: calc(20 * var(--tu)); padding-top: calc(16 * var(--tu)); }
.tl-large .tl-node { width: calc(36 * var(--tu)); height: calc(36 * var(--tu)); margin-top: calc(10 * var(--tu)); }
.tl-large .tl-icon { width: calc(20 * var(--tu)); height: calc(20 * var(--tu)); }
.tl-large .tl-line { top: calc(46 * var(--tu)); }

/* The exhibition card (large and readonly): no scrolling, a chart that starts at 240 px and takes
   the spare height (fitSpare in the script), tighter steps with the title on one line and the
   detail clamped to two lines (three when there is room), and past four steps two columns. The
   type stays at the large sizes above (24 px body, 20 px times, 36 px nodes). These rules come
   after the large ones so they win, and the sizes match FIT_* in the script. */
.tl-fit { overflow: hidden; }
.tl-fit .tl-chart { height: calc(240 * var(--tu)); overflow: hidden; }
.tl-fit .tl-cols { display: grid; grid-auto-flow: column; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: calc(24 * var(--tu)); }
.tl-fit .tl-row { grid-template-columns: calc(64 * var(--tu)) calc(36 * var(--tu)) minmax(0, 1fr); column-gap: calc(10 * var(--tu)); }
.tl-fit .tl-time { padding-top: calc(5 * var(--tu)); }
.tl-fit .tl-node { margin-top: calc(1 * var(--tu)); }
.tl-fit .tl-line { top: calc(37 * var(--tu)); bottom: calc(-2 * var(--tu)); }
.tl-fit .tl-step { margin: 0; padding: calc(2 * var(--tu)) calc(10 * var(--tu)); }
.tl-fit .tl-head { flex-wrap: nowrap; }
.tl-fit .tl-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-fit .tl-detail { margin-top: 0; display: -webkit-box; -webkit-line-clamp: var(--tl-lines, 2); line-clamp: var(--tl-lines, 2); -webkit-box-orient: vertical; overflow: hidden; }
.tl-fit .tl-more { padding: calc(4 * var(--tu)) calc(10 * var(--tu)); }
</style>
