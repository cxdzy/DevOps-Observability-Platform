<script lang="ts">
export type { ChatEntry, ReplyChip, ReplyKind } from './chatStore'
</script>

<script setup lang="ts">
import type { ChatEntry, ReplyChip } from './chatStore'
import { computed } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import ChatNotice from './ChatNotice.vue'
import { mytClock } from './chatStore'

const props = defineProps<{ entry: ChatEntry, disabled?: boolean }>()
const emit = defineEmits<{ openIncident: [start: number], choose: [chip: ReplyChip] }>()

// Template, guard and fallback replies (and the fixed action reply) get the dashed "Template
// answer" chip; model replies the filled "Local model" chip.
const source = computed(() => {
  const k = props.entry.kind
  if (!k) return null
  return k === 'llm' ? 'model' : 'template'
})

// "From incident records and the remediation log, 11.8 s".
const meta = computed(() => {
  const e = props.entry
  const parts: string[] = []
  const s = e.sources ?? []
  if (s.length) parts.push(`From ${s.length === 1 ? s[0] : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`}`)
  if (e.elapsedS !== undefined) parts.push(`${e.elapsedS.toFixed(1)} s`)
  return parts.join(', ')
})

const choices = computed(() => (props.entry.incidents ?? []).filter(i => i.choice))
const links = computed(() => (props.entry.incidents ?? []).filter(i => !i.choice))
</script>

<template>
  <!-- relative on each element with sr-only text keeps that text inside it instead of the page. -->
  <div v-if="entry.role === 'user'" class="relative max-w-[80%] self-end rounded-[14px_14px_4px_14px] bg-chip px-3.5 py-2.5 break-words whitespace-pre-wrap">
    <span class="sr-only">You: </span>{{ entry.text }}
  </div>

  <ChatNotice v-else-if="entry.notice" :kind="entry.notice" :text="entry.text" />

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

      <div v-if="choices.length" role="group" aria-label="Choose an incident" class="flex flex-wrap gap-1.5">
        <button
          v-for="incident in choices"
          :key="incident.start"
          type="button"
          class="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-3 text-xs text-foreground hover:bg-chip disabled:cursor-not-allowed disabled:opacity-50 md:min-h-8"
          :disabled="disabled"
          @click="emit('choose', incident)"
        >
          <TierBadge :tier="incident.tier" />
          <span class="font-mono">{{ mytClock(incident.start) }}</span>
          <span v-if="incident.signal">{{ incident.signal }}</span>
          <span class="sr-only">, ask what caused it</span>
        </button>
      </div>

      <div v-if="links.length" class="flex flex-wrap gap-1.5">
        <a
          v-for="incident in links"
          :key="incident.start"
          href="#incidents"
          class="relative inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground no-underline hover:bg-chip"
          @click="emit('openIncident', incident.start)"
        >
          <TierBadge :tier="incident.tier" />
          <span class="font-mono">{{ mytClock(incident.start) }}</span>
          <span class="sr-only">, open in Incidents</span>
        </a>
      </div>

      <div v-if="source || meta" class="flex flex-wrap items-center gap-2 text-xs text-faint">
        <span
          v-if="source === 'template'"
          class="inline-flex items-center rounded-full border border-dashed border-border px-2 py-px text-[11px] font-medium text-muted-foreground"
        >Template answer</span>
        <span
          v-else-if="source === 'model'"
          class="inline-flex items-center rounded-full bg-chip px-2 py-px text-[11px] font-medium text-foreground"
        >Local model</span>
        <span v-if="meta">{{ meta }}</span>
      </div>
    </div>
  </div>
</template>
