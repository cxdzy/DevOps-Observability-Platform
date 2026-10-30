<script setup lang="ts">
import type { Incident } from '@/types'
import TierBadge from '@/components/TierBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { fixed, localDateTime, orDash } from '@/lib/format'
import { explanationFallback, STATUS_STYLE } from '@/lib/incident'

defineProps<{ incident: Incident | null }>()
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Incident detail</CardTitle>
    </CardHeader>
    <CardContent class="flex flex-col gap-3 text-sm">
      <p v-if="!incident" class="text-muted-foreground">Select an incident to see its explanation</p>
      <template v-else>
        <div class="flex flex-wrap items-center gap-1.5">
          <TierBadge :tier="incident.tier" />
          <Badge :class="STATUS_STYLE[incident.status].badgeClass">{{ STATUS_STYLE[incident.status].label }}</Badge>
          <Badge v-if="incident.deployment" variant="outline">deployment</Badge>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt class="text-muted-foreground">Start</dt>
          <dd class="text-right">{{ localDateTime(incident.start) }}</dd>
          <dt class="text-muted-foreground">Duration</dt>
          <dd class="text-right">{{ incident.minutes }} min</dd>
          <dt class="text-muted-foreground">Signal</dt>
          <dd class="text-right">{{ orDash(incident.signal) }}</dd>
          <dt class="text-muted-foreground">Action</dt>
          <dd class="text-right">{{ orDash(incident.action) }}</dd>
          <dt class="text-muted-foreground">Peak score</dt>
          <dd class="text-right font-mono">{{ fixed(incident.peakScore) }}</dd>
          <dt class="text-muted-foreground">Source</dt>
          <dd class="text-right">{{ orDash(incident.source) }}</dd>
        </dl>
        <Separator />
        <p class="whitespace-pre-wrap break-words">{{ incident.explanation ?? explanationFallback(incident) }}</p>
      </template>
    </CardContent>
  </Card>
</template>
