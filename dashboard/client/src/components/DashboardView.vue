<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import AnomalyView from '@/components/AnomalyView.vue'
import AppHeader from '@/components/AppHeader.vue'
import AppSidebar from '@/components/AppSidebar.vue'
import ChartLoadError from '@/components/ChartLoadError.vue'
import ChartSkeleton from '@/components/ChartSkeleton.vue'
import ChatView from '@/components/ChatView.vue'
import IncidentsView from '@/components/IncidentsView.vue'
import ModelView from '@/components/ModelView.vue'
import OverviewView from '@/components/OverviewView.vue'
import RemediationView from '@/components/RemediationView.vue'
import ResourcesView from '@/components/ResourcesView.vue'
import { useRangeData } from '@/composables/useRangeData'

// The Evaluation view is downloaded only when it is first opened, so it does not grow the main bundle.
const EvaluationView = defineAsyncComponent({
  loader: () => import('@/components/EvaluationView.vue'),
  loadingComponent: ChartSkeleton,
  errorComponent: ChartLoadError,
  delay: 0,
  timeout: 30000,
})

// Drift draws an ECharts chart, so the whole view is downloaded only when it is first opened.
const DriftView = defineAsyncComponent({
  loader: () => import('@/components/DriftView.vue'),
  loadingComponent: ChartSkeleton,
  errorComponent: ChartLoadError,
  delay: 0,
  timeout: 30000,
})

const TABS = ['overview', 'resources', 'anomaly', 'incidents', 'remediation', 'chat', 'evaluation', 'drift', 'model'] as const
type Tab = typeof TABS[number]
const TITLES: Record<Tab, string> = { overview: 'Overview', resources: 'Resources', anomaly: 'Anomaly', incidents: 'Incidents', remediation: 'Remediation', chat: 'Chat', evaluation: 'Evaluation', drift: 'Drift', model: 'Model' }
// Breadcrumb group, the same grouping as the sidebar.
const GROUPS: Record<Tab, string> = { overview: 'Monitoring', resources: 'Monitoring', anomaly: 'Monitoring', incidents: 'Monitoring', remediation: 'Actions', chat: 'Actions', evaluation: 'Results', drift: 'Results', model: 'System' }

// The hash is the view name, optionally followed by "?" and the view's own state, for example
// #evaluation?run=2026-11-11T04:30:00Z. The view is read from the part before the "?".
function hashParts(): { name: string, query: string } {
  const hash = window.location.hash.slice(1)
  const at = hash.indexOf('?')
  return at === -1 ? { name: hash, query: '' } : { name: hash.slice(0, at), query: hash.slice(at + 1) }
}

function tabFromHash(): Tab {
  const { name } = hashParts()
  return (TABS as readonly string[]).includes(name) ? (name as Tab) : 'overview'
}

// The selected view is kept in the URL hash, so a reload or a shared link opens the same view.
// The sidebar links change the hash; an unknown hash is replaced with the default view. A hash
// that already names the view, with or without a query, is left as it is.
const tab = ref<Tab>(tabFromHash())
// The text after the "?", passed to the view. A view that changes its own state rewrites the hash
// with history.replaceState, which does not fire hashchange, so the view also sends the new text
// back (v-model:query). That keeps this in step, so a pasted link to an earlier state still changes it.
const viewQuery = ref(hashParts().query)
watch(tab, (name) => {
  if (hashParts().name !== name) history.replaceState(null, '', `#${name}`)
})
const onHashChange = () => {
  tab.value = tabFromHash()
  viewQuery.value = hashParts().query
}
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
// The champion version for the sidebar, known once the Model view has loaded.
const championVersion = ref<string | null>(null)

// Overview, Resources, Remediation and Model poll on their own and report each load here.
function onViewRefreshed(ok: boolean) {
  live.value = ok
  if (ok) refreshedAt.value = Date.now()
}

// The Chat view shows the assistant's state in the top bar instead of the live time. null until
// the first stats call has answered.
const assistantReady = ref<boolean | null>(null)
const headerStatus = computed(() => {
  if (tab.value !== 'chat') return null
  if (assistantReady.value === null) return 'Checking the assistant'
  return assistantReady.value ? 'Assistant ready' : 'Assistant unavailable'
})
// The header's dot: a hollow ring while checking (no refresh time yet), green when ready, red when not.
const headerRefreshedAt = computed(() => (tab.value === 'chat' ? (assistantReady.value === null ? null : 0) : refreshedAt.value))
const headerLive = computed(() => (tab.value === 'chat' ? assistantReady.value !== false : live.value))

// An incident chip in a chat reply opens the Incidents view with that incident selected.
function openIncident(start: number) {
  selectedIncident.value = start
  tab.value = 'incidents'
}
</script>

<template>
  <div class="flex min-h-dvh flex-col gap-2 p-2 md:flex-row">
    <AppSidebar :current="tab" :incident-count="incidentCount" :hours="hours" :champion-version="championVersion" />

    <main class="flex min-w-0 flex-1 flex-col rounded-[14px] bg-card ring-1 ring-border">
      <AppHeader
        :group="GROUPS[tab]"
        :page="TITLES[tab]"
        :refreshed-at="headerRefreshedAt"
        :live="headerLive"
        :status-text="headerStatus"
      />

      <div class="flex flex-col gap-5 p-4 md:p-6">
        <!-- v-if, so a hidden view stops polling and the chart is not drawn in a hidden box. -->
        <OverviewView v-if="tab === 'overview'" @refreshed="onViewRefreshed" />
        <ResourcesView v-else-if="tab === 'resources'" @refreshed="onViewRefreshed" />
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
        <ChatView v-else-if="tab === 'chat'" @status="assistantReady = $event" @open-incident="openIncident" />
        <EvaluationView v-else-if="tab === 'evaluation'" v-model:query="viewQuery" @refreshed="onViewRefreshed" />
        <ModelView v-else-if="tab === 'model'" @refreshed="onViewRefreshed" @champion="championVersion = $event" />
        <DriftView v-else-if="tab === 'drift'" @refreshed="onViewRefreshed" />
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
