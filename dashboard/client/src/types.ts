// Response shapes of the dashboard API. InfluxDB returns null for a field a row does not have.

export interface Health {
  status: string
  time: string
  influx: boolean
}

// GET /api/anomaly/latest returns one of these, or {} when there are no scores yet.
export interface LatestAnomaly {
  time?: number
  score?: number
  threshold?: number
  tier?: string
  // The worker writes it with the v prefix, for example v10.
  model?: string
}

// One scored minute from GET /api/anomaly.
export interface AnomalyPoint {
  time: number
  score: number | null
  threshold: number | null
  is_anomaly: number | null
  tier: string | null
  tier_level: number | null
  signal: string | null
  cpu_rate: number | null
  memory_mb: number | null
  latency_ms: number | null
  recent_deployment: number | boolean | null
  model: string | null
  // Trend warning (worker): 1 when a signal is rising steadily towards its warning level. Absent on older points.
  early_warning?: number | null
  ew_signal?: string | null
  ew_minutes?: number | null
  // Fitted rise per minute of the warned signal (cpu_rate, memory in MB, latency in ms) and the fit's R squared.
  ew_slope?: number | null
  ew_r2?: number | null
  // 1 for minutes scored during the warm-up after a restart; those are never flagged.
  warmup?: number | null
}

export type IncidentStatus = 'open' | 'closed' | 'awaiting_explanation'

// One incident from GET /api/incidents, newest first.
export interface Incident {
  start: number
  end: number
  status: IncidentStatus
  // The job tag the explainer stored with the incident; null when the row has none.
  job: string | null
  tier: string | null
  action: string | null
  signal: string | null
  peakScore: number | null
  minutes: number
  deployment: boolean
  source: string | null
  explanation: string | null
}

// One server from GET /api/nodes. Null means Prometheus returned no value.
export interface NodeInfo {
  key: string
  // Fixed card title (fyp-main, staging); hostname is the real one from node_uname_info.
  displayName: string
  hostname: string | null
  role: string
  provider: string
  location: string
  up: boolean | null
  memoryTotalBytes: number | null
  memoryAvailableBytes: number | null
  diskSizeBytes: number | null
  diskAvailableBytes: number | null
  cpuCount: number | null
  // Share of CPU time not idle over the last 5 minutes, 0 to 1.
  cpuBusy: number | null
  containers: number | null
}

// GET /api/services: the main server's running containers and the names expected to run there.
export interface ServicesInfo {
  expected: { name: string, role: string }[]
  containers: { name: string, memoryBytes: number | null }[]
  // True when cAdvisor named no container at all, so it is not known which services run.
  unknown: boolean
}

// One item from GET /api/activity, newest first.
export type ActivityItem =
  | { type: 'incident', time: number, tier: string | null, signal: string | null, action: string | null, minutes: number, peakScore: number | null }
  | { type: 'deployment', time: number, commit: string | null, runId: string | null, branch: string | null }
  | { type: 'retrain', time: number, promoted: boolean, newVersion: string | null, championVersion: string | null, championF1: number | null, challengerF1: number | null }

// One restart from GET /api/remediation, newest first. The n8n workflow records only restarts
// that ran; mode is "auto" or "approved". service_up is 1 when monitoring showed the service up
// 60 seconds after the restart.
export interface RemediationRow {
  time: number
  // restart (workflow 5b) or rollback (workflow 5c)
  action: string
  mode: string | null
  // success, failed, expired, rejected or skipped_*; null only if nothing was logged
  outcome: string | null
  signal: string | null
  minutes: number | null
  service_up: number | null
  // The open incident the restart most likely answered, or null.
  incident: { start: number, tier: string | null, peak_score: number | null } | null
}

// One model registry version from GET /api/model. testF1 is the test_f1 tag the worker sets on
// promotion; versions registered by the training script do not have it.
export interface ModelVersionInfo {
  version: string
  createdAt: number | null
  testF1: number | null
  runId: string | null
  aliases: string[]
}

// GET /api/model. Registry fields are null when MLflow did not answer; thresholds and lastRetrain
// are null when InfluxDB did not answer.
export interface ModelInfo {
  champion: ModelVersionInfo | null
  previous: ModelVersionInfo | null
  versions: ModelVersionInfo[] | null
  // The last decision threshold seen in anomaly_score for each model tag (v10 is version "10").
  thresholds: { model: string, version: string, threshold: number | null, lastSeen: number | null }[] | null
  // The newest model_retrain row with every field it has (see worker/worker.py retrain()).
  lastRetrain: Record<string, string | number | null> | null
  rules: {
    promoteMargin: number
    minTestAnomalies: number
    minTestInjections: number
    minInjectionDetection: number
    minRecall: number
    retrainHourUtc: number
  }
  mlflowOk: boolean
  influxOk: boolean
}

// GET /api/resources?node=main|old&hours=1|6|24|72|168: node resources of one server from
// Prometheus. Null means Prometheus returned no value for that metric.
export type ResourceSeries = [number, number | null][]
export interface ResourcesInfo {
  key: string
  displayName: string
  hostname: string | null
  role: string
  provider: string
  location: string
  hours: number
  stepSeconds: number
  // The history window in ms.
  start: number
  end: number
  // Both servers, for the status dots on the node switch. up is null when Prometheus has no value.
  nodes: { key: string, displayName: string, up: boolean | null }[]
  // Shares from 0 to 1, except pressure, which is percent of the last minute spent waiting.
  // swapUsed is null when the server reports no swap.
  now: {
    cpuBusy: number | null
    loadPerCore: number | null
    memoryUsed: number | null
    swapUsed: number | null
    diskUsed: number | null
    pressure: { cpu: number | null, memory: number | null, io: number | null }
  }
  facts: {
    cores: number | null
    memoryTotalBytes: number | null
    swapTotalBytes: number | null
    rootSizeBytes: number | null
    uptimeSeconds: number | null
    containers: number | null
  }
  // cpu and memory in percent, network and disk in bytes per second.
  history: Record<'cpu' | 'memory' | 'networkIn' | 'networkOut' | 'diskRead' | 'diskWrite', ResourceSeries>
}

// GET /api/resources/containers?node=main|old: containers of one server from cAdvisor. Null means
// Prometheus returned no value. limitBytes is null for a container without a memory limit. Each
// container has one cell per 15 minutes for the last 24 hours, oldest first; t is the end of the cell.
export type ContainerCellState = 'up' | 'restarted' | 'over70' | 'nodata'
export interface ContainerRow {
  name: string
  // Percent of one core.
  cpuPct: number | null
  memBytes: number | null
  limitBytes: number | null
  restarts24h: number | null
  cells: { t: number, state: ContainerCellState }[]
}
export interface ContainersInfo {
  node: string
  displayName: string
  // Whole-node memory for the "Where the memory goes" header.
  memTotalBytes: number | null
  memUsedBytes: number | null
  stepSeconds: number
  start: number
  end: number
  containers: ContainerRow[]
}

// Zoom window of a chart in percent of its loaded window, 0 to 100.
export interface ZoomWindow { start: number, end: number }

// GET /api/status: the current state of the service as the worker and the explainer see it.
export type StatusInfo =
  | { state: 'normal', time: number }
  // An early warning on the latest minute.
  | { state: 'watching', time: number, signal: string | null, minutes: number | null }
  | { state: 'incident', tier: string | null, job: string | null, start: number, peakScore: number | null }
  // Warm-up after a restart; step and of are present only when known, for example 2 of 3.
  | { state: 'recovering', time: number, step?: number, of?: number }
  // The latest scored minute is older than 5 minutes, or there is no data.
  | { state: 'stale', time: number | null }

export type EventKind = 'deploy' | 'retrain' | 'early_warning' | 'incident' | 'action'

// One marker from GET /api/events. Any detail field may be null.
export interface EventItem {
  time: number
  kind: EventKind
  label: string
  detail: {
    // deploy
    commit?: string | null
    shortCommit?: string | null
    branch?: string | null
    runId?: string | null
    // retrain
    promoted?: boolean | null
    newVersion?: string | null
    championVersion?: string | null
    // early_warning
    signal?: string | null
    minutes?: number | null
    // incident
    tier?: string | null
    peakScore?: number | null
    job?: string | null
    // action
    action?: string | null
    mode?: string | null
    outcome?: string | null
    family?: 'worked' | 'failed' | 'not_run' | null
  }
}

// GET /api/events?hours=N. unavailable names the sources that could not be read, for example
// "deployments" or "retraining". truncated is true when the server dropped the oldest incidents
// and actions to stay under its 2000-event cap.
export interface EventsResponse {
  events: EventItem[]
  unavailable: string[]
  truncated?: boolean
}

// The visible time range of a chart and the pixel insets of its plot area from the left and
// right edges of the chart container. The event lane under a chart uses it to place markers.
export interface ChartWindow {
  start: number
  end: number
  left: number
  right: number
}

// How a timeline step is drawn. warn is the early warning, flag a flagged minute or the opened
// incident (coloured by tier), worked and failed are actions that ran (failed is the only red),
// not_run is an action that did not run (grey, dashed), warmup is the hatch, info is the rest.
export type TimelineFamily = 'warn' | 'flag' | 'worked' | 'failed' | 'not_run' | 'warmup' | 'info'

// The kinds of step the server builds (dashboard/server/timeline.js).
export type TimelineKind = 'early_warning' | 'first_flag' | 'incident_open' | 'action' | 'warmup' | 'incident_closed' | 'explanation' | 'rollback_not_run'

// One step of GET /api/incidents/timeline. time is null for a step with no stored time (the
// explanation and the rollback that did not run); those come last.
export interface TimelineStep {
  time: number | null
  kind: TimelineKind
  title: string
  detail: string
  // The stored measurement the step came from, or "rule".
  source: string
  family: TimelineFamily
}

// GET /api/incidents/timeline?start=<ms>&job=<job>: the minutes around one incident and its steps.
export interface IncidentTimeline {
  start: number
  job: string
  from: number
  to: number
  tier: string | null
  minutes: number
  deployment: boolean
  points: AnomalyPoint[]
  steps: TimelineStep[]
}

// GET /api/evaluation: a saved detection report (scripts/detection_report.py --save). Rates are
// fractions from 0 to 1, not percent. A field the report could not compute is null.
export interface EvaluationRun {
  run_id: string
  // Time of the run in ms.
  time: number | null
  // The scored period, ISO text in UTC.
  since: string | null
  until: string | null
  scored_minutes: number | null
  injections: number | null
  detected: number | null
  detection_rate: number | null
  flagged_minutes: number | null
  normal_minutes: number | null
  false_alarms: number | null
  false_alarm_rate: number | null
  top_normal_score: number | null
  p99_normal_score: number | null
  threshold: number | null
  // Threshold minus the highest normal score.
  margin: number | null
  ramp_injections: number | null
  warned_before_flag: number | null
  lead_median_min: number | null
  lead_max_min: number | null
  false_ew_minutes: number | null
  excluded: number | null
  model: string | null
}

export interface EvaluationFault {
  fault: string | null
  injections: number | null
  detected: number | null
  detection_rate: number | null
  median_peak_score: number | null
  missed: number | null
  missed_example: string | null
}

export interface EvaluationDay {
  // The UTC day, for example 2026-11-10.
  day: string | null
  time: number | null
  scored_minutes: number | null
  normal_minutes: number | null
  false_alarms: number | null
  false_alarm_rate: number | null
  flagged_minutes: number | null
  injections: number | null
}

export interface EvaluationRunSummary {
  run_id: string
  since: string | null
  until: string | null
  injections: number | null
}

export interface Evaluation {
  run_id: string
  run: EvaluationRun
  runs: EvaluationRunSummary[]
  faults: EvaluationFault[]
  days: EvaluationDay[]
  // Median time from the start of a Medium or High incident to the action that brought the service
  // back, for the run's period (Chapter 3, E3). approved and automatic count how the counted actions
  // ran; an approved one includes the wait for an answer on Telegram. null when it could not be read.
  mttr: { median_minutes: number | null, median_seconds: number | null, count: number, approved: number, automatic: number } | null
  // Restarts and rollbacks in the run's period that ran, and how many brought the service back
  // (Chapter 3, E5). null when the data could not be read.
  remediation: { ran: number, worked: number } | null
  // Counts over everything stored, for the objectives table. null when they could not be read.
  evidence: { ci_deployments: number, explanations: number, actions: { ran: number, restart_worked: number, rollback_worked: number } } | null
}

// GET /api/drift?days=7|14|30|60 (dashboard/server/drift.js). Times are ms. Rates are fractions from 0 to 1.
export interface DriftDay {
  // Start of the UTC day.
  day: number
  // The run of detection_report.py --save the day came from, or null when it has no readable run time.
  run: number | null
  // False alarms over normal minutes, or null when the day had no normal minutes.
  rate: number | null
  false_alarms: number | null
  normal_minutes: number | null
  scored_minutes: number | null
  flagged_minutes: number | null
  injections: number | null
}

// An accepted detection reference of the worker (measurement reference_level), written every 30 minutes.
export interface DriftReference {
  time: number
  memory_median: number | null
  memory_p99: number | null
  cpu_median: number | null
  cpu_p99: number | null
  latency_median: number | null
  latency_p99: number | null
  // Signals whose new reference the worker's guard refused (for example latency_ms).
  rejected: string[]
}

export interface DriftPromotion {
  time: number
  old_version: string | null
  new_version: string | null
  // Test F1 of the old champion and of the new model on the same test minutes.
  old_f1: number | null
  new_f1: number | null
}

// A run of consecutive days above the false alarm threshold. end is the end of the last day.
export interface DriftEpisode {
  start: number
  end: number
  days: number
  peak_rate: number
  false_alarms: number
}

export interface DriftResponse {
  days: DriftDay[]
  reference: DriftReference[]
  latest_reference: DriftReference | null
  promotions: DriftPromotion[]
  episodes: DriftEpisode[]
  // The false alarm rate above which a day counts toward an episode.
  episode_rate: number
  // Start of the first requested day and end of the last, in ms.
  from: number
  to: number
}

// Server and project registry (Settings). GET /api/servers lists the active servers for every
// signed-in user; the views use it instead of fixed names. The keys main and old stay valid.
export interface ServerBrief {
  key: string
  name: string
  role: string
  location: string
}

export type ServerStatus = 'pending' | 'active' | 'archived'

// GET /api/settings/servers (admin only). nodeUp and cadvisorUp are null when Prometheus failed.
export interface SettingsServer {
  key: string
  name: string
  role: string
  location: string
  address: string | null
  builtin: boolean
  status: ServerStatus
  nodeUp: boolean | null
  cadvisorUp: boolean | null
  lastSeen: number | string | null
}

// GET /api/settings/servers/:key/check. error is words, for example "Not added to Prometheus yet".
export interface ExporterCheck {
  up: boolean
  lastScrape: number | string | null
  error: string | null
}
export interface ServerCheck {
  node: ExporterCheck
  cadvisor: ExporterCheck
}

// GET /api/settings/servers/:key/containers. reason says why a container cannot be picked, for
// example "Used by the platform" or "Already in sample-service".
export interface PickableContainer {
  name: string
  available: boolean
  reason: string | null
}

export type DeploySource = 'ci' | 'image'
export type Automation = 'approval' | 'monitored'

// GET /api/settings/projects (admin only). The server sends snake case (server_key, server_name,
// repo_url, deploy_source); toSettingsProject turns it into these names.
export interface SettingsProject {
  key: string
  name: string
  serverKey: string
  // The server's display name. It is also there for an archived server, which /api/servers no longer lists.
  serverName: string
  repoUrl: string | null
  deploySource: DeploySource
  automation: Automation
  // Who rolls the project back: n8n after approval, the project's own pipeline, or nobody.
  rollback: RollbackSetting
  builtin: boolean
  status: 'active' | 'archived'
  containers: string[]
}

export type RollbackSetting = 'n8n' | 'own_pipeline' | 'none'

// GET /api/projects (any signed-in user). One row per active project. A cell of the strip is 15 minutes.
export type ProjectStatus = 'healthy' | 'incident' | 'partial' | 'down' | 'no_data'
export type StripState = 'up' | 'deploy' | 'restart' | 'incident' | 'down' | 'nodata'
export interface ProjectContainer {
  name: string
  up: boolean | null
  restarts24h: number | null
  memBytes: number | null
  limitBytes: number | null
}
// at is a time in milliseconds or ISO text. ref is the commit sha for ci and the image for image.
export interface ProjectDeploy {
  at: number | string
  source: DeploySource
  ref: string
}
// ready is true only for mode n8n when the latest deploy is 15 minutes old or less.
export interface ProjectRollback {
  mode: string
  text: string
  ready?: boolean
}
export interface ProjectRow {
  key: string
  name: string
  server: { key: string, name: string }
  containers: ProjectContainer[]
  status: ProjectStatus
  watchedByModel: boolean
  automation: string
  deploySource: DeploySource
  lastDeploy: ProjectDeploy | null
  rollback: ProjectRollback
  strip: StripState[]
}

// GET /api/deployments?project=<key>&days=7|30|90. latest is the newest run or null.
export interface DeploymentRun {
  at: number | string
  source: DeploySource
  ref: string
  previousRef: string | null
  detail: string | null
  // The GitHub Actions run id (pipeline_run_id) and branch of a ci run, null for image runs. When
  // runId is missing or not all digits the run gets no Actions link. For ci runs previousRef is
  // the previous image.
  runId?: string | null
  branch?: string | null
}
// week is the Monday as YYYY-MM-DD in UTC; empty weeks are included.
export interface DeploymentWeek {
  week: number | string
  count: number
}
export interface DeploymentsResponse {
  project: string
  runs: DeploymentRun[]
  weeks: DeploymentWeek[]
  latest: DeploymentRun | null
  rollback: ProjectRollback
}

// A time that arrives as milliseconds or as ISO text, in milliseconds, or null.
export function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

// GET /api/settings/log?limit=50|200. Newest first. The server sends { id, at (ISO text),
// user_email, action, target, detail }; toSettingsLogRow turns at into milliseconds.
export interface SettingsLogRow {
  id: number
  at: number
  userEmail: string
  action: string
  target: string
  detail: string
}

// The error body of every failed Settings write. field names the form field it belongs to.
export type ErrorField = 'name' | 'role' | 'location' | 'address' | 'repo_url' | 'containers' | 'server_key' | 'rollback'
export interface ApiErrorInfo {
  message: string
  field: ErrorField | null
}

const FIELDS: readonly string[] = ['name', 'role', 'location', 'address', 'repo_url', 'containers', 'server_key']

// Reads { error, field? } from a failed call. Without a usable body the message says the call did
// not work, so a form never shows a blank error.
export function apiError(err: unknown, fallback = 'That did not work. Try again.'): ApiErrorInfo {
  const body = (err as { response?: { data?: { error?: unknown, field?: unknown } } })?.response?.data
  const message = typeof body?.error === 'string' && body.error ? body.error : fallback
  const field = typeof body?.field === 'string' && FIELDS.includes(body.field) ? (body.field as ErrorField) : null
  return { message, field }
}

// The Settings answers are read defensively: a field that is missing or of another type gets a
// plain default, so one odd row never breaks the table. Snake case names are accepted too.
type Raw = Record<string, unknown>
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const when = (v: unknown): number | string | null => (typeof v === 'number' || typeof v === 'string' ? v : null)
const pick = (r: Raw, ...names: string[]): unknown => names.map(n => r[n]).find(v => v !== undefined)

export function toSettingsServer(v: unknown): SettingsServer {
  const r = (v ?? {}) as Raw
  const status = str(r.status)
  return {
    key: str(r.key),
    name: str(r.name, str(r.key)),
    role: str(r.role),
    location: str(r.location),
    address: strOrNull(r.address),
    builtin: r.builtin === true,
    status: status === 'pending' || status === 'archived' ? status : 'active',
    nodeUp: boolOrNull(pick(r, 'nodeUp', 'node_up')),
    cadvisorUp: boolOrNull(pick(r, 'cadvisorUp', 'cadvisor_up')),
    lastSeen: when(pick(r, 'lastSeen', 'last_seen')),
  }
}

function toExporterCheck(v: unknown): ExporterCheck {
  const r = (v ?? {}) as Raw
  return { up: r.up === true, lastScrape: when(pick(r, 'lastScrape', 'last_scrape')), error: strOrNull(r.error) }
}

export function toServerCheck(v: unknown): ServerCheck {
  const r = (v ?? {}) as Raw
  return { node: toExporterCheck(r.node), cadvisor: toExporterCheck(r.cadvisor) }
}

export function toPickableContainer(v: unknown): PickableContainer {
  const r = (v ?? {}) as Raw
  const available = r.available !== false && !pick(r, 'reason', 'why')
  return { name: str(pick(r, 'name', 'container_name', 'containerName')), available, reason: strOrNull(pick(r, 'reason', 'why')) }
}

export function toSettingsProject(v: unknown): SettingsProject {
  const r = (v ?? {}) as Raw
  const containers = pick(r, 'containers', 'container_names')
  const source = str(pick(r, 'deploySource', 'deploy_source'))
  const automation = str(r.automation)
  const rollback = str(r.rollback)
  return {
    key: str(r.key),
    name: str(r.name, str(r.key)),
    serverKey: str(pick(r, 'server_key', 'serverKey')),
    serverName: str(pick(r, 'server_name', 'serverName'), str(pick(r, 'server_key', 'serverKey'))),
    repoUrl: strOrNull(pick(r, 'repo_url', 'repoUrl')),
    deploySource: source === 'ci' ? 'ci' : 'image',
    automation: automation === 'approval' ? 'approval' : 'monitored',
    // An answer without the field is read as the server's default: n8n for the project with
    // approval, otherwise no rollback (never a pipeline the server did not report).
    rollback: rollback === 'n8n' || rollback === 'own_pipeline' || rollback === 'none' ? rollback : automation === 'approval' ? 'n8n' : 'none',
    builtin: r.builtin === true,
    status: r.status === 'archived' ? 'archived' : 'active',
    containers: Array.isArray(containers)
      ? containers.map(c => (typeof c === 'string' ? c : str((c as Raw)?.container_name ?? (c as Raw)?.name))).filter(Boolean)
      : [],
  }
}

export function toSettingsLogRow(v: unknown): SettingsLogRow {
  const r = (v ?? {}) as Raw
  const at = pick(r, 'at', 'time')
  return {
    id: typeof r.id === 'number' ? r.id : Number(r.id) || 0,
    at: typeof at === 'number' ? at : Date.parse(str(at)) || 0,
    userEmail: str(pick(r, 'userEmail', 'user_email', 'user')),
    action: str(r.action),
    target: str(r.target),
    detail: str(r.detail),
  }
}

// GET /api/llm?days=1|7|30 (dashboard/server/llm.js), read from the call log in PostgreSQL. Times are ms,
// durations in ms unless the name says _s. A rate is a fraction from 0 to 1, or null when there is nothing to
// divide. No prompt, answer or user id is part of it.
export interface LlmExplanationDay {
  // Start of the UTC day.
  day: number
  count: number
  llm: number
  template: number
  firstTry: number
  medianMs: number | null
  p95Ms: number | null
}

export interface LlmChatDay {
  day: number
  replies: number
  llm: number
  fallback: number
  checked: number
  passed: number
  checkRate: number | null
  medianReplyS: number | null
  medianTokS: number | null
}

export interface LlmModelCount { model: string | null, count: number }

export interface LlmRecentCall {
  time: number | null
  trace: 'explanation' | 'chat'
  model: string | null
  latencyMs: number | null
  tokens: number | null
  // llm or template for an explanation.
  source: string | null
  // llm or fallback for a chat reply.
  kind: string | null
  attempts: number | null
  // Chat calls only: whether the answer passed the fact check.
  checkPassed: boolean | null
  // Why the explanation was rejected (last attempt), when it was.
  rejected: string | null
}

export interface LlmResponse {
  days: number
  // Start of the first UTC day and end of the last, in ms.
  from: number
  to: number
  explanations: {
    total: number
    llm: number
    template: number
    firstTry: number
    firstTryRate: number | null
    templateRate: number | null
    medianMs: number | null
    p95Ms: number | null
    medianTokens: number | null
    attempts: { attempts: number, count: number }[]
    rejections: { reason: string, count: number }[]
    models: LlmModelCount[]
    daily: LlmExplanationDay[]
  }
  chat: {
    replies: number
    llm: number
    fallback: number
    checked: number
    passed: number
    checkRate: number | null
    medianReplyS: number | null
    medianTokS: number | null
    kinds: { kind: string, count: number }[]
    models: LlmModelCount[]
    daily: LlmChatDay[]
  }
  recent: LlmRecentCall[]
}
