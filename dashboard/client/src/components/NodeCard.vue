<script setup lang="ts">
import type { NodeInfo } from '@/types'
import { computed } from 'vue'
import { gigabytes, percentUsed } from '@/lib/format'

const props = defineProps<{ node: NodeInfo }>()

const METRICS = ['memoryTotalBytes', 'memoryAvailableBytes', 'diskSizeBytes', 'diskAvailableBytes', 'cpuCount', 'cpuBusy', 'containers'] as const

// Dashed "no data" style when the exporter is not up or Prometheus returned nothing at all.
// A server that answers with some values missing shows "No data" on those rows only.
const noData = computed(() => props.node.up !== true || METRICS.every(k => props.node[k] === null))

const name = computed(() => props.node.hostname ?? (props.node.key === 'main' ? 'Main server' : 'Staging server'))
const place = computed(() => `${props.node.role} server, ${props.node.provider}, ${props.node.location}`)

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
  <article :aria-label="name" class="overflow-hidden rounded-xl border border-border" :class="border">
    <div class="flex items-center gap-3 border-b border-border px-4 py-3.5" :class="border">
      <span
        class="size-2.5 shrink-0 rounded-full"
        :class="noData ? 'border-2 border-idle' : 'bg-okdot'"
        aria-hidden="true"
      />
      <span class="flex min-w-0 flex-col">
        <span class="truncate font-mono font-medium">{{ name }}</span>
        <span class="text-xs text-muted-foreground">{{ place }}</span>
      </span>
      <span
        class="ml-auto shrink-0 rounded-md px-2 py-px text-xs font-medium"
        :class="noData ? 'bg-chip text-chipfg' : 'bg-okbg text-ok'"
      >
        {{ noData ? 'No data' : 'Online' }}
      </span>
    </div>

    <p v-if="noData" class="px-4 py-3 text-[13px] text-muted-foreground">No data from this server</p>

    <dl v-else>
      <div v-for="row in [{ label: 'Memory', u: memory }, { label: 'Disk', u: disk }]" :key="row.label" class="flex flex-col gap-2 border-b border-border px-4 py-3">
        <div class="flex justify-between gap-2.5">
          <dt class="text-muted-foreground">{{ row.label }}</dt>
          <dd v-if="row.u.percent !== null"><span class="font-mono">{{ gigabytes(row.u.used) }}</span> of {{ gigabytes(row.u.total) }} GB</dd>
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
      <div class="grid grid-cols-3">
        <div class="border-r border-border px-4 py-3">
          <dt class="text-xs text-muted-foreground">Containers</dt>
          <dd class="mt-0.5"><span v-if="node.containers !== null" class="font-mono">{{ node.containers }}</span><span v-else class="text-muted-foreground">No data</span></dd>
        </div>
        <div class="border-r border-border px-4 py-3">
          <dt class="text-xs text-muted-foreground">CPU</dt>
          <dd class="mt-0.5"><span v-if="cpu" class="font-mono">{{ cpu }}</span><span v-else class="text-muted-foreground">No data</span></dd>
        </div>
        <div class="px-4 py-3">
          <dt class="text-xs text-muted-foreground">Role</dt>
          <dd class="mt-0.5">{{ node.role }}</dd>
        </div>
      </div>
    </dl>
  </article>
</template>
