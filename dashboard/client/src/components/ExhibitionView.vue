<script setup lang="ts">
// Exhibition mode: a full-screen view for a bright hall screen. It has no sidebar and no top bar,
// shows three screens in turn (Live, Last incident, Results) and is dark whatever the saved theme.
// It is one fixed 1920 x 1080 stage that is scaled as a whole to fit the window, so every window
// size shows exactly the 1920 x 1080 layout, smaller or larger, with a dark border around it.
// Inside the stage all sizes are plain design pixels and nothing scrolls.
import type { AnomalyPoint, Evaluation, Incident, StatusInfo } from '@/types'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ChartLoadError from '@/components/ChartLoadError.vue'
import ChartSkeleton from '@/components/ChartSkeleton.vue'
import IncidentTimeline from '@/components/IncidentTimeline.vue'
import StatusChip from '@/components/StatusChip.vue'
import { api, usePoll } from '@/composables/useApi'
import { useTheme } from '@/composables/useTheme'
import { clockTime, fixed, shortDate } from '@/lib/format'
import { explanationFallback } from '@/lib/incident'
import { TIER_SHAPE, TIER_STYLE, toTier } from '@/lib/tier'

// ECharts stays out of the main chunk: the score chart is downloaded when this view first shows it.
const AnomalyChart = defineAsyncComponent({
  loader: () => import('@/components/AnomalyChart.vue'),
  loadingComponent: ChartSkeleton,
  errorComponent: ChartLoadError,
  delay: 0,
  timeout: 30000,
})

// ---- Dark by default, without touching the saved theme ----
// The dark class goes on <html> here in setup, before any child is created, because the chart reads
// its colours from CSS when it is set up. The saved theme (localStorage "theme") is never written.
// When the view goes away the app theme is put back, before the next view is drawn. The app theme
// is read when leaving, not when entering, because it follows the browser setting until the user
// picks one and that setting can change while this view is open.
const root = document.documentElement
const { theme: appTheme } = useTheme()
function forceDark() {
  root.classList.add('dark')
  root.style.colorScheme = 'dark'
}
forceDark()
// useTheme puts the light class back when the browser setting changes to light. This runs at once
// (flush sync), before the chart reads its colours for the theme change, so the chart stays dark.
const stopThemeWatch = watch(appTheme, forceDark, { flush: 'sync' })
onBeforeUnmount(() => {
  stopThemeWatch()
  root.classList.toggle('dark', appTheme.value === 'dark')
  root.style.colorScheme = appTheme.value
})

// ---- Scale ----
// The stage is DESIGN_W x DESIGN_H and is scaled by the smaller of the width and height ratio. The
// stage sets --u to 1 px, so the rules below and the timeline's large size (which reads --u) work
// in design pixels.
const DESIGN_W = 1920
const DESIGN_H = 1080
const fitScale = () => Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H)
const scale = ref(fitScale())
function onResize() {
  scale.value = fitScale()
}
// The status chip's own text is 13 px, so it is zoomed to 24 px on the stage.
const CHIP_ZOOM = String(24 / 13)

// ---- Screens, rotation and controls ----
const SCREENS = [
  { id: 'live', label: 'Live' },
  { id: 'incident', label: 'Last incident' },
  { id: 'results', label: 'Results' },
] as const
const ROTATE_SECONDS = 20
const screen = ref(0)
const left = ref(ROTATE_SECONDS)
const paused = ref(false)
const now = ref(Date.now())
const host = window.location.host

function go(index: number) {
  screen.value = (index + SCREENS.length) % SCREENS.length
  left.value = ROTATE_SECONDS
}

let ticker: number | undefined
function tick() {
  now.value = Date.now()
  // The countdown also waits while the tab is hidden, so the screen does not change unseen.
  if (paused.value || document.hidden) return
  left.value -= 1
  if (left.value <= 0) go(screen.value + 1)
}

// Keys are ignored while focus is in a form control, and with a modifier held. Space is also left
// alone on a button or link, where it means "press this".
function onKey(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target instanceof HTMLElement ? event.target : null
  if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
  if (event.key === ' ' || event.code === 'Space') {
    if (target && ['BUTTON', 'A'].includes(target.tagName)) return
    event.preventDefault()
    // Resuming carries on from the seconds that were left; only a screen change starts a new count.
    paused.value = !paused.value
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    go(screen.value + 1)
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    go(screen.value - 1)
  } else if (event.key === 'Escape') {
    window.location.hash = '#overview'
  }
}

onMounted(() => {
  ticker = window.setInterval(tick, 1000)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.clearInterval(ticker)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
})

// ---- Data, refreshed every 30 s ----
// Each source fails on its own and keeps its last good answer. Anything missing shows "No data".
const status = ref<StatusInfo | null>(null)
const statusFailed = ref(false)
const points = ref<AnomalyPoint[]>([])
const incidents = ref<Incident[]>([])
const evaluation = ref<Evaluation | null>(null)
// The header and footer are always drawn; only the middle changes. Until the first load ends the
// screens say "Loading". A source whose latest request failed is named in a line above the screen,
// with the fact that it is tried again in 30 s, and keeps showing its last good answer if it has one.
const loadedOnce = ref(false)
const anomalyFailed = ref(false)
const incidentsFailed = ref(false)
const evaluationFailed = ref(false)

const SCORE_WINDOW_HOURS = 2
const INCIDENT_LOOKBACK_HOURS = 168

async function load() {
  // The server accepts any whole number of hours from 1 to 168, so 2 hours is asked for directly.
  // The trim below keeps the chart on the 2 hours up to the newest point if the answer is wider.
  // It counts from the newest point and not from this browser's clock, so a clock that is ahead
  // cannot empty the chart.
  const [s, a, i, e] = await Promise.allSettled([
    api.get<StatusInfo>('/api/status'),
    api.get<AnomalyPoint[]>('/api/anomaly', { params: { hours: SCORE_WINDOW_HOURS } }),
    api.get<Incident[]>('/api/incidents', { params: { hours: INCIDENT_LOOKBACK_HOURS } }),
    api.get<Evaluation>('/api/evaluation'),
  ])
  statusFailed.value = s.status === 'rejected'
  if (s.status === 'fulfilled') status.value = s.value.data
  anomalyFailed.value = !(a.status === 'fulfilled' && Array.isArray(a.value.data))
  incidentsFailed.value = !(i.status === 'fulfilled' && Array.isArray(i.value.data))
  // A 404 is an answer (no report saved yet), not a failure.
  evaluationFailed.value = e.status === 'rejected' && (e.reason as { response?: { status?: number } })?.response?.status !== 404
  if (a.status === 'fulfilled' && Array.isArray(a.value.data)) {
    const data = a.value.data
    const from = data.length ? data[data.length - 1].time - SCORE_WINDOW_HOURS * 3600000 : 0
    points.value = data.filter(p => p.time >= from)
  }
  if (i.status === 'fulfilled' && Array.isArray(i.value.data)) incidents.value = i.value.data
  // A 404 means no report is saved yet; either way there is nothing to show.
  if (e.status === 'fulfilled') evaluation.value = e.value.data
  else if ((e.reason as { response?: { status?: number } })?.response?.status === 404) evaluation.value = null
  loadedOnce.value = true
}
usePoll(load, 30000)

// ---- Clock ----
const clock = computed(() => new Date(now.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }))

// Local time with the zone abbreviation. Copied from EvaluationView.vue (zoneName), which keeps its
// helpers inside its script setup.
function zoneName(ms: number = Date.now()): string {
  try {
    return new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}
const zone = zoneName()
const zoneSuffix = zone ? ` (${zone})` : ''
const localStamp = (ms: number) => `${shortDate(ms)} ${clockTime(ms)}`

const NO_DATA = 'No data'
// What an empty place shows: "Loading" until the first load has ended, then "No data".
const empty = computed(() => (loadedOnce.value ? NO_DATA : 'Loading'))

// What failed, in words, for the line above the screen.
const RETRY = 'Retrying in 30 s.'
const failureText = computed(() => {
  const names: string[] = []
  if (statusFailed.value) names.push('status')
  if (anomalyFailed.value) names.push('anomaly scores')
  if (incidentsFailed.value) names.push('incidents')
  if (evaluationFailed.value) names.push('evaluation report')
  if (names.length === 0) return ''
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `The ${list} could not be loaded. ${RETRY}`
})

// ---- Live screen ----
const latest = computed(() => {
  for (let k = points.value.length - 1; k >= 0; k--) {
    if (points.value[k].score !== null) return points.value[k]
  }
  return null
})
const latestSub = computed(() => {
  const p = latest.value
  if (!p) return ''
  const parts: string[] = []
  if (p.threshold !== null) parts.push(`threshold ${fixed(p.threshold)}`)
  const tier = toTier(p.tier)
  if (tier !== 'none') parts.push(`${tier} tier`)
  // A minute older than the status page's 5 minute limit is labelled with its time.
  if (now.value - p.time > 5 * 60000) parts.push(`last scored at ${clockTime(p.time)}`)
  return parts.join(', ')
})

// The first minute of each run of early-warning minutes, drawn as dashed lines on the chart.
// Derived from the same points, so no extra request is needed.
const warnings = computed(() => {
  const out: number[] = []
  let previous: number | null = null
  for (const p of points.value) {
    if (p.early_warning === 1) {
      if (previous === null || p.time - previous > 60000 * 1.5) out.push(p.time)
      previous = p.time
    } else {
      previous = null
    }
  }
  return out
})
const FULL = { start: 0, end: 100 }

// Copied from StatusChip.vue (signalName), which does not export it.
const SIGNALS: [string, string][] = [['mem', 'Memory'], ['cpu', 'CPU'], ['lat', 'Latency']]
function signalName(signal: string | null | undefined): string {
  if (!signal) return 'A metric'
  const lower = signal.toLowerCase()
  for (const [key, name] of SIGNALS) {
    if (lower.includes(key)) return name
  }
  const words = lower.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// The loop the system runs. The current step comes from the status: normal is Detect, watching is
// Warn early, an open incident is Explain, recovering is Fix and check. Ask is never the current
// step, because the time the question was asked is not stored yet; when it is, the step can follow
// the stored time. With no status, or a stale one, no step is highlighted. Steps are not marked
// done, since the status does not say which earlier steps happened. A detail line comes from the
// status when it has something true to say, and is otherwise a plain description of the step.
const currentStep = computed(() => {
  const s = status.value
  if (statusFailed.value || !s) return -1
  if (s.state === 'normal') return 0
  if (s.state === 'watching') return 1
  if (s.state === 'incident') return 2
  if (s.state === 'recovering') return 4
  return -1
})
const steps = computed(() => {
  const s = status.value
  const live = !statusFailed.value && s !== null
  let warn = 'Flags a signal that is rising steadily, before any minute is flagged'
  if (live && s.state === 'watching') {
    const eta = s.minutes === null ? ' towards its warning level' : `, about ${Math.round(s.minutes)} min to its warning level`
    warn = `${signalName(s.signal)} is rising${eta}`
  }
  let explain = 'The local LLM writes what happened and why'
  if (live && s.state === 'incident') {
    const tier = toTier(s.tier)
    explain = `Incident open since ${clockTime(s.start)}${tier === 'none' ? '' : `, ${tier} tier`}`
  }
  let fix = 'Restart, then confirm the service is back'
  if (live && s.state === 'recovering') {
    fix = s.step !== undefined && s.of !== undefined ? `The service restarted, warm-up minute ${s.step} of ${s.of}` : 'The service restarted and is warming up'
  }
  return [
    { title: 'Detect', detail: 'Scores every minute with the Isolation Forest' },
    { title: 'Warn early', detail: warn },
    { title: 'Explain', detail: explain },
    { title: 'Ask', detail: 'A person approves the fix on Telegram' },
    { title: 'Fix and check', detail: fix },
  ]
})

// ---- Last incident screen ----
// The newest medium or high incident. Low incidents have no timeline and are not shown here.
const lastIncident = computed<Incident | null>(() => {
  let best: Incident | null = null
  for (const i of incidents.value) {
    const tier = toTier(i.tier)
    if ((tier === 'medium' || tier === 'high') && (best === null || i.start > best.start)) best = i
  }
  return best
})
const incidentTier = computed(() => toTier(lastIncident.value?.tier))

// The explainer writes three labelled lines. When all three are there each gets its own heading.
// Copied from IncidentDetail.vue (sections), which keeps it inside its script setup.
const sections = computed(() => {
  const text = lastIncident.value?.explanation
  if (!text) return null
  const find = (label: string) => {
    const match = text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, 'im'))
    return match ? match[1].trim() : null
  }
  const what = find('What happened')
  const cause = find('Likely cause')
  const next = find('Next step')
  return what && cause && next ? [['What happened', what], ['Likely cause', cause], ['Next step', next]] as const : null
})
const incidentFacts = computed(() => {
  const i = lastIncident.value
  if (!i) return ''
  const parts = [`${localStamp(i.start)}${zoneSuffix}`, `${i.minutes} min`]
  if (i.signal) parts.push(i.signal)
  if (i.peakScore !== null) parts.push(`peak score ${fixed(i.peakScore, 2)}`)
  return parts.join(', ')
})

// ---- Results screen ----
// Formulas copied from EvaluationView.vue (measured, cards): false positive rate is false_alarms
// over flagged_minutes, recall is the stored detection rate, lead time is the stored median.
interface Stat {
  label: string
  value: string
  sub: string
  // Words rather than a number, so they are set smaller.
  words: boolean
}
const percent = (rate: number, digits: number) => `${(rate * 100).toFixed(digits)}%`
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

// Only a figure that was measured gets a tile. A figure with no value is left out and the tiles
// that remain are laid out again, so nothing says "No data" or "not measured".
const stats = computed<Stat[]>(() => {
  const d = evaluation.value
  const r = d?.run
  if (!d || !r) return []
  const out: Stat[] = []

  if (r.detection_rate !== null && (r.injections ?? 0) > 0) {
    out.push({ label: 'Recall, faults detected', value: percent(r.detection_rate, 1), sub: r.detected === null ? `${r.injections} injections` : `${r.detected} of ${r.injections} injections detected`, words: false })
  }

  if (r.false_alarms !== null && r.flagged_minutes !== null && r.flagged_minutes > 0) {
    out.push({ label: 'False positive rate', value: percent(r.false_alarms / r.flagged_minutes, 1), sub: `${r.false_alarms} of ${r.flagged_minutes} flagged minutes`, words: false })
  }

  if (r.margin !== null) {
    out.push({ label: 'Safety margin', value: fixed(r.margin, 3), sub: r.threshold === null ? 'below the threshold' : `below the threshold ${fixed(r.threshold)}`, words: false })
  }

  if (r.ramp_injections !== null && r.ramp_injections > 0) {
    if (r.lead_median_min !== null) {
      out.push({ label: 'Warned ahead', value: `${r.lead_median_min.toFixed(1)} min`, sub: r.warned_before_flag === null ? `median, ${r.ramp_injections} ramp ${plural(r.ramp_injections, 'injection', 'injections')}` : `median, ${r.warned_before_flag} of ${r.ramp_injections} ramp ${plural(r.ramp_injections, 'injection', 'injections')}`, words: false })
    } else {
      out.push({ label: 'Warned ahead', value: 'None', sub: `0 of ${r.ramp_injections} ramp ${plural(r.ramp_injections, 'injection', 'injections')} warned first`, words: true })
    }
  }

  const m = d.mttr
  if (m && m.median_seconds !== null) {
    out.push({ label: 'Time to recover', value: `${m.median_seconds} s`, sub: `median, ${m.count} ${plural(m.count, 'incident', 'incidents')}`, words: false })
  }

  const rem = d.remediation
  if (rem && rem.ran > 0) {
    out.push({ label: 'Remediation success', value: percent(rem.worked / rem.ran, 0), sub: `${rem.worked} of ${rem.ran} ${plural(rem.ran, 'action', 'actions')} that ran`, words: false })
  }

  return out
})
// Tiles per row: 1 to 3 in one row, 4 as 2 by 2, 5 and 6 over two rows of up to 3.
const statColumns = computed(() => (stats.value.length === 4 ? 2 : Math.min(3, Math.max(1, stats.value.length))))
// The one line shown instead of tiles.
const resultsLine = computed(() => {
  if (!loadedOnce.value) return 'Loading'
  if (evaluationFailed.value && !evaluation.value) return `The evaluation report could not be loaded. ${RETRY}`
  if (!evaluation.value?.run) return 'No saved evaluation run yet.'
  return 'No figure was measured in this run.'
})

const period = computed(() => {
  const r = evaluation.value?.run
  const a = r?.since ? Date.parse(r.since) : Number.NaN
  const b = r?.until ? Date.parse(r.until) : Number.NaN
  if (!Number.isFinite(a) || !Number.isFinite(b)) return ''
  return `${localStamp(a)} to ${localStamp(b)}${zoneSuffix}`
})
const runModel = computed(() => evaluation.value?.run.model ?? null)
</script>

<template>
  <div class="ex-outer fixed inset-0 z-50 overflow-hidden bg-background text-foreground">
  <div class="ex absolute flex flex-col overflow-hidden bg-background text-foreground" :style="{ transform: `translate(-50%, -50%) scale(${scale})` }">
    <header class="ex-header flex shrink-0 items-center">
      <span class="ex-logo flex shrink-0 items-center justify-center bg-primary text-primary-foreground" aria-hidden="true">
        <svg class="size-1/2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
      </span>
      <div class="min-w-0">
        <h1 class="ex-t-title m-0 font-semibold tracking-tight">Intelligent DevOps Observability Platform</h1>
        <p class="ex-t-body m-0 text-muted-foreground">Predicts failures, explains them in plain English, fixes them after approval</p>
      </div>
      <div class="ml-auto flex items-center ex-header-right">
        <div :style="{ zoom: CHIP_ZOOM }">
          <StatusChip :status="status" :failed="statusFailed" />
        </div>
        <time class="ex-t-clock font-mono font-medium" :datetime="new Date(now).toISOString()">{{ clock }}</time>
      </div>
    </header>

    <main class="ex-main flex min-h-0 flex-1 flex-col" :aria-label="SCREENS[screen].label">
      <!-- What could not be loaded, whichever screen is showing. -->
      <p v-if="failureText" class="ex-alert ex-t-body m-0 shrink-0 bg-tier-high-bg text-tier-high-fg" role="alert">{{ failureText }}</p>

      <!-- Live -->
      <div v-if="screen === 0" class="ex-live grid min-h-0 flex-1">
        <section aria-label="Live score" class="ex-card flex min-h-0 min-w-0 flex-col">
          <div class="flex items-baseline justify-between">
            <h2 class="ex-t-title m-0 font-semibold">Anomaly score, last 2 hours</h2>
          </div>
          <div class="flex flex-wrap items-baseline ex-score-row">
            <!-- With no scored minute the place says so in body type, never in hero type. -->
            <template v-if="latest">
              <span class="ex-t-hero font-mono font-medium leading-none tracking-tight">{{ fixed(latest.score, 3) }}</span>
              <span class="ex-t-body text-muted-foreground">{{ latestSub }}</span>
            </template>
            <span v-else class="ex-t-body text-muted-foreground">{{ empty }}</span>
          </div>
          <!-- The chart takes all the height left in the card; the large chart fills this box. -->
          <div class="relative min-h-0 min-w-0 flex-1">
            <div v-if="points.length" class="pointer-events-none absolute inset-0 overflow-hidden">
              <AnomalyChart compact size="large" :points="points" :hours="SCORE_WINDOW_HOURS" :selected="null" :zoom="FULL" :warnings="warnings" />
            </div>
            <p v-else class="ex-t-body m-0 rounded-lg bg-chip text-center text-muted-foreground ex-nodata">{{ loadedOnce && anomalyFailed ? `The anomaly scores could not be loaded. ${RETRY}` : empty }}</p>
          </div>
        </section>

        <section aria-label="The loop" class="ex-card flex min-h-0 min-w-0 flex-col">
          <h2 class="ex-t-title m-0 font-semibold">What the system is doing</h2>
          <ol class="m-0 flex list-none flex-col p-0 ex-steps">
            <li
              v-for="(step, i) in steps"
              :key="step.title"
              class="ex-step flex items-center"
              :class="currentStep === i ? 'bg-warnbg ring-2 ring-warnring' : ''"
              :aria-current="currentStep === i ? 'step' : undefined"
            >
              <span
                class="ex-num flex shrink-0 items-center justify-center rounded-full font-mono font-medium"
                :class="currentStep === i ? 'bg-card text-warn ring-2 ring-warnring' : 'border-2 border-input text-muted-foreground'"
                aria-hidden="true"
              >{{ i + 1 }}</span>
              <span class="flex min-w-0 flex-col">
                <span class="ex-t-step font-semibold">{{ step.title }}<span v-if="currentStep === i" class="sr-only"> (current step)</span></span>
                <span class="ex-t-body text-muted-foreground">{{ step.detail }}</span>
              </span>
            </li>
          </ol>
        </section>
      </div>

      <!-- Last incident -->
      <div v-else-if="screen === 1" class="ex-incident grid min-h-0 flex-1">
        <section aria-label="Last incident" class="ex-card flex min-h-0 min-w-0 flex-col overflow-hidden">
          <h2 class="ex-t-title m-0 font-semibold">Last incident, medium or high</h2>
          <template v-if="lastIncident">
            <div class="flex flex-wrap items-center ex-incident-head">
              <span class="ex-t-body ex-tier inline-flex items-center font-semibold" :class="TIER_STYLE[incidentTier].badgeClass">
                <svg class="ex-tier-icon" viewBox="0 0 12 12" aria-hidden="true"><path :d="TIER_SHAPE[incidentTier]" fill="currentColor" /></svg>
                {{ TIER_STYLE[incidentTier].label }}
              </span>
              <span class="ex-t-body text-muted-foreground">{{ incidentFacts }}</span>
            </div>
            <div v-if="sections" class="flex flex-col ex-sections">
              <div v-for="[title, text] in sections" :key="title">
                <h3 class="ex-t-body m-0 font-semibold text-muted-foreground">{{ title }}</h3>
                <p class="ex-t-explain ex-clamp-section m-0">{{ text }}</p>
              </div>
            </div>
            <p v-else class="ex-t-explain ex-clamp-whole m-0 whitespace-pre-line">{{ lastIncident.explanation || explanationFallback(lastIncident) }}</p>
          </template>
          <p v-else class="ex-t-body m-0 text-muted-foreground">{{ !loadedOnce ? 'Loading' : incidentsFailed ? `The incidents could not be loaded. ${RETRY}` : `${NO_DATA}. No medium or high incident in the last 7 days.` }}</p>
        </section>

        <section aria-label="Incident timeline" class="ex-card flex min-h-0 min-w-0 flex-col overflow-hidden">
          <IncidentTimeline v-if="lastIncident && lastIncident.job" :key="`${lastIncident.start}-${lastIncident.job}`" :start="lastIncident.start" :job="lastIncident.job" :tier="lastIncident.tier" size="large" readonly />
          <p v-else class="ex-t-body m-0 text-muted-foreground">{{ lastIncident ? `${NO_DATA}. This incident has no timeline.` : empty }}</p>
        </section>
      </div>

      <!-- Results -->
      <div v-else class="flex min-h-0 flex-1 flex-col ex-results">
        <div class="ex-results-head flex flex-wrap items-baseline">
          <h2 class="ex-t-title m-0 font-semibold">Results of the latest saved evaluation run</h2>
          <span class="ex-t-body text-muted-foreground">{{ period ? `${period}${runModel ? `, model ${runModel}` : ''}` : '' }}</span>
        </div>
        <ul v-if="stats.length" class="ex-stats m-0 flex min-h-0 flex-1 list-none p-0" :style="{ '--cols': statColumns }">
          <li v-for="stat in stats" :key="stat.label" class="ex-card ex-stat flex min-w-0 flex-col justify-center">
            <span class="ex-t-body text-muted-foreground">{{ stat.label }}</span>
            <span class="font-mono font-medium leading-tight tracking-tight" :class="stat.words ? 'ex-t-numtext' : 'ex-t-num'">{{ stat.value }}</span>
            <span class="ex-t-body text-muted-foreground">{{ stat.sub }}</span>
          </li>
        </ul>
        <p v-else class="ex-t-body m-0 text-muted-foreground">{{ resultsLine }}</p>
      </div>
    </main>

    <footer class="ex-footer ex-t-body flex shrink-0 flex-wrap items-center text-muted-foreground">
      <!-- A mouse click does not focus a button (mousedown.prevent), so Space still pauses after a
           click instead of pressing the button again. Tab still reaches them from the keyboard. -->
      <div class="flex items-center ex-dots" role="group" aria-label="Screens">
        <button
          v-for="(s, i) in SCREENS"
          :key="s.id"
          type="button"
          class="ex-dot ex-t-body cursor-pointer rounded-full font-medium"
          :class="screen === i ? 'bg-foreground text-background' : 'border border-border bg-card text-foreground'"
          :aria-current="screen === i ? 'true' : undefined"
          @mousedown.prevent
          @click="go(i)"
        >{{ s.label }}</button>
      </div>
      <span v-if="paused" class="font-semibold text-foreground">Paused.</span>
      <span>{{ paused ? 'Press Space to resume, Esc to leave.' : `Next screen in ${left} s. Press Space to pause, Esc to leave.` }}</span>
      <span class="ml-auto font-mono">{{ host }}</span>
    </footer>
  </div>
  </div>
</template>

<style scoped>
/* The outer element fills the window and clips; the stage inside it is a fixed 1920 x 1080 box,
   centred and scaled by the script. One design pixel is --u, which is 1 px on the stage. */
.ex { --u: 1px; --pad: calc(36 * var(--u)); width: 1920px; height: 1080px; left: 50%; top: 50%; transform-origin: center center; }
.ex-header { gap: calc(20 * var(--u)); padding: calc(28 * var(--u)) var(--pad) calc(16 * var(--u)); }
.ex-header-right { gap: calc(28 * var(--u)); }
.ex-logo { width: calc(64 * var(--u)); height: calc(64 * var(--u)); border-radius: calc(16 * var(--u)); }
.ex-main { padding: 0 var(--pad); gap: calc(12 * var(--u)); }
.ex-alert { padding: calc(10 * var(--u)) calc(20 * var(--u)); border-radius: calc(12 * var(--u)); }
.ex-footer { gap: calc(20 * var(--u)); padding: calc(16 * var(--u)) var(--pad) calc(24 * var(--u)); }
.ex-dots { gap: calc(10 * var(--u)); }
.ex-dot { min-height: calc(52 * var(--u)); padding: 0 calc(22 * var(--u)); }
.ex-card { background: var(--card); border-radius: calc(20 * var(--u)); box-shadow: 0 0 0 1px var(--border); padding: calc(24 * var(--u)) calc(28 * var(--u)); gap: calc(14 * var(--u)); }
.ex-live { grid-template-columns: 1.5fr 1fr; gap: calc(24 * var(--u)); }
.ex-incident { grid-template-columns: 1fr 1fr; gap: calc(24 * var(--u)); }
.ex-score-row { gap: calc(24 * var(--u)); }
.ex-nodata { padding: calc(40 * var(--u)) 0; }
.ex-steps { gap: calc(10 * var(--u)); }
.ex-step { gap: calc(18 * var(--u)); padding: calc(12 * var(--u)) calc(16 * var(--u)); border-radius: calc(16 * var(--u)); }
.ex-num { width: calc(52 * var(--u)); height: calc(52 * var(--u)); font-size: calc(26 * var(--u)); }
.ex-incident-head { gap: calc(16 * var(--u)); }
.ex-tier { gap: calc(10 * var(--u)); min-height: calc(48 * var(--u)); padding: 0 calc(20 * var(--u)); border-radius: 999px; }
.ex-tier-icon { width: calc(22 * var(--u)); height: calc(22 * var(--u)); }
.ex-sections { gap: calc(16 * var(--u)); }
/* The incident card does not scroll, so a long explanation is cut with an ellipsis instead. The
   card holds about 16 lines of 28 px text below its head (about 636 px with the error line shown):
   4 lines for each of the three sections with their headings, or 15 for unlabelled text. */
.ex-clamp-section, .ex-clamp-whole { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
.ex-clamp-section { -webkit-line-clamp: 4; line-clamp: 4; }
.ex-clamp-whole { -webkit-line-clamp: 15; line-clamp: 15; }
.ex-results { gap: calc(20 * var(--u)); }
.ex-results-head { gap: calc(8 * var(--u)) calc(24 * var(--u)); }
/* Every tile has the same fixed size, a third of the 1848 px between the page margins less the
   gaps, whatever the count. The list is as wide as --cols tiles and centred, so the tiles wrap into
   rows of that many (3 + 3, 3 + 2, 2 + 2, or one row) and each row is centred. */
.ex-stats { --tile: calc((1848 * var(--u) - 2 * 20 * var(--u)) / 3); flex-wrap: wrap; justify-content: center; align-content: center; gap: calc(20 * var(--u)); width: calc(var(--cols) * var(--tile) + (var(--cols) - 1) * 20 * var(--u)); margin-inline: auto; }
.ex-stat { gap: calc(6 * var(--u)); width: var(--tile); height: calc(330 * var(--u)); }

.ex-t-hero { font-size: calc(104 * var(--u)); }
.ex-t-num { font-size: calc(88 * var(--u)); }
.ex-t-numtext { font-size: calc(52 * var(--u)); }
.ex-t-clock { font-size: calc(56 * var(--u)); }
.ex-t-title { font-size: calc(32 * var(--u)); line-height: 1.2; }
.ex-t-step { font-size: calc(28 * var(--u)); }
.ex-t-explain { font-size: calc(28 * var(--u)); line-height: 1.4; }
.ex-t-body { font-size: calc(24 * var(--u)); line-height: 1.35; }

/* No motion at all when the visitor asks for less, including the reused components. */
@media (prefers-reduced-motion: reduce) {
  .ex :deep(*) { animation: none !important; transition: none !important; }
}
</style>
