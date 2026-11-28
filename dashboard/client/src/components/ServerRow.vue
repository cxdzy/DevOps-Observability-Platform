<script setup lang="ts">
import type { NodeInfo, ProjectRow } from '@/types'
import { computed } from 'vue'
import { gigabytes, percentUsed } from '@/lib/format'

const props = defineProps<{ node: NodeInfo, projects: ProjectRow[] }>()

const METRICS = ['memoryTotalBytes', 'memoryAvailableBytes', 'diskSizeBytes', 'diskAvailableBytes', 'cpuCount', 'cpuBusy', 'containers'] as const

// Dashed "no data" style when the exporter is not up or Prometheus returned nothing at all.
const noData = computed(() => props.node.up !== true || METRICS.every(k => props.node[k] === null))

const name = computed(() => props.node.displayName)
const place = computed(() => [props.node.hostname, props.node.role, props.node.provider, props.node.location].filter(Boolean).join(' · '))
const hosted = computed(() => props.projects.filter(p => p.server.key === props.node.key).map(p => p.name))

function usage(total: number | null, available: number | null) {
  const used = total === null || available === null ? null : total - available
  return { used, total, percent: percentUsed(used, total) }
}
const memory = computed(() => usage(props.node.memoryTotalBytes, props.node.memoryAvailableBytes))
const disk = computed(() => usage(props.node.diskSizeBytes, props.node.diskAvailableBytes))

// okdot below 70 percent, amber from 70, red from 90.
function barClass(percent: number) {
  return percent >= 90 ? 'bg-tier-high-marker' : percent >= 70 ? 'bg-tier-medium-marker' : 'bg-okdot'
}

const cpu = computed(() => {
  const { cpuCount, cpuBusy } = props.node
  if (cpuCount === null && cpuBusy === null) return null
  const parts = []
  if (cpuCount !== null) parts.push(`${cpuCount} vCPU`)
  if (cpuBusy !== null) parts.push(`${Math.round(cpuBusy * 100)}% busy`)
  return parts.join(', ')
})

const border = computed(() => (noData.value ? 'border-dashed' : 'border-solid'))
</script>

<template>
  <article :aria-label="name" class="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border px-4 py-3" :class="border">
    <div class="flex items-center gap-2.5">
      <span class="size-2.5 shrink-0 rounded-full" :class="noData ? 'border-2 border-idle' : 'bg-okdot'" aria-hidden="true" />
      <span class="min-w-0 truncate font-mono font-medium">{{ name }}</span>
      <span
        class="ml-auto shrink-0 rounded-md px-2 py-px text-xs font-medium"
        :class="noData ? 'bg-chip text-chipfg' : 'bg-okbg text-ok'"
      >
        {{ noData ? 'No data' : 'Online' }}
      </span>
    </div>
    <p class="truncate font-mono text-[11px] text-muted-foreground" :title="place">{{ place }}</p>

    <p v-if="noData" class="text-[13px] text-muted-foreground">No data from this server</p>

    <template v-else>
      <dl class="flex flex-col gap-2">
        <div v-for="row in [{ label: 'Memory', u: memory }, { label: 'Disk', u: disk }]" :key="row.label" class="flex flex-col gap-1">
          <div class="flex justify-between gap-2.5 text-[13px]">
            <dt class="text-muted-foreground">{{ row.label }}</dt>
            <dd v-if="row.u.percent !== null" class="min-w-0 text-right"><span class="font-mono">{{ gigabytes(row.u.used) }}</span> of {{ gigabytes(row.u.total) }} GB</dd>
            <dd v-else class="text-muted-foreground">No data</dd>
          </div>
          <div
            v-if="row.u.percent !== null"
            class="h-1.5 rounded-full bg-track"
            role="img"
            :aria-label="`${row.u.percent} percent of ${row.label.toLowerCase()} used`"
          >
            <div class="h-1.5 rounded-full" :class="barClass(row.u.percent)" :style="{ width: `${Math.min(100, row.u.percent)}%` }" />
          </div>
          <div v-else class="h-1.5 rounded-full bg-track" aria-hidden="true" />
        </div>
      </dl>
      <dl class="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <div class="flex gap-1.5">
          <dt class="text-muted-foreground">Containers</dt>
          <dd><span v-if="node.containers !== null" class="font-mono">{{ node.containers }}</span><span v-else class="text-muted-foreground">No data</span></dd>
        </div>
        <div class="flex min-w-0 gap-1.5">
          <dt class="text-muted-foreground">CPU</dt>
          <dd class="min-w-0"><span v-if="cpu" class="font-mono">{{ cpu }}</span><span v-else class="text-muted-foreground">No data</span></dd>
        </div>
      </dl>
    </template>

    <p class="text-[13px] [overflow-wrap:anywhere]">
      <span class="text-muted-foreground">Projects: </span>
      <template v-if="hosted.length > 0">
        <template v-for="(projectName, i) in hosted" :key="projectName"><span class="font-mono">{{ projectName }}</span><span v-if="i < hosted.length - 1">, </span></template>
      </template>
      <span v-else class="text-muted-foreground">none</span>
    </p>
  </article>
</template>
