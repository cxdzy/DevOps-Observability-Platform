<script setup lang="ts">
import type { ProjectCardData } from '@/lib/overviewFleet'
import { computed, onUnmounted, ref, watch } from 'vue'
import { DOT_CLASS, STATUS_CLASS } from '@/components/ProjectsView.vue'
import ForecastChip from '@/components/ForecastChip.vue'
import { clockTime, shortDate } from '@/lib/format'
import { CELL_FILL, CELL_HEIGHT, CELL_NAME, cell, cellY, mergeStrip, pickMerge, stripLabel } from '@/lib/projectStrip'
import { toMs } from '@/types'

// One project of the fleet: header, four figures, the 24 hour strip and a footer.
const props = defineProps<{ data: ProjectCardData }>()

const stripEl = ref<HTMLElement | null>(null)
const stripWidth = ref<number | null>(null)
let observer: ResizeObserver | null = null
watch(stripEl, (el) => {
  observer?.disconnect()
  observer = null
  if (!el || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => { stripWidth.value = el.getBoundingClientRect().width })
  observer.observe(el)
})
onUnmounted(() => observer?.disconnect())

const merge = computed(() => pickMerge(stripWidth.value))
const cells = computed(() => mergeStrip(props.data.strip, merge.value))
const label = computed(() => stripLabel(props.data.name, cells.value, merge.value))

const deployTime = computed(() => {
  const ms = toMs(props.data.lastDeploy?.at)
  return ms === null ? 'No data' : `${shortDate(ms)} ${clockTime(ms)}`
})

// The progress bar thresholds of the Containers tab: amber from 70 percent, red from 90.
function barClass(p: number): string {
  return p >= 90 ? 'bg-red' : p >= 70 ? 'bg-amber' : 'bg-okdot'
}
function barLabel(p: number): string {
  return `${Math.round(p)} percent of its limit${p >= 90 ? ', above 90 percent' : p >= 70 ? ', above 70 percent' : ''}`
}
const rollbackClass = computed(() => {
  const rb = props.data.rollback
  if (rb.mode === 'n8n' && rb.ready === true) return 'bg-tier-medium-bg text-tier-medium-fg'
  if (rb.mode === 'own_pipeline' || rb.mode === 'none' || (rb.mode === 'n8n' && rb.ready === false)) return 'border border-dashed border-input text-chipfg'
  return 'bg-chip text-foreground'
})

const dt = 'text-xs text-muted-foreground'
const dd = 'mt-1 font-mono text-lg font-medium tracking-[-0.02em] [overflow-wrap:anywhere]'
const sub = 'mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]'
const link = 'inline-flex items-center rounded text-xs underline underline-offset-3 hover:text-foreground pointer-coarse:min-h-11'
</script>

<template>
  <article class="flex min-w-0 flex-col rounded-xl border border-border" :aria-label="data.name">
    <header class="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-3">
      <span class="size-2 shrink-0 rounded-full" :class="DOT_CLASS[data.status] ?? DOT_CLASS.no_data" aria-hidden="true" />
      <a
        :href="data.href"
        :aria-label="`${data.name} in Projects`"
        class="min-w-0 rounded font-mono text-[13px] font-medium underline underline-offset-3 hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:inline-flex pointer-coarse:items-center [overflow-wrap:anywhere]"
      >{{ data.name }}</a>
      <span class="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">on {{ data.server }}</span>
      <span class="ml-auto flex flex-wrap items-center gap-2">
        <span class="rounded-md bg-chip px-2 py-px text-xs font-medium text-chipfg">{{ data.modelLabel }}</span>
        <span class="rounded-full px-2.5 py-0.5 text-xs font-semibold" :class="STATUS_CLASS[data.status] ?? STATUS_CLASS.no_data">{{ data.statusText }}</span>
      </span>
    </header>

    <dl class="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-border px-4 py-3 sm:grid-cols-4">
      <div class="min-w-0">
        <dt :class="dt">Anomaly score</dt>
        <dd :class="[dd, data.figures.score.kind === 'value' ? '' : 'text-sm text-muted-foreground']">{{ data.figures.score.text }}</dd>
        <p v-if="data.figures.score.sub" :class="sub">{{ data.figures.score.sub }}</p>
      </div>
      <div class="min-w-0">
        <dt :class="dt">Memory</dt>
        <dd :class="dd">{{ data.figures.memory.text }}</dd>
        <span v-if="data.figures.memory.percent !== null" class="mt-1 block h-1.5 overflow-hidden rounded-full bg-track" role="img" :aria-label="barLabel(data.figures.memory.percent)">
          <span class="block h-1.5 rounded-full" :class="barClass(data.figures.memory.percent)" :style="{ width: `${Math.max(2, Math.min(100, data.figures.memory.percent))}%` }" />
        </span>
        <p :class="sub">{{ data.figures.memory.sub }}</p>
      </div>
      <div class="min-w-0">
        <dt :class="dt">Containers</dt>
        <dd :class="dd">{{ data.figures.containers.text }}</dd>
        <p :class="sub">{{ data.figures.containers.sub }}</p>
      </div>
      <div class="min-w-0">
        <dt :class="dt">Incidents, 6 h</dt>
        <dd :class="[dd, data.figures.incidents.kind === 'value' ? '' : 'text-sm text-muted-foreground']">{{ data.figures.incidents.text }}</dd>
        <p v-if="data.figures.incidents.sub" :class="sub">{{ data.figures.incidents.sub }}</p>
      </div>
    </dl>

    <div class="px-4 pt-3">
      <div class="mb-1 text-xs text-muted-foreground">Last 24 hours</div>
      <div ref="stripEl">
        <svg :viewBox="`0 0 ${cells.length * 4} 14`" width="100%" preserveAspectRatio="none" class="block h-3.5" role="img" :aria-label="label">
          <rect
            v-for="(state, i) in cells"
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
      </div>
      <p class="mt-1 text-[11px] text-muted-foreground">Marks: up, deploy or restart, incident, down, no data. Hover a mark to read it.</p>
    </div>

    <footer class="mt-auto flex flex-col gap-2 px-4 py-3 text-[13px]">
      <ForecastChip v-if="data.forecast" kind="memory" :item="data.forecast" />
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span class="text-xs text-muted-foreground">Last deploy</span>
        <template v-if="data.lastDeploy">
          <span class="min-w-0 font-mono [overflow-wrap:anywhere]">{{ deployTime }}, {{ data.lastDeploy.ref }}</span>
          <span class="rounded-md bg-chip px-2 py-px text-xs font-medium text-chipfg">{{ data.lastDeploy.chip }}</span>
        </template>
        <span v-else class="text-muted-foreground">{{ data.lastDeployEmpty }}</span>
      </div>
      <div class="rounded-[10px] px-3 py-2 text-[13px] [overflow-wrap:anywhere]" :class="rollbackClass">
        <span class="font-medium">{{ data.rollback.title }}.</span> {{ data.rollback.text }}
      </div>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <a v-if="data.links.incidents" :href="data.links.incidents" :class="link">View incidents</a>
        <a :href="data.links.pipeline" :class="link">Pipeline</a>
      </div>
    </footer>
  </article>
</template>
