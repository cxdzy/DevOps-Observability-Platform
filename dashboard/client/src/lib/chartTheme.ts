// Shared colour handling for the ECharts canvases. Canvas drawing cannot use CSS variables, so
// the colours are read from the theme when drawing and read again when the theme changes.
import { onMounted, ref, watch } from 'vue'
import { useTheme } from '@/composables/useTheme'
import { TIER_STYLE } from '@/lib/tier'

export const MONO = '"Geist Mono", ui-monospace, monospace'

// Legend icon drawn as a filled path: a solid bar, 24 by 2.
export const LINE_ICON = 'path://M0 0h24v2H0z'

export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

// #RRGGBB with an alpha, for the area fill that fades out.
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`
}

export function readPalette() {
  return {
    panel: cssVar('--panel', '#FFFFFF'),
    ink: cssVar('--ink', '#18181B'),
    muted: cssVar('--muted-foreground', '#52525B'),
    faint: cssVar('--faint', '#71717A'),
    line: cssVar('--line', '#E4E4E7'),
    primary: cssVar('--primary', '#18181B'),
    chartline: cssVar('--chartline', '#18181B'),
    thresh: cssVar('--thresh', '#A1A1AA'),
    grid: cssVar('--grid', '#E4E4E7'),
    tiers: {
      low: cssVar(TIER_STYLE.low.markerVar, '#2563EB'),
      medium: cssVar(TIER_STYLE.medium.markerVar, '#D97706'),
      high: cssVar(TIER_STYLE.high.markerVar, '#DC2626'),
    },
  }
}

// The palette, kept in step with the theme, and a counter that goes up once Geist Mono has
// loaded. Canvas text does not wait for web fonts, so a chart reads the counter in its option
// to be drawn again when the font arrives. Call from a component's setup.
export function useChartTheme() {
  const { theme } = useTheme()
  const palette = ref(readPalette())
  watch(theme, () => { palette.value = readPalette() })

  const fontReady = ref(0)
  onMounted(() => {
    document.fonts?.load(`11px ${MONO}`).then(() => { fontReady.value++ }, () => {})
  })
  return { palette, fontReady }
}
