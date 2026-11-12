<script setup lang="ts">
import type { ProjectContainer, ProjectRow, ProjectStatus, StripState } from '@/types'
import { computed, ref, watch } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { clockTime, shortDate } from '@/lib/format'
import { toMs } from '@/types'

// Every registered project with its health, its last 24 hours and its deployment and rollback state.
// Only registered projects are shown. A value the API did not return is shown as "No data".
const props = defineProps<{ query: string }>()
const emit = defineEmits<{ 'refreshed': [ok: boolean], 'update:query': [query: string] }>()

const projects = ref<ProjectRow[]>([])
const loading = ref(true)
const failed = ref(false)
const refreshing = ref(false)

async function load() {
  refreshing.value = true
  try {
    const res = await api.get<ProjectRow[]>('/api/projects')
    if (!Array.isArray(res.data)) throw new Error('unexpected response')
    projects.value = res.data.map(p => ({
      ...p,
      containers: Array.isArray(p.containers) ? p.containers : [],
      strip: Array.isArray(p.strip) ? p.strip : [],
    }))
    listLoaded = true
    dropUnknown()
    failed.value = false
    emit('refreshed', true)
  } catch {
    failed.value = true
    emit('refreshed', false)
  } finally {
    refreshing.value = false
    loading.value = false
  }
}
const { refresh } = usePoll(load, 30000)

// ---------------------------------------------------------------- selection, kept in the hash

function projectFromQuery(query: string): string | null {
  return new URLSearchParams(query).get('project') || null
}
const picked = ref<string | null>(projectFromQuery(props.query))
let listLoaded = false
watch(() => props.query, (query) => {
  picked.value = projectFromQuery(query)
  if (listLoaded) dropUnknown()
})

// A key in the hash that is not (or no longer) a registered project is dropped, so a copied link
// names the project that is shown.
function dropUnknown() {
  if (!picked.value || projects.value.some(p => p.key === picked.value)) return
  picked.value = null
  if (window.location.hash.startsWith('#projects?')) history.replaceState(null, '', '#projects')
  if (props.query !== '') emit('update:query', '')
}

// The project shown in the detail panel: the chosen one, or the first when none (or an unknown one) is chosen.
const selected = computed(() => projects.value.find(p => p.key === picked.value) ?? projects.value[0] ?? null)

// A history.replaceState does not fire hashchange, so the new query is also sent to the parent.
function choose(key: string) {
  picked.value = key
  const query = `project=${encodeURIComponent(key)}`
  const hash = `#projects?${query}`
  if (window.location.hash !== hash) history.replaceState(null, '', hash)
  if (props.query !== query) emit('update:query', query)
}

// ---------------------------------------------------------------- numbers

const serverCount = computed(() => new Set(projects.value.map(p => p.server?.key)).size)
const healthy = computed(() => projects.value.filter(p => p.status === 'healthy').length)
const incidents = computed(() => projects.value.filter(p => p.status === 'incident').length)
const watched = computed(() => projects.value.filter(p => p.watchedByModel).length)
// A project counts as deployed today when its latest deploy is on today's local date.
const deployedToday = computed(() => {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return projects.value.filter((p) => {
    const at = toMs(p.lastDeploy?.at)
    return at !== null && at >= start.getTime()
  }).length
})
// Rollback ready means this platform can roll the project back (through n8n, after approval).
const rollbackReady = computed(() => projects.value.filter(p => p.rollback?.mode === 'n8n').length)

// ---------------------------------------------------------------- display

function zoneName(): string {
  try {
    return new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}
const zone = zoneName()
const zoneSuffix = zone ? ` (${zone})` : ''
function stamp(value: number | string | null | undefined): string {
  const ms = toMs(value)
  return ms === null ? 'No data' : `${shortDate(ms)} ${clockTime(ms)}`
}

const STATUS_TEXT: Record<ProjectStatus, string> = {
  healthy: 'Healthy',
  incident: 'Incident',
  partial: 'Partly down',
  down: 'Down',
  no_data: 'No data',
}
const STATUS_CLASS: Record<ProjectStatus, string> = {
  healthy: 'bg-okbg text-ok',
  incident: 'bg-tier-medium-bg text-tier-medium-fg',
  partial: 'bg-tier-medium-bg text-tier-medium-fg',
  down: 'bg-tier-high-bg text-tier-high-fg',
  no_data: 'border border-dashed border-input text-chipfg',
}
const DOT_CLASS: Record<ProjectStatus, string> = {
  healthy: 'bg-okdot',
  incident: 'bg-amber',
  partial: 'bg-amber',
  down: 'bg-red',
  no_data: 'border-[1.5px] border-idle',
}
function statusText(s: ProjectStatus): string {
  return STATUS_TEXT[s] ?? 'No data'
}

// Strip cells. Colour comes from the theme tokens. Shape is a second cue: a deploy is full height,
// a restart is shorter, and no data is a short bar.
const CELL_NAME: Record<StripState, string> = {
  up: 'up',
  deploy: 'deploy',
  restart: 'restart',
  incident: 'incident',
  down: 'down',
  nodata: 'no data',
}
const CELL_FILL: Record<StripState, string> = {
  up: 'fill-stripup',
  deploy: 'fill-primary',
  restart: 'fill-primary',
  incident: 'fill-amber',
  down: 'fill-red',
  nodata: 'fill-track',
}
const CELL_HEIGHT: Record<StripState, number> = { up: 12, deploy: 14, restart: 8, incident: 14, down: 14, nodata: 4 }
function cell(state: StripState): StripState {
  return state in CELL_NAME ? state : 'nodata'
}
function cellY(state: StripState): number {
  return (14 - CELL_HEIGHT[cell(state)]) / 2
}
function stripLabel(p: ProjectRow): string {
  const count = (s: StripState) => p.strip.filter(c => c === s).length
  const parts: string[] = []
  for (const s of ['incident', 'down', 'deploy', 'restart', 'nodata'] as const) {
    const n = count(s)
    if (n) parts.push(`${n} ${CELL_NAME[s]} ${n === 1 ? 'period' : 'periods'} of 15 minutes`)
  }
  return `${p.name}, last 24 hours: ${parts.length ? parts.join(', ') : 'up the whole time'}`
}

const LEGEND: { state: StripState, label: string }[] = [
  { state: 'up', label: 'Up' },
  // Deploy and restart share a colour; in the strip a restart is the shorter mark.
  { state: 'deploy', label: 'Deploy or restart' },
  { state: 'incident', label: 'Incident' },
  { state: 'down', label: 'Down' },
  { state: 'nodata', label: 'No data' },
]

function size(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return 'No data'
  const mib = bytes / 1024 ** 2
  if (mib < 1024) return `${mib >= 100 ? mib.toFixed(0) : mib.toFixed(1).replace(/\.0$/, '')} MiB`
  const gib = mib / 1024
  return `${gib >= 100 ? gib.toFixed(0) : gib.toFixed(1).replace(/\.0$/, '')} GiB`
}
function limitShare(c: ProjectContainer): number | null {
  return c.memBytes === null || !c.limitBytes || c.limitBytes <= 0 ? null : (c.memBytes / c.limitBytes) * 100
}
// The progress bar thresholds of the Containers tab: amber from 70 percent, red from 90.
function barClass(p: number): string {
  return p >= 90 ? 'bg-red' : p >= 70 ? 'bg-amber' : 'bg-okdot'
}
function barLabel(p: number): string {
  return `${Math.round(p)} percent of its limit${p >= 90 ? ', above 90 percent' : p >= 70 ? ', above 70 percent' : ''}`
}

const ROLLBACK_TITLE: Record<string, string> = {
  n8n: 'Rollback after approval',
  own_pipeline: 'Rollback handled elsewhere',
  none: 'No rollback',
}
function rollbackTitle(p: ProjectRow): string {
  return ROLLBACK_TITLE[p.rollback?.mode] ?? 'Rollback'
}
// A rollback that can be asked for now is amber. One this platform cannot do, or not right now,
// is drawn dashed, like the other "not here" boxes.
function rollbackClass(p: ProjectRow): string {
  const rb = p.rollback
  if (rb?.mode === 'n8n' && rb.ready === true) return 'bg-tier-medium-bg text-tier-medium-fg'
  if (rb?.mode === 'own_pipeline' || rb?.mode === 'none' || (rb?.mode === 'n8n' && rb.ready === false)) return 'border border-dashed border-input text-chipfg'
  return 'bg-chip text-foreground'
}
function automationText(value: string): string {
  return value === 'approval' ? 'Restart and rollback with approval' : value === 'monitored' ? 'Monitored only' : value || 'No data'
}
function shortRef(p: ProjectRow): string {
  const ref = p.lastDeploy?.ref ?? ''
  return p.lastDeploy?.source === 'ci' ? ref.slice(0, 7) : ref
}

const card = 'rounded-xl border border-border p-4'
const bigNumber = 'mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]'
const GRID = 'grid grid-cols-[minmax(0,1.3fr)_120px_minmax(0,1fr)_minmax(0,1.2fr)] gap-3'
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-[-0.02em]">Projects</h1>
      <p class="mt-0.5 text-[13px] text-muted-foreground">Every project registered in Settings, with its own health, deployments and rollback.</p>
    </div>
    <button
      type="button"
      class="inline-flex min-h-8 items-center gap-2 rounded-lg border border-border px-3 text-xs hover:bg-chip pointer-coarse:min-h-11"
      :aria-busy="loading || refreshing"
      @click="refresh"
    >
      <svg class="size-3.5" :class="loading || refreshing ? 'animate-spin motion-reduce:animate-none' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
      {{ loading || refreshing ? 'Refreshing' : 'Refresh' }}
    </button>
  </div>

  <template v-if="loading">
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <Skeleton v-for="n in 5" :key="n" class="h-[116px] rounded-xl" />
    </div>
    <Skeleton class="h-[240px] rounded-xl" />
  </template>

  <p v-else-if="failed && projects.length === 0" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    The projects could not be loaded. Retrying in 30 s.
  </p>

  <template v-else>
    <p v-if="failed" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      Projects could not be refreshed. Showing the last loaded data.
    </p>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
      <section aria-label="Projects and servers" :class="card">
        <div class="text-[13px] text-muted-foreground">Projects</div>
        <div :class="bigNumber">{{ projects.length }}</div>
        <div class="mt-0.5 text-xs text-muted-foreground">on {{ serverCount }} {{ serverCount === 1 ? 'server' : 'servers' }}</div>
      </section>
      <section aria-label="Healthy projects" :class="card">
        <div class="text-[13px] text-muted-foreground">Healthy</div>
        <div :class="bigNumber">{{ healthy }}</div>
        <div class="mt-0.5 text-xs text-muted-foreground">{{ incidents ? `${incidents} incident${incidents === 1 ? '' : 's'} open` : 'no incident open' }}</div>
      </section>
      <section aria-label="Watched by a model" :class="card">
        <div class="text-[13px] text-muted-foreground">Watched by a model</div>
        <div :class="bigNumber">{{ watched }}</div>
        <div class="mt-0.5 text-xs text-muted-foreground">{{ projects.length - watched }} not watched</div>
      </section>
      <section aria-label="Deployed today" :class="card">
        <div class="text-[13px] text-muted-foreground">Deployed today</div>
        <div :class="bigNumber">{{ deployedToday }}</div>
        <div class="mt-0.5 text-xs text-muted-foreground">projects whose latest deploy is today</div>
      </section>
      <section aria-label="Rollback ready" :class="card">
        <div class="text-[13px] text-muted-foreground">Rollback ready</div>
        <div :class="bigNumber">{{ rollbackReady }}</div>
        <div class="mt-0.5 text-xs text-muted-foreground">of {{ projects.length }} can be rolled back from here</div>
      </section>
    </div>

    <p v-if="projects.length === 0" class="rounded-lg bg-chip p-3 text-[13px] text-chipfg" role="status">
      No projects are registered yet. An admin can add one in Settings.
    </p>

    <div v-else class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <section aria-labelledby="projects-list-title" class="min-w-0 overflow-hidden rounded-xl border border-border">
        <h2 id="projects-list-title" class="px-4 py-3 text-[15px] font-semibold">All projects</h2>
        <!-- Below 768 px the rows keep 640 px and the card scrolls sideways. From 768 px up the columns
             shrink to the card instead, and the strip's cells get narrower, so the whole 24 h stays in view. -->
        <div class="relative max-md:overflow-x-auto">
          <div class="max-md:min-w-[640px]">
            <div :class="GRID" class="bg-chip px-4 py-2 text-xs font-medium text-muted-foreground">
              <span>Project</span><span>Status</span><span>Last deploy</span><span>Last 24 hours</span>
            </div>
            <button
              v-for="p in projects"
              :key="p.key"
              type="button"
              :class="GRID"
              class="w-full items-center border-t border-border px-4 py-3 text-left hover:bg-chip pointer-coarse:min-h-11"
              :style="selected?.key === p.key ? 'box-shadow: inset 3px 0 0 var(--primary)' : undefined"
              :aria-pressed="selected?.key === p.key"
              @click="choose(p.key)"
            >
              <span class="flex min-w-0 flex-col">
                <span class="flex items-center gap-2">
                  <span class="size-2 shrink-0 rounded-full" :class="DOT_CLASS[p.status] ?? DOT_CLASS.no_data" aria-hidden="true" />
                  <span class="min-w-0 font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{{ p.name }}</span>
                </span>
                <span class="truncate text-xs text-muted-foreground">on {{ p.server?.name ?? 'No data' }}</span>
              </span>
              <span class="w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold" :class="STATUS_CLASS[p.status] ?? STATUS_CLASS.no_data">{{ statusText(p.status) }}</span>
              <span class="flex min-w-0 flex-col text-[13px]">
                <template v-if="p.lastDeploy">
                  <span class="font-mono">{{ stamp(p.lastDeploy.at) }}</span>
                  <span class="text-xs text-muted-foreground">{{ p.lastDeploy.source === 'ci' ? 'Verified' : 'Detected' }}</span>
                </template>
                <span v-else class="text-muted-foreground">No deploy recorded</span>
              </span>
              <svg viewBox="0 0 384 14" width="100%" preserveAspectRatio="none" class="block h-3.5" role="img" :aria-label="stripLabel(p)">
                <rect
                  v-for="(state, i) in p.strip"
                  :key="i"
                  :x="i * 4"
                  :y="cellY(state)"
                  width="3"
                  :height="CELL_HEIGHT[cell(state)]"
                  rx="1"
                  :class="CELL_FILL[cell(state)]"
                >
                  <title>{{ CELL_NAME[cell(state)] }}</title>
                </rect>
              </svg>
            </button>
          </div>
        </div>
        <ul class="flex flex-wrap gap-x-3.5 gap-y-1 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <li v-for="l in LEGEND" :key="l.state" class="inline-flex items-center gap-1.5">
            <span class="inline-block rounded-[2px]" :class="[l.state === 'nodata' ? 'h-1 w-2.5' : 'size-2.5', { up: 'bg-stripup', deploy: 'bg-primary', restart: 'bg-primary', incident: 'bg-amber', down: 'bg-red', nodata: 'bg-track' }[l.state]]" aria-hidden="true" />
            {{ l.label }}
          </li>
        </ul>
        <p class="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">Each mark is 15 minutes. Times are local{{ zoneSuffix }}.</p>
      </section>

      <section v-if="selected" :aria-label="`${selected.name} details`" class="flex min-w-0 flex-col gap-4 rounded-xl border border-border p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <h2 class="font-mono text-[15px] font-semibold [overflow-wrap:anywhere]">{{ selected.name }}</h2>
            <p class="text-xs text-muted-foreground">on {{ selected.server?.name ?? 'No data' }}</p>
          </div>
          <span class="rounded-full px-2.5 py-0.5 text-xs font-semibold" :class="STATUS_CLASS[selected.status] ?? STATUS_CLASS.no_data">{{ statusText(selected.status) }}</span>
        </div>

        <div class="flex flex-col gap-2">
          <h3 class="text-[13px] font-semibold">Containers</h3>
          <p v-if="selected.containers.length === 0" class="text-[13px] text-muted-foreground">No containers.</p>
          <ul v-else class="flex flex-col divide-y divide-border">
            <li v-for="c in selected.containers" :key="c.name" class="flex flex-col gap-1 py-2 text-[13px]">
              <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                <span class="min-w-0 font-mono [overflow-wrap:anywhere]">{{ c.name }}</span>
                <span class="inline-flex items-center gap-1.5 text-xs">
                  <span class="size-2 rounded-full" :class="c.up === true ? 'bg-okdot' : c.up === false ? 'bg-red' : 'border-[1.5px] border-idle'" aria-hidden="true" />
                  {{ c.up === true ? 'Up' : c.up === false ? 'Down' : 'No data' }}
                </span>
              </div>
              <div class="text-xs text-muted-foreground">
                Restarts in 24 h: <span class="font-mono text-foreground">{{ c.restarts24h === null || c.restarts24h === undefined ? 'No data' : c.restarts24h }}</span>
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-mono text-xs" :class="c.memBytes === null ? 'text-muted-foreground' : ''">
                  <template v-if="c.memBytes === null || c.memBytes === undefined">Memory: No data</template>
                  <template v-else-if="limitShare(c) === null">Memory {{ size(c.memBytes) }}, No limit</template>
                  <template v-else>Memory {{ size(c.memBytes) }} of {{ size(c.limitBytes) }} ({{ Math.round(limitShare(c) as number) }}%)</template>
                </span>
                <span v-if="limitShare(c) !== null" class="h-1.5 overflow-hidden rounded-full bg-track" role="img" :aria-label="barLabel(limitShare(c) as number)">
                  <span class="block h-1.5 rounded-full" :class="barClass(limitShare(c) as number)" :style="{ width: `${Math.max(2, Math.min(100, limitShare(c) as number))}%` }" />
                </span>
              </div>
            </li>
          </ul>
        </div>

        <div class="flex flex-col gap-1.5">
          <h3 class="text-[13px] font-semibold">Last deploy</h3>
          <template v-if="selected.lastDeploy">
            <div class="flex flex-wrap items-center gap-2 text-[13px]">
              <span class="font-mono">{{ stamp(selected.lastDeploy.at) }}{{ zoneSuffix }}</span>
              <span
                class="rounded-full px-2.5 py-0.5 text-xs font-semibold"
                :class="selected.lastDeploy.source === 'ci' ? 'bg-foreground text-card' : 'bg-chip text-chipfg'"
              >{{ selected.lastDeploy.source === 'ci' ? 'Verified' : 'Detected' }}</span>
            </div>
            <p class="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{{ shortRef(selected) }}</p>
          </template>
          <p v-else class="text-[13px] text-muted-foreground">No deploy recorded.</p>
          <a :href="`#pipeline?project=${encodeURIComponent(selected.key)}`" class="w-fit text-xs text-muted-foreground underline">All runs of {{ selected.name }}</a>
        </div>

        <div class="rounded-[10px] px-3 py-2.5 text-[13px]" :class="rollbackClass(selected)">
          <div class="font-medium">{{ rollbackTitle(selected) }}</div>
          <div class="mt-0.5">{{ selected.rollback?.text || 'No data' }}</div>
        </div>

        <div class="flex flex-col gap-1 text-[13px]">
          <h3 class="font-semibold">Automation</h3>
          <p>{{ automationText(selected.automation) }}</p>
          <p class="text-xs text-muted-foreground">{{ selected.watchedByModel ? 'Watched by an anomaly model.' : 'Not watched by an anomaly model.' }}</p>
        </div>
      </section>
    </div>
  </template>
</template>
