// Fleet view models of the Overview page. Run with: node --test test/overviewFleet.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  containersCard, fleetSubtitle, incidentsNote, projectCardData, projectCards, projectsCard, sortProjects, statusCard,
} from '../src/lib/overviewFleet.ts'
import { mergeStrip, pickMerge, stripLabel } from '../src/lib/projectStrip.ts'

const project = (key: string, over: Record<string, unknown> = {}): any => ({
  key,
  name: key,
  server: { key: 'main', name: 'fyp-main' },
  containers: [{ name: 'app', up: true, restarts24h: 1, memBytes: 100 * 1024 ** 2, limitBytes: 400 * 1024 ** 2 }],
  status: 'healthy',
  watchedByModel: true,
  automation: 'approval',
  deploySource: 'ci',
  lastDeploy: { at: 1000, source: 'ci', ref: 'abcdef123456' },
  rollback: { mode: 'n8n', text: 'ok', ready: true },
  strip: [],
  ...over,
})
const node = (key: string, containers: number | null, up: boolean | null = true): any => ({ key, displayName: key === 'main' ? 'fyp-main' : 'staging', containers, up })
const ctx = { latest: { score: 0.1234, threshold: 0.5, model: 'v10' }, incidents: [{ status: 'closed' }, { status: 'open' }] as any, forecasts: [] }

const model = project('sample-service')
const bot = project('kotone-bot', { watchedByModel: false, server: { key: 'staging', name: 'staging' } })

test('model project card shows score and incident count', () => {
  const d = projectCardData(model, ctx)
  assert.equal(d.figures.score.kind, 'value')
  assert.equal(d.figures.score.text, '0.123')
  assert.equal(d.figures.incidents.count, 2)
  assert.equal(d.links.incidents, '#incidents')
  assert.equal(d.lastDeploy?.chip, 'Verified')
  assert.equal(d.lastDeploy?.ref, 'abcdef1')
  assert.equal(d.href, '#projects?project=sample-service')
})

test('monitored-only project has no score and no incident count', () => {
  const d = projectCardData(bot, ctx)
  assert.equal(d.figures.score.kind, 'notwatched')
  assert.equal(d.figures.score.text, 'Not watched')
  assert.equal(d.figures.score.sub, 'no model for this project')
  assert.equal(d.figures.incidents.count, null)
  assert.equal(d.figures.incidents.text, 'None')
  assert.equal(d.figures.incidents.sub, 'no model, so no incidents')
  assert.equal(d.links.incidents, null)
  assert.equal(d.lastDeploy?.ref, 'abcdef123456'.slice(0, 7))
})

test('a watched project with another key gets No data', () => {
  const d = projectCardData(project('other'), ctx)
  assert.equal(d.figures.score.text, 'No data')
  assert.equal(d.figures.incidents.text, 'No data')
  assert.equal(d.figures.incidents.count, null)
})

test('no deploy gives the empty text, image deploys keep the full ref', () => {
  assert.equal(projectCardData(project('x', { lastDeploy: null }), ctx).lastDeploy, null)
  const d = projectCardData(project('x', { lastDeploy: { at: 1, source: 'image', ref: 'img:1' } }), ctx)
  assert.equal(d.lastDeploy?.chip, 'Detected')
  assert.equal(d.lastDeploy?.ref, 'img:1')
  assert.equal(d.lastDeployEmpty, 'none detected yet')
})

test('memory bar only when every container has a limit', () => {
  const withLimit = projectCardData(model, ctx).figures.memory
  assert.equal(withLimit.percent, 25)
  const mixed = project('m', { containers: [
    { name: 'a', up: true, restarts24h: 0, memBytes: 100, limitBytes: 1000 },
    { name: 'b', up: true, restarts24h: 0, memBytes: 100, limitBytes: null },
  ] })
  const m = projectCardData(mixed, ctx).figures.memory
  assert.equal(m.percent, null)
  assert.equal(m.sub, 'no limit set')
  const none = projectCardData(project('n', { containers: [] }), ctx).figures
  assert.equal(none.memory.text, 'No data')
  assert.equal(none.containers.text, '0 of 0 up')
})

test('containers figure counts up and restarts', () => {
  const p = project('c', { containers: [
    { name: 'a', up: true, restarts24h: 2, memBytes: null, limitBytes: null },
    { name: 'b', up: false, restarts24h: 1, memBytes: null, limitBytes: null },
  ] })
  const f = projectCardData(p, ctx).figures.containers
  assert.equal(f.text, '1 of 2 up')
  assert.equal(f.sub, 'restarts 24 h: 3')
})

test('fleet subtitle', () => {
  assert.equal(fleetSubtitle([model, bot], 2), '2 projects on 2 servers. Only sample-service has a model and automatic actions.')
  assert.equal(fleetSubtitle([model], 1), '1 project on 1 server. Only sample-service has a model and automatic actions.')
  assert.equal(fleetSubtitle([model, project('b')], 1), '2 projects on 1 server. Only sample-service and b have a model and automatic actions.')
  assert.equal(fleetSubtitle([bot], 1), '1 project on 1 server. No project has a model yet.')
  assert.equal(fleetSubtitle([], 0), '0 projects on 0 servers. No project has a model yet.')
})

test('status card', () => {
  const nodes = [node('main', 7), node('staging', 3)]
  const ok = statusCard({ projects: [model, bot], nodes, openIncident: false, incidentsKnown: true })
  assert.equal(ok.chip, 'Normal')
  assert.equal(ok.line, '2 of 2 projects healthy, 2 of 2 servers online, no incident open')
  assert.equal(statusCard({ projects: [model, bot], nodes, openIncident: true, incidentsKnown: true }).chip, 'Incident')
  assert.match(statusCard({ projects: [model], nodes, openIncident: true, incidentsKnown: true }).line, /an incident is open$/)
  assert.equal(statusCard({ projects: [project('d', { status: 'down' })], nodes, openIncident: false, incidentsKnown: true }).chip, 'Attention')
  assert.equal(statusCard({ projects: [model], nodes: [node('main', 1, false)], openIncident: false, incidentsKnown: true }).chip, 'Attention')
  assert.equal(statusCard({ projects: [model], nodes: [node('main', 1, null)], openIncident: false, incidentsKnown: true }).chip, 'Unknown')
  assert.equal(statusCard({ projects: [], nodes: [], openIncident: false, incidentsKnown: false }).chip, 'Unknown')
  assert.equal(statusCard({ projects: [model], nodes, openIncident: false, incidentsKnown: false }).chip, 'Unknown')
})

test('projects card shows the add hint to admins only', () => {
  const a = projectsCard([model, bot], true)
  assert.equal(a.count, 2)
  assert.equal(a.line, '1 watched by a model, 1 monitored only')
  assert.equal(a.addHint, 'Add a project in Settings')
  assert.equal(projectsCard([model, bot], false).addHint, null)
})

test('incidents note names the model projects', () => {
  assert.equal(incidentsNote([model, bot]), 'From the model on sample-service. Monitored-only projects have no incidents.')
  assert.equal(incidentsNote([bot]), 'Monitored-only projects have no incidents.')
})

test('containers card adds "of n expected" on the main server only', () => {
  const nodes = [node('main', 7), node('staging', 3)]
  const services: any = { expected: new Array(9).fill({ name: 'x', role: 'y' }), containers: [], unknown: false }
  const c = containersCard(nodes, services)
  assert.equal(c.total, 10)
  assert.deepEqual(c.lines, ['7 on fyp-main, 0 of 9 expected services running', '3 on staging'])
  assert.deepEqual(containersCard(nodes, { ...services, unknown: true }).lines, ['7 on fyp-main', '3 on staging'])
  assert.deepEqual(containersCard(nodes, null).lines, ['7 on fyp-main', '3 on staging'])
  assert.deepEqual(containersCard([node('main', null)], services), { total: null, lines: [] })
})

test('sortProjects orders by status then name', () => {
  const rows = [
    project('b', { status: 'healthy' }), project('a', { status: 'healthy' }), project('n', { status: 'no_data' }),
    project('p', { status: 'partial' }), project('i', { status: 'incident' }), project('d', { status: 'down' }),
  ]
  assert.deepEqual(sortProjects(rows).map(p => p.key), ['d', 'i', 'p', 'n', 'a', 'b'])
  assert.deepEqual(sortProjects([]), [])
})

test('projectCards maps exactly what it receives', () => {
  assert.deepEqual(projectCards([], ctx), [])
  assert.deepEqual(projectCards([model, bot, project('z')], ctx).map(c => c.key).sort(), ['kotone-bot', 'sample-service', 'z'])
})

test('strip helpers merge and label like the Projects page', () => {
  assert.equal(pickMerge(null), 1)
  assert.equal(pickMerge(400), 1)
  assert.equal(pickMerge(200), 2)
  assert.equal(pickMerge(100), 4)
  assert.deepEqual(mergeStrip(['up', 'down', 'up', 'up'], 2), ['down', 'up'])
  assert.equal(stripLabel('x', ['up', 'down'], 1), 'x, last 24 hours in cells of 15 minutes: 1 down period')
})

test('status card: an empty but loaded fleet is not unknown, and a missing platform service needs attention', () => {
  const nodes = [node('main', 7, true)]
  assert.equal(statusCard({ projects: [], nodes, openIncident: false, incidentsKnown: true, projectsKnown: true }).chip, 'Normal')
  const missing = statusCard({ projects: [], nodes, openIncident: false, incidentsKnown: true, projectsKnown: true, missingServices: 2 })
  assert.equal(missing.chip, 'Attention')
  assert.match(missing.line, /2 platform services missing/)
})
