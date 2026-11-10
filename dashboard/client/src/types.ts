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
}

export type IncidentStatus = 'open' | 'closed' | 'awaiting_explanation'

// One incident from GET /api/incidents, newest first.
export interface Incident {
  start: number
  end: number
  status: IncidentStatus
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
  key: 'main' | 'old'
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
  key: 'main' | 'old'
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
  nodes: { key: 'main' | 'old', displayName: string, up: boolean | null }[]
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
// "deployments" or "retraining".
export interface EventsResponse {
  events: EventItem[]
  unavailable: string[]
}

// The visible time range of a chart and the pixel insets of its plot area from the left and
// right edges of the chart container. The event lane under a chart uses it to place markers.
export interface ChartWindow {
  start: number
  end: number
  left: number
  right: number
}
