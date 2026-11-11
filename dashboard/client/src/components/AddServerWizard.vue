<script setup lang="ts">
import type { ApiErrorInfo, ErrorField, ServerCheck, SettingsServer } from '@/types'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { api } from '@/composables/useApi'
import { apiError, toServerCheck, toSettingsServer } from '@/types'

// The four steps of adding a server: Details, Run the command, Test connection, Live. The server
// is saved as pending after step 1, so closing the wizard keeps it in the table and "Continue
// setup" there opens it again at the command step.
const props = defineProps<{ server: SettingsServer | null }>()
const emit = defineEmits<{ changed: [], close: [] }>()

const STEPS = [
  { title: 'Details', sub: 'name, role, address' },
  { title: 'Run the command', sub: 'on the new server' },
  { title: 'Test connection', sub: 'both exporters answer' },
  { title: 'Live', sub: 'appears in every view' },
]
const ROLES = [
  { value: 'application', label: 'Application server' },
  { value: 'staging', label: 'Staging' },
  { value: 'platform', label: 'Platform server' },
]

const resumed = props.server
const step = ref(resumed ? 2 : 1)
// The furthest step reached; later steps cannot be opened by clicking until they have been reached.
const reached = ref(step.value)
const key = ref(resumed?.key ?? '')
const form = reactive({
  name: resumed?.name ?? '',
  role: resumed?.role || 'application',
  location: resumed?.location ?? '',
  address: resumed?.address ?? '',
})
// The values last saved on the server. A resumed setup sends only the fields that changed, so the
// change log gets no empty "X to X" entries.
const stored = reactive({ role: form.role, location: form.location, address: form.address })
const error = ref<ApiErrorInfo | null>(null)
const saving = ref(false)

function fieldError(field: ErrorField): string | null {
  return error.value?.field === field ? error.value.message : null
}
const formError = computed(() => (error.value && !error.value.field ? error.value.message : null))

function goTo(n: number) {
  if (n > reached.value || n === step.value) return
  step.value = n
  error.value = null
}
function advance(n: number) {
  step.value = n
  reached.value = Math.max(reached.value, n)
  error.value = null
}

async function saveDetails() {
  error.value = null
  saving.value = true
  try {
    const body = { name: form.name.trim(), role: form.role, location: form.location.trim(), address: form.address.trim() }
    if (key.value) {
      // The name is the key and cannot change. Only the fields that differ are sent; with none,
      // nothing is saved and the wizard simply moves on.
      const patch: Record<string, string> = {}
      if (body.role !== stored.role) patch.role = body.role
      if (body.location !== stored.location) patch.location = body.location
      if (body.address !== stored.address) patch.address = body.address
      if (Object.keys(patch).length) {
        await api.patch(`/api/settings/servers/${encodeURIComponent(key.value)}`, patch)
        emit('changed')
      }
      if (patch.address !== undefined) command.value = ''
    } else {
      const res = await api.post<unknown>('/api/settings/servers', body)
      const created = toSettingsServer(res.data)
      // The server trims and lowercases the name, which becomes the key.
      key.value = created.key || body.name.toLowerCase()
      form.name = created.name || key.value
      command.value = ''
      emit('changed')
    }
    Object.assign(stored, { role: body.role, location: body.location, address: body.address })
    form.location = body.location
    form.address = body.address
    advance(2)
  } catch (err) {
    error.value = apiError(err)
  } finally {
    saving.value = false
  }
}

// Step 2: the two docker run commands, filled in by the server with the validated address.
const command = ref('')
const commandState = ref<'idle' | 'loading' | 'failed'>('idle')
const commandError = ref('')
async function loadCommand() {
  if (!key.value) return
  commandState.value = 'loading'
  try {
    const res = await api.get<{ command?: unknown }>(`/api/settings/servers/${encodeURIComponent(key.value)}/command`)
    if (typeof res.data?.command !== 'string') throw new Error('unexpected response')
    command.value = res.data.command
    commandState.value = 'idle'
  } catch (err) {
    commandError.value = apiError(err, 'The command could not be loaded.').message
    commandState.value = 'failed'
  }
}
const copied = ref<'' | 'yes' | 'no'>('')
let copiedTimer: number | undefined
async function copy() {
  window.clearTimeout(copiedTimer)
  try {
    await navigator.clipboard.writeText(command.value)
    copied.value = 'yes'
  } catch {
    copied.value = 'no'
  }
  copiedTimer = window.setTimeout(() => (copied.value = ''), 3000)
}

// Step 3: ask for both checks every 10 seconds while the step is shown.
const check = ref<ServerCheck | null>(null)
const checkFailed = ref(false)
const checkError = ref('')
let timer: number | undefined
let checking = false
async function runCheck() {
  if (checking || !key.value) return
  checking = true
  try {
    const res = await api.get<unknown>(`/api/settings/servers/${encodeURIComponent(key.value)}/check`)
    check.value = toServerCheck(res.data)
    checkFailed.value = false
  } catch (err) {
    checkError.value = apiError(err, 'The check could not be run.').message
    checkFailed.value = true
  } finally {
    checking = false
  }
}
function stopTimer() {
  window.clearInterval(timer)
  timer = undefined
}
watch(step, (n) => {
  stopTimer()
  if (n === 2 && !command.value) loadCommand()
  if (n === 3) {
    runCheck()
    timer = window.setInterval(runCheck, 10000)
  }
}, { immediate: true })
onUnmounted(() => {
  stopTimer()
  window.clearTimeout(copiedTimer)
})

const ready = computed(() => check.value?.node.up === true && check.value?.cadvisor.up === true)
const activating = ref(false)
// Finish stays inactive (aria-disabled, so it can still explain itself) until both exporters are up.
async function finish() {
  if (!ready.value || activating.value) return
  error.value = null
  activating.value = true
  try {
    await api.post(`/api/settings/servers/${encodeURIComponent(key.value)}/activate`, {})
    emit('changed')
    advance(4)
  } catch (err) {
    error.value = apiError(err)
  } finally {
    activating.value = false
  }
}

// Focus moves to the wizard when it opens, so a keyboard user does not have to look for it below the table.
const root = ref<HTMLElement | null>(null)
onMounted(() => {
  root.value?.scrollIntoView({ block: 'nearest' })
  root.value?.focus({ preventScroll: true })
})

// The three links of the Live step open the new server in Resources, its Containers tab, and
// Add project with the server chosen.
const links = computed(() => {
  const k = encodeURIComponent(key.value)
  return {
    resources: `#resources?node=${k}`,
    containers: `#resources?tab=containers&node=${k}`,
    project: `#settings?tab=projects&server=${k}`,
  }
})

const target = computed(() => form.address.trim())
const exporters = computed(() => [
  { name: 'node-exporter', target: `${target.value}:9100`, result: check.value?.node ?? null },
  { name: 'cAdvisor', target: `${target.value}:8080`, result: check.value?.cadvisor ?? null },
])

const inputClass = 'min-h-[38px] rounded-lg border bg-card px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground'
const btn = 'inline-flex min-h-9 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium pointer-coarse:min-h-11'
</script>

<template>
  <!-- Escape anywhere in the wizard closes it; the parent puts focus back on the button that opened it. -->
  <section ref="root" tabindex="-1" :aria-label="resumed ? `Continue setup of ${resumed.name}` : 'Add server'" class="flex flex-col gap-[18px] rounded-xl border border-border p-[18px]" @keydown.esc.stop="emit('close')">
    <div class="flex flex-wrap items-baseline justify-between gap-2.5">
      <span class="text-[15px] font-semibold">{{ resumed ? `Continue setup of ${resumed.name}` : 'Add server' }}</span>
      <span class="flex items-center gap-3 text-xs text-muted-foreground">
        Step {{ step }} of 4
        <button type="button" class="rounded-md px-2 py-1 text-xs hover:bg-chip hover:text-foreground" @click="emit('close')">Close</button>
      </span>
    </div>

    <ol class="m-0 grid list-none grid-cols-2 gap-2 p-0 md:grid-cols-4">
      <li v-for="(s, i) in STEPS" :key="s.title">
        <button
          type="button"
          class="flex min-h-11 w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px] disabled:cursor-default"
          :class="step === i + 1 ? 'border-primary bg-card' : 'border-transparent bg-chip'"
          :aria-current="step === i + 1 ? 'step' : undefined"
          :disabled="i + 1 > reached || step === 4"
          @click="goTo(i + 1)"
        >
          <span
            class="flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            :class="i + 1 < step ? 'bg-okdot text-primary-foreground' : step === i + 1 ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground ring-1 ring-border'"
          >
            {{ i + 1 < step ? '✓' : i + 1 }}
          </span>
          <span class="flex min-w-0 flex-col text-left">
            <span class="font-medium">{{ s.title }}</span>
            <span class="text-xs text-muted-foreground">{{ s.sub }}</span>
          </span>
        </button>
      </li>
    </ol>

    <!-- Step 1 -->
    <form v-if="step === 1" class="flex flex-col gap-4" novalidate @submit.prevent="saveDetails">
      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-3.5">
        <label class="flex flex-col gap-1.5 text-[13px] font-medium">
          Name
          <input
            v-model="form.name"
            class="font-mono read-only:bg-chip read-only:text-muted-foreground"
            :class="[inputClass, fieldError('name') ? 'border-destructive' : 'border-input']"
            autocomplete="off"
            spellcheck="false"
            placeholder="shop-node"
            :readonly="!!key"
            :aria-invalid="!!fieldError('name')"
          >
          <span v-if="fieldError('name')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('name') }}</span>
          <span v-else-if="key" class="text-xs font-normal text-muted-foreground">The name is saved and cannot be changed. Archive the server and add it again to use another name.</span>
          <span v-else class="text-xs font-normal text-muted-foreground">Lowercase letters, digits and dashes. Used in every view.</span>
        </label>
        <label class="flex flex-col gap-1.5 text-[13px] font-medium">
          Role
          <select v-model="form.role" :class="[inputClass, fieldError('role') ? 'border-destructive' : 'border-input']" :aria-invalid="!!fieldError('role')">
            <option v-for="r in ROLES" :key="r.value" :value="r.value">{{ r.label }}</option>
          </select>
          <span v-if="fieldError('role')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('role') }}</span>
        </label>
        <label class="flex flex-col gap-1.5 text-[13px] font-medium">
          Location
          <input
            v-model="form.location"
            :class="[inputClass, fieldError('location') ? 'border-destructive' : 'border-input']"
            autocomplete="off"
            placeholder="Hetzner, Germany"
            maxlength="60"
            :aria-invalid="!!fieldError('location')"
          >
          <span v-if="fieldError('location')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('location') }}</span>
        </label>
        <label class="flex flex-col gap-1.5 text-[13px] font-medium">
          Tailscale address
          <input
            v-model="form.address"
            class="font-mono"
            :class="[inputClass, fieldError('address') ? 'border-destructive' : 'border-input']"
            autocomplete="off"
            inputmode="decimal"
            spellcheck="false"
            placeholder="100.64.0.12"
            :aria-invalid="!!fieldError('address')"
          >
          <span v-if="fieldError('address')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('address') }}</span>
          <span v-else class="text-xs font-normal text-muted-foreground">Must be in 100.64.0.0/10. Public addresses are refused, so nothing is scraped over the internet.</span>
        </label>
      </div>
      <p v-if="formError" class="text-[13px] text-destructive" role="alert">{{ formError }}</p>
      <div class="flex justify-end">
        <button type="submit" :class="btn" class="bg-primary text-primary-foreground disabled:opacity-50" :disabled="saving">
          {{ saving ? 'Saving' : 'Save and continue' }}
        </button>
      </div>
    </form>

    <!-- Step 2 -->
    <template v-else-if="step === 2">
      <p class="text-[13px] text-chipfg">
        Run this once on <span class="font-mono">{{ form.name }}</span> over SSH. It starts the two exporters in Docker, listening on the Tailscale address only, so no port opens to the internet and no firewall rule changes.
      </p>
      <div v-if="commandState === 'loading'" class="h-40 animate-pulse rounded-[10px] bg-chip" role="status" aria-label="Loading the command" />
      <div v-else-if="commandState === 'failed'" class="flex flex-col items-start gap-3 rounded-[10px] border border-border p-4" role="alert">
        <p class="text-[13px] text-muted-foreground">{{ commandError }}</p>
        <button type="button" :class="btn" class="border border-border hover:bg-chip" @click="loadCommand">Try again</button>
      </div>
      <!-- The command block stays dark in both themes (design note dI1). -->
      <pre v-else class="m-0 overflow-x-auto whitespace-pre rounded-[10px] bg-[#0B0E13] px-4 py-3.5 font-mono text-[12.5px] leading-[1.6] text-[#E6EDF3] ring-1 ring-[#252C36]" tabindex="0" aria-label="Commands to run on the new server">{{ command }}</pre>
      <div class="flex flex-wrap items-center justify-between gap-2.5">
        <span class="text-xs text-muted-foreground">Versions match the ones on fyp-main. Docker must already be installed there.</span>
        <span class="flex items-center gap-2">
          <span class="text-xs text-muted-foreground" role="status">{{ copied === 'yes' ? 'Copied' : copied === 'no' ? 'Copy was blocked, select the text instead' : '' }}</span>
          <button type="button" :class="btn" class="border border-border hover:bg-chip disabled:opacity-50" :disabled="!command" @click="copy">Copy</button>
          <button type="button" :class="btn" class="bg-primary text-primary-foreground disabled:opacity-50" :disabled="!command" @click="advance(3)">I ran it, test now</button>
        </span>
      </div>
    </template>

    <!-- Step 3 -->
    <template v-else-if="step === 3">
      <p class="text-[13px] text-chipfg">Checking both exporters in Prometheus every 10 s. A new server can take up to a minute to show as up.</p>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-3">
        <div
          v-for="e in exporters"
          :key="e.name"
          class="flex flex-col gap-1.5 rounded-[10px] border px-3.5 py-3"
          :class="!e.result
            ? 'border-dashed border-input bg-chip'
            : e.result.up
              ? 'border-stripup bg-okbg'
              : 'border-[#FECACA] bg-tier-high-bg dark:border-[#5A2A2E]'"
        >
          <span class="flex items-center gap-2.5">
            <span
              class="flex size-[22px] items-center justify-center rounded-full text-xs font-bold"
              :class="!e.result ? 'border-2 border-idle' : e.result.up ? 'bg-okdot text-primary-foreground' : 'bg-red text-primary-foreground'"
              aria-hidden="true"
            >{{ !e.result ? '' : e.result.up ? '✓' : '!' }}</span>
            <span class="font-medium">{{ e.name }}</span>
            <span class="ml-auto font-mono text-xs text-muted-foreground">{{ e.target }}</span>
          </span>
          <span class="text-[13px]" :class="!e.result ? 'text-muted-foreground' : e.result.up ? 'text-ok' : 'text-tier-high-fg'" role="status">
            <template v-if="!e.result">{{ checkFailed ? `${checkError} Trying again in 10 s.` : 'Checking' }}</template>
            <template v-else-if="e.result.up">Answering.</template>
            <template v-else>{{ e.result.error || 'No answer yet.' }}</template>
          </span>
        </div>
      </div>
      <p v-if="checkFailed && check" class="text-xs text-muted-foreground" role="status">{{ checkError }} Showing the previous answer and trying again in 10 s.</p>
      <p v-if="formError" class="text-[13px] text-destructive" role="alert">{{ formError }}</p>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <span v-if="!ready" class="mr-auto text-xs text-muted-foreground">Finish is available when both exporters answer.</span>
        <button type="button" :class="btn" class="border border-border hover:bg-chip" @click="runCheck">Check now</button>
        <button
          type="button"
          :class="[btn, ready && !activating ? 'bg-primary text-primary-foreground' : 'cursor-not-allowed bg-border text-faint']"
          :aria-disabled="!ready || activating"
          @click="finish"
        >
          {{ activating ? 'Activating' : 'Finish' }}
        </button>
      </div>
    </template>

    <!-- Step 4 -->
    <template v-else>
      <div class="flex flex-wrap items-center gap-3 rounded-[10px] bg-okbg px-4 py-3.5 text-ok" role="status">
        <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17l9-10" /></svg>
        <span class="font-medium">{{ form.name }} is active.</span>
        <span>It now appears in Overview, Resources and Containers. Its history starts now.</span>
      </div>
      <div class="flex flex-wrap gap-2">
        <a :href="links.resources" :class="btn" class="border border-border text-foreground no-underline hover:bg-chip">Open Resources</a>
        <a :href="links.containers" :class="btn" class="border border-border text-foreground no-underline hover:bg-chip">Open Containers</a>
        <a :href="links.project" :class="btn" class="bg-primary text-primary-foreground no-underline">Add a project on it</a>
      </div>
      <p class="text-xs text-muted-foreground">Archive a server from its row later. Archived servers stop being scraped, but their history and incidents keep their name.</p>
    </template>
  </section>
</template>
