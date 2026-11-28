import type { StripState } from '@/types'

// Pure parts of the 24 hour project strip. They match the strip on the Projects page.
// Each cell takes 4 units of the strip and is drawn 3 units wide.

export const CELL_NAME: Record<StripState, string> = {
  up: 'up',
  deploy: 'deploy',
  restart: 'restart',
  incident: 'incident',
  down: 'down',
  nodata: 'no data',
}
export const CELL_FILL: Record<StripState, string> = {
  up: 'fill-stripup',
  deploy: 'fill-primary',
  restart: 'fill-primary',
  incident: 'fill-amber',
  down: 'fill-red',
  nodata: 'fill-track',
}
export const CELL_HEIGHT: Record<StripState, number> = { up: 12, deploy: 14, restart: 8, incident: 14, down: 14, nodata: 4 }

export const MIN_CELL_PX = 3
export const MERGES = [1, 2, 4] as const
export type Merge = typeof MERGES[number]
export const MERGE_LABEL: Record<Merge, string> = { 1: '15 minutes', 2: '30 minutes', 4: '1 hour' }
// A merged cell shows its most important state.
export const RANK: StripState[] = ['down', 'incident', 'deploy', 'restart', 'up', 'nodata']

// An unknown state is drawn as no data.
export function cell(state: StripState): StripState {
  return state in CELL_NAME ? state : 'nodata'
}
export function cellY(state: StripState): number {
  return (14 - CELL_HEIGHT[cell(state)]) / 2
}

// Until the strip is measured the full 96 cells are drawn.
export function pickMerge(widthPx: number | null | undefined): Merge {
  if (!widthPx) return 1
  return MERGES.find(m => (widthPx / (96 / m)) * 0.75 >= MIN_CELL_PX) ?? 4
}

export function mergeStrip(strip: StripState[], merge: Merge): StripState[] {
  if (merge === 1) return strip
  const out: StripState[] = []
  for (let i = 0; i < strip.length; i += merge) {
    const group = strip.slice(i, i + merge).map(cell)
    out.push(RANK.find(s => group.includes(s)) ?? 'nodata')
  }
  return out
}

export function stripLabel(name: string, cells: StripState[], merge: Merge): string {
  const parts: string[] = []
  for (const s of ['incident', 'down', 'deploy', 'restart', 'nodata'] as const) {
    const n = cells.filter(c => c === s).length
    if (n) parts.push(`${n} ${CELL_NAME[s]} ${n === 1 ? 'period' : 'periods'}`)
  }
  return `${name}, last 24 hours in cells of ${MERGE_LABEL[merge]}: ${parts.length ? parts.join(', ') : 'up the whole time'}`
}
