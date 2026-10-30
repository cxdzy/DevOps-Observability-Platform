import type { Ref } from 'vue'
import type { AnomalyPoint, Incident } from '@/types'
import { ref, watch } from 'vue'
import { api, usePoll } from './useApi'

// Anomaly points and incidents for the selected range, shared by the Anomaly and Incidents tabs.
// Polls only while active is true. The two calls are independent: one failing does not hide the other.
// A failed refresh keeps the last good data; xLoaded tells the views whether there is any to show.
export function useRangeData(hours: Ref<number>, active: Ref<boolean>) {
  const points = ref<AnomalyPoint[]>([])
  const incidents = ref<Incident[]>([])
  const loading = ref(true)
  const pointsFailed = ref(false)
  const incidentsFailed = ref(false)
  const pointsLoaded = ref(false)
  const incidentsLoaded = ref(false)

  async function load() {
    const requested = hours.value
    const params = { hours: requested }
    const [a, i] = await Promise.allSettled([
      api.get<AnomalyPoint[]>('/api/anomaly', { params }),
      api.get<Incident[]>('/api/incidents', { params }),
    ])
    // The range changed while this load ran; a reload for the new range follows.
    if (requested !== hours.value) return
    pointsFailed.value = a.status === 'rejected'
    if (a.status === 'fulfilled') {
      points.value = Array.isArray(a.value.data) ? a.value.data : []
      pointsLoaded.value = true
    }
    incidentsFailed.value = i.status === 'rejected'
    if (i.status === 'fulfilled') {
      incidents.value = Array.isArray(i.value.data) ? i.value.data : []
      incidentsLoaded.value = true
    }
    loading.value = false
  }

  const { refresh } = usePoll(load, 30000, active)

  // Data for the old range is never shown under the new one.
  watch(hours, () => {
    points.value = []
    incidents.value = []
    pointsLoaded.value = false
    incidentsLoaded.value = false
    pointsFailed.value = false
    incidentsFailed.value = false
    loading.value = true
    refresh()
  })

  return { points, incidents, loading, pointsFailed, incidentsFailed, pointsLoaded, incidentsLoaded }
}
