<script setup lang="ts">
// The current state of the service as a pill (variant chip) or as a full-width banner with one
// plain sentence and a link (variant banner). Every state has an icon and words, so colour is
// never the only cue. Everything shown is built from the /api/status answer.
import type { StatusInfo } from '@/types'
import { computed } from 'vue'
import { clockTime } from '@/lib/format'
import { TIER_SHAPE, TIER_STYLE, toTier } from '@/lib/tier'

const props = withDefaults(defineProps<{
  status: StatusInfo | null
  failed: boolean
  variant?: 'chip' | 'banner'
}>(), { variant: 'chip' })

type Icon = 'check' | 'chevron' | 'tier' | 'partial' | 'clock' | 'dash'

const SIGNALS: [string, string][] = [['mem', 'Memory'], ['cpu', 'CPU'], ['lat', 'Latency']]
function signalName(signal: string | null | undefined): string {
  if (!signal) return 'A metric'
  const lower = signal.toLowerCase()
  for (const [key, name] of SIGNALS) {
    if (lower.includes(key)) return name
  }
  const words = lower.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

interface Look {
  icon: Icon
  // Tier of the shape when the icon is the tier shape.
  tier: 'low' | 'medium' | 'high' | 'none'
  classes: string
  chip: string
  title: string
  sentence: string
  link: { href: string, text: string } | null
}

const OK = 'bg-okbg text-ok ring-ok/30'
const WARN = 'bg-warnbg text-warnfg ring-warnring'
const MUTED = 'bg-chip text-chipfg ring-border'

const look = computed<Look | null>(() => {
  const s = props.status
  // The latest load failed: the last answer may no longer be true, so it is not shown as current.
  if (props.failed) {
    return { icon: 'dash', tier: 'none', classes: MUTED, chip: 'Status unavailable', title: 'Status unavailable', sentence: 'The status could not be loaded. Retrying in 30 s.', link: null }
  }
  if (!s) return null
  if (s.state === 'normal') {
    return { icon: 'check', tier: 'none', classes: OK, chip: 'Normal', title: 'Normal', sentence: 'No incident is open and nothing is being watched.', link: null }
  }
  if (s.state === 'watching') {
    const name = signalName(s.signal)
    const lead = s.signal ? `${name} is rising` : 'A metric is rising'
    const eta = s.minutes === null ? ' towards its warning level' : `, about ${Math.round(s.minutes)} ${Math.round(s.minutes) === 1 ? 'minute' : 'minutes'} to its warning level`
    return {
      icon: 'chevron',
      tier: 'none',
      classes: WARN,
      chip: s.signal ? `Watching ${s.signal}` : 'Watching',
      title: 'Watching',
      sentence: `${lead}${eta}. Nothing has been flagged yet.`,
      link: { href: '#anomaly', text: 'Open the anomaly chart' },
    }
  }
  if (s.state === 'incident') {
    const tier = toTier(s.tier)
    const parts = [`Incident open since ${clockTime(s.start)}`]
    if (tier !== 'none') parts.push(`${tier} tier`)
    if (s.peakScore !== null) parts.push(`peak score ${s.peakScore.toFixed(2)}`)
    return {
      icon: 'tier',
      tier,
      classes: `${TIER_STYLE[tier].badgeClass} ring-current/25`,
      chip: tier === 'none' ? 'Incident' : `Incident, ${tier}`,
      title: 'Incident',
      sentence: `${parts.join(', ')}.`,
      link: { href: '#incidents', text: 'Open incidents' },
    }
  }
  if (s.state === 'recovering') {
    const step = s.step !== undefined && s.of !== undefined
    return {
      icon: 'partial',
      tier: 'none',
      classes: OK,
      chip: step ? `Recovering, warm-up ${s.step} of ${s.of}` : 'Recovering',
      title: 'Recovering',
      sentence: 'The service restarted. Warm-up minutes are scored but never flagged.',
      link: { href: '#anomaly', text: 'Open the anomaly chart' },
    }
  }
  return {
    icon: 'clock',
    tier: 'none',
    classes: MUTED,
    chip: s.time === null ? 'No recent data' : `No recent data, last at ${clockTime(s.time)}`,
    title: 'No recent data',
    sentence: s.time === null ? 'The worker has no scored minute to show.' : `The worker has not scored a minute since ${clockTime(s.time)}.`,
    link: { href: '#anomaly', text: 'Open the anomaly chart' },
  }
})

const pulse = computed(() => !props.failed && props.status?.state === 'watching')
const showBanner = computed(() => props.variant === 'banner' && look.value !== null && (props.failed || (props.status !== null && props.status.state !== 'normal')))
</script>

<template>
  <!-- The wrapper is always present so a screen reader announces a change of state. -->
  <span v-if="variant === 'chip'" role="status" aria-live="polite" class="inline-flex">
    <span
      v-if="look"
      class="inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ring-1"
      :class="look.classes"
    >
      <svg class="size-3.5 shrink-0" :class="pulse ? 'motion-safe:animate-pulse' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="look.icon === 'check'" d="m5 12.5 4.5 4.5L19 7.5" />
        <path v-else-if="look.icon === 'chevron'" d="m6 15 6-6 6 6" />
        <path v-else-if="look.icon === 'tier'" :d="TIER_SHAPE[look.tier]" transform="scale(2)" fill="currentColor" stroke="none" />
        <template v-else-if="look.icon === 'partial'">
          <circle cx="12" cy="12" r="8" stroke-width="2" />
          <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
        </template>
        <template v-else-if="look.icon === 'clock'">
          <circle cx="12" cy="12" r="8.5" stroke-width="2" />
          <path d="M12 7.5V12l3 2" stroke-width="2" />
        </template>
        <path v-else d="M6 12h12" />
      </svg>
      {{ look.chip }}
    </span>
  </span>

  <section
    v-else-if="showBanner && look"
    :aria-label="`Status: ${look.title}`"
    class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-4 py-3 ring-1"
    :class="look.classes"
  >
    <svg class="size-4 shrink-0" :class="pulse ? 'motion-safe:animate-pulse' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path v-if="look.icon === 'chevron'" d="m6 15 6-6 6 6" />
      <path v-else-if="look.icon === 'tier'" :d="TIER_SHAPE[look.tier]" transform="scale(2)" fill="currentColor" stroke="none" />
      <template v-else-if="look.icon === 'partial'">
        <circle cx="12" cy="12" r="8" stroke-width="2" />
        <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
      </template>
      <template v-else-if="look.icon === 'clock'">
        <circle cx="12" cy="12" r="8.5" stroke-width="2" />
        <path d="M12 7.5V12l3 2" stroke-width="2" />
      </template>
      <path v-else d="M6 12h12" />
    </svg>
    <p class="min-w-0 flex-1 basis-60 text-[13px]">
      <strong class="font-semibold">{{ look.title }}.</strong> {{ look.sentence }}
    </p>
    <a
      v-if="look.link"
      :href="look.link.href"
      class="inline-flex min-h-8 items-center rounded-md px-1 text-[13px] font-medium text-current underline underline-offset-2 pointer-coarse:min-h-11"
    >
      {{ look.link.text }}
    </a>
  </section>
</template>
