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
