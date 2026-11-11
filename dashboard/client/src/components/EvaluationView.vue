<script setup lang="ts">
import type { Evaluation, EvaluationDay } from '@/types'
import axios from 'axios'
import { computed, onUnmounted, ref, watch } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { clockTime, fixed, shortDate } from '@/lib/format'

const props = defineProps<{
  // The text after the "?" in the hash, for example run=2026-11-11T04:30:00Z.
  query: string
}>()
const emit = defineEmits<{ 'refreshed': [ok: boolean], 'update:query': [query: string] }>()

function runFromQuery(query: string): string | null {
  return new URLSearchParams(query).get('run') || null
}

// The run shown. null means the latest saved run.
const run = ref<string | null>(runFromQuery(props.query))
const data = ref<Evaluation | null>(null)
const loading = ref(true)
const failed = ref(false)
// The server has no saved report, or none for the run in the link.
const notFound = ref(false)
const refreshing = ref(false)

async function load() {
  const requested = run.value
  refreshing.value = true
  try {
    const { data: body } = await api.get<Evaluation>('/api/evaluation', { params: requested ? { run: requested } : {} })
    // The run changed while this load ran; a reload for the new run follows.
    if (requested !== run.value) return
    data.value = body
    failed.value = false
    notFound.value = false
    emit('refreshed', true)
  } catch (err) {
    if (requested !== run.value) return
    const status = axios.isAxiosError(err) ? err.response?.status : undefined
    if (status === 404 || status === 400) {
      // A missing report is an answer, not a failure.
      data.value = null
      failed.value = false
      notFound.value = true
      emit('refreshed', true)
    } else {
      failed.value = true
      emit('refreshed', false)
    }
  } finally {
    refreshing.value = false
    if (requested === run.value) loading.value = false
  }
}

const { refresh } = usePoll(load, 60000)

// The hash keeps the view and the run, so a copied link opens the same report. replaceState does
// not fire hashchange, so the new query is also sent to the parent, which keeps its copy in step.
function writeHash() {
  const query = run.value ? `run=${run.value}` : ''
  const hash = query ? `#evaluation?${query}` : '#evaluation'
  if (window.location.hash !== hash) history.replaceState(null, '', hash)
  if (props.query !== query) emit('update:query', query)
}

// A report from the old run is never shown under the new one.
watch(run, () => {
  data.value = null
  failed.value = false
  notFound.value = false
  loading.value = true
  writeHash()
  refresh()
})
// A link pasted while this view is open.
watch(() => props.query, (query) => { run.value = runFromQuery(query) })

function pick(event: Event) {
  run.value = (event.target as HTMLSelectElement).value || null
}

const spinning = computed(() => loading.value || refreshing.value)

// Copy link: the address always names the run on screen, so it stays the same report after newer
// runs are saved.
const toast = ref<{ url: string, ok: boolean } | null>(null)
let toastTimer: number | undefined
// The older way to copy, for browsers without the clipboard API: select the text in a hidden
// text area and run the copy command. Returns false when the browser refuses.
function copyWithSelection(text: string): boolean {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(area)
  focused?.focus()
  return ok
}
async function copyLink() {
  const id = data.value?.run_id
  if (!id) return
  const url = `${window.location.origin}${window.location.pathname}#evaluation?run=${id}`
  let ok = false
  try {
    // navigator.clipboard is missing on a page served over plain HTTP.
    await navigator.clipboard.writeText(url)
    ok = true
  } catch {
    ok = copyWithSelection(url)
  }
  toast.value = { url, ok }
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = null }, 3500)
}
onUnmounted(() => window.clearTimeout(toastTimer))

// Display helpers. Stored rates are fractions from 0 to 1.
const percent = (rate: number, digits: number) => `${(rate * 100).toFixed(digits)}%`
const count = (value: number | null | undefined) => (value === null || value === undefined ? '-' : String(value))
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

function parseTime(text: string | null): number | null {
  const ms = text ? Date.parse(text) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}
function periodText(since: string | null, until: string | null): string {
  const a = parseTime(since)
  const b = parseTime(until)
  if (a === null || b === null) return 'Period not stored'
  return `${shortDate(a)} ${clockTime(a)} to ${shortDate(b)} ${clockTime(b)}`
}
function hoursText(since: string | null, until: string | null): string {
  const a = parseTime(since)
  const b = parseTime(until)
  if (a === null || b === null) return ''
  const hours = (b - a) / 3600000
  return hours >= 48 ? `${Math.round(hours / 24)} d` : `${Math.round(hours)} h`
}

const options = computed(() =>
  (data.value?.runs ?? []).map((r) => {
    const saved = parseTime(r.run_id)
    const when = saved === null ? r.run_id : `${shortDate(saved)} ${clockTime(saved)}`
    return {
      id: r.run_id,
      label: `${periodText(r.since, r.until)} (${hoursText(r.since, r.until) || 'period not stored'}, ${count(r.injections)} injections, saved ${when})`,
    }
  }),
)

// The rest of the line under the picker: length, model, left-out periods and when the run was saved.
const summaryRest = computed(() => {
  const d = data.value
  if (!d) return ''
  const parts: string[] = []
  const length = hoursText(d.run.since, d.run.until)
  if (length) parts.push(length)
  if (d.run.model) parts.push(`model ${d.run.model}`)
  if (d.run.excluded) parts.push(`${d.run.excluded} ${plural(d.run.excluded, 'period', 'periods')} left out`)
  const saved = Date.parse(d.run_id)
  const savedText = Number.isFinite(saved) ? ` Saved ${shortDate(saved)} ${clockTime(saved)}.` : ''
  return `${parts.length ? `, ${parts.join(', ')}` : ''}.${savedText}`
})

interface Card {
  key: string
  label: string
  // null when the report has no figure for it.
  value: string | null
  unit: string
  context: string
}

const cards = computed<Card[]>(() => {
  const d = data.value
  if (!d) return []
  const r = d.run

  const detection: Card = r.detection_rate !== null && (r.injections ?? 0) > 0
    ? { key: 'detection', label: 'Faults detected', value: percent(r.detection_rate, 1), unit: '', context: `${count(r.detected)} of ${count(r.injections)} injections` }
    : { key: 'detection', label: 'Faults detected', value: null, unit: '', context: 'No injections fall inside this period.' }

  let falseContext = 'No normal minutes in this period.'
  if (r.false_alarm_rate !== null) {
    falseContext = `${count(r.false_alarms)} in ${count(r.normal_minutes)} normal minutes`
    // With no false alarm, the rule of three gives the most the true rate could be at 95 percent confidence.
    if (r.false_alarms === 0 && r.normal_minutes) falseContext += `, below ${percent(3 / r.normal_minutes, 2)} at 95% confidence`
  }
  const falseAlarms: Card = { key: 'false', label: 'False alarms', value: r.false_alarm_rate !== null ? percent(r.false_alarm_rate, 2) : null, unit: '', context: falseContext }

  const margin: Card = r.margin !== null
    ? { key: 'margin', label: 'Safety margin', value: fixed(r.margin, 3), unit: '', context: `highest normal ${fixed(r.top_normal_score)} against threshold ${fixed(r.threshold)}` }
    : { key: 'margin', label: 'Safety margin', value: null, unit: '', context: 'The threshold or the normal scores were not stored.' }

  let lead: Card
  if (r.ramp_injections === null || r.ramp_injections === 0) {
    lead = { key: 'lead', label: 'Warned ahead', value: null, unit: '', context: 'No ramp injections in this period, so there is no lead time to measure.' }
  } else if (r.lead_median_min !== null) {
    const longest = r.lead_max_min === null ? '' : `, longest ${r.lead_max_min.toFixed(0)} min`
    lead = { key: 'lead', label: 'Warned ahead', value: r.lead_median_min.toFixed(0), unit: ' min median', context: `${count(r.warned_before_flag)} of ${r.ramp_injections} ramp ${plural(r.ramp_injections, 'injection', 'injections')} warned before the first flag${longest}` }
  } else {
    lead = { key: 'lead', label: 'Warned ahead', value: 'None', unit: '', context: `0 of ${r.ramp_injections} ramp ${plural(r.ramp_injections, 'injection', 'injections')} warned before the model flagged ${r.ramp_injections === 1 ? 'it' : 'them'}` }
  }

  const m = d.mttr
  const mttr: Card = m && m.median_minutes !== null
    ? { key: 'mttr', label: 'Time to recover', value: m.median_minutes.toFixed(1), unit: ' min MTTR', context: `incident start to the action that worked, ${m.count} ${plural(m.count, 'incident', 'incidents')}` }
    : { key: 'mttr', label: 'Time to recover', value: null, unit: '', context: m ? 'No restart or rollback brought the service back in this period.' : 'The action data could not be read. Try Refresh.' }

  return [detection, falseAlarms, margin, lead, mttr]
})

const FAULT_NAMES: Record<string, string> = { 'cpu-spike': 'CPU spike', 'memory-leak': 'Memory leak', 'latency-spike': 'Latency spike' }
function faultName(name: string | null): string {
  if (!name) return 'Unknown'
  if (FAULT_NAMES[name]) return FAULT_NAMES[name]
  const words = name.replace(/[-_]/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// One bar per UTC day: normal minutes, false alarms and minutes inside an injection window add up
// to the minutes scored that day. The stored data has no score histogram, so this is the chart.
interface Bar {
  day: string
  label: string
  scored: number
  normalOk: number
  falseAlarms: number
  injected: number
  // Heights in percent of the busiest day.
  normalPct: string
  falsePct: string
  injectedPct: string
  summary: string
}
const bars = computed<Bar[]>(() => {
  const days = (data.value?.days ?? []).filter((d): d is EvaluationDay & { day: string } => d.day !== null && d.scored_minutes !== null)
  const tallest = Math.max(1, ...days.map(d => d.scored_minutes ?? 0))
  return days.map((d) => {
    const scored = d.scored_minutes ?? 0
    const normal = Math.min(scored, d.normal_minutes ?? 0)
    const falseAlarms = Math.min(normal, d.false_alarms ?? 0)
    const at = Date.parse(`${d.day}T12:00:00Z`)
    const label = Number.isFinite(at) ? new Date(at).toLocaleDateString([], { day: '2-digit', month: 'short', timeZone: 'UTC' }) : d.day
    const pct = (v: number) => `${(v / tallest) * 100}%`
    const injected = scored - normal
    return {
      day: d.day,
      label,
      scored,
      normalOk: normal - falseAlarms,
      falseAlarms,
      injected,
      normalPct: pct(normal - falseAlarms),
      falsePct: falseAlarms > 0 ? `max(${pct(falseAlarms)}, 3px)` : '0%',
      injectedPct: pct(injected),
      summary: `${label} UTC: ${scored} minutes scored, ${normal - falseAlarms} normal, ${falseAlarms} false ${plural(falseAlarms, 'alarm', 'alarms')}, ${injected} inside an injection window`,
    }
  })
})
const totalFalseAlarms = computed(() => bars.value.reduce((sum, b) => sum + b.falseAlarms, 0))

type Status = 'Met' | 'In progress' | 'Not tested'
interface Objective {
  no: number
  text: string
  by: string
  status: Status
}

// Objectives and their status. Each status comes only from stored data, never from a typed-in
// result. Two target values are set here and can be changed: a run meets objective 3 at or above
// DETECTION_TARGET and at or below FALSE_ALARM_LIMIT. They are working targets chosen for this
// view, not figures from the project documents, and the table says so next to the result.
const DETECTION_TARGET = 0.9
const FALSE_ALARM_LIMIT = 0.05
const TARGETS_TEXT = `target ${percent(DETECTION_TARGET, 0)} detected, at most ${percent(FALSE_ALARM_LIMIT, 0)} false alarms (dashboard targets)`
const objectives = computed<Objective[]>(() => {
  const d = data.value
  if (!d) return []
  const r = d.run
  const e = d.evidence
  const list: Objective[] = []

  // 1. CI/CD pipeline. Met when at least one deployment event from CI is stored (source ci).
  // Not tested when none is stored or the count could not be read.
  const deployments = e?.ci_deployments ?? 0
  list.push({
    no: 1,
    text: 'Construct an automated CI/CD pipeline',
    by: e ? `${deployments} ${plural(deployments, 'deployment', 'deployments')} recorded by CI` : 'Deployments recorded by CI (could not be read)',
    status: deployments > 0 ? 'Met' : 'Not tested',
  })

  // 2. Real-time monitoring. Met when the saved report scored at least one minute, which means
  // metrics were scraped and stored. Not tested otherwise.
  const scored = r.scored_minutes ?? 0
  list.push({
    no: 2,
    text: 'Develop real-time monitoring',
    by: scored > 0 ? `${scored} minutes of metrics scored in this report` : 'Scored minutes in the saved report',
    status: scored > 0 ? 'Met' : 'Not tested',
  })

  // 3. Anomaly model. Not tested when the report has no injections or no detection rate. Met when the
  // detection rate is at least DETECTION_TARGET and the false alarm rate (when there are normal
  // minutes) is at most FALSE_ALARM_LIMIT. In progress otherwise.
  let modelStatus: Status = 'Not tested'
  if (r.detection_rate !== null && (r.injections ?? 0) > 0) {
    const falseOk = r.false_alarm_rate === null || r.false_alarm_rate <= FALSE_ALARM_LIMIT
    modelStatus = r.detection_rate >= DETECTION_TARGET && falseOk ? 'Met' : 'In progress'
  }
  list.push({
    no: 3,
    text: 'Develop and evaluate the anomaly model',
    by: r.detection_rate !== null
      ? `Detection ${percent(r.detection_rate, 1)}${r.false_alarm_rate !== null ? `, false alarms ${percent(r.false_alarm_rate, 2)}` : ''}; ${TARGETS_TEXT}`
      : `Detection and false alarms against the injector log; ${TARGETS_TEXT}`,
    status: modelStatus,
  })

  // 4. Local LLM. Not tested when no incident explanation is stored. In progress when some are stored,
  // because no stored data says whether they are correct, so this never reaches Met here.
  const explanations = e?.explanations ?? 0
  list.push({
    no: 4,
    text: 'Integrate the local LLM with observability',
    by: explanations > 0 ? `${explanations} ${plural(explanations, 'explanation', 'explanations')} stored, accuracy not measured` : 'Stored explanations and a signal accuracy check',
    status: explanations > 0 ? 'In progress' : 'Not tested',
  })

  // 5. Three-tier remediation. Not tested when no restart or rollback has run. Met when at least one
  // restart and at least one rollback ran and the service was up afterwards (service_up 1). In
  // progress when actions ran but one of the two has not yet worked.
  const a = e?.actions
  let remediation: Status = 'Not tested'
  if (a && a.ran > 0) remediation = a.restart_worked > 0 && a.rollback_worked > 0 ? 'Met' : 'In progress'
  const mttrText = d.mttr?.median_minutes != null ? `, MTTR ${d.mttr.median_minutes.toFixed(1)} min` : ''
  list.push({
    no: 5,
    text: 'Implement three-tier remediation',
    by: a ? `${a.ran} ${plural(a.ran, 'action', 'actions')} ran, ${a.restart_worked} ${plural(a.restart_worked, 'restart', 'restarts')} and ${a.rollback_worked} ${plural(a.rollback_worked, 'rollback', 'rollbacks')} worked${mttrText}` : 'Restarts and rollbacks that worked (could not be read)',
    status: remediation,
  })

  // 6. Dashboard and Telegram chatbot. Test results are not stored anywhere the dashboard reads, so
  // this is always Not tested.
  list.push({
    no: 6,
    text: 'Develop the dashboard and Telegram chatbot',
    by: 'Functional tests FT-34 to FT-39 (no results stored)',
    status: 'Not tested',
  })
  return list
})

const STATUS_CLASS: Record<Status, string> = {
  'Met': 'border-transparent bg-okbg text-ok',
  'In progress': 'border-transparent bg-tier-medium-bg text-tier-medium-fg',
  'Not tested': 'border-dashed border-input bg-transparent text-chipfg',
}

const card = 'rounded-xl border border-border p-4'
const cell = 'px-[18px] py-3'
const buttonClass = 'inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3.5 text-[13px] font-medium hover:bg-chip pointer-coarse:min-h-11'
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Evaluation</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">How well the system works, measured against the injector log. Anything the saved report does not hold shows as Not tested.</p>
    </div>
    <div class="flex min-w-0 max-w-full flex-wrap items-center gap-2.5">
      <label v-if="data" class="flex min-w-0 max-w-full items-center gap-2 text-[13px] text-muted-foreground">
        Report
        <select
          class="min-h-9 w-full min-w-0 max-w-[34rem] flex-1 rounded-lg border border-input bg-card px-2.5 text-foreground pointer-coarse:min-h-11"
          :value="data.run_id"
          @change="pick"
        >
          <option v-for="o in options" :key="o.id" :value="o.id">{{ o.label }}</option>
        </select>
      </label>
      <button type="button" :class="buttonClass" :disabled="!data" @click="copyLink">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
        Copy link
      </button>
      <button type="button" :class="buttonClass" :aria-busy="spinning" @click="refresh">
        <svg class="size-3.5" :class="spinning ? 'animate-spin motion-reduce:animate-none' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
        {{ spinning ? 'Refreshing' : 'Refresh' }}
      </button>
    </div>
  </div>

  <!-- The toast inverts the theme: dark on light, light on dark. The status region is always in
       the page, so a screen reader announces the message when it appears inside it. -->
  <div role="status" aria-live="polite" class="pointer-events-none fixed top-16 right-4 z-50 w-[min(420px,calc(100vw-2rem))] md:right-6">
    <div v-if="toast" class="pointer-events-auto rounded-[10px] bg-foreground p-3 text-[13px] text-card shadow-lg">
      <div class="font-semibold">{{ toast.ok ? 'Link copied' : 'Could not copy the link' }}</div>
      <div class="mt-0.5 opacity-85">{{ toast.ok ? 'It opens this report.' : 'Select the address below and copy it by hand.' }}</div>
      <div class="mt-2 rounded-md bg-card/10 px-2 py-1.5 font-mono text-[11px] break-all select-all">{{ toast.url }}</div>
    </div>
  </div>

  <template v-if="loading">
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <Skeleton v-for="n in 5" :key="n" class="h-[116px] rounded-xl" />
    </div>
    <Skeleton class="h-48 rounded-xl" />
    <Skeleton class="h-56 rounded-xl" />
  </template>

  <p v-else-if="failed && !data" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    InfluxDB did not answer. Retrying in 60 s.
  </p>

  <div v-else-if="!data" class="rounded-xl border border-dashed border-input px-[18px] py-10 text-center text-[13px] text-muted-foreground">
    <template v-if="run">
      <p>There is no saved report for the run in this link.</p>
      <button type="button" class="mt-3 rounded-lg border border-border px-3.5 py-2 font-medium text-foreground hover:bg-chip" @click="run = null">Show the latest report</button>
    </template>
    <p v-else>No saved report yet. Run detection_report.py --save on the server.</p>
  </div>

  <template v-else>
    <p v-if="failed" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      The report could not be refreshed. Showing the last loaded data.
    </p>

    <p class="text-[13px] text-muted-foreground">
      <span class="font-medium text-foreground">{{ periodText(data.run.since, data.run.until) }}</span>{{ summaryRest }}
    </p>

    <section aria-label="Headline results" class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <div v-for="c in cards" :key="c.key" :class="card">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] text-muted-foreground">{{ c.label }}</span>
          <span v-if="c.value === null" class="rounded-md border border-dashed border-input px-1.5 text-[11px] font-medium text-chipfg">Not tested</span>
        </div>
        <div class="mt-2">
          <span v-if="c.value !== null" class="font-mono text-[28px] font-medium tracking-[-0.02em]">{{ c.value }}</span>
          <span v-else class="font-mono text-[28px] font-medium tracking-[-0.02em] text-muted-foreground">No data</span>
          <span v-if="c.value !== null && c.unit" class="text-[13px] text-muted-foreground">{{ c.unit }}</span>
        </div>
        <div class="mt-0.5 text-xs text-muted-foreground">{{ c.context }}</div>
      </div>
    </section>

    <div class="flex flex-wrap items-stretch gap-4">
      <section aria-labelledby="days-title" class="flex min-w-0 flex-[1.4_1_420px] flex-col gap-2 rounded-xl border border-border px-[18px] py-4">
        <div>
          <h2 id="days-title" class="text-[15px] font-semibold">Minutes scored, by day</h2>
          <p class="text-xs text-muted-foreground">
            The number above each bar is that day's false alarms ({{ totalFalseAlarms }} in this report). Days are UTC.
            The report keeps a count per day, not a histogram of scores.
          </p>
        </div>
        <p v-if="bars.length === 0" class="py-10 text-center text-[13px] text-muted-foreground">No per-day figures in this report.</p>
        <div v-else class="flex items-end gap-2 overflow-x-auto pt-1 pb-1" role="group" aria-label="Minutes scored per day">
          <div v-for="b in bars" :key="b.day" class="flex w-14 shrink-0 flex-col items-center gap-1">
            <span class="font-mono text-[11px]" :class="b.falseAlarms > 0 ? 'font-semibold text-tier-medium-fg' : 'text-muted-foreground'">{{ b.falseAlarms }}</span>
            <div class="flex h-40 w-full flex-col-reverse overflow-hidden rounded-sm bg-track/40" role="img" :aria-label="b.summary" :title="b.summary">
              <div class="bg-strip" :style="{ height: b.normalPct }" />
              <div class="bg-amber" :style="{ height: b.falsePct }" />
              <div class="bg-series2" :style="{ height: b.injectedPct }" />
            </div>
            <span class="font-mono text-[11px] text-faint">{{ b.label }}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
          <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[2px] bg-strip" aria-hidden="true" />Normal minutes</span>
          <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[2px] bg-amber" aria-hidden="true" />False alarms</span>
          <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[2px] bg-series2" aria-hidden="true" />Minutes inside an injection window</span>
        </div>
      </section>

      <section aria-labelledby="faults-title" class="min-w-0 flex-[1_1_340px] overflow-hidden rounded-xl border border-border">
        <div class="px-[18px] py-3.5">
          <h2 id="faults-title" class="text-[15px] font-semibold">By fault type</h2>
          <p class="text-xs text-muted-foreground">Detected means at least one minute was flagged during the injection.</p>
        </div>
        <p v-if="data.faults.length === 0" class="border-t border-border px-[18px] py-10 text-center text-[13px] text-muted-foreground">
          No injections fall inside this period.
        </p>
        <div v-else class="overflow-x-auto">
          <table class="w-full min-w-[520px] text-left">
            <thead class="bg-chip text-xs font-medium text-muted-foreground">
              <tr>
                <th scope="col" :class="cell" class="py-2 font-medium">Fault</th>
                <th scope="col" :class="cell" class="py-2 font-medium">Injections</th>
                <th scope="col" :class="cell" class="py-2 font-medium">Detected</th>
                <th scope="col" :class="cell" class="py-2 font-medium">Rate</th>
                <th scope="col" :class="cell" class="py-2 font-medium">Median peak</th>
                <th scope="col" :class="cell" class="py-2 font-medium">Missed example</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in data.faults" :key="f.fault ?? ''" class="border-t border-border align-top">
                <td :class="cell" class="font-medium">{{ faultName(f.fault) }}</td>
                <td :class="cell" class="font-mono text-[13px]">{{ count(f.injections) }}</td>
                <td :class="cell" class="font-mono text-[13px]">{{ count(f.detected) }}</td>
                <td :class="cell" class="font-mono text-[13px]">{{ f.detection_rate === null ? '-' : percent(f.detection_rate, 0) }}</td>
                <td :class="cell" class="font-mono text-[13px]">{{ fixed(f.median_peak_score) }}</td>
                <td :class="cell" class="text-[13px]">
                  <span v-if="f.missed_example" class="font-mono text-xs text-tier-medium-fg">{{ f.missed_example }}</span>
                  <span v-else class="text-muted-foreground">{{ f.missed === 0 ? 'None missed' : '-' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <section aria-labelledby="objectives-title" class="overflow-hidden rounded-xl border border-border">
      <div class="px-[18px] py-3.5">
        <h2 id="objectives-title" class="text-[15px] font-semibold">Against the project objectives</h2>
        <p class="text-xs text-muted-foreground">Status comes only from stored data. Not tested means nothing stored answers it yet. The targets for objective 3 are set in this dashboard, not taken from the project documents.</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] text-left">
          <thead class="bg-chip text-xs font-medium text-muted-foreground">
            <tr>
              <th scope="col" :class="cell" class="w-11 py-2 font-medium">No.</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Objective</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Measured by</th>
              <th scope="col" :class="cell" class="w-36 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in objectives" :key="o.no" class="border-t border-border align-middle">
              <td :class="cell" class="font-mono">{{ o.no }}</td>
              <td :class="cell">{{ o.text }}</td>
              <td :class="cell" class="text-[13px] text-muted-foreground">{{ o.by }}</td>
              <td :class="cell">
                <span class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap" :class="STATUS_CLASS[o.status]">{{ o.status }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>
