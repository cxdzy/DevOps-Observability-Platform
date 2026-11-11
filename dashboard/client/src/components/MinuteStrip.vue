<script lang="ts">
// Shared minute logic for the anomaly view. The cards, the chart, the strip and the minute detail
// all read the same rules from here, so they cannot disagree. This file never imports echarts.
import type { AnomalyPoint } from '@/types'
import { toTier } from '@/lib/tier'

export const MINUTE_MS = 60_000
// How long after a warning run ends a flag still counts as following it.
export const LEAD_WINDOW_MS = 30 * MINUTE_MS

export interface Episode {
  // First and last warning minute of the run.
  start: number
  end: number
  // First flagged minute after the run, or null when none came in time.
  flagAt: number | null
  // Whole minutes from the first warning minute to flagAt, or null.
  leadMinutes: number | null
  // The first loaded minute is already a warning, so the episode began before the loaded range.
  startedBeforeRange: boolean
}

// Warning runs closer than this (from the end of one to the start of the next) are one episode,
// the same as the worker's EW_RENOTIFY_MINUTES default, which notifies once per episode.
export const EPISODE_MERGE_MS = 10 * MINUTE_MS

// A warning run is minutes with early_warning = 1, each exactly 60 s after the one before. An
// episode is one or more runs where each run starts less than 10 minutes after the previous one
// ended. Its lead time runs from the episode's first warning minute to the first is_anomaly = 1
// minute (not a warm-up minute) after that first warning and no later than 30 minutes after the
// episode's last warning minute. Without such a flag there is no lead time. Points must be sorted
// by time, as the API returns them.
export function findEpisodes(points: AnomalyPoint[]): Episode[] {
  const runs: Run[] = []
  let i = 0
  while (i < points.length) {
    if (points[i].early_warning !== 1) {
      i++
      continue
    }
    const start = points[i].time
    let end = start
    let j = i + 1
    while (j < points.length && points[j].early_warning === 1 && points[j].time - end === MINUTE_MS) {
      end = points[j].time
      j++
    }
    runs.push({ start, end })
    i = j
  }

  const merged: Run[] = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end < EPISODE_MERGE_MS) last.end = r.end
    else merged.push({ ...r })
  }

  const firstTime = points.length ? points[0].time : null
  return merged.map(({ start, end }) => {
    let flagAt: number | null = null
    for (const p of points) {
      if (p.time <= start) continue
      if (p.time > end + LEAD_WINDOW_MS) break
      if (p.is_anomaly === 1 && p.warmup !== 1) {
        flagAt = p.time
        break
      }
    }
    return {
      start,
      end,
      flagAt,
      leadMinutes: flagAt === null ? null : Math.round((flagAt - start) / MINUTE_MS),
      startedBeforeRange: start === firstTime,
    }
  })
}

export interface Run { start: number, end: number }

// Runs of warm-up minutes (60 s apart). end is the time of the last warm-up minute.
export function warmupRuns(points: AnomalyPoint[]): Run[] {
  const runs: Run[] = []
  let current: Run | null = null
  for (const p of points) {
    if (p.warmup !== 1) {
      current = null
      continue
    }
    if (current && p.time - current.end === MINUTE_MS) {
      current.end = p.time
    } else {
      current = { start: p.time, end: p.time }
      runs.push(current)
    }
  }
  return runs
}

// The worker marks WARMUP_MINUTES (3 by default) minutes from each restart minute as warm-up.
export const WARMUP_MS = 3 * MINUTE_MS

// A restart is a warm-up minute whose previous point is not warm-up, or one that comes a full
// warm-up after the last restart (a second restart right after the first). A missing minute
// inside a warm-up is therefore not a new restart. A warm-up that already began when the loaded
// range starts is skipped, because its restart minute is not in the data.
export function restartTimes(points: AnomalyPoint[]): number[] {
  const times: number[] = []
  let restartAt = Number.NEGATIVE_INFINITY
  let previousWarm = false
  points.forEach((p, i) => {
    if (p.warmup !== 1) {
      previousWarm = false
      return
    }
    if (i === 0) {
      restartAt = p.time
    } else if (!previousWarm || p.time - restartAt >= WARMUP_MS) {
      restartAt = p.time
      times.push(p.time)
    }
    previousWarm = true
  })
  return times
}

export function isFlagged(p: AnomalyPoint): boolean {
  // Warm-up minutes are never flagged, whatever the stored flag says.
  return p.is_anomaly === 1 && p.warmup !== 1
}

// What one minute shows as, from most to least important: flag tier, early warning, restart,
// warm-up, normal. The rank is used where several minutes share a pixel.
export type CellState = 'normal' | 'warmup' | 'restart' | 'warn' | 'low' | 'medium' | 'high'
export const CELL_RANK: Record<CellState, number> = { normal: 0, warmup: 1, restart: 2, warn: 3, low: 4, medium: 5, high: 6 }

export function cellStates(points: AnomalyPoint[]): CellState[] {
  const restarts = new Set(restartTimes(points))
  return points.map((p) => {
    if (isFlagged(p)) {
      const tier = toTier(p.tier)
      return tier === 'none' ? 'low' : tier
    }
    if (p.early_warning === 1) return 'warn'
    if (restarts.has(p.time)) return 'restart'
    if (p.warmup === 1) return 'warmup'
    return 'normal'
  })
}

// Times of the minutes worth stepping to: a warning, a flag or a restart.
export function eventTimes(points: AnomalyPoint[]): number[] {
  const restarts = new Set(restartTimes(points))
  return points.filter(p => p.early_warning === 1 || isFlagged(p) || restarts.has(p.time)).map(p => p.time)
}
</script>

<script setup lang="ts">
import type { ZoomWindow } from '@/types'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { hatchTile, useChartTheme } from '@/lib/chartTheme'
import { localDateTime } from '@/lib/format'
import { TIER_STYLE } from '@/lib/tier'

// One strip cell per minute under the chart, with a framed brush for the chart's zoom window. The
// view owns the zoom; this control only asks for a new window with the zoom event.
const props = defineProps<{
  points: AnomalyPoint[]
  zoom: ZoomWindow
}>()
const emit = defineEmits<{ zoom: [window: ZoomWindow] }>()

const root = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const width = ref(0)
const height = ref(0)
const { palette } = useChartTheme()
let observer: ResizeObserver | undefined

onMounted(() => {
  if (!root.value) return
  width.value = root.value.clientWidth
  height.value = root.value.clientHeight
  observer = new ResizeObserver(() => {
    width.value = root.value?.clientWidth ?? 0
    height.value = root.value?.clientHeight ?? 0
  })
  observer.observe(root.value)
  watchPixelRatio()
})
onUnmounted(() => {
  observer?.disconnect()
  pixelQuery?.removeEventListener('change', onPixelRatio)
})

// Moving the window to a screen with another pixel ratio changes no size, so the canvas would stay
// at the old resolution. A media query for the current ratio fires once when it changes.
const pixelRatio = ref(1)
let pixelQuery: MediaQueryList | undefined
function onPixelRatio() {
  pixelQuery?.removeEventListener('change', onPixelRatio)
  watchPixelRatio()
}
function watchPixelRatio() {
  pixelRatio.value = window.devicePixelRatio || 1
  pixelQuery = window.matchMedia?.(`(resolution: ${pixelRatio.value}dppx)`)
  pixelQuery?.addEventListener('change', onPixelRatio)
}

const states = computed(() => cellStates(props.points))

// Drawn on one canvas, so a 7 day range (10080 minutes) costs a few hundred rectangles, not
// thousands of elements. When several minutes fall on the same pixel the cell shows the most
// important one of them: flag tier, then early warning, then restart, then warm-up, then normal.
function draw() {
  const cv = canvas.value
  const w = width.value
  const h = height.value
  const pts = props.points
  if (!cv || w <= 0 || h <= 0) return
  const dpr = pixelRatio.value
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (pts.length === 0) return

  const c = palette.value
  const first = pts[0].time
  // One slot per minute of the range, at least one pixel wide.
  const total = pts[pts.length - 1].time - first + MINUTE_MS
  const unit = Math.max(1, (w * MINUTE_MS) / total)
  const buckets = Math.ceil(w / unit)
  const best = new Int8Array(buckets).fill(-1)
  const bestState: CellState[] = new Array(buckets).fill('normal')
  for (let i = 0; i < pts.length; i++) {
    const b = Math.min(buckets - 1, Math.floor(((pts[i].time - first) / total) * (w / unit)))
    const rank = CELL_RANK[states.value[i]]
    if (rank > best[b]) {
      best[b] = rank
      bestState[b] = states.value[i]
    }
  }

  const hatch = ctx.createPattern(hatchTile(c.faint), 'repeat')
  const gap = unit >= 3 ? 1 : 0
  const cellW = unit - gap
  for (let b = 0; b < buckets; b++) {
    if (best[b] < 0) continue
    const x = b * unit
    const state = bestState[b]
    if (state === 'low' || state === 'medium' || state === 'high') {
      ctx.fillStyle = c.tiers[state]
      ctx.fillRect(x, 0, cellW, h)
      continue
    }
    if (state === 'warn') {
      ctx.fillStyle = cellW >= 3 ? c.warnbg : c.warn
      ctx.fillRect(x, 0, cellW, h)
      if (cellW >= 3) {
        ctx.strokeStyle = c.warn
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, 0.5, cellW - 1, h - 1)
      }
      continue
    }
    ctx.fillStyle = c.strip
    ctx.fillRect(x, 0, cellW, h)
    if (state === 'warmup' && hatch) {
      ctx.fillStyle = hatch
      ctx.fillRect(x, 0, cellW, h)
    }
    if (state === 'restart') {
      ctx.fillStyle = c.primary
      ctx.fillRect(x, 0, Math.max(2, Math.min(cellW, 3)), h)
    }
  }
}
watch([() => props.points, palette, width, height, pixelRatio], () => { void nextTick(draw) }, { flush: 'post' })
onMounted(() => { void nextTick(draw) })

// Zoom percent is measured over the chart's x axis, first to last minute (one minute when there
// is only one), while the cells cover first to last minute plus that minute's own width. These
// convert between the two, so the brush frames exactly the cells of the minutes the chart shows.
const scale = computed(() => {
  const pts = props.points
  const first = pts.length ? pts[0].time : 0
  const last = pts.length ? pts[pts.length - 1].time : 0
  return { first, range: last > first ? last - first : MINUTE_MS, total: last - first + MINUTE_MS }
})
// Percent of the strip's width at a zoom percent.
const stripPercent = (zoomPercent: number) => (scale.value.range * zoomPercent) / scale.value.total
// Zoom percent that the minute starting at the given strip percent has.
const zoomPercent = (strip: number) => (strip * scale.value.total) / scale.value.range
const cellPercent = computed(() => (MINUTE_MS / scale.value.range) * 100)

// The visible window and its times, for the brush and the spoken value.
const span = computed(() => props.zoom.end - props.zoom.start)
const brush = computed(() => {
  const left = stripPercent(props.zoom.start)
  const right = Math.min(100, stripPercent(props.zoom.end) + (MINUTE_MS / scale.value.total) * 100)
  return { left: `${left}%`, width: `${Math.max(right - left, 0.5)}%` }
})
const windowText = computed(() => {
  if (props.points.length === 0) return 'No data'
  const { first, range } = scale.value
  const at = (percent: number) => localDateTime(first + (range * percent) / 100)
  return `From ${at(props.zoom.start)} to ${at(props.zoom.end)}`
})

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
function moveTo(start: number) {
  if (span.value >= 99.99) return
  const s = clamp(start, 0, 100 - span.value)
  emit('zoom', { start: s, end: s + span.value })
}

// Dragging inside the brush moves it; pressing elsewhere (a click on a cell) centres the window
// on that cell and carries on as a drag.
let dragging = false
let grab = 0
// Zoom percent under the pointer.
function percentAt(e: PointerEvent): number {
  const rect = root.value?.getBoundingClientRect()
  return rect && rect.width > 0 ? clamp(zoomPercent(((e.clientX - rect.left) / rect.width) * 100), 0, 100) : 0
}
function onDown(e: PointerEvent) {
  if (e.button !== 0 || props.points.length === 0) return
  const p = percentAt(e)
  if (p >= props.zoom.start && p <= props.zoom.end + cellPercent.value) {
    grab = p - props.zoom.start
  } else {
    grab = span.value / 2
    moveTo(p - grab)
  }
  dragging = true
  root.value?.setPointerCapture(e.pointerId)
  root.value?.focus({ preventScroll: true })
}
function onMove(e: PointerEvent) {
  if (dragging) moveTo(percentAt(e) - grab)
}
function onUp() { dragging = false }

function onKey(e: KeyboardEvent) {
  const step = span.value / 4
  if (e.key === 'ArrowLeft') moveTo(props.zoom.start - step)
  else if (e.key === 'ArrowRight') moveTo(props.zoom.start + step)
  else if (e.key === 'Home') moveTo(0)
  else if (e.key === 'End') moveTo(100)
  else return
  e.preventDefault()
}

const LEGEND = [
  { label: 'Normal', cls: 'bg-strip' },
  { label: 'Early warning', cls: 'border border-warn bg-warnbg' },
  { label: TIER_STYLE.low.label, style: { background: `var(${TIER_STYLE.low.markerVar})` } },
  { label: TIER_STYLE.medium.label, style: { background: `var(${TIER_STYLE.medium.markerVar})` } },
  { label: TIER_STYLE.high.label, style: { background: `var(${TIER_STYLE.high.markerVar})` } },
  { label: 'Warm-up', cls: 'bg-strip', style: { backgroundImage: 'repeating-linear-gradient(-45deg, transparent 0 2px, var(--faint) 2px 3px)' } },
  { label: 'Restart', cls: 'border-l-2 border-primary bg-strip' },
]
</script>

<template>
  <div class="mt-3">
    <div class="mb-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <span class="text-xs font-medium text-muted-foreground">Each minute ({{ points.length }})</span>
      <ul class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground" aria-label="Minute strip legend">
        <li v-for="item in LEGEND" :key="item.label" class="flex items-center gap-1">
          <span class="inline-block h-2.5 w-3 rounded-[2px]" :class="item.cls" :style="item.style" aria-hidden="true" />
          {{ item.label }}
        </li>
      </ul>
    </div>
    <div
      ref="root"
      role="slider"
      tabindex="0"
      aria-label="Visible time window of the chart"
      aria-orientation="horizontal"
      aria-valuemin="0"
      :aria-valuemax="Math.round(100 - span)"
      :aria-valuenow="Math.round(zoom.start)"
      :aria-valuetext="windowText"
      class="relative h-8 w-full cursor-pointer touch-pan-y select-none rounded-sm bg-chip focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-coarse:h-11"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @keydown="onKey"
    >
      <canvas ref="canvas" class="absolute inset-0 size-full" aria-hidden="true" />
      <div class="pointer-events-none absolute inset-y-0 rounded-[3px] border-2 border-primary bg-primary/10" :style="brush" />
    </div>
  </div>
</template>
