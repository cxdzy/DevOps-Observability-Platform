<script setup lang="ts">
import type { AnomalyPoint, Incident } from '@/types'
import { computed } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { fixed, orDash } from '@/lib/format'
import { FLAG_TIERS, TIER_STYLE, toTier } from '@/lib/tier'

const props = defineProps<{
  points: AnomalyPoint[]
  incidents: Incident[]
  incidentsFailed: boolean
}>()

const latest = computed(() => props.points[props.points.length - 1] ?? null)
const scored = computed(() => props.points.filter(p => p.score !== null).length)
const flaggedMinutes = computed(() => props.points.filter(p => p.is_anomaly === 1).length)
const counts = computed(() =>
  FLAG_TIERS.map(tier => ({
    tier,
    count: props.incidents.filter(i => toTier(i.tier) === tier).length,
  })),
)

// How far the latest score is from its threshold, only when both were returned.
const margin = computed(() => {
  const p = latest.value
  if (!p || p.score === null || p.threshold === null) return null
  const diff = p.score - p.threshold
  return `${fixed(Math.abs(diff))} ${diff < 0 ? 'below' : 'above'} the threshold`
})
</script>

<template>
  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
    <section aria-label="Latest score" class="rounded-xl border border-border p-4">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[13px] text-muted-foreground">Latest score</span>
        <TierBadge v-if="latest" :tier="latest.tier" />
      </div>
      <div class="mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]">{{ fixed(latest?.score) }}</div>
      <div v-if="margin" class="mt-0.5 text-xs text-muted-foreground">{{ margin }}</div>
    </section>

    <section aria-label="Flagged minutes" class="rounded-xl border border-border p-4">
      <div class="text-[13px] text-muted-foreground">Flagged minutes</div>
      <div class="mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]">{{ flaggedMinutes }}</div>
      <div class="mt-0.5 text-xs text-muted-foreground">of {{ scored }} scored minutes</div>
    </section>

    <section aria-label="Incidents by tier" class="rounded-xl border border-border p-4">
      <div class="text-[13px] text-muted-foreground">Incidents</div>
      <p v-if="incidentsFailed" class="mt-2.5 text-[13px] text-muted-foreground">Unavailable</p>
      <template v-else>
        <div class="mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]">{{ incidents.length }}</div>
        <div class="mt-1 flex flex-wrap gap-1.5">
          <span v-for="c in counts" :key="c.tier" class="rounded-md px-1.5 text-[11px] font-semibold" :class="TIER_STYLE[c.tier].badgeClass">
            {{ c.count }} {{ TIER_STYLE[c.tier].label }}
          </span>
        </div>
      </template>
    </section>

    <section aria-label="Threshold" class="rounded-xl border border-border p-4">
      <div class="text-[13px] text-muted-foreground">Threshold</div>
      <div class="mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]">{{ fixed(latest?.threshold) }}</div>
      <div v-if="latest?.model" class="mt-0.5 text-xs text-muted-foreground">model {{ orDash(latest.model) }}</div>
    </section>
  </div>
</template>
