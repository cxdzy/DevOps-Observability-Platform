import type { ContainerForecast } from '@/composables/useApi'
import type { ProjectRow, ProjectStatus } from '@/types'

// Rows for the Projects section of the Overview page. The server returns active projects only
// (dashboard/server/projects.js), so every row received here is shown and none is added.

export const EMPTY_TEXT = 'No projects yet. Add one in Settings.'
export const ERROR_TEXT = 'The projects could not be loaded. Retrying in 30 s.'

// Same wording as the Projects page.
const STATUS_TEXT: Record<string, string> = {
  healthy: 'Healthy',
  incident: 'Incident',
  partial: 'Partly down',
  down: 'Down',
  no_data: 'No data',
}

function statusText(s: string): string {
  return STATUS_TEXT[s] ?? 'No data'
}

export function modelLabel(p: Pick<ProjectRow, 'watchedByModel' | 'automation'>): 'Model and automation' | 'Monitored only' {
  return p.watchedByModel === true && p.automation !== 'monitored' ? 'Model and automation' : 'Monitored only'
}

// Most urgent first. A state that is not listed ranks last.
const STATE_ORDER = ['restarting', 'warning', 'no_limit', 'not_enough_data', 'ok', 'no_data']

// One forecast for the compact row: the most urgent one among the containers of the project.
// The first entry in the list wins a tie. Null when the project has no forecast entry.
export function pickForecast(
  p: Pick<ProjectRow, 'key' | 'containers'>,
  forecasts: ContainerForecast[] | null | undefined,
): ContainerForecast | null {
  if (!Array.isArray(forecasts)) return null
  const names = new Set((p.containers ?? []).map(c => c.name))
  let best: ContainerForecast | null = null
  let bestRank = Infinity
  for (const f of forecasts) {
    if (f.project !== p.key || !names.has(f.container)) continue
    const idx = STATE_ORDER.indexOf(f.state)
    const rank = idx === -1 ? STATE_ORDER.length : idx
    if (rank < bestRank) {
      best = f
      bestRank = rank
    }
  }
  return best
}

export interface OverviewRow {
  key: string
  name: string
  server: string
  status: ProjectStatus
  statusText: string
  modelLabel: 'Model and automation' | 'Monitored only'
  forecast: ContainerForecast | null
  href: string
}

export function overviewRows(projects: ProjectRow[], forecasts: ContainerForecast[] | null | undefined): OverviewRow[] {
  return projects.map(p => ({
    key: p.key,
    name: p.name,
    server: p.server?.name ?? 'No data',
    status: p.status,
    statusText: statusText(p.status),
    modelLabel: modelLabel(p),
    forecast: pickForecast(p, forecasts),
    href: `#projects?project=${encodeURIComponent(p.key)}`,
  }))
}
