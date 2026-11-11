const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { validRunId, computeMttr, computeEvidence, DEPLOYMENTS_QUERY, EXPLANATIONS_QUERY, ACTIONS_QUERY } = require("../evaluation");

const MIN = 60000;
const RUN_NEW = "2026-11-11T04:30:00Z";
const RUN_OLD = "2026-11-09T19:00:00Z";
const SINCE = "2026-11-10T23:00:00Z";
const UNTIL = "2026-11-11T01:59:00Z";
const T0 = Date.parse(SINCE);

function runPoint(runId, extra = {}) {
  return {
    time: Date.parse(runId), run_id: runId, since: SINCE, until: UNTIL, scored_minutes: 180, injections: 4, detected: 3,
    detection_rate: 0.75, flagged_minutes: 5, normal_minutes: 161, false_alarms: 1, false_alarm_rate: 1 / 161,
    top_normal_score: 0.65, p99_normal_score: 0.4, threshold: 0.6, margin: -0.05, ramp_injections: 1,
    warned_before_flag: 1, lead_median_min: 4, lead_max_min: 4, false_ew_minutes: 1, excluded: 0, model: "v11", ...extra,
  };
}

const FAULTS = [
  { time: Date.parse(RUN_NEW), run_id: RUN_NEW, fault: "latency-spike", injections: 1, detected: 0, detection_rate: 0, median_peak_score: 0.5, missed: 1, missed_example: "2026-11-11T00:20:00Z, peak score 0.500" },
  { time: Date.parse(RUN_NEW), run_id: RUN_NEW, fault: "cpu-spike", injections: 2, detected: 2, detection_rate: 1, median_peak_score: 0.69, missed: 0, missed_example: "" },
];
const DAYS = [
  { time: Date.parse("2026-11-10T00:00:00Z"), run_id: RUN_NEW, day: "2026-11-10", scored_minutes: 60, normal_minutes: 46, false_alarms: 0, false_alarm_rate: 0, flagged_minutes: 3, injections: 2 },
];

// A fake InfluxDB for the evaluation queries. It records every query and fails when asked to.
function fakeInflux({ runs = [runPoint(RUN_NEW), runPoint(RUN_OLD, { injections: 9 })], restarts = [], opens = [], deployments = [], explanations = [], actions = [], fail = false, failExtra = false } = {}) {
  const sent = [];
  const query = async (q) => {
    sent.push(q);
    if (fail) throw new Error("influxdb returned 500");
    if (q.includes('FROM "evaluation_run"')) return runs;
    if (q.includes('FROM "evaluation_fault"')) return FAULTS;
    if (q.includes('FROM "evaluation_day"')) return DAYS;
    if (failExtra && /FROM "(remediation_action|incident_open|deployment_event|incident_explanation)"/.test(q)) throw new Error("influxdb returned 500");
    if (q.includes('FROM "remediation_action"')) return q.includes("WHERE time") ? restarts : actions;
    if (q.includes('FROM "incident_open"')) return opens;
    if (q.includes('FROM "deployment_event"')) return deployments;
    if (q.includes('FROM "incident_explanation"')) return explanations;
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

test("GET /api/evaluation needs a session", async (t) => {
  const app = await startApp({ query: fakeInflux().query });
  t.after(app.close);
  assert.equal((await app.request("/api/evaluation")).status, 401);
});

test("without run it returns the latest run, its faults and days, and the list of runs", async (t) => {
  const { query, sent } = fakeInflux();
  const get = await signedIn(t, query);
  const res = await get("/api/evaluation");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run_id, RUN_NEW);
  assert.equal(body.run.injections, 4);
  assert.equal(body.run.detection_rate, 0.75);
  assert.equal(body.run.model, "v11");
  assert.deepEqual(body.runs, [
    { run_id: RUN_NEW, since: SINCE, until: UNTIL, injections: 4 },
    { run_id: RUN_OLD, since: SINCE, until: UNTIL, injections: 9 },
  ]);
  // Most injections first.
  assert.deepEqual(body.faults.map((f) => f.fault), ["cpu-spike", "latency-spike"]);
  assert.equal(body.faults[1].missed_example, "2026-11-11T00:20:00Z, peak score 0.500");
  assert.equal(body.faults[0].missed_example, null);
  assert.equal(body.days.length, 1);
  assert.equal(body.days[0].day, "2026-11-10");
  assert.equal(body.days[0].false_alarm_rate, 0);
  // Only the validated run id reaches the queries, in quotes.
  assert.ok(sent.includes(`SELECT * FROM "evaluation_fault" WHERE "run_id" = '${RUN_NEW}'`));
  assert.ok(sent.includes(`SELECT * FROM "evaluation_day" WHERE "run_id" = '${RUN_NEW}' ORDER BY time ASC`));
});

test("run picks that run and uses its id in the queries", async (t) => {
  const { query, sent } = fakeInflux();
  const get = await signedIn(t, query);
  const res = await get(`/api/evaluation?run=${RUN_OLD}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run_id, RUN_OLD);
  assert.equal(body.run.injections, 9);
  assert.equal(body.runs.length, 2);
  assert.ok(sent.includes(`SELECT * FROM "evaluation_fault" WHERE "run_id" = '${RUN_OLD}'`));
});

test("a run that is not stored is a 404", async (t) => {
  const get = await signedIn(t, fakeInflux().query);
  const res = await get("/api/evaluation?run=2026-01-01T00:00:00Z");
  assert.equal(res.status, 404);
});

test("a bad run is a 400 and sends no query", async (t) => {
  const { query, sent } = fakeInflux();
  const get = await signedIn(t, query);
  const bad = [
    "yesterday",
    "2026-11-11",
    "2026-11-11T04:30:00",
    "2026-11-11T04:30:00.000Z",
    "2026-13-45T04:30:00Z",
    "2026-02-30T04:30:00Z",
    encodeURIComponent("2026-11-11T04:30:00Z' OR 1=1 --"),
    encodeURIComponent('2026-11-11T04:30:00Z"; DROP'),
    "",
  ];
  for (const run of bad) {
    const res = await get(`/api/evaluation?run=${run}`);
    assert.equal(res.status, 400, `run=${run}`);
  }
  // An array (run twice) is not a string either.
  assert.equal((await get(`/api/evaluation?run=${RUN_NEW}&run=${RUN_OLD}`)).status, 400);
  assert.deepEqual(sent, []);
});

test("no stored run is a 404", async (t) => {
  const get = await signedIn(t, fakeInflux({ runs: [] }).query);
  const res = await get("/api/evaluation");
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no saved report/);
});

test("InfluxDB down is a 502", async (t) => {
  const get = await signedIn(t, fakeInflux({ fail: true }).query);
  const res = await get("/api/evaluation");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "influxdb unreachable" });
});

test("MTTR is the median minutes from incident_open to a restart that worked, with the count", async (t) => {
  const { query, sent } = fakeInflux({
    opens: [
      { time: T0 + 10 * MIN, job: "sample-service", tier: "medium", peak_score: 0.7 },
      { time: T0 + 60 * MIN, job: "sample-service", tier: "medium", peak_score: 0.7 },
      { time: T0 + 100 * MIN, job: "sample-service", tier: "medium", peak_score: 0.7 },
      { time: T0 + 140 * MIN, job: "sample-service", tier: "high", peak_score: 0.7 },
    ],
    restarts: [
      { time: T0 + 14 * MIN, action: "restart", mode: "approved", outcome: "success", job: "sample-service", service_up: 1 },
      { time: T0 + 66 * MIN, action: "restart", mode: "auto", outcome: "success", job: "sample-service", service_up: 1 },
      // Did not come back, never counted.
      { time: T0 + 103 * MIN, action: "restart", mode: "auto", outcome: "failed", job: "sample-service", service_up: 0 },
      // A success without service_up 1 is not counted either.
      { time: T0 + 143 * MIN, action: "rollback", mode: "auto", outcome: "success", job: "sample-service", service_up: 0 },
    ],
  });
  const get = await signedIn(t, query);
  const body = await (await get("/api/evaluation")).json();
  // One approved (4 min) and one automatic (6 min) restart worked: the median is 5 min, 300 s.
  assert.deepEqual(body.mttr, { median_minutes: 5, median_seconds: 300, count: 2, approved: 1, automatic: 1 });
  // Of the four actions that ran in the period, two brought the service back.
  assert.deepEqual(body.remediation, { ran: 4, worked: 2 });
  // The queries cover the run period; actions may follow their incident by up to 30 minutes.
  assert.ok(sent.some((q) => q.includes('FROM "incident_open"') && q.includes(`time >= '${SINCE.replace("Z", ".000Z")}'`) && q.includes(`time <= '${UNTIL.replace("Z", ".000Z")}'`)));
  assert.ok(sent.some((q) => q.includes('FROM "remediation_action"') && q.includes("2026-11-11T02:29:00.000Z")));
});

test("MTTR has no value and a count of 0 when nothing worked", async (t) => {
  const get = await signedIn(t, fakeInflux().query);
  const body = await (await get("/api/evaluation")).json();
  assert.deepEqual(body.mttr, { median_minutes: null, median_seconds: null, count: 0, approved: 0, automatic: 0 });
  assert.deepEqual(body.remediation, { ran: 0, worked: 0 });
});

test("the saved report still comes back when the MTTR and objectives queries fail", async (t) => {
  const get = await signedIn(t, fakeInflux({ failExtra: true }).query);
  const res = await get("/api/evaluation");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run_id, RUN_NEW);
  assert.equal(body.mttr, null);
  assert.equal(body.remediation, null);
  assert.equal(body.evidence, null);
});

test("MTTR counts only medium and high incidents, and remediation success leaves out skips and actions after the period", async (t) => {
  const { query } = fakeInflux({
    opens: [
      { time: T0 + 10 * MIN, job: "sample-service", tier: "low", peak_score: 0.66 },
      { time: T0 + 60 * MIN, job: "sample-service", tier: "high", peak_score: 0.7 },
    ],
    restarts: [
      // A low incident never counts for MTTR (Chapter 3, E3: Medium and High tiers).
      { time: T0 + 11 * MIN, action: "restart", mode: "auto", outcome: "success", job: "sample-service", service_up: 1 },
      { time: T0 + 61 * MIN, action: "rollback", mode: "approved", outcome: "success", job: "sample-service", service_up: 1 },
      // Skipped and expired requests did not run.
      { time: T0 + 62 * MIN, action: "rollback", mode: "skipped", outcome: "skipped_cooldown", job: "sample-service", service_up: 0 },
      { time: T0 + 63 * MIN, action: "restart", mode: "expired", outcome: "expired", job: "sample-service", service_up: 0 },
      // After the period ends: matched for MTTR but not counted for the success rate.
      { time: Date.parse(UNTIL) + 5 * MIN, action: "restart", mode: "auto", outcome: "failed", job: "sample-service", service_up: 0 },
    ],
  });
  const get = await signedIn(t, query);
  const body = await (await get("/api/evaluation")).json();
  assert.deepEqual(body.mttr, { median_minutes: 1, median_seconds: 60, count: 1, approved: 1, automatic: 0 });
  assert.deepEqual(body.remediation, { ran: 2, worked: 2 });
});

test("evidence counts CI deployments, explanations and the actions that ran", async (t) => {
  const { query } = fakeInflux({
    // COUNT answers: one row with a count column.
    deployments: [{ time: 0, count: 2 }],
    explanations: [{ time: 0, count: 1 }],
    actions: [
      { time: 1, action: "restart", mode: "auto", outcome: "success", service_up: 1 },
      { time: 2, action: "restart", mode: "approved", outcome: "failed", service_up: 0 },
      { time: 3, action: "rollback", mode: "approved", outcome: "success", service_up: 1 },
      { time: 4, action: "restart", mode: "expired", outcome: "expired" },
    ],
  });
  const get = await signedIn(t, query);
  const body = await (await get("/api/evaluation")).json();
  assert.deepEqual(body.evidence, { ci_deployments: 2, explanations: 1, actions: { ran: 3, restart_worked: 1, rollback_worked: 1 } });
});

test("a field missing from a stored point comes back as null, never invented", async (t) => {
  const { query } = fakeInflux({ runs: [{ time: Date.parse(RUN_NEW), run_id: RUN_NEW, since: SINCE, until: UNTIL, injections: 0, scored_minutes: 10 }] });
  const get = await signedIn(t, query);
  const body = await (await get("/api/evaluation")).json();
  assert.equal(body.run.detection_rate, null);
  assert.equal(body.run.lead_median_min, null);
  assert.equal(body.run.threshold, null);
  assert.equal(body.run.model, null);
});

test("validRunId accepts the script's format only", () => {
  assert.equal(validRunId("2026-11-11T04:30:00Z"), true);
  assert.equal(validRunId("2026-11-11T04:30:00+00:00"), false);
  assert.equal(validRunId("2026-02-29T04:30:00Z"), false);
  assert.equal(validRunId(undefined), false);
  assert.equal(validRunId(["2026-11-11T04:30:00Z"]), false);
});

test("computeMttr counts an incident once, by its first action that worked", () => {
  const opens = [{ time: 0, job: "j", tier: "medium" }];
  const rows = [
    { time: 6 * MIN, mode: "auto", outcome: "success", service_up: 1, job: "j" },
    { time: 4 * MIN, mode: "approved", outcome: "success", service_up: 1, job: "j" },
  ];
  assert.deepEqual(computeMttr(rows, opens), { median_minutes: 4, median_seconds: 240, count: 1, approved: 1, automatic: 0 });
  assert.deepEqual(computeMttr([], []), { median_minutes: null, median_seconds: null, count: 0, approved: 0, automatic: 0 });
  // An incident without a tier is not Medium or High, so it is not counted.
  assert.equal(computeMttr(rows, [{ time: 0, job: "j" }]).count, 0);
});

test("the objectives queries are counts or bounded", () => {
  assert.equal(DEPLOYMENTS_QUERY, 'SELECT COUNT("commit_sha") FROM "deployment_event" WHERE "source" = \'ci\'');
  assert.equal(EXPLANATIONS_QUERY, 'SELECT COUNT("end_time") FROM "incident_explanation"');
  assert.match(ACTIONS_QUERY, /^SELECT .* FROM "remediation_action" ORDER BY time DESC LIMIT \d+$/);
});

test("a run older than the picker list is read by its id and added to the list", async (t) => {
  const old = runPoint(RUN_OLD, { injections: 9 });
  const sent = [];
  const query = async (q) => {
    sent.push(q);
    if (q === `SELECT * FROM "evaluation_run" WHERE "run_id" = '${RUN_OLD}'`) return [old];
    if (q.includes('FROM "evaluation_run"')) return [runPoint(RUN_NEW)];
    return [];
  };
  const get = await signedIn(t, query);
  const res = await get(`/api/evaluation?run=${RUN_OLD}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run_id, RUN_OLD);
  assert.deepEqual(body.runs.map((r) => r.run_id), [RUN_NEW, RUN_OLD]);
  assert.ok(sent.includes(`SELECT * FROM "evaluation_fault" WHERE "run_id" = '${RUN_OLD}'`));
});

test("computeEvidence handles empty lists", () => {
  assert.deepEqual(computeEvidence([], [], []), { ci_deployments: 0, explanations: 0, actions: { ran: 0, restart_worked: 0, rollback_worked: 0 } });
});
