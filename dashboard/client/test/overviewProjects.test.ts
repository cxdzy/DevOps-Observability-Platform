// The Projects section of the Overview page. Runs with the Node test runner, which strips the
// types: node --test test/overviewProjects.test.ts (from dashboard/client).
// Archived projects are filtered by the server (dashboard/server/projects.js returns active ones
// only), so the client receives active projects and shows exactly what it receives.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_TEXT, ERROR_TEXT, modelLabel, overviewRows, pickForecast } from '../src/lib/overviewProjects.ts'

const project = (key: string, over: Record<string, unknown> = {}, containers: string[] = ['app']): any => ({
  key,
  name: key,
  server: { key: 'main', name: 'Main server' },
  containers: containers.map(name => ({ name, up: true, restarts24h: 0, memBytes: null, limitBytes: null })),
  status: 'healthy',
  watchedByModel: true,
  automation: 'approval',
  ...over,
})
const fc = (project: string, container: string, state: string): any => ({ project, container, state })

test('model label: watched with approval', () => {
  assert.equal(modelLabel({ watchedByModel: true, automation: 'approval' }), 'Model and automation')
})

test('model label: not watched is monitored only', () => {
  assert.equal(modelLabel({ watchedByModel: false, automation: 'approval' }), 'Monitored only')
})

test('model label: watched but automation monitored is monitored only', () => {
  assert.equal(modelLabel({ watchedByModel: true, automation: 'monitored' }), 'Monitored only')
})

test('an empty list gives no rows', () => {
  assert.deepEqual(overviewRows([], []), [])
})

test('overviewRows maps exactly the rows it receives', () => {
  const rows = overviewRows([project('a'), project('b'), project('c')], null)
  assert.deepEqual(rows.map(r => r.key), ['a', 'b', 'c'])
})

test('pickForecast returns the worst state', () => {
  const p = project('x', {}, ['a', 'b', 'c'])
  const list = [fc('x', 'a', 'ok'), fc('x', 'b', 'warning'), fc('x', 'c', 'no_data')]
  assert.equal(pickForecast(p, list)?.container, 'b')
  assert.equal(pickForecast(p, [...list, fc('x', 'a', 'restarting')])?.state, 'restarting')
})

test('pickForecast ranks no_limit above not_enough_data above ok above no_data', () => {
  const p = project('x', {}, ['a', 'b', 'c', 'd'])
  const list = [fc('x', 'a', 'no_data'), fc('x', 'b', 'ok'), fc('x', 'c', 'not_enough_data'), fc('x', 'd', 'no_limit')]
  assert.equal(pickForecast(p, list)?.container, 'd')
  assert.equal(pickForecast(p, list.slice(0, 3))?.container, 'c')
})

test('pickForecast: the first entry wins a tie', () => {
  const p = project('x', {}, ['a', 'b'])
  assert.equal(pickForecast(p, [fc('x', 'b', 'ok'), fc('x', 'a', 'ok')])?.container, 'b')
})

test('pickForecast is null without a matching entry', () => {
  const p = project('x')
  assert.equal(pickForecast(p, []), null)
  assert.equal(pickForecast(p, null), null)
  assert.equal(pickForecast(p, undefined), null)
  assert.equal(pickForecast(p, [fc('other', 'app', 'warning')]), null)
  assert.equal(pickForecast(p, [fc('x', 'not-in-project', 'warning')]), null)
})

test('href encodes the key', () => {
  const [row] = overviewRows([project('a b/c')], [])
  assert.equal(row?.href, '#projects?project=a%20b%2Fc')
})

test('status text for each status and an unknown one', () => {
  const text = (status: string) => overviewRows([project('x', { status })], [])[0]?.statusText
  assert.equal(text('healthy'), 'Healthy')
  assert.equal(text('incident'), 'Incident')
  assert.equal(text('partial'), 'Partly down')
  assert.equal(text('down'), 'Down')
  assert.equal(text('no_data'), 'No data')
  assert.equal(text('surprise'), 'No data')
})

test('server falls back to No data', () => {
  assert.equal(overviewRows([project('x', { server: undefined })], [])[0]?.server, 'No data')
  assert.equal(overviewRows([project('x')], [])[0]?.server, 'Main server')
})

test('the empty and error texts', () => {
  assert.equal(EMPTY_TEXT, 'No projects yet. Add one in Settings.')
  assert.equal(ERROR_TEXT, 'The projects could not be loaded. Retrying in 30 s.')
})
