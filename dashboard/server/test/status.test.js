const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");

// The test clock in helpers.js.
const NOW = Date.UTC(2026, 9, 30, 8, 0, 0);
const MIN = 60000;

// Latest minutes are given newest first, like the real query.
function fakeInflux({ latest = [], open = [], expl = [], fail = false } = {}) {
  const query = async (q) => {
    if (fail) throw new Error("influxdb returned 500");
    if (q.includes('FROM "anomaly_score"')) return latest;
    if (q.includes('FROM "incident_open"')) return open;
    if (q.includes('FROM "incident_explanation"')) return expl;
    return [];
  };
  return { query };
}

async function signedIn(t, query) {
  const app = await startApp({ query });
  t.after(app.close);
  await app.addUser("viewer@example.com", "viewer", "a long enough password");
  const { cookie } = await app.login("viewer@example.com", "a long enough password");
  return (path) => app.request(path, { headers: { cookie } });
}

async function status(t, opts) {
  const get = await signedIn(t, fakeInflux(opts).query);
  const res = await get("/api/status");
  assert.equal(res.status, 200);
  return res.json();
}

const fresh = (extra = {}) => ({ time: NOW - MIN, warmup: 0, early_warning: 0, ...extra });
const openRow = (extra = {}) => ({ time: NOW - 3 * MIN, tier: "medium", peak_score: 0.7, minutes: 2, job: "sample-service", ...extra });

test("GET /api/status needs a session", async (t) => {
  const app = await startApp({ query: fakeInflux().query });
  t.after(app.close);
  assert.equal((await app.request("/api/status")).status, 401);
});

test("normal", async (t) => {
  assert.deepEqual(await status(t, { latest: [fresh()] }), { state: "normal", time: NOW - MIN });
});

test("watching reports the signal and minutes", async (t) => {
  const body = await status(t, { latest: [fresh({ early_warning: 1, ew_signal: "memory", ew_minutes: 14 })] });
  assert.deepEqual(body, { state: "watching", time: NOW - MIN, signal: "memory", minutes: 14 });
});

test("watching without signal data gives nulls", async (t) => {
  const body = await status(t, { latest: [fresh({ early_warning: 1 })] });
  assert.deepEqual(body, { state: "watching", time: NOW - MIN, signal: null, minutes: null });
});

test("incident reports tier, job, start and peak score", async (t) => {
  const body = await status(t, { latest: [fresh()], open: [openRow()] });
  assert.deepEqual(body, { state: "incident", tier: "medium", job: "sample-service", start: NOW - 3 * MIN, peakScore: 0.7 });
});

test("recovering with step 2 of 3", async (t) => {
  const latest = [
    fresh({ warmup: 1 }),
    { time: NOW - 2 * MIN, warmup: 1 },
    { time: NOW - 3 * MIN, warmup: 0 },
    { time: NOW - 4 * MIN, warmup: 0 },
  ];
  assert.deepEqual(await status(t, { latest }), { state: "recovering", time: NOW - MIN, step: 2, of: 3 });
});

test("recovering without a step when the start of the run is not visible", async (t) => {
  const latest = [
    fresh({ warmup: 1 }),
    { time: NOW - 2 * MIN, warmup: 1 },
    { time: NOW - 3 * MIN, warmup: 1 },
    { time: NOW - 4 * MIN, warmup: 1 },
  ];
  assert.deepEqual(await status(t, { latest }), { state: "recovering", time: NOW - MIN });
  // A gap in the minutes also hides the start.
  const gap = [fresh({ warmup: 1 }), { time: NOW - 5 * MIN, warmup: 0 }];
  assert.deepEqual(await status(t, { latest: gap }), { state: "recovering", time: NOW - MIN });
  // A run longer than the assumed warm-up length is not given a step.
  const long = [
    fresh({ warmup: 1 }),
    { time: NOW - 2 * MIN, warmup: 1 },
    { time: NOW - 3 * MIN, warmup: 1 },
    { time: NOW - 4 * MIN, warmup: 1 },
  ].slice(0, 4);
  long.push({ time: NOW - 5 * MIN, warmup: 0 });
  assert.equal((await status(t, { latest: long })).step, undefined);
});

test("incident beats recovering beats watching", async (t) => {
  const both = fresh({ warmup: 1, early_warning: 1, ew_signal: "cpu", ew_minutes: 5 });
  const before = { time: NOW - 2 * MIN, warmup: 0 };
  assert.equal((await status(t, { latest: [both, before], open: [openRow()] })).state, "incident");
  assert.equal((await status(t, { latest: [both, before] })).state, "recovering");
  assert.equal((await status(t, { latest: [fresh({ early_warning: 1 })] })).state, "watching");
});

test("an incident at or before the latest explanation for its job is not open", async (t) => {
  const latest = [fresh()];
  const older = await status(t, { latest, open: [openRow()], expl: [{ time: NOW - 2 * MIN, job: "sample-service" }] });
  assert.equal(older.state, "normal");
  const equal = await status(t, { latest, open: [openRow()], expl: [{ time: NOW - 3 * MIN, job: "sample-service" }] });
  assert.equal(equal.state, "normal");
});

test("an explanation for another job does not close the incident", async (t) => {
  const body = await status(t, { latest: [fresh()], open: [openRow()], expl: [{ time: NOW - MIN, job: "other-service" }] });
  assert.equal(body.state, "incident");
});

test("a newer incident than the explanation is open", async (t) => {
  const body = await status(t, { latest: [fresh()], open: [openRow()], expl: [{ time: NOW - 10 * MIN, job: "sample-service" }] });
  assert.equal(body.state, "incident");
});

test("the newest of several open incidents is reported", async (t) => {
  const open = [openRow({ time: NOW - 2 * MIN, tier: "high", job: "b" }), openRow({ time: NOW - 4 * MIN, tier: "low", job: "a" })];
  const body = await status(t, { latest: [fresh()], open });
  assert.equal(body.tier, "high");
  assert.equal(body.job, "b");
});

test("an incident past its end plus 5 minutes is only awaiting its explanation", async (t) => {
  // Start 10 minutes ago, 2 minutes long: now >= start + 7 minutes.
  const closed = openRow({ time: NOW - 10 * MIN, minutes: 2 });
  assert.equal((await status(t, { latest: [fresh()], open: [closed] })).state, "normal");
  // Exactly at start + (minutes + 5) it counts as closed, one minute earlier it is still open.
  assert.equal((await status(t, { latest: [fresh()], open: [openRow({ time: NOW - 7 * MIN, minutes: 2 })] })).state, "normal");
  assert.equal((await status(t, { latest: [fresh()], open: [openRow({ time: NOW - 6 * MIN, minutes: 2 })] })).state, "incident");
});

test("stale when the latest minute is more than 5 minutes old", async (t) => {
  const old = { time: NOW - 6 * MIN, warmup: 0 };
  assert.deepEqual(await status(t, { latest: [old], open: [openRow({ time: NOW - MIN, minutes: 5 })] }), { state: "stale", time: NOW - 6 * MIN });
  assert.equal((await status(t, { latest: [{ time: NOW - 5 * MIN }] })).state, "normal");
});

test("stale with a null time when there are no rows", async (t) => {
  assert.deepEqual(await status(t, { latest: [] }), { state: "stale", time: null });
});

test("InfluxDB down gives 502", async (t) => {
  const get = await signedIn(t, fakeInflux({ fail: true }).query);
  const res = await get("/api/status");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "influxdb unreachable" });
});
