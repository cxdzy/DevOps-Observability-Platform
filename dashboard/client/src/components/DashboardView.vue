<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AnomalyView from '@/components/AnomalyView.vue'
import IncidentsView from '@/components/IncidentsView.vue'
import OverviewView from '@/components/OverviewView.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useRangeData } from '@/composables/useRangeData'

const TABS = ['overview', 'anomaly', 'incidents'] as const
type Tab = typeof TABS[number]

function tabFromHash(): Tab {
  const name = window.location.hash.slice(1)
  return (TABS as readonly string[]).includes(name) ? (name as Tab) : 'overview'
}

// The selected tab is kept in the URL hash so a reload or a shared link opens the same tab.
const tab = ref<string | number>(tabFromHash())
watch(tab, (name) => {
  if (window.location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
})
const onHashChange = () => { tab.value = tabFromHash() }
onMounted(() => window.addEventListener('hashchange', onHashChange))
onUnmounted(() => window.removeEventListener('hashchange', onHashChange))

// One time range and one data load shared by the Anomaly and Incidents tabs, polled only while
// one of them is open (the Overview has its own timer). Each tab keeps its own selection.
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
</script>

<template>
  <Tabs v-model="tab" class="gap-6">
    <TabsList class="self-center">
      <TabsTrigger value="overview">Overview</TabsTrigger>
      <TabsTrigger value="anomaly">Anomaly</TabsTrigger>
      <TabsTrigger value="incidents">Incidents</TabsTrigger>
    </TabsList>

    <TabsContent value="overview">
      <OverviewView />
    </TabsContent>
    <TabsContent value="anomaly">
      <AnomalyView
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
    </TabsContent>
    <TabsContent value="incidents">
      <IncidentsView
        v-model:hours="hours"
        v-model:selected="selectedIncident"
        :incidents="incidents"
        :loading="loading"
        :failed="incidentsFailed"
        :loaded="incidentsLoaded"
      />
    </TabsContent>
  </Tabs>
</template>
