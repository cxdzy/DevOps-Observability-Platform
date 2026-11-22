// The forecast job. Once a minute it reads, per active server, two range queries from Prometheus
// (one for the memory, start time and OOM series of the server's project containers, one for the
// configured filesystems), runs the pure rules in fit.js and opens or closes warnings in
// forecast_events with the hysteresis rules. forecast_events is the only thing it writes; it never
// sends a message and never restarts anything.
//
// A failed query, or an answer with no series at all for a server, keeps the last state, marks it
// "no data" and neither opens nor closes a warning.
const { createPrometheus } = require("../prometheus");
const { CONTAINER_RE } = require("../registry");
const { escapeName } = require("../deployments");
const { FORECAST_CONFIG } = require("./config");
const fit = require("./fit");

const MINUTE_MS = 60 * 1000;
const MOUNTPOINT_RE = /^\/[A-Za-z0-9_./-]{0,200}$/;
const FSTYPE_RE = /^[a-z0-9]{1,20}$/;

function alternatives(values) {
  return values.map(escapeName).join("|");
}

// One query for every project container of a server: working set, limit, start time, OOM count
// and the host memory, told apart by the label m. Returns null when the server has no valid name.
function memoryQuery(server, names) {
  const valid = [...new Set(names.filter((n) => typeof n === "string" && CONTAINER_RE.test(n)))].sort();
  if (!valid.length) return null;
  const sel = `${server.cadvisorSel},name=~"${alternatives(valid)}"`;
  return [
    `label_replace(max by (name) (container_memory_working_set_bytes{${sel}}), "m", "ws", "", "")`,
    `label_replace(max by (name) (container_spec_memory_limit_bytes{${sel}}), "m", "limit", "", "")`,
    `label_replace(max by (name) (container_start_time_seconds{${sel}}), "m", "start", "", "")`,
    `label_replace(sum by (name) (container_oom_events_total{${sel}}), "m", "oom", "", "")`,
    `label_replace(max(machine_memory_bytes{${server.cadvisorSel}}), "m", "host", "", "")`,
  ].join(" or ");
}

// One query for the configured filesystems of a server: size and available bytes.
function diskQuery(server, config = FORECAST_CONFIG) {
  const mounts = config.disk.mountpoints.filter((m) => MOUNTPOINT_RE.test(m));
  const types = config.disk.fstypes.filter((t) => FSTYPE_RE.test(t));
  if (!mounts.length || !types.length) return null;
  const sel = `${server.nodeSel},mountpoint=~"${alternatives(mounts)}",fstype=~"${alternatives(types)}"`;
  return [
    `label_replace(max by (mountpoint) (node_filesystem_size_bytes{${sel}}), "m", "size", "", "")`,
    `label_replace(max by (mountpoint) (node_filesystem_avail_bytes{${sel}}), "m", "avail", "", "")`,
  ].join(" or ");
}

// Per active server: its project containers and its two queries. Rebuilt when the registry changes.
function buildTargets(snap, config = FORECAST_CONFIG) {
  const servers = new Map(snap.activeServers.map((s) => [s.key, s]));
  const perServer = new Map(snap.activeServers.map((s) => [s.key, []]));
  for (const p of snap.projects) {
    if (p.status !== "active" || !servers.has(p.server_key)) continue;
    for (const name of p.containers || []) {
      if (typeof name === "string" && CONTAINER_RE.test(name)) perServer.get(p.server_key).push({ project: p.key, name });
    }
  }
  return snap.activeServers.map((server) => {
    const containers = perServer.get(server.key);
    return {
      server,
      containers,
      memoryQuery: memoryQuery(server, containers.map((c) => c.name)),
      diskQuery: diskQuery(server, config),
    };
  });
}

// True when the series has a point at or after fromMs.
function fresh(series, fromMs) {
  const s = fit.clean(series);
  return s.length > 0 && s[s.length - 1][0] >= fromMs;
}

function latest(series) {
  const s = fit.clean(series);
  return s.length ? s[s.length - 1][1] : null;
}

// The range of a window ending at the last whole step before nowMs, in Unix seconds.
function rangeFor(nowMs, windowMin, stepSec) {
  const end = Math.floor(nowMs / 1000 / stepSec) * stepSec;
  return { start: end - windowMin * 60, end, step: stepSec };
}

const keyOf = (resource, server, name) => `${resource}|${server}|${name}`;
const rowKey = (row) => keyOf(row.resource, row.server, row.resource === "disk" ? row.mountpoint : row.container);

// deps: { db, registry, prometheus, now, log, config }. prometheus lets tests pass a client; the
// default one allows only the queries built from the registry.
function createForecastJob({ db, registry, prometheus, now = Date.now, log = console.log, config = FORECAST_CONFIG }) {
  const targetList = registry.derived((snap) => buildTargets(snap, config));
  const allowed = registry.derived((snap) => buildTargets(snap, config).flatMap((t) => [t.memoryQuery, t.diskQuery].filter(Boolean)));
  const prom = prometheus || createPrometheus({ allowed });

  // Open warnings by key: { row, falseSince }. Filled from the table on the first run.
  const open = new Map();
  let openLoaded = false;
  // What the API shows, by key: containers by "server|name", disks by "server|mountpoint".
  const containers = new Map();
  const disks = new Map();
  let lastRun = null;
  let running = false;
  let timer = null;
  const failing = new Set();

  // Logs a failure once until the same kind works again. Never logs a value from a request.
  function fail(kind, err) {
    if (!failing.has(kind)) log(JSON.stringify({ event: `forecast_${kind}_failed`, error: String(err && err.message) }));
    failing.add(kind);
  }
  const ok = (kind) => failing.delete(kind);

  async function close(key, nowMs, reason, est) {
    const o = open.get(key);
    if (!o) return;
    try {
      await db.closeForecastEvent(o.row.id, new Date(nowMs), reason, est ?? null);
      open.delete(key);
      ok("db");
    } catch (err) {
      fail("db", err);
    }
  }

  // One rule result for one key. Opens a warning when the rule holds and none is open; otherwise
  // updates or closes the open one with the hysteresis rules.
  async function step(resource, key, result, meta, nowMs) {
    const holds = result.state === "warning" || result.state === "restarting";
    const closeEst = resource === "memory" ? config.memory.closeEstMin : resource === "disk" ? config.disk.closeEstMin : null;
    const o = open.get(key);
    if (!o) {
      if (!holds) return;
      try {
        const row = await db.insertForecastEvent({
          resource,
          server: meta.server,
          project: meta.project ?? null,
          container: meta.container ?? null,
          mountpoint: meta.mountpoint ?? null,
          openedAt: new Date(nowMs),
          estMinutes: result.est_minutes ?? null,
          limitValue: resource === "restarts" ? null : result.limit ?? null,
          level: resource === "restarts" ? result.changes ?? null : result.level ?? null,
          slope: result.slope ?? null,
          r2: result.r2 ?? null,
          windowMin: resource === "restarts" ? config.restarts.windowMin : result.window_min ?? null,
          configVersion: config.version,
        });
        if (row) open.set(key, { row, falseSince: null });
        ok("db");
      } catch (err) {
        fail("db", err);
      }
      return;
    }
    const openedMs = new Date(o.row.opened_at).getTime();
    if (resource === "memory" && result.restart_at !== null && result.restart_at !== undefined && result.restart_at > openedMs) {
      return close(key, nowMs, "restart_cut", null);
    }
    if (closeEst !== null && result.est_minutes !== null && result.est_minutes !== undefined && result.est_minutes > closeEst) {
      return close(key, nowMs, "estimate_rose", result.est_minutes);
    }
    if (holds) {
      o.falseSince = null;
    } else {
      if (o.falseSince === null) o.falseSince = nowMs;
      if (nowMs - o.falseSince >= config.closeAfterFalseMin * MINUTE_MS) return close(key, nowMs, "steady", result.est_minutes);
    }
    const est = result.est_minutes;
    if (est !== null && est !== undefined && (o.row.est_minutes_latest === null || Math.abs(o.row.est_minutes_latest - est) >= 0.1)) {
      try {
        await db.updateForecastEstimate(o.row.id, est);
        o.row.est_minutes_latest = est;
        ok("db");
      } catch (err) {
        fail("db", err);
      }
    }
  }

  // The state shown for a container, from its memory and restart results and open warnings.
  function containerEntry(server, c, mem, rs, nowMs) {
    const memOpen = open.get(keyOf("memory", server.key, c.name));
    const rsOpen = open.get(keyOf("restarts", server.key, c.name));
    let state = mem.state;
    let reason = mem.reason;
    let since = null;
    if (rs.state === "restarting" || rsOpen) {
      state = "restarting";
      reason = rs.state === "restarting" ? rs.reason : "restarts";
      since = rsOpen ? rsOpen.row.opened_at : null;
    } else if (memOpen) {
      state = "warning";
      since = memOpen.row.opened_at;
    }
    return {
      server: server.key,
      server_name: server.name,
      project: c.project,
      container: c.name,
      state,
      reason,
      est_minutes: mem.est_minutes,
      limit_bytes: mem.limit,
      level_bytes: mem.level,
      slope_bytes_per_min: mem.slope,
      r2: mem.r2,
      restarts: rs.changes,
      oom: rs.oom,
      since: since ? new Date(since).toISOString() : null,
      updated_at: new Date(nowMs).toISOString(),
    };
  }

  // Keeps the last values of a server's entries but shows them as having no data.
  function markNoData(map, serverKey, names, make, reason) {
    for (const name of names) {
      const k = `${serverKey}|${name}`;
      const prev = map.get(k);
      map.set(k, prev ? { ...prev, state: "no_data", reason } : make(name));
    }
  }

  async function memoryRun(t, nowMs) {
    const names = t.containers.map((c) => c.name);
    const blank = (name) => {
      const c = t.containers.find((x) => x.name === name);
      return containerEntry(t.server, c, { state: "no_data", reason: "prometheus" }, { state: "ok", changes: null, oom: null }, nowMs);
    };
    if (!t.memoryQuery) return;
    const r = rangeFor(nowMs, config.memory.windowMin, config.memory.stepSec);
    let rows;
    try {
      rows = await prom.queryRange(t.memoryQuery, r.start, r.end, r.step);
      ok(`prometheus_memory_${t.server.key}`);
    } catch (err) {
      fail(`prometheus_memory_${t.server.key}`, err);
      return markNoData(containers, t.server.key, names, blank, "prometheus");
    }
    // No series at all, or no fresh host series (cAdvisor reports it as long as it runs), means
    // cAdvisor is not answering: the containers are not known to be gone.
    const freshFrom = r.end * 1000 - config.staleAfterMin * MINUTE_MS;
    const hostRow = rows.find((x) => x.labels && x.labels.m === "host");
    if (!rows.length || !hostRow || !fresh(hostRow.values, freshFrom)) return markNoData(containers, t.server.key, names, blank, "prometheus");
    const host = latest(hostRow.values);
    const byName = new Map();
    for (const row of rows) {
      const m = row.labels && row.labels.m;
      if (m === "host") continue;
      const name = row.labels && row.labels.name;
      if (!names.includes(name) || !["ws", "limit", "start", "oom"].includes(m)) continue;
      if (!byName.has(name)) byName.set(name, {});
      byName.get(name)[m] = row.values;
    }
    for (const c of t.containers) {
      const data = byName.get(c.name);
      const memKey = keyOf("memory", t.server.key, c.name);
      const rsKey = keyOf("restarts", t.server.key, c.name);
      if (!data || !fresh(data.ws, freshFrom)) {
        // cAdvisor answered but this container has no recent point: it is gone.
        await close(memKey, nowMs, "container_gone", null);
        await close(rsKey, nowMs, "container_gone", null);
        containers.set(`${t.server.key}|${c.name}`, {
          ...containerEntry(t.server, c, { state: "no_data", reason: "no_series" }, { state: "ok", changes: null, oom: null }, nowMs),
          est_minutes: null,
          limit_bytes: null,
          level_bytes: null,
          slope_bytes_per_min: null,
          r2: null,
        });
        continue;
      }
      const mem = fit.assessMemory({ points: data.ws, limit: latest(data.limit), hostBytes: host, starts: data.start }, config);
      const rs = fit.assessRestarts({ starts: data.start, ooms: data.oom, nowMs }, config);
      const meta = { server: t.server.key, project: c.project, container: c.name };
      await step("memory", memKey, mem, meta, nowMs);
      await step("restarts", rsKey, rs, meta, nowMs);
      containers.set(`${t.server.key}|${c.name}`, containerEntry(t.server, c, mem, rs, nowMs));
    }
  }

  function diskEntry(server, mountpoint, d, nowMs) {
    const o = open.get(keyOf("disk", server.key, mountpoint));
    const slopePctPerHour = d.slope !== null && d.slope !== undefined && d.limit ? (d.slope * 60 * 100) / d.limit : null;
    return {
      server: server.key,
      server_name: server.name,
      mountpoint,
      state: o ? "warning" : d.state,
      reason: d.reason,
      est_minutes: d.est_minutes ?? null,
      used_pct: d.used_pct ?? null,
      size_bytes: d.limit ?? null,
      slope_pct_per_hour: slopePctPerHour,
      r2: d.r2 ?? null,
      since: o ? new Date(o.row.opened_at).toISOString() : null,
      updated_at: new Date(nowMs).toISOString(),
    };
  }

  async function diskRun(t, nowMs) {
    if (!t.diskQuery) return;
    const mounts = config.disk.mountpoints.filter((m) => MOUNTPOINT_RE.test(m));
    const blank = (m) => diskEntry(t.server, m, { state: "no_data", reason: "prometheus" }, nowMs);
    const r = rangeFor(nowMs, config.disk.windowMin, config.disk.stepSec);
    let rows;
    try {
      rows = await prom.queryRange(t.diskQuery, r.start, r.end, r.step);
      ok(`prometheus_disk_${t.server.key}`);
    } catch (err) {
      fail(`prometheus_disk_${t.server.key}`, err);
      return markNoData(disks, t.server.key, mounts, blank, "prometheus");
    }
    if (!rows.length) return markNoData(disks, t.server.key, mounts, blank, "prometheus");
    const freshFrom = r.end * 1000 - config.staleAfterMin * MINUTE_MS;
    // Old points of a node exporter that stopped are not current data.
    if (!rows.some((x) => fresh(x.values, freshFrom))) return markNoData(disks, t.server.key, mounts, blank, "prometheus");
    for (const m of mounts) {
      const size = rows.find((x) => x.labels && x.labels.m === "size" && x.labels.mountpoint === m);
      const avail = rows.find((x) => x.labels && x.labels.m === "avail" && x.labels.mountpoint === m && fresh(x.values, freshFrom));
      const d = fit.assessDisk({ size: size ? size.values : [], avail: avail ? avail.values : [] }, config);
      // A mountpoint the server does not have is shown as no data and never warns.
      if (d.state !== "no_data") await step("disk", keyOf("disk", t.server.key, m), d, { server: t.server.key, mountpoint: m }, nowMs);
      disks.set(`${t.server.key}|${m}`, diskEntry(t.server, m, d, nowMs));
    }
  }

  // One run. Never throws, and never runs twice at the same time.
  async function tick() {
    if (running) return;
    running = true;
    try {
      await registry.load();
      if (!openLoaded) {
        try {
          for (const row of await db.listOpenForecastEvents()) open.set(rowKey(row), { row, falseSince: null });
          openLoaded = true;
          ok("db");
        } catch (err) {
          // Without the open rows a run could open a second warning, so nothing runs until they load.
          fail("db", err);
          return;
        }
      }
      const nowMs = now();
      const list = targetList();
      for (const t of list) {
        await memoryRun(t, nowMs);
        await diskRun(t, nowMs);
      }
      // Containers and servers that left the registry: their warnings close and they are no longer shown.
      const wanted = new Set();
      for (const t of list) {
        for (const c of t.containers) {
          wanted.add(keyOf("memory", t.server.key, c.name));
          wanted.add(keyOf("restarts", t.server.key, c.name));
        }
        for (const m of config.disk.mountpoints.filter((x) => MOUNTPOINT_RE.test(x))) wanted.add(keyOf("disk", t.server.key, m));
      }
      for (const key of [...open.keys()]) if (!wanted.has(key)) await close(key, nowMs, "container_gone", null);
      const shown = new Set([...wanted].map((k) => k.split("|").slice(1).join("|")));
      for (const k of [...containers.keys()]) if (!shown.has(k)) containers.delete(k);
      for (const k of [...disks.keys()]) if (!shown.has(k)) disks.delete(k);
      lastRun = nowMs;
    } catch (err) {
      fail("run", err);
    } finally {
      running = false;
    }
  }

  // The current state for GET /api/forecast, in registry order.
  function snapshot() {
    return {
      last_run_at: lastRun === null ? null : new Date(lastRun).toISOString(),
      containers: [...containers.values()].map((e) => ({ ...e })),
      disks: [...disks.values()].map((e) => ({ ...e })),
    };
  }

  // The timer does not keep the process alive. start() twice does nothing.
  function start(intervalMs = config.intervalMs) {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref();
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, snapshot, allowed, isRunning: () => running };
}

module.exports = { createForecastJob, memoryQuery, diskQuery, buildTargets, rangeFor };
