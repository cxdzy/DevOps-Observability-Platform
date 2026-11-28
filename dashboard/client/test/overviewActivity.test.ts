// The Recent activity list on the Overview page. Runs with the Node test runner, which strips the
// types: node --test test/overviewActivity.test.ts (from dashboard/client).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildActivityRows, emptyText, filterOptions, filterRows, restartsLast24h } from '../src/lib/overviewActivity.ts'

const project = (key: string, over: Record<string, unknown> = {}, restarts: (number | null)[] = [0]): any => ({
  key,
  name: key,
  deploySource: 'ci',
  containers: restarts.map((r, i) => ({ name: `c${i}`, up: true, restarts24h: r, memBytes: null, limitBytes: null })),
  ...over,
})
const incident = (time: number): any => ({ type: 'incident', time, tier: 'medium', signal: 'cpu', action: 'restart', minutes: 5, peakScore: 0.9 })
const deploy = (time: number): any => ({ type: 'deployment', time, commit: 'abcdef123456', runId: '1', branch: 'master' })
const retrain = (time: number): any => ({ type: 'retrain', time, promoted: true, newVersion: '4', championVersion: '3', championF1: 0.8, challengerF1: 0.9 })
const run = (at: unknown, ref = 'ghcr.io/x/blog:v12abcdef0123456'): any => ({ at, source: 'image', ref, previousRef: null, detail: null })

const projects = [project('sample-service', { name: 'Sample service' }), project('blog', { name: 'Blog', deploySource: 'image' }, [2, null])]
const items = [incident(5000), deploy(4000), retrain(3000)]
const runs = { blog: [run(4500), run(1000)] }

test('rows are newest first and name their project', () => {
  const rows = buildActivityRows(items, projects, runs)
  assert.deepEqual(rows.map(r => r.time), [5000, 4500, 4000, 3000, 1000])
  assert.deepEqual(rows.map(r => r.project), ['Sample service', 'Blog', 'Sample service', 'platform', 'Blog'])
  assert.equal(rows[2].title, 'Sample service deployed')
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length)
})

test('project name falls back to sample-service when the project is missing', () => {
  const rows = buildActivityRows([incident(1)], [], {})
  assert.equal(rows[0].project, 'sample-service')
  assert.equal(rows[0].projectKey, 'sample-service')
})

test('filter all returns every row', () => {
  const rows = buildActivityRows(items, projects, runs)
  assert.equal(filterRows(rows, 'all').length, 5)
})

test('filter by project returns only that project', () => {
  const rows = buildActivityRows(items, projects, runs)
  assert.deepEqual(filterRows(rows, 'sample-service').map(r => r.kind), ['incident', 'deployment'])
  assert.deepEqual(filterRows(rows, 'blog').map(r => r.kind), ['detected', 'detected'])
})

test('retrain is platform and shows only under all', () => {
  const rows = buildActivityRows(items, projects, runs)
  const retrainRow = rows.find(r => r.kind === 'retrain')!
  assert.equal(retrainRow.project, 'platform')
  assert.equal(retrainRow.projectKey, null)
  for (const p of projects) assert.ok(!filterRows(rows, p.key).some(r => r.kind === 'retrain'))
})

test('detected rows only for image projects and use detected wording', () => {
  const rows = buildActivityRows([], [project('a', { deploySource: 'ci' }), project('b', { deploySource: 'image' })], { a: [run(1)], b: [run(2)] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'detected')
  assert.equal(rows[0].title, 'b deployed')
  assert.equal(rows[0].detail, 'image v12abcdef012, detected')
  assert.ok(!/commit|CI/.test(rows[0].detail))
})

test('image runs with invalid times are dropped, ISO text is accepted', () => {
  const rows = buildActivityRows([], [project('b', { deploySource: 'image' })], { b: [run('not a time'), run(null), run('2026-01-01T00:00:00Z')] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].time, Date.parse('2026-01-01T00:00:00Z'))
})

test('restarts ignore null counts', () => {
  assert.equal(restartsLast24h(projects[1]), 2)
  assert.equal(restartsLast24h(project('x', {}, [null])), 0)
})

test('empty text for a filtered project without and with restarts', () => {
  assert.equal(emptyText({ name: 'Blog' }, 0), 'Blog: no deploys or restarts in the last 7 days')
  assert.equal(emptyText({ name: 'Blog' }, 3), 'Blog: no deploys in the last 7 days, restarts in the last 24 hours: 3')
})

test('empty text for all keeps the current wording and an empty list builds no rows', () => {
  assert.equal(emptyText(null, 0), 'No activity in the last 7 days')
  assert.deepEqual(buildActivityRows([], projects, {}), [])
  assert.deepEqual(filterRows([], 'blog'), [])
})

test('options are All plus one per project', () => {
  assert.deepEqual(filterOptions(projects), [
    { value: 'all', label: 'All' },
    { value: 'sample-service', label: 'Sample service' },
    { value: 'blog', label: 'Blog' },
  ])
  assert.deepEqual(filterOptions([]), [{ value: 'all', label: 'All' }])
})
