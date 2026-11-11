const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { buildSteps, parseParams, windowOf, incidentEnd, ownActions } = require("../timeline");

const MIN = 60000;
// The test app's clock starts at this time (see helpers.js).
const NOW = Date.UTC(2026, 9, 30, 8, 0, 0);
const START = NOW - 2 * 60 * MIN;
const JOB = "sample-service";

function score(offsetMin, extra) {
  return {
    time: START + offsetMin * MIN, score: 0.3, threshold: 0.6, is_anomaly: 0, tier: "none", signal: null,
    warmup: 0, early_warning: 0, ...extra,
  };
}

function flagged(offsetMin, extra) {
  return score(offsetMin, { score: 0.684, is_anomaly: 1, tier: "medium", signal: "memory", ...extra });
}

// Minutes -5 .. 12 with a flagged pair at 0 and 1, then quiet minutes.
function scores(extra = {}) {
  const rows = [];
  for (let m = -5; m <= 12; m++) rows.push(score(m, extra[m]));
  rows[5] = flagged(0);
  rows[6] = flagged(1);
  return rows;
}

const open = (extra) => ({ time: START, tier: "medium", action: "restart", minutes: 2, deployment: 0, ...extra });
const kinds = (steps) => steps.map((s) => s.kind);

test("windowOf runs from 30 min before the start to 20 min after the end, capped at start plus 6 h", () => {
  assert.deepEqual(windowOf(START, START + 5 * MIN), { from: START - 30 * MIN, to: START + 25 * MIN, end: START + 5 * MIN });
  assert.equal(windowOf(START, START + 1000 * MIN).to, START + 6 * 60 * MIN);
  assert.equal(windowOf(START, START + 340 * MIN).to, START + 6 * 60 * MIN);
  assert.equal(windowOf(START, START + 339 * MIN).to, START + 359 * MIN);
});

test("incidentEnd uses the stored end_time, else the last flag before the next incident, else the flagged minutes", () => {
  const flags = [flagged(0), flagged(1), flagged(40), flagged(95), flagged(130), score(140, { is_anomaly: 1, warmup: 1 })];
  // The explanation's end_time wins.
  const iso = new Date(START + 50 * MIN).toISOString();
  assert.equal(incidentEnd(START, 2, { time: START, end_time: iso }, flags, null), START + 50 * MIN);
  // Without it, the last flagged minute; warm-up minutes are never flags.
  assert.equal(incidentEnd(START, 2, null, flags, null), START + 130 * MIN);
  // A later incident_open for the same job ends the search.
  assert.equal(incidentEnd(START, 2, null, flags, START + 100 * MIN), START + 95 * MIN);
  // An end_time that is not a date is ignored; flags before the start are not counted.
  assert.equal(incidentEnd(START, 2, { end_time: "soon" }, [flagged(-3), flagged(1)], null), START + MIN);
  // No flags at all: start plus the flagged minutes.
  assert.equal(incidentEnd(START, 3, null, [], null), START + 3 * MIN);
});

test("ownActions keeps only the actions matched to this incident", () => {
  const opens = [{ time: START }, { time: START + 20 * MIN }];
  const actions = [
    { time: START + 5 * MIN, action: "restart", mode: "approved", outcome: "success", service_up: 1 },
    { time: START + 25 * MIN, action: "restart", mode: "expired", outcome: "expired" },
    { time: START + 26 * MIN, action: "rollback", mode: "skipped", outcome: "skipped_no_deployment" },
    // Before both incidents, so it answers neither.
    { time: START - 10 * MIN, action: "restart", mode: "expired", outcome: "expired" },
  ];
  assert.deepEqual(ownActions(actions, opens, START, JOB).map((a) => a.time), [START + 5 * MIN]);
  assert.deepEqual(ownActions(actions, opens, START + 20 * MIN, JOB).map((a) => a.time), [START + 25 * MIN, START + 26 * MIN]);
  // The open-row tolerance applies: a stored start 60 s off still owns its actions.
  assert.deepEqual(ownActions(actions, [{ time: START + MIN }], START, JOB).map((a) => a.time), [START + 5 * MIN, START + 25 * MIN, START + 26 * MIN]);
  assert.deepEqual(ownActions([], opens, START, JOB), []);
});

test("a full incident gives every step in time order", () => {
  const rows = scores({ 3: { warmup: 1 }, 4: { warmup: 1 }, 5: { warmup: 1 } });
  const steps = buildSteps(open(), {
    scores: rows,
    warning: { time: START - 5 * MIN, signal: "memory", minutes_to_threshold: 4.6 },
    actions: [{ time: START + 3 * MIN, action: "restart", mode: "approved", outcome: "success", service_up: 1 }],
    explanation: { time: START, source: "llm", attempts: 1 },
  });
  assert.deepEqual(kinds(steps), ["early_warning", "first_flag", "incident_open", "action", "warmup", "incident_closed", "explanation", "rollback_not_run"]);
  const times = steps.filter((s) => s.time !== null).map((s) => s.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  for (const s of steps) assert.deepEqual(Object.keys(s), ["time", "kind", "title", "detail", "source", "family"]);

  const [warn, first, opened, action, warm, closed, expl, roll] = steps;
  assert.equal(warn.detail, "Memory rising, about 5 min to its flag level. Watch only, nothing was started.");
  assert.equal(warn.family, "warn");
  assert.equal(warn.time, START - 5 * MIN);
  assert.equal(first.time, START);
  assert.equal(first.detail, "Score 0.684 above the 0.600 threshold. Signal memory, tier medium.");
  assert.equal(first.family, "flag");
  assert.equal(opened.detail, "Medium, restart planned.");
  assert.equal(opened.family, "flag");
  assert.equal(action.title, "Approved");
  assert.equal(action.family, "worked");
  assert.match(action.detail, /restarted/);
  assert.match(action.detail, /Back up 60 s later\./);
  assert.equal(warm.title, "Warm-up, 3 minutes");
  assert.equal(warm.family, "warmup");
  assert.equal(warm.time, START + 3 * MIN);
  assert.equal(closed.time, START + 5 * MIN);
  assert.equal(closed.detail, "4 quiet minutes after the last flag.");
  assert.equal(expl.detail, "Written by the local LLM, accepted at the first attempt.");
  assert.equal(expl.time, null);
  assert.equal(roll.title, "Rollback not run");
  assert.equal(roll.family, "not_run");
  assert.equal(roll.time, null);
});

test("an early warning steps count minutes, a missing signal and a missing eta", () => {
  const w = (extra) => buildSteps(open(), { scores: [], actions: [], warning: { time: START - MIN, ...extra } })[0];
  assert.equal(w({ signal: "latency", minutes_to_threshold: 1 }).detail, "Latency rising, about 1 min to its flag level. Watch only, nothing was started.");
  assert.equal(w({}).detail, "A signal rising towards its flag level. Watch only, nothing was started.");
  assert.match(w({ signal: "cpu", minutes_to_threshold: 7.4 }).detail, /^CPU rising, about 7 min/);
});

test("steps are left out when their data is missing", () => {
  const steps = buildSteps(open({ tier: null, action: null }), { scores: [], actions: [], warning: null, explanation: null });
  assert.deepEqual(kinds(steps), ["incident_open", "rollback_not_run"]);
  assert.equal(steps[0].detail, "An incident was recorded.");
});

test("the first flagged minute is taken from 2 minutes before the start and not from warm-up", () => {
  const rows = [flagged(-3), flagged(-2, { score: 0.7 }), flagged(0, { warmup: 1 })];
  const first = buildSteps(open(), { scores: rows }).find((s) => s.kind === "first_flag");
  assert.equal(first.time, START - 2 * MIN);
  assert.match(first.detail, /^Score 0\.700 /);
  assert.equal(buildSteps(open(), { scores: [flagged(-3), flagged(0, { warmup: 1 })] }).some((s) => s.kind === "first_flag"), false);
});

test("no closed step until a scored minute shows the four quiet minutes have passed", () => {
  const short = [flagged(0), flagged(1), score(2), score(3), score(4)];
  assert.equal(buildSteps(open(), { scores: short }).some((s) => s.kind === "incident_closed"), false);
  assert.equal(buildSteps(open(), { scores: [] }).some((s) => s.kind === "incident_closed"), false);
});

test("the explainer closes on the clock, so a missing minute or a later incident does not keep it open", () => {
  const closedOf = (rows) => buildSteps(open(), { scores: rows }).find((s) => s.kind === "incident_closed");
  // Minute 1 was not scored: the incident still closed 4 minutes after the last flag.
  const gap = closedOf([flagged(0), score(2), score(3), score(4), score(5)]);
  assert.equal(gap.time, START + 4 * MIN);
  assert.equal(gap.detail, "4 minutes after the last flag, the explainer's quiet time.");
  // A flag 3 minutes later is a new incident (more than INCIDENT_GAP_MINUTES away).
  const again = closedOf([flagged(0), score(1), score(2), flagged(3), score(4), score(5)]);
  assert.equal(again.time, START + 4 * MIN);
});

test("the stored end_time of the explanation sets the close time", () => {
  const steps = buildSteps(open(), {
    scores: [flagged(0), flagged(1)],
    explanation: { time: START, end_time: new Date(START + 7 * MIN).toISOString().replace("Z", "+00:00"), source: "llm", attempts: 1 },
  });
  const closed = steps.find((s) => s.kind === "incident_closed");
  assert.equal(closed.time, START + 11 * MIN);
  assert.deepEqual(kinds(steps).slice(-2), ["explanation", "rollback_not_run"]);
});

test("a warm-up that starts before the action's logged time still comes after the action", () => {
  const rows = [flagged(0), score(2, { warmup: 1 }), score(3, { warmup: 1 })];
  const steps = buildSteps(open(), { scores: rows, actions: [{ time: START + 2 * MIN + 40000, outcome: "success", mode: "auto" }] });
  const order = kinds(steps);
  assert.ok(order.indexOf("action") < order.indexOf("warmup"));
  assert.equal(steps.find((s) => s.kind === "warmup").time, START + 2 * MIN);
});

test("a flag after a 2 minute gap stays in the incident", () => {
  const rows = [flagged(0), score(1), flagged(2), score(3), score(4), score(5), score(6)];
  const closed = buildSteps(open(), { scores: rows }).find((s) => s.kind === "incident_closed");
  assert.equal(closed.time, START + 6 * MIN);
});

test("action titles, details and families", () => {
  const one = (row) => buildSteps(open(), { scores: [], actions: [{ time: START + MIN, ...row }] }).find((s) => s.kind === "action");
  const cases = [
    [{ mode: "approved", outcome: "success", service_up: 1 }, "Approved", "worked", /Back up 60 s later/],
    [{ mode: "approved", outcome: "failed", service_up: 0 }, "Approved", "failed", /Still down 60 s later/],
    [{ mode: "auto", outcome: "success", service_up: 1 }, "Ran automatically", "worked", /run without asking/],
    [{ mode: "auto", outcome: "success" }, "Ran automatically", "worked", /^((?!60 s later).)*$/],
    [{ outcome: "success", action: "restart" }, "Restarted", "worked", /restarted/],
    [{ outcome: "success", action: "rollback" }, "Rolled back", "worked", /rolled back/],
    [{ mode: "rejected", outcome: "rejected" }, "Rejected", "not_run", /rejected/],
    [{ mode: "expired", outcome: "expired" }, "Expired", "not_run", /Nobody answered/],
    [{ outcome: "skipped_cooldown" }, "Skipped, cooldown", "not_run", /cooldown/],
    [{ outcome: "skipped_closed" }, "Skipped, incident already closed", "not_run", /closed/],
    [{ outcome: "skipped_simulated" }, "Skipped, simulated incident", "not_run", /fault injection/],
    [{ outcome: "skipped_no_previous_image" }, "Skipped, no previous image", "not_run", /earlier image/],
    [{ outcome: "skipped_no_deployment", action: "rollback" }, "Skipped, no recent deployment", "not_run", /no rollback/],
    // Old rows without an outcome: the outcome comes from service_up.
    [{ mode: "auto", service_up: 1 }, "Ran automatically", "worked", /Back up/],
    [{ mode: "approved", service_up: 0 }, "Approved", "failed", /Still down/],
  ];
  for (const [row, title, family, detail] of cases) {
    const s = one(row);
    assert.equal(s.title, title, JSON.stringify(row));
    assert.equal(s.family, family, JSON.stringify(row));
    assert.match(s.detail, detail, JSON.stringify(row));
    assert.equal(s.source, "remediation_action");
    assert.ok(!s.detail.includes(String.fromCharCode(0x2014)));
  }
});

test("only a failed action has the failed family", () => {
  const outcomes = ["success", "rejected", "expired", "skipped_cooldown", "skipped_closed"];
  for (const outcome of outcomes) {
    const s = buildSteps(open(), { actions: [{ time: START, outcome }] }).find((x) => x.kind === "action");
    assert.notEqual(s.family, "failed");
  }
});

test("warm-up follows only an action that ran, and each run is used once", () => {
  const rows = [flagged(0), score(3, { warmup: 1 }), score(4, { warmup: 1 })];
  const rejected = buildSteps(open(), { scores: rows, actions: [{ time: START + 3 * MIN, outcome: "rejected" }] });
  assert.equal(rejected.some((s) => s.kind === "warmup"), false);
  const two = buildSteps(open(), {
    scores: rows,
    actions: [{ time: START + 3 * MIN, outcome: "success" }, { time: START + 4 * MIN, outcome: "success" }],
  });
  assert.equal(two.filter((s) => s.kind === "warmup").length, 1);
  assert.equal(two.find((s) => s.kind === "warmup").title, "Warm-up, 2 minutes");
  const single = buildSteps(open(), { scores: [score(3, { warmup: 1 })], actions: [{ time: START + 3 * MIN, outcome: "success" }] });
  assert.equal(single.find((s) => s.kind === "warmup").title, "Warm-up, 1 minute");
  // A warm-up far from the action does not belong to it.
  const far = buildSteps(open(), { scores: [score(30, { warmup: 1 })], actions: [{ time: START + MIN, outcome: "success" }] });
  assert.equal(far.some((s) => s.kind === "warmup"), false);
});

test("explanation steps", () => {
  const one = (row) => buildSteps(open(), { explanation: { time: START, ...row } }).find((s) => s.kind === "explanation");
  assert.equal(one({ source: "llm", attempts: 2 }).detail, "Written by the local LLM, accepted at attempt 2.");
  assert.equal(one({ source: "llm" }).detail, "Written by the local LLM.");
  assert.equal(one({ source: "template", attempts: 3 }).detail, "Template used after 3 attempts with the local LLM.");
  assert.equal(one({ source: "template" }).detail, "Template used.");
  assert.equal(one({}).detail, "The explanation was stored.");
});

test("the rollback step says which condition was missing", () => {
  const roll = (o) => buildSteps(open(o), {}).find((s) => s.kind === "rollback_not_run");
  const rule = "A rollback only follows a high-tier incident with a real CI deployment in the last 15 minutes.";
  assert.equal(roll({ tier: "medium", deployment: 0 }).detail, `${rule} The incident was medium tier. There was no real deployment in the last 15 minutes.`);
  assert.equal(roll({ tier: "high", deployment: 0 }).detail, `${rule} There was no real deployment in the last 15 minutes.`);
  assert.equal(roll({ tier: "medium", deployment: 1 }).detail, `${rule} The incident was medium tier.`);
  assert.equal(roll({ tier: "high", deployment: 1 }).detail, `${rule} Both conditions were met, but no rollback was recorded.`);
});

test("no rollback step when a rollback row exists", () => {
  const steps = buildSteps(open({ tier: "high", deployment: 1 }), { actions: [{ time: START + MIN, action: "rollback", outcome: "success" }] });
  assert.equal(steps.some((s) => s.kind === "rollback_not_run"), false);
  assert.equal(steps.find((s) => s.kind === "action").title, "Rolled back");
});

test("null and missing fields do not throw", () => {
  const steps = buildSteps(
    { time: START },
    {
      scores: [null, { time: null }, { time: START, score: null, threshold: null, is_anomaly: 1, tier: null }],
      actions: [null, { time: START }, { time: START + MIN, outcome: null, mode: null }],
      warning: { time: START - MIN },
      explanation: { time: START },
    }
  );
  assert.ok(steps.length >= 4);
  assert.equal(steps.find((s) => s.kind === "first_flag").detail, "This minute was flagged.");
});

// ----- the route -----

// A fake InfluxDB that answers each query by measurement and records every query sent.
function fakeInflux({ rows = {}, fail = [] } = {}) {
  const sent = [];
  const query = async (q) => {
    sent.push(q);
    for (const name of Object.keys(rows)) {
      if (q.includes(`FROM "${name}"`)) {
        if (fail === "all" || fail.includes(name)) throw new Error("influxdb returned 500");
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
  return { get: (path) => app.request(path, { headers: { cookie } }), app };
}

const URL = (start = START, job = JOB) => `/api/incidents/timeline?start=${start}&job=${job}`;

test("the route needs a session", async (t) => {
  const app = await startApp({ query: fakeInflux().query });
  t.after(app.close);
  assert.equal((await app.request(URL())).status, 401);
});

test("the route returns the window's minutes and the steps", async (t) => {
  const { query, sent } = fakeInflux({
    rows: {
      incident_open: [open()],
      anomaly_score: scores(),
      early_warning: [{ time: START - 3 * MIN, signal: "memory", minutes_to_threshold: 3 }],
      remediation_action: [],
      incident_explanation: [{ time: START, source: "template", attempts: 3 }],
    },
  });
  const { get } = await signedIn(t, query);
  const res = await get(URL());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.start, START);
  assert.equal(body.job, JOB);
  assert.equal(body.tier, "medium");
  assert.equal(body.deployment, false);
  assert.equal(body.from, START - 30 * MIN);
  // No end_time stored, so the end is the last flagged minute (minute 1).
  assert.equal(body.to, START + MIN + 20 * MIN);
  assert.equal(body.points.length, 18);
  assert.deepEqual(kinds(body.steps), ["early_warning", "first_flag", "incident_open", "incident_closed", "explanation", "rollback_not_run"]);
  assert.equal(body.steps.find((s) => s.kind === "explanation").detail, "Template used after 3 attempts with the local LLM.");

  // Constant InfluxQL with only the validated numbers and job.
  const sixHours = START + 6 * 60 * MIN;
  assert.equal(sent.length, 7);
  assert.equal(sent[0], `SELECT "tier","action","signal","peak_score","minutes","deployment" FROM "incident_open" WHERE "job" = 'sample-service' AND time >= ${START - 2 * MIN}ms AND time <= ${START + 2 * MIN}ms ORDER BY time ASC`);
  assert.ok(sent.includes(`SELECT "end_time","source","attempts","minutes" FROM "incident_explanation" WHERE "job" = 'sample-service' AND time >= ${START - 2 * MIN}ms AND time <= ${START + 2 * MIN}ms ORDER BY time ASC`));
  assert.ok(sent.includes(`SELECT "tier","peak_score" FROM "incident_open" WHERE "job" = 'sample-service' AND time >= ${START - 60 * MIN}ms AND time <= ${sixHours}ms ORDER BY time ASC`));
  assert.ok(sent.includes(`SELECT "is_anomaly","warmup" FROM "anomaly_score" WHERE "job" = 'sample-service' AND "is_anomaly" = 1 AND time >= ${START}ms AND time <= ${sixHours}ms ORDER BY time ASC`));
  assert.ok(sent.some((q) => q.includes(`FROM "anomaly_score" WHERE "job" = 'sample-service' AND time >= ${START - 30 * MIN}ms AND time <= ${START + 21 * MIN}ms ORDER BY time ASC`)));
  assert.ok(sent.some((q) => q.includes(`FROM "early_warning" WHERE "job" = 'sample-service' AND time >= ${START - 30 * MIN}ms AND time <= ${START}ms ORDER BY time DESC LIMIT 1`)));
  assert.ok(sent.some((q) => q.includes(`FROM "remediation_action" WHERE "job" = 'sample-service' AND time >= ${START - 30 * MIN}ms AND time <= ${START + 21 * MIN}ms`)));
});

test("a long incident with few flagged minutes gets its whole window", async (t) => {
  // Two flagged minutes are counted, but the last flag comes 90 minutes after the start.
  const rows = [flagged(0), score(1), score(45), flagged(90), score(91)];
  const { query } = fakeInflux({ rows: { incident_open: [open({ minutes: 2 })], anomaly_score: rows } });
  const { get } = await signedIn(t, query);
  const body = await (await get(URL())).json();
  assert.equal(body.to, START + 90 * MIN + 20 * MIN);
  assert.deepEqual(body.points.map((p) => p.time), rows.map((p) => p.time));
});

test("the stored end_time sets the window end, capped at start plus 6 h", async (t) => {
  const late = new Date(START + 7 * 60 * MIN).toISOString();
  const { query } = fakeInflux({ rows: { incident_open: [open()], incident_explanation: [{ time: START, end_time: late, source: "llm", attempts: 1 }] } });
  const { get } = await signedIn(t, query);
  const body = await (await get(URL())).json();
  assert.equal(body.to, START + 6 * 60 * MIN);
});

test("two incidents close together each show only their own actions and rollback state", async (t) => {
  const B = START + 20 * MIN;
  const { query } = fakeInflux({
    rows: {
      incident_open: [open(), open({ time: B, tier: "high", deployment: 1, action: "rollback" })],
      anomaly_score: [flagged(0), flagged(1), score(5), flagged(20), flagged(21), score(30)],
      remediation_action: [
        { time: START + 5 * MIN, action: "restart", mode: "approved", outcome: "success", service_up: 1 },
        { time: B + 3 * MIN, action: "rollback", mode: "skipped", outcome: "skipped_simulated" },
        { time: B + 4 * MIN, action: "restart", mode: "expired", outcome: "expired" },
      ],
    },
  });
  const { get } = await signedIn(t, query);

  const a = await (await get(URL())).json();
  assert.equal(a.start, START);
  // The last flag before the next incident ends incident A.
  assert.equal(a.to, START + MIN + 20 * MIN);
  const aActions = a.steps.filter((s) => s.kind === "action");
  assert.deepEqual(aActions.map((s) => [s.time, s.title]), [[START + 5 * MIN, "Approved"]]);
  // B's rollback row does not count for A.
  assert.ok(a.steps.some((s) => s.kind === "rollback_not_run"));

  const b = await (await get(URL(B))).json();
  assert.equal(b.start, B);
  const bActions = b.steps.filter((s) => s.kind === "action");
  assert.deepEqual(bActions.map((s) => [s.time, s.title]), [[B + 3 * MIN, "Skipped, simulated incident"], [B + 4 * MIN, "Expired"]]);
  assert.ok(!b.steps.some((s) => s.kind === "rollback_not_run"));
});

test("the open row is matched within 2 minutes, nearest first, and its stored start is used", async (t) => {
  const { query, sent } = fakeInflux({
    rows: {
      incident_open: [open({ time: START - 2 * MIN, tier: "low" }), open({ time: START + MIN, tier: "high", minutes: 3 })],
    },
  });
  const { get } = await signedIn(t, query);
  const body = await (await get(URL())).json();
  assert.equal(body.start, START + MIN);
  assert.equal(body.tier, "high");
  assert.equal(body.from, START + MIN - 30 * MIN);
  assert.equal(body.to, START + MIN + 3 * MIN + 20 * MIN);
  assert.ok(sent.some((q) => q.includes(`FROM "early_warning" WHERE "job" = 'sample-service' AND time >= ${START + MIN - 30 * MIN}ms AND time <= ${START + MIN}ms`)));
  assert.ok(sent.some((q) => q.includes(`FROM "incident_explanation" WHERE "job" = 'sample-service' AND time >= ${START - MIN}ms AND time <= ${START + 3 * MIN}ms`)));
});

test("an exact open row is used when there is one", async (t) => {
  const { query } = fakeInflux({ rows: { incident_open: [open({ time: START - MIN, tier: "low" }), open()] } });
  const { get } = await signedIn(t, query);
  const body = await (await get(URL())).json();
  assert.equal(body.start, START);
  assert.equal(body.tier, "medium");
});

test("the route answers with only the steps that have data", async (t) => {
  const { query } = fakeInflux({ rows: { incident_open: [open({ tier: "high", deployment: 1 })] } });
  const { get } = await signedIn(t, query);
  const body = await (await get(URL())).json();
  assert.deepEqual(kinds(body.steps), ["incident_open", "rollback_not_run"]);
  assert.deepEqual(body.points, []);
  assert.equal(body.deployment, true);
});

test("bad parameters give 400 and no query is sent", async (t) => {
  const { query, sent } = fakeInflux({ rows: { incident_open: [open()] } });
  const { get } = await signedIn(t, query);
  const bad = [
    "/api/incidents/timeline",
    `/api/incidents/timeline?start=${START}`,
    `/api/incidents/timeline?job=${JOB}`,
    URL("abc"),
    URL("1.5"),
    URL("-5"),
    URL(`${START}0`),
    URL(NOW - 15 * 24 * 60 * MIN - 1),
    URL(NOW + 1),
    URL(START, "Sample"),
    URL(START, "-x"),
    URL(START, "a".repeat(41)),
    URL(START, "a%27%20OR%201%3D1"),
    URL(START, "a%22b"),
    `/api/incidents/timeline?start=${START}&start=${START}&job=${JOB}`,
    `/api/incidents/timeline?start=${START}&job=a&job=b`,
  ];
  for (const path of bad) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
  }
  assert.equal(sent.length, 0);
});

test("start exactly 15 days back and a 40 character job are accepted", async (t) => {
  const { query } = fakeInflux({ rows: { incident_open: [open()] } });
  const { get } = await signedIn(t, query);
  assert.equal((await get(URL(NOW - 15 * 24 * 60 * MIN, "a".repeat(40)))).status, 200);
  assert.equal((await get(URL(NOW, "a"))).status, 200);
});

test("parseParams checks type, range and job", () => {
  assert.deepEqual(parseParams({ start: String(START), job: JOB }, NOW), { start: START, job: JOB });
  assert.ok(parseParams({ start: [String(START)], job: JOB }, NOW).error);
  assert.ok(parseParams({ start: String(START), job: { a: 1 } }, NOW).error);
});

test("an unknown incident gives 404 and only the first query", async (t) => {
  const { query, sent } = fakeInflux({ rows: { incident_open: [] } });
  const { get } = await signedIn(t, query);
  assert.equal((await get(URL())).status, 404);
  assert.equal(sent.length, 1);
});

test("InfluxDB down gives 502, on the first query and on a later one", async (t) => {
  const first = await signedIn(t, fakeInflux({ fail: "all" }).query);
  assert.equal((await first.get(URL())).status, 502);
  const later = await signedIn(t, fakeInflux({ rows: { incident_open: [open()], remediation_action: [] }, fail: ["remediation_action"] }).query);
  const res = await later.get(URL());
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "influxdb unreachable" });
});
