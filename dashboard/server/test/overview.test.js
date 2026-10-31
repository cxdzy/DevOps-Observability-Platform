const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { QUERIES, EXPECTED } = require("../overview");
const { PROMETHEUS_URL } = require("../prometheus");

const GB = 1024 ** 3;

// Sample vectors per query and job. The staging server ("-old" jobs) can be left out.
function samples({ staging = true } = {}) {
  const rows = {
    uname: [{ metric: { job: "node-exporter", nodename: "fyp-main" }, value: 1 }],
    up: [{ metric: { job: "node-exporter" }, value: 1 }],
    memTotal: [{ metric: { job: "node-exporter" }, value: 8 * GB }],
    memAvailable: [{ metric: { job: "node-exporter" }, value: 5 * GB }],
    diskSize: [{ metric: { job: "node-exporter", mountpoint: "/" }, value: 180 * GB }],
    diskAvailable: [{ metric: { job: "node-exporter", mountpoint: "/" }, value: 140 * GB }],
    cpuCount: [{ metric: { job: "node-exporter" }, value: 4 }],
    cpuBusy: [{ metric: { job: "node-exporter" }, value: 0.12 }],
    containers: [{ metric: { job: "cadvisor" }, value: 3 }],
    services: [
      { metric: { job: "cadvisor", name: "worker" }, value: 300e6 },
      { metric: { job: "cadvisor", name: "influxdb" }, value: 200e6 },
      { metric: { job: "cadvisor", name: "extra-tool" }, value: 10e6 },
    ],
  };
  if (staging) {
    rows.uname.push({ metric: { job: "node-exporter-old", nodename: "naqib-emqx-vps-1" }, value: 1 });
    rows.up.push({ metric: { job: "node-exporter-old" }, value: 1 });
    rows.memTotal.push({ metric: { job: "node-exporter-old" }, value: 4 * GB });
    rows.cpuCount.push({ metric: { job: "node-exporter-old" }, value: 2 });
    rows.containers.push({ metric: { job: "cadvisor-old" }, value: 7 });
  }
  return rows;
}

// Answers requests to the default Prometheus URL; everything else goes to the real fetch
// (the test client talks to the app with it). Records every Prometheus query that was sent.
function stubPrometheus(t, { staging = true, down = false } = {}) {
  const sent = [];
  const original = globalThis.fetch;
  const byQuery = new Map(Object.entries(QUERIES).map(([k, q]) => [q, k]));
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(PROMETHEUS_URL)) return original(url, init);
    const q = new URL(href).searchParams.get("query");
    sent.push(q);
    if (down) throw new TypeError("fetch failed");
    const rows = samples({ staging })[byQuery.get(q)] || [];
    const result = rows.map((r) => ({ metric: r.metric, value: [1700000000, String(r.value)] }));
    return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result } }), {
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  return sent;
}

async function signedIn(t, options = {}) {
  const app = await startApp(options);
  t.after(app.close);
  await app.addUser("viewer@example.com", "viewer", "a long enough password");
  const { cookie } = await app.login("viewer@example.com", "a long enough password");
  const get = (path) => app.request(path, { headers: { cookie } });
  return { app, get };
}

test("the overview routes need a session", async (t) => {
  stubPrometheus(t);
  const app = await startApp();
  t.after(app.close);
  for (const path of ["/api/nodes", "/api/services", "/api/activity"]) {
    assert.equal((await app.request(path)).status, 401, path);
  }
});

test("GET /api/nodes returns both servers with their values and static labels", async (t) => {
  stubPrometheus(t);
  const { get } = await signedIn(t);
  const res = await get("/api/nodes");
  assert.equal(res.status, 200);
  const [main, old] = await res.json();
  assert.deepEqual(main, {
    key: "main",
    hostname: "fyp-main",
    role: "Platform",
    provider: "Tencent Cloud",
    location: "Singapore",
    up: true,
    memoryTotalBytes: 8 * GB,
    memoryAvailableBytes: 5 * GB,
    diskSizeBytes: 180 * GB,
    diskAvailableBytes: 140 * GB,
    cpuCount: 4,
    cpuBusy: 0.12,
    containers: 3,
  });
  assert.equal(old.key, "old");
  assert.equal(old.hostname, "naqib-emqx-vps-1");
  assert.equal(old.role, "Staging");
  assert.equal(old.provider, "Hetzner");
  assert.equal(old.location, "Finland");
  assert.equal(old.memoryTotalBytes, 4 * GB);
  assert.equal(old.containers, 7);
  // Values Prometheus did not return for the staging server stay null.
  assert.equal(old.memoryAvailableBytes, null);
  assert.equal(old.diskSizeBytes, null);
});

test("a staging server with no data is returned with null values, not guesses", async (t) => {
  stubPrometheus(t, { staging: false });
  const { get } = await signedIn(t);
  const [, old] = await (await get("/api/nodes")).json();
  assert.equal(old.key, "old");
  assert.equal(old.role, "Staging");
  for (const field of ["hostname", "up", "memoryTotalBytes", "memoryAvailableBytes", "diskSizeBytes", "diskAvailableBytes", "cpuCount", "cpuBusy", "containers"]) {
    assert.equal(old[field], null, field);
  }
});

test("GET /api/services lists the main server's containers and the expected names", async (t) => {
  stubPrometheus(t);
  const { get } = await signedIn(t);
  const body = await (await get("/api/services")).json();
  assert.deepEqual(body.expected, EXPECTED);
  assert.deepEqual(body.containers, [
    { name: "extra-tool", memoryBytes: 10e6 },
    { name: "influxdb", memoryBytes: 200e6 },
    { name: "worker", memoryBytes: 300e6 },
  ]);
});

test("the services query reads only the main server's cAdvisor job", () => {
  assert.match(QUERIES.services, /job="cadvisor"/);
  assert.doesNotMatch(QUERIES.services, /cadvisor-old/);
});

test("Prometheus down gives 502 on nodes and services while incidents still work", async (t) => {
  stubPrometheus(t, { down: true });
  const { get } = await signedIn(t);
  for (const path of ["/api/nodes", "/api/services"]) {
    const res = await get(path);
    assert.equal(res.status, 502, path);
    assert.deepEqual(await res.json(), { error: "prometheus unreachable" });
  }
  assert.equal((await get("/api/incidents")).status, 200);
  assert.equal((await get("/api/activity")).status, 200);
});

test("no request input reaches a Prometheus query", async (t) => {
  const sent = stubPrometheus(t);
  const { get } = await signedIn(t);
  const evil = encodeURIComponent('up{job="x"} or vector(1)');
  await get(`/api/nodes?query=${evil}&job=${evil}`);
  await get(`/api/services?query=${evil}&name=${evil}`);
  assert.ok(sent.length > 0);
  const allowed = new Set(Object.values(QUERIES));
  for (const q of sent) assert.ok(allowed.has(q), `unexpected query: ${q}`);
});

test("GET /api/activity merges closed incidents, the latest CI deployment and the latest retraining", async (t) => {
  stubPrometheus(t);
  const T = Date.UTC(2026, 9, 30, 7, 0, 0);
  const queries = [];
  const query = async (q) => {
    queries.push(q);
    if (q.includes('FROM "incident_explanation"')) {
      return [
        { time: T - 60 * 60000, tier: "low", signal: "cpu", action: "notify", minutes: 1, peak_score: 0.66 },
        { time: T - 10 * 60000, tier: "medium", signal: "memory", action: "restart", minutes: 2, peak_score: 0.7 },
      ];
    }
    if (q.includes('FROM "incident_open"')) return [{ time: T - 2 * 60000, tier: "high", minutes: 1 }];
    if (q.includes('FROM "deployment_event"')) {
      return [{ time: T - 30 * 60000, commit_sha: "abc1234def", pipeline_run_id: "42", branch: "master" }];
    }
    if (q.includes('FROM "model_retrain"')) {
      return [{ time: T - 5 * 60000, promoted: 0, new_version: "", champion_version: "10", champion_f1: 0.8276, challenger_f1: 0.81 }];
    }
    return [];
  };
  const { get } = await signedIn(t, { query });
  const res = await get("/api/activity");
  assert.equal(res.status, 200);
  const items = await res.json();
  assert.deepEqual(items.map((i) => i.type), ["retrain", "incident", "deployment", "incident"]);
  assert.deepEqual(items[0], {
    type: "retrain",
    time: T - 5 * 60000,
    promoted: false,
    newVersion: null,
    championVersion: "10",
    championF1: 0.8276,
    challengerF1: 0.81,
  });
  assert.equal(items[1].tier, "medium");
  assert.equal(items[1].peakScore, 0.7);
  assert.equal(items[2].commit, "abc1234def");
  // The open incident is not activity yet.
  assert.ok(!items.some((i) => i.type === "incident" && i.tier === "high"));
  // Only CI deployments are read, never the injector's simulated ones.
  const deployQuery = queries.find((q) => q.includes('FROM "deployment_event"'));
  assert.match(deployQuery, /"source" = 'ci'/);
});

test("activity keeps only the newest five items", async (t) => {
  stubPrometheus(t);
  const T = Date.UTC(2026, 9, 30, 7, 0, 0);
  const query = async (q) =>
    q.includes('FROM "incident_explanation"')
      ? Array.from({ length: 8 }, (_, i) => ({ time: T - (i + 1) * 3600000, tier: "low", minutes: 1 }))
      : [];
  const { get } = await signedIn(t, { query });
  const items = await (await get("/api/activity")).json();
  assert.equal(items.length, 5);
  assert.equal(items[0].time, T - 3600000);
});

test("InfluxDB down gives 502 on activity while nodes still work", async (t) => {
  stubPrometheus(t);
  const query = async () => { throw new Error("influxdb returned 500"); };
  const { get } = await signedIn(t, { query });
  const res = await get("/api/activity");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "influxdb unreachable" });
  assert.equal((await get("/api/nodes")).status, 200);
});
