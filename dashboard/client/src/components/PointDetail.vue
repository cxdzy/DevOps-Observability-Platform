<script setup lang="ts">
import type { AnomalyPoint, Incident } from '@/types'
import { computed } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { fixed, localDateTime, orDash } from '@/lib/format'
import { explanationFallback } from '@/lib/incident'

const props = defineProps<{
  point: AnomalyPoint | null
  incident: Incident | null
}>()

// [label, value, shown in mono]
const rows = computed(() => {
  const p = props.point
  if (!p) return []
  const deployed = p.recent_deployment === true || p.recent_deployment === 1
  return [
    ['Score', fixed(p.score), true],
    ['Threshold', fixed(p.threshold), true],
    ['Signal', orDash(p.signal), false],
    ['CPU rate', fixed(p.cpu_rate), true],
    ['Memory', p.memory_mb === null ? '-' : `${fixed(p.memory_mb, 1)} MB`, true],
    ['Latency', p.latency_ms === null ? '-' : `${fixed(p.latency_ms, 1)} ms`, true],
    ['Recent deployment', deployed ? 'Yes' : 'No', false],
    ['Model', orDash(p.model), true],
  ] as const
})
</script>

<template>
  <aside aria-label="Selected minute" class="flex flex-col gap-3 rounded-xl border border-border px-[18px] py-4">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-[15px] font-semibold">Selected minute</h2>
      <TierBadge v-if="point" :tier="point.tier" />
    </div>
    <p v-if="!point" class="text-[13px] text-muted-foreground">Click a point on the chart</p>
    <template v-else>
      <div class="font-mono text-[13px] text-muted-foreground">{{ localDateTime(point.time) }}</div>
      <dl class="grid grid-cols-[1fr_auto] text-[13px]">
        <template v-for="[label, value, mono] in rows" :key="label">
          <dt class="border-t border-border py-2 text-muted-foreground">{{ label }}</dt>
          <dd class="border-t border-border py-2 text-right break-all" :class="mono ? 'font-mono' : ''">{{ value }}</dd>
        </template>
      </dl>

      <div v-if="incident" class="flex flex-col gap-2 border-t border-border pt-3 text-[13px]">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium">Incident</span>
          <TierBadge :tier="incident.tier" />
          <span class="text-muted-foreground">action: {{ orDash(incident.action) }}</span>
        </div>
        <p class="break-words whitespace-pre-wrap">{{ incident.explanation ?? explanationFallback(incident) }}</p>
      </div>
      <p v-else class="mt-auto text-xs text-muted-foreground">This minute is not part of an incident. Flagged minutes show their incident here.</p>
    </template>
  </aside>
</template>
