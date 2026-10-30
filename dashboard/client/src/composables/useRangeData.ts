import type { Ref } from 'vue'
import type { AnomalyPoint, Incident } from '@/types'
import { ref, watch } from 'vue'
import { api, usePoll } from './useApi'

// Anomaly points and incidents for the selected range, shared by the Anomaly and Incidents tabs.
// The two calls are independent: one failing does not hide the other.
export function useRangeData(hours: Ref<number>) {
  const points = ref<AnomalyPoint[]>([])
  const incidents = ref<Incident[]>([])
  const loading = ref(true)
  const pointsFailed = ref(false)
  const incidentsFailed = ref(false)

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
    points.value = a.status === 'fulfilled' && Array.isArray(a.value.data) ? a.value.data : []
    incidentsFailed.value = i.status === 'rejected'
    incidents.value = i.status === 'fulfilled' && Array.isArray(i.value.data) ? i.value.data : []
    loading.value = false
  }

  const { refresh } = usePoll(load, 30000)

  watch(hours, () => {
    loading.value = true
    refresh()
  })

  return { points, incidents, loading, pointsFailed, incidentsFailed }
}
