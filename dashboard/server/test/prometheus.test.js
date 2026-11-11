const test = require("node:test");
const assert = require("node:assert/strict");
const { createPrometheus } = require("../prometheus");

const URL_BASE = "http://prom.test:9090";
const ALLOWED = 'up{job="node-exporter"}';

// Replaces global fetch for one test; returns the recorded calls.
function stubFetch(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("an allowed query is sent with GET to /api/v1/query and the vector comes back as plain objects", async (t) => {
  const calls = stubFetch(t, () =>
    json({
      status: "success",
      data: { resultType: "vector", result: [{ metric: { job: "node-exporter" }, value: [1700000000, "1"] }] },
    })
  );
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  const rows = await prom.query(ALLOWED);
  assert.deepEqual(rows, [{ labels: { job: "node-exporter" }, value: 1 }]);
  assert.equal(calls.length, 1);
  const sent = new URL(calls[0].url);
  assert.equal(sent.origin + sent.pathname, `${URL_BASE}/api/v1/query`);
  assert.equal(sent.searchParams.get("query"), ALLOWED);
  assert.equal(calls[0].init.method, "GET");
  assert.ok(calls[0].init.signal, "a timeout signal is set");
});

test("a query that is not in the allow list is refused before any request", async (t) => {
  const calls = stubFetch(t, () => json({}));
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  await assert.rejects(prom.query('up{job="anything"} or vector(1)'), /allow list/);
  assert.equal(calls.length, 0);
});

test("NaN and missing sample values become null", async (t) => {
  stubFetch(t, () =>
    json({
      status: "success",
      data: { resultType: "vector", result: [{ metric: { job: "a" }, value: [1, "NaN"] }, { metric: { job: "b" } }] },
    })
  );
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  const rows = await prom.query(ALLOWED);
  assert.deepEqual(rows.map((r) => r.value), [null, null]);
});

test("an HTTP error, an error status or a network failure rejects", async (t) => {
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  let mode = "http";
  stubFetch(t, () => {
    if (mode === "http") return json({ status: "error" }, 503);
    if (mode === "status") return json({ status: "error", error: "bad" });
    throw new TypeError("fetch failed");
  });
  await assert.rejects(prom.query(ALLOWED), /503/);
  mode = "status";
  await assert.rejects(prom.query(ALLOWED), /unexpected/);
  mode = "network";
  await assert.rejects(prom.query(ALLOWED), /fetch failed/);
});

function matrix(result) {
  return json({ status: "success", data: { resultType: "matrix", result } });
}

test("an allowed range query is sent with GET to /api/v1/query_range with start, end and step", async (t) => {
  const calls = stubFetch(t, () =>
    matrix([{ metric: { job: "node-exporter" }, values: [[1700000000, "0.5"], [1700000060, "NaN"], [1700000120, "2"]] }])
  );
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  const rows = await prom.queryRange(ALLOWED, 1700000000, 1700000120, 60);
  assert.deepEqual(rows, [
    { labels: { job: "node-exporter" }, values: [[1700000000000, 0.5], [1700000060000, null], [1700000120000, 2]] },
  ]);
  assert.equal(calls.length, 1);
  const sent = new URL(calls[0].url);
  assert.equal(sent.origin + sent.pathname, `${URL_BASE}/api/v1/query_range`);
  assert.equal(sent.searchParams.get("query"), ALLOWED);
  assert.equal(sent.searchParams.get("start"), "1700000000");
  assert.equal(sent.searchParams.get("end"), "1700000120");
  assert.equal(sent.searchParams.get("step"), "60");
  assert.equal(calls[0].init.method, "GET");
  assert.ok(calls[0].init.signal, "a timeout signal is set");
});

test("a range query outside the allow list or with bad times is refused before any request", async (t) => {
  const calls = stubFetch(t, () => matrix([]));
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  await assert.rejects(prom.queryRange('up{job="anything"}', 0, 60, 15), /allow list/);
  await assert.rejects(prom.queryRange(ALLOWED, "0", 60, 15), /finite/);
  await assert.rejects(prom.queryRange(ALLOWED, 0, NaN, 15), /finite/);
  await assert.rejects(prom.queryRange(ALLOWED, 0, 60, 0), /positive step/);
  await assert.rejects(prom.queryRange(ALLOWED, 120, 60, 15), /positive step/);
  assert.equal(calls.length, 0);
});

test("a range query rejects an HTTP error, a vector answer and a network failure", async (t) => {
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  let mode = "http";
  stubFetch(t, () => {
    if (mode === "http") return json({ status: "error" }, 503);
    if (mode === "vector") return json({ status: "success", data: { resultType: "vector", result: [] } });
    throw new TypeError("fetch failed");
  });
  await assert.rejects(prom.queryRange(ALLOWED, 0, 60, 15), /503/);
  mode = "vector";
  await assert.rejects(prom.queryRange(ALLOWED, 0, 60, 15), /unexpected/);
  mode = "network";
  await assert.rejects(prom.queryRange(ALLOWED, 0, 60, 15), /fetch failed/);
});

test("query() still only uses /api/v1/query", async (t) => {
  const calls = stubFetch(t, () => json({ status: "success", data: { resultType: "vector", result: [] } }));
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  await prom.query(ALLOWED);
  assert.equal(new URL(calls[0].url).pathname, "/api/v1/query");
});

test("allowed can be a function, so the list can follow the registry", async (t) => {
  const calls = stubFetch(t, () => json({ status: "success", data: { resultType: "vector", result: [] } }));
  let current = [ALLOWED];
  const prom = createPrometheus({ allowed: () => current, url: URL_BASE });
  const added = 'up{job="node-registry",server="shop-node"}';
  await assert.rejects(prom.query(added), /allow list/);
  assert.equal(calls.length, 0);
  // A new array object is a new list; the added string is now allowed and the old one still is.
  current = [ALLOWED, added];
  await prom.query(added);
  await prom.query(ALLOWED);
  assert.equal(calls.length, 2);
  // Removing a string takes it out again, and a range query follows the same list.
  current = [ALLOWED];
  await assert.rejects(prom.query(added), /allow list/);
  await assert.rejects(prom.queryRange(added, 0, 60, 15), /allow list/);
  assert.equal(calls.length, 2);
});

test("a function allow list is read on each query but the set is built only when the array changes", async (t) => {
  stubFetch(t, () => json({ status: "success", data: { resultType: "vector", result: [] } }));
  let reads = 0;
  let iterations = 0;
  const list = {
    *[Symbol.iterator]() {
      iterations += 1;
      yield ALLOWED;
    },
  };
  const prom = createPrometheus({ allowed: () => { reads += 1; return list; }, url: URL_BASE });
  await prom.query(ALLOWED);
  await prom.query(ALLOWED);
  await prom.query(ALLOWED);
  assert.equal(reads, 3);
  assert.equal(iterations, 1);
});

test("targets() sends one fixed GET to /api/v1/targets?state=active and returns health and error per job and server", async (t) => {
  const calls = stubFetch(t, () =>
    json({
      status: "success",
      data: {
        activeTargets: [
          { labels: { job: "node-registry", server: "shop-node" }, health: "down", lastError: "connection refused", lastScrape: "2026-11-12T08:00:00Z" },
          { labels: { job: "cadvisor" }, health: "up", lastError: "" },
        ],
      },
    })
  );
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  const rows = await prom.targets();
  assert.deepEqual(rows, [
    { job: "node-registry", server: "shop-node", health: "down", lastError: "connection refused", lastScrape: "2026-11-12T08:00:00Z" },
    { job: "cadvisor", server: "", health: "up", lastError: "", lastScrape: null },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${URL_BASE}/api/v1/targets?state=active`);
  assert.equal(calls[0].init.method, "GET");
  assert.ok(calls[0].init.signal);
});

test("targets() refuses an error status and an unexpected body", async (t) => {
  stubFetch(t, () => json({}, 500));
  const prom = createPrometheus({ allowed: [ALLOWED], url: URL_BASE });
  await assert.rejects(() => prom.targets(), /returned 500/);
  globalThis.fetch = async () => json({ status: "success", data: {} });
  await assert.rejects(() => prom.targets(), /unexpected/);
});
