<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

// The phone bottom sheet with the chat list and the statistics. A native modal dialog, so focus
// stays inside and Escape closes it; the content comes from the slot.
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
let opener: HTMLElement | null = null

watch(() => props.open, async (open) => {
  const d = dialog.value
  if (!d) return
  if (open && !d.open) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    d.showModal()
    await nextTick()
    closeButton.value?.focus()
  } else if (!open && d.open) {
    d.close()
  }
})

function onClose() {
  if (props.open) emit('close')
  opener?.focus()
  opener = null
}

// A click on the backdrop (the dialog element itself, outside the panel) closes the sheet.
function onClick(event: MouseEvent) {
  if (event.target === dialog.value) emit('close')
}
</script>

<template>
  <dialog
    ref="dialog"
    aria-labelledby="chat-sheet-title"
    class="mx-0 mt-auto mb-0 max-h-[85dvh] w-full max-w-none rounded-t-2xl border-t border-border bg-card p-0 text-foreground shadow-lg backdrop:bg-black/40"
    @close="onClose"
    @click="onClick"
  >
    <div class="flex flex-col gap-4 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))]">
      <div class="mx-auto h-1 w-10 rounded-full bg-border" aria-hidden="true" />
      <div class="flex items-center justify-between gap-2">
        <h2 id="chat-sheet-title" class="text-[15px] font-semibold">Chats and assistant</h2>
        <button ref="closeButton" type="button" aria-label="Close" class="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-chip hover:text-foreground" @click="emit('close')">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <slot />
    </div>
  </dialog>
</template>
