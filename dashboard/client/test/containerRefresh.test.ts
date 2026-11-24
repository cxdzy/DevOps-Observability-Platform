// The Refresh button of the container list in Add project. Runs with the Node test runner, which
// strips the types: node --test test/containerRefresh.test.ts (from dashboard/client).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRefresh, untickedText } from '../src/composables/containerRefresh.ts'

const free = (name: string) => ({ name, available: true, reason: null })
const taken = (name: string, reason = 'Already in shop') => ({ name, available: false, reason })

test('a refresh keeps the ticked containers that still exist and adds new ones to the list', () => {
  const prev = { containers: [free('api'), free('web')], picked: ['api', 'web'] }
  const out = applyRefresh(prev, [free('api'), free('web'), free('worker-new')])
  assert.equal(out.ok, true)
  assert.deepEqual(out.picked, ['api', 'web'])
  assert.deepEqual(out.containers.map(c => c.name), ['api', 'web', 'worker-new'])
  assert.deepEqual(out.gone, [])
  assert.deepEqual(out.blocked, [])
  assert.equal(untickedText(out.gone, out.blocked), '')
})

test('a ticked container that disappeared is unticked', () => {
  const prev = { containers: [free('api'), free('web')], picked: ['api', 'web'] }
  const out = applyRefresh(prev, [free('api')])
  assert.deepEqual(out.picked, ['api'])
  assert.deepEqual(out.gone, ['web'])
  assert.equal(untickedText(out.gone, out.blocked), 'Unticked because web is no longer on the server.')
})

test('a ticked container that can no longer be picked is unticked', () => {
  const prev = { containers: [free('api'), free('web')], picked: ['api', 'web'] }
  const out = applyRefresh(prev, [free('api'), taken('web')])
  assert.deepEqual(out.picked, ['api'])
  assert.deepEqual(out.blocked, ['web'])
  assert.equal(untickedText(['a', 'b'], ['web']), 'Unticked because a, b are no longer on the server and web can no longer be picked.')
})

test('a failed refresh keeps the old list and the ticks', () => {
  const prev = { containers: [free('api'), taken('db')], picked: ['api'] }
  const out = applyRefresh(prev, null)
  assert.equal(out.ok, false)
  assert.equal(out.containers, prev.containers)
  assert.deepEqual(out.picked, ['api'])
  assert.deepEqual(out.gone, [])
})

test('an empty refreshed list unticks everything', () => {
  const out = applyRefresh({ containers: [free('api')], picked: ['api'] }, [])
  assert.deepEqual(out.containers, [])
  assert.deepEqual(out.picked, [])
  assert.deepEqual(out.gone, ['api'])
})
