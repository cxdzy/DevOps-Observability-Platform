<script setup lang="ts">
import type { AnomalyPoint } from '@/types'
import { computed } from 'vue'
import { findEpisodes, isFlagged } from '@/components/MinuteStrip.vue'
import TierBadge from '@/components/TierBadge.vue'
import { fixed } from '@/lib/format'
import { FLAG_TIERS, TIER_STYLE, toTier } from '@/lib/tier'

const props = defineProps<{
  points: AnomalyPoint[]
}>()

const latest = computed(() => props.points[props.points.length - 1] ?? null)
const scored = computed(() => props.points.filter(p => p.score !== null).length)
const flagged = computed(() => props.points.filter(isFlagged))
const counts = computed(() =>
  FLAG_TIERS.map(tier => ({ tier, count: flagged.value.filter(p => toTier(p.tier) === tier).length })),
)
const warmupMinutes = computed(() => props.points.filter(p => p.warmup === 1).length)

// Episodes use the shared rule in MinuteStrip: a run of warning minutes, and a lead time to the
// first flag within 30 minutes after the run.
const episodes = computed(() => findEpisodes(props.points))
const lastEpisode = computed(() => episodes.value[episodes.value.length - 1] ?? null)
const episodeLine = computed(() => {
  const e = lastEpisode.value
  if (!e) return 'none in this range'
  return e.leadMinutes === null ? 'no flag followed' : `came ${e.leadMinutes} min before its first flag`
})

// State of the latest minute, as words and a chip style; never colour alone.
const state = computed(() => {
  const p = latest.value
  if (!p) return null
  if (isFlagged(p)) return { kind: 'flag' as const, tier: p.tier }
  if (p.early_warning === 1) return { kind: 'chip' as const, text: 'Early warning', cls: 'bg-warnbg text-warnfg' }
  if (p.warmup === 1) return { kind: 'chip' as const, text: 'Warm-up', cls: 'bg-chip text-chipfg' }
  return { kind: 'chip' as const, text: 'Normal', cls: 'bg-okbg text-ok' }
})

const latestLine = computed(() => {
  const p = latest.value
  if (!p) return ''
  const parts: string[] = []
  if (p.threshold !== null) parts.push(`threshold ${fixed(p.threshold)}`)
  if (p.model) parts.push(`model ${p.model}`)
  return parts.join(', ')
})

const chip = 'rounded-md px-1.5 py-px text-xs font-semibold whitespace-nowrap'
</script>

<template>
  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
    <section aria-label="Latest score" class="rounded-xl border border-border p-4">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[13px] text-muted-foreground">Latest score</span>
        <template v-if="state">
          <TierBadge v-if="state.kind === 'flag'" :tier="state.tier" />
          <span v-else :class="[chip, state.cls]">{{ state.text }}</span>
        </template>
      </div>
      <div class="mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]">{{ fixed(latest?.score) }}</div>
      <div v-if="latestLine" class="mt-0.5 text-xs text-muted-foreground">{{ latestLine }}</div>
    </section>

    <section aria-label="Early warnings" class="rounded-xl border border-border p-4">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[13px] text-muted-foreground">Early warnings</span>
        <span :class="[chip, 'bg-warnbg text-warnfg']">Watch only</span>
      </div>
      <div class="mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]">{{ episodes.length }}</div>
      <div class="mt-0.5 text-xs text-muted-foreground">{{ episodeLine }}</div>
    </section>

    <section aria-label="Flagged minutes" class="rounded-xl border border-border p-4">
      <div class="text-[13px] text-muted-foreground">Flagged minutes</div>
      <div class="mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]">{{ flagged.length }}</div>
      <div class="mt-1 flex flex-wrap gap-1.5">
        <span v-for="c in counts" :key="c.tier" class="rounded-md px-1.5 text-[11px] font-semibold" :class="TIER_STYLE[c.tier].badgeClass">
          {{ c.count }} {{ TIER_STYLE[c.tier].label }}
        </span>
      </div>
      <div class="mt-1 text-xs text-muted-foreground">of {{ scored }} scored minutes</div>
    </section>

    <section aria-label="Warm-up minutes" class="rounded-xl border border-border p-4">
      <div class="text-[13px] text-muted-foreground">Warm-up minutes</div>
      <div class="mt-2 font-mono text-[28px] font-medium tracking-[-0.02em]">{{ warmupMinutes }}</div>
      <div class="mt-0.5 text-xs text-muted-foreground">scored after a restart, never flagged</div>
    </section>
  </div>
</template>
