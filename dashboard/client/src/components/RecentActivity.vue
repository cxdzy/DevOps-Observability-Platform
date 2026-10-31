<script setup lang="ts">
import type { ActivityItem } from '@/types'
import TierBadge from '@/components/TierBadge.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { clockTime, fixed, orDash, shortDate } from '@/lib/format'

defineProps<{
  items: ActivityItem[]
  loading: boolean
  failed: boolean
  loaded: boolean
}>()

const SIGNAL_LABEL: Record<string, string> = { cpu: 'CPU spike', memory: 'Memory rise', latency: 'Latency spike' }
const ACTION_LABEL: Record<string, string> = { notify: 'notify only', restart: 'restart', rollback: 'rollback' }

function title(item: ActivityItem): string {
  if (item.type === 'incident') return (item.signal && SIGNAL_LABEL[item.signal]) || `Incident, ${orDash(item.signal)}`
  if (item.type === 'deployment') return 'sample-service deployed'
  return 'Model retraining'
}

function detail(item: ActivityItem): string {
  if (item.type === 'incident') {
    const action = item.action ? (ACTION_LABEL[item.action] ?? item.action) : 'no action'
    return `${item.minutes} min, peak ${fixed(item.peakScore)}, ${action}`
  }
  if (item.type === 'deployment') {
    const commit = item.commit ? `commit ${item.commit.slice(0, 7)}` : 'commit unknown'
    return `${commit}, CI${item.branch ? ` on ${item.branch}` : ''}`
  }
  const f1 = item.promoted ? item.challengerF1 : item.championF1
  const score = f1 === null ? '' : ` (F1 ${fixed(f1, 4)})`
  if (item.promoted) return `promoted ${item.newVersion ? `version ${item.newVersion}` : 'a new version'}${score}`
  return `kept ${item.championVersion ? `version ${item.championVersion}` : 'the champion'}${score}`
}

const CHIP = 'rounded-md px-1.5 text-[11px] font-semibold'
</script>

<template>
  <section aria-labelledby="activity-title" class="flex flex-col gap-3 rounded-xl border border-border px-[18px] py-4">
    <div class="flex items-center justify-between gap-2">
      <h2 id="activity-title" class="text-[15px] font-semibold">Recent activity</h2>
      <a href="#incidents" class="rounded text-[13px] text-muted-foreground underline underline-offset-3 hover:text-foreground">View incidents</a>
    </div>

    <div v-if="loading" class="flex flex-col gap-3">
      <Skeleton v-for="n in 4" :key="n" class="h-10 rounded-lg bg-chip" />
    </div>
    <p v-else-if="failed && !loaded" class="text-[13px] text-muted-foreground" role="status">
      InfluxDB did not answer. Retrying in 30 s.
    </p>
    <p v-else-if="items.length === 0" class="text-[13px] text-muted-foreground">No activity in the last 7 days</p>
    <ol v-else class="flex flex-col">
      <li v-for="item in items" :key="`${item.type}-${item.time}`" class="flex gap-3 border-b border-border py-2.5 last:border-b-0">
        <span class="flex w-12 shrink-0 flex-col pt-0.5 font-mono text-xs leading-tight text-muted-foreground">
          <span>{{ clockTime(item.time) }}</span>
          <span class="font-sans">{{ shortDate(item.time) }}</span>
        </span>
        <span class="flex min-w-0 flex-col gap-1">
          <span class="flex flex-wrap items-center gap-1.5">
            <TierBadge v-if="item.type === 'incident'" :tier="item.tier" />
            <span v-else :class="CHIP" class="bg-chip text-chipfg">{{ item.type === 'deployment' ? 'Deploy' : 'Model' }}</span>
            <span class="font-medium">{{ title(item) }}</span>
          </span>
          <span class="text-xs text-muted-foreground">{{ detail(item) }}</span>
        </span>
      </li>
    </ol>
    <p v-if="failed && loaded" class="text-xs text-muted-foreground" role="status">Could not refresh. Showing the last loaded activity.</p>
  </section>
</template>
