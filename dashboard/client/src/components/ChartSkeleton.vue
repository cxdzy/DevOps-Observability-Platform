<script setup lang="ts">
import { Skeleton } from '@/components/ui/skeleton'
</script>

<template>
  <!-- Same height as the chart container, so swapping one for the other does not move the layout. -->
  <Skeleton class="h-[260px] w-full md:h-[320px]" />
</template>
