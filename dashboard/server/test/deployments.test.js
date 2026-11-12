// Tests for the image watcher and GET /api/deployments. Prometheus is replaced by a stub on the
// global fetch; InfluxDB by a function that records the queries it gets.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { createFakeDb } = require("./fake-db");
const { createRegistry } = require("../registry");
const { PROMETHEUS_URL } = require("../prometheus");
const { createDeployments, imageQuery, escapeName, weeklyCounts, rollbackBlock, WATCH_INTERVAL_MS } = require("../deployments");

const NOW = Date.UTC(2026, 9, 30, 8, 0, 0);
const MIN = 60000;
const DAY = 24 * 60 * MIN;
const PASSWORD = "a long enough password";

// Answers Prometheus instant queries from rows(q), which returns [{ name, image, value }] or
// throws. Returns the list of queries that were sent.
function stubProm(t, rows) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(PROMETHEUS_URL)) return original(url, init);
    const q = new URL(href).searchParams.get("query");
    sent.push(q);
    const result = rows(q).map((r) => ({ metric: { name: r.name, image: r.image }, value: [NOW / 1000, String(r.value ?? 1)] }));
    return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result } }), { headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });
  return sent;
}

async function addShop(db, containers = ["web", "db"], key = "shop") {
  await db.transaction(async (ops) => {
    if (!(await ops.listServers()).some((s) => s.key === "shop-node")) {
      await ops.insertServer({ key: "shop-node", name: "shop-node", role: "application", location: "Home lab", address: "100.64.0.12", builtin: false, status: "active", node_job: "node-registry", cadvisor_job: "cadvisor-registry" });
    }
    await ops.insertProject({ key, name: key, server_key: "shop-node", repo_url: null, deploy_source: "image", automation: "monitored", builtin: false, status: "active", containers });
  });
}

// A watcher on a fake database. now moves with clock.t.
async function watcher(t, rows, { containers, db = createFakeDb() } = {}) {
  const sent = stubProm(t, rows);
  await addShop(db, containers);
  const logs = [];
  const clock = { t: NOW };
  const registry = createRegistry({ db, now: () => clock.t, log: () => {}, targets: null });
  await registry.reload();
  const d = createDeployments({ db, registry, query: async () => [], now: () => clock.t, log: (l) => logs.push(l) });
  t.after(() => d.stop());
  return { d, db, sent, logs, clock, registry };
}

const detected = (db) => db.registry.detected.map((r) => [r.container_name, r.old_image, r.new_image]);
const images = (db) => Object.fromEntries(db.registry.containerImages.map((r) => [r.container_name, r.image]));

test("the first sighting only stores the image", async (t) => {
  const w = await watcher(t, () => [{ name: "web", image: "shop/web:1" }, { name: "db", image: "postgres:16" }]);
  await w.d.tick();
  assert.deepEqual(detected(w.db), []);
  assert.deepEqual(images(w.db), { web: "shop/web:1", db: "postgres:16" });
});

test("a different image later is a deployment with the old and the new image", async (t) => {
  let image = "shop/web:1";
  const w = await watcher(t, () => [{ name: "web", image }, { name: "db", image: "postgres:16" }]);
  await w.d.tick();
  image = "shop/web:2";
  w.clock.t += MIN;
  await w.d.tick();
  assert.deepEqual(detected(w.db), [["web", "shop/web:1", "shop/web:2"]]);
  assert.equal(w.db.registry.detected[0].project_key, "shop");
  assert.equal(w.db.registry.detected[0].server_key, "shop-node");
  assert.equal(new Date(w.db.registry.detected[0].detected_at).getTime(), NOW + MIN);
  assert.deepEqual(images(w.db), { web: "shop/web:2", db: "postgres:16" });
  // The same image on the next tick adds nothing.
  await w.d.tick();
  assert.equal(w.db.registry.detected.length, 1);
});

test("a restart with the same image is not a deployment", async (t) => {
  let seen = 1000;
  const w = await watcher(t, () => [{ name: "web", image: "shop/web:1", value: seen }]);
  await w.d.tick();
  seen = 2000;
  await w.d.tick();
  assert.deepEqual(detected(w.db), []);
});

test("two containers that change in one tick give two rows", async (t) => {
  let v = 1;
  const w = await watcher(t, () => [{ name: "web", image: `shop/web:${v}` }, { name: "db", image: `postgres:${v + 15}` }]);
  await w.d.tick();
  v = 2;
  await w.d.tick();
  assert.deepEqual(detected(w.db).sort(), [["db", "postgres:16", "postgres:17"], ["web", "shop/web:1", "shop/web:2"]]);
});

test("while a container is being replaced the image seen last wins", async (t) => {
  let phase = 0;
  const w = await watcher(t, () =>
    phase === 0
      ? [{ name: "web", image: "shop/web:1", value: 100 }]
      : [{ name: "web", image: "shop/web:1", value: 100 }, { name: "web", image: "shop/web:2", value: 200 }]
  );
  await w.d.tick();
  phase = 1;
  await w.d.tick();
  assert.deepEqual(detected(w.db), [["web", "shop/web:1", "shop/web:2"]]);
});

test("a container that is not in the answer, or has no image, changes nothing", async (t) => {
  let rows = [{ name: "web", image: "shop/web:1" }];
  const w = await watcher(t, () => rows);
  await w.d.tick();
  rows = [{ name: "other", image: "x:1" }, { name: "web", image: "" }];
  await w.d.tick();
  assert.deepEqual(detected(w.db), []);
  assert.deepEqual(images(w.db), { web: "shop/web:1" });
});

test("Prometheus down skips the tick, logs once, and works again afterwards", async (t) => {
  let down = true;
  const w = await watcher(t, () => {
    if (down) throw new TypeError("fetch failed");
    return [{ name: "web", image: "shop/web:1" }];
  });
  await w.d.tick();
  await w.d.tick();
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /image_watcher_prometheus_failed/);
  assert.equal(w.db.registry.containerImages.length, 0);
  down = false;
  await w.d.tick();
  assert.deepEqual(images(w.db), { web: "shop/web:1" });
  down = true;
  await w.d.tick();
  assert.equal(w.logs.length, 2);
});

test("a tick that cannot get the lock writes nothing", async (t) => {
  const w = await watcher(t, () => [{ name: "web", image: "shop/web:1" }]);
  const busy = { ...w.db, withWatcherLock: async () => ({ locked: false }) };
  const d = createDeployments({ db: busy, registry: w.registry, query: async () => [], now: () => NOW, log: () => {} });
  await d.tick();
  assert.equal(w.db.registry.containerImages.length, 0);
});

test("the names regex escapes special characters and is made from valid names only", async (t) => {
  const w = await watcher(t, () => [], { containers: ["web.api", "db-1"] });
  await w.d.tick();
  assert.equal(w.sent.length, 1);
  // A dot is escaped for the regex, and the backslash is doubled for the PromQL string.
  assert.equal(w.sent[0], 'max by (name, image) (container_last_seen{job="cadvisor-registry",server="shop-node",name=~"db-1|web\\\\.api"})');
  assert.equal(escapeName("a.b"), "a\\\\.b");
  assert.equal(escapeName("a|b(c)"), "a\\\\|b\\\\(c\\\\)");
  const server = { cadvisorSel: 'job="cadvisor"' };
  assert.equal(imageQuery(server, ["bad name", 'x"y', "ok"]), 'max by (name, image) (container_last_seen{job="cadvisor",name=~"ok"})');
  assert.equal(imageQuery(server, ["bad name"]), null);
});

test("the queries are in the allow list, and the list follows the registry", async (t) => {
  const db = createFakeDb();
  const w = await watcher(t, () => [], { containers: ["web"], db });
  const first = w.d.allowed();
  assert.deepEqual(first, [imageQuery({ cadvisorSel: 'job="cadvisor-registry",server="shop-node"' }, ["web"])]);
  assert.equal(w.d.allowed(), first);
  await db.transaction((ops) => ops.setContainers("shop", "shop-node", ["web", "cache"]));
  await w.registry.reload();
  const next = w.d.allowed();
  assert.notEqual(next, first);
  assert.match(next[0], /name=~"cache\|web"/);
  await w.d.tick();
  for (const q of w.sent) assert.ok(next.includes(q), q);
});

test("projects that deploy with CI or are archived are not watched", async (t) => {
  const w = await watcher(t, () => [], { containers: ["web"] });
  await w.db.transaction(async (ops) => {
    await ops.updateProject("shop", { status: "archived" });
  });
  await w.registry.reload();
  await w.d.tick();
  // Only the archived project exists besides the built-in CI project, so nothing is asked.
  assert.equal(w.sent.length, 0);
});

test("the timer runs ticks, is stopped by stop(), and does not hold the process open", async (t) => {
  const w = await watcher(t, () => [{ name: "web", image: "shop/web:1" }]);
  w.d.start(15);
  await new Promise((r) => setTimeout(r, 80));
  w.d.stop();
  const count = w.sent.length;
  assert.ok(count >= 2, `expected repeated ticks, got ${count}`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(w.sent.length, count);
  assert.equal(WATCH_INTERVAL_MS, 60000);
});

// ---- GET /api/deployments

function influxSpy(rows = []) {
  const sent = [];
  const query = async (q) => {
    sent.push(q);
    if (q.includes('FROM "deployment_event"')) return q.includes("LIMIT 1") ? rows.slice(0, 1) : rows;
    return [];
  };
  return { sent, query };
}

async function setup(t, { rows, prepare } = {}) {
  const spy = influxSpy(rows);
  const db = createFakeDb();
  if (prepare) await prepare(db);
  const app = await startApp({ db, query: spy.query });
  t.after(app.close);
  await app.addUser("viewer@example.com", "viewer", PASSWORD);
  const { cookie } = await app.login("viewer@example.com", PASSWORD);
  return { app, db, spy, get: (p) => app.request(p, { headers: { cookie } }) };
}

test("GET /api/deployments needs a session", async (t) => {
  const app = await startApp();
  t.after(app.close);
  assert.equal((await app.request("/api/deployments?project=sample-service&days=7")).status, 401);
});

test("a bad project or days is a 400 and sends no query", async (t) => {
  const s = await setup(t, { prepare: (db) => addShop(db) });
  const bad = [
    "",
    "?days=7",
    "?project=nope&days=7",
    "?project=sample-service&days=1",
    "?project=sample-service&days=8",
    "?project=sample-service&days=7.5",
    "?project=sample-service&days=-7",
    "?project=sample-service&days=abc",
    "?project=sample-service&days=7&days=30",
    "?project=sample-service&project=shop&days=7",
    "?project=sample-service%27%20OR%201=1&days=7",
    "?project=SAMPLE-SERVICE&days=7",
  ];
  for (const qs of bad) assert.equal((await s.get(`/api/deployments${qs}`)).status, 400, qs);
  assert.equal(s.spy.sent.length, 0);
});

test("a CI project: runs from deployment_event with a constant query, weeks and the latest", async (t) => {
  const rows = [
    { time: NOW - 5 * MIN, commit_sha: "bbb", pipeline_run_id: "22", branch: "master", previous_image: "img:aaa" },
    { time: NOW - 9 * DAY, commit_sha: "aaa", pipeline_run_id: "21", branch: "master", previous_image: "" },
  ];
  const s = await setup(t, { rows });
  const res = await s.get("/api/deployments?project=sample-service&days=30");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.project, "sample-service");
  assert.equal(body.runs.length, 2);
  assert.deepEqual(body.runs[0], { at: NOW - 5 * MIN, source: "ci", ref: "bbb", previousRef: "img:aaa", detail: "Branch master, run 22", runId: "22", branch: "master" });
  assert.equal(body.runs[1].previousRef, null);
  assert.deepEqual(body.latest, body.runs[0]);
  assert.equal(body.weeks.reduce((n, w) => n + w.count, 0), 2);
  assert.ok(body.weeks.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.week)));
  assert.equal(body.rollback.mode, "n8n");
  assert.equal(body.rollback.ready, true);
  assert.deepEqual(s.spy.sent, [
    `SELECT "commit_sha","pipeline_run_id","branch","previous_image" FROM "deployment_event" WHERE "source" = 'ci' AND ("container_name" = 'sample-service') AND time > now() - 720h ORDER BY time DESC`,
    `SELECT "commit_sha","pipeline_run_id","branch","previous_image" FROM "deployment_event" WHERE "source" = 'ci' AND ("container_name" = 'sample-service') ORDER BY time DESC LIMIT 1`,
  ]);
});

test("an image project: runs from detected_deployments, newest first, within the window", async (t) => {
  const s = await setup(t, {
    prepare: async (db) => {
      await addShop(db);
      await db.transaction(async (ops) => {
        const add = (at, o, n) => ops.insertDetectedDeployment({ projectKey: "shop", serverKey: "shop-node", containerName: "web", oldImage: o, newImage: n, detectedAt: new Date(at) });
        await add(NOW - 2 * DAY, "shop/web:1", "shop/web:2");
        await add(NOW - 1 * DAY, "shop/web:2", "shop/web:3");
        await add(NOW - 20 * DAY, "shop/web:0", "shop/web:1");
      });
    },
  });
  const week = await (await s.get("/api/deployments?project=shop&days=7")).json();
  assert.deepEqual(week.runs.map((r) => [r.ref, r.previousRef]), [["shop/web:3", "shop/web:2"], ["shop/web:2", "shop/web:1"]]);
  assert.equal(week.runs[0].source, "image");
  assert.equal(week.runs[0].detail, "Container web");
  assert.equal(week.latest.ref, "shop/web:3");
  const month = await (await s.get("/api/deployments?project=shop&days=30")).json();
  assert.equal(month.runs.length, 3);
  assert.equal(month.weeks.reduce((n, w) => n + w.count, 0), 3);
  // No InfluxDB query for an image project.
  assert.equal(s.spy.sent.length, 0);
});

test("the rollback block by mode", async (t) => {
  const s = await setup(t, {
    prepare: async (db) => {
      await addShop(db, ["web"], "own");
      await addShop(db, ["db"], "nope");
      await db.transaction(async (ops) => {
        await ops.updateProject("own", { rollback: "own_pipeline" });
      });
    },
  });
  const own = await (await s.get("/api/deployments?project=own&days=7")).json();
  assert.deepEqual(own.rollback, { mode: "own_pipeline", ready: false, text: "Rollback is handled by the project's own pipeline" });
  assert.equal(own.latest, null);
  assert.deepEqual(own.runs, []);
  const none = await (await s.get("/api/deployments?project=nope&days=7")).json();
  assert.deepEqual(none.rollback, { mode: "none", ready: false, text: "No rollback from this platform" });
  // n8n: ready only within 15 minutes of the latest deployment.
  assert.equal(rollbackBlock("n8n", { at: NOW - 14 * MIN }, NOW).ready, true);
  assert.equal(rollbackBlock("n8n", { at: NOW - 16 * MIN }, NOW).ready, false);
  assert.equal(rollbackBlock("n8n", null, NOW).ready, false);
});

test("an InfluxDB failure for a CI project is a 502", async (t) => {
  const down = await startApp({ query: async () => { throw new Error("influxdb returned 500"); } });
  t.after(down.close);
  await down.addUser("v@example.com", "viewer", PASSWORD);
  const { cookie } = await down.login("v@example.com", PASSWORD);
  assert.equal((await down.request("/api/deployments?project=sample-service&days=7", { headers: { cookie } })).status, 502);
});

test("weeklyCounts lists every week of the window, empty ones too, starting on Monday", () => {
  // 2026-10-30 is a Friday. A 14 day window starts on 2026-10-16 (a Friday): weeks of Oct 12, 19 and 26.
  const weeks = weeklyCounts([{ at: NOW }, { at: NOW - 1000 }, { at: NOW - 12 * DAY }], NOW - 14 * DAY, NOW);
  assert.deepEqual(weeks, [
    { week: "2026-10-12", count: 1 },
    { week: "2026-10-19", count: 0 },
    { week: "2026-10-26", count: 2 },
  ]);
});
