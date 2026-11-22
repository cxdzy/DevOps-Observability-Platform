// scripts/forecast-report.js on a fixture: a true warning, a false warning, a miss, lead times and
// the estimate error. Only the pure part runs here; nothing connects to a database or Prometheus.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { buildReport, parseArgs } = require("../scripts/forecast-report");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "forecast_report.json"), "utf8"));
const FROM = Date.parse(fixture.from);
const TO = Date.parse(fixture.to);

// [minutes after from, value] to [ms, value].
function history() {
  const out = {};
  for (const [key, series] of Object.entries(fixture.history)) {
    out[key] = {};
    for (const [name, points] of Object.entries(series)) out[key][name] = points.map(([m, v]) => [FROM + m * 60000, v]);
  }
  return out;
}

const report = (excludes = []) => buildReport({ from: FROM, to: TO, excludes, warnings: fixture.warnings, history: history() });

test("each warning gets its outcome, verdict, lead time and estimate error", () => {
  const { rows } = report();
  const byId = Object.fromEntries(rows.map((r) => [r.warning.id, r]));
  // Disk: 95 percent used at 10:10, 120 minutes after it opened with an estimate of 300.
  assert.equal(byId[1].verdict, "true");
  assert.equal(byId[1].reachAt, Date.parse("2026-11-22T10:10:00Z"));
  assert.equal(byId[1].leadMin, 120);
  assert.equal(byId[1].errorMin, 180);
  // Memory: 95 percent at 09:05 (the restart at 09:10 comes later), 35 minutes after opening.
  assert.equal(byId[2].verdict, "true");
  assert.equal(byId[2].reachAt, Date.parse("2026-11-22T09:05:00Z"));
  assert.equal(byId[2].restartAt, Date.parse("2026-11-22T09:10:00Z"));
  assert.equal(byId[2].leadMin, 35);
  assert.equal(byId[2].errorMin, 5);
  // Memory that never got there within 1.5 x 30 + 10 minutes: false.
  assert.equal(byId[3].verdict, "false");
  assert.equal(byId[3].outcomeAt, null);
  assert.equal(byId[3].leadMin, null);
  // A restart-loop warning is listed but not scored.
  assert.equal(byId[4].verdict, "not scored");
});

test("the summary counts warnings and misses and gives the medians", () => {
  const { summary, misses } = report();
  assert.equal(summary.warnings, 4);
  assert.equal(summary.scored, 3);
  assert.equal(summary.true, 2);
  assert.equal(summary.false, 1);
  assert.equal(summary.notScored, 1);
  assert.equal(summary.medianLeadMin, 77.5);
  assert.equal(summary.medianAbsErrorMin, 92.5);
  // worker2 reached 95 percent at 10:30 with no warning open in the 120 minutes before.
  assert.equal(misses.length, 1);
  assert.equal(misses[0].name, "worker2");
  assert.equal(misses[0].at, Date.parse("2026-11-22T10:30:00Z"));
});

test("the Markdown has the warnings table, the summary and the misses", () => {
  const { markdown } = report();
  assert.match(markdown, /\| Container \| Resource \| Opened \(UTC\) \| Estimate at open \| 95 percent reached \| Restart or OOM \| Outcome \| Lead time \| Estimate error \|/);
  assert.match(markdown, /\| old kotone-bot \| memory \| 2026-11-22T08:30:00Z \| 40\.0 min \| 2026-11-22T09:05:00Z \| 2026-11-22T09:10:00Z \| true \| 35\.0 min \| \+5\.0 min \|/);
  assert.match(markdown, /- True warnings: 2/);
  assert.match(markdown, /- False warnings: 1/);
  assert.match(markdown, /- Median lead time: 77\.5 min/);
  assert.match(markdown, /\| old worker2 \| 2026-11-22T10:30:00Z \| memory reached 95 percent of the limit \|/);
  assert.ok(!markdown.includes("\u2014"), "no em dashes");
});

test("--exclude drops the warnings opened in that window", () => {
  const { summary } = report([[Date.parse("2026-11-22T08:55:00Z"), Date.parse("2026-11-22T09:05:00Z")]]);
  assert.equal(summary.warnings, 3);
  assert.equal(summary.false, 0);
});

test("the arguments are checked", () => {
  const args = parseArgs(["--from", "2026-11-22T00:00:00Z", "--to", "2026-11-23T00:00:00Z", "--exclude", "2026-11-22T01:00:00Z", "2026-11-22T02:00:00Z"]);
  assert.equal(args.from, Date.parse("2026-11-22T00:00:00Z"));
  assert.deepEqual(args.excludes, [[Date.parse("2026-11-22T01:00:00Z"), Date.parse("2026-11-22T02:00:00Z")]]);
  assert.throws(() => parseArgs(["--from", "yesterday", "--to", "2026-11-23T00:00:00Z"]), /ISO UTC/);
  assert.throws(() => parseArgs(["--from", "2026-11-23T00:00:00Z", "--to", "2026-11-22T00:00:00Z"]), /after/);
  assert.throws(() => parseArgs(["--to", "2026-11-23T00:00:00Z"]), /Usage/);
});
