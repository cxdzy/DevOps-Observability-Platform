<script lang="ts">
import type { ContainerForecast, DiskForecast, ForecastState } from '@/composables/useApi'

// Minutes as shown: rounded to 5 minutes above 10, otherwise the whole minute.
export function forecastMinutes(minutes: number): number {
  return minutes > 10 ? Math.round(minutes / 5) * 5 : Math.max(0, Math.round(minutes))
}

const NO_DATA = 'No data'
const num = (v: number | null | undefined, digits: number) => (v === null || v === undefined ? NO_DATA : `${v.toFixed(digits).replace(/\.0+$/, '')}`)

// The words of a memory forecast. Every state has its own sentence, so colour is never the only cue.
export function memoryText(f: ContainerForecast | null): string {
  if (!f) return NO_DATA
  switch (f.state) {
    case 'ok': return 'Memory steady'
    case 'warning':
      return f.est_minutes === null ? 'Memory is rising towards its limit, estimate: No data' : `Memory reaches its limit in about ${forecastMinutes(f.est_minutes)} min`
    case 'no_limit': return 'No memory limit set, so no forecast. Set a limit on the container.'
    case 'not_enough_data': return 'Collecting data (needs 10 minutes after a restart)'
    case 'restarting':
      if (f.restarts !== null && f.restarts >= 1) return `Restarted ${f.restarts} ${f.restarts === 1 ? 'time' : 'times'} in 15 minutes${f.oom ? ', out of memory' : ''}`
      return f.oom ? 'Out of memory kill in the last 15 minutes' : 'Restarting repeatedly'
    case 'no_data': return 'No data from this server'
    default: return NO_DATA
  }
}

// The detail line under a memory forecast: limit, current level and rate.
export function memoryDetail(f: ContainerForecast | null): string {
  if (!f || f.state === 'no_limit' || f.state === 'no_data') return ''
  const rate = f.slope_mb_per_min === null ? NO_DATA : `${f.slope_mb_per_min >= 0 ? 'rising' : 'falling'} ${num(Math.abs(f.slope_mb_per_min), 2)} MiB a minute`
  return `Limit ${num(f.limit_mb, 0)} MiB, now ${num(f.level_mb, 0)} MiB, ${rate}`
}

export function diskText(d: DiskForecast | null): string {
  if (!d) return NO_DATA
  const on = ` on ${d.mountpoint}`
  switch (d.state) {
    case 'ok': return `Disk steady${on}`
    case 'warning': {
      if (d.est_hours === null) return `Disk is filling${on}, estimate: No data`
      const h = Math.max(1, Math.round(d.est_hours))
      return `Disk full in about ${h} ${h === 1 ? 'hour' : 'hours'}${on}`
    }
    case 'not_enough_data': return `Collecting disk data${on}`
    case 'no_data': return 'No data from this server'
    default: return NO_DATA
  }
}

export function diskDetail(d: DiskForecast | null): string {
  if (!d || d.state === 'no_data') return ''
  const used = d.used_pct === null ? NO_DATA : `${num(d.used_pct, 1)} percent used`
  const rate = d.slope_pct_per_hour === null ? NO_DATA : `${d.slope_pct_per_hour >= 0 ? 'rising' : 'falling'} ${num(Math.abs(d.slope_pct_per_hour), 2)} percent an hour`
  return `${used}, ${rate}`
}

export type ChipIcon = 'check' | 'chevron' | 'chevrons' | 'none' | 'clock' | 'dash'
export function forecastIcon(state: ForecastState | null | undefined): ChipIcon {
  switch (state) {
    case 'ok': return 'check'
    case 'warning': return 'chevron'
    case 'restarting': return 'chevrons'
    case 'no_limit': return 'none'
    case 'not_enough_data': return 'clock'
    default: return 'dash'
  }
}
</script>

<script setup lang="ts">
// One forecast state as a pill: an icon and words, in the early warning colours for a warning
// (never a tier colour or shape), green for steady and muted for the rest. Optional detail line.
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  kind: 'memory' | 'disk'
  item: ContainerForecast | DiskForecast | null
  loading?: boolean
  failed?: boolean
  detail?: boolean
}>(), { loading: false, failed: false, detail: false })

const state = computed<ForecastState | null>(() => props.item?.state ?? null)
const text = computed(() => {
  if (props.failed) return 'Forecast unavailable'
  return props.kind === 'memory' ? memoryText(props.item as ContainerForecast | null) : diskText(props.item as DiskForecast | null)
})
const detailText = computed(() => {
  if (!props.detail || props.failed) return ''
  return props.kind === 'memory' ? memoryDetail(props.item as ContainerForecast | null) : diskDetail(props.item as DiskForecast | null)
})
const icon = computed<ChipIcon>(() => (props.failed ? 'dash' : forecastIcon(state.value)))
const classes = computed(() => {
  if (props.failed) return 'bg-chip text-chipfg ring-border'
  switch (state.value) {
    case 'warning':
    case 'restarting': return 'bg-warnbg text-warnfg ring-warnring'
    case 'ok': return 'bg-okbg text-ok ring-ok/30'
    case 'no_data':
    case null: return 'border border-dashed border-input text-chipfg ring-0'
    default: return 'bg-chip text-chipfg ring-border'
  }
})
</script>

<template>
  <span v-if="loading" class="inline-block h-6 w-40 animate-pulse rounded-full bg-chip motion-reduce:animate-none" aria-label="Loading the forecast" role="status" />
  <span v-else class="inline-flex min-w-0 flex-col gap-0.5">
    <span
      class="inline-flex w-fit max-w-full items-start gap-1.5 rounded-2xl px-2.5 py-1 text-xs font-medium ring-1"
      :class="classes"
      :data-state="failed ? 'failed' : state ?? 'none'"
    >
      <svg class="mt-px size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="icon === 'check'" d="m5 12.5 4.5 4.5L19 7.5" />
        <path v-else-if="icon === 'chevron'" d="m6 15 6-6 6 6" />
        <template v-else-if="icon === 'chevrons'">
          <path d="m6 13 6-6 6 6" />
          <path d="m6 19 6-6 6 6" />
        </template>
        <template v-else-if="icon === 'none'">
          <circle cx="12" cy="12" r="8" stroke-width="2" />
          <path d="m6.5 17.5 11-11" stroke-width="2" />
        </template>
        <template v-else-if="icon === 'clock'">
          <circle cx="12" cy="12" r="8.5" stroke-width="2" />
          <path d="M12 7.5V12l3 2" stroke-width="2" />
        </template>
        <path v-else d="M6 12h12" />
      </svg>
      <span class="min-w-0 [overflow-wrap:anywhere]">{{ text }}</span>
    </span>
    <span v-if="detailText" class="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{{ detailText }}</span>
  </span>
</template>
