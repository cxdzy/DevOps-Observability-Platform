<script setup lang="ts">
import { computed, ref } from 'vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { useAuth } from '@/composables/useAuth'

const props = defineProps<{
  current: string
  // Incidents in the selected range, or null until they have been loaded.
  incidentCount: number | null
  hours: number
  // Champion model version (for example "10"), or null until the Model view has loaded it.
  championVersion: string | null
}>()

const { me, logout } = useAuth()

// Only the views that exist today, in their sidebar groups. Icons are 24 by 24 stroke paths.
const ALL_NAV = [
  {
    label: 'Monitoring',
    items: [
      { id: 'overview', label: 'Overview', icon: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z' },
      // Two stacked servers.
      { id: 'resources', label: 'Resources', icon: 'M4.5 4h15A1.5 1.5 0 0 1 21 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 9.5v-4A1.5 1.5 0 0 1 4.5 4zM4.5 13h15a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-4A1.5 1.5 0 0 1 4.5 13zM7 7.5h.01M7 16.5h.01' },
      { id: 'anomaly', label: 'Anomaly', icon: 'M3 12h4l3-8 4 16 3-8h4' },
      { id: 'incidents', label: 'Incidents', icon: 'M12 3 2.5 20h19zM12 10v4M12 17h.01' },
    ],
  },
  {
    label: 'Actions',
    items: [
      { id: 'remediation', label: 'Remediation', icon: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7' },
      { id: 'chat', label: 'Chat', icon: 'M4 5h16v11H9l-5 4V5z' },
    ],
  },
  {
    label: 'Results',
    items: [
      // A bar chart with a check mark.
      { id: 'evaluation', label: 'Evaluation', icon: 'M4 20V10M10 20V4M16 20v-7M3 20h18M18 5l1.5 1.5L22 4' },
      // A line over a column of bars.
      { id: 'drift', label: 'Drift', icon: 'M4 20V10M10 20V6M16 20v-8M3 8l5-3 5 4 7-5' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'model', label: 'Model', icon: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1' },
      // Sliders. Admins only.
      { id: 'settings', label: 'Settings', adminOnly: true, icon: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4' },
    ],
  },
]

// Viewers do not see the Settings item.
const NAV = computed(() => ALL_NAV.map(group => ({
  ...group,
  items: group.items.filter(item => !('adminOnly' in item && item.adminOnly) || me.value?.role === 'admin'),
})))

const roleLabel = computed(() => (me.value?.role === 'admin' ? 'Admin' : 'Viewer'))
const initials = computed(() => {
  const local = (me.value?.email ?? '').split('@')[0].replace(/[^a-z0-9]/gi, '')
  return (local.slice(0, 2) || '?').toUpperCase()
})
const rangeLabel = computed(() => (props.hours > 24 && props.hours % 24 === 0 ? `${props.hours / 24} d` : `${props.hours} h`))
const leaving = ref(false)
async function signOut() {
  leaving.value = true
  try {
    await logout()
  } finally {
    leaving.value = false
  }
}
</script>

<template>
  <aside class="flex flex-col gap-3 md:sticky md:top-2 md:h-[calc(100dvh-1rem)] md:w-[232px] md:shrink-0 md:gap-[18px] md:px-2 md:py-3">
    <div class="flex items-center gap-2.5 px-2 py-1">
      <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
      </span>
      <span class="flex min-w-0 flex-col leading-tight">
        <span class="font-semibold">Observability</span>
        <span class="truncate text-xs text-muted-foreground">Predictive monitoring</span>
      </span>
      <!-- Phone only: the user card and the top bar toggle are hidden there. -->
      <div class="ml-auto flex items-center gap-2 md:hidden">
        <span class="rounded-md bg-chip px-2 py-px text-xs font-medium text-chipfg">{{ roleLabel }}</span>
        <ThemeToggle class="size-11 bg-card" />
        <button
          type="button"
          class="min-h-11 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-chip disabled:opacity-50"
          :disabled="leaving"
          @click="signOut"
        >
          Log out
        </button>
      </div>
    </div>

    <!-- On phones the links scroll sideways; the scroll box clips, so their focus ring sits inside. -->
    <!-- On phones the groups merge into one row (display: contents) and their labels hide. The row
         scrolls sideways by touch, and focusing a link with the keyboard scrolls it into view; the
         scrollbar itself is hidden. -->
    <!-- relative on the row and on each link keeps their absolutely positioned sr-only text inside
         the scrolling row; without it that text is placed against the page and widens it on phones. -->
    <nav aria-label="Views" class="relative flex gap-1 overflow-x-auto [scrollbar-width:none] md:flex-col md:gap-3.5 md:overflow-visible [&::-webkit-scrollbar]:hidden">
      <div v-for="group in NAV" :key="group.label" class="max-md:contents md:flex md:flex-col md:gap-0.5">
        <span class="hidden px-2.5 pb-1 text-xs font-medium text-muted-foreground md:block">{{ group.label }}</span>
        <a
          v-for="item in group.items"
          :key="item.id"
          :href="`#${item.id}`"
          class="relative flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 no-underline max-md:[--focus-offset:-2px] md:min-h-0"
          :class="current === item.id
            ? 'bg-navon font-medium text-navonfg ring-1 ring-navring'
            : 'text-muted-foreground hover:bg-card hover:text-foreground'"
          :aria-current="current === item.id ? 'page' : undefined"
        >
          <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="item.icon" /></svg>
          {{ item.label }}
          <span
            v-if="item.id === 'incidents' && incidentCount !== null"
            class="ml-auto rounded-full border border-border bg-card px-[7px] font-mono text-[11px] text-foreground"
            :title="`${incidentCount} in the last ${rangeLabel}`"
          >
            {{ incidentCount }}<span class="sr-only"> in the last {{ rangeLabel }}</span>
          </span>
          <span
            v-if="item.id === 'model' && championVersion"
            class="ml-auto font-mono text-[11px]"
            :title="`Champion is version ${championVersion}`"
          >
            v{{ championVersion }}<span class="sr-only">, champion version</span>
          </span>
        </a>
      </div>
    </nav>

    <!-- Opens the full-screen exhibition view. Dashed, so it reads as a mode and not as a page. -->
    <a
      href="#exhibition"
      class="mt-auto hidden min-h-9 items-center gap-2.5 rounded-lg border border-dashed border-input px-2.5 py-2 text-[13px] text-foreground no-underline hover:bg-card md:flex"
    >
      <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
      Exhibition mode
    </a>

    <div v-if="me" class="hidden items-center gap-2.5 rounded-[10px] bg-card p-2 ring-1 ring-border md:flex">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground" aria-hidden="true">
        {{ initials }}
      </span>
      <span class="flex min-w-0 flex-col leading-tight">
        <span class="truncate text-[13px] font-medium" :title="me.email">{{ me.email }}</span>
        <span class="text-xs text-muted-foreground">{{ roleLabel }}</span>
      </span>
      <button
        type="button"
        class="ml-auto shrink-0 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-chip hover:text-foreground disabled:opacity-50"
        :disabled="leaving"
        @click="signOut"
      >
        Log out
      </button>
    </div>
  </aside>
</template>
