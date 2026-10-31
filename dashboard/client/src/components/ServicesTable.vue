<script setup lang="ts">
import type { ServicesInfo } from '@/types'
import { computed } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'
import { megabytes } from '@/lib/format'

const props = defineProps<{
  services: ServicesInfo | null
  // Hostname of the main server, when /api/nodes returned it.
  host: string | null
  loading: boolean
  failed: boolean
}>()

// Expected containers first (running or missing), then any other running container.
const rows = computed(() => {
  const s = props.services
  if (!s) return []
  const running = new Map(s.containers.map(c => [c.name, c]))
  const expected = s.expected.map(e => ({ name: e.name, role: e.role, up: running.has(e.name), memoryBytes: running.get(e.name)?.memoryBytes ?? null }))
  const known = new Set(s.expected.map(e => e.name))
  const extra = s.containers.filter(c => !known.has(c.name)).map(c => ({ name: c.name, role: 'Not in compose', up: true, memoryBytes: c.memoryBytes }))
  return [...expected, ...extra]
})
const upCount = computed(() => rows.value.filter(r => r.up && r.role !== 'Not in compose').length)
const expectedCount = computed(() => props.services?.expected.length ?? 0)
const allUp = computed(() => upCount.value === expectedCount.value)

</script>

<template>
  <section aria-labelledby="services-title" class="overflow-hidden rounded-xl border border-border">
    <div class="flex flex-wrap items-center justify-between gap-2.5 px-[18px] py-3.5">
      <h2 id="services-title" class="text-[15px] font-semibold">
        Services<template v-if="host"> on <span class="font-mono">{{ host }}</span></template>
      </h2>
      <span
        v-if="services"
        class="rounded-md px-2 py-px text-xs font-medium"
        :class="allUp ? 'bg-okbg text-ok' : 'bg-tier-high-bg text-tier-high-fg'"
      >
        {{ upCount }} of {{ expectedCount }} up
      </span>
    </div>

    <div v-if="loading" class="flex flex-col gap-2 px-[18px] pb-4">
      <Skeleton v-for="n in 4" :key="n" class="h-8 rounded-lg bg-chip" />
    </div>
    <p v-else-if="failed && !services" class="px-[18px] pb-4 text-[13px] text-muted-foreground" role="status">
      Prometheus did not answer. Retrying in 30 s.
    </p>
    <p v-else-if="rows.length === 0" class="px-[18px] pb-4 text-[13px] text-muted-foreground">No containers reported</p>
    <template v-else>
      <p v-if="failed" class="px-[18px] pb-3 text-xs text-muted-foreground" role="status">Could not refresh. Showing the last loaded list.</p>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[640px] text-left">
          <thead class="bg-chip text-xs font-medium text-muted-foreground">
            <tr>
              <th scope="col" class="px-[18px] py-2 font-medium">Service</th>
              <th scope="col" class="px-[18px] py-2 font-medium">Role</th>
              <th scope="col" class="px-[18px] py-2 font-medium">Status</th>
              <th scope="col" class="px-[18px] py-2 font-medium">Memory</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.name" class="border-t border-border">
              <td class="px-[18px] py-2.5 font-mono text-[13px]">{{ row.name }}</td>
              <td class="px-[18px] py-2.5 text-muted-foreground">{{ row.role }}</td>
              <td class="px-[18px] py-2.5">
                <span class="inline-flex items-center gap-1.5">
                  <span class="size-2 rounded-full" :class="row.up ? 'bg-okdot' : 'bg-tier-high-marker'" aria-hidden="true" />
                  {{ row.up ? 'Up' : 'Missing' }}
                </span>
              </td>
              <td class="px-[18px] py-2.5 font-mono text-[13px]" :class="row.memoryBytes === null ? 'text-muted-foreground' : ''">
                {{ row.up ? megabytes(row.memoryBytes) : '-' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
