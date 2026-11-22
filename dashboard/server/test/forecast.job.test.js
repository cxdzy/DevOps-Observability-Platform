// The forecast job: queries, hysteresis and the forecast_events rows (forecast/job.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createForecastJob, memoryQuery, diskQuery } = require("../forecast/job");
const { FORECAST_CONFIG } = require("../forecast/config");
const { createFakeDb } = require("./fake-db");

const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 22, 8, 0, 0);

const SERVERS = [
  { key: "main", name: "fyp-main", builtin: true, status: "active", nodeSel: 'job="node-exporter"', cadvisorSel: 'job="cadvisor"' },
  { key: "old", name: "staging", builtin: true, status: "active", nodeSel: 'job="node-exporter-old"', cadvisorSel: 'job="cadvisor-old"' },
];
function fakeRegistry(projects = [{ key: "bot", status: "active", server_key: "old", containers: ["kotone-bot"] }]) {
  const snap = { version: 1, servers: SERVERS, activeServers: SERVERS, projects };
  return {
    load: async () => snap,
    current: () => snap,
    derived: (fn) => () => fn(snap),
  };
}

// A Prometheus stand-in. world says, per container, the working set in MiB, the limit and the
// start time as functions of the time in ms; disk gives the used percent per mountpoint.
function fakeProm(world) {
  const calls = [];
  const client = {
    calls,
    fail: false,
    empty: false,
    async queryRange(q, start, end, step) {
      calls.push(q);
      if (client.fail) throw new Error("prometheus returned 503");
      if (client.empty) return [];
      const times = [];
      for (let s = start; s <= end; s += step) times.push(s * 1000);
      const rows = [];
      if (q.includes("working_set")) {
        const server = q.includes('job="cadvisor-old"') ? "old" : "main";
        // stopAt: the time a container (or, for the host series, cAdvisor) stopped reporting.
        const until = (stopAt) => (stopAt === undefined ? times : times.filter((t) => t < stopAt));
        rows.push({ labels: { m: "host" }, values: until(world.hostStopAt).map((t) => [t, 4 * GIB]) });
        for (const [name, c] of Object.entries(world.containers || {})) {
          if ((c.server || "old") !== server || c.gone) continue;
          rows.push({ labels: { m: "ws", name }, values: until(c.stopAt).map((t) => [t, c.ws(t) * MIB]) });
          rows.push({ labels: { m: "limit", name }, values: times.map((t) => [t, c.limit === undefined ? 400 * MIB : c.limit]) });
          rows.push({ labels: { m: "start", name }, values: times.map((t) => [t, c.start ? c.start(t) : T0 / 1000 - 86400]) });
          rows.push({ labels: { m: "oom", name }, values: times.map((t) => [t, 0]) });
        }
      } else if (q.includes("node_filesystem")) {
        const server = q.includes('job="node-exporter-old"') ? "old" : "main";
        for (const [mount, d] of Object.entries((world.disks || {})[server] || {})) {
          rows.push({ labels: { m: "size", mountpoint: mount }, values: times.map((t) => [t, 100 * GIB]) });
          rows.push({ labels: { m: "avail", mountpoint: mount }, values: times.map((t) => [t, 100 * GIB * (1 - d(t) / 100)]) });
        }
      }
      return rows;
    },
  };
  return client;
}

// A leak of 1 MiB a minute that is at 350 MiB at T0 (about 54 minutes to the 400 MiB limit).
const leak = (t) => 350 + (t - T0) / MIN;
const flat = () => 200;

function setup({ world, projects, config } = {}) {
  const db = createFakeDb();
  const clock = { t: T0 };
  const logs = [];
  const prom = fakeProm(world || { containers: { "kotone-bot": { ws: leak } } });
  const make = () => createForecastJob({ db, registry: fakeRegistry(projects), prometheus: prom, now: () => clock.t, log: (l) => logs.push(l), config: config || FORECAST_CONFIG });
  return { db, clock, logs, prom, job: make(), make };
}
const openRows = (db) => db.forecastEvents.filter((e) => e.closed_at === null);

test("the queries are batched per server: two per server and run", async () => {
  const { job, prom } = setup();
  await job.tick();
  // Two servers; main has no project container, so it only gets the disk query.
  assert.equal(prom.calls.length, 3);
  assert.equal(prom.calls.filter((q) => q.includes("working_set")).length, 1);
  assert.equal(prom.calls.filter((q) => q.includes("node_filesystem")).length, 2);
  const q = memoryQuery(SERVERS[1], ["kotone-bot", "a.b"]);
  assert.match(q, /name=~"a\\\\.b\|kotone-bot"/);
  assert.equal(memoryQuery(SERVERS[1], ["bad name"]), null);
  assert.match(diskQuery(SERVERS[0]), /mountpoint=~"\/",fstype=~"ext2\|ext3\|ext4\|xfs\|btrfs\|zfs\|f2fs"/);
  // Only the queries the job builds are allowed.
  assert.deepEqual([...job.allowed()].sort(), [...new Set(prom.calls)].sort());
});

test("a leak opens one warning, later runs update it and never open a second", async () => {
  const { job, db, clock } = setup();
  await job.tick();
  let rows = openRows(db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.resource, "memory");
  assert.equal(row.server, "old");
  assert.equal(row.project, "bot");
  assert.equal(row.container, "kotone-bot");
  assert.equal(row.mountpoint, null);
  assert.equal(row.limit_value, 400 * MIB);
  assert.equal(row.config_version, FORECAST_CONFIG.version);
  assert.ok(row.est_minutes_at_open > 45 && row.est_minutes_at_open <= 60);
  clock.t += MIN;
  await job.tick();
  clock.t += MIN;
  await job.tick();
  rows = openRows(db);
  assert.equal(db.forecastEvents.length, 1);
  assert.ok(rows[0].est_minutes_latest < row.est_minutes_at_open);
  const snap = job.snapshot();
  const c = snap.containers.find((x) => x.container === "kotone-bot");
  assert.equal(c.state, "warning");
  assert.equal(c.since, row.opened_at.toISOString());
});

test("a warning closes only after the rule has been false for 10 minutes in a row", async () => {
  const world = { containers: { "kotone-bot": { ws: leak } } };
  const { job, db, clock } = setup({ world });
  await job.tick();
  assert.equal(openRows(db).length, 1);
  // The leak stops: the memory goes flat (and far below the limit, so the estimate is gone).
  world.containers["kotone-bot"].ws = flat;
  for (let i = 1; i <= 10; i++) {
    clock.t += MIN;
    await job.tick();
    assert.equal(openRows(db).length, 1, `open after ${i} false runs`);
  }
  // The first false run starts the count; it closes on the run 10 minutes after that one.
  assert.equal(openRows(db).length, 1, "still open 9 minutes after the first false run");
  clock.t += MIN;
  await job.tick();
  assert.equal(openRows(db).length, 0);
  assert.equal(db.forecastEvents[0].close_reason, "steady");
  assert.equal(job.snapshot().containers[0].state, "ok");
});

test("a warning that comes back within 10 minutes stays open as the same row", async () => {
  const world = { containers: { "kotone-bot": { ws: leak } } };
  const { job, db, clock } = setup({ world });
  await job.tick();
  world.containers["kotone-bot"].ws = flat;
  for (let i = 0; i < 5; i++) {
    clock.t += MIN;
    await job.tick();
  }
  world.containers["kotone-bot"].ws = leak;
  for (let i = 0; i < 10; i++) {
    clock.t += MIN;
    await job.tick();
  }
  assert.equal(db.forecastEvents.length, 1);
  assert.equal(openRows(db).length, 1);
});

test("an estimate above 90 minutes closes the warning at once", async () => {
  const world = { containers: { "kotone-bot": { ws: leak } } };
  const { job, db, clock } = setup({ world });
  await job.tick();
  // Same steady rise but far from the limit now (the limit was raised to 800 MiB).
  world.containers["kotone-bot"].limit = 800 * MIB;
  clock.t += MIN;
  await job.tick();
  assert.equal(openRows(db).length, 0);
  assert.equal(db.forecastEvents[0].close_reason, "estimate_rose");
});

test("a restart after the warning opened closes it with restart_cut", async () => {
  const world = { containers: { "kotone-bot": { ws: leak } } };
  const { job, db, clock } = setup({ world });
  await job.tick();
  const restartAt = T0 + 30 * 1000;
  world.containers["kotone-bot"].start = (t) => (t >= restartAt ? restartAt / 1000 : T0 / 1000 - 86400);
  clock.t += MIN;
  await job.tick();
  assert.equal(openRows(db).length, 0);
  assert.equal(db.forecastEvents[0].close_reason, "restart_cut");
  assert.equal(job.snapshot().containers[0].state, "not_enough_data");
});

test("a container that has no series while the server answers closes with container_gone", async () => {
  const world = { containers: { "kotone-bot": { ws: leak }, other: { ws: flat } } };
  const projects = [{ key: "bot", status: "active", server_key: "old", containers: ["kotone-bot", "other"] }];
  const { job, db, clock } = setup({ world, projects });
  await job.tick();
  assert.equal(openRows(db).length, 1);
  world.containers["kotone-bot"].gone = true;
  clock.t += MIN;
  await job.tick();
  assert.equal(openRows(db).length, 0);
  assert.equal(db.forecastEvents[0].close_reason, "container_gone");
  const c = job.snapshot().containers.find((x) => x.container === "kotone-bot");
  assert.equal(c.state, "no_data");
  assert.equal(c.est_minutes, null);
});

test("a failed query or an empty answer changes nothing: no open, no close, state no data", async () => {
  const world = { containers: { "kotone-bot": { ws: leak } } };
  const { job, db, clock, prom, logs } = setup({ world });
  await job.tick();
  const before = JSON.stringify(db.forecastEvents);
  const est = job.snapshot().containers[0].est_minutes;
  world.containers["kotone-bot"].ws = flat;
  prom.fail = true;
  for (let i = 0; i < 15; i++) {
    clock.t += MIN;
    await job.tick();
  }
  assert.equal(JSON.stringify(db.forecastEvents), before);
  const c = job.snapshot().containers[0];
  assert.equal(c.state, "no_data");
  assert.equal(c.reason, "prometheus");
  // The last values are kept.
  assert.equal(c.est_minutes, est);
  // Logged once, not once a minute.
  assert.equal(logs.filter((l) => l.includes("forecast_prometheus_memory_old_failed")).length, 1);
  prom.fail = false;
  prom.empty = true;
  clock.t += MIN;
  await job.tick();
  assert.equal(JSON.stringify(db.forecastEvents), before);
  // The failed minutes did not count towards the 10 quiet minutes: one good flat run does not close it.
  prom.empty = false;
  clock.t += MIN;
  await job.tick();
  assert.equal(openRows(db).length, 1);
});

test("a no-data run does not open a warning either", async () => {
  const { job, db, prom } = setup();
  prom.fail = true;
  await job.tick();
  assert.equal(db.forecastEvents.length, 0);
  assert.equal(job.snapshot().containers[0].state, "no_data");
});

test("after a dashboard restart the open warning is taken from the table, not opened again", async () => {
  const { job, db, clock, make } = setup();
  await job.tick();
  assert.equal(db.forecastEvents.length, 1);
  const second = make();
  clock.t += MIN;
  await second.tick();
  assert.equal(db.forecastEvents.length, 1);
  assert.equal(second.snapshot().containers[0].since, db.forecastEvents[0].opened_at.toISOString());
});

test("a run never overlaps the one before it", async () => {
  const { job, prom } = setup();
  let release;
  const slow = prom.queryRange.bind(prom);
  prom.queryRange = async (...args) => {
    await new Promise((r) => (release = r));
    return slow(...args);
  };
  const first = job.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(job.isRunning(), true);
  await job.tick();
  assert.equal(prom.calls.length, 0);
  // Let the first run finish its queries one by one.
  while (job.isRunning()) {
    if (release) release();
    await new Promise((r) => setImmediate(r));
  }
  await first;
  assert.equal(prom.calls.length, 3);
});

test("restarts open their own warning beside the memory one", async () => {
  const changes = [T0 - 12 * MIN, T0 - 8 * MIN, T0 - 4 * MIN];
  const start = (t) => {
    const done = changes.filter((c) => c <= t);
    return done.length ? done[done.length - 1] / 1000 : T0 / 1000 - 86400;
  };
  const { job, db } = setup({ world: { containers: { "kotone-bot": { ws: flat, start } } } });
  await job.tick();
  const rows = openRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource, "restarts");
  assert.equal(rows[0].level_at_open, 3);
  assert.equal(rows[0].est_minutes_at_open, null);
  const c = job.snapshot().containers[0];
  assert.equal(c.state, "restarting");
  assert.equal(c.restarts, 3);
});

test("two mountpoints on one server have their own state and rows", async () => {
  const config = { ...FORECAST_CONFIG, disk: { ...FORECAST_CONFIG.disk, mountpoints: ["/", "/mnt/data"] } };
  const rising = (t) => 92 + (t - T0) / (60 * MIN);
  const world = { containers: {}, disks: { main: { "/": () => 40, "/mnt/data": rising } } };
  const { job, db, prom } = setup({ world, projects: [], config });
  await job.tick();
  assert.match(prom.calls.find((q) => q.includes('job="node-exporter"')), /mountpoint=~"\/\|\/mnt\/data"/);
  const rows = openRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource, "disk");
  assert.equal(rows[0].mountpoint, "/mnt/data");
  assert.equal(rows[0].container, null);
  const disks = job.snapshot().disks.filter((d) => d.server === "main");
  assert.equal(disks.length, 2);
  assert.equal(disks.find((d) => d.mountpoint === "/").state, "ok");
  const data = disks.find((d) => d.mountpoint === "/mnt/data");
  assert.equal(data.state, "warning");
  assert.ok(Math.abs(data.est_minutes / 60 - 8) < 0.2);
  assert.ok(Math.abs(data.slope_pct_per_hour - 1) < 0.01);
  // The staging server has no such filesystems: no data, no row.
  assert.ok(job.snapshot().disks.filter((d) => d.server === "old").every((d) => d.state === "no_data"));
});

test("a container with no memory limit is shown as no limit and never opens a row", async () => {
  const { job, db } = setup({ world: { containers: { "kotone-bot": { ws: leak, limit: 0 } } } });
  await job.tick();
  assert.equal(db.forecastEvents.length, 0);
  const c = job.snapshot().containers[0];
  assert.equal(c.state, "no_limit");
  assert.equal(c.est_minutes, null);
  assert.equal(c.limit_bytes, null);
});

test("old points of a stopped container are not current: the warning closes with container_gone", async () => {
  const world = { containers: { "kotone-bot": { ws: leak }, other: { ws: flat } } };
  const projects = [{ key: "bot", status: "active", server_key: "old", containers: ["kotone-bot", "other"] }];
  const { job, db, clock } = setup({ world, projects });
  await job.tick();
  assert.equal(openRows(db).length, 1);
  // It stopped 8 minutes ago; the 30 minute window still holds its older points.
  world.containers["kotone-bot"].stopAt = T0 + 2 * MIN;
  clock.t = T0 + 10 * MIN;
  await job.tick();
  assert.equal(openRows(db).length, 0);
  assert.equal(db.forecastEvents[0].close_reason, "container_gone");
  assert.equal(job.snapshot().containers.find((x) => x.container === "kotone-bot").state, "no_data");
});

test("old points from a cAdvisor that stopped are no data: nothing opens or closes", async () => {
  const world = { containers: { "kotone-bot": { ws: leak } } };
  const { job, db, clock } = setup({ world });
  await job.tick();
  const before = JSON.stringify(db.forecastEvents);
  world.hostStopAt = T0 + 2 * MIN;
  world.containers["kotone-bot"].stopAt = T0 + 2 * MIN;
  clock.t = T0 + 20 * MIN;
  await job.tick();
  assert.equal(JSON.stringify(db.forecastEvents), before);
  const c = job.snapshot().containers[0];
  assert.equal(c.state, "no_data");
  assert.equal(c.reason, "prometheus");
});
