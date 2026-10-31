// Tier colours, chart marker shapes and labels, shared by badges and chart markers.
// Badges always show the label, and chart markers differ in shape as well as colour,
// so colour is never the only cue. Colours are CSS variables, so they follow the theme.

export type Tier = 'none' | 'low' | 'medium' | 'high'

export const FLAG_TIERS = ['low', 'medium', 'high'] as const

interface TierStyle {
  label: string
  // CSS variable with the marker colour; the chart reads its value when drawing.
  markerVar: string
  // ECharts built-in symbol name for chart markers.
  symbol: 'circle' | 'triangle' | 'diamond'
  badgeClass: string
}

export const TIER_STYLE: Record<Tier, TierStyle> = {
  none: { label: 'Normal', markerVar: '--idle', symbol: 'circle', badgeClass: 'bg-chip text-chipfg' },
  low: { label: 'Low', markerVar: '--tier-low-marker', symbol: 'circle', badgeClass: 'bg-tier-low-bg text-tier-low-fg' },
  medium: { label: 'Medium', markerVar: '--tier-medium-marker', symbol: 'triangle', badgeClass: 'bg-tier-medium-bg text-tier-medium-fg' },
  high: { label: 'High', markerVar: '--tier-high-marker', symbol: 'diamond', badgeClass: 'bg-tier-high-bg text-tier-high-fg' },
}

// SVG paths in a 12 by 12 box for the same shapes in HTML badges and legends.
export const TIER_SHAPE: Record<Tier, string> = {
  none: 'M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z',
  low: 'M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z',
  medium: 'M6 1 11 10H1z',
  high: 'M6 .5 11.5 6 6 11.5.5 6z',
}

// The worker writes tier "none" for minutes the model did not flag.
export function toTier(value: string | null | undefined): Tier {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'none'
}
