// Pure helpers for the Recent activity list on the Overview page. Runs with the Node test runner
// (types stripped), so this file only uses type imports from the app.
import type { ActivityItem, DeploymentRun, ProjectRow } from '@/types'

export type ActivityKind = 'incident' | 'deployment' | 'retrain' | 'detected'

export type ActivityRow = {
  key: string
  // Milliseconds since the epoch.
  time: number
  // Project name, or 'platform' for model retraining.
  project: string
  projectKey: string | null
  kind: ActivityKind
  item: ActivityItem | DeploymentRun
  title: string
  detail: string
  // Set for incident rows so the chip can show the tier.
  tier: string | null
}

export type FilterOption = { value: string, label: string }

export const MODEL_PROJECT_KEY = 'sample-service'
export const PLATFORM_NAME = 'platform'
export const EMPTY_ALL_TEXT = 'No activity in the last 7 days'

const SIGNAL_LABEL: Record<string, string> = { cpu: 'CPU spike', memory: 'Memory rise', latency: 'Latency spike' }
const ACTION_LABEL: Record<string, string> = { notify: 'notify only', restart: 'restart', rollback: 'rollback' }

// A time that arrives as milliseconds or as ISO text, in milliseconds, or null.
function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

function fixed(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || Number.isNaN(value) ? '-' : value.toFixed(digits)
}

// The tag or digest part of an image reference, cut to 12 characters.
export function shortRef(ref: string): string {
  const tail = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref
  return (tail || ref).slice(0, 12)
}

type IncidentItem = Extract<ActivityItem, { type: 'incident' }>
type DeploymentItem = Extract<ActivityItem, { type: 'deployment' }>
type RetrainItem = Extract<ActivityItem, { type: 'retrain' }>

function incidentTitle(item: IncidentItem): string {
  return (item.signal && SIGNAL_LABEL[item.signal]) || `Incident, ${item.signal || '-'}`
}

function incidentDetail(item: IncidentItem): string {
  const action = item.action ? (ACTION_LABEL[item.action] ?? item.action) : 'no action'
  return `${item.minutes} min, peak ${fixed(item.peakScore)}, ${action}`
}

function deploymentDetail(item: DeploymentItem): string {
  const commit = item.commit ? `commit ${item.commit.slice(0, 7)}` : 'commit unknown'
  return `${commit}, CI${item.branch ? ` on ${item.branch}` : ''}`
}

function retrainDetail(item: RetrainItem): string {
  const f1 = item.promoted ? item.challengerF1 : item.championF1
  const score = f1 === null ? '' : ` (F1 ${fixed(f1, 4)})`
  if (item.promoted) return `promoted ${item.newVersion ? `version ${item.newVersion}` : 'a new version'}${score}`
  return `kept ${item.championVersion ? `version ${item.championVersion}` : 'the champion'}${score}`
}

// All rows newest first. Incident and deployment items come from the model's project
// (sample-service), retrain items belong to the platform, and projects that deploy by image
// add one "detected" row per run found in runsByProject.
export function buildActivityRows(
  items: ActivityItem[],
  projects: ProjectRow[],
  runsByProject: Record<string, DeploymentRun[]>,
): ActivityRow[] {
  const model = projects.find(p => p.key === MODEL_PROJECT_KEY)
  const modelName = model ? model.name : MODEL_PROJECT_KEY
  const rows: Omit<ActivityRow, 'key'>[] = []

  for (const item of items) {
    const time = toMs(item.time)
    if (time === null) continue
    if (item.type === 'incident') {
      rows.push({ time, project: modelName, projectKey: MODEL_PROJECT_KEY, kind: 'incident', item, title: incidentTitle(item), detail: incidentDetail(item), tier: item.tier })
    } else if (item.type === 'deployment') {
      rows.push({ time, project: modelName, projectKey: MODEL_PROJECT_KEY, kind: 'deployment', item, title: `${modelName} deployed`, detail: deploymentDetail(item), tier: null })
    } else {
      rows.push({ time, project: PLATFORM_NAME, projectKey: null, kind: 'retrain', item, title: 'Model retraining', detail: retrainDetail(item), tier: null })
    }
  }

  for (const project of projects) {
    if (project.deploySource !== 'image') continue
    for (const run of runsByProject[project.key] ?? []) {
      const time = toMs(run.at)
      if (time === null) continue
      rows.push({ time, project: project.name, projectKey: project.key, kind: 'detected', item: run, title: `${project.name} deployed`, detail: `image ${shortRef(run.ref)}, detected`, tier: null })
    }
  }

  rows.sort((a, b) => b.time - a.time)
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const base = `${row.kind}-${row.projectKey ?? PLATFORM_NAME}-${row.time}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { ...row, key: n === 0 ? base : `${base}-${n}` }
  })
}

// 'all' returns every row. A project key returns that project's rows. Retrain rows have no
// project key, so they only show under All.
export function filterRows(rows: ActivityRow[], filter: string): ActivityRow[] {
  return filter === 'all' ? rows : rows.filter(r => r.projectKey === filter)
}

// Restarts in the last 24 hours across the project's containers. Unknown counts are ignored.
export function restartsLast24h(project: Pick<ProjectRow, 'containers'>): number {
  return project.containers.reduce((sum, c) => sum + (c.restarts24h ?? 0), 0)
}

export function emptyText(project: { name: string } | null | undefined, restarts: number): string {
  if (!project) return EMPTY_ALL_TEXT
  if (restarts > 0) return `${project.name}: no deploys in the last 7 days, restarts in the last 24 hours: ${restarts}`
  return `${project.name}: no deploys or restarts in the last 7 days`
}

export function filterOptions(projects: Pick<ProjectRow, 'key' | 'name'>[]): FilterOption[] {
  return [{ value: 'all', label: 'All' }, ...projects.map(p => ({ value: p.key, label: p.name }))]
}
