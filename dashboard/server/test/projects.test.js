// Tests for GET /api/projects: the contract, the status rules, the strip, the last deployment and
// the rollback block. Prometheus is replaced by a stub on the global fetch, InfluxDB by a function.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { PROMETHEUS_URL } = require("../prometheus");
const { buildStrip } = require("../projects");

const GB = 1024 ** 3;
// The test clock in helpers.js.
const NOW = Date.UTC(2026, 9, 30, 8, 0, 0);
const MIN = 60000;
const CELL = 15 * MIN;
const PASSWORD = "a long enough password";

// config.servers[key].containers[name] = { mem, limit, restarts, present(k), restartedAt }
// where k is the cell number from 1 (oldest) to 96 (newest). mem null means not up now.
function stubProm(t, config) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(PROMETHEUS_URL)) return original(url, init);
    if (config.down) throw new TypeError("fetch failed");
    const u = new URL(href);
    const q = u.searchParams.get("query");
    const key = Object.keys(config.servers).find((k) => q.includes(`server="${k}"`)) || "main";
    const containers = Object.entries(config.servers[key].containers);
    const ok = (resultType, result) =>
      new Response(JSON.stringify({ status: "success", data: { resultType, result } }), { headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v1/query_range") {
      const start = Number(u.searchParams.get("start"));
      const step = Number(u.searchParams.get("step"));
      const series = (fn) =>
        containers
          .map(([name, c]) => {
            const values = [];
            for (let k = 1; k <= 96; k++) {
              const v = fn(c, k);
              if (v !== null) values.push([start + k * step, String(v)]);
            }
            return values.length ? { metric: { name }, values } : null;
          })
          .filter(Boolean);
      if (q.includes("count_over_time")) return ok("matrix", series((c, k) => (c.present(k) ? 1 : null)));
      if (q.includes("container_start_time_seconds")) {
        return ok("matrix", series((c, k) => (c.present(k) ? (c.restartedAt && k >= c.restartedAt ? 2000 : 1000) : null)));
      }
      return ok("matrix", []);
    }
    const perName = (field) =>
      ok(
        "vector",
        containers.filter(([, c]) => c[field] !== null && c[field] !== undefined).map(([name, c]) => ({ metric: { name }, value: [NOW / 1000, String(c[field])] }))
      );
    if (q.includes(" - node_memory_MemAvailable")) return ok("vector", [{ metric: {}, value: [NOW / 1000, String(2 * GB)] }]);
    if (q.startsWith("node_memory_MemTotal_bytes")) return ok("vector", [{ metric: {}, value: [NOW / 1000, String(8 * GB)] }]);
    if (q.startsWith("sum by (name) (container_memory_working_set_bytes")) return perName("mem");
    if (q.startsWith("max by (name) (container_spec_memory_limit_bytes")) return perName("limit");
    if (q.startsWith("changes(")) return perName("restarts");
    return ok("vector", []);
  };
  t.after(() => { globalThis.fetch = original; });
}

const always = () => true;
const up = (extra = {}) => ({ mem: 100 * 1024 * 1024, limit: 512 * 1024 * 1024, restarts: 0, present: always, ...extra });

function influx({ latest = [], open = [], expl = [], deploys = [], recent = null, fail = false } = {}) {
  return async (q) => {
    if (fail) throw new Error("influxdb returned 500");
    if (q.includes('FROM "anomaly_score"')) return latest;
    if (q.includes('FROM "incident_open"')) return open;
    if (q.includes('FROM "incident_explanation"')) return expl;
    if (q.includes('FROM "deployment_event"')) return q.includes("LIMIT 1") ? deploys.slice(0, 1) : recent || deploys;
    return [];
  };
}

async function setup(t, { servers, query, withServer = false } = {}) {
  const config = { servers: { main: { containers: {} }, "shop-node": { containers: {} }, ...servers } };
  stubProm(t, config);
  const app = await startApp({ query: query || influx() });
  t.after(app.close);
  if (withServer) {
    await app.db.transaction(async (ops) => {
      await ops.insertServer({ key: "shop-node", name: "shop-node", role: "application", location: "Home lab", address: "100.64.0.12", builtin: false, status: "active", node_job: "node-registry", cadvisor_job: "cadvisor-registry" });
      await ops.insertProject({ key: "shop", name: "shop", server_key: "shop-node", repo_url: null, deploy_source: "image", automation: "monitored", rollback: "own_pipeline", builtin: false, status: "active", containers: ["a", "b"] });
      await ops.insertProject({ key: "idle", name: "idle", server_key: "shop-node", repo_url: null, deploy_source: "image", automation: "monitored", builtin: false, status: "active", containers: ["z"] });
      await ops.insertProject({ key: "gone", name: "gone", server_key: "shop-node", repo_url: null, deploy_source: "image", automation: "monitored", builtin: false, status: "active", containers: ["g"] });
    });
  }
  await app.addUser("viewer@example.com", "viewer", PASSWORD);
  const { cookie } = await app.login("viewer@example.com", PASSWORD);
  return { app, config, get: (p) => app.request(p, { headers: { cookie } }) };
}

const byKey = (list) => Object.fromEntries(list.map((p) => [p.key, p]));

test("GET /api/projects needs a session", async (t) => {
  stubProm(t, { servers: { main: { containers: {} } } });
  const app = await startApp();
  t.after(app.close);
  assert.equal((await app.request("/api/projects")).status, 401);
});

test("the contract for the built-in project, with its last CI deployment and the 15 minute rollback", async (t) => {
  const deploy = { time: NOW - 5 * MIN, commit_sha: "abc123", pipeline_run_id: "99", branch: "master" };
  const s = await setup(t, {
    servers: { main: { containers: { "sample-service": up({ restarts: 1 }) } } },
    query: influx({ deploys: [deploy] }),
  });
  const res = await s.get("/api/projects");
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.length, 1);
  const p = list[0];
  assert.deepEqual(Object.keys(p).sort(), ["automation", "containers", "deploySource", "key", "lastDeploy", "name", "rollback", "server", "status", "strip", "watchedByModel"].sort());
  assert.equal(p.key, "sample-service");
  assert.deepEqual(p.server, { key: "main", name: "fyp-main" });
  assert.deepEqual(p.containers, [{ name: "sample-service", up: true, restarts24h: 1, memBytes: 100 * 1024 * 1024, limitBytes: 512 * 1024 * 1024 }]);
  assert.equal(p.status, "healthy");
  assert.equal(p.watchedByModel, true);
  assert.equal(p.automation, "approval");
  assert.equal(p.deploySource, "ci");
  assert.deepEqual(p.lastDeploy, { at: NOW - 5 * MIN, source: "ci", ref: "abc123" });
  assert.equal(p.rollback.mode, "n8n");
  assert.equal(p.rollback.ready, true);
  assert.equal(typeof p.rollback.text, "string");
  assert.equal(p.strip.length, 96);
  assert.ok(p.strip.every((c) => ["up", "deploy", "restart", "incident", "down", "nodata"].includes(c)));
  // The deployment 5 minutes ago falls in the newest cell, which shows it.
  assert.equal(p.strip[95], "deploy");
  assert.equal(p.strip[94], "up");
});

test("a deployment older than 15 minutes means no rollback is possible now", async (t) => {
  const s = await setup(t, {
    servers: { main: { containers: { "sample-service": up() } } },
    query: influx({ deploys: [{ time: NOW - 40 * MIN, commit_sha: "old", pipeline_run_id: "1", branch: "master" }] }),
  });
  const p = (await (await s.get("/api/projects")).json())[0];
  assert.equal(p.rollback.ready, false);
  assert.match(p.rollback.text, /15 minutes/);
  const none = await setup(t, { servers: { main: { containers: { "sample-service": up() } } } });
  const q = (await (await none.get("/api/projects")).json())[0];
  assert.equal(q.lastDeploy, null);
  assert.equal(q.rollback.ready, false);
});

test("status: healthy, partial, down and no_data, and the rollback mode of each project", async (t) => {
  const s = await setup(t, {
    withServer: true,
    servers: {
      main: { containers: { "sample-service": up() } },
      "shop-node": {
        containers: {
          a: up(),
          // b is not up now but was earlier today.
          b: up({ mem: null, present: (k) => k < 90 }),
          // g was up earlier and is not up now.
          g: up({ mem: null, present: (k) => k < 50 }),
        },
      },
    },
  });
  const list = byKey(await (await s.get("/api/projects")).json());
  assert.equal(list["sample-service"].status, "healthy");
  assert.equal(list.shop.status, "partial");
  assert.deepEqual(list.shop.containers.map((c) => [c.name, c.up]), [["a", true], ["b", false]]);
  assert.equal(list.gone.status, "down");
  assert.equal(list.idle.status, "no_data");
  assert.deepEqual(list.idle.containers, [{ name: "z", up: false, restarts24h: null, memBytes: null, limitBytes: null }]);
  assert.ok(list.idle.strip.every((c) => c === "nodata"));
  assert.equal(list.shop.rollback.mode, "own_pipeline");
  assert.equal(list.shop.rollback.text, "Rollback is handled by the project's own pipeline");
  assert.equal(list.idle.rollback.mode, "none");
  assert.equal(list.idle.rollback.text, "No rollback from this platform");
  assert.equal(list.shop.watchedByModel, false);
  assert.equal(list.shop.deploySource, "image");
  assert.equal(list.shop.lastDeploy, null);
});

test("the strip shows nodata before the first sight, then up, down after it vanished", async (t) => {
  const s = await setup(t, {
    withServer: true,
    servers: { "shop-node": { containers: { g: up({ mem: null, present: (k) => k >= 11 && k <= 50 }) } } },
  });
  const strip = byKey(await (await s.get("/api/projects")).json()).gone.strip;
  assert.equal(strip.length, 96);
  assert.ok(strip.slice(0, 10).every((c) => c === "nodata"));
  assert.ok(strip.slice(10, 50).every((c) => c === "up"));
  assert.ok(strip.slice(50).every((c) => c === "down"));
});

test("a restart shows in its cell, and a detected deployment shows as deploy", async (t) => {
  const s = await setup(t, {
    withServer: true,
    servers: { "shop-node": { containers: { a: up({ restartedAt: 60 }), b: up() } } },
  });
  // A detected deployment in cell 80 (the cell ends at NOW - 16 cells * 15 minutes).
  await s.app.db.transaction((ops) =>
    ops.insertDetectedDeployment({ projectKey: "shop", serverKey: "shop-node", containerName: "a", oldImage: "shop:1", newImage: "shop:2", detectedAt: new Date(NOW - 16 * CELL - 5 * MIN) })
  );
  const shop = byKey(await (await s.get("/api/projects")).json()).shop;
  assert.equal(shop.strip[59], "restart");
  assert.equal(shop.strip[58], "up");
  assert.equal(shop.strip[79], "deploy");
  assert.deepEqual(shop.lastDeploy, { at: NOW - 16 * CELL - 5 * MIN, source: "image", ref: "shop:2" });
});

test("incident applies only to sample-service, from the existing status logic", async (t) => {
  const open = { time: NOW - 3 * MIN, tier: "medium", peak_score: 0.7, minutes: 2, job: "sample-service" };
  const s = await setup(t, {
    withServer: true,
    servers: { main: { containers: { "sample-service": up() } }, "shop-node": { containers: { a: up(), b: up() } } },
    query: influx({ latest: [{ time: NOW - MIN, warmup: 0, early_warning: 0 }], open: [open] }),
  });
  const list = byKey(await (await s.get("/api/projects")).json());
  assert.equal(list["sample-service"].status, "incident");
  assert.equal(list.shop.status, "healthy");
  // The incident minutes are marked in the newest cell of sample-service only.
  assert.equal(list["sample-service"].strip[95], "incident");
  assert.notEqual(list.shop.strip[95], "incident");
});

test("InfluxDB down leaves the incident and deployment parts out but still answers", async (t) => {
  const s = await setup(t, { servers: { main: { containers: { "sample-service": up() } } }, query: influx({ fail: true }) });
  const res = await s.get("/api/projects");
  assert.equal(res.status, 200);
  const p = (await res.json())[0];
  assert.equal(p.status, "healthy");
  assert.equal(p.lastDeploy, null);
});

test("Prometheus down gives 502", async (t) => {
  const s = await setup(t, { servers: {} });
  s.config.down = true;
  const res = await s.get("/api/projects");
  assert.equal(res.status, 502);
});

test("buildStrip priority: down, incident, deploy, restart, up", () => {
  const t = [CELL, 2 * CELL, 3 * CELL, 4 * CELL, 5 * CELL];
  const cells = [[{ state: "up" }, { state: "restarted" }, { state: "restarted" }, { state: "nodata" }, { state: "nodata" }]];
  const strip = buildStrip(t, cells, [{ start: 2 * CELL - 1000, end: 2 * CELL - 500 }], [3 * CELL - 1000]);
  // Cell 2 has a restart and an incident (incident wins); cell 3 has a restart and a deploy (deploy wins).
  assert.deepEqual(strip, ["up", "incident", "deploy", "down", "down"]);
});
