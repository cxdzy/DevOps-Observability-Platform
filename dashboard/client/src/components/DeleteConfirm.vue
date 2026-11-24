<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'

// The confirmation of a permanent delete, shared by Servers and Projects. It lists what goes and
// what stays, and the Delete button works only when the exact name is typed (case and spaces
// count). blocked: a reason the delete cannot happen yet (for example projects still on a server);
// the field and the button are then not offered.
const props = defineProps<{
  kind: 'server' | 'project'
  name: string
  removes: string[]
  keeps: string
  blocked?: string | null
  error?: string | null
  busy?: boolean
}>()
const emit = defineEmits<{ confirm: [], cancel: [] }>()

const typed = ref('')
const matches = computed(() => typed.value === props.name)
const field = ref<HTMLInputElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
onMounted(() => nextTick(() => (props.blocked ? cancelButton.value : field.value)?.focus()))

function submit() {
  if (matches.value && !props.busy && !props.blocked) emit('confirm')
}

const btn = 'inline-flex min-h-9 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium pointer-coarse:min-h-11'
</script>

<template>
  <div
    class="flex flex-col gap-3 rounded-xl border border-destructive/60 p-[18px]"
    role="alertdialog"
    aria-labelledby="delete-title"
    aria-describedby="delete-text"
    @keydown.esc.stop="emit('cancel')"
  >
    <span id="delete-title" class="text-[15px] font-semibold [overflow-wrap:anywhere]">Delete {{ kind }} <span class="font-mono">{{ name }}</span> permanently?</span>
    <div id="delete-text" class="flex flex-col gap-2 text-[13px] text-chipfg">
      <p v-if="blocked" class="text-destructive" role="alert">{{ blocked }}</p>
      <template v-else>
        <p>This cannot be undone. It removes:</p>
        <ul class="list-disc pl-5">
          <li v-for="line in removes" :key="line">{{ line }}</li>
        </ul>
        <p>{{ keeps }}</p>
      </template>
    </div>
    <form v-if="!blocked" class="flex flex-col gap-3" novalidate @submit.prevent="submit">
      <label class="flex max-w-[360px] flex-col gap-1.5 text-[13px] font-medium">
        <span>Type <span class="font-mono">{{ name }}</span> to confirm</span>
        <input
          ref="field"
          v-model="typed"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="min-h-[38px] rounded-lg border border-input bg-card px-2.5 font-mono text-[13px] text-foreground pointer-coarse:min-h-11"
        >
      </label>
      <p v-if="error" class="text-[13px] text-destructive" role="alert">{{ error }}</p>
      <div class="flex flex-wrap justify-end gap-2">
        <button ref="cancelButton" type="button" :class="btn" class="border border-border hover:bg-chip" @click="emit('cancel')">Cancel</button>
        <button
          type="submit"
          :class="[btn, matches && !busy ? 'bg-destructive text-background' : 'cursor-not-allowed bg-border text-faint']"
          :disabled="!matches || busy"
        >
          {{ busy ? 'Deleting' : `Delete ${kind}` }}
        </button>
      </div>
    </form>
    <div v-else class="flex justify-end">
      <button ref="cancelButton" type="button" :class="btn" class="border border-border hover:bg-chip" @click="emit('cancel')">Close</button>
    </div>
  </div>
</template>
