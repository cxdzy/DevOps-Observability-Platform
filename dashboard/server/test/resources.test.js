const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { QUERIES, CONTAINER_QUERIES, ALLOWED, UP_QUERY, ROOT_FS, CELLS } = require("../resources");
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
    for (const preset of Object.values(q.range)) {
      for (const [name, text] of Object.entries(preset)) lookup.set(text, { key, name, kind: "range" });
    }
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
    const expected = [UP_QUERY, ...Object.values(QUERIES[node].instant), ...Object.values(QUERIES[node].range[6])];
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

// The six history queries of one server with a given rate window, written out in full.
function expectedRange(job, window) {
  const net = 'device!~"lo|veth.*|docker.*|br-.*"';
  const disk = 'device!~"loop.*"';
  return [
    `100 * (1 - avg by (job) (rate(node_cpu_seconds_total{job="${job}",mode="idle"}[${window}])))`,
    `100 * (1 - node_memory_MemAvailable_bytes{job="${job}"} / node_memory_MemTotal_bytes{job="${job}"})`,
    `sum by (job) (rate(node_network_receive_bytes_total{job="${job}",${net}}[${window}]))`,
    `sum by (job) (rate(node_network_transmit_bytes_total{job="${job}",${net}}[${window}]))`,
    `sum by (job) (rate(node_disk_read_bytes_total{job="${job}",${disk}}[${window}]))`,
    `sum by (job) (rate(node_disk_written_bytes_total{job="${job}",${disk}}[${window}]))`,
  ];
}

test("each preset sends exactly its range strings, with a rate window of max(5m, step)", async (t) => {
  const sent = stubPrometheus(t);
  const get = await signedIn(t);
  const windows = { 1: "5m", 6: "5m", 24: "5m", 72: "12m", 168: "28m" };
  for (const [node, job] of [["main", "node-exporter"], ["old", "node-exporter-old"]]) {
    for (const [hours, window] of Object.entries(windows)) {
      sent.length = 0;
      assert.equal((await get(`/api/resources?node=${node}&hours=${hours}`)).status, 200);
      const ranges = sent.filter((s) => s.path === "/api/v1/query_range").map((s) => s.query);
      assert.deepEqual(ranges.sort(), expectedRange(job, window).sort(), `${node} ${hours} h`);
      // The instant queries do not depend on the preset.
      const instant = sent.filter((s) => s.path === "/api/v1/query").map((s) => s.query);
      assert.deepEqual(new Set(instant), new Set([UP_QUERY, ...Object.values(QUERIES[node].instant)]));
    }
  }
});

test("the allow list is fixed: one string per server, preset and query, plus the instant ones", () => {
  const instant = Object.values(QUERIES.main.instant).length + Object.values(QUERIES.old.instant).length;
  // Per server: 5 rate queries in 3 distinct windows (5m, 12m, 28m), plus the memory query, which
  // has no rate and is the same string in every preset.
  const range = new Set(Object.values(QUERIES).flatMap((q) => Object.values(q.range).flatMap((p) => Object.values(p))));
  assert.equal(range.size, 2 * (5 * 3 + 1));
  // The Containers tab adds 5 instant and 3 range strings per server; its memoryTotal is the node
  // string that is already counted above.
  const containerOwn = 2 * (5 + 3);
  assert.equal(new Set(ALLOWED).size, 1 + instant + range.size + containerOwn);
  assert.ok(Object.isFrozen(QUERIES.main.range[168]));
});

test("the root filter and the container count match overview.js", () => {
  assert.ok(OVERVIEW_QUERIES.diskSize.includes(ROOT_FS));
  assert.ok(OVERVIEW_QUERIES.containers.includes('container_memory_working_set_bytes{'));
  assert.ok(QUERIES.main.instant.containers.includes('job="cadvisor",name!=""'));
  assert.ok(QUERIES.old.instant.containers.includes('job="cadvisor-old",name!=""'));
});

// ---- Containers tab ----

const MB = 1024 ** 2;
const STEP = 900;
const START = NOW_SEC - 24 * 3600;
// The second a cell ends at, for cell index i from 0 to 95.
const cellEnd = (i) => START + (i + 1) * STEP;

// One fixture per container: instant values, and range values as functions of the cell index
// (undefined means no sample in that cell).
function containerFixture() {
  const steady = () => 1;
  return {
    ollama: {
      cpu: 0.2, memory: 1200 * MB, limit: 1600 * MB, restarts: 0,
      present: steady, started: () => START - 5000, share: (i) => (i >= 60 && i <= 63 ? 0.75 : 0.4),
    },
    mlflow: {
      cpu: 0.4, memory: 400 * MB, limit: 0, restarts: 0,
      present: steady, started: () => START - 5000, share: () => undefined,
    },
    "sample-service": {
      cpu: 0.3, memory: 135 * MB, limit: 512 * MB, restarts: 1,
      present: steady, started: (i) => (i < 66 ? START - 5000 : cellEnd(65) + 300), share: () => 0.26,
    },
    late: {
      // Appeared during the day: first seen in cell 40, started inside that cell.
      cpu: 1.5, memory: 50 * MB, limit: 256 * MB, restarts: 0,
      present: (i) => (i >= 40 ? 1 : undefined), started: () => cellEnd(39) + 200, share: () => 0.2,
    },
    hugelimit: {
      // cAdvisor can report a huge number for "no limit".
      cpu: 0, memory: 10 * MB, limit: 9223372036854771712, restarts: 0,
      present: steady, started: () => START - 5000, share: () => undefined,
    },
  };
}

// Answers the Containers queries of both servers from the fixture; everything else goes to fetch.
// A name in skipInstant is left out of the instant answers (a container that is gone now).
function stubContainers(t, { fixture = containerFixture(), down = false, memTotal = 8 * GB, skipInstant = [] } = {}) {
  const sent = [];
  const original = globalThis.fetch;
  const lookup = new Map();
  for (const [key, q] of Object.entries(CONTAINER_QUERIES)) {
    for (const [name, text] of Object.entries(q.instant)) lookup.set(text, { key, name, kind: "instant" });
    for (const [name, text] of Object.entries(q.range)) lookup.set(text, { key, name, kind: "range" });
  }
  const json = (data) => new Response(JSON.stringify({ status: "success", data }), { headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(PROMETHEUS_URL)) return original(url, init);
    const u = new URL(href);
    const q = u.searchParams.get("query");
    sent.push({ path: u.pathname, query: q, params: Object.fromEntries(u.searchParams), method: init && init.method });
    if (down) throw new TypeError("fetch failed");
    const hit = lookup.get(q);
    if (u.pathname === "/api/v1/query_range") {
      const result = [];
      for (const [name, c] of Object.entries(fixture)) {
        const f = c[hit.name];
        // A point at the start of the window, before the first cell, which the server ignores.
        const values = hit.name === "present" && c.present(0) !== undefined ? [[START, "1"]] : [];
        for (let i = 0; i < CELLS; i++) {
          const v = f(i);
          if (v !== undefined) values.push([cellEnd(i), String(v)]);
        }
        result.push({ metric: { name }, values });
      }
      return json({ resultType: "matrix", result });
    }
    if (hit.name === "memoryTotal") return json({ resultType: "vector", result: [{ metric: { job: "x" }, value: [NOW_SEC, String(memTotal)] }] });
    if (hit.name === "memoryUsedBytes") return json({ resultType: "vector", result: [{ metric: {}, value: [NOW_SEC, String(3.9 * GB)] }] });
    const result = Object.entries(fixture)
      .filter(([name]) => !skipInstant.includes(name))
      .map(([name, c]) => ({ metric: { name }, value: [NOW_SEC, String(c[hit.name])] }));
    return json({ resultType: "vector", result });
  };
  t.after(() => { globalThis.fetch = original; });
  return sent;
}

const stateOf = (c) => c.cells.map((x) => x.state);
const indexesOf = (c, state) => stateOf(c).map((s, i) => (s === state ? i : -1)).filter((i) => i >= 0);

test("GET /api/resources/containers needs a session", async (t) => {
  const sent = stubContainers(t);
  const app = await startApp();
  t.after(app.close);
  assert.equal((await app.request("/api/resources/containers")).status, 401);
  assert.equal(sent.length, 0);
});

test("a normal response has node memory, rows by memory and 96 cells of 15 minutes", async (t) => {
  stubContainers(t);
  const get = await signedIn(t);
  const res = await get("/api/resources/containers?node=main");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.node, "main");
  assert.equal(body.displayName, "fyp-main");
  assert.equal(body.memTotalBytes, 8 * GB);
  assert.equal(body.memUsedBytes, 3.9 * GB);
  assert.equal(body.stepSeconds, 900);
  assert.equal(body.end, NOW_SEC * 1000);
  assert.equal(body.start, START * 1000);
  assert.deepEqual(body.containers.map((c) => c.name), ["ollama", "mlflow", "sample-service", "late", "hugelimit"]);
  const ollama = body.containers[0];
  assert.equal(ollama.cpuPct, 0.2);
  assert.equal(ollama.memBytes, 1200 * MB);
  assert.equal(ollama.limitBytes, 1600 * MB);
  assert.equal(ollama.restarts24h, 0);
  assert.equal(ollama.cells.length, 96);
  assert.equal(ollama.cells[0].t, cellEnd(0) * 1000);
  assert.equal(ollama.cells[95].t, NOW_SEC * 1000);
  // A share of the limit at or above 70 percent only in those four cells.
  assert.deepEqual(indexesOf(ollama, "over70"), [60, 61, 62, 63]);
  assert.equal(stateOf(ollama).filter((s) => s === "up").length, 92);
});

test("a container without a limit has a null limit and never shows over70", async (t) => {
  stubContainers(t);
  const get = await signedIn(t);
  const body = await (await get("/api/resources/containers")).json();
  const mlflow = body.containers.find((c) => c.name === "mlflow");
  assert.equal(mlflow.limitBytes, null);
  assert.ok(stateOf(mlflow).every((s) => s === "up"));
  // A limit at or above the node's memory total is the "no limit" value on some setups.
  const huge = body.containers.find((c) => c.name === "hugelimit");
  assert.equal(huge.limitBytes, null);
});

test("a restart inside a cell marks that cell as restarted", async (t) => {
  stubContainers(t);
  const get = await signedIn(t);
  const body = await (await get("/api/resources/containers")).json();
  const svc = body.containers.find((c) => c.name === "sample-service");
  assert.equal(svc.restarts24h, 1);
  assert.deepEqual(indexesOf(svc, "restarted"), [66]);
  assert.equal(svc.cells[66].t, cellEnd(66) * 1000);
});

test("a gap followed by a new start time is a restart, not just up", async (t) => {
  const fixture = containerFixture();
  fixture.recreated = {
    cpu: 0.1, memory: 20 * MB, limit: 0, restarts: 1,
    present: (i) => (i >= 20 && i < 30 ? undefined : 1),
    started: (i) => (i >= 20 && i < 30 ? undefined : i < 20 ? START - 100 : cellEnd(29) + 60),
    share: () => undefined,
  };
  stubContainers(t, { fixture });
  const get = await signedIn(t);
  const body = await (await get("/api/resources/containers")).json();
  const states = stateOf(body.containers.find((c) => c.name === "recreated"));
  assert.ok(states.slice(20, 30).every((s) => s === "nodata"));
  assert.deepEqual(indexesOf(body.containers.find((c) => c.name === "recreated"), "restarted"), [30]);
});

test("a container that appeared during the day has no data before and is not a restart", async (t) => {
  stubContainers(t);
  const get = await signedIn(t);
  const body = await (await get("/api/resources/containers")).json();
  const states = stateOf(body.containers.find((c) => c.name === "late"));
  assert.ok(states.slice(0, 40).every((s) => s === "nodata"));
  assert.ok(states.slice(40).every((s) => s === "up"));
});

test("a container that is gone now still appears, with no current values", async (t) => {
  const fixture = containerFixture();
  fixture.gone = {
    cpu: 0, memory: 0, limit: 0, restarts: 0,
    present: (i) => (i < 10 ? 1 : undefined), started: () => START - 100, share: () => undefined,
  };
  stubContainers(t, { fixture, skipInstant: ["gone"] });
  const get = await signedIn(t);
  const body = await (await get("/api/resources/containers")).json();
  const g = body.containers.find((c) => c.name === "gone");
  assert.equal(g.memBytes, null);
  assert.equal(g.cpuPct, null);
  assert.equal(g.restarts24h, null);
  assert.equal(stateOf(g)[5], "up");
  assert.equal(stateOf(g)[50], "nodata");
  // Rows without a current memory value come last.
  assert.equal(body.containers[body.containers.length - 1].name, "gone");
});

test("a bad node gives 400 and sends no query", async (t) => {
  const sent = stubContainers(t);
  const get = await signedIn(t);
  for (const path of [
    "/api/resources/containers?node=other",
    "/api/resources/containers?node=MAIN",
    "/api/resources/containers?node=",
    "/api/resources/containers?node=main&node=old",
    "/api/resources/containers?node=main%22%7D%20or%20vector(1)",
  ]) {
    assert.equal((await get(path)).status, 400, path);
  }
  assert.equal(sent.length, 0);
});

test("Prometheus down gives 502 for the containers", async (t) => {
  stubContainers(t, { down: true });
  const get = await signedIn(t);
  const res = await get("/api/resources/containers?node=old");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "prometheus unreachable" });
});

test("only allow-listed container strings for the chosen server are sent, all with GET", async (t) => {
  const sent = stubContainers(t);
  const get = await signedIn(t);
  for (const node of ["main", "old"]) {
    sent.length = 0;
    assert.equal((await get(`/api/resources/containers?node=${node}`)).status, 200);
    const allowed = new Set(ALLOWED);
    for (const s of sent) {
      assert.ok(allowed.has(s.query), s.query);
      assert.equal(s.method, "GET");
    }
    const q = CONTAINER_QUERIES[node];
    assert.deepEqual(new Set(sent.map((s) => s.query)), new Set([...Object.values(q.instant), ...Object.values(q.range)]));
    const ranges = sent.filter((s) => s.path === "/api/v1/query_range");
    assert.equal(ranges.length, 3);
    for (const r of ranges) {
      assert.equal(Number(r.params.step), 900);
      assert.equal(Number(r.params.end) - Number(r.params.start), 24 * 3600);
    }
    const otherJob = node === "main" ? "cadvisor-old" : 'job="cadvisor"';
    for (const s of sent) assert.ok(!s.query.includes(otherJob), s.query);
  }
});

test("the container strings are written out for the main server", () => {
  const q = CONTAINER_QUERIES.main;
  assert.equal(q.instant.cpu, '100 * sum by (name) (rate(container_cpu_usage_seconds_total{job="cadvisor",name!=""}[5m]))');
  assert.equal(q.instant.memory, 'sum by (name) (container_memory_working_set_bytes{job="cadvisor",name!=""})');
  assert.equal(q.instant.limit, 'max by (name) (container_spec_memory_limit_bytes{job="cadvisor",name!=""})');
  assert.equal(q.instant.restarts, 'changes(max by (name) (container_start_time_seconds{job="cadvisor",name!=""})[24h:1m])');
  assert.equal(q.instant.memoryTotal, 'node_memory_MemTotal_bytes{job="node-exporter"}');
  assert.equal(q.range.present, 'count by (name) (count_over_time(container_memory_working_set_bytes{job="cadvisor",name!=""}[15m]))');
  assert.equal(q.range.started, 'max by (name) (max_over_time(container_start_time_seconds{job="cadvisor",name!=""}[15m]))');
  // on() must list name too, or the one-to-one division drops it and max by (name) has nothing.
  assert.equal(
    q.range.share,
    'max by (name) (max_over_time(container_memory_working_set_bytes{job="cadvisor",name!=""}[15m]) / on (id, name) (max_over_time(container_spec_memory_limit_bytes{job="cadvisor",name!=""}[15m]) > 0 < scalar(node_memory_MemTotal_bytes{job="node-exporter"})))'
  );
  assert.ok(Object.isFrozen(q.instant) && Object.isFrozen(q.range));
});

// A registry server: its queries carry job and server labels, and everything stays on the allow list.
test("an active registry server works on both resource routes with its own selector", async (t) => {
  const NODE = 'job="node-registry",server="shop-node"';
  const CAD = 'job="cadvisor-registry",server="shop-node"';
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(PROMETHEUS_URL)) return original(url, init);
    const u = new URL(href);
    const q = u.searchParams.get("query");
    sent.push({ path: u.pathname, query: q });
    const matrix = u.pathname === "/api/v1/query_range";
    let result = [];
    if (q === "up{" + NODE + "}") result = [{ metric: { job: "node-registry", server: "shop-node" }, value: [NOW_SEC, "1"] }];
    else if (q === "node_memory_MemTotal_bytes{" + NODE + "}") result = [{ metric: {}, value: [NOW_SEC, String(2 * GB)] }];
    else if (matrix && q.includes("node_cpu_seconds_total")) result = [{ metric: {}, values: [[NOW_SEC, "12.5"]] }];
    else if (q.startsWith("sum by (name) (container_memory_working_set_bytes")) result = [{ metric: { name: "shop-web" }, value: [NOW_SEC, "1000"] }];
    return new Response(JSON.stringify({ status: "success", data: { resultType: matrix ? "matrix" : "vector", result } }), { headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });

  const app = await startApp();
  t.after(app.close);
  await app.addUser("boss@example.com", "admin", "a long enough password");
  const { cookie } = await app.login("boss@example.com", "a long enough password");
  const get = (path) => app.request(path, { headers: { cookie } });

  // Unknown until the server is active, and no query is sent for it.
  const unknown = await get("/api/resources?node=shop-node");
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: "node must be main or old" });
  assert.equal((await get("/api/resources/containers?node=shop-node")).status, 400);
  assert.equal(sent.length, 0);

  await app.db.transaction(async (ops) => {
    await ops.insertServer({ key: "shop-node", name: "shop-node", role: "application", location: "Home lab", address: "100.64.0.12", builtin: false, status: "active", node_job: "node-registry", cadvisor_job: "cadvisor-registry" });
  });
  // A settings write reloads the registry at once.
  const write = await app.request("/api/settings/servers/old", { method: "PATCH", json: { role: "staging" }, headers: { cookie } });
  assert.equal(write.status, 200);

  const res = await get("/api/resources?node=shop-node&hours=6");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.key, "shop-node");
  assert.equal(body.role, "Application");
  assert.equal(body.location, "Home lab");
  assert.deepEqual(body.nodes.map((n) => [n.key, n.up]), [["main", null], ["old", null], ["shop-node", true]]);
  assert.equal(body.facts.memoryTotalBytes, 2 * GB);
  assert.deepEqual(body.history.cpu, [[NOW_SEC * 1000, 12.5]]);
  const instant = sent.filter((s) => s.path === "/api/v1/query").map((s) => s.query);
  assert.ok(instant.includes("node_uname_info{" + NODE + "}"));
  assert.ok(instant.includes("up{" + NODE + "}"));
  assert.ok(instant.includes("node_memory_MemTotal_bytes{" + NODE + "}"));
  // Every query of that server is scoped by both labels; none uses a built-in job.
  for (const s of sent) {
    if (s.query === UP_QUERY) continue;
    assert.ok(s.query.includes(NODE) || s.query.includes(CAD), s.query);
    assert.ok(!s.query.includes('job="node-exporter'), s.query);
  }

  sent.length = 0;
  const containers = await get("/api/resources/containers?node=shop-node");
  assert.equal(containers.status, 200);
  const cbody = await containers.json();
  assert.equal(cbody.node, "shop-node");
  assert.deepEqual(cbody.containers.map((c) => c.name), ["shop-web"]);
  for (const s of sent.filter((x) => x.query.includes("container_"))) assert.ok(s.query.includes(CAD), s.query);
  // The main and old strings are unchanged by the registry.
  assert.ok(ALLOWED.includes('node_memory_MemTotal_bytes{job="node-exporter"}'));
});
