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

// %W is the rate window of the chosen preset (see rateWindow).
const RANGE_TEMPLATES = Object.freeze({
  cpu: '100 * (1 - avg by (job) (rate(node_cpu_seconds_total{job="%J",mode="idle"}[%W])))',
  memory: '100 * (1 - node_memory_MemAvailable_bytes{job="%J"} / node_memory_MemTotal_bytes{job="%J"})',
  networkIn: `sum by (job) (rate(node_network_receive_bytes_total{job="%J",${NET_DEVICES}}[%W]))`,
  networkOut: `sum by (job) (rate(node_network_transmit_bytes_total{job="%J",${NET_DEVICES}}[%W]))`,
  diskRead: `sum by (job) (rate(node_disk_read_bytes_total{job="%J",${DISK_DEVICES}}[%W]))`,
  diskWrite: `sum by (job) (rate(node_disk_written_bytes_total{job="%J",${DISK_DEVICES}}[%W]))`,
});

// Whether each server's node exporter is up, for the status dots on the node switch.
const UP_QUERY = OVERVIEW_QUERIES.up;

// The windows the page offers, in hours. History has about 360 points in every window.
const HOURS = Object.freeze([1, 6, 24, 72, 168]);
const POINTS = 360;

// Step in seconds for a window, so the history has about POINTS points.
function stepFor(hours) {
  return Math.round((hours * 3600) / POINTS);
}

// Rate window of a preset: the step in whole minutes, at least 5 minutes, so each point covers
// the time since the one before and short spikes are not skipped. 1 h, 6 h and 24 h: 5m;
// 3 d: 12m; 7 d: 28m.
function rateWindow(hours) {
  return `${Math.max(5, Math.round(stepFor(hours) / 60))}m`;
}

function fill(template, server, window = "") {
  return template.replace(/%J/g, server.nodeJob).replace(/%C/g, server.cadvisorJob).replace(/%W/g, window);
}

// Query strings per server key: { main: { instant: {...}, range: { 1: {...}, 6: {...}, ... } },
// old: {...} }. range is keyed by preset hours, each preset with its own rate window.
const QUERIES = Object.freeze(
  Object.fromEntries(
    SERVERS.map((s) => [
      s.key,
      Object.freeze({
        instant: Object.freeze(Object.fromEntries(Object.entries(INSTANT_TEMPLATES).map(([k, t]) => [k, fill(t, s)]))),
        range: Object.freeze(
          Object.fromEntries(
            HOURS.map((h) => [
              h,
              Object.freeze(Object.fromEntries(Object.entries(RANGE_TEMPLATES).map(([k, t]) => [k, fill(t, s, rateWindow(h))]))),
            ])
          )
        ),
      }),
    ])
  )
);

// The Containers tab: per container name, from the server's cAdvisor job. Containers are summed or
// maxed by name so a container that was recreated (new id, same name) is one row. CPU and memory
// are summed over any duplicate series; the limit, the start time and the restart count take the
// largest, because adding them up would multiply one limit by the number of series.
// Restarts use a subquery over the largest start time per name, because a recreated container
// gets a new series and changes() on the raw series would then see no change at all.
// cAdvisor can report a very large limit (or the host memory) for "no limit" on some setups, so
// the code treats a limit at or above the node's memory total as no limit. The share query does
// the same with scalar(node memory total).
// The range queries look back over the whole 15 minute cell ([15m], the same as CONTAINER_STEP),
// so a cell counts what happened anywhere inside it, not only the sample at its end. The share
// divides "on (id, name)": one-to-one matching with on() keeps only the listed labels, so name
// has to be listed for the max by (name) around it to see it.
const CONTAINER_INSTANT_TEMPLATES = Object.freeze({
  cpu: '100 * sum by (name) (rate(container_cpu_usage_seconds_total{job="%C",name!=""}[5m]))',
  memory: 'sum by (name) (container_memory_working_set_bytes{job="%C",name!=""})',
  limit: 'max by (name) (container_spec_memory_limit_bytes{job="%C",name!=""})',
  restarts: 'changes(max by (name) (container_start_time_seconds{job="%C",name!=""})[24h:1m])',
  memoryUsedBytes: 'node_memory_MemTotal_bytes{job="%J"} - node_memory_MemAvailable_bytes{job="%J"}',
});
const CONTAINER_RANGE_TEMPLATES = Object.freeze({
  present: 'count by (name) (count_over_time(container_memory_working_set_bytes{job="%C",name!=""}[15m]))',
  started: 'max by (name) (max_over_time(container_start_time_seconds{job="%C",name!=""}[15m]))',
  share:
    'max by (name) (max_over_time(container_memory_working_set_bytes{job="%C",name!=""}[15m]) / on (id, name) (max_over_time(container_spec_memory_limit_bytes{job="%C",name!=""}[15m]) > 0 < scalar(node_memory_MemTotal_bytes{job="%J"})))',
});

// The strip covers the last 24 hours with one cell per 15 minutes.
const CONTAINER_HOURS = 24;
const CONTAINER_STEP = 900;
const CELLS = (CONTAINER_HOURS * 3600) / CONTAINER_STEP;
// A cell is "over70" from this share of the limit.
const OVER_SHARE = 0.7;

// Query strings per server key for the Containers tab. memoryTotal is the node total from the
// node queries above, so the tab has no extra string for it.
const CONTAINER_QUERIES = Object.freeze(
  Object.fromEntries(
    SERVERS.map((s) => [
      s.key,
      Object.freeze({
        instant: Object.freeze({
          ...Object.fromEntries(Object.entries(CONTAINER_INSTANT_TEMPLATES).map(([k, t]) => [k, fill(t, s)])),
          memoryTotal: QUERIES[s.key].instant.memoryTotal,
        }),
        range: Object.freeze(Object.fromEntries(Object.entries(CONTAINER_RANGE_TEMPLATES).map(([k, t]) => [k, fill(t, s)]))),
      }),
    ])
  )
);

const ALLOWED = Object.freeze([
  UP_QUERY,
  ...Object.values(QUERIES).flatMap((q) => [
    ...Object.values(q.instant),
    ...Object.values(q.range).flatMap((preset) => Object.values(preset)),
  ]),
  ...Object.values(CONTAINER_QUERIES).flatMap((q) => [...Object.values(q.instant), ...Object.values(q.range)]),
]);

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The first value of an instant result, or null when Prometheus returned no series.
function first(rows) {
  return rows.length ? numberOrNull(rows[0].value) : null;
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
    const ranges = q.range[hours];
    const rangeNames = Object.keys(ranges);
    // Any failed request rejects the whole load (the route answers 502). An empty result is a
    // missing metric and becomes null.
    const [upRows, instant, range] = await Promise.all([
      prom.query(UP_QUERY),
      Promise.all(instantNames.map((n) => prom.query(q.instant[n]))),
      Promise.all(rangeNames.map((n) => prom.queryRange(ranges[n], start, end, step))),
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

  // Values of an instant result by container name.
  function byName(rows) {
    const map = new Map();
    for (const row of rows) {
      const name = row.labels && typeof row.labels.name === "string" ? row.labels.name : "";
      if (name !== "") map.set(name, numberOrNull(row.value));
    }
    return map;
  }

  // A range result as name -> Map(second -> number), NaN and gaps left out.
  function seriesByName(matrix) {
    const map = new Map();
    for (const item of matrix) {
      const name = item.labels && typeof item.labels.name === "string" ? item.labels.name : "";
      if (name === "") continue;
      const points = map.get(name) || new Map();
      for (const [ms, value] of item.values) {
        if (value !== null) points.set(Math.round(ms / 1000), value);
      }
      map.set(name, points);
    }
    return map;
  }

  // The state of every 15 minute cell of one container. A cell ending at time t covers the 15
  // minutes before t. nodata: the container did not exist in that cell. restarted: its start time
  // is later than the last start time seen before, so it was restarted since the previous cell
  // (the first cell a container is seen in is never a restart). over70: the memory share of the
  // limit reached 70 percent in that cell (only when a limit exists). Otherwise up.
  function cellsFor(times, present, started, share) {
    let lastStart = null;
    return times.map((sec) => {
      if (!present || !present.has(sec)) return { t: sec * 1000, state: "nodata" };
      const start = started && started.has(sec) ? started.get(sec) : null;
      let restarted = false;
      if (start !== null) {
        restarted = lastStart !== null && start > lastStart + 1;
        lastStart = start;
      }
      if (restarted) return { t: sec * 1000, state: "restarted" };
      const s = share && share.has(sec) ? share.get(sec) : null;
      return { t: sec * 1000, state: s !== null && s >= OVER_SHARE ? "over70" : "up" };
    });
  }

  // Containers of one server (key must already be validated) with the last 24 hours as cells.
  async function containers(key) {
    const server = SERVERS.find((s) => s.key === key);
    if (!server) throw new Error("unknown server");
    const q = CONTAINER_QUERIES[key];
    const end = Math.floor(now() / 1000);
    const start = end - CONTAINER_HOURS * 3600;
    const times = Array.from({ length: CELLS }, (_, i) => start + (i + 1) * CONTAINER_STEP);

    const instantNames = Object.keys(q.instant);
    const rangeNames = Object.keys(q.range);
    const [instant, range] = await Promise.all([
      Promise.all(instantNames.map((n) => prom.query(q.instant[n]))),
      Promise.all(rangeNames.map((n) => prom.queryRange(q.range[n], start, end, CONTAINER_STEP))),
    ]);
    const r = Object.fromEntries(instantNames.map((n, i) => [n, instant[i]]));
    const g = Object.fromEntries(rangeNames.map((n, i) => [n, seriesByName(range[i])]));
    const memTotalBytes = first(r.memoryTotal);
    const memUsedBytes = first(r.memoryUsedBytes);
    const cpu = byName(r.cpu);
    const memory = byName(r.memory);
    const limit = byName(r.limit);
    const restarts = byName(r.restarts);

    // Containers that are present now, plus any that were present earlier in the day.
    const names = [...new Set([...memory.keys(), ...g.present.keys()])];
    const rows = names.map((name) => {
      const lim = limit.get(name);
      // 0 means no limit; so does a limit at or above the node's memory total.
      const hasLimit = typeof lim === "number" && lim > 0 && (memTotalBytes === null || lim < memTotalBytes);
      const restartCount = restarts.get(name);
      return {
        name,
        cpuPct: cpu.has(name) ? cpu.get(name) : null,
        memBytes: memory.has(name) ? memory.get(name) : null,
        limitBytes: hasLimit ? lim : null,
        restarts24h: typeof restartCount === "number" ? Math.round(restartCount) : null,
        cells: cellsFor(times, g.present.get(name), g.started.get(name), g.share.get(name)),
      };
    });
    rows.sort((a, b) => (b.memBytes ?? -1) - (a.memBytes ?? -1) || (a.name < b.name ? -1 : 1));

    return {
      node: server.key,
      displayName: server.displayName,
      memTotalBytes,
      memUsedBytes,
      stepSeconds: CONTAINER_STEP,
      start: start * 1000,
      end: end * 1000,
      containers: rows,
    };
  }

  return { load, containers };
}

module.exports = {
  createResources,
  QUERIES,
  CONTAINER_QUERIES,
  ALLOWED,
  UP_QUERY,
  HOURS,
  POINTS,
  CELLS,
  stepFor,
  rateWindow,
  ROOT_FS,
};
