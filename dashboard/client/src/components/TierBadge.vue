<script setup lang="ts">
import { computed } from 'vue'
import { TIER_SHAPE, TIER_STYLE, toTier } from '@/lib/tier'

const props = defineProps<{ tier: string | null | undefined }>()

const tier = computed(() => toTier(props.tier))
const style = computed(() => TIER_STYLE[tier.value])
</script>

<template>
  <span class="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md px-1.5 py-px text-xs font-semibold whitespace-nowrap" :class="style.badgeClass">
    <svg v-if="tier !== 'none'" class="size-2" viewBox="0 0 12 12" aria-hidden="true">
      <path :d="TIER_SHAPE[tier]" :style="{ fill: `var(${style.markerVar})` }" />
    </svg>
    {{ style.label }}
  </span>
</template>
