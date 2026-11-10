// Data for the Resources page: node resources of one server from Prometheus, right now and over a
// chosen window. The servers come from overview.js, so they are defined once. Every query string
// is built here from a constant template with only that server's scrape job filled in, and the
// full set is the allow list. Nothing from the request ever enters a query: the route picks a
// server key and an hours value from fixed sets and this module looks both up.
const { createPrometheus } = require("./prometheus");
const { SERVERS, QUERIES: OVERVIEW_QUERIES } = require("./overview");

// The same root filesystem filter and container count as overview.js, per job.
const ROOT_FS = 'mountpoint="/",fstype!~"tmpfs|overlay"';
const NET_DEVICES = 'device!~"lo|veth.*|docker.*|br-.*"';
const DISK_DEVICES = 'device!~"loop.*"';

// %J is the node-exporter job, %C the cAdvisor job.
const INSTANT_TEMPLATES = Object.freeze({
  uname: 'node_uname_info{job="%J"}',
  cpuBusy: '1 - avg by (job) (rate(node_cpu_seconds_total{job="%J",mode="idle"}[5m]))',
  cores: 'count by (job) (node_cpu_seconds_total{job="%J",mode="idle"})',
  loadPerCore:
    'sum by (job) (node_load1{job="%J"}) / count by (job) (node_cpu_seconds_total{job="%J",mode="idle"})',
  memoryUsed: '1 - node_memory_MemAvailable_bytes{job="%J"} / node_memory_MemTotal_bytes{job="%J"}',
  memoryTotal: 'node_memory_MemTotal_bytes{job="%J"}',
  swapUsed: '1 - node_memory_SwapFree_bytes{job="%J"} / node_memory_SwapTotal_bytes{job="%J"}',
  swapTotal: 'node_memory_SwapTotal_bytes{job="%J"}',
  diskUsed: `1 - node_filesystem_avail_bytes{job="%J",${ROOT_FS}} / node_filesystem_size_bytes{job="%J",${ROOT_FS}}`,
  rootSize: `node_filesystem_size_bytes{job="%J",${ROOT_FS}}`,
  pressureCpu: 'rate(node_pressure_cpu_waiting_seconds_total{job="%J"}[1m]) * 100',
  pressureMemory: 'rate(node_pressure_memory_waiting_seconds_total{job="%J"}[1m]) * 100',
  pressureIo: 'rate(node_pressure_io_waiting_seconds_total{job="%J"}[1m]) * 100',
  uptime: 'time() - node_boot_time_seconds{job="%J"}',
  containers: 'count by (job) (count by (job, name) (container_memory_working_set_bytes{job="%C",name!=""}))',
});

const RANGE_TEMPLATES = Object.freeze({
  cpu: '100 * (1 - avg by (job) (rate(node_cpu_seconds_total{job="%J",mode="idle"}[5m])))',
  memory: '100 * (1 - node_memory_MemAvailable_bytes{job="%J"} / node_memory_MemTotal_bytes{job="%J"})',
  networkIn: `sum by (job) (rate(node_network_receive_bytes_total{job="%J",${NET_DEVICES}}[5m]))`,
  networkOut: `sum by (job) (rate(node_network_transmit_bytes_total{job="%J",${NET_DEVICES}}[5m]))`,
  diskRead: `sum by (job) (rate(node_disk_read_bytes_total{job="%J",${DISK_DEVICES}}[5m]))`,
  diskWrite: `sum by (job) (rate(node_disk_written_bytes_total{job="%J",${DISK_DEVICES}}[5m]))`,
});

// Whether each server's node exporter is up, for the status dots on the node switch.
const UP_QUERY = OVERVIEW_QUERIES.up;

// The windows the page offers, in hours. History has about 360 points in every window.
const HOURS = Object.freeze([1, 6, 24, 72, 168]);
const POINTS = 360;

function fill(template, server) {
  return template.replace(/%J/g, server.nodeJob).replace(/%C/g, server.cadvisorJob);
}

// Query strings per server key: { main: { instant: {...}, range: {...} }, old: {...} }.
const QUERIES = Object.freeze(
  Object.fromEntries(
    SERVERS.map((s) => [
      s.key,
      Object.freeze({
        instant: Object.freeze(Object.fromEntries(Object.entries(INSTANT_TEMPLATES).map(([k, t]) => [k, fill(t, s)]))),
        range: Object.freeze(Object.fromEntries(Object.entries(RANGE_TEMPLATES).map(([k, t]) => [k, fill(t, s)]))),
      }),
    ])
  )
);

const ALLOWED = Object.freeze([
  UP_QUERY,
  ...Object.values(QUERIES).flatMap((q) => [...Object.values(q.instant), ...Object.values(q.range)]),
]);

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The first value of an instant result, or null when Prometheus returned no series.
function first(rows) {
  return rows.length ? numberOrNull(rows[0].value) : null;
}

// Step in seconds for a window, so the history has about POINTS points.
function stepFor(hours) {
  return Math.round((hours * 3600) / POINTS);
}

function createResources({ prometheus, now = Date.now } = {}) {
  const prom = prometheus || createPrometheus({ allowed: ALLOWED });

  // key and hours must already be validated by the caller (one of SERVERS and one of HOURS).
  async function load(key, hours) {
    const server = SERVERS.find((s) => s.key === key);
    if (!server || !HOURS.includes(hours)) throw new Error("unknown server or window");
    const q = QUERIES[key];

    const step = stepFor(hours);
    const end = Math.floor(now() / 1000);
    const start = end - hours * 3600;

    const instantNames = Object.keys(q.instant);
    const rangeNames = Object.keys(q.range);
    // Any failed request rejects the whole load (the route answers 502). An empty result is a
    // missing metric and becomes null.
    const [upRows, instant, range] = await Promise.all([
      prom.query(UP_QUERY),
      Promise.all(instantNames.map((n) => prom.query(q.instant[n]))),
      Promise.all(rangeNames.map((n) => prom.queryRange(q.range[n], start, end, step))),
    ]);
    const r = Object.fromEntries(instantNames.map((n, i) => [n, instant[i]]));
    const v = (name) => first(r[name]);

    const swapTotal = v("swapTotal");
    const hostname = r.uname[0] && r.uname[0].labels.nodename ? String(r.uname[0].labels.nodename) : null;

    const nodes = SERVERS.map((s) => {
      const row = upRows.find((u) => u.labels.job === s.nodeJob);
      const up = row ? numberOrNull(row.value) : null;
      return { key: s.key, displayName: s.displayName, up: up === null ? null : up === 1 };
    });

    const history = Object.fromEntries(
      rangeNames.map((n, i) => [n, range[i].length ? range[i][0].values : []])
    );

    return {
      key: server.key,
      displayName: server.displayName,
      hostname,
      role: server.role,
      provider: server.provider,
      location: server.location,
      hours,
      stepSeconds: step,
      start: start * 1000,
      end: end * 1000,
      nodes,
      // Shares from 0 to 1. Swap is null when the server reports no swap at all.
      now: {
        cpuBusy: v("cpuBusy"),
        loadPerCore: v("loadPerCore"),
        memoryUsed: v("memoryUsed"),
        swapUsed: swapTotal === null || swapTotal === 0 ? null : v("swapUsed"),
        diskUsed: v("diskUsed"),
        // Percent of the last minute spent waiting.
        pressure: { cpu: v("pressureCpu"), memory: v("pressureMemory"), io: v("pressureIo") },
      },
      facts: {
        cores: v("cores"),
        memoryTotalBytes: v("memoryTotal"),
        swapTotalBytes: swapTotal,
        rootSizeBytes: v("rootSize"),
        uptimeSeconds: v("uptime"),
        containers: v("containers"),
      },
      // [[ms, value]]: cpu and memory in percent, network and disk in bytes per second.
      history,
    };
  }

  return { load };
}

module.exports = { createResources, QUERIES, ALLOWED, UP_QUERY, HOURS, POINTS, stepFor, ROOT_FS };
