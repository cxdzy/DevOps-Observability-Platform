<script setup lang="ts">
import { Button } from '@/components/ui/button'

function reload() {
  window.location.reload()
}
</script>

<template>
  <div class="flex h-[260px] w-full flex-col items-center justify-center gap-3 text-center text-sm md:h-[320px]" role="alert">
    <p class="text-muted-foreground">
      The chart could not be loaded. You may be offline, or the dashboard was updated since this page was opened.
    </p>
    <Button variant="outline" size="sm" @click="reload">Reload the page</Button>
  </div>
</template>
