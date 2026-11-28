<script setup lang="ts">
import type { NodeInfo, ProjectRow } from '@/types'
import { computed } from 'vue'
import ServerRow from '@/components/ServerRow.vue'
import { Skeleton } from '@/components/ui/skeleton'

const props = defineProps<{
  nodes: NodeInfo[]
  projects: ProjectRow[]
  loading: boolean
  failed: boolean
  loaded: boolean
}>()

const reporting = computed(() => props.nodes.filter(n => n.up === true).length)
const GRID = 'grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-4'
</script>

<template>
  <section aria-labelledby="servers-title" class="flex flex-col gap-3">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="servers-title" class="text-[15px] font-semibold">Servers</h2>
      <span v-if="loaded" class="text-xs text-muted-foreground">{{ reporting }} of {{ nodes.length }} reporting</span>
    </div>
    <div v-if="loading" :class="GRID">
      <Skeleton v-for="n in 2" :key="n" class="h-[150px] rounded-xl" />
    </div>
    <p v-else-if="failed && !loaded" class="rounded-xl border border-border p-4 text-[13px] text-muted-foreground" role="status">
      Prometheus did not answer. Retrying in 30 s.
    </p>
    <template v-else>
      <p v-if="failed" class="text-xs text-muted-foreground" role="status">Could not refresh. Showing the last loaded values.</p>
      <div :class="GRID">
        <ServerRow v-for="node in nodes" :key="node.key" :node="node" :projects="projects" />
      </div>
    </template>
  </section>
</template>
