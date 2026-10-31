const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { MLFLOW_URL, ENDPOINTS } = require("../mlflow");
const { RULES } = require("../model");

const T = Date.UTC(2026, 9, 30, 7, 0, 0);

function mv(version, { f1, run = "abcdef1234567890" } = {}) {
  const tags = f1 === undefined ? [] : [{ key: "test_f1", value: String(f1) }];
  return { name: "anomaly-detector", version: String(version), creation_timestamp: String(T - (20 - version) * 86400000), run_id: run, tags };
}

// Answers the three MLflow endpoints on the default URL; other requests go to the real fetch.
function stubMlflow(t, { down = false, versions = 10, noPrevious = false } = {}) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(MLFLOW_URL)) return original(url, init);
    const u = new URL(href);
    sent.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), method: init && init.method });
    if (down) throw new TypeError("fetch failed");
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const all = Array.from({ length: versions }, (_, i) => mv(i + 1, { f1: i + 1 === 7 ? undefined : 0.8 + i / 1000 }));
    if (u.pathname === ENDPOINTS.model) {
      const aliases = [{ alias: "champion", version: "10" }];
      if (!noPrevious) aliases.push({ alias: "previous", version: "9" });
      return json({ registered_model: { name: "anomaly-detector", aliases } });
    }
    if (u.pathname === ENDPOINTS.alias) {
      const alias = u.searchParams.get("alias");
      if (alias === "previous" && noPrevious) return json({ error_code: "RESOURCE_DOES_NOT_EXIST" }, 404);
      return json({ model_version: alias === "champion" ? all[9] : all[8] });
    }
    if (u.pathname === ENDPOINTS.search) return json({ model_versions: all });
    return json({}, 404);
  };
  t.after(() => { globalThis.fetch = original; });
  return sent;
}

function fakeInflux({ down = false } = {}) {
  const sent = [];
  const query = async (q) => {
    sent.push(q);
    if (down) throw new Error("influxdb returned 500");
    if (q.startsWith("SHOW TAG VALUES")) {
      return [{ key: "model", value: "v9" }, { key: "model", value: "v10" }, { key: "model", value: "bad'tag" }];
    }
    if (q.includes(`"model" = 'v10'`)) return [{ time: T, last: 0.602 }];
    if (q.includes(`"model" = 'v9'`)) return [{ time: T - 86400000, last: 0.611 }];
    if (q.includes('FROM "model_retrain"')) {
      return [{ time: T - 3600000, job: "sample-service", promoted: 0, new_version: "", champion_version: "10", champion_f1: 0.8072, challenger_f1: 0.8144, reason: "challenger 0.814 does not beat champion 0.807 by 0.01" }];
    }
    return [];
  };
  return { query, sent };
}

async function signedIn(t, query) {
  const app = await startApp({ query });
  t.after(app.close);
  await app.addUser("viewer@example.com", "viewer", "a long enough password");
  const { cookie } = await app.login("viewer@example.com", "a long enough password");
  return (path) => app.request(path, { headers: { cookie } });
}

test("GET /api/model needs a session", async (t) => {
  stubMlflow(t);
  const app = await startApp({ query: fakeInflux().query });
  t.after(app.close);
  assert.equal((await app.request("/api/model")).status, 401);
});

test("normal: champion, previous, newest 8 versions, thresholds, last retraining and rules", async (t) => {
  const sent = stubMlflow(t);
  const influx = fakeInflux();
  const get = await signedIn(t, influx.query);
  const res = await get("/api/model?name=evil&alias=evil");
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.champion, {
    version: "10",
    createdAt: T - 10 * 86400000,
    testF1: 0.809,
    runId: "abcdef12",
    aliases: ["champion"],
  });
  assert.equal(body.previous.version, "9");
  assert.deepEqual(body.previous.aliases, ["previous"]);
  assert.deepEqual(body.versions.map((v) => v.version), ["10", "9", "8", "7", "6", "5", "4", "3"]);
  assert.deepEqual(body.thresholds, [
    { model: "v10", version: "10", threshold: 0.602, lastSeen: T },
    { model: "v9", version: "9", threshold: 0.611, lastSeen: T - 86400000 },
  ]);
  assert.equal(body.lastRetrain.champion_f1, 0.8072);
  assert.equal(body.lastRetrain.reason, "challenger 0.814 does not beat champion 0.807 by 0.01");
  assert.deepEqual(body.rules, RULES);
  assert.equal(body.mlflowOk, true);
  assert.equal(body.influxOk, true);

  // Only GET, only the three endpoints, fixed parameters whatever the request said.
  for (const call of sent) {
    assert.equal(call.method, "GET");
    assert.ok(Object.values(ENDPOINTS).includes(call.path), call.path);
    assert.equal(call.params.name ?? "anomaly-detector", "anomaly-detector");
    if (call.params.alias) assert.ok(["champion", "previous"].includes(call.params.alias));
  }
  // A malformed tag value is never put into a query.
  assert.ok(!influx.sent.some((q) => q.includes("bad'tag")));
});

test("a version without the test_f1 tag gets testF1 null", async (t) => {
  stubMlflow(t);
  const get = await signedIn(t, fakeInflux().query);
  const body = await (await get("/api/model")).json();
  const v7 = body.versions.find((v) => v.version === "7");
  assert.equal(v7.testF1, null);
  assert.equal(v7.createdAt, T - 13 * 86400000);
});

test("no previous alias yet gives previous null", async (t) => {
  stubMlflow(t, { noPrevious: true });
  const get = await signedIn(t, fakeInflux().query);
  const body = await (await get("/api/model")).json();
  assert.equal(body.previous, null);
  assert.equal(body.champion.version, "10");
});

test("MLflow down: registry fields are null, InfluxDB data still returned", async (t) => {
  stubMlflow(t, { down: true });
  const get = await signedIn(t, fakeInflux().query);
  const res = await get("/api/model");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.champion, null);
  assert.equal(body.previous, null);
  assert.equal(body.versions, null);
  assert.equal(body.thresholds.length, 2);
  assert.equal(body.lastRetrain.champion_version, "10");
  assert.equal(body.mlflowOk, false);
});

test("InfluxDB down: thresholds and lastRetrain are null, registry still returned", async (t) => {
  stubMlflow(t);
  const get = await signedIn(t, fakeInflux({ down: true }).query);
  const res = await get("/api/model");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.thresholds, null);
  assert.equal(body.lastRetrain, null);
  assert.equal(body.champion.version, "10");
  assert.equal(body.versions.length, 8);
  assert.equal(body.influxOk, false);
});

test("both down gives 502", async (t) => {
  stubMlflow(t, { down: true });
  const get = await signedIn(t, fakeInflux({ down: true }).query);
  const res = await get("/api/model");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "mlflow and influxdb unreachable" });
});
