<script setup lang="ts">
import type { Incident, IncidentStatus } from '@/types'
import { computed } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { clockTime, fixed, localDateTime, orDash } from '@/lib/format'
import { explanationFallback, STATUS_STYLE } from '@/lib/incident'

const props = defineProps<{ incident: Incident | null }>()

const STATUS_CLASS: Record<IncidentStatus, string> = {
  open: 'bg-primary text-primary-foreground',
  closed: 'bg-chip text-chipfg',
  awaiting_explanation: 'bg-chip text-chipfg',
}
const SOURCE_LABEL: Record<string, string> = { llm: 'LLM', template: 'Template' }

// The explainer writes three labelled lines. When all three are there they get their own
// headings; any other text is shown as it is.
const sections = computed(() => {
  const text = props.incident?.explanation
  if (!text) return null
  const find = (label: string) => {
    const match = text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, 'im'))
    return match ? match[1].trim() : null
  }
  const what = find('What happened')
  const cause = find('Likely cause')
  const next = find('Next step')
  return what && cause && next ? { what, cause, next } : null
})

const facts = computed(() => {
  const i = props.incident
  if (!i) return []
  return [
    ['Duration', `${i.minutes} min`, true],
    ['Peak score', fixed(i.peakScore), true],
    ['Signal', orDash(i.signal), false],
    ['Action', orDash(i.action), false],
    ['Deployment', i.deployment ? 'Yes' : 'None', false],
    ['Written by', i.source ? (SOURCE_LABEL[i.source] ?? i.source) : '-', false],
  ] as const
})
</script>

<template>
  <aside aria-label="Incident detail" class="flex flex-col gap-4 rounded-xl border border-border px-5 py-[18px]">
    <p v-if="!incident" class="text-[13px] text-muted-foreground">Select an incident to see its explanation</p>
    <template v-else>
      <div class="flex items-start justify-between gap-2.5">
        <div>
          <h2 class="text-[15px] font-semibold">Incident at <span class="font-mono">{{ clockTime(incident.start) }}</span></h2>
          <p class="font-mono text-xs text-muted-foreground">{{ localDateTime(incident.start) }}</p>
        </div>
        <span class="flex shrink-0 flex-wrap justify-end gap-1.5">
          <TierBadge :tier="incident.tier" />
          <span class="rounded-md px-1.5 py-px text-xs font-semibold" :class="STATUS_CLASS[incident.status]">{{ STATUS_STYLE[incident.status].label }}</span>
        </span>
      </div>

      <dl class="grid grid-cols-2 overflow-hidden rounded-[10px] border border-border sm:grid-cols-3">
        <div v-for="[label, value, mono] in facts" :key="label" class="-mr-px -mb-px border-r border-b border-border px-3 py-2.5">
          <dt class="text-xs text-muted-foreground">{{ label }}</dt>
          <dd class="mt-0.5 break-words" :class="mono ? 'font-mono' : ''">{{ value }}</dd>
        </div>
      </dl>

      <div v-if="sections" class="flex flex-col gap-3.5">
        <div>
          <h3 class="text-[13px] font-semibold">What happened</h3>
          <p class="mt-1 break-words">{{ sections.what }}</p>
        </div>
        <div>
          <h3 class="text-[13px] font-semibold">Likely cause</h3>
          <p class="mt-1 break-words">{{ sections.cause }}</p>
        </div>
        <div class="rounded-[10px] bg-chip px-3.5 py-3">
          <h3 class="text-[13px] font-semibold">Next step</h3>
          <p class="mt-1 break-words">{{ sections.next }}</p>
        </div>
      </div>
      <p v-else class="break-words whitespace-pre-wrap" :class="incident.explanation ? '' : 'text-muted-foreground'">
        {{ incident.explanation ?? explanationFallback(incident) }}
      </p>

      <a href="#anomaly" class="inline-flex min-h-9 w-fit items-center rounded-lg border border-border px-3.5 text-[13px] font-medium text-foreground no-underline hover:bg-chip">
        Show the score chart
      </a>
    </template>
  </aside>
</template>
