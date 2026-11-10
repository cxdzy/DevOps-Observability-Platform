const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { QUERIES, ALLOWED, UP_QUERY, ROOT_FS } = require("../resources");
const { QUERIES: OVERVIEW_QUERIES } = require("../overview");
const { PROMETHEUS_URL } = require("../prometheus");

const GB = 1024 ** 3;
// The test clock in helpers.js.
const NOW_SEC = Date.UTC(2026, 9, 30, 8, 0, 0) / 1000;

// Instant values per server key and query name. A name left out returns an empty vector.
function instantSamples({ swap = true, pressure = true } = {}) {
  const main = {
    uname: { labels: { nodename: "VM-0-13-ubuntu" }, value: 1 },
    cpuBusy: 0.06,
    cores: 4,
    loadPerCore: 0.128,
    memoryUsed: 0.483,
    memoryTotal: 8 * GB,
    swapUsed: 0.481,
    swapTotal: 2 * GB,
    diskUsed: 0.281,
    rootSize: 177 * GB,
    pressureCpu: 0.4,
    pressureMemory: 0,
    pressureIo: 0.1,
    uptime: 1632960,
    containers: 15,
  };
  const old = {
    uname: { labels: { nodename: "staging-host" }, value: 1 },
    cpuBusy: 0.04,
    cores: 2,
    loadPerCore: 0.095,
    memoryUsed: 0.297,
    memoryTotal: 3.7 * GB,
    // A server without swap: SwapTotal is 0 and the ratio is NaN.
    swapUsed: swap ? 0.1 : "NaN",
    swapTotal: swap ? 1 * GB : 0,
    diskUsed: 0.556,
    rootSize: 37.2 * GB,
    pressureCpu: 0.2,
    pressureMemory: 0,
    pressureIo: 0.3,
    uptime: 86400,
    containers: 10,
  };
  if (!pressure) {
    for (const s of [main, old]) {
      delete s.pressureCpu;
      delete s.pressureMemory;
      delete s.pressureIo;
    }
  }
  return { main, old };
}

const RANGE_SERIES = {
  cpu: [["0", "6.5"], ["60", "7.25"]],
  memory: [["0", "48"], ["60", "NaN"]],
  networkIn: [["0", "42000"]],
  networkOut: [["0", "28000"]],
  diskRead: [["0", "400"]],
  diskWrite: [["0", "1800"]],
};

// Answers requests to the default Prometheus URL; everything else goes to the real fetch (the
// test client talks to the app with it). Records every Prometheus request.
function stubPrometheus(t, options = {}) {
  const sent = [];
  const original = globalThis.fetch;
  const lookup = new Map();
  for (const [key, q] of Object.entries(QUERIES)) {
    for (const [name, text] of Object.entries(q.instant)) lookup.set(text, { key, name, kind: "instant" });
    for (const [name, text] of Object.entries(q.range)) lookup.set(text, { key, name, kind: "range" });
  }
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(PROMETHEUS_URL)) return original(url, init);
    const u = new URL(href);
    sent.push({ path: u.pathname, query: u.searchParams.get("query"), params: Object.fromEntries(u.searchParams), method: init && init.method });
    if (options.down) throw new TypeError("fetch failed");
    const q = u.searchParams.get("query");
    let data;
    if (u.pathname === "/api/v1/query_range") {
      const hit = lookup.get(q);
      const values = hit ? RANGE_SERIES[hit.name] : null;
      const start = Number(u.searchParams.get("start"));
      const result = values ? [{ metric: { job: "x" }, values: values.map(([dt, v]) => [start + Number(dt), v]) }] : [];
      data = { resultType: "matrix", result };
    } else if (q === UP_QUERY) {
      const result = [{ metric: { job: "node-exporter" }, value: [NOW_SEC, "1"] }];
      if (!options.stagingDown) result.push({ metric: { job: "node-exporter-old" }, value: [NOW_SEC, "1"] });
      data = { resultType: "vector", result };
    } else {
      const hit = lookup.get(q);
      const sample = hit ? instantSamples(options)[hit.key][hit.name] : undefined;
      let result = [];
      if (sample !== undefined) {
        const labels = typeof sample === "object" ? sample.labels : {};
        const value = typeof sample === "object" ? sample.value : sample;
        result = [{ metric: { job: "x", ...labels }, value: [NOW_SEC, String(value)] }];
      }
      data = { resultType: "vector", result };
    }
    return new Response(JSON.stringify({ status: "success", data }), { headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });
  return sent;
}

async function signedIn(t) {
  const app = await startApp();
  t.after(app.close);
  await app.addUser("viewer@example.com", "viewer", "a long enough password");
  const { cookie } = await app.login("viewer@example.com", "a long enough password");
  return (path) => app.request(path, { headers: { cookie } });
}

test("GET /api/resources needs a session", async (t) => {
  const sent = stubPrometheus(t);
  const app = await startApp();
  t.after(app.close);
  assert.equal((await app.request("/api/resources")).status, 401);
  assert.equal(sent.length, 0);
});

test("the default is the main server over 6 hours, with values, facts and history", async (t) => {
  stubPrometheus(t);
  const get = await signedIn(t);
  const res = await get("/api/resources");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.key, "main");
  assert.equal(body.displayName, "fyp-main");
  assert.equal(body.hostname, "VM-0-13-ubuntu");
  assert.equal(body.hours, 6);
  assert.deepEqual(body.nodes, [
    { key: "main", displayName: "fyp-main", up: true },
    { key: "old", displayName: "staging", up: true },
  ]);
  assert.deepEqual(body.now, {
    cpuBusy: 0.06,
    loadPerCore: 0.128,
    memoryUsed: 0.483,
    swapUsed: 0.481,
    diskUsed: 0.281,
    pressure: { cpu: 0.4, memory: 0, io: 0.1 },
  });
  assert.deepEqual(body.facts, {
    cores: 4,
    memoryTotalBytes: 8 * GB,
    swapTotalBytes: 2 * GB,
    rootSizeBytes: 177 * GB,
    uptimeSeconds: 1632960,
    containers: 15,
  });
  assert.equal(body.end, NOW_SEC * 1000);
  assert.equal(body.start, (NOW_SEC - 6 * 3600) * 1000);
  const start = NOW_SEC - 6 * 3600;
  assert.deepEqual(body.history.cpu, [[start * 1000, 6.5], [(start + 60) * 1000, 7.25]]);
  // NaN in a range becomes null, never a guess.
  assert.deepEqual(body.history.memory, [[start * 1000, 48], [(start + 60) * 1000, null]]);
  for (const name of ["networkIn", "networkOut", "diskRead", "diskWrite"]) {
    assert.equal(body.history[name].length, 1, name);
  }
});

test("a staging server without swap reports swap as null", async (t) => {
  stubPrometheus(t, { swap: false });
  const get = await signedIn(t);
  const body = await (await get("/api/resources?node=old&hours=24")).json();
  assert.equal(body.key, "old");
  assert.equal(body.displayName, "staging");
  assert.equal(body.now.swapUsed, null);
  assert.equal(body.facts.swapTotalBytes, 0);
  assert.equal(body.now.memoryUsed, 0.297);
});

test("missing pressure metrics are null", async (t) => {
  stubPrometheus(t, { pressure: false });
  const get = await signedIn(t);
  const body = await (await get("/api/resources?node=main&hours=1")).json();
  assert.deepEqual(body.now.pressure, { cpu: null, memory: null, io: null });
  assert.equal(body.now.cpuBusy, 0.06);
});

test("a node exporter that is not up gives a null or false status, not a guess", async (t) => {
  stubPrometheus(t, { stagingDown: true });
  const get = await signedIn(t);
  const body = await (await get("/api/resources")).json();
  assert.deepEqual(body.nodes.map((n) => n.up), [true, null]);
});

test("a bad node or hours value gives 400 and sends no query", async (t) => {
  const sent = stubPrometheus(t);
  const get = await signedIn(t);
  const bad = [
    "/api/resources?node=other",
    "/api/resources?node=MAIN",
    "/api/resources?node=main&node=old",
    "/api/resources?node=",
    "/api/resources?hours=2",
    "/api/resources?hours=0",
    "/api/resources?hours=6.0",
    "/api/resources?hours=-6",
    "/api/resources?hours=169",
    "/api/resources?hours=6&hours=24",
    "/api/resources?hours=abc",
    '/api/resources?node=main%22%7D%20or%20vector(1)',
  ];
  for (const path of bad) {
    assert.equal((await get(path)).status, 400, path);
  }
  assert.equal(sent.length, 0);
});

test("Prometheus down gives 502", async (t) => {
  stubPrometheus(t, { down: true });
  const get = await signedIn(t);
  const res = await get("/api/resources?node=old&hours=72");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "prometheus unreachable" });
});

test("only allow-listed strings for the chosen server are sent, all with GET", async (t) => {
  const sent = stubPrometheus(t);
  const get = await signedIn(t);
  for (const node of ["main", "old"]) {
    sent.length = 0;
    assert.equal((await get(`/api/resources?node=${node}`)).status, 200);
    const allowed = new Set(ALLOWED);
    for (const s of sent) {
      assert.ok(allowed.has(s.query), s.query);
      assert.equal(s.method, "GET");
      assert.ok(["/api/v1/query", "/api/v1/query_range"].includes(s.path), s.path);
    }
    const expected = [UP_QUERY, ...Object.values(QUERIES[node].instant), ...Object.values(QUERIES[node].range)];
    assert.deepEqual(new Set(sent.map((s) => s.query)), new Set(expected));
    // The other server's job never appears in a node query.
    const otherJob = node === "main" ? "node-exporter-old" : 'job="node-exporter"';
    for (const s of sent.filter((x) => x.query !== UP_QUERY)) assert.ok(!s.query.includes(otherJob), s.query);
  }
});

test("the range step is about window / 360 for every window", async (t) => {
  const sent = stubPrometheus(t);
  const get = await signedIn(t);
  for (const hours of [1, 6, 24, 72, 168]) {
    sent.length = 0;
    const body = await (await get(`/api/resources?hours=${hours}`)).json();
    const ranges = sent.filter((s) => s.path === "/api/v1/query_range");
    assert.equal(ranges.length, 6, `${hours} h`);
    for (const r of ranges) {
      const start = Number(r.params.start);
      const end = Number(r.params.end);
      const step = Number(r.params.step);
      assert.equal(end, NOW_SEC);
      assert.equal(end - start, hours * 3600);
      assert.equal(step, (hours * 3600) / 360);
      assert.equal(Math.round((end - start) / step), 360);
    }
    assert.equal(body.stepSeconds, (hours * 3600) / 360);
  }
});

test("the root filter and the container count match overview.js", () => {
  assert.ok(OVERVIEW_QUERIES.diskSize.includes(ROOT_FS));
  assert.ok(OVERVIEW_QUERIES.containers.includes('container_memory_working_set_bytes{'));
  assert.ok(QUERIES.main.instant.containers.includes('job="cadvisor",name!=""'));
  assert.ok(QUERIES.old.instant.containers.includes('job="cadvisor-old",name!=""'));
});
