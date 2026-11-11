<script setup lang="ts">
import type { ApiErrorInfo, ErrorField, SettingsServer } from '@/types'
import { nextTick, reactive, ref } from 'vue'
import AddServerWizard from '@/components/AddServerWizard.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { apiError, toSettingsServer } from '@/types'

// The Servers tab: the table with the two exporter dots, the add server wizard, editing role and
// location, and archiving. Nothing is deleted; an archived server stops being scraped and keeps
// its history and its name.
const emit = defineEmits<{ refreshed: [ok: boolean] }>()

const ROLES = [
  { value: 'application', label: 'Application server' },
  { value: 'staging', label: 'Staging' },
  { value: 'platform', label: 'Platform server' },
]
const ROLE_LABEL: Record<string, string> = { application: 'Application', staging: 'Staging', platform: 'Platform' }
const GRID = 'grid grid-cols-[minmax(0,1.2fr)_100px_minmax(0,1fr)_140px_140px_90px_150px] gap-3'

const servers = ref<SettingsServer[]>([])
const loading = ref(true)
const failed = ref(false)

async function load() {
  try {
    const res = await api.get<unknown[]>('/api/settings/servers')
    if (!Array.isArray(res.data)) throw new Error('unexpected response')
    servers.value = res.data.map(toSettingsServer)
    failed.value = false
    emit('refreshed', true)
  } catch {
    failed.value = true
    emit('refreshed', false)
  } finally {
    loading.value = false
  }
}
// Every 15 s, so the dots and a pending server's state stay current.
const { refresh } = usePoll(load, 15000)

// The control that opened the wizard or the confirmation. Closing either puts focus back on it,
// or on Add server when that control is gone (for example the row of an archived server).
const addButton = ref<HTMLButtonElement | null>(null)
let opener: HTMLElement | null = null
function rememberOpener() {
  const el = document.activeElement
  opener = el instanceof HTMLElement && el !== document.body ? el : null
}
function returnFocus() {
  const el = opener
  opener = null
  nextTick(() => {
    if (el && el.isConnected) el.focus()
    else addButton.value?.focus()
  })
}

// The wizard: closed, or open for a new server (server null) or for a pending one.
const wizard = ref<{ server: SettingsServer | null, id: number } | null>(null)
let wizardId = 0
function openWizard(server: SettingsServer | null) {
  rememberOpener()
  closeEdit()
  confirming.value = null
  wizard.value = { server, id: ++wizardId }
}
function closeWizard() {
  wizard.value = null
  returnFocus()
}

// Editing role and location.
const editing = ref<SettingsServer | null>(null)
const editForm = reactive({ role: 'application', location: '' })
const editError = ref<ApiErrorInfo | null>(null)
const editSaving = ref(false)
function startEdit(s: SettingsServer) {
  wizard.value = null
  confirming.value = null
  editing.value = s
  editForm.role = s.role || 'application'
  editForm.location = s.location
  editError.value = null
}
function closeEdit() {
  editing.value = null
  editError.value = null
}
function editFieldError(field: ErrorField): string | null {
  return editError.value?.field === field ? editError.value.message : null
}
async function saveEdit() {
  if (!editing.value) return
  // Only the fields that changed are sent, so the change log gets no empty "X to X" entries.
  const patch: Record<string, string> = {}
  if (editForm.role !== editing.value.role) patch.role = editForm.role
  if (editForm.location.trim() !== editing.value.location) patch.location = editForm.location.trim()
  if (!Object.keys(patch).length) {
    closeEdit()
    return
  }
  editSaving.value = true
  editError.value = null
  try {
    await api.patch(`/api/settings/servers/${encodeURIComponent(editing.value.key)}`, patch)
    closeEdit()
    refresh()
  } catch (err) {
    editError.value = apiError(err)
  } finally {
    editSaving.value = false
  }
}

// Archiving asks first and says what it stops and what it keeps.
const confirming = ref<SettingsServer | null>(null)
const archiveError = ref<string | null>(null)
const archiving = ref(false)
const confirmCancel = ref<HTMLButtonElement | null>(null)
function askArchive(s: SettingsServer) {
  rememberOpener()
  wizard.value = null
  closeEdit()
  confirming.value = s
  archiveError.value = null
  // Focus goes to Cancel in the confirmation, the safe choice.
  nextTick(() => confirmCancel.value?.focus())
}
// Cancel and Escape close the confirmation and return focus to the Archive button.
function closeConfirm() {
  confirming.value = null
  archiveError.value = null
  returnFocus()
}
async function archive() {
  if (!confirming.value) return
  archiving.value = true
  archiveError.value = null
  try {
    await api.post(`/api/settings/servers/${encodeURIComponent(confirming.value.key)}/archive`, {})
    confirming.value = null
    // The row's Archive button goes away, so focus goes to Add server.
    opener = null
    returnFocus()
    refresh()
  } catch (err) {
    archiveError.value = apiError(err).message
  } finally {
    archiving.value = false
  }
}

function dotClass(up: boolean | null) {
  return up === true ? 'bg-okdot' : up === false ? 'bg-red' : 'border-2 border-idle'
}
function exporterText(s: SettingsServer, up: boolean | null): string {
  if (up === true) return s.lastSeen ? `Up, ${ago(s.lastSeen)}` : 'Up'
  if (up === false) return s.status === 'pending' ? 'No answer yet' : 'No answer'
  return s.status === 'pending' ? 'Waiting' : 'Unknown'
}
function ago(at: number | string): string {
  const ms = typeof at === 'number' ? (at < 1e12 ? at * 1000 : at) : Date.parse(at)
  if (!Number.isFinite(ms)) return 'just now'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return `${s} s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}
function statusClass(status: string) {
  return status === 'active' ? 'bg-okbg text-ok' : status === 'archived' ? 'bg-chip text-faint' : 'border border-dashed border-input text-chipfg'
}
function tag(s: SettingsServer): string | null {
  return s.key === 'main' ? 'This server' : s.builtin ? 'Built in' : null
}

const inputClass = 'min-h-[38px] rounded-lg border bg-card px-2.5 text-[13px] text-foreground'
const btn = 'inline-flex min-h-9 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium pointer-coarse:min-h-11'
</script>

<template>
  <section aria-label="Servers" class="overflow-hidden rounded-xl border border-border">
    <div class="flex items-center justify-between gap-3 px-[18px] py-3.5">
      <span class="text-[15px] font-semibold">Servers</span>
      <button ref="addButton" type="button" :class="btn" class="gap-2 bg-primary text-primary-foreground" @click="openWizard(null)">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        Add server
      </button>
    </div>
    <!-- relative: the sr-only labels inside are position absolute and must stay inside this scroll box -->
    <div class="relative overflow-x-auto">
      <div class="min-w-[900px]">
        <div :class="GRID" class="bg-chip px-[18px] py-2 text-xs font-medium text-muted-foreground">
          <span>Server</span><span>Role</span><span>Location</span><span>node-exporter</span><span>cAdvisor</span><span>Status</span><span><span class="sr-only">Actions</span></span>
        </div>

        <div v-if="loading" class="flex flex-col gap-3 px-[18px] py-4" role="status" aria-label="Loading servers">
          <Skeleton v-for="i in 3" :key="i" class="h-9 rounded-md" />
        </div>
        <div v-else-if="failed && servers.length === 0" class="flex flex-col items-start gap-3 border-t border-border px-[18px] py-4" role="alert">
          <p class="text-[13px] text-muted-foreground">The servers could not be loaded. Retrying in 15 s.</p>
          <button type="button" :class="btn" class="border border-border hover:bg-chip" @click="refresh">Retry now</button>
        </div>
        <p v-else-if="servers.length === 0" class="border-t border-border px-[18px] py-6 text-[13px] text-muted-foreground">
          No servers yet. Use Add server to connect one.
        </p>
        <div
          v-for="s in servers"
          :key="s.key"
          :class="[GRID, s.status === 'archived' ? 'text-faint' : '']"
          class="items-center border-t border-border px-[18px] py-3"
        >
          <span class="flex min-w-0 flex-col">
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span class="min-w-0 font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{{ s.name }}</span>
              <span v-if="tag(s)" class="whitespace-nowrap rounded-md bg-chip px-1.5 text-[11px] font-semibold text-chipfg">{{ tag(s) }}</span>
            </span>
            <span class="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{{ s.address ?? (s.key === 'main' ? 'local' : 'Tailscale') }}</span>
          </span>
          <span>{{ ROLE_LABEL[s.role] ?? s.role }}</span>
          <span class="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{{ s.location }}</span>
          <span class="inline-flex items-center gap-1.5 text-[13px]">
            <span class="size-2 shrink-0 rounded-full" :class="dotClass(s.status === 'archived' ? null : s.nodeUp)" aria-hidden="true" />
            {{ s.status === 'archived' ? 'Not scraped' : exporterText(s, s.nodeUp) }}
          </span>
          <span class="inline-flex items-center gap-1.5 text-[13px]">
            <span class="size-2 shrink-0 rounded-full" :class="dotClass(s.status === 'archived' ? null : s.cadvisorUp)" aria-hidden="true" />
            {{ s.status === 'archived' ? 'Not scraped' : exporterText(s, s.cadvisorUp) }}
          </span>
          <span class="w-max rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize" :class="statusClass(s.status)">{{ s.status }}</span>
          <span class="flex flex-wrap justify-end gap-1">
            <button v-if="s.status === 'pending'" type="button" class="min-h-8 rounded-md px-2 text-xs font-medium hover:bg-chip pointer-coarse:min-h-11" @click="openWizard(s)">Continue setup</button>
            <button v-if="s.status !== 'archived'" type="button" class="min-h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-chip hover:text-foreground pointer-coarse:min-h-11" :aria-label="`Edit ${s.name}`" @click="startEdit(s)">Edit</button>
            <button v-if="s.status !== 'archived' && !s.builtin" type="button" class="min-h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-chip hover:text-foreground pointer-coarse:min-h-11" :aria-label="`Archive ${s.name}`" @click="askArchive(s)">Archive</button>
          </span>
        </div>
      </div>
    </div>
  </section>

  <form
    v-if="editing"
    class="flex flex-col gap-4 rounded-xl border border-border p-[18px]"
    :aria-label="`Edit ${editing.name}`"
    novalidate
    @submit.prevent="saveEdit"
  >
    <span class="text-[15px] font-semibold">Edit <span class="font-mono">{{ editing.name }}</span></span>
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-3.5">
      <label class="flex flex-col gap-1.5 text-[13px] font-medium">
        Role
        <select v-model="editForm.role" :class="[inputClass, editFieldError('role') ? 'border-destructive' : 'border-input']">
          <option v-for="r in ROLES" :key="r.value" :value="r.value">{{ r.label }}</option>
        </select>
        <span v-if="editFieldError('role')" class="text-xs font-normal text-destructive" role="alert">{{ editFieldError('role') }}</span>
      </label>
      <label class="flex flex-col gap-1.5 text-[13px] font-medium">
        Location
        <input v-model="editForm.location" maxlength="60" autocomplete="off" :class="[inputClass, editFieldError('location') ? 'border-destructive' : 'border-input']">
        <span v-if="editFieldError('location')" class="text-xs font-normal text-destructive" role="alert">{{ editFieldError('location') }}</span>
      </label>
    </div>
    <p v-if="editError && !editError.field" class="text-[13px] text-destructive" role="alert">{{ editError.message }}</p>
    <p class="text-xs text-muted-foreground">The name and address cannot be changed here. {{ editing.status === 'pending' ? 'To change the address, use Continue setup.' : '' }}</p>
    <div class="flex justify-end gap-2">
      <button type="button" :class="btn" class="border border-border hover:bg-chip" @click="closeEdit">Cancel</button>
      <button type="submit" :class="btn" class="bg-primary text-primary-foreground disabled:opacity-50" :disabled="editSaving">{{ editSaving ? 'Saving' : 'Save' }}</button>
    </div>
  </form>

  <div v-if="confirming" class="flex flex-col gap-3 rounded-xl border border-dashed border-input p-[18px]" role="alertdialog" :aria-label="`Archive ${confirming.name}`" @keydown.esc.stop="closeConfirm">
    <span class="text-[15px] font-semibold">Archive <span class="font-mono">{{ confirming.name }}</span>?</span>
    <p class="text-[13px] text-chipfg">
      This stops scraping the server and hides it from Overview, Resources and Containers. Its history, incidents and name are kept, and nothing is deleted.
    </p>
    <p v-if="archiveError" class="text-[13px] text-destructive" role="alert">{{ archiveError }}</p>
    <div class="flex justify-end gap-2">
      <button ref="confirmCancel" type="button" :class="btn" class="border border-border hover:bg-chip" @click="closeConfirm">Cancel</button>
      <button type="button" :class="btn" class="bg-primary text-primary-foreground disabled:opacity-50" :disabled="archiving" @click="archive">{{ archiving ? 'Archiving' : 'Archive server' }}</button>
    </div>
  </div>

  <AddServerWizard
    v-if="wizard"
    :key="wizard.id"
    :server="wizard.server"
    @changed="refresh"
    @close="closeWizard"
  />
</template>
