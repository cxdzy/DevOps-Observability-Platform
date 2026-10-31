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
