<script setup lang="ts">
import { computed } from 'vue'

// A semicircle gauge drawn in SVG. okdot below 70 percent, amber from 70, red from 90. The number
// is always written in the middle, so colour is never the only cue.
const props = defineProps<{
  label: string
  // Percent, or null when there is no value. Values over 100 fill the arc and still show in full.
  percent: number | null
  detail: string
}>()

const RADIUS = 46
const LENGTH = Math.PI * RADIUS
const ARC = 'M14 62 A46 46 0 0 1 106 62'

const hasValue = computed(() => props.percent !== null && Number.isFinite(props.percent))
const text = computed(() => (hasValue.value ? `${(props.percent as number).toFixed(1)}%` : 'No data'))
const dash = computed(() => {
  const p = hasValue.value ? Math.max(0, Math.min(100, props.percent as number)) : 0
  return `${((p / 100) * LENGTH).toFixed(1)} ${LENGTH.toFixed(1)}`
})
const colour = computed(() => {
  const p = props.percent ?? 0
  return p >= 90 ? 'stroke-red' : p >= 70 ? 'stroke-amber' : 'stroke-okdot'
})
const level = computed(() => {
  const p = props.percent ?? 0
  return p >= 90 ? ', above 90 percent' : p >= 70 ? ', above 70 percent' : ''
})
const aria = computed(() =>
  hasValue.value ? `${props.label} ${(props.percent as number).toFixed(1)} percent${level.value}` : `${props.label}, no data`,
)
</script>

<template>
  <div class="flex min-w-0 flex-col rounded-xl border border-border px-3.5 py-3">
    <div class="text-[13px] text-muted-foreground">{{ label }}</div>
    <svg viewBox="0 0 120 70" class="mx-auto mt-1 block w-full max-w-[150px]" role="img" :aria-label="aria">
      <path :d="ARC" fill="none" class="stroke-track" stroke-width="10" stroke-linecap="round" />
      <path v-if="hasValue" :d="ARC" fill="none" :class="colour" stroke-width="10" stroke-linecap="round" :stroke-dasharray="dash" />
      <text
        x="60"
        y="60"
        text-anchor="middle"
        class="fill-foreground font-mono"
        :font-size="hasValue ? 18 : 13"
        font-weight="500"
      >{{ text }}</text>
    </svg>
    <div class="text-center text-xs text-muted-foreground">{{ detail }}</div>
  </div>
</template>
