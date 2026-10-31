import type { Incident, IncidentStatus } from '@/types'

export const STATUS_STYLE: Record<IncidentStatus, { label: string }> = {
  open: { label: 'Open' },
  closed: { label: 'Closed' },
  awaiting_explanation: { label: 'Awaiting explanation' },
}

// The incident that covers a minute: from its start up to one minute after its end.
export function incidentAt(incidents: Incident[], time: number): Incident | null {
  return incidents.find(i => time >= i.start && time <= i.end + 60000) ?? null
}

export function explanationFallback(incident: Incident): string {
  if (incident.status === 'open') return 'The explanation is written after the incident closes.'
  if (incident.status === 'awaiting_explanation') return 'The incident has ended. Waiting for the explanation.'
  return 'No explanation was recorded.'
}
