<script setup lang="ts">
// A thin lane under a time-series chart with one marker per event (deployment, retraining, early
// warning, incident, automatic action). The chart reports its visible time range and the insets
// of its plot area, so the lane follows the chart's zoom without a second time scale. The lane
// must sit in a container as wide as the chart canvas. Markers closer than 8 px merge into one
// "+n" button. Each marker is a real button that opens a small dialog with the details.
import type { EventItem, ChartWindow } from '@/types'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { clockTime, localDateTime, shortDate } from '@/lib/format'
import { TIER_SHAPE, toTier } from '@/lib/tier'

const props = defineProps<{
  events: EventItem[]
  window: ChartWindow | null
  // Sources the server could not read; shown as a muted note under the lane.
  unavailable?: string[]
}>()

const GROUP_PX = 8
const POPOVER_PX = 288

const root = ref<HTMLElement | null>(null)
const lane = ref<HTMLElement | null>(null)
const width = ref(0)
let observer: ResizeObserver | undefined

onMounted(() => {
  if (lane.value) {
    width.value = lane.value.clientWidth
    observer = new ResizeObserver(() => { width.value = lane.value?.clientWidth ?? 0 })
    observer.observe(lane.value)
  }
  document.addEventListener('pointerdown', onOutside)
})
onUnmounted(() => {
  observer?.disconnect()
  document.removeEventListener('pointerdown', onOutside)
})

function signalName(signal: string | null | undefined): string {
  return signal ? signal.replace(/_/g, ' ').toLowerCase() : 'unknown signal'
}
function actionName(action: string | null | undefined): string {
  if (!action) return 'Action'
  return action.charAt(0).toUpperCase() + action.slice(1).toLowerCase()
}
const FAMILY_WORDS = { worked: 'worked', failed: 'failed', not_run: 'not run' } as const
function familyOf(e: EventItem): 'worked' | 'failed' | 'not_run' {
  return e.detail.family ?? 'not_run'
}

// The date is added when the visible range is a day or longer, so a label is never ambiguous.
const longRange = computed(() => (props.window ? props.window.end - props.window.start >= 24 * 3600 * 1000 : false))
function stamp(ms: number): string {
  return longRange.value ? `${shortDate(ms)} ${clockTime(ms)}` : clockTime(ms)
}

function ariaLabel(e: EventItem): string {
  const at = stamp(e.time)
  const d = e.detail
  if (e.kind === 'deploy') return `Deployment${d.shortCommit || d.commit ? ` ${d.shortCommit ?? String(d.commit).slice(0, 7)}` : ''} at ${at}`
  if (e.kind === 'retrain') {
    const state = d.promoted === true ? 'promoted' : d.promoted === false ? 'not promoted' : ''
    return `Retraining${state ? ` ${state}` : ''}${d.newVersion ? ` ${d.newVersion}` : ''} at ${at}`
  }
  if (e.kind === 'early_warning') return `Early warning, ${signalName(d.signal)}, at ${at}`
  if (e.kind === 'incident') return `Incident${d.tier ? `, ${d.tier}` : ''}, at ${at}`
  return `${actionName(d.action)}, ${FAMILY_WORDS[familyOf(e)]}, at ${at}`
}

// The plain-words lines of the dialog for one event.
function describe(e: EventItem): { title: string, lines: string[] } {
  const d = e.detail
  const lines: string[] = []
  let title = ''
  if (e.kind === 'deploy') {
    title = 'Deployment'
    if (d.shortCommit || d.commit) lines.push(`Commit ${d.shortCommit ?? String(d.commit).slice(0, 7)}`)
    if (d.branch) lines.push(`Branch ${d.branch}`)
    if (d.runId) lines.push(`Run ${d.runId}`)
  } else if (e.kind === 'retrain') {
    title = 'Retraining'
    if (d.promoted === true) lines.push(d.newVersion ? `Promoted: ${d.newVersion} is the new champion` : 'The new model was promoted')
    else if (d.promoted === false) lines.push('Not promoted, the champion stays')
    if (d.newVersion && d.promoted !== true) lines.push(`New model ${d.newVersion}`)
    if (d.championVersion) lines.push(`Champion ${d.championVersion}`)
  } else if (e.kind === 'early_warning') {
    title = 'Early warning'
    if (d.signal) lines.push(`Signal ${signalName(d.signal)}`)
    if (d.minutes !== null && d.minutes !== undefined) lines.push(`About ${Math.round(d.minutes)} ${Math.round(d.minutes) === 1 ? 'minute' : 'minutes'} to its warning level`)
  } else if (e.kind === 'incident') {
    title = 'Incident'
    if (d.tier) lines.push(`Tier ${d.tier}`)
    if (d.peakScore !== null && d.peakScore !== undefined) lines.push(`Peak score ${d.peakScore.toFixed(2)}`)
    if (d.job) lines.push(`Job ${d.job}`)
  } else {
    title = actionName(d.action)
    lines.push(`Outcome ${d.outcome ?? FAMILY_WORDS[familyOf(e)]}`)
    if (d.mode) lines.push(`Mode ${d.mode}`)
  }
  // Nothing in the detail: fall back to the server's own label.
  if (lines.length === 0 && e.label) lines.push(e.label)
  return { title, lines }
}

interface Item { event: EventItem, x: number }
interface Marker { key: string, x: number, items: Item[] }

const markers = computed<Marker[]>(() => {
  const w = props.window
  if (!w || w.end <= w.start) return []
  const plot = width.value - w.left - w.right
  if (plot <= 0) return []
  const items: Item[] = props.events
    .filter(e => e.time >= w.start && e.time <= w.end)
    .sort((a, b) => a.time - b.time)
    .map(event => ({ event, x: w.left + ((event.time - w.start) / (w.end - w.start)) * plot }))
  // Left to right: an event joins the open group while it is under 8 px from the group's last
  // event, so two neighbouring markers always end up at least 8 px apart. The key is the group's
  // first event, so an open dialog stays open when a poll or a zoom does not change that event.
  const out: Marker[] = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (last && item.x - last.items[last.items.length - 1].x < GROUP_PX) {
      last.items.push(item)
      last.x = last.items.reduce((sum, i) => sum + i.x, 0) / last.items.length
    } else {
      out.push({ key: `${item.event.kind}-${item.event.time}`, x: item.x, items: [item] })
    }
  }
  return out
})

function markerLabel(m: Marker): string {
  if (m.items.length === 1) return ariaLabel(m.items[0].event)
  return `${m.items.length} events from ${stamp(m.items[0].event.time)} to ${stamp(m.items[m.items.length - 1].event.time)}`
}

// The open dialog: which marker, and the button to give focus back to.
const openKey = ref<string | null>(null)
let opener: HTMLElement | null = null
const dialog = ref<HTMLElement | null>(null)

const openMarker = computed(() => markers.value.find(m => m.key === openKey.value) ?? null)
const dialogLeft = computed(() => {
  const m = openMarker.value
  if (!m) return 0
  const w = Math.min(POPOVER_PX, width.value)
  return Math.max(0, Math.min(width.value - w, m.x - w / 2))
})
const dialogWidth = computed(() => Math.min(POPOVER_PX, width.value))

function toggle(m: Marker, e: MouseEvent) {
  if (openKey.value === m.key) {
    close(false)
    return
  }
  openKey.value = m.key
  opener = e.currentTarget as HTMLElement
  nextTick(() => dialog.value?.focus())
}
function close(refocus: boolean) {
  openKey.value = null
  if (refocus) opener?.focus()
}
// The marker left the window (a zoom or a new poll): close its dialog, so it does not open again
// by itself later, and give focus back to the marker button if it is still on the page.
watch(openMarker, (m) => {
  if (openKey.value === null || m) return
  const hadFocus = root.value?.contains(document.activeElement) ?? false
  openKey.value = null
  if (hadFocus) nextTick(() => { if (opener?.isConnected) opener.focus() })
})
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && openKey.value) {
    e.stopPropagation()
    close(true)
  }
}
function onOutside(e: Event) {
  if (openKey.value && root.value && !root.value.contains(e.target as Node)) close(false)
}
function onFocusout(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (openKey.value && next && root.value && !root.value.contains(next)) close(false)
}

const TIER_TEXT = { none: 'text-idle', low: 'text-tier-low-marker', medium: 'text-tier-medium-marker', high: 'text-tier-high-marker' } as const
const PILL = {
  worked: 'border-solid border-ok bg-okbg text-ok',
  failed: 'border-solid border-red bg-tier-high-bg text-tier-high-fg',
  not_run: 'border-dashed border-faint bg-chip text-chipfg',
} as const
</script>

<template>
  <div ref="root" class="flex flex-col gap-1" @keydown="onKeydown" @focusout="onFocusout">
    <div ref="lane" role="group" aria-label="Events on the chart" class="relative h-7 rounded-lg bg-chip">
      <span v-if="window && markers.length === 0" class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
        No events in this window
      </span>

      <button
        v-for="m in markers"
        :key="m.key"
        type="button"
        class="absolute top-1/2 flex min-h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        :style="{ left: `${m.x}px` }"
        :aria-label="markerLabel(m)"
        :aria-expanded="openKey === m.key"
        aria-haspopup="dialog"
        @click="toggle(m, $event)"
      >
        <span v-if="m.items.length > 1" class="inline-flex h-5 items-center rounded-full bg-card px-1.5 font-mono text-[11px] text-foreground ring-1 ring-border" aria-hidden="true">
          +{{ m.items.length }}
        </span>
        <svg v-else-if="m.items[0].event.kind === 'deploy'" class="size-3.5 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M12 17V8m-4 4 4-4 4 4" />
        </svg>
        <svg v-else-if="m.items[0].event.kind === 'retrain'" class="size-3.5 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 2.5 20.5 7.25v9.5L12 21.5l-8.5-4.75v-9.5z" />
        </svg>
        <svg v-else-if="m.items[0].event.kind === 'early_warning'" class="size-3.5 text-warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m5 16 7-8 7 8" />
        </svg>
        <svg v-else-if="m.items[0].event.kind === 'incident'" class="size-3.5" :class="TIER_TEXT[toTier(m.items[0].event.detail.tier)]" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path :d="TIER_SHAPE[toTier(m.items[0].event.detail.tier)]" />
        </svg>
        <span v-else class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border px-1" :class="PILL[familyOf(m.items[0].event)]" aria-hidden="true">
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="familyOf(m.items[0].event) === 'worked'" d="m5 12.5 4.5 4.5L19 7.5" />
            <path v-else-if="familyOf(m.items[0].event) === 'failed'" d="m6 6 12 12M18 6 6 18" />
            <path v-else d="M6 12h12" />
          </svg>
        </span>
      </button>

      <div
        v-if="openMarker"
        ref="dialog"
        role="dialog"
        tabindex="-1"
        :aria-label="openMarker.items.length > 1 ? `${openMarker.items.length} events` : describe(openMarker.items[0].event).title"
        class="absolute top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg bg-card p-3 text-[13px] text-foreground shadow-sm ring-1 ring-border"
        :style="{ left: `${dialogLeft}px`, width: `${dialogWidth}px` }"
      >
        <ul class="flex flex-col gap-2.5">
          <li v-for="(it, i) in openMarker.items" :key="i">
            <div class="font-semibold">{{ describe(it.event).title }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ localDateTime(it.event.time) }}</div>
            <ul v-if="describe(it.event).lines.length" class="mt-0.5 text-xs text-muted-foreground">
              <li v-for="line in describe(it.event).lines" :key="line">{{ line }}</li>
            </ul>
          </li>
        </ul>
      </div>
    </div>

    <p v-if="unavailable && unavailable.length" class="text-xs text-muted-foreground" role="status">
      Some events could not be loaded: {{ unavailable.join(', ') }}.
    </p>
  </div>
</template>
