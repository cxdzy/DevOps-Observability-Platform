const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { buildDrift, pickDays, findEpisodes, DAYS, EPISODE_RATE, DAY_MS } = require("../drift");

// 30 Oct 2026, 08:00 UTC, the same clock the test app uses.
const NOW = Date.UTC(2026, 9, 30, 8, 0, 0);
const TODAY = Date.UTC(2026, 9, 30);
const day = (back) => TODAY - back * DAY_MS;

function dayRow(back, rate, run, extra = {}) {
  return {
    time: day(back),
    run_id: run,
    scored_minutes: 1440,
    normal_minutes: 1000,
    false_alarms: Math.round(rate * 1000),
    false_alarm_rate: rate,
    flagged_minutes: 40,
    injections: 3,
    ...extra,
  };
}

// A fake InfluxDB that answers each drift query by measurement and records every query sent.
function fakeInflux({ rows = {}, fail = false } = {}) {
  const sent = [];
  const query = async (q) => {
    sent.push(q);
    if (fail) throw new Error("influxdb returned 500");
    for (const name of Object.keys(rows)) {
      if (q.includes(`FROM "${name}"`)) {
        // The latest reference query is the one with LIMIT 1.
        const value = rows[name];
        return typeof value === "function" ? value(q) : value;
      }
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

test("GET /api/drift needs a session", async (t) => {
  const app = await startApp({ query: fakeInflux().query });
  t.after(app.close);
  assert.equal((await app.request("/api/drift")).status, 401);
});

test("days must be 7, 14, 30 or 60, and a bad value sends no query", async (t) => {
  const { query, sent } = fakeInflux();
  const get = await signedIn(t, query);
  for (const bad of ["0", "5", "61", "-7", "7.5", "abc", "7d", "7;DROP", "1e1", ""]) {
    const res = await get(`/api/drift?days=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
  }
  assert.equal((await get("/api/drift?days=7&days=14")).status, 400);
  assert.equal(sent.length, 0);
  for (const ok of DAYS) assert.equal((await get(`/api/drift?days=${ok}`)).status, 200, String(ok));
});

test("empty data gives empty lists, no latest reference and no episodes", async (t) => {
  const get = await signedIn(t, fakeInflux().query);
  const res = await get("/api/drift?days=30");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.days, []);
  assert.deepEqual(body.reference, []);
  assert.equal(body.latest_reference, null);
  assert.deepEqual(body.promotions, []);
  assert.deepEqual(body.episodes, []);
  assert.equal(body.episode_rate, EPISODE_RATE);
  assert.equal(body.from, day(29));
  assert.equal(body.to, TODAY + DAY_MS);
});

test("the queries are constants with only the validated number inserted", async (t) => {
  const { query, sent } = fakeInflux();
  const get = await signedIn(t, query);
  await get("/api/drift?days=14");
  assert.equal(sent.length, 4);
  assert.ok(sent.some((q) => q.includes('FROM "evaluation_day" WHERE time > now() - 15d ORDER BY time ASC')));
  assert.ok(sent.some((q) => q.includes('FROM "reference_level" WHERE "job" = \'sample-service\' AND time > now() - 14d ORDER BY time ASC')));
  assert.ok(sent.some((q) => q.includes('FROM "reference_level" WHERE "job" = \'sample-service\' ORDER BY time DESC LIMIT 1')));
  assert.ok(sent.some((q) => q.includes('FROM "model_retrain" WHERE time > now() - 14d ORDER BY time ASC')));
  for (const q of sent) assert.doesNotMatch(q, /;|\binto\b/i);
});

test("a mixed response has days, reference, promotions and episodes", async (t) => {
  const run = new Date(NOW).toISOString();
  const { query } = fakeInflux({
    rows: {
      evaluation_day: [
        dayRow(5, 0.002, run),
        dayRow(4, 0.05, run),
        dayRow(3, 0.8, run),
        dayRow(2, 0.004, run),
        dayRow(1, 0.0, run),
      ],
      reference_level: (q) =>
        q.includes("LIMIT 1")
          ? [{ time: NOW - 1000, memory_max_mb_median: 137, memory_max_mb_p99: 150, cpu_rate_median: 0.01, cpu_rate_p99: 0.02, latency_ms_median: 3, latency_ms_p99: 9, rejected: "" }]
          : [
              { time: NOW - 3600000, memory_max_mb_median: 130, memory_max_mb_p99: 140, rejected: "" },
              { time: NOW - 1000, memory_max_mb_median: 137, memory_max_mb_p99: 150, rejected: "latency_ms,cpu_rate" },
            ],
      model_retrain: [
        { time: NOW - 5 * DAY_MS, promoted: 1, new_version: "11", champion_version: "10", champion_f1: 0.8, challenger_f1: 0.9 },
        { time: NOW - 2 * DAY_MS, promoted: 0, new_version: "", champion_version: "11", champion_f1: 0.9, challenger_f1: 0.7 },
      ],
    },
  });
  const get = await signedIn(t, query);
  const body = await (await get("/api/drift?days=7")).json();

  assert.equal(body.days.length, 5);
  assert.deepEqual(body.days[1], {
    day: day(4), run: NOW, rate: 0.05, false_alarms: 50, normal_minutes: 1000, scored_minutes: 1440, flagged_minutes: 40, injections: 3,
  });
  assert.equal(body.reference.length, 2);
  assert.equal(body.reference[0].memory_median, 130);
  assert.deepEqual(body.reference[1].rejected, ["latency_ms", "cpu_rate"]);
  assert.equal(body.latest_reference.memory_median, 137);
  assert.equal(body.latest_reference.latency_p99, 9);
  assert.deepEqual(body.promotions, [{ time: NOW - 5 * DAY_MS, old_version: "v10", new_version: "v11", old_f1: 0.8, new_f1: 0.9 }]);
  assert.deepEqual(body.episodes, [{ start: day(4), end: day(2), days: 2, peak_rate: 0.8, false_alarms: 850 }]);
});

test("for one day the point of the newest run wins, and older days stay", () => {
  const older = "2026-10-28T06:00:00.000Z";
  const newer = "2026-10-29T06:00:00.000Z";
  const rows = [
    dayRow(3, 0.30, older),
    dayRow(2, 0.20, older),
    // The newer run is listed first on purpose: order must not matter.
    dayRow(2, 0.01, newer),
    dayRow(1, 0.02, newer),
  ].reverse();
  const picked = pickDays(rows, 7, NOW);
  assert.deepEqual(picked.map((d) => [d.day, d.rate]), [[day(3), 0.30], [day(2), 0.01], [day(1), 0.02]]);
  assert.equal(picked[1].run, Date.parse(newer));
});

test("a point without a readable run_id loses to one with it", () => {
  const picked = pickDays([dayRow(1, 0.5, undefined), dayRow(1, 0.1, "2026-10-29T06:00:00Z"), dayRow(1, 0.9, "not a date")], 7, NOW);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].rate, 0.1);
});

test("days outside the range are left out, and the rate falls back to false alarms over normal minutes", () => {
  const rows = [
    dayRow(30, 0.5, "2026-10-29T06:00:00Z"),
    dayRow(6, 0.1, "2026-10-29T06:00:00Z"),
    dayRow(7, 0.1, "2026-10-29T06:00:00Z"),
    { time: day(1), run_id: "2026-10-29T06:00:00Z", normal_minutes: 200, false_alarms: 10 },
    { time: day(0), run_id: "2026-10-29T06:00:00Z", normal_minutes: 0, false_alarms: 0 },
  ];
  const picked = pickDays(rows, 7, NOW);
  assert.deepEqual(picked.map((d) => d.day), [day(6), day(1), day(0)]);
  assert.equal(picked[1].rate, 0.05);
  assert.equal(picked[2].rate, null);
});

test("episodes are runs of consecutive days above 1 percent", () => {
  const d = (back, rate) => ({ day: day(back), rate, false_alarms: rate === null ? null : Math.round(rate * 100) });
  // Exactly 1 percent is not above the threshold.
  const list = [d(9, 0.01), d(8, 0.02), d(7, 0.5), d(6, 0.0), d(5, 0.03), d(3, 0.04), d(2, null), d(1, 0.2)];
  const eps = findEpisodes(list);
  assert.deepEqual(
    eps.map((e) => [e.start, e.end, e.days, e.peak_rate]),
    [
      [day(8), day(7) + DAY_MS, 2, 0.5],
      [day(5), day(5) + DAY_MS, 1, 0.03],
      // A missing day (day 4) breaks the run, and a day with no rate breaks it too.
      [day(3), day(3) + DAY_MS, 1, 0.04],
      [day(1), day(1) + DAY_MS, 1, 0.2],
    ]
  );
  assert.deepEqual(findEpisodes([]), []);
});

test("promotions list only promoted attempts in the shown days, with a v prefix once, oldest first", () => {
  const t1 = day(5) + 19 * 3600000;
  const t2 = day(4) + 19 * 3600000;
  const t3 = day(3) + 19 * 3600000;
  const body = buildDrift({
    evaluationRows: [],
    referenceRows: [],
    latestReferenceRows: [],
    retrainRows: [
      { time: t3, promoted: "1", new_version: "v12", champion_version: "v11", champion_f1: "0.5", challenger_f1: null },
      { time: t1, promoted: true, new_version: 11, champion_version: 10 },
      { time: t2, promoted: 0, new_version: "", champion_version: "11" },
      { time: null, promoted: 1 },
      // Inside the query window (now - 7 days) but before the first shown day.
      { time: day(6) - 3600000, promoted: 1, new_version: "10", champion_version: "9" },
    ],
    days: 7,
    now: NOW,
  });
  assert.deepEqual(body.promotions, [
    { time: t1, old_version: "v10", new_version: "v11", old_f1: null, new_f1: null },
    { time: t3, old_version: "v11", new_version: "v12", old_f1: 0.5, new_f1: null },
  ]);
});

test("InfluxDB down gives 502", async (t) => {
  const get = await signedIn(t, fakeInflux({ fail: true }).query);
  const res = await get("/api/drift?days=30");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "influxdb unreachable" });
});
