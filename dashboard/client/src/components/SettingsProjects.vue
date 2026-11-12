<script setup lang="ts">
import type { ApiErrorInfo, ErrorField, PickableContainer, RollbackSetting, ServerBrief, SettingsProject } from '@/types'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { apiError, toPickableContainer, toSettingsProject } from '@/types'

// The Projects tab: the table, Add project (name, server, repository link, containers picked from
// what cAdvisor sees on that server) and Archive. Every project added here is detected from image
// changes and monitored only; the other choices are shown but cannot be selected.
// initialServer: a server key to choose first, from #settings?tab=projects&server=<key>.
const props = defineProps<{ initialServer?: string | null }>()
const emit = defineEmits<{ refreshed: [ok: boolean] }>()

const GRID = 'grid grid-cols-[minmax(0,1.1fr)_110px_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_80px] gap-3'

const projects = ref<SettingsProject[]>([])
const servers = ref<ServerBrief[]>([])
const loading = ref(true)
const failed = ref(false)

async function load() {
  try {
    const [p, s] = await Promise.all([
      api.get<unknown[]>('/api/settings/projects'),
      api.get<ServerBrief[]>('/api/servers'),
    ])
    if (!Array.isArray(p.data) || !Array.isArray(s.data)) throw new Error('unexpected response')
    projects.value = p.data.map(toSettingsProject)
    servers.value = s.data
    failed.value = false
    // The first answer chooses the hinted server, or the first one. A chosen server that is no
    // longer active is replaced.
    const keys = servers.value.map(x => x.key)
    if (!form.server || !keys.includes(form.server)) {
      form.server = props.initialServer && keys.includes(props.initialServer) ? props.initialServer : (keys[0] ?? '')
    }
    emit('refreshed', true)
  } catch {
    failed.value = true
    emit('refreshed', false)
  } finally {
    loading.value = false
  }
}
const { refresh } = usePoll(load, 30000)

function serverName(key: string): string {
  return servers.value.find(s => s.key === key)?.name ?? key
}

// The server switch is a radio group: one tab stop, arrow keys move the choice.
function onServerKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
  if (!step || !servers.value.length) return
  event.preventDefault()
  const i = Math.max(0, servers.value.findIndex(s => s.key === form.server))
  form.server = servers.value[(i + step + servers.value.length) % servers.value.length].key
  // Focus follows the choice once the DOM has updated.
  const group = event.currentTarget as HTMLElement
  nextTick(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
}
const shown = computed(() => projects.value.filter(p => p.status === 'active'))
const serverCount = computed(() => new Set(shown.value.map(p => p.serverKey)).size)

// Add project.
const form = reactive({ name: '', server: '', repoUrl: '' })
const picked = ref<string[]>([])
const error = ref<ApiErrorInfo | null>(null)
const saving = ref(false)
const saved = ref<string | null>(null)

function fieldError(field: ErrorField): string | null {
  return error.value?.field === field ? error.value.message : null
}
const formError = computed(() => (error.value && !error.value.field ? error.value.message : null))

const containers = ref<PickableContainer[]>([])
const containersState = ref<'idle' | 'loading' | 'failed'>('idle')
const containersError = ref('')
async function loadContainers() {
  const wanted = form.server
  containers.value = []
  if (!wanted) {
    containersState.value = 'idle'
    return
  }
  containersState.value = 'loading'
  try {
    const res = await api.get<unknown[]>(`/api/settings/servers/${encodeURIComponent(wanted)}/containers`)
    if (wanted !== form.server) return
    if (!Array.isArray(res.data)) throw new Error('unexpected response')
    containers.value = res.data.map(toPickableContainer).filter(c => c.name)
    containersState.value = 'idle'
  } catch (err) {
    if (wanted !== form.server) return
    containersError.value = apiError(err, 'The containers on this server could not be read. cAdvisor may not be answering.').message
    containersState.value = 'failed'
  }
}
watch(() => form.server, () => {
  picked.value = []
  loadContainers()
})

function toggle(c: PickableContainer) {
  if (!c.available) return
  picked.value = picked.value.includes(c.name) ? picked.value.filter(n => n !== c.name) : [...picked.value, c.name]
}

const summary = computed(() => {
  const n = picked.value.length
  if (!n) return 'Pick at least one container.'
  return `Saves ${n} container${n > 1 ? 's' : ''} on ${serverName(form.server)} as one project, monitored only. Logged under your name.`
})

async function save() {
  if (!picked.value.length) {
    error.value = { message: 'Pick at least one container.', field: 'containers' }
    return
  }
  error.value = null
  saved.value = null
  saving.value = true
  try {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      server_key: form.server,
      containers: picked.value,
      // New projects are always detected from image changes and monitored only.
      deploy_source: 'image',
      automation: 'monitored',
    }
    if (form.repoUrl.trim()) body.repo_url = form.repoUrl.trim()
    await api.post('/api/settings/projects', body)
    saved.value = form.name.trim()
    form.name = ''
    form.repoUrl = ''
    picked.value = []
    refresh()
    loadContainers()
  } catch (err) {
    error.value = apiError(err)
  } finally {
    saving.value = false
  }
}

// Archive asks first and says what it stops and what it keeps.
const confirming = ref<SettingsProject | null>(null)
const archiveError = ref<string | null>(null)
const archiving = ref(false)
const confirmCancel = ref<HTMLButtonElement | null>(null)
// The Archive button that opened the confirmation; focus goes back to it on Cancel or Escape.
let opener: HTMLElement | null = null
function askArchive(p: SettingsProject) {
  const el = document.activeElement
  opener = el instanceof HTMLElement && el !== document.body ? el : null
  confirming.value = p
  archiveError.value = null
  // Focus goes to Cancel in the confirmation, the safe choice.
  nextTick(() => confirmCancel.value?.focus())
}
function closeConfirm() {
  const el = opener
  opener = null
  confirming.value = null
  archiveError.value = null
  nextTick(() => { if (el && el.isConnected) el.focus() })
}
async function archive() {
  if (!confirming.value) return
  archiving.value = true
  archiveError.value = null
  try {
    await api.post(`/api/settings/projects/${encodeURIComponent(confirming.value.key)}/archive`, {})
    confirming.value = null
    opener = null
    refresh()
    loadContainers()
  } catch (err) {
    archiveError.value = apiError(err).message
  } finally {
    archiving.value = false
  }
}

// The Rollback choice of a project that is not built in: its own pipeline, or none. Saved at once.
const rollbackSaving = ref<string | null>(null)
const rollbackError = ref<{ key: string, message: string } | null>(null)
function rollbackText(mode: RollbackSetting): string {
  return mode === 'n8n' ? 'By n8n, after approval on Telegram' : mode === 'none' ? 'None' : 'Handled by its own pipeline'
}
async function setRollback(p: SettingsProject, select: HTMLSelectElement) {
  const value = select.value
  if ((value !== 'own_pipeline' && value !== 'none') || value === p.rollback) {
    select.value = p.rollback
    return
  }
  rollbackSaving.value = p.key
  rollbackError.value = null
  try {
    await api.patch(`/api/settings/projects/${encodeURIComponent(p.key)}`, { rollback: value })
    p.rollback = value
  } catch (err) {
    rollbackError.value = { key: p.key, message: apiError(err).message }
    // The bound value has not changed, so the list would keep showing the refused choice.
    select.value = p.rollback
  } finally {
    rollbackSaving.value = null
    // A saved or refused change is read back, so the choice shown is what the server holds.
    refresh()
  }
}

function containerSub(c: PickableContainer): string {
  return c.available ? 'Running, not in a project' : (c.reason ?? 'Not available')
}
function containersText(p: SettingsProject): string {
  const n = p.containers.length
  return n ? `${n} container${n > 1 ? 's' : ''}: ${p.containers.join(', ')}` : 'No containers'
}

const inputClass = 'min-h-[38px] rounded-lg border bg-card px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground'
const btn = 'inline-flex min-h-9 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium pointer-coarse:min-h-11'
</script>

<template>
  <section aria-label="Projects" class="overflow-hidden rounded-xl border border-border">
    <div class="flex items-center justify-between gap-3 px-[18px] py-3.5">
      <span class="text-[15px] font-semibold">Projects</span>
      <span v-if="!loading && !failed" class="text-xs text-muted-foreground">
        {{ shown.length }} project{{ shown.length === 1 ? '' : 's' }} on {{ serverCount }} server{{ serverCount === 1 ? '' : 's' }}
      </span>
    </div>
    <!-- relative: the sr-only labels inside are position absolute and must stay inside this scroll box -->
    <div class="relative overflow-x-auto">
      <div class="min-w-[900px]">
        <div :class="GRID" class="bg-chip px-[18px] py-2 text-xs font-medium text-muted-foreground">
          <span>Project</span><span>Server</span><span>Deployments from</span><span>Automation</span><span>Rollback</span><span><span class="sr-only">Actions</span></span>
        </div>

        <div v-if="loading" class="flex flex-col gap-3 px-[18px] py-4" role="status" aria-label="Loading projects">
          <Skeleton v-for="i in 2" :key="i" class="h-9 rounded-md" />
        </div>
        <div v-else-if="failed && projects.length === 0" class="flex flex-col items-start gap-3 border-t border-border px-[18px] py-4" role="alert">
          <p class="text-[13px] text-muted-foreground">The projects could not be loaded. Retrying in 30 s.</p>
          <button type="button" :class="btn" class="border border-border hover:bg-chip" @click="refresh">Retry now</button>
        </div>
        <p v-else-if="shown.length === 0" class="border-t border-border px-[18px] py-6 text-[13px] text-muted-foreground">
          No projects yet. Add one below.
        </p>
        <div v-for="p in shown" :key="p.key" :class="GRID" class="items-center border-t border-border px-[18px] py-3">
          <span class="flex min-w-0 flex-col">
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span class="min-w-0 font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{{ p.name }}</span>
              <a v-if="p.repoUrl" :href="p.repoUrl" target="_blank" rel="noopener noreferrer" class="shrink-0 text-xs text-muted-foreground underline">Repository<span class="sr-only"> of {{ p.name }}, opens in a new tab</span></a>
            </span>
            <span class="truncate text-xs text-muted-foreground" :title="containersText(p)">{{ containersText(p) }}</span>
          </span>
          <span class="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere]">{{ p.serverName }}</span>
          <span
            class="w-fit max-w-full rounded-[10px] px-2.5 py-0.5 text-xs leading-snug font-semibold"
            :class="p.deploySource === 'ci' ? 'bg-foreground text-card' : 'bg-chip text-chipfg'"
          >{{ p.deploySource === 'ci' ? 'CI events (verified)' : 'Image changes (detected)' }}</span>
          <span
            class="w-fit max-w-full rounded-[10px] px-2.5 py-0.5 text-xs leading-snug font-semibold"
            :class="p.automation === 'approval' ? 'bg-okbg text-ok' : 'border border-dashed border-input text-chipfg'"
          >{{ p.automation === 'approval' ? 'Restart and rollback with approval' : 'Monitored only' }}</span>
          <span v-if="p.builtin" class="text-[13px] text-chipfg">{{ rollbackText(p.rollback) }}</span>
          <span v-else class="flex min-w-0 flex-col gap-1">
            <select
              class="min-h-8 w-full max-w-[260px] rounded-lg border border-input bg-card px-2 text-[13px] text-foreground disabled:opacity-50 pointer-coarse:min-h-11"
              :aria-label="`Rollback for ${p.name}`"
              :value="p.rollback"
              :disabled="rollbackSaving === p.key"
              @change="setRollback(p, $event.target as HTMLSelectElement)"
            >
              <option value="own_pipeline">Handled by its own pipeline</option>
              <option value="none">None</option>
            </select>
            <span v-if="rollbackError && rollbackError.key === p.key" class="text-xs text-destructive" role="alert">{{ rollbackError.message }}</span>
          </span>
          <span class="flex justify-end">
            <button v-if="!p.builtin" type="button" class="min-h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-chip hover:text-foreground pointer-coarse:min-h-11" :aria-label="`Archive ${p.name}`" @click="askArchive(p)">Archive</button>
          </span>
        </div>
      </div>
    </div>
  </section>

  <div v-if="confirming" class="flex flex-col gap-3 rounded-xl border border-dashed border-input p-[18px]" role="alertdialog" :aria-label="`Archive ${confirming.name}`" @keydown.esc.stop="closeConfirm">
    <span class="text-[15px] font-semibold">Archive <span class="font-mono">{{ confirming.name }}</span>?</span>
    <p class="text-[13px] text-chipfg">
      This stops monitoring and deployment detection for the project and frees its containers to be picked again. Its history, incidents and name are kept, and the containers keep running. Nothing is deleted.
    </p>
    <p v-if="archiveError" class="text-[13px] text-destructive" role="alert">{{ archiveError }}</p>
    <div class="flex justify-end gap-2">
      <button ref="confirmCancel" type="button" :class="btn" class="border border-border hover:bg-chip" @click="closeConfirm">Cancel</button>
      <button type="button" :class="btn" class="bg-primary text-primary-foreground disabled:opacity-50" :disabled="archiving" @click="archive">{{ archiving ? 'Archiving' : 'Archive project' }}</button>
    </div>
  </div>

  <form aria-label="Add project" class="flex flex-col gap-4 rounded-xl border border-border p-[18px]" novalidate @submit.prevent="save">
    <span class="text-[15px] font-semibold">Add project</span>
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-3.5">
      <label class="flex flex-col gap-1.5 text-[13px] font-medium">
        Name
        <input
          v-model="form.name"
          class="font-mono"
          :class="[inputClass, fieldError('name') ? 'border-destructive' : 'border-input']"
          autocomplete="off"
          spellcheck="false"
          placeholder="new-project"
          :aria-invalid="!!fieldError('name')"
        >
        <span v-if="fieldError('name')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('name') }}</span>
      </label>
      <div class="flex flex-col gap-1.5 text-[13px] font-medium">
        <span id="project-server">Server</span>
        <div role="radiogroup" aria-labelledby="project-server" class="flex w-max max-w-full flex-wrap gap-0.5 rounded-lg bg-chip p-[3px]" @keydown="onServerKey">
          <button
            v-for="s in servers"
            :key="s.key"
            type="button"
            role="radio"
            :aria-checked="form.server === s.key"
            :tabindex="form.server === s.key || (!form.server && s === servers[0]) ? 0 : -1"
            class="inline-flex min-h-8 items-center rounded-md px-3 font-mono text-[13px] pointer-coarse:min-h-11"
            :class="form.server === s.key ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'"
            @click="form.server = s.key"
          >
            {{ s.name }}
          </button>
          <span v-if="servers.length === 0" class="px-3 py-1.5 text-xs font-normal text-muted-foreground">No active servers</span>
        </div>
        <span v-if="fieldError('server_key')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('server_key') }}</span>
      </div>
      <label class="flex flex-col gap-1.5 text-[13px] font-medium">
        Repository link (optional)
        <input
          v-model="form.repoUrl"
          type="url"
          maxlength="200"
          :class="[inputClass, fieldError('repo_url') ? 'border-destructive' : 'border-input']"
          autocomplete="off"
          placeholder="https://github.com/owner/repo"
          :aria-invalid="!!fieldError('repo_url')"
        >
        <span v-if="fieldError('repo_url')" class="text-xs font-normal text-destructive" role="alert">{{ fieldError('repo_url') }}</span>
        <span v-else class="text-xs font-normal text-muted-foreground">Shown as a link only. Nothing is read from it.</span>
      </label>
    </div>

    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <span id="project-containers" class="text-[13px] font-medium">Containers on <span class="font-mono">{{ form.server ? serverName(form.server) : 'the server' }}</span></span>
        <span class="text-xs text-muted-foreground">From cAdvisor, live. Containers already in a project or used by the platform cannot be picked.</span>
      </div>
      <div v-if="containersState === 'loading'" class="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-2" role="status" aria-label="Loading containers">
        <Skeleton v-for="i in 4" :key="i" class="h-[52px] rounded-[10px]" />
      </div>
      <div v-else-if="containersState === 'failed'" class="flex flex-col items-start gap-3 rounded-[10px] border border-border p-4" role="alert">
        <p class="text-[13px] text-muted-foreground">{{ containersError }}</p>
        <button type="button" :class="btn" class="border border-border hover:bg-chip" @click="loadContainers">Try again</button>
      </div>
      <p v-else-if="containers.length === 0" class="rounded-[10px] border border-dashed border-input px-4 py-3 text-[13px] text-muted-foreground">
        {{ form.server ? 'cAdvisor sees no containers on this server.' : 'Choose a server to see its containers.' }}
      </p>
      <div v-else role="group" aria-labelledby="project-containers" class="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-2">
        <button
          v-for="c in containers"
          :key="c.name"
          type="button"
          role="checkbox"
          :aria-checked="picked.includes(c.name)"
          :aria-disabled="!c.available"
          class="flex min-h-[52px] items-center gap-2.5 rounded-[10px] px-3 py-2 text-left"
          :class="!c.available
            ? 'cursor-not-allowed border border-dashed border-strip bg-background text-idle dark:border-[#3A4452]'
            : picked.includes(c.name)
              ? 'border border-primary bg-card ring-1 ring-primary'
              : 'border border-border bg-card hover:bg-chip'"
          @click="toggle(c)"
        >
          <span
            class="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-xs font-bold"
            :class="picked.includes(c.name) ? 'bg-primary text-primary-foreground' : c.available ? 'border-[1.5px] border-input' : 'border-[1.5px] border-strip dark:border-[#3A4452]'"
            aria-hidden="true"
          >{{ picked.includes(c.name) ? '✓' : '' }}</span>
          <span class="flex min-w-0 flex-col">
            <span class="truncate font-mono text-[13px]">{{ c.name }}</span>
            <span class="text-xs" :class="c.available ? 'text-muted-foreground' : 'text-inherit'">{{ containerSub(c) }}</span>
          </span>
        </button>
      </div>
      <span v-if="fieldError('containers')" class="text-xs text-destructive" role="alert">{{ fieldError('containers') }}</span>
    </div>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-3.5">
      <div class="flex flex-col gap-2">
        <span class="text-[13px] font-medium">Deployments</span>
        <div class="rounded-[10px] border border-border px-3.5 py-3 text-[13px] text-chipfg">
          <span class="font-medium text-foreground">Detected from image changes.</span>
          When a picked container comes back with a different image or tag, that is recorded as a deployment. The project's own CI needs no change.
        </div>
      </div>
      <div class="flex flex-col gap-2">
        <span id="project-automation" class="text-[13px] font-medium">Automation</span>
        <div role="radiogroup" aria-labelledby="project-automation" class="flex flex-col gap-1.5">
          <!-- The only choice for a new project. It is a tab stop so the group can be reached by keyboard;
               the approval option below is announced as unavailable and cannot be chosen. -->
          <span role="radio" aria-checked="true" tabindex="0" class="flex gap-2.5 rounded-[10px] border border-primary px-3 py-2.5 text-[13px]">
            <span class="mt-0.5 size-4 shrink-0 rounded-full border-[5px] border-primary" aria-hidden="true" />
            <span>
              <span class="font-medium">Monitored only</span><br>
              <span class="text-muted-foreground">Health, restarts, memory and deployments. No automatic action.</span>
            </span>
          </span>
          <span role="radio" aria-checked="false" aria-disabled="true" class="flex gap-2.5 rounded-[10px] border border-dashed border-input px-3 py-2.5 text-[13px] text-faint">
            <span class="mt-0.5 size-4 shrink-0 rounded-full border-[1.5px] border-input" aria-hidden="true" />
            <span>
              <span class="font-medium">Restart and rollback with approval</span><br>
              Needs its own anomaly model and an n8n allowlist entry, which are set in code, not here. Only sample-service has it.
            </span>
          </span>
        </div>
      </div>
    </div>

    <p v-if="formError" class="text-[13px] text-destructive" role="alert">{{ formError }}</p>
    <p v-if="saved" class="text-[13px] text-ok" role="status">{{ saved }} was added and appears in the table above.</p>
    <div class="flex flex-wrap items-center justify-between gap-2.5 border-t border-border pt-3.5">
      <span class="text-xs text-muted-foreground">{{ summary }}</span>
      <button
        type="submit"
        :class="[btn, picked.length && !saving ? 'bg-primary text-primary-foreground' : 'cursor-not-allowed bg-border text-faint']"
        :aria-disabled="!picked.length || saving"
        :disabled="saving"
      >
        {{ saving ? 'Saving' : 'Save project' }}
      </button>
    </div>
  </form>
</template>
