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

const { refresh } = usePoll(load, 30000)

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
// Times are shown in the browser's local time, in the dashboard's usual format, with the zone
// abbreviation from Intl written once wherever a period or timestamp appears.
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

// The missed example as the script stores it, "2026-10-28T11:59:33Z, peak score 0.558", with its
// time rewritten in local time. Text that does not start with a time is shown as it is.
function missedText(example: string): string {
  const match = example.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))(.*)$/)
  if (!match) return example
  const ms = Date.parse(match[1])
  return Number.isFinite(ms) ? `${localStamp(ms)}${match[2]}` : example
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
      label: `${periodText(r.since, r.until)}${zoneSuffix} (${hoursText(r.since, r.until) || 'period not stored'}, ${count(r.injections)} injections, saved ${when})`,
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

// Acceptance criteria from Chapter 3: the System Evaluation Metrics table (Table 3.23, E1 to E6) and
// the ML Model Evaluation Metrics table (precision, recall, F1). Every criterion is strict: "above",
// "below" or "greater than", so a value equal to the target does not meet it.
const TARGETS = {
  // ML model metrics: precision above 0.85, recall above 0.80, F1 score above 0.82.
  precision: 0.85,
  recall: 0.80,
  f1: 0.82,
  // E1 anomaly prediction lead time: greater than 3 minutes on average.
  leadMinutes: 3,
  // E2 false positive rate: alerts raised outside any injection divided by all alerts, below 10%.
  falsePositiveRate: 0.10,
  // E3 mean time to resolution: below 60 seconds for the Medium and High tiers.
  mttrSeconds: 60,
  // E5 remediation success rate: above 85% of the actions that ran.
  remediationSuccess: 0.85,
} as const

// The figures the targets are judged on, all from stored data; null when it is not stored.
// E2 counts per flagged minute: false_alarms (flagged minutes outside any injection) divided by all
// flagged minutes. Precision is the same count from the other side, the flagged minutes that fell
// inside an injection. Recall is the share of injections detected. F1 combines the two as Chapter 3
// defines it, so it mixes a per-minute precision with a per-injection recall.
const measured = computed(() => {
  const r = data.value?.run
  if (!r) return null
  const recall = r.detection_rate !== null && (r.injections ?? 0) > 0 ? r.detection_rate : null
  const fpr = r.false_alarms !== null && r.flagged_minutes !== null && r.flagged_minutes > 0 ? r.false_alarms / r.flagged_minutes : null
  const precision = fpr === null ? null : 1 - fpr
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { recall, fpr, precision, f1 }
})

interface Card {
  key: string
  label: string
  // null when the report has no figure for it.
  value: string | null
  unit: string
  context: string
  // A second line under the context, or empty.
  extra?: string
}

const cards = computed<Card[]>(() => {
  const d = data.value
  const mv = measured.value
  if (!d || !mv) return []
  const r = d.run

  const detection: Card = mv.recall !== null
    ? { key: 'detection', label: 'Recall, faults detected', value: percent(mv.recall, 1), unit: '', context: `${count(r.detected)} of ${count(r.injections)} injections, target above ${percent(TARGETS.recall, 0)}` }
    : { key: 'detection', label: 'Recall, faults detected', value: null, unit: '', context: 'No injections fall inside this period.' }

  // E2 is the main figure; the share of normal minutes flagged is the second line.
  let perNormal = ''
  if (r.false_alarm_rate !== null) {
    perNormal = `${percent(r.false_alarm_rate, 2)} per normal minute (${count(r.false_alarms)} in ${count(r.normal_minutes)})`
    // With no false alarm, the rule of three gives the most the true rate could be at 95 percent confidence.
    if (r.false_alarms === 0 && r.normal_minutes) perNormal += `, below ${percent(3 / r.normal_minutes, 2)} at 95% confidence`
  }
  const falseAlarms: Card = mv.fpr !== null
    ? { key: 'false', label: 'False positive rate', value: percent(mv.fpr, 1), unit: '', context: `${count(r.false_alarms)} of ${count(r.flagged_minutes)} flagged minutes outside an injection, target below ${percent(TARGETS.falsePositiveRate, 0)}`, extra: perNormal }
    : { key: 'false', label: 'False positive rate', value: null, unit: '', context: 'No minute was flagged in this period.', extra: perNormal }

  const margin: Card = r.margin !== null
    ? { key: 'margin', label: 'Safety margin', value: fixed(r.margin, 3), unit: '', context: `highest normal ${fixed(r.top_normal_score)} against threshold ${fixed(r.threshold)}` }
    : { key: 'margin', label: 'Safety margin', value: null, unit: '', context: 'The threshold or the normal scores were not stored.' }

  // E1 asks for an average; the report stores only the median and the longest lead, so the median is
  // shown and named as such.
  let lead: Card
  if (r.ramp_injections === null || r.ramp_injections === 0) {
    lead = { key: 'lead', label: 'Lead time, median', value: null, unit: '', context: 'No ramp injections in this period, so there is no lead time to measure.' }
  } else if (r.lead_median_min !== null) {
    const longest = r.lead_max_min === null ? '' : `, longest ${r.lead_max_min.toFixed(0)} min`
    lead = { key: 'lead', label: 'Lead time, median', value: r.lead_median_min.toFixed(1), unit: ' min median', context: `${count(r.warned_before_flag)} of ${r.ramp_injections} ramp ${plural(r.ramp_injections, 'injection', 'injections')} warned before the first flag${longest}`, extra: `Target greater than ${TARGETS.leadMinutes} min on average; only the median is stored.` }
  } else {
    lead = { key: 'lead', label: 'Lead time, median', value: 'None', unit: '', context: `0 of ${r.ramp_injections} ramp ${plural(r.ramp_injections, 'injection', 'injections')} warned before the model flagged ${r.ramp_injections === 1 ? 'it' : 'them'}` }
  }

  const m = d.mttr
  const mttr: Card = m && m.median_seconds !== null
    ? {
        key: 'mttr',
        label: 'MTTR, Medium and High',
        value: String(m.median_seconds),
        unit: ' s median',
        context: `incident start to the action that worked, ${m.count} ${plural(m.count, 'incident', 'incidents')}, target below ${TARGETS.mttrSeconds} s`,
        extra: m.approved > 0 ? 'Includes the wait for approval on Telegram.' : '',
      }
    : { key: 'mttr', label: 'MTTR, Medium and High', value: null, unit: '', context: m ? 'No restart or rollback brought a Medium or High incident back in this period.' : 'The action data could not be read. Try Refresh.' }

  // E5 counts the restarts and rollbacks inside this report's period only, so it can differ from the
  // success rate on the Remediation page, which uses that page's own range.
  const rem = d.remediation
  const success: Card = rem && rem.ran > 0
    ? { key: 'success', label: 'Remediation success', value: percent(rem.worked / rem.ran, 0), unit: '', context: `${rem.worked} of ${rem.ran} ${plural(rem.ran, 'action', 'actions')} that ran brought the service back, target above ${percent(TARGETS.remediationSuccess, 0)}`, extra: "For this report's period." }
    : { key: 'success', label: 'Remediation success', value: null, unit: '', context: rem ? 'No restart or rollback ran in this period.' : 'The action data could not be read. Try Refresh.', extra: "For this report's period." }

  return [detection, falseAlarms, margin, lead, mttr, success]
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

// One row per Chapter 3 target. Met and Not met need a stored figure; Not tested means nothing
// stored answers it yet, and why says what is missing.
type TargetStatus = 'Met' | 'Not met' | 'Not tested'
interface TargetRow {
  key: 'precision' | 'recall' | 'f1' | 'e1' | 'e2' | 'e3' | 'e4' | 'e5' | 'e6'
  id: string
  metric: string
  target: string
  measured: string
  status: TargetStatus
}
const notStored = (key: TargetRow['key'], id: string, metric: string, target: string, why: string): TargetRow =>
  ({ key, id, metric, target, measured: why, status: 'Not tested' })

const targets = computed<TargetRow[]>(() => {
  const d = data.value
  const mv = measured.value
  if (!d || !mv) return []
  const r = d.run
  const judge = (ok: boolean): TargetStatus => (ok ? 'Met' : 'Not met')
  const rows: TargetRow[] = []

  rows.push(mv.precision === null
    ? notStored('precision', 'ML', 'Precision', `above ${TARGETS.precision.toFixed(2)}`, 'No flagged minutes in this report')
    : { key: 'precision', id: 'ML', metric: 'Precision', target: `above ${TARGETS.precision.toFixed(2)}`, measured: `${mv.precision.toFixed(3)}, flagged minutes inside an injection`, status: judge(mv.precision > TARGETS.precision) })
  rows.push(mv.recall === null
    ? notStored('recall', 'ML', 'Recall', `above ${TARGETS.recall.toFixed(2)}`, 'No injections in this report')
    : { key: 'recall', id: 'ML', metric: 'Recall', target: `above ${TARGETS.recall.toFixed(2)}`, measured: `${mv.recall.toFixed(3)}, ${count(r.detected)} of ${count(r.injections)} injections`, status: judge(mv.recall > TARGETS.recall) })
  rows.push(mv.f1 === null
    ? notStored('f1', 'ML', 'F1 score', `above ${TARGETS.f1.toFixed(2)}`, 'Needs precision and recall')
    : { key: 'f1', id: 'ML', metric: 'F1 score', target: `above ${TARGETS.f1.toFixed(2)}`, measured: mv.f1.toFixed(3), status: judge(mv.f1 > TARGETS.f1) })

  // E1. Only the median lead is stored, so the median is judged against the average target and the
  // row says so. Ramp injections that were never warned before their first flag have no lead.
  const leadTarget = `greater than ${TARGETS.leadMinutes} min on average`
  if (!r.ramp_injections) rows.push(notStored('e1', 'E1', 'Anomaly prediction lead time', leadTarget, 'No ramp injections in this report'))
  else if (r.lead_median_min === null) rows.push({ key: 'e1', id: 'E1', metric: 'Anomaly prediction lead time', target: leadTarget, measured: `No warning before the first flag (0 of ${r.ramp_injections})`, status: 'Not met' })
  else rows.push({ key: 'e1', id: 'E1', metric: 'Anomaly prediction lead time', target: leadTarget, measured: `${r.lead_median_min.toFixed(1)} min median (the average is not stored)`, status: judge(r.lead_median_min > TARGETS.leadMinutes) })

  rows.push(mv.fpr === null
    ? notStored('e2', 'E2', 'False positive rate', `below ${percent(TARGETS.falsePositiveRate, 0)}`, 'No flagged minutes in this report')
    : { key: 'e2', id: 'E2', metric: 'False positive rate', target: `below ${percent(TARGETS.falsePositiveRate, 0)}`, measured: `${percent(mv.fpr, 1)}, ${count(r.false_alarms)} of ${count(r.flagged_minutes)} flagged minutes`, status: judge(mv.fpr < TARGETS.falsePositiveRate) })

  const m = d.mttr
  const mttrTarget = `below ${TARGETS.mttrSeconds} s, Medium and High`
  if (!m || m.median_seconds === null) rows.push(notStored('e3', 'E3', 'Mean time to resolution', mttrTarget, m ? 'No action brought a Medium or High incident back' : 'The action data could not be read'))
  else rows.push({ key: 'e3', id: 'E3', metric: 'Mean time to resolution', target: mttrTarget, measured: `${m.median_seconds} s median, ${m.count} ${plural(m.count, 'incident', 'incidents')}${m.approved > 0 ? ', includes the wait for approval on Telegram' : ''}`, status: judge(m.median_seconds < TARGETS.mttrSeconds) })

  rows.push(notStored('e4', 'E4', 'LLM explanation accuracy', 'at least 80% scored 2 or 3', 'Not stored yet'))

  const rem = d.remediation
  const remTarget = `above ${percent(TARGETS.remediationSuccess, 0)}`
  if (!rem || rem.ran === 0) rows.push(notStored('e5', 'E5', 'Remediation success rate', remTarget, rem ? 'No restart or rollback ran in this period' : 'The action data could not be read'))
  else rows.push({ key: 'e5', id: 'E5', metric: 'Remediation success rate', target: remTarget, measured: `${percent(rem.worked / rem.ran, 0)}, ${rem.worked} of ${rem.ran} that ran`, status: judge(rem.worked / rem.ran > TARGETS.remediationSuccess) })

  rows.push(notStored('e6', 'E6', 'End-to-end alert latency', 'below 30 s', 'Not stored yet'))
  return rows
})

type Status = 'Met' | 'In progress' | 'Not tested'
interface Objective {
  no: number
  text: string
  by: string
  status: Status
}

// An objective linked to Chapter 3 targets (the traceability table, Table 3.18): Met only when every
// linked target is stored and met; In progress when at least one is stored but not every one is met;
// Not tested when none is stored.
function statusFromTargets(keys: TargetRow['key'][]): Status {
  const linked = targets.value.filter(t => keys.includes(t.key))
  const stored = linked.filter(t => t.status !== 'Not tested')
  if (stored.length === 0) return 'Not tested'
  return stored.length === linked.length && stored.every(t => t.status === 'Met') ? 'Met' : 'In progress'
}
function targetsText(keys: TargetRow['key'][]): string {
  const linked = targets.value.filter(t => keys.includes(t.key))
  const met = linked.filter(t => t.status === 'Met').length
  const stored = linked.filter(t => t.status !== 'Not tested').length
  return `${met} of ${linked.length} Chapter 3 targets met, ${stored} measured`
}
const OBJECTIVE_3_TARGETS: TargetRow['key'][] = ['precision', 'recall', 'f1', 'e1', 'e2']
// Objective 5 links E3, E5 and E6, as in the traceability table. E6 is not stored yet, so objective
// 5 is In progress at best until it is.
const OBJECTIVE_5_TARGETS: TargetRow['key'][] = ['e3', 'e5', 'e6']

// Objectives and their status, each only from stored data, never from a typed-in result.
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

  // 3. Anomaly model, linked to precision, recall, F1, lead time (E1) and false positive rate (E2).
  list.push({
    no: 3,
    text: 'Develop and evaluate the anomaly model',
    by: `Precision, recall, F1, lead time and false positive rate: ${targetsText(OBJECTIVE_3_TARGETS)}`,
    status: statusFromTargets(OBJECTIVE_3_TARGETS),
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

  // 5. Three-tier remediation, linked to MTTR (E3), remediation success (E5) and end-to-end alert
  // latency (E6).
  list.push({
    no: 5,
    text: 'Implement three-tier remediation',
    by: `MTTR, remediation success rate and alert latency: ${targetsText(OBJECTIVE_5_TARGETS)}`,
    status: statusFromTargets(OBJECTIVE_5_TARGETS),
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

const STATUS_CLASS: Record<Status | TargetStatus, string> = {
  'Met': 'border-transparent bg-okbg text-ok',
  'In progress': 'border-transparent bg-tier-medium-bg text-tier-medium-fg',
  'Not met': 'border-transparent bg-tier-medium-bg text-tier-medium-fg',
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
      <Skeleton v-for="n in 6" :key="n" class="h-[116px] rounded-xl" />
    </div>
    <Skeleton class="h-48 rounded-xl" />
    <Skeleton class="h-56 rounded-xl" />
  </template>

  <div v-else-if="failed && !data" class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    <span>The evaluation data could not be loaded. Retrying in 30 s.</span>
    <button type="button" class="min-h-9 rounded-lg border border-current px-3.5 font-medium hover:bg-card/40 pointer-coarse:min-h-11" @click="refresh">Retry</button>
  </div>

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
      <span class="font-medium text-foreground">{{ periodText(data.run.since, data.run.until) }}{{ zoneSuffix }}</span>{{ summaryRest }}
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
        <div v-if="c.extra" class="mt-0.5 text-xs text-muted-foreground">{{ c.extra }}</div>
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
                <th scope="col" :class="cell" class="py-2 font-medium">Missed example{{ zoneSuffix }}</th>
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
                  <span v-if="f.missed_example" class="font-mono text-xs text-tier-medium-fg">{{ missedText(f.missed_example) }}</span>
                  <span v-else class="text-muted-foreground">{{ f.missed === 0 ? 'None missed' : '-' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <section aria-labelledby="targets-title" class="overflow-hidden rounded-xl border border-border">
      <div class="px-[18px] py-3.5">
        <h2 id="targets-title" class="text-[15px] font-semibold">Chapter 3 targets</h2>
        <p class="text-xs text-muted-foreground">The acceptance criteria of the System Evaluation Metrics (E1 to E6) and the ML model metrics, judged on this report. Not tested means nothing stored answers it yet.</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] text-left">
          <thead class="bg-chip text-xs font-medium text-muted-foreground">
            <tr>
              <th scope="col" :class="cell" class="w-14 py-2 font-medium">ID</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Metric</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Target</th>
              <th scope="col" :class="cell" class="py-2 font-medium">Measured</th>
              <th scope="col" :class="cell" class="w-32 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in targets" :key="t.key" class="border-t border-border align-middle">
              <td :class="cell" class="font-mono text-[13px]">{{ t.id }}</td>
              <td :class="cell">{{ t.metric }}</td>
              <td :class="cell" class="text-[13px] text-muted-foreground">{{ t.target }}</td>
              <td :class="cell" class="text-[13px]"><span :class="t.status === 'Not tested' ? 'text-muted-foreground' : 'font-mono'">{{ t.measured }}</span></td>
              <td :class="cell">
                <span class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap" :class="STATUS_CLASS[t.status]">{{ t.status }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section aria-labelledby="objectives-title" class="overflow-hidden rounded-xl border border-border">
      <div class="px-[18px] py-3.5">
        <h2 id="objectives-title" class="text-[15px] font-semibold">Against the project objectives</h2>
        <p class="text-xs text-muted-foreground">Status comes only from stored data. Objectives 3 and 5 are Met only when every Chapter 3 target linked to them is met, In progress when some are measured, and Not tested when none is.</p>
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
