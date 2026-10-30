// Display helpers. All times are shown in the browser's local time zone.

export function localDateTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : '-'
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], { day: '2-digit', month: 'short' })
}

export function fixed(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || Number.isNaN(value) ? '-' : value.toFixed(digits)
}

export function orDash(value: string | null | undefined): string {
  return value ? value : '-'
}
