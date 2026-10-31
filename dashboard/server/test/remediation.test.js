const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { matchRestarts } = require("../remediation");

const T = Date.UTC(2026, 9, 30, 7, 0, 0);
const MIN = 60000;

// A fake InfluxDB that answers the two remediation queries and records every query sent.
function fakeInflux({ restarts = [], open = [], fail = false } = {}) {
  const sent = [];
  const query = async (q) => {
    sent.push(q);
    if (fail) throw new Error("influxdb returned 500");
    if (q.includes('FROM "remediation_action"')) return restarts;
    if (q.includes('FROM "incident_open"')) return open;
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

test("GET /api/remediation needs a session", async (t) => {
  const app = await startApp({ query: fakeInflux().query });
  t.after(app.close);
  assert.equal((await app.request("/api/remediation")).status, 401);
});

test("restarts come back newest first, each with its matching open incident", async (t) => {
  const { query } = fakeInflux({
    restarts: [
      { time: T - 120 * MIN, mode: "approved", job: "sample-service", signal: "memory", minutes: 2, service_up: 1 },
      { time: T, mode: "auto", job: "sample-service", signal: "latency", minutes: 3, service_up: 0 },
    ],
    open: [
      { time: T - 130 * MIN, job: "sample-service", tier: "medium", peak_score: 0.69 },
      { time: T - 10 * MIN, job: "sample-service", tier: "high", peak_score: 0.74 },
    ],
  });
  const get = await signedIn(t, query);
  const res = await get("/api/remediation");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [
    {
      time: T,
      mode: "auto",
      signal: "latency",
      minutes: 3,
      service_up: 0,
      incident: { start: T - 10 * MIN, tier: "high", peak_score: 0.74 },
    },
    {
      time: T - 120 * MIN,
      mode: "approved",
      signal: "memory",
      minutes: 2,
      service_up: 1,
      incident: { start: T - 130 * MIN, tier: "medium", peak_score: 0.69 },
    },
  ]);
});

test("no restarts gives an empty list", async (t) => {
  const get = await signedIn(t, fakeInflux().query);
  const res = await get("/api/remediation");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test("a restart without a matching incident gets incident null", () => {
  const restart = { time: T, mode: "approved", job: "sample-service", signal: "cpu", minutes: 1, service_up: 1 };
  const cases = [
    // Started more than 30 minutes before the restart.
    [{ time: T - 31 * MIN, job: "sample-service", tier: "low" }],
    // Started after the restart.
    [{ time: T + MIN, job: "sample-service", tier: "low" }],
    // Another job.
    [{ time: T - 5 * MIN, job: "other-service", tier: "low" }],
    [],
  ];
  for (const open of cases) {
    assert.equal(matchRestarts([restart], open)[0].incident, null, JSON.stringify(open));
  }
});

test("the closest earlier incident wins, and a start exactly 30 minutes before still matches", () => {
  const restart = { time: T, job: "sample-service" };
  const open = [
    { time: T - 30 * MIN, job: "sample-service", tier: "low" },
    { time: T - 4 * MIN, job: "sample-service", tier: "medium" },
  ];
  assert.equal(matchRestarts([restart], open)[0].incident.tier, "medium");
  assert.equal(matchRestarts([restart], [open[0]])[0].incident.tier, "low");
});

test("InfluxDB down gives 502", async (t) => {
  const get = await signedIn(t, fakeInflux({ fail: true }).query);
  const res = await get("/api/remediation");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "influxdb unreachable" });
});

test("hours defaults to 168, is clamped to 1..720 and must be an integer", async (t) => {
  const influx = fakeInflux();
  const get = await signedIn(t, influx.query);
  const restartQuery = () => influx.sent.filter((q) => q.includes('FROM "remediation_action"')).pop();

  await get("/api/remediation");
  assert.match(restartQuery(), /now\(\) - 168h /);
  await get("/api/remediation?hours=24");
  assert.match(restartQuery(), /now\(\) - 24h /);
  await get("/api/remediation?hours=5000");
  assert.match(restartQuery(), /now\(\) - 720h /);
  await get("/api/remediation?hours=0");
  assert.match(restartQuery(), /now\(\) - 1h /);

  for (const bad of ["abc", "1.5", "24h", "1;DROP"]) {
    const before = influx.sent.length;
    const res = await get(`/api/remediation?hours=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.equal(influx.sent.length, before, `no query for ${bad}`);
  }
});

test("the other range routes keep their 168 hour limit", async (t) => {
  const influx = fakeInflux();
  const get = await signedIn(t, influx.query);
  await get("/api/incidents?hours=720");
  assert.match(influx.sent.find((q) => q.includes('FROM "incident_explanation"')), /now\(\) - 168h /);
});
