<script lang="ts">
export type ReplyKind = 'template' | 'guard' | 'llm' | 'fallback' | 'action_unavailable'

// One line of the conversation. Kept in the Chat view's state only.
export interface ChatEntry {
  id: number
  role: 'user' | 'assistant'
  text: string
  kind?: ReplyKind
  sources?: string[]
  elapsedS?: number
  incidents?: { start: number, tier: string | null }[]
  // The request failed; text is the reason shown to the user.
  error?: boolean
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { clockTime } from '@/lib/format'

const props = defineProps<{ entry: ChatEntry }>()
const emit = defineEmits<{ openIncident: [start: number] }>()

// "From incident records and the remediation log, 11.8 s", plus "template answer" for replies
// that did not come from the model.
const meta = computed(() => {
  const e = props.entry
  const parts: string[] = []
  const s = e.sources ?? []
  if (s.length) parts.push(`From ${s.length === 1 ? s[0] : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`}`)
  if (e.elapsedS !== undefined) parts.push(`${e.elapsedS.toFixed(1)} s`)
  if (e.kind && e.kind !== 'llm') parts.push('template answer')
  const text = parts.join(', ')
  return text ? text[0].toUpperCase() + text.slice(1) : ''
})
</script>

<template>
  <!-- relative on each element with sr-only text keeps that text inside it instead of the page. -->
  <div v-if="entry.role === 'user'" class="relative max-w-[80%] self-end rounded-[14px_14px_4px_14px] bg-chip px-3.5 py-2.5 break-words whitespace-pre-wrap">
    <span class="sr-only">You: </span>{{ entry.text }}
  </div>

  <div v-else class="flex max-w-[92%] gap-3">
    <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
    </span>
    <div class="flex min-w-0 flex-col gap-2.5">
      <p
        class="relative m-0 break-words"
        :class="entry.error ? 'rounded-lg bg-tier-high-bg px-3 py-2 text-[13px] text-tier-high-fg' : ''"
        :role="entry.error ? 'alert' : undefined"
      >
        <span class="sr-only">Assistant: </span>{{ entry.text }}
      </p>
      <div v-if="entry.incidents?.length" class="flex flex-wrap gap-1.5">
        <a
          v-for="incident in entry.incidents"
          :key="incident.start"
          href="#incidents"
          class="relative inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground no-underline hover:bg-chip"
          @click="emit('openIncident', incident.start)"
        >
          <TierBadge :tier="incident.tier" />
          <span class="font-mono">{{ clockTime(incident.start) }}</span>
          <span class="sr-only">, open in Incidents</span>
        </a>
      </div>
      <span v-if="meta" class="text-xs text-faint">{{ meta }}</span>
    </div>
  </div>
</template>
