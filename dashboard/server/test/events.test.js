const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { matchRestarts } = require("../remediation");
const { outcomeOf, familyOf, buildEvents, MAX_EVENTS } = require("../events");

const NOW = Date.UTC(2026, 9, 30, 8, 0, 0);
const MIN = 60000;

// A fake InfluxDB that answers each events query by measurement and records every query sent.
function fakeInflux({ rows = {}, fail = [] } = {}) {
  const sent = [];
  const query = async (q) => {
    sent.push(q);
    for (const name of Object.keys(rows)) {
      if (q.includes(`FROM "${name}"`)) {
        if (fail.includes(name)) throw new Error("influxdb returned 500");
        return rows[name];
      }
    }
    if (fail === "all") throw new Error("influxdb returned 500");
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

const MEASUREMENTS = ["deployment_event", "model_retrain", "early_warning", "incident_open", "remediation_action"];

test("GET /api/events needs a session", async (t) => {
  const app = await startApp({ query: fakeInflux().query });
  t.after(app.close);
  assert.equal((await app.request("/api/events")).status, 401);
});

test("a mixed response is sorted by time with kinds, labels and details", async (t) => {
  const { query } = fakeInflux({
    rows: {
      deployment_event: [
        { time: NOW - 50 * MIN, commit_sha: "cc34d10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "master", pipeline_run_id: "123", source: "ci" },
      ],
      model_retrain: [
        { time: NOW - 40 * MIN, promoted: 1, new_version: "11", champion_version: "10" },
        { time: NOW - 20 * MIN, promoted: 0, new_version: "12", champion_version: "11" },
      ],
      early_warning: [{ time: NOW - 30 * MIN, signal: "memory", minutes_to_threshold: 12.5 }],
      incident_open: [{ time: NOW - 25 * MIN, tier: "medium", peak_score: 0.71, job: "sample-service" }],
      remediation_action: [
        { time: NOW - 10 * MIN, action: "restart", mode: "auto", service_up: 1, job: "sample-service" },
        { time: NOW - 5 * MIN, action: "rollback", mode: "approved", outcome: "failed", service_up: 0 },
        { time: NOW - 2 * MIN, mode: "skipped", outcome: "skipped_cooldown" },
      ],
    },
  });
  const get = await signedIn(t, query);
  const res = await get("/api/events");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.unavailable, []);
  assert.deepEqual(body.events.map((e) => [e.kind, e.label]), [
    ["deploy", "Deployment cc34d10"],
    ["retrain", "Retraining promoted v11"],
    ["early_warning", "Early warning, memory"],
    ["incident", "Incident, medium"],
    ["retrain", "Retraining kept v11"],
    ["action", "Restart, worked"],
    ["action", "Rollback, failed"],
    ["action", "Restart, not run (skipped_cooldown)"],
  ]);
  assert.deepEqual(body.events[0], {
    time: NOW - 50 * MIN,
    kind: "deploy",
    label: "Deployment cc34d10",
    detail: { commit: "cc34d10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortCommit: "cc34d10", branch: "master", runId: "123" },
  });
  assert.deepEqual(body.events[1].detail, { promoted: true, newVersion: "v11", championVersion: "v10" });
  assert.deepEqual(body.events[2].detail, { signal: "memory", minutes: 12.5 });
  assert.deepEqual(body.events[3].detail, { tier: "medium", peakScore: 0.71, job: "sample-service" });
  assert.deepEqual(body.events[5].detail, { action: "restart", mode: "auto", outcome: "success", family: "worked" });
  assert.deepEqual(body.events[7].detail, { action: "restart", mode: "skipped", outcome: "skipped_cooldown", family: "not_run" });
});

test("missing values are null, never guessed", () => {
  const { events } = buildEvents({
    deploy: [{ time: NOW, source: "ci" }],
    warning: [{ time: NOW + 1 }],
    incident: [{ time: NOW + 2 }],
  });
  assert.deepEqual(events[0].detail, { commit: null, shortCommit: null, branch: null, runId: null });
  assert.deepEqual(events[1].detail, { signal: null, minutes: null });
  assert.deepEqual(events[2].detail, { tier: null, peakScore: null, job: null });
});

test("simulated deployments are never returned", () => {
  const { events } = buildEvents({
    deploy: [
      { time: NOW - MIN, commit_sha: "aaaaaaa1", source: "simulated" },
      { time: NOW, commit_sha: "bbbbbbb2", source: "ci" },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.shortCommit, "bbbbbbb");
});

test("the cap is 2000 events", () => {
  assert.equal(MAX_EVENTS, 2000);
});

test("at the cap nothing is dropped and truncated is false", () => {
  const incident = [];
  for (let i = 0; i < MAX_EVENTS; i++) incident.push({ time: NOW + i * MIN, tier: "low" });
  const { events, truncated } = buildEvents({ incident });
  assert.equal(events.length, MAX_EVENTS);
  assert.equal(truncated, false);
});

test("over the cap the newest are kept and truncated is true", () => {
  const incident = [];
  for (let i = 0; i < MAX_EVENTS + 50; i++) incident.push({ time: NOW + i * MIN, tier: "low" });
  const { events, truncated } = buildEvents({ incident });
  assert.equal(truncated, true);
  assert.equal(events.length, MAX_EVENTS);
  assert.equal(events[0].time, NOW + 50 * MIN);
  assert.equal(events[MAX_EVENTS - 1].time, NOW + (MAX_EVENTS + 49) * MIN);
});

test("over the cap the oldest incidents and actions go first, never deployments, retrains or warnings", () => {
  // The rare kinds are the oldest rows, so a plain newest-first cut would drop them.
  const deploy = [{ time: NOW, commit_sha: "aaaaaaa1", source: "ci" }];
  const retrain = [{ time: NOW + MIN, promoted: 0, champion_version: "3" }];
  const warning = [{ time: NOW + 2 * MIN, signal: "memory" }];
  const incident = [];
  const action = [];
  for (let i = 0; i < 1500; i++) {
    incident.push({ time: NOW + (10 + 2 * i) * MIN, tier: "medium" });
    action.push({ time: NOW + (11 + 2 * i) * MIN, mode: "skipped", outcome: "skipped_cooldown" });
  }
  const { events, truncated } = buildEvents({ deploy, retrain, warning, incident, action });
  assert.equal(truncated, true);
  assert.equal(events.length, MAX_EVENTS);
  assert.deepEqual(events.slice(0, 3).map((e) => e.kind), ["deploy", "retrain", "early_warning"]);
  // 3000 incidents and actions compete for the 1997 places left: the newest 1997 stay.
  const rest = events.slice(3);
  assert.equal(rest.length, 1997);
  assert.equal(rest[rest.length - 1].time, NOW + (11 + 2 * 1499) * MIN);
  assert.equal(rest[0].time, NOW + (10 + 3000 - 1997) * MIN);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].time >= events[i - 1].time);
});

test("the response has truncated: true only when events were dropped", async (t) => {
  const incident_open = [];
  for (let i = 0; i < MAX_EVENTS + 1; i++) incident_open.push({ time: NOW - i * 1000, tier: "low" });
  let get = await signedIn(t, fakeInflux({ rows: { incident_open } }).query);
  let body = await (await get("/api/events")).json();
  assert.equal(body.truncated, true);
  assert.equal(body.events.length, MAX_EVENTS);

  get = await signedIn(t, fakeInflux({ rows: { incident_open: incident_open.slice(0, 5) } }).query);
  body = await (await get("/api/events")).json();
  assert.equal(body.truncated, undefined);
  assert.equal(body.events.length, 5);
});

test("one failed source leaves its events out and is named in unavailable", async (t) => {
  const { query } = fakeInflux({
    rows: {
      model_retrain: [{ time: NOW, promoted: 1, new_version: "3" }],
      incident_open: [{ time: NOW - MIN, tier: "low" }],
    },
    fail: ["model_retrain"],
  });
  const get = await signedIn(t, query);
  const res = await get("/api/events");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.unavailable, ["retraining"]);
  assert.deepEqual(body.events.map((e) => e.kind), ["incident"]);
});

test("every source failing gives 502", async (t) => {
  const { query } = fakeInflux({ rows: {}, fail: "all" });
  const get = await signedIn(t, query);
  const res = await get("/api/events");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "influxdb unreachable" });
});

test("bad hours gives 400 and no query is sent", async (t) => {
  const influx = fakeInflux();
  const get = await signedIn(t, influx.query);
  for (const bad of ["abc", "1.5", "24h", "1;DROP"]) {
    const res = await get(`/api/events?hours=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
  }
  assert.equal(influx.sent.length, 0);
});

test("only the validated integer hours appears in the queries", async (t) => {
  const influx = fakeInflux();
  const get = await signedIn(t, influx.query);
  await get("/api/events?hours=6");
  assert.deepEqual(influx.sent.sort(), [
    'SELECT "action","mode","outcome","service_up","job" FROM "remediation_action" WHERE time > now() - 6h ORDER BY time ASC',
    'SELECT "commit_sha","branch","pipeline_run_id","source" FROM "deployment_event" WHERE "source" = \'ci\' AND time > now() - 6h ORDER BY time ASC',
    'SELECT "promoted","new_version","champion_version" FROM "model_retrain" WHERE time > now() - 6h ORDER BY time ASC',
    'SELECT "signal","minutes_to_threshold" FROM "early_warning" WHERE time > now() - 6h ORDER BY time ASC',
    'SELECT "tier","peak_score","job" FROM "incident_open" WHERE time > now() - 6h ORDER BY time ASC',
  ].sort());
  influx.sent.length = 0;
  await get("/api/events?hours=9999");
  assert.ok(influx.sent.every((q) => q.includes("now() - 168h ")));
  assert.equal(MEASUREMENTS.length, 5);
});

test("outcomeOf gives the same outcome as remediation.js", () => {
  const rows = [
    { outcome: "success", mode: "auto", service_up: 0 },
    { outcome: "expired", mode: "expired" },
    { outcome: "skipped_cooldown", mode: "skipped" },
    { mode: "auto", service_up: 1 },
    { mode: "auto", service_up: 0 },
    { mode: "approved", service_up: 1 },
    { mode: "approved", service_up: 0 },
    { mode: "approved" },
    { mode: "rejected" },
    { mode: "expired", service_up: 1 },
    { outcome: "", mode: "", service_up: "" },
    { outcome: "", mode: "auto", service_up: 1 },
    { outcome: "", mode: "rejected" },
    {},
  ];
  const expected = matchRestarts(rows.map((r, i) => ({ ...r, time: NOW - i * MIN })), []);
  // matchRestarts sorts newest first, which is the input order here.
  rows.forEach((r, i) => assert.equal(outcomeOf(r), expected[i].outcome, JSON.stringify(r)));
});

test("outcome families", () => {
  assert.equal(familyOf("success"), "worked");
  assert.equal(familyOf("failed"), "failed");
  for (const o of ["expired", "rejected", "skipped_cooldown", null, undefined]) {
    assert.equal(familyOf(o), "not_run", String(o));
  }
});
