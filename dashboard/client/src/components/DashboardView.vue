<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AnomalyView from '@/components/AnomalyView.vue'
import AppHeader from '@/components/AppHeader.vue'
import AppSidebar from '@/components/AppSidebar.vue'
import IncidentsView from '@/components/IncidentsView.vue'
import OverviewView from '@/components/OverviewView.vue'
import RemediationView from '@/components/RemediationView.vue'
import { useRangeData } from '@/composables/useRangeData'

const TABS = ['overview', 'anomaly', 'incidents', 'remediation'] as const
type Tab = typeof TABS[number]
const TITLES: Record<Tab, string> = { overview: 'Overview', anomaly: 'Anomaly', incidents: 'Incidents', remediation: 'Remediation' }
// Breadcrumb group, the same grouping as the sidebar.
const GROUPS: Record<Tab, string> = { overview: 'Monitoring', anomaly: 'Monitoring', incidents: 'Monitoring', remediation: 'Actions' }

function tabFromHash(): Tab {
  const name = window.location.hash.slice(1)
  return (TABS as readonly string[]).includes(name) ? (name as Tab) : 'overview'
}

// The selected view is kept in the URL hash, so a reload or a shared link opens the same view.
// The sidebar links change the hash; an unknown hash is replaced with the default view.
const tab = ref<Tab>(tabFromHash())
watch(tab, (name) => {
  if (window.location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
})
const onHashChange = () => { tab.value = tabFromHash() }
onMounted(() => window.addEventListener('hashchange', onHashChange))
onUnmounted(() => window.removeEventListener('hashchange', onHashChange))

// One time range and one data load shared by the Anomaly and Incidents views, polled only while
// one of them is open (the Overview has its own timer). Each view keeps its own selection.
const hours = ref(24)
const dataTabActive = computed(() => tab.value === 'anomaly' || tab.value === 'incidents')
const {
  points,
  incidents,
  loading,
  pointsFailed,
  incidentsFailed,
  pointsLoaded,
  incidentsLoaded,
} = useRangeData(hours, dataTabActive)
const selectedMinute = ref<number | null>(null)
const selectedIncident = ref<number | null>(null)

const incidentCount = computed(() => (incidentsLoaded.value ? incidents.value.length : null))

// The live dot in the top bar: the last successful load from whichever view is polling.
const refreshedAt = ref<number | null>(null)
const live = ref(true)
// A successful range load replaces these arrays; a range change empties them and clears the
// loaded flags at the same time, which is not a refresh.
watch([points, incidents], () => {
  if (pointsLoaded.value || incidentsLoaded.value) {
    refreshedAt.value = Date.now()
    live.value = !pointsFailed.value && !incidentsFailed.value
  }
})
watch([pointsFailed, incidentsFailed], ([p, i]) => { live.value = !p && !i })
// Overview and Remediation poll on their own and report each load here.
function onViewRefreshed(ok: boolean) {
  live.value = ok
  if (ok) refreshedAt.value = Date.now()
}
</script>

<template>
  <div class="flex min-h-dvh flex-col gap-2 p-2 md:flex-row">
    <AppSidebar :current="tab" :incident-count="incidentCount" :hours="hours" />

    <main class="flex min-w-0 flex-1 flex-col rounded-[14px] bg-card ring-1 ring-border">
      <AppHeader :group="GROUPS[tab]" :page="TITLES[tab]" :refreshed-at="refreshedAt" :live="live" />

      <div class="flex flex-col gap-5 p-4 md:p-6">
        <!-- v-if, so a hidden view stops polling and the chart is not drawn in a hidden box. -->
        <OverviewView v-if="tab === 'overview'" @refreshed="onViewRefreshed" />
        <AnomalyView
          v-else-if="tab === 'anomaly'"
          v-model:hours="hours"
          v-model:selected="selectedMinute"
          :points="points"
          :incidents="incidents"
          :loading="loading"
          :points-failed="pointsFailed"
          :incidents-failed="incidentsFailed"
          :points-loaded="pointsLoaded"
          :incidents-loaded="incidentsLoaded"
        />
        <RemediationView v-else-if="tab === 'remediation'" @refreshed="onViewRefreshed" />
        <IncidentsView
          v-else
          v-model:hours="hours"
          v-model:selected="selectedIncident"
          :incidents="incidents"
          :loading="loading"
          :failed="incidentsFailed"
          :loaded="incidentsLoaded"
        />
      </div>
    </main>
  </div>
</template>
