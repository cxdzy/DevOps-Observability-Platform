<script setup lang="ts">
// Shown in a chat while another chat waits for its reply.
defineProps<{ title: string, seconds: number }>()
const emit = defineEmits<{ go: [] }>()
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground" role="status">
    <span class="size-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
    <span class="min-w-0">
      The assistant is answering <span class="font-medium text-foreground">{{ title }}</span>,
      <span class="font-mono">{{ seconds }}</span> s
    </span>
    <button type="button" class="ml-auto inline-flex min-h-11 items-center rounded-md px-2 font-medium text-foreground underline-offset-2 hover:underline md:min-h-7" @click="emit('go')">
      Go to that chat
    </button>
  </div>
</template>
