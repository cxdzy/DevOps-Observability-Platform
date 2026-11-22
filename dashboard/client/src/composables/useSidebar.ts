import type { Ref } from 'vue'
import { computed, ref } from 'vue'

export type SidebarState = 'expanded' | 'collapsed'

export const SIDEBAR_KEY = 'sidebar'
// The same width as the Tailwind md breakpoint. Below it the sidebar is the top bar and never collapses.
export const DESKTOP_QUERY = '(min-width: 768px)'

// The storage is passed as a function, so even reading window.localStorage (which throws when the
// browser blocks storage) happens inside the try.
type StorageSource = () => Pick<Storage, 'getItem' | 'setItem'> | null | undefined

// Anything other than the two known values (missing, old or edited by hand) means expanded.
export function parseSidebar(value: unknown): SidebarState {
  return value === 'collapsed' ? 'collapsed' : 'expanded'
}

export function readSidebar(storage: StorageSource): SidebarState {
  try {
    return parseSidebar(storage()?.getItem(SIDEBAR_KEY))
  } catch {
    return 'expanded'
  }
}

// Returns false when the choice could not be saved; it then lasts until the page is reloaded.
export function writeSidebar(storage: StorageSource, value: SidebarState): boolean {
  try {
    const target = storage()
    if (!target) return false
    target.setItem(SIDEBAR_KEY, value)
    return true
  } catch {
    return false
  }
}

// True for a field the user types into. isContentEditable is also true inside a contenteditable box.
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as { tagName?: unknown, isContentEditable?: unknown }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

export interface ShortcutEvent {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
  defaultPrevented?: boolean
  target: unknown
}

// "[" alone toggles the sidebar on desktop. It is ignored while a field has focus, with any modifier
// key held (AltGr counts, so layouts that need it for "[" are left alone), while an input method is
// composing, on key repeat, and when something else already handled the key.
export function isToggleShortcut(event: ShortcutEvent, desktop: boolean, active: unknown = null): boolean {
  if (!desktop || event.key !== '[') return false
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false
  if (event.repeat || event.isComposing || event.defaultPrevented) return false
  return !isTypingTarget(event.target) && !isTypingTarget(active)
}

// One shared state for the app, read from storage the first time a component asks for it. The
// sidebar is first drawn after the session check, so it starts in the stored state and does not flash.
let state: Ref<SidebarState> | null = null
let desktop: Ref<boolean> | null = null

function browserStorage() {
  return window.localStorage
}

export function useSidebar() {
  if (!state) state = ref(readSidebar(browserStorage))
  if (!desktop) {
    const media = window.matchMedia(DESKTOP_QUERY)
    const wide = ref(media.matches)
    media.addEventListener('change', (event) => { wide.value = event.matches })
    desktop = wide
  }
  const current = state
  const collapsed = computed(() => current.value === 'collapsed')

  function toggle() {
    const next: SidebarState = current.value === 'collapsed' ? 'expanded' : 'collapsed'
    current.value = next
    writeSidebar(browserStorage, next)
  }

  return { collapsed, desktop: desktop as Readonly<Ref<boolean>>, toggle }
}
