<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

// Asks once before a chat is deleted. A native modal dialog, so focus stays inside it and Escape
// cancels; focus goes back to where it was when it closes.
const props = defineProps<{ title: string | null }>()
const emit = defineEmits<{ confirm: [], cancel: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
let opener: HTMLElement | null = null

watch(() => props.title, async (title) => {
  const d = dialog.value
  if (!d) return
  if (title !== null && !d.open) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    d.showModal()
    await nextTick()
    cancelButton.value?.focus()
  } else if (title === null && d.open) {
    d.close()
  }
})

function onClose() {
  if (props.title !== null) emit('cancel')
  opener?.focus()
  opener = null
}
</script>

<template>
  <dialog
    ref="dialog"
    aria-labelledby="delete-chat-title"
    class="m-auto w-[min(400px,calc(100vw-32px))] rounded-xl border border-border bg-card p-5 text-foreground shadow-lg backdrop:bg-black/40"
    @close="onClose"
  >
    <h2 id="delete-chat-title" class="text-[15px] font-semibold">Delete this chat?</h2>
    <p class="mt-1.5 text-[13px] break-words text-muted-foreground">
      "{{ title }}" and its messages are removed from this page. This cannot be undone.
    </p>
    <div class="mt-4 flex justify-end gap-2">
      <button ref="cancelButton" type="button" class="min-h-11 rounded-lg border border-border px-3.5 text-[13px] font-medium hover:bg-chip md:min-h-9" @click="emit('cancel')">
        Cancel
      </button>
      <button type="button" class="min-h-11 rounded-lg bg-tier-high-fg px-3.5 text-[13px] font-medium text-background hover:opacity-90 md:min-h-9" @click="emit('confirm')">
        Delete chat
      </button>
    </div>
  </dialog>
</template>
