<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import axios from 'axios'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

interface Health {
  status: string
  time: string
  influx: boolean
}

interface Anomaly {
  time?: number
  score?: number
  threshold?: number
  tier?: string
}

const health = ref<Health | null>(null)
const anomaly = ref<Anomaly | null>(null)
const loading = ref(true)
const failed = ref(false)
const anomalyFailed = ref(false)
let timer: number | undefined
let running = false

async function load() {
  if (running) return
  running = true
  const [h, a] = await Promise.allSettled([
    axios.get<Health>('/api/health', { timeout: 10000 }),
    axios.get<Anomaly>('/api/anomaly/latest', { timeout: 10000 }),
  ])
  failed.value = h.status === 'rejected'
  if (h.status === 'fulfilled') health.value = h.value.data
  anomalyFailed.value = a.status === 'rejected'
  if (a.status === 'fulfilled') anomaly.value = a.value.data
  loading.value = false
  running = false
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 15000)
})
onUnmounted(() => window.clearInterval(timer))

const hasAnomaly = computed(() => anomaly.value !== null && anomaly.value.score !== undefined)

// The worker writes tier "none" for minutes the model did not flag.
const tierLabel = computed(() => {
  const tier = anomaly.value?.tier
  return !tier || tier === 'none' ? 'normal' : tier
})

const tierClass = computed(() => {
  switch (tierLabel.value) {
    case 'low':
      return 'bg-blue-100 text-blue-800'
    case 'medium':
      return 'bg-amber-100 text-amber-800'
    case 'high':
      return 'bg-red-100 text-red-800'
    default:
      return 'bg-secondary text-secondary-foreground'
  }
})

const localTime = computed(() =>
  anomaly.value?.time ? new Date(anomaly.value.time).toLocaleString() : '-',
)
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-8">
    <h1 class="text-center text-2xl font-semibold">Observability Dashboard</h1>

    <p v-if="failed" class="rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-800">
      API unreachable. Retrying every 15 seconds.
    </p>

    <div class="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>System</CardTitle>
        </CardHeader>
        <CardContent class="flex flex-col gap-3">
          <template v-if="loading">
            <Skeleton class="h-6 w-full" />
            <Skeleton class="h-6 w-full" />
          </template>
          <template v-else-if="health">
            <div class="flex items-center justify-between">
              <span>API</span>
              <Badge :class="health.status === 'ok' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'">
                {{ health.status === 'ok' ? 'OK' : 'Down' }}
              </Badge>
            </div>
            <div class="flex items-center justify-between">
              <span>InfluxDB</span>
              <Badge :class="health.influx ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'">
                {{ health.influx ? 'Reachable' : 'Unreachable' }}
              </Badge>
            </div>
          </template>
          <p v-else class="text-sm text-muted-foreground">No data.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Latest anomaly score</CardTitle>
        </CardHeader>
        <CardContent class="flex flex-col gap-3">
          <template v-if="loading">
            <Skeleton class="h-6 w-full" />
            <Skeleton class="h-6 w-full" />
            <Skeleton class="h-6 w-full" />
          </template>
          <p v-else-if="anomalyFailed" class="text-sm text-muted-foreground">Anomaly data unavailable.</p>
          <template v-else-if="hasAnomaly && anomaly">
            <div class="flex items-center justify-between">
              <span>Score</span>
              <span class="font-mono">{{ anomaly.score?.toFixed(3) }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span>Threshold</span>
              <span class="font-mono">{{ anomaly.threshold?.toFixed(3) }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span>Tier</span>
              <Badge :class="tierClass">{{ tierLabel }}</Badge>
            </div>
            <div class="flex items-center justify-between">
              <span>Time</span>
              <span class="text-sm">{{ localTime }}</span>
            </div>
          </template>
          <p v-else class="text-sm text-muted-foreground">No anomaly scores yet.</p>
        </CardContent>
      </Card>
    </div>
  </main>
</template>
