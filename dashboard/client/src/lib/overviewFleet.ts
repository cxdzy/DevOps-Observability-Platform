import type { ContainerForecast } from '@/composables/useApi'
import type { Incident, LatestAnomaly, NodeInfo, ProjectRow, ProjectStatus, ServicesInfo } from '@/types'
import { modelLabel, pickForecast } from './overviewProjects.ts'

// View models for the fleet level parts of the Overview page. Pure functions: times stay raw and
// the components format them. Only the project with a model (key sample-service) has a score and
// incidents. The server returns active projects only, so every row received is mapped.

export const MODEL_PROJECT_KEY = 'sample-service'

function join(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function modelProjectNames(projects: ProjectRow[]): string[] {
  return projects.filter(p => p.watchedByModel === true).map(p => p.name)
}

export function fleetSubtitle(projects: ProjectRow[], serverCount: number): string {
  const head = `${plural(projects.length, 'project', 'projects')} on ${plural(serverCount, 'server', 'servers')}.`
  const names = modelProjectNames(projects)
  if (names.length === 0) return `${head} No project has a model yet.`
  return `${head} Only ${join(names)} ${names.length === 1 ? 'has' : 'have'} a model and automatic actions.`
}

export interface StatusCard {
  chip: 'Normal' | 'Incident' | 'Attention' | 'Unknown'
  ok: boolean | null
  title: string
  line: string
}

// projectsKnown says the project list loaded, so an empty list is a real empty fleet.
// missingServices counts expected platform services that are not running.
export function statusCard(args: { projects: ProjectRow[], nodes: NodeInfo[], openIncident: boolean, incidentsKnown: boolean, projectsKnown?: boolean, missingServices?: number }): StatusCard {
  const { projects, nodes, openIncident, incidentsKnown } = args
  const projectsKnown = args.projectsKnown ?? projects.length > 0
  const missing = args.missingServices ?? 0
  const healthy = projects.filter(p => p.status === 'healthy').length
  const online = nodes.filter(n => n.up === true).length
  const known = projectsKnown && nodes.length > 0 && nodes.every(n => n.up !== null)
  const incidentText = openIncident ? 'an incident is open' : incidentsKnown ? 'no incident open' : 'incidents unknown'
  const missingText = missing > 0 ? `, ${plural(missing, 'platform service', 'platform services')} missing` : ''
  const line = `${healthy} of ${plural(projects.length, 'project', 'projects')} healthy, ${online} of ${plural(nodes.length, 'server', 'servers')} online${missingText}, ${incidentText}`
  if (openIncident) return { chip: 'Incident', ok: false, title: 'Incident', line }
  if (!known) return { chip: 'Unknown', ok: null, title: 'Status unknown', line }
  if (healthy !== projects.length || online !== nodes.length || missing > 0) return { chip: 'Attention', ok: false, title: 'Needs attention', line }
  if (!incidentsKnown) return { chip: 'Unknown', ok: null, title: 'Status unknown', line }
  return { chip: 'Normal', ok: true, title: 'All normal', line }
}

export function projectsCard(projects: ProjectRow[], isAdmin: boolean): { count: number, line: string, addHint: string | null } {
  const watched = projects.filter(p => p.watchedByModel === true).length
  return {
    count: projects.length,
    line: `${watched} watched by a model, ${projects.length - watched} monitored only`,
    addHint: isAdmin ? 'Add a project in Settings' : null,
  }
}

// Used when the project list did not load, so the model project is not known by name.
export const INCIDENTS_NOTE_GENERIC = 'From the anomaly model. Monitored-only projects have no incidents.'

export function incidentsNote(projects: ProjectRow[]): string {
  const names = modelProjectNames(projects)
  const from = names.length ? `From the model on ${join(names)}. ` : ''
  return `${from}Monitored-only projects have no incidents.`
}

export function containersCard(nodes: NodeInfo[], services: ServicesInfo | null | undefined): { total: number | null, lines: string[] } {
  const counted = nodes.filter(n => typeof n.containers === 'number')
  const total = counted.length ? counted.reduce((sum, n) => sum + (n.containers as number), 0) : null
  const expected = services && !services.unknown && Array.isArray(services.expected) ? services.expected.length : null
  // The host count includes every container, so the expected platform services are counted apart.
  const names = new Set(Array.isArray(services?.containers) ? services.containers.map(c => c.name) : [])
  const running = services && !services.unknown && Array.isArray(services.expected)
    ? services.expected.filter(e => names.has(e.name)).length
    : 0
  const lines = counted.map((n) => {
    const base = `${n.containers} on ${n.displayName}`
    return n.key === 'main' && expected !== null ? `${base}, ${running} of ${expected} expected services running` : base
  })
  return { total, lines }
}

const STATUS_RANK: Record<string, number> = { down: 0, incident: 1, partial: 2, no_data: 3, healthy: 4 }
export function sortProjects(projects: ProjectRow[]): ProjectRow[] {
  const rank = (s: string) => STATUS_RANK[s] ?? STATUS_RANK.no_data
  return [...projects].sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------- one project card

const STATUS_TEXT: Record<string, string> = { healthy: 'Healthy', incident: 'Incident', partial: 'Partly down', down: 'Down', no_data: 'No data' }
const ROLLBACK_TITLE: Record<string, string> = {
  n8n: 'Rollback after approval',
  own_pipeline: 'Rollback handled elsewhere',
  none: 'No rollback',
}

// The same size text as the Projects page.
export function size(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'No data'
  const mib = bytes / 1024 ** 2
  if (mib < 1024) return `${mib >= 100 ? mib.toFixed(0) : mib.toFixed(1).replace(/\.0$/, '')} MiB`
  const gib = mib / 1024
  return `${gib >= 100 ? gib.toFixed(0) : gib.toFixed(1).replace(/\.0$/, '')} GiB`
}

export interface ProjectCardData {
  key: string
  name: string
  server: string
  status: ProjectStatus
  statusText: string
  modelLabel: 'Model and automation' | 'Monitored only'
  href: string
  figures: {
    score: { kind: 'value' | 'nodata' | 'notwatched', text: string, sub: string }
    memory: { text: string, percent: number | null, sub: string }
    containers: { text: string, sub: string }
    incidents: { kind: 'value' | 'nodata' | 'none', count: number | null, text: string, sub: string }
  }
  strip: ProjectRow['strip']
  forecast: ContainerForecast | null
  // at is raw (milliseconds or ISO text); the component formats it.
  lastDeploy: { at: number | string, ref: string, chip: 'Verified' | 'Detected' } | null
  lastDeployEmpty: string
  rollback: { title: string, text: string, ready: boolean | null, mode: string }
  links: { incidents: string | null, pipeline: string }
}

export interface CardContext {
  latest: LatestAnomaly | null | undefined
  incidents: Incident[] | null | undefined
  forecasts: ContainerForecast[] | null | undefined
}

export function projectCardData(p: ProjectRow, ctx: CardContext): ProjectCardData {
  const containers = Array.isArray(p.containers) ? p.containers : []
  const isModel = p.key === MODEL_PROJECT_KEY
  const watched = p.watchedByModel === true

  let score: ProjectCardData['figures']['score']
  let incidents: ProjectCardData['figures']['incidents']
  if (!watched) {
    score = { kind: 'notwatched', text: 'Not watched', sub: 'no model for this project' }
    incidents = { kind: 'none', count: null, text: 'None', sub: 'no model, so no incidents' }
  } else if (!isModel) {
    score = { kind: 'nodata', text: 'No data', sub: '' }
    incidents = { kind: 'nodata', count: null, text: 'No data', sub: '' }
  } else {
    const s = ctx.latest?.score
    if (typeof s === 'number' && Number.isFinite(s)) {
      const parts: string[] = []
      if (typeof ctx.latest?.threshold === 'number') parts.push(`threshold ${ctx.latest.threshold.toFixed(3)}`)
      if (ctx.latest?.model) parts.push(`model ${ctx.latest.model}`)
      score = { kind: 'value', text: s.toFixed(3), sub: parts.join(', ') }
    } else {
      score = { kind: 'nodata', text: 'No data', sub: '' }
    }
    if (Array.isArray(ctx.incidents)) {
      const n = ctx.incidents.length
      const open = ctx.incidents.filter(i => i.status === 'open').length
      incidents = { kind: 'value', count: n, text: String(n), sub: open ? `${open} open now` : n === 0 ? 'none in the last 6 h' : 'none open now' }
    } else {
      incidents = { kind: 'nodata', count: null, text: 'No data', sub: '' }
    }
  }

  const mems = containers.map(c => c.memBytes).filter((m): m is number => typeof m === 'number')
  const memTotal = mems.length ? mems.reduce((a, b) => a + b, 0) : null
  const allLimited = containers.length > 0 && containers.every(c => typeof c.limitBytes === 'number' && c.limitBytes > 0)
  const limitTotal = allLimited ? containers.reduce((a, c) => a + (c.limitBytes as number), 0) : null
  const percent = memTotal !== null && limitTotal !== null ? (memTotal / limitTotal) * 100 : null
  const memory = {
    text: memTotal === null ? 'No data' : size(memTotal),
    percent,
    sub: percent !== null ? `${Math.round(percent)}% of ${size(limitTotal)}` : 'no limit set',
  }

  const up = containers.filter(c => c.up === true).length
  const restarts = containers.reduce((a, c) => a + (typeof c.restarts24h === 'number' ? c.restarts24h : 0), 0)
  const key = encodeURIComponent(p.key)
  const rb = p.rollback
  return {
    key: p.key,
    name: p.name,
    server: p.server?.name ?? 'No data',
    status: p.status,
    statusText: STATUS_TEXT[p.status] ?? 'No data',
    modelLabel: modelLabel(p),
    href: `#projects?project=${key}`,
    figures: {
      score,
      memory,
      containers: { text: `${up} of ${containers.length} up`, sub: `restarts 24 h: ${restarts}` },
      incidents,
    },
    strip: Array.isArray(p.strip) ? p.strip : [],
    forecast: pickForecast({ key: p.key, containers }, ctx.forecasts),
    lastDeploy: p.lastDeploy
      ? { at: p.lastDeploy.at, ref: p.lastDeploy.source === 'ci' ? (p.lastDeploy.ref ?? '').slice(0, 7) : (p.lastDeploy.ref ?? ''), chip: p.lastDeploy.source === 'ci' ? 'Verified' : 'Detected' }
      : null,
    lastDeployEmpty: 'none detected yet',
    rollback: { title: ROLLBACK_TITLE[rb?.mode] ?? 'Rollback', text: rb?.text || 'No data', ready: rb?.ready ?? null, mode: rb?.mode ?? '' },
    links: { incidents: watched ? '#incidents' : null, pipeline: `#pipeline?project=${key}` },
  }
}

// The cards in display order: most urgent first.
export function projectCards(projects: ProjectRow[], ctx: CardContext): ProjectCardData[] {
  return sortProjects(projects).map(p => projectCardData(p, ctx))
}
