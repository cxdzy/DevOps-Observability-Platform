<script setup lang="ts">
import type { Incident } from '@/types'
import TierBadge from '@/components/TierBadge.vue'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fixed, localDateTime, orDash } from '@/lib/format'
import { STATUS_STYLE } from '@/lib/incident'
import { TIER_STYLE, toTier } from '@/lib/tier'

defineProps<{
  incidents: Incident[]
  selected: number | null
}>()
const emit = defineEmits<{ select: [start: number] }>()
</script>

<template>
  <ScrollArea class="h-[min(32rem,70vh)]">
    <ol class="relative ml-2 flex flex-col gap-3 border-l border-border py-1 pr-3 pl-5">
      <li v-for="incident in incidents" :key="`${incident.start}-${incident.status}`" class="relative">
        <span
          class="absolute top-4 -left-[1.6rem] size-3 rounded-full ring-2 ring-background"
          :style="{ backgroundColor: TIER_STYLE[toTier(incident.tier)].color }"
          aria-hidden="true"
        />
        <button
          type="button"
          class="w-full rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          :class="[
            incident.status === 'open' ? 'border-violet-500 ring-2 ring-violet-200' : 'border-border',
            selected === incident.start ? 'bg-muted' : '',
          ]"
          :aria-pressed="selected === incident.start"
          @click="emit('select', incident.start)"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ localDateTime(incident.start) }}</span>
            <span class="text-muted-foreground">{{ incident.minutes }} min</span>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <TierBadge :tier="incident.tier" />
            <Badge :class="STATUS_STYLE[incident.status].badgeClass">{{ STATUS_STYLE[incident.status].label }}</Badge>
            <Badge v-if="incident.deployment" variant="outline">deployment</Badge>
          </div>
          <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            <span>signal: {{ orDash(incident.signal) }}</span>
            <span>action: {{ orDash(incident.action) }}</span>
            <span>peak: <span class="font-mono">{{ fixed(incident.peakScore) }}</span></span>
          </div>
        </button>
      </li>
    </ol>
  </ScrollArea>
</template>
