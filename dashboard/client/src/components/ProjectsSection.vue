<script setup lang="ts">
import type { ProjectCardData } from '@/lib/overviewFleet'
import ProjectCard from '@/components/ProjectCard.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { EMPTY_TEXT, ERROR_TEXT } from '@/lib/overviewProjects'

// The Projects section of the Overview. The server returns active projects only, so every
// card received is shown.
defineProps<{
  projects: ProjectCardData[]
  loading: boolean
  loaded: boolean
  failed: boolean
  isAdmin: boolean
}>()

const note = 'rounded-xl border border-border p-4 text-[13px] text-muted-foreground'
</script>

<template>
  <section aria-labelledby="projects-title" class="flex flex-col gap-3">
    <div class="flex items-baseline justify-between gap-3">
      <h2 id="projects-title" class="text-[15px] font-semibold">Projects</h2>
      <span class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        <span v-if="loaded" class="text-xs text-muted-foreground">{{ projects.length }} active</span>
        <a
          v-if="isAdmin"
          href="#settings"
          class="inline-flex items-center rounded-md border border-dashed border-input px-2 py-0.5 text-xs text-muted-foreground hover:bg-chip hover:text-foreground pointer-coarse:min-h-11"
        >Add a project</a>
      </span>
    </div>

    <div v-if="loading && !loaded" class="grid grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))] gap-4">
      <Skeleton v-for="n in 2" :key="n" class="h-[300px] rounded-xl" />
    </div>
    <p v-else-if="failed && !loaded" :class="note" role="status">{{ ERROR_TEXT }}</p>
    <template v-else>
      <p v-if="failed" class="text-xs text-muted-foreground" role="status">Could not refresh. Showing the last loaded values.</p>
      <p v-if="projects.length === 0" :class="note" role="status">{{ EMPTY_TEXT }}</p>
      <div v-if="projects.length > 0" class="grid grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))] gap-4">
        <ProjectCard v-for="p in projects" :key="p.key" :data="p" />
      </div>
    </template>
  </section>
</template>
