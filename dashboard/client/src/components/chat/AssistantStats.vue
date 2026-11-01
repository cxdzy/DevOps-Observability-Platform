<script lang="ts">
// GET /api/chat/stats. replies and the medians are null when the chat log is off or unreadable.
export interface ChatStats {
  model: string
  replies: number | null
  medianReplyS: number | null
  medianTokS: number | null
  questionsLeft: number
  perHour: number
  ollamaUp: boolean
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'

const props = defineProps<{ stats: ChatStats | null, loading: boolean, failed: boolean }>()

const NO_DATA = 'No data'
const rows = computed(() => {
  const s = props.stats
  if (!s) return []
  const none = s.replies === 0
  return [
    { label: 'Model', value: s.model },
    { label: 'Replies', value: s.replies === null ? NO_DATA : String(s.replies) },
    { label: 'Median reply time', value: none || s.medianReplyS === null ? NO_DATA : `${s.medianReplyS.toFixed(1)} s` },
    { label: 'Speed', value: none || s.medianTokS === null ? NO_DATA : `${s.medianTokS.toFixed(1)} tok/s` },
    { label: 'Questions left', value: `${s.questionsLeft} of ${s.perHour} per hour` },
  ]
})
</script>

<template>
  <aside aria-label="Assistant statistics" class="flex min-w-0 flex-col gap-4">
    <div>
      <h2 class="text-[15px] font-semibold">Assistant</h2>
      <div class="text-xs text-muted-foreground">Local model, last 24 hours</div>
    </div>

    <div v-if="loading && !stats" class="flex flex-col gap-2" aria-busy="true">
      <Skeleton v-for="n in 5" :key="n" class="h-8" />
    </div>

    <p v-else-if="failed && !stats" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
      The assistant statistics did not load. Retrying in 60 s.
    </p>

    <template v-else-if="stats">
      <p v-if="failed" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
        Could not refresh. Showing the last loaded values.
      </p>
      <dl class="m-0 flex flex-col text-[13px]">
        <div v-for="(row, i) in rows" :key="row.label" class="flex justify-between gap-2.5 border-t border-border py-2" :class="i === rows.length - 1 ? 'border-b' : ''">
          <dt class="text-muted-foreground">{{ row.label }}</dt>
          <dd class="m-0 min-w-0 text-right font-mono">{{ row.value }}</dd>
        </div>
      </dl>
      <p v-if="stats.replies === 0" class="text-xs text-muted-foreground">No model replies in the last 24 hours yet.</p>
    </template>

    <p class="text-xs text-muted-foreground">Each model reply is logged with its prompt, time and token count.</p>
  </aside>
</template>
