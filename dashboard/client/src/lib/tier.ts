// Tier colours and labels, shared by badges and chart markers.
// The label is always shown next to the colour, so colour is never the only cue.

export type Tier = 'none' | 'low' | 'medium' | 'high'

export const FLAG_TIERS = ['low', 'medium', 'high'] as const

interface TierStyle {
  label: string
  color: string
  badgeClass: string
}

export const TIER_STYLE: Record<Tier, TierStyle> = {
  none: { label: 'Normal', color: '#6b7280', badgeClass: 'bg-gray-100 text-gray-700' },
  low: { label: 'Low', color: '#2563eb', badgeClass: 'bg-blue-100 text-blue-800' },
  medium: { label: 'Medium', color: '#d97706', badgeClass: 'bg-amber-100 text-amber-800' },
  high: { label: 'High', color: '#dc2626', badgeClass: 'bg-red-100 text-red-800' },
}

// The worker writes tier "none" for minutes the model did not flag.
export function toTier(value: string | null | undefined): Tier {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'none'
}
