<script setup lang="ts">
// Window controls for time-series charts (DESIGN.md section 7.2): presets that pick the loaded
// window, then zoom in, zoom out, move earlier, move later and Reset inside it. The parent owns
// the zoom state; this only reports which button was pressed.
const value = defineModel<number>({ required: true })

defineProps<{
  presets: { value: number, label: string, title: string }[]
  // Disables zoom out and Reset when the whole window is already shown.
  atFull?: boolean
  // Disables moving when the view already touches that edge.
  atStart?: boolean
  atEnd?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ zoomIn: [], zoomOut: [], earlier: [], later: [], reset: [] }>()

// 32 px buttons, 44 px where the main pointer is a finger.
const icon = 'flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-foreground hover:bg-chip disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:size-11'
</script>

<template>
  <div role="toolbar" aria-label="Time window" class="flex flex-wrap items-center gap-1.5">
    <div role="group" aria-label="Window" class="flex gap-0.5 rounded-lg bg-chip p-[3px]">
      <button
        v-for="p in presets"
        :key="p.value"
        type="button"
        class="min-h-[26px] rounded-md px-2.5 text-[13px] pointer-coarse:min-h-11"
        :class="value === p.value ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
        :aria-pressed="value === p.value"
        :aria-label="p.title"
        :title="p.title"
        :disabled="disabled"
        @click="value = p.value"
      >
        {{ p.label }}
      </button>
    </div>
    <button type="button" :class="icon" aria-label="Move earlier" title="Move earlier" :disabled="disabled || atStart" @click="emit('earlier')">
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
    </button>
    <button type="button" :class="icon" aria-label="Move later" title="Move later" :disabled="disabled || atEnd" @click="emit('later')">
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    </button>
    <button type="button" :class="icon" aria-label="Zoom out" title="Zoom out" :disabled="disabled || atFull" @click="emit('zoomOut')">
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M16.5 16.5 21 21" /></svg>
    </button>
    <button type="button" :class="icon" aria-label="Zoom in" title="Zoom in" :disabled="disabled" @click="emit('zoomIn')">
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M11 8v6M16.5 16.5 21 21" /></svg>
    </button>
    <button
      type="button"
      class="min-h-8 rounded-lg border border-border px-2.5 text-xs text-foreground hover:bg-chip disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11"
      aria-label="Reset zoom to the whole window"
      title="Reset zoom"
      :disabled="disabled || atFull"
      @click="emit('reset')"
    >
      Reset
    </button>
  </div>
</template>
