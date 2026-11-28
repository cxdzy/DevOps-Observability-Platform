<script setup lang="ts">
import type { ActivityRow, FilterOption } from '@/lib/overviewActivity'
import { computed, nextTick, ref, watch } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { clockTime, shortDate } from '@/lib/format'
import { emptyText, filterRows } from '@/lib/overviewActivity'

const MAX_ROWS = 12

const props = defineProps<{
  // Built with buildActivityRows, all projects, newest first.
  rows: ActivityRow[]
  options: FilterOption[]
  loading: boolean
  failed: boolean
  loaded: boolean
  projectsFailed?: boolean
  // Restarts in the last 24 hours by project key, used in the empty text.
  restartsByProject: Record<string, number>
}>()

const filter = ref('all')

// A project that disappears from the options falls back to All.
watch(
  () => props.options,
  (options) => {
    if (!options.some(o => o.value === filter.value)) filter.value = 'all'
  },
  { immediate: true },
)

const selected = computed(() => props.options.find(o => o.value === filter.value))
const visible = computed(() => filterRows(props.rows, filter.value).slice(0, MAX_ROWS))
const empty = computed(() =>
  filter.value === 'all'
    ? emptyText(null, 0)
    : emptyText({ name: selected.value?.label ?? filter.value }, props.restartsByProject[filter.value] ?? 0),
)

const buttons = ref<HTMLButtonElement[]>([])

async function choose(index: number) {
  const option = props.options[index]
  if (!option) return
  filter.value = option.value
  await nextTick()
  buttons.value[index]?.focus()
}

function onKey(event: KeyboardEvent, index: number) {
  const last = props.options.length - 1
  let next = -1
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = last
  if (next < 0) return
  event.preventDefault()
  void choose(next)
}

const CHIP = 'rounded-md px-1.5 text-[11px] font-semibold'
const CHIP_LABEL: Record<string, string> = { deployment: 'Deploy', detected: 'Deploy', retrain: 'Model' }
</script>

<template>
  <section aria-labelledby="activity-title" class="flex flex-col gap-3 rounded-xl border border-border px-[18px] py-4">
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <h2 id="activity-title" class="text-[15px] font-semibold">Recent activity</h2>
      <a href="#incidents" class="rounded text-[13px] text-muted-foreground underline underline-offset-3 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">View incidents</a>
    </div>

    <div
      v-if="options.length > 1"
      role="radiogroup"
      aria-label="Filter by project"
      class="flex min-w-0 flex-wrap gap-1 self-start rounded-lg bg-chip p-1"
    >
      <button
        v-for="(option, index) in options"
        :key="option.value"
        :ref="(el) => { if (el) buttons[index] = el as HTMLButtonElement }"
        type="button"
        role="radio"
        :aria-checked="filter === option.value"
        :tabindex="filter === option.value ? 0 : -1"
        class="min-w-0 max-w-full truncate rounded-md px-2.5 py-1 text-[13px] pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        :class="filter === option.value ? 'bg-background font-medium text-foreground ring-1 ring-border' : 'text-chipfg hover:text-foreground'"
        @click="choose(index)"
        @keydown="onKey($event, index)"
      >
        {{ option.label }}
      </button>
    </div>

    <div v-if="loading" class="flex flex-col gap-3">
      <Skeleton v-for="n in 4" :key="n" class="h-10 rounded-lg bg-chip" />
    </div>
    <p v-else-if="failed && !loaded" class="text-[13px] text-muted-foreground" role="status">
      InfluxDB did not answer. Retrying in 30 s.
    </p>
    <p v-else-if="visible.length === 0" class="text-[13px] text-muted-foreground">{{ empty }}</p>
    <ol v-else class="flex flex-col">
      <li v-for="row in visible" :key="row.key" class="flex gap-3 border-b border-border py-2.5 last:border-b-0">
        <span class="flex w-12 shrink-0 flex-col pt-0.5 font-mono text-xs leading-tight text-muted-foreground">
          <span>{{ clockTime(row.time) }}</span>
          <span class="font-sans">{{ shortDate(row.time) }}</span>
        </span>
        <span class="flex min-w-0 flex-col gap-1">
          <span class="flex flex-wrap items-center gap-1.5">
            <TierBadge v-if="row.kind === 'incident'" :tier="row.tier" />
            <span v-else :class="CHIP" class="bg-chip text-chipfg">{{ CHIP_LABEL[row.kind] }}</span>
            <span class="font-medium [overflow-wrap:anywhere]">{{ row.title }}</span>
          </span>
          <span class="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {{ row.detail }} · <span class="font-mono">{{ row.project }}</span>
          </span>
        </span>
      </li>
    </ol>
    <p v-if="failed && loaded" class="text-xs text-muted-foreground" role="status">Could not refresh. Showing the last loaded activity.</p>
    <p v-if="projectsFailed" class="text-xs text-muted-foreground" role="status">Could not load the project list. Activity from other projects may be missing.</p>
  </section>
</template>
