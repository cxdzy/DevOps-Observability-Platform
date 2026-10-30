<script setup lang="ts">
import type { Health, LatestAnomaly } from '@/types'
import { computed, ref } from 'vue'
import TierBadge from '@/components/TierBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { fixed, localDateTime } from '@/lib/format'

const health = ref<Health | null>(null)
const anomaly = ref<LatestAnomaly | null>(null)
const loading = ref(true)
const failed = ref(false)
const anomalyFailed = ref(false)

async function load() {
  const [h, a] = await Promise.allSettled([
    api.get<Health>('/api/health'),
    api.get<LatestAnomaly>('/api/anomaly/latest'),
  ])
  failed.value = h.status === 'rejected'
  if (h.status === 'fulfilled') health.value = h.value.data
  anomalyFailed.value = a.status === 'rejected'
  if (a.status === 'fulfilled') anomaly.value = a.value.data
  loading.value = false
}

usePoll(load, 15000)

const hasAnomaly = computed(() => anomaly.value !== null && anomaly.value.score !== undefined)
</script>

<template>
  <div class="flex flex-col gap-6">
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
              <span class="font-mono">{{ fixed(anomaly.score) }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span>Threshold</span>
              <span class="font-mono">{{ fixed(anomaly.threshold) }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span>Tier</span>
              <TierBadge :tier="anomaly.tier" />
            </div>
            <div class="flex items-center justify-between">
              <span>Time</span>
              <span class="text-sm">{{ localDateTime(anomaly.time) }}</span>
            </div>
          </template>
          <p v-else class="text-sm text-muted-foreground">No anomaly scores yet.</p>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
