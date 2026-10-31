<script setup lang="ts">
import type { Incident, IncidentStatus } from '@/types'
import TierBadge from '@/components/TierBadge.vue'
import { clockTime, fixed, orDash, shortDate } from '@/lib/format'
import { STATUS_STYLE } from '@/lib/incident'

defineProps<{
  incidents: Incident[]
  selected: number | null
}>()
const emit = defineEmits<{ select: [start: number] }>()

// Theme colours for the status text; an open incident stands out.
const STATUS_CLASS: Record<IncidentStatus, string> = {
  open: 'rounded-md bg-primary px-1.5 py-px text-xs font-semibold text-primary-foreground',
  closed: 'text-muted-foreground',
  awaiting_explanation: 'text-muted-foreground',
}

const columns = 'grid grid-cols-[84px_96px_minmax(0,1fr)_64px_minmax(72px,auto)] items-center gap-3 px-4'
</script>

<template>
  <section aria-label="Incident list" class="overflow-hidden rounded-xl border border-border">
    <div class="max-h-[min(36rem,70vh)] overflow-auto">
      <div class="min-w-[560px]">
        <!-- Column titles for sighted users; each row button reads out its own values. -->
        <div :class="columns" class="sticky top-0 z-10 bg-chip py-2 text-xs font-medium text-muted-foreground" aria-hidden="true">
          <span>Start</span><span>Tier</span><span>Signal and action</span><span>Peak</span><span>Status</span>
        </div>
        <ul>
          <li v-for="incident in incidents" :key="`${incident.start}-${incident.status}`" class="border-t border-border">
            <!-- relative keeps the sr-only "Peak" text inside the scrolling list instead of the page. -->
            <button
              type="button"
              :class="[
                columns,
                selected === incident.start
                  ? 'bg-chip shadow-[inset_3px_0_0_var(--primary)] dark:bg-navon'
                  : 'hover:bg-chip/60',
              ]"
              class="relative w-full py-3 text-left [--focus-offset:-2px]"
              :aria-pressed="selected === incident.start"
              @click="emit('select', incident.start)"
            >
              <span class="flex flex-col leading-tight">
                <span class="font-mono font-medium">{{ clockTime(incident.start) }}</span>
                <span class="text-xs text-muted-foreground">{{ shortDate(incident.start) }}</span>
              </span>
              <span><TierBadge :tier="incident.tier" /></span>
              <span class="truncate text-muted-foreground">
                {{ orDash(incident.signal) }}, {{ orDash(incident.action) }}, {{ incident.minutes }} min<template v-if="incident.deployment">, after a deployment</template>
              </span>
              <span class="font-mono text-[13px]"><span class="sr-only">Peak </span>{{ fixed(incident.peakScore) }}</span>
              <span class="text-[13px]"><span :class="STATUS_CLASS[incident.status]">{{ STATUS_STYLE[incident.status].label }}</span></span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
