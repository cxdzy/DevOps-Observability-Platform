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
