<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import SettingsLog from '@/components/SettingsLog.vue'
import SettingsProjects from '@/components/SettingsProjects.vue'
import SettingsServers from '@/components/SettingsServers.vue'
import { useAuth } from '@/composables/useAuth'

// Settings: servers, projects and the change log. Admin only; a viewer who opens the address sees
// a short notice and nothing is requested. The tab is kept in the hash, #settings?tab=servers.
const props = defineProps<{ query: string }>()
const emit = defineEmits<{ 'refreshed': [ok: boolean], 'update:query': [query: string] }>()

const { me } = useAuth()
const isAdmin = computed(() => me.value?.role === 'admin')

const TABS = [
  { key: 'servers', label: 'Servers', text: 'Servers and projects this dashboard watches. Every change is saved with your name in the change log.' },
  { key: 'projects', label: 'Projects', text: 'A project is one or more containers on a server. Nothing is installed: cAdvisor already sees them.' },
  { key: 'log', label: 'Change log', text: 'Every change to servers and projects, newest first. Entries cannot be edited or deleted.' },
] as const
type TabKey = typeof TABS[number]['key']

function tabFromQuery(query: string): TabKey {
  const t = new URLSearchParams(query).get('tab')
  return TABS.find(x => x.key === t)?.key ?? 'servers'
}
const tab = ref<TabKey>(tabFromQuery(props.query))
const current = computed(() => TABS.find(t => t.key === tab.value) ?? TABS[0])
// #settings?tab=projects&server=<key> (the last step of Add server) opens Add project with that
// server chosen. The hint is kept here because rewriting the hash for the tab drops it.
const serverHint = ref(new URLSearchParams(props.query).get('server'))

// The hash keeps the tab. replaceState does not fire hashchange, so the new query is also sent to
// the parent, which keeps its copy in step.
watch(tab, (key) => {
  const query = `tab=${key}`
  const hash = `#settings?${query}`
  if (window.location.hash !== hash) history.replaceState(null, '', hash)
  if (props.query !== query) emit('update:query', query)
})
watch(() => props.query, (query) => {
  const server = new URLSearchParams(query).get('server')
  if (server) serverHint.value = server
  tab.value = tabFromQuery(query)
})

function onTabKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  event.preventDefault()
  const i = TABS.findIndex(t => t.key === tab.value)
  tab.value = TABS[(i + step + TABS.length) % TABS.length].key
  // Focus follows the selection once the DOM has updated.
  const list = event.currentTarget as HTMLElement
  nextTick(() => list.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
}
</script>

<template>
  <div v-if="!isAdmin" class="flex flex-col gap-1 rounded-xl border border-dashed border-input p-6" role="status">
    <h1 class="text-2xl font-semibold tracking-[-0.02em]">Settings</h1>
    <p class="text-[13px] text-muted-foreground">Settings are for admins.</p>
  </div>

  <template v-else>
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-[-0.02em]">Settings</h1>
        <p class="mt-0.5 text-[13px] text-muted-foreground">{{ current.text }}</p>
      </div>
      <div role="tablist" aria-label="Settings" class="flex gap-0.5 rounded-lg bg-chip p-[3px]" @keydown="onTabKey">
        <button
          v-for="t in TABS"
          :id="`settings-tab-${t.key}`"
          :key="t.key"
          type="button"
          role="tab"
          :aria-selected="tab === t.key"
          :aria-controls="`settings-panel-${t.key}`"
          :tabindex="tab === t.key ? 0 : -1"
          class="inline-flex min-h-8 items-center rounded-md px-3 text-[13px] pointer-coarse:min-h-11"
          :class="tab === t.key ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <!-- v-if, so a hidden tab stops polling. -->
    <div :id="`settings-panel-${tab}`" role="tabpanel" :aria-labelledby="`settings-tab-${tab}`" class="flex flex-col gap-5">
      <SettingsServers v-if="tab === 'servers'" @refreshed="emit('refreshed', $event)" />
      <SettingsProjects v-else-if="tab === 'projects'" :initial-server="serverHint" @refreshed="emit('refreshed', $event)" />
      <SettingsLog v-else @refreshed="emit('refreshed', $event)" />
    </div>
  </template>
</template>
