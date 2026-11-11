<script setup lang="ts">
// A thin lane under a time-series chart with one marker per event (deployment, retraining, early
// warning, incident, automatic action). The chart reports its visible time range and the insets
// of its plot area, so the lane follows the chart's zoom without a second time scale. The lane
// must sit in a container as wide as the chart canvas.
//
// The plot width is cut into equal slots, each one marker wide plus a 4 px gap (28 px with a
// mouse, 48 px on a touch screen). Every event goes into the slot that holds its x position. A
// slot with one event draws that event's marker; a slot with more draws one "+n" pill. A marker
// always fits inside its own slot, so no two markers overlap at any width, and the slots are cut
// again on every zoom, pan, resize and poll, so zooming in splits the pills.
import type { EventItem, ChartWindow } from '@/types'
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch, type FunctionalComponent } from 'vue'
import { clockTime, localDateTime, shortDate } from '@/lib/format'
import { TIER_SHAPE, toTier } from '@/lib/tier'

const props = defineProps<{
  events: EventItem[]
  window: ChartWindow | null
  // Sources the server could not read; shown as a muted note under the lane.
  unavailable?: string[]
  // The server dropped the oldest incidents and actions to stay under its cap.
  truncated?: boolean
}>()

const GAP_PX = 4
const MARKER_FINE_PX = 24
const MARKER_COARSE_PX = 44
const POPOVER_PX = 288
const GROUP_LIST_MAX = 20

const root = ref<HTMLElement | null>(null)
const lane = ref<HTMLElement | null>(null)
const width = ref(0)
let observer: ResizeObserver | undefined

// The slot size follows the main pointer, the same rule as the pointer-coarse classes below.
const coarseQuery = typeof window !== 'undefined' ? window.matchMedia('(pointer: coarse)') : null
const coarse = ref(coarseQuery?.matches ?? false)
function onPointerChange(e: MediaQueryListEvent) { coarse.value = e.matches }
const markerPx = computed(() => (coarse.value ? MARKER_COARSE_PX : MARKER_FINE_PX))
const slotPx = computed(() => markerPx.value + GAP_PX)

onMounted(() => {
  if (lane.value) {
    width.value = lane.value.clientWidth
    observer = new ResizeObserver(() => { width.value = lane.value?.clientWidth ?? 0 })
    observer.observe(lane.value)
  }
  coarseQuery?.addEventListener('change', onPointerChange)
  document.addEventListener('pointerdown', onOutside)
})
onUnmounted(() => {
  observer?.disconnect()
  coarseQuery?.removeEventListener('change', onPointerChange)
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

// How important an event is for a pill's look, lowest first: deployment, ran-and-failed action,
// early warning, high, medium and low incident (then an incident without a tier), retraining,
// other actions.
function rank(e: EventItem): number {
  if (e.kind === 'deploy') return 0
  if (e.kind === 'action' && familyOf(e) === 'failed') return 1
  if (e.kind === 'early_warning') return 2
  if (e.kind === 'incident') return { high: 3, medium: 4, low: 5, none: 6 }[toTier(e.detail.tier)]
  if (e.kind === 'retrain') return 7
  return 8
}

// The words for one kind in a pill's label, singular and plural. Actions are named with their
// outcome family, for example "restart not run".
function kindKey(e: EventItem): string {
  if (e.kind === 'action') return `action:${(e.detail.action ?? 'action').toLowerCase()}:${familyOf(e)}`
  return e.kind
}
function kindWords(key: string, n: number): string {
  const s = n === 1 ? '' : 's'
  if (key === 'deploy') return `${n} deployment${s}`
  if (key === 'retrain') return `${n} retraining run${s}`
  if (key === 'early_warning') return `${n} early warning${s}`
  if (key === 'incident') return `${n} incident${s}`
  const [, action, family] = key.split(':')
  return `${n} ${action}${s} ${FAMILY_WORDS[family as keyof typeof FAMILY_WORDS]}`
}

const eventKey = (e: EventItem) => `${e.kind}-${e.time}`

interface Marker {
  // The key of the slot's oldest event, so a marker keeps its identity while that event stays.
  key: string
  x: number
  // Oldest first.
  items: EventItem[]
  // The event whose shape and colour a pill shows.
  lead: EventItem
}

const markers = computed<Marker[]>(() => {
  const w = props.window
  if (!w || w.end <= w.start) return []
  const plot = width.value - w.left - w.right
  if (plot <= 0) return []
  // Equal slots, each at least one marker plus the gap wide, so a marker fits inside its slot.
  const count = Math.max(1, Math.floor(plot / slotPx.value))
  const slot = plot / count
  const half = Math.min(markerPx.value, slot) / 2
  // Half the gap stays free on each side of a slot, so markers in neighbouring slots never touch.
  const pad = Math.min(GAP_PX / 2, slot / 2 - half)
  const span = w.end - w.start
  const bySlot = new Map<number, { x: number, event: EventItem }[]>()
  for (const event of props.events) {
    if (event.time < w.start || event.time > w.end) continue
    const x = w.left + ((event.time - w.start) / span) * plot
    const k = Math.min(count - 1, Math.max(0, Math.floor((x - w.left) / slot)))
    const list = bySlot.get(k)
    if (list) list.push({ x, event })
    else bySlot.set(k, [{ x, event }])
  }
  const out: Marker[] = []
  for (const [k, list] of [...bySlot.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.event.time - b.event.time)
    const start = w.left + k * slot
    const items = list.map(i => i.event)
    // One event: centred on its true x, kept inside its slot. More: centred on the slot.
    const x = list.length === 1
      ? Math.min(start + slot - half - pad, Math.max(start + half + pad, list[0].x))
      : start + slot / 2
    const lead = items.reduce((best, e) => (rank(e) < rank(best) ? e : best), items[0])
    out.push({ key: eventKey(items[0]), x, items, lead })
  }
  return out
})

function markerLabel(m: Marker): string {
  if (m.items.length === 1) return ariaLabel(m.items[0])
  const counts = new Map<string, { n: number, rank: number }>()
  for (const e of m.items) {
    const k = kindKey(e)
    const c = counts.get(k)
    if (c) {
      c.n++
      c.rank = Math.min(c.rank, rank(e))
    } else {
      counts.set(k, { n: 1, rank: rank(e) })
    }
  }
  const kinds = [...counts.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([k, c]) => kindWords(k, c.n))
  return `${m.items.length} events: ${kinds.join(', ')}, ${stamp(m.items[0].time)} to ${stamp(m.items[m.items.length - 1].time)}`
}

// The count on a pill, shortened so it fits the pill: the exact number is in its label.
function countText(n: number): string {
  const max = coarse.value ? 999 : 99
  return n > max ? `${max}+` : `+${n}`
}

// The open dialog is tied to one event (the oldest event of the marker that opened it), not to a
// slot, so it stays open while that event is visible even when a poll or a zoom regroups the slots.
const openEvent = ref<string | null>(null)
const dialog = ref<HTMLElement | null>(null)

const openMarker = computed(() => {
  const key = openEvent.value
  if (key === null) return null
  return markers.value.find(m => m.items.some(e => eventKey(e) === key)) ?? null
})
const dialogLeft = computed(() => {
  const m = openMarker.value
  if (!m) return 0
  const w = Math.min(POPOVER_PX, width.value)
  return Math.max(0, Math.min(width.value - w, m.x - w / 2))
})
const dialogWidth = computed(() => Math.min(POPOVER_PX, width.value))
// A group lists its newest events first, at most GROUP_LIST_MAX of them.
const groupList = computed(() => (openMarker.value ? openMarker.value.items.slice().reverse().slice(0, GROUP_LIST_MAX) : []))
const groupMore = computed(() => (openMarker.value ? Math.max(0, openMarker.value.items.length - GROUP_LIST_MAX) : 0))

// The marker button that holds the open event; looked up each time, because a regrouping can
// replace the button.
function openButton(): HTMLElement | null {
  const m = openMarker.value
  if (!m || !root.value) return null
  return root.value.querySelector<HTMLElement>(`[data-marker="${CSS.escape(m.key)}"]`)
}

function toggle(m: Marker) {
  if (openMarker.value && openMarker.value.key === m.key) {
    close(false)
    return
  }
  openEvent.value = eventKey(m.items[0])
  nextTick(() => dialog.value?.focus())
}
function close(refocus: boolean) {
  const button = refocus ? openButton() : null
  openEvent.value = null
  button?.focus()
}
// The event left the window (a zoom or a new poll): close its dialog, so it does not open again
// by itself later. If focus was in the lane, it goes back to the lane.
watch(openMarker, (m) => {
  if (openEvent.value === null || m) return
  const hadFocus = root.value?.contains(document.activeElement) ?? false
  openEvent.value = null
  if (hadFocus) nextTick(() => lane.value?.querySelector<HTMLElement>('button')?.focus())
})
// A regrouping that replaces the open marker's button while the dialog has focus keeps focus in
// the dialog; Escape then finds the new button through openButton.
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && openEvent.value) {
    e.stopPropagation()
    close(true)
  }
}
function onOutside(e: Event) {
  if (openEvent.value && root.value && !root.value.contains(e.target as Node)) close(false)
}
function onFocusout(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (openEvent.value && next && root.value && !root.value.contains(next)) close(false)
}

const TIER_TEXT = { none: 'text-idle', low: 'text-tier-low-marker', medium: 'text-tier-medium-marker', high: 'text-tier-high-marker' } as const
const PILL = {
  worked: 'border-solid border-ok bg-okbg text-ok',
  failed: 'border-solid border-red bg-tier-high-bg text-tier-high-fg',
  not_run: 'border-dashed border-faint bg-chip text-chipfg',
} as const

// The shape of one event (DESIGN.md 7.4). small is the reduced shape drawn inside a "+n" pill.
const svgAttrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }
const Shape: FunctionalComponent<{ event: EventItem, small?: boolean }> = ({ event, small }) => {
  const size = small ? 'size-2.5 pointer-coarse:size-3' : 'size-3.5'
  if (event.kind === 'deploy') {
    return h('svg', { ...svgAttrs, class: `${size} text-foreground`, 'stroke-width': '2.2' }, [
      h('rect', { x: '3', y: '3', width: '18', height: '18', rx: '3' }),
      h('path', { d: 'M12 17V8m-4 4 4-4 4 4' }),
    ])
  }
  if (event.kind === 'retrain') {
    return h('svg', { ...svgAttrs, class: `${size} text-foreground`, 'stroke-width': '2.2' }, [
      h('path', { d: 'M12 2.5 20.5 7.25v9.5L12 21.5l-8.5-4.75v-9.5z' }),
    ])
  }
  if (event.kind === 'early_warning') {
    return h('svg', { ...svgAttrs, class: `${size} text-warn`, 'stroke-width': '3' }, [h('path', { d: 'm5 16 7-8 7 8' })])
  }
  if (event.kind === 'incident') {
    const tier = toTier(event.detail.tier)
    return h('svg', { viewBox: '0 0 12 12', fill: 'currentColor', 'aria-hidden': 'true', class: `${size} ${TIER_TEXT[tier]}` }, [h('path', { d: TIER_SHAPE[tier] })])
  }
  const family = familyOf(event)
  const mark = family === 'worked' ? 'm5 12.5 4.5 4.5L19 7.5' : family === 'failed' ? 'm6 6 12 12M18 6 6 18' : 'M6 12h12'
  const box = small ? 'h-3 min-w-3 pointer-coarse:h-3.5 pointer-coarse:min-w-3.5 px-px' : 'h-5 min-w-5 px-1'
  return h('span', { class: `inline-flex items-center justify-center rounded-full border ${box} ${PILL[family]}`, 'aria-hidden': 'true' }, [
    h('svg', { ...svgAttrs, class: small ? 'size-2' : 'size-3', 'stroke-width': '3' }, [h('path', { d: mark })]),
  ])
}
Shape.props = ['event', 'small']
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
        :data-marker="m.key"
        class="absolute top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md pointer-coarse:size-11"
        :style="{ left: `${m.x}px` }"
        :aria-label="markerLabel(m)"
        :aria-expanded="openMarker?.key === m.key"
        aria-haspopup="dialog"
        @click="toggle(m)"
      >
        <span
          v-if="m.items.length > 1"
          class="flex size-full flex-col items-center justify-center gap-px rounded-md bg-card ring-1 ring-border"
          aria-hidden="true"
        >
          <Shape :event="m.lead" small />
          <span class="font-mono text-[9px] leading-none text-foreground pointer-coarse:text-[11px]">{{ countText(m.items.length) }}</span>
        </span>
        <Shape v-else :event="m.items[0]" />
      </button>

      <div
        v-if="openMarker"
        ref="dialog"
        role="dialog"
        tabindex="-1"
        :aria-label="openMarker.items.length > 1 ? `${openMarker.items.length} events` : describe(openMarker.items[0]).title"
        class="absolute top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg bg-card p-3 text-[13px] text-foreground shadow-sm ring-1 ring-border pointer-coarse:mt-3"
        :style="{ left: `${dialogLeft}px`, width: `${dialogWidth}px` }"
      >
        <template v-if="openMarker.items.length === 1">
          <div class="font-semibold">{{ describe(openMarker.items[0]).title }}</div>
          <div class="font-mono text-xs text-muted-foreground">{{ localDateTime(openMarker.items[0].time) }}</div>
          <ul v-if="describe(openMarker.items[0]).lines.length" class="mt-0.5 text-xs text-muted-foreground">
            <li v-for="line in describe(openMarker.items[0]).lines" :key="line">{{ line }}</li>
          </ul>
        </template>
        <template v-else>
          <div class="mb-1.5 font-semibold">{{ openMarker.items.length }} events, newest first</div>
          <ul class="flex flex-col gap-1">
            <li v-for="e in groupList" :key="eventKey(e)" class="flex items-center gap-2 text-xs">
              <span class="flex w-5 shrink-0 justify-center"><Shape :event="e" small /></span>
              <span class="shrink-0 font-mono text-muted-foreground">{{ stamp(e.time) }}</span>
              <span class="min-w-0 truncate">{{ e.label }}</span>
            </li>
          </ul>
          <p v-if="groupMore > 0" class="mt-1.5 text-xs text-muted-foreground">
            and {{ groupMore }} more, zoom in to see them
          </p>
        </template>
      </div>
    </div>

    <p v-if="truncated" class="text-xs text-muted-foreground">
      Showing the newest {{ events.length }} events; zoom in or pick a shorter range
    </p>
    <p v-if="unavailable && unavailable.length" class="text-xs text-muted-foreground" role="status">
      Some events could not be loaded: {{ unavailable.join(', ') }}.
    </p>
  </div>
</template>
