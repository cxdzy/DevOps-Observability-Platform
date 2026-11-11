<script setup lang="ts">
import type { ContainerCellState, ContainerRow, ContainersInfo } from '@/types'
import { computed, ref, watch } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { clockTime } from '@/lib/format'

// The Containers tab of Resources: memory share across containers and a table with a 24 hour
// strip per container, from cAdvisor through /api/resources/containers. The parent owns the node
// switch and the Refresh button; it passes the node and calls refresh().
const props = defineProps<{ node: string }>()
const emit = defineEmits<{ refreshed: [ok: boolean], busy: [busy: boolean] }>()

type SortKey = 'mem' | 'cpu' | 'name'
const SORTS: { key: SortKey, label: string }[] = [
  { key: 'mem', label: 'Memory' },
  { key: 'cpu', label: 'CPU' },
  { key: 'name', label: 'Name' },
]

const data = ref<ContainersInfo | null>(null)
const loading = ref(true)
const failed = ref(false)
const sort = ref<SortKey>('mem')

function valid(v: unknown): v is ContainersInfo {
  const r = v as ContainersInfo
  return typeof r === 'object' && r !== null && Array.isArray(r.containers)
}

async function load() {
  const wanted = props.node
  loading.value = true
  try {
    const res = await api.get<ContainersInfo>('/api/resources/containers', { params: { node: wanted } })
    // The node changed while this was loading; the queued load fetches the new one.
    if (wanted !== props.node) return
    if (!valid(res.data)) throw new Error('unexpected response')
    data.value = res.data
    failed.value = false
    emit('refreshed', true)
  } catch {
    if (wanted !== props.node) return
    failed.value = true
    emit('refreshed', false)
  } finally {
    loading.value = false
  }
}

// Every 30 seconds while the tab is shown (the parent mounts it only then).
const { refresh } = usePoll(load, 30000)
watch(() => props.node, () => {
  data.value = null
  failed.value = false
  refresh()
})
watch(loading, v => emit('busy', v), { immediate: true })
defineExpose({ refresh })

// Sizes: MiB below 1 GiB, otherwise GiB.
function size(bytes: number | null): string {
  if (bytes === null) return 'No data'
  const mib = bytes / 1024 ** 2
  if (mib < 1024) return `${mib >= 100 ? mib.toFixed(0) : mib.toFixed(1).replace(/\.0$/, '')} MiB`
  const gib = mib / 1024
  return `${gib >= 100 ? gib.toFixed(0) : gib.toFixed(1).replace(/\.0$/, '')} GiB`
}

// Memory share. Largest first; the legend names the top 6 and groups the rest as "others".
// Light greys go from dark (largest) to light, dark greys from bright (largest) to dim.
const SHARE_LIGHT = ['#18181B', '#3F3F46', '#52525B', '#71717A', '#8A8A93', '#A1A1AA', '#D4D4D8']
const SHARE_DARK = ['#E6EDF3', '#CBD4DE', '#B0BBC7', '#95A1AF', '#7A8795', '#5A6674', '#3A4452']
const TOP = 6

const memoryRows = computed(() =>
  (data.value?.containers ?? [])
    .filter((c): c is ContainerRow & { memBytes: number } => c.memBytes !== null && c.memBytes > 0)
    .sort((a, b) => b.memBytes - a.memBytes),
)
const containersBytes = computed(() => memoryRows.value.reduce((sum, c) => sum + c.memBytes, 0))
const shareParts = computed(() => {
  const rows = memoryRows.value
  const total = containersBytes.value
  if (total <= 0) return []
  const parts = rows.slice(0, TOP).map(c => ({ name: c.name, bytes: c.memBytes }))
  const rest = rows.slice(TOP)
  if (rest.length) parts.push({ name: 'others', bytes: rest.reduce((s, c) => s + c.memBytes, 0) })
  return parts.map((p, i) => ({
    ...p,
    width: (p.bytes / total) * 100,
    title: `${p.name} ${size(p.bytes)}`,
    // At most 7 parts, so the ramp always has a colour for each, and "others" gets the last one.
    colour: `--c-l:${SHARE_LIGHT[i]};--c-d:${SHARE_DARK[i]}`,
  }))
})
const shareLabel = computed(() => {
  const names = shareParts.value.filter(p => p.name !== 'others').map(p => p.name)
  if (!names.length) return 'Container memory share, no data'
  const hasOthers = shareParts.value.some(p => p.name === 'others')
  return `Container memory share: ${names[0]} largest${names.length > 1 ? `, then ${names.slice(1).join(', ')}` : ''}${hasOthers ? ' and the rest' : ''}`
})
const shareHeader = computed(() => {
  const d = data.value
  if (!d) return ''
  const parts: string[] = []
  if (d.memUsedBytes !== null && d.memTotalBytes !== null) parts.push(`${size(d.memUsedBytes)} of ${size(d.memTotalBytes)} in use`)
  if (containersBytes.value > 0) parts.push(`containers ${size(containersBytes.value)}`)
  return parts.join(', ')
})

// Sorting. Rows without a value go last for memory and CPU.
const rows = computed(() => {
  const list = [...(data.value?.containers ?? [])]
  const by = (k: 'memBytes' | 'cpuPct') => (a: ContainerRow, b: ContainerRow) => (b[k] ?? -1) - (a[k] ?? -1) || a.name.localeCompare(b.name)
  if (sort.value === 'name') return list.sort((a, b) => a.name.localeCompare(b.name))
  return list.sort(by(sort.value === 'cpu' ? 'cpuPct' : 'memBytes'))
})

// Memory against the limit: okdot, amber from 70 percent, red from 90 percent.
function limitShare(c: ContainerRow): number | null {
  return c.memBytes === null || c.limitBytes === null || c.limitBytes <= 0 ? null : (c.memBytes / c.limitBytes) * 100
}
function barClass(p: number) {
  return p >= 90 ? 'bg-red' : p >= 70 ? 'bg-amber' : 'bg-okdot'
}
function memText(c: ContainerRow): string {
  if (c.memBytes === null) return 'No data'
  const p = limitShare(c)
  return p === null ? size(c.memBytes) : `${size(c.memBytes)} of ${size(c.limitBytes)}`
}
function barLabel(c: ContainerRow): string {
  const p = limitShare(c)
  if (p === null) return ''
  return `${Math.round(p)} percent of its limit${p >= 90 ? ', above 90 percent' : p >= 70 ? ', above 70 percent' : ''}`
}

// The strip. One 3 px cell every 4 px. A restarted cell is taller and a no-data cell is a short
// bar, so colour is not the only cue (light up and no-data colours are close).
function cellHeight(state: ContainerCellState) {
  return state === 'restarted' ? 14 : state === 'nodata' ? 4 : 12
}
function cellY(state: ContainerCellState) {
  return (14 - cellHeight(state)) / 2
}
const STATE_NAME: Record<ContainerCellState, string> = {
  up: 'up',
  restarted: 'restarted',
  over70: 'over 70 percent of its limit',
  nodata: 'no data',
}
function cellFill(state: ContainerCellState) {
  return state === 'up' ? 'fill-stripup' : state === 'restarted' ? 'fill-primary' : state === 'over70' ? 'fill-amber' : 'fill-track'
}
function stripWidth(c: ContainerRow) {
  return Math.max(1, c.cells.length) * 4
}
function duration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ')
}
// A sentence for the strip, for example "up the whole time" or "restarted at 16:42".
function stripLabel(c: ContainerRow): string {
  const step = (data.value?.stepSeconds ?? 900) / 60
  const count = (s: ContainerCellState) => c.cells.filter(x => x.state === s).length
  if (!c.cells.length) return `${c.name}, no data for the last 24 hours`
  const parts: string[] = []
  const restarted = c.cells.filter(x => x.state === 'restarted')
  // A restart is only known to be inside a 15 minute cell, so the label gives the cell.
  const between = (t: number) => `between ${clockTime(t - step * 60000)} and ${clockTime(t)}`
  if (restarted.length) parts.push(`restarted ${restarted.length === 1 ? between(restarted[0].t) : `${restarted.length} times, first ${between(restarted[0].t)}`}`)
  if (count('over70')) parts.push(`over 70 percent of its limit for ${duration(count('over70') * step)}`)
  if (count('nodata')) parts.push(count('nodata') === c.cells.length ? 'no data' : `no data for ${duration(count('nodata') * step)}`)
  if (!parts.length) parts.push('up the whole time')
  else if (count('up') === c.cells.length) parts.unshift('up')
  return `${c.name} over the last 24 hours, ${parts.join(', ')}`
}
function cellTitle(t: number, state: ContainerCellState) {
  return `${clockTime(t - ((data.value?.stepSeconds ?? 900) * 1000))} to ${clockTime(t)}, ${STATE_NAME[state]}`
}
</script>

<template>
  <div v-if="failed && !data" class="flex flex-col items-start gap-3 rounded-xl border border-border p-4" role="alert">
    <p class="text-[13px] text-muted-foreground">Prometheus did not answer. Retrying in 30 s.</p>
    <button type="button" class="min-h-9 rounded-lg border border-border px-3.5 text-[13px] font-medium hover:bg-chip pointer-coarse:min-h-11" @click="refresh">
      Retry now
    </button>
  </div>

  <template v-else>
    <p v-if="failed" class="text-xs text-muted-foreground" role="status">Could not refresh. Showing the last loaded values. Retrying in 30 s.</p>

    <section aria-labelledby="share-title" class="flex flex-col gap-2.5 rounded-xl border border-border px-4 py-4">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="share-title" class="text-[15px] font-semibold">Where the memory goes</h2>
        <span v-if="data" class="text-xs text-muted-foreground">{{ shareHeader }}</span>
      </div>
      <Skeleton v-if="!data" class="h-[22px] rounded-md" />
      <p v-else-if="!shareParts.length" class="text-[13px] text-muted-foreground">No data</p>
      <template v-else>
        <div class="flex h-[22px] overflow-hidden rounded-md bg-chip" role="img" :aria-label="shareLabel">
          <span
            v-for="p in shareParts"
            :key="p.name"
            class="block h-full min-w-px border-r-2 border-card bg-[var(--c-l)] dark:bg-[var(--c-d)]"
            :style="`${p.colour};width:${p.width}%`"
            :title="p.title"
          />
        </div>
        <ul class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <li v-for="p in shareParts" :key="p.name" class="inline-flex items-center gap-1.5">
            <span class="size-2.5 rounded-[2px] bg-[var(--c-l)] dark:bg-[var(--c-d)]" :style="p.colour" aria-hidden="true" />
            <span class="font-mono">{{ p.title }}</span>
          </li>
        </ul>
      </template>
    </section>

    <section aria-labelledby="containers-title" class="overflow-hidden rounded-xl border border-border">
      <div class="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3.5">
        <h2 id="containers-title" class="text-[15px] font-semibold">Containers</h2>
        <div role="group" aria-label="Sort by" class="flex gap-0.5 rounded-lg bg-chip p-[3px]">
          <button
            v-for="s in SORTS"
            :key="s.key"
            type="button"
            class="inline-flex min-h-7 items-center rounded-md px-2.5 text-[13px] pointer-coarse:min-h-11"
            :class="sort === s.key ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="sort === s.key"
            @click="sort = s.key"
          >
            {{ s.label }}
          </button>
        </div>
      </div>

      <!-- The table scrolls inside its card, so the page never scrolls sideways. -->
      <div class="overflow-x-auto">
        <div class="min-w-[900px]">
          <div class="grid grid-cols-[170px_80px_210px_72px_minmax(0,1fr)] gap-3.5 bg-chip px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>Container</span>
            <span>CPU</span>
            <span>Memory</span>
            <span>Restarts (24 h)</span>
            <span>Last 24 hours, one cell per 15 min</span>
          </div>

          <template v-if="!data">
            <div v-for="n in 6" :key="n" class="border-t border-border px-4 py-2.5">
              <Skeleton class="h-6 rounded-md" />
            </div>
          </template>
          <p v-else-if="!rows.length" class="border-t border-border px-4 py-4 text-[13px] text-muted-foreground">No data</p>
          <template v-else>
            <div
              v-for="c in rows"
              :key="c.name"
              class="grid grid-cols-[170px_80px_210px_72px_minmax(0,1fr)] items-center gap-3.5 border-t border-border px-4 py-2"
            >
              <span class="flex min-w-0 items-center gap-2">
                <span
                  class="size-2 shrink-0 rounded-full"
                  :class="c.memBytes !== null ? 'bg-okdot' : 'border-2 border-idle'"
                  aria-hidden="true"
                />
                <span class="truncate font-mono text-[13px]" :title="c.name">{{ c.name }}</span>
                <span v-if="c.memBytes === null" class="sr-only">not running now</span>
              </span>
              <span class="font-mono text-[13px]" :class="c.cpuPct === null ? 'text-muted-foreground' : ''">
                {{ c.cpuPct === null ? 'No data' : `${c.cpuPct.toFixed(1)}%` }}
              </span>
              <span class="flex min-w-0 flex-col gap-1">
                <span class="font-mono text-[13px]" :class="c.memBytes === null ? 'text-muted-foreground' : ''">
                  {{ memText(c) }}<template v-if="limitShare(c) !== null"> ({{ Math.round(limitShare(c) as number) }}%)</template>
                </span>
                <span v-if="c.memBytes !== null && limitShare(c) !== null" class="h-1.5 overflow-hidden rounded-full bg-track" role="img" :aria-label="barLabel(c)">
                  <span class="block h-1.5 rounded-full" :class="barClass(limitShare(c) as number)" :style="{ width: `${Math.max(2, Math.min(100, limitShare(c) as number))}%` }" />
                </span>
                <span v-else-if="c.memBytes !== null" class="text-[11px] text-faint">no limit</span>
              </span>
              <span class="font-mono text-[13px]" :class="c.restarts24h === null ? 'text-muted-foreground' : ''">
                {{ c.restarts24h === null ? 'No data' : c.restarts24h }}
              </span>
              <svg :viewBox="`0 0 ${stripWidth(c)} 14`" width="100%" preserveAspectRatio="none" class="block h-3.5" role="img" :aria-label="stripLabel(c)">
                <rect
                  v-for="(cell, i) in c.cells"
                  :key="cell.t"
                  :x="i * 4"
                  :y="cellY(cell.state)"
                  width="3"
                  :height="cellHeight(cell.state)"
                  rx="1"
                  :class="cellFill(cell.state)"
                >
                  <title>{{ cellTitle(cell.t, cell.state) }}</title>
                </rect>
              </svg>
            </div>
          </template>
        </div>
      </div>

      <ul class="flex flex-wrap gap-x-3.5 gap-y-1 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <li class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[2px] bg-stripup" aria-hidden="true" />Up</li>
        <li class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[2px] bg-primary" aria-hidden="true" />Restarted</li>
        <li class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[2px] bg-amber" aria-hidden="true" />Over 70% of its limit</li>
        <li class="inline-flex items-center gap-1.5"><span class="h-1 w-2.5 rounded-[1px] bg-track" aria-hidden="true" />No data</li>
      </ul>
    </section>

    <p class="text-xs text-muted-foreground">
      Read live from cAdvisor through Prometheus. CPU is percent of one core over 5 minutes. A container with no memory limit shows "no limit".
    </p>
  </template>
</template>
