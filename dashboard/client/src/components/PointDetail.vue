<script setup lang="ts">
import type { AnomalyPoint, Incident } from '@/types'
import { computed } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { fixed, localDateTime, orDash } from '@/lib/format'
import { explanationFallback } from '@/lib/incident'
import { TIER_STYLE, toTier } from '@/lib/tier'

const props = defineProps<{
  point: AnomalyPoint | null
  incident: Incident | null
  // Times of the warning, flag and restart minutes, sorted, for the step buttons.
  events: number[]
}>()
const emit = defineEmits<{ select: [time: number] }>()

const previous = computed(() => {
  const t = props.point?.time
  if (t === undefined) return null
  for (let i = props.events.length - 1; i >= 0; i--) if (props.events[i] < t) return props.events[i]
  return null
})
const next = computed(() => {
  const t = props.point?.time
  if (t === undefined) return null
  return props.events.find(e => e > t) ?? null
})

const SIGNAL_NAME: Record<string, string> = { cpu: 'CPU', memory: 'Memory', latency: 'Latency' }

// The fitted rise per minute in the unit people see elsewhere: cpu_rate is shown as percent of a
// core (as on the resource charts), memory in MB, latency in ms.
function slopeText(signal: string | null | undefined, slope: number): string {
  const value = signal === 'cpu' ? slope * 100 : slope
  const unit = signal === 'cpu' ? '% of a core' : signal === 'memory' ? 'MB' : signal === 'latency' ? 'ms' : ''
  const digits = Math.abs(value) < 10 ? 2 : 1
  return `${value.toFixed(digits)}${unit === '% of a core' ? '' : ' '}${unit}`.trim()
}

// One sentence group per state; any part whose field is missing is left out.
const sentence = computed(() => {
  const p = props.point
  if (!p) return ''
  if (p.warmup === 1) return 'Scored during warm-up after a restart, so it is never flagged.'
  if (p.early_warning !== 1) return ''
  const name = p.ew_signal ? (SIGNAL_NAME[p.ew_signal] ?? orDash(p.ew_signal)) : 'A metric'
  let text = `${name} is rising`
  if (typeof p.ew_slope === 'number') text += ` at about ${slopeText(p.ew_signal, p.ew_slope)} a minute`
  if (typeof p.ew_r2 === 'number') text += ` (R squared ${p.ew_r2.toFixed(2)})`
  text += '.'
  if (typeof p.ew_minutes === 'number') {
    text += ` At this rate it reaches its flag level in about ${Math.max(1, Math.round(p.ew_minutes))} minutes.`
  }
  return `${text} This is a heads-up only; nothing restarts from a warning.`
})

// [label, value, shown in mono]
const rows = computed(() => {
  const p = props.point
  if (!p) return []
  return [
    ['Score', fixed(p.score), true],
    ['Memory', p.memory_mb === null ? '-' : `${fixed(p.memory_mb, 1)} MB`, true],
    ['Tier', TIER_STYLE[toTier(p.tier)].label, false],
    ['Early warning', p.early_warning === 1 ? `Yes${p.ew_signal ? `, ${SIGNAL_NAME[p.ew_signal] ?? p.ew_signal}` : ''}` : 'No', false],
    ['Warm-up', p.warmup === 1 ? 'Yes' : 'No', false],
  ] as const
})

const step = 'min-h-9 flex-1 rounded-md border border-border px-2.5 text-[13px] font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent pointer-coarse:min-h-11'
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
      <p v-if="sentence" class="text-[13px] break-words">{{ sentence }}</p>

      <div class="flex gap-2">
        <button type="button" :class="step" :disabled="previous === null" @click="previous !== null && emit('select', previous)">Previous event</button>
        <button type="button" :class="step" :disabled="next === null" @click="next !== null && emit('select', next)">Next event</button>
      </div>

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
