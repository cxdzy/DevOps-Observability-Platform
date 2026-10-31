<script setup lang="ts">
import { Button } from '@/components/ui/button'

function reload() {
  window.location.reload()
}
</script>

<template>
  <div class="flex h-[260px] w-full flex-col items-center justify-center gap-3 text-center text-[13px] md:h-[320px]" role="alert">
    <p class="max-w-md text-muted-foreground">
      The chart could not be loaded. You may be offline, or the dashboard was updated since this page was opened.
    </p>
    <Button variant="outline" class="min-h-9 border-border bg-transparent px-3.5 text-[13px] dark:border-border dark:bg-transparent" @click="reload">
      Reload the page
    </Button>
  </div>
</template>
