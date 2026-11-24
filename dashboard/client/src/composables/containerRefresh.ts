import type { PickableContainer } from '@/types'

// What the Add project form shows for the containers of the chosen server.
export interface ContainerList {
  containers: PickableContainer[]
  picked: string[]
}

export interface RefreshOutcome extends ContainerList {
  // Ticked containers that are no longer on the server.
  gone: string[]
  // Ticked containers that are still there but can no longer be picked (for example now in a project).
  blocked: string[]
  // False when the list could not be read; the old list is then kept as it was.
  ok: boolean
}

// Applies a refreshed container list. next is the new list, or null when reading it failed.
// The typed name and the chosen server are not part of this, so a refresh never touches them.
export function applyRefresh(prev: ContainerList, next: PickableContainer[] | null): RefreshOutcome {
  if (!next) return { containers: prev.containers, picked: prev.picked, gone: [], blocked: [], ok: false }
  const byName = new Map(next.map(c => [c.name, c]))
  const picked: string[] = []
  const gone: string[] = []
  const blocked: string[] = []
  for (const name of prev.picked) {
    const c = byName.get(name)
    if (!c) gone.push(name)
    else if (!c.available) blocked.push(name)
    else picked.push(name)
  }
  return { containers: next, picked, gone, blocked, ok: true }
}

// One sentence for the containers that were unticked, or '' when none were.
export function untickedText(gone: string[], blocked: string[]): string {
  const parts: string[] = []
  if (gone.length) parts.push(`${gone.join(', ')} ${gone.length > 1 ? 'are' : 'is'} no longer on the server`)
  if (blocked.length) parts.push(`${blocked.join(', ')} can no longer be picked`)
  return parts.length ? `Unticked because ${parts.join(' and ')}.` : ''
}
