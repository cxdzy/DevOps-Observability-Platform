<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { TIER_STYLE, toTier } from '@/lib/tier'

const props = defineProps<{ tier: string | null | undefined }>()

const style = computed(() => TIER_STYLE[toTier(props.tier)])
</script>

<template>
  <Badge :class="style.badgeClass">{{ style.label }}</Badge>
</template>
