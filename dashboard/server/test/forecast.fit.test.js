// The pure forecast rules on synthetic series (forecast/fit.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fit = require("../forecast/fit");
const { FORECAST_CONFIG: CONFIG } = require("../forecast/config");

const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
const T0 = Date.UTC(2026, 10, 22, 8, 0, 0);
const LIMIT = 400 * MIB;
const HOST = 8 * GIB;

// A repeatable noise source (a small linear congruential generator) in -1..1.
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

// 31 points, one a minute, value fn(minute) in MiB.
function memSeries(fn, minutes = 30) {
  const out = [];
  for (let m = 0; m <= minutes; m++) out.push([T0 + m * 60000, fn(m) * MIB]);
  return out;
}
// A start time series that is constant, or changes at the given minutes.
function startSeries(changesAt = [], minutes = 30) {
  const out = [];
  let start = T0 / 1000 - 86400;
  for (let m = 0; m <= minutes; m++) {
    if (changesAt.includes(m)) start = (T0 + m * 60000) / 1000 - 5;
    out.push([T0 + m * 60000, start]);
  }
  return out;
}
const memory = (fn, extra = {}) => fit.assessMemory({ points: memSeries(fn), limit: LIMIT, hostBytes: HOST, starts: startSeries(), ...extra }, CONFIG);

test("the result has the documented shape", () => {
  const r = memory((m) => 200);
  for (const k of ["state", "slope", "r2", "rise_pct", "est_minutes", "reason"]) assert.ok(k in r, k);
});

test("a steady leak warns, with the estimate within 10 percent of the true time", () => {
  const n = noise(1);
  // 1 MiB a minute from 320 MiB: at minute 30 it is at 350, so the limit comes 50 minutes later.
  const r = memory((m) => 320 + m + n() * 0.2);
  assert.equal(r.state, "warning");
  assert.equal(r.reason, "trend");
  assert.ok(r.r2 >= 0.8, `r2 ${r.r2}`);
  const trueMinutes = 50;
  assert.ok(Math.abs(r.est_minutes - trueMinutes) / trueMinutes <= 0.1, `estimate ${r.est_minutes}`);
  // The 5 minute envelope trails a rise by about 4 minutes, so the estimate is a little long.
  assert.ok(r.est_minutes >= trueMinutes, `estimate ${r.est_minutes}`);
  assert.ok(Math.abs(r.slope / MIB - 1) < 0.05);
});

test("a slow leak (6 percent of the limit per 30 minutes) warns only once the estimate is under 60 minutes", () => {
  const perMin = (0.06 * 400) / 30;
  const far = memory((m) => 256 + m * perMin);
  assert.equal(far.state, "ok");
  assert.equal(far.reason, "far");
  assert.ok(far.est_minutes > 60);
  assert.ok(far.rise_pct >= 4 && far.rise_pct < 7, `rise ${far.rise_pct}`);
  const near = memory((m) => 336 + m * perMin);
  assert.equal(near.state, "warning");
  assert.ok(near.est_minutes <= 60, `estimate ${near.est_minutes}`);
});

test("a flat noisy series does not warn", () => {
  const n = noise(7);
  const r = memory(() => 200 + n() * 5);
  assert.equal(r.state, "ok");
});

test("a garbage collection saw-tooth around a flat level does not warn", () => {
  // Climbs 4 MiB a minute for 3 minutes, then is collected back to 200.
  const r = memory((m) => 200 + (m % 4) * 4);
  assert.equal(r.state, "ok");
  assert.ok(Math.abs(r.slope) < 0.01 * MIB);
});

test("a saw-tooth around a rising level warns", () => {
  const r = memory((m) => 320 + m + (m % 4) * 4);
  assert.equal(r.state, "warning");
  assert.ok(r.est_minutes > 40 && r.est_minutes <= 60, `estimate ${r.est_minutes}`);
});

test("a step up with no trend (a model load) does not warn", () => {
  const r = memory((m) => (m < 15 ? 150 : 300));
  assert.equal(r.state, "ok");
  assert.ok(r.r2 < 0.8 || r.est_minutes > 60, `r2 ${r.r2}, estimate ${r.est_minutes}`);
});

test("a cache warm-up that rises then flattens does not warn", () => {
  const r = memory((m) => 150 + 200 * (1 - Math.exp(-m / 4)));
  assert.equal(r.state, "ok");
});

test("a decreasing series does not warn", () => {
  const r = memory((m) => 380 - m);
  assert.equal(r.state, "ok");
  assert.equal(r.reason, "not_rising");
  assert.equal(r.est_minutes, null);
});

test("a restart in the window cuts it: not enough data until 10 minutes after the restart", () => {
  const leak = (m) => 320 + m;
  const early = memory(leak, { starts: startSeries([22]) });
  assert.equal(early.state, "not_enough_data");
  assert.equal(early.reason, "restart");
  assert.equal(early.restart_at, T0 + 22 * 60000 - 5000);
  const ready = memory(leak, { starts: startSeries([20]) });
  assert.notEqual(ready.state, "not_enough_data");
  assert.equal(ready.window_min, 10);
  // The points before the restart are not used: a high level before it does not count.
  const dropped = memory((m) => (m < 15 ? 390 : 100), { starts: startSeries([15]) });
  assert.equal(dropped.state, "ok");
});

test("too few points give not enough data", () => {
  const points = memSeries((m) => 320 + m).slice(0, 5);
  const r = fit.assessMemory({ points, limit: LIMIT, hostBytes: HOST, starts: startSeries() }, CONFIG);
  assert.equal(r.state, "not_enough_data");
  assert.equal(r.reason, "too_few_points");
  assert.equal(fit.assessMemory({ points: [], limit: LIMIT, hostBytes: HOST, starts: [] }, CONFIG).state, "not_enough_data");
});

test("a limit of 0, the unlimited value or one above the host memory is no limit", () => {
  for (const limit of [0, null, 2 ** 63, 16 * GIB]) {
    const r = fit.assessMemory({ points: memSeries((m) => 320 + m), limit, hostBytes: HOST, starts: startSeries() }, CONFIG);
    assert.equal(r.state, "no_limit", String(limit));
    assert.equal(r.est_minutes, null);
    assert.equal(r.slope, null);
  }
});

function diskSeries(sizeBytes, usedPctAt, hours = 6) {
  const size = [];
  const avail = [];
  for (let i = 0; i <= (hours * 60) / 5; i++) {
    const t = T0 + i * 300000;
    size.push([t, sizeBytes]);
    avail.push([t, sizeBytes * (1 - usedPctAt(i * 5) / 100)]);
  }
  return { size, avail };
}

test("a slow disk rise warns with an estimate in hours", () => {
  // 1 percent an hour, 92 percent used at the end: full in about 8 hours.
  const r = fit.assessDisk(diskSeries(100 * GIB, (min) => 86 + min / 60), CONFIG);
  assert.equal(r.state, "warning");
  assert.ok(Math.abs(r.est_minutes / 60 - 8) < 0.1, `estimate ${r.est_minutes / 60} h`);
  assert.ok(Math.abs(r.used_pct - 92) < 0.01);
  // A slower rise is a long way off and does not warn.
  const slow = fit.assessDisk(diskSeries(100 * GIB, (min) => 50 + min / 120), CONFIG);
  assert.equal(slow.state, "ok");
});

test("a flat disk does not warn", () => {
  const n = noise(3);
  const r = fit.assessDisk(diskSeries(40 * GIB, () => 45 + n() * 0.01), CONFIG);
  assert.equal(r.state, "ok");
  assert.ok(Math.abs(r.used_pct - 45) < 0.1);
});

test("a disk with no series has no data", () => {
  assert.equal(fit.assessDisk({ size: [], avail: [] }, CONFIG).state, "no_data");
});

test("three start changes in 15 minutes is restarting, two is not, and an OOM kill is restarting too", () => {
  const nowMs = T0 + 30 * 60000;
  const zero = memSeries(() => 0);
  assert.equal(fit.assessRestarts({ starts: startSeries([18, 22, 26]), ooms: zero, nowMs }, CONFIG).state, "restarting");
  const two = fit.assessRestarts({ starts: startSeries([22, 26]), ooms: zero, nowMs }, CONFIG);
  assert.equal(two.state, "ok");
  assert.equal(two.changes, 2);
  // Changes older than 15 minutes do not count.
  assert.equal(fit.assessRestarts({ starts: startSeries([5, 8, 12]), ooms: zero, nowMs }, CONFIG).state, "ok");
  const oom = fit.assessRestarts({ starts: startSeries(), ooms: memSeries((m) => (m >= 25 ? 1 : 0)), nowMs }, CONFIG);
  assert.equal(oom.state, "restarting");
  assert.equal(oom.reason, "oom");
  // A counter reset (a new container) is not an OOM kill.
  assert.equal(fit.assessRestarts({ starts: startSeries(), ooms: memSeries((m) => (m >= 25 ? 0 : 3)), nowMs }, CONFIG).state, "ok");
});

test("the helpers: envelope, Theil-Sen and R squared", () => {
  assert.deepEqual(fit.envelope([5, 3, 4, 6, 7, 8], 3), [5, 3, 3, 3, 4, 6]);
  const line = fit.theilSen([0, 1, 2, 3, 4], [1, 3, 5, 100, 9]);
  assert.equal(line.slope, 2);
  assert.equal(line.intercept, 1);
  assert.equal(fit.rSquared([0, 1, 2], [1, 3, 5], 2, 1), 1);
  assert.equal(fit.rSquared([0, 1, 2], [4, 4, 4], 0, 4), 0);
  assert.equal(fit.theilSen([1], [1]), null);
});
