// Pure state logic of the collapsible sidebar. The client has no test runner, so this runs with the
// Node test runner, which strips the types: node --test test/useSidebar.test.ts (from dashboard/client).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isToggleShortcut, parseSidebar, readSidebar, SIDEBAR_KEY, writeSidebar } from '../src/composables/useSidebar.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)) },
  }
}

const throwing = {
  getItem: () => { throw new Error('SecurityError: storage is blocked') },
  setItem: () => { throw new Error('QuotaExceededError') },
}

function key(overrides: Partial<Parameters<typeof isToggleShortcut>[0]> = {}) {
  return { key: '[', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: { tagName: 'BODY' }, ...overrides }
}

test('the default is expanded when nothing is stored', () => {
  assert.equal(readSidebar(() => memoryStorage()), 'expanded')
  assert.equal(readSidebar(() => null), 'expanded')
  assert.equal(parseSidebar(null), 'expanded')
})

test('a stored value is used', () => {
  assert.equal(readSidebar(() => memoryStorage({ [SIDEBAR_KEY]: 'collapsed' })), 'collapsed')
  assert.equal(readSidebar(() => memoryStorage({ [SIDEBAR_KEY]: 'expanded' })), 'expanded')
})

test('an invalid stored value is ignored', () => {
  for (const bad of ['', 'Collapsed', 'true', '1', '{"v":"collapsed"}', ' collapsed']) {
    assert.equal(readSidebar(() => memoryStorage({ [SIDEBAR_KEY]: bad })), 'expanded', bad)
  }
})

test('toggling writes the new value under the sidebar key', () => {
  const storage = memoryStorage()
  assert.equal(writeSidebar(() => storage, 'collapsed'), true)
  assert.equal(storage.data.get('sidebar'), 'collapsed')
  assert.equal(readSidebar(() => storage), 'collapsed')
  assert.equal(writeSidebar(() => storage, 'expanded'), true)
  assert.equal(readSidebar(() => storage), 'expanded')
})

test('storage that throws is survived on read and on write', () => {
  assert.equal(readSidebar(() => throwing), 'expanded')
  assert.equal(writeSidebar(() => throwing, 'collapsed'), false)
  // Reading window.localStorage itself throws when the browser blocks storage.
  const blocked = () => { throw new Error('SecurityError: access denied') }
  assert.equal(readSidebar(blocked), 'expanded')
  assert.equal(writeSidebar(blocked, 'collapsed'), false)
  assert.equal(writeSidebar(() => null, 'collapsed'), false)
})

test('"[" toggles on desktop when no field has focus', () => {
  assert.equal(isToggleShortcut(key(), true), true)
  assert.equal(isToggleShortcut(key({ target: { tagName: 'A' } }), true), true)
  assert.equal(isToggleShortcut(key({ target: { tagName: 'BUTTON' } }), true, { tagName: 'BUTTON' }), true)
})

test('the shortcut is ignored while typing', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'textarea']) {
    assert.equal(isToggleShortcut(key({ target: { tagName } }), true), false, tagName)
  }
  assert.equal(isToggleShortcut(key({ target: { tagName: 'DIV', isContentEditable: true } }), true), false)
  // The focused element is checked as well as the event target.
  assert.equal(isToggleShortcut(key(), true, { tagName: 'TEXTAREA' }), false)
  assert.equal(isToggleShortcut(key({ isComposing: true }), true), false)
})

test('the shortcut is ignored with any modifier key', () => {
  for (const mod of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const) {
    assert.equal(isToggleShortcut(key({ [mod]: true }), true), false, mod)
  }
  // AltGr reports Ctrl and Alt together.
  assert.equal(isToggleShortcut(key({ ctrlKey: true, altKey: true }), true), false)
})

test('the shortcut is ignored for other keys, on repeat, when handled, and below 768 px', () => {
  assert.equal(isToggleShortcut(key({ key: ']' }), true), false)
  assert.equal(isToggleShortcut(key({ key: '{' }), true), false)
  assert.equal(isToggleShortcut(key({ repeat: true }), true), false)
  assert.equal(isToggleShortcut(key({ defaultPrevented: true }), true), false)
  assert.equal(isToggleShortcut(key(), false), false)
})
