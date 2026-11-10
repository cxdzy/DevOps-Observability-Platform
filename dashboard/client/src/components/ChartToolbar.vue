<script setup lang="ts">
// Window controls for time-series charts (DESIGN.md section 7.2): presets that pick the loaded
// window, then zoom in, zoom out, move earlier, move later and Reset inside it. The parent owns
// the zoom state; this only reports which button was pressed.
//
// A button at its limit (Reset at the whole window, Move later at the end) is marked
// aria-disabled and does nothing, but it is never given the disabled attribute: that would drop
// keyboard focus to the page the moment a press reached the limit.
const value = defineModel<number>({ required: true })

const props = defineProps<{
  presets: { value: number, label: string, title: string }[]
  // The whole window is shown: zoom out and Reset have nothing to do.
  atFull?: boolean
  // The narrowest zoom is reached: zoom in has nothing to do.
  atMin?: boolean
  // The view touches that edge: moving that way has nothing to do.
  atStart?: boolean
  atEnd?: boolean
  // No data yet: every button is inactive.
  inactive?: boolean
}>()

const emit = defineEmits<{ zoomIn: [], zoomOut: [], earlier: [], later: [], reset: [] }>()

type Action = 'zoomIn' | 'zoomOut' | 'earlier' | 'later' | 'reset'
function off(action: Action): boolean {
  if (props.inactive) return true
  if (action === 'zoomIn') return props.atMin === true
  if (action === 'zoomOut' || action === 'reset') return props.atFull === true
  if (action === 'earlier') return props.atStart === true
  return props.atEnd === true
}
function press(action: Action) {
  if (off(action)) return
  if (action === 'zoomIn') emit('zoomIn')
  else if (action === 'zoomOut') emit('zoomOut')
  else if (action === 'earlier') emit('earlier')
  else if (action === 'later') emit('later')
  else emit('reset')
}
function pick(hours: number) {
  if (!props.inactive) value.value = hours
}

// 32 px buttons, 44 px where the main pointer is a finger. aria-disabled ones are muted.
const base = 'rounded-lg border border-border text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-40 [&:not([aria-disabled=true])]:hover:bg-chip'
const icon = `flex size-8 shrink-0 items-center justify-center ${base} pointer-coarse:size-11`
</script>

<template>
  <div class="flex flex-col items-end gap-1">
    <div role="toolbar" aria-label="Time window" class="flex flex-wrap items-center gap-1.5">
      <div role="group" aria-label="Window" class="flex gap-0.5 rounded-lg bg-chip p-[3px]">
        <button
          v-for="p in presets"
          :key="p.value"
          type="button"
          class="min-h-[26px] rounded-md px-2.5 text-[13px] aria-disabled:cursor-not-allowed aria-disabled:opacity-40 pointer-coarse:min-h-11"
          :class="value === p.value ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
          :aria-pressed="value === p.value"
          :aria-label="p.title"
          :aria-disabled="inactive ? 'true' : undefined"
          :title="p.title"
          @click="pick(p.value)"
        >
          {{ p.label }}
        </button>
      </div>
      <button type="button" :class="icon" aria-label="Move earlier" title="Move earlier" :aria-disabled="off('earlier') ? 'true' : undefined" @click="press('earlier')">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
      </button>
      <button type="button" :class="icon" aria-label="Move later" title="Move later" :aria-disabled="off('later') ? 'true' : undefined" @click="press('later')">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      <button type="button" :class="icon" aria-label="Zoom out" title="Zoom out" :aria-disabled="off('zoomOut') ? 'true' : undefined" @click="press('zoomOut')">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M16.5 16.5 21 21" /></svg>
      </button>
      <button type="button" :class="icon" aria-label="Zoom in" title="Zoom in" :aria-disabled="off('zoomIn') ? 'true' : undefined" @click="press('zoomIn')">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M11 8v6M16.5 16.5 21 21" /></svg>
      </button>
      <button
        type="button"
        :class="base"
        class="min-h-8 px-2.5 text-xs pointer-coarse:min-h-11"
        aria-label="Reset zoom to the whole window"
        title="Reset zoom"
        :aria-disabled="off('reset') ? 'true' : undefined"
        @click="press('reset')"
      >
        Reset
      </button>
    </div>
    <!-- Mouse and trackpad only; on touch screens pinch and the slider zoom, and a drag scrolls. -->
    <p class="text-[11px] text-muted-foreground pointer-coarse:hidden">Ctrl + scroll to zoom, drag to pan</p>
  </div>
</template>
