const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeIncidents } = require("../incidents");

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);

function expl(time, extra) {
  return {
    time, tier: "medium", action: "restart", signal: "memory", peak_score: 0.71,
    minutes: 6, source: "llm", deployment: 0, explanation: "Line one.\\nLine two.", ...extra,
  };
}

function open(time, extra) {
  return {
    time, tier: "high", tier_level: 3, action: "rollback", signal: "latency",
    peak_score: 0.8, minutes: 3, deployment: 1, ...extra,
  };
}

test("closed only", () => {
  const out = mergeIncidents([expl(T0)], [], T0 + 60 * MIN);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    start: T0, end: T0 + 6 * MIN, status: "closed", tier: "medium", action: "restart",
    signal: "memory", peakScore: 0.71, minutes: 6, deployment: false, source: "llm",
    explanation: "Line one.\nLine two.",
  });
});

test("open only", () => {
  const out = mergeIncidents([], [open(T0)], T0 + 4 * MIN);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "open");
  assert.equal(out[0].end, T0 + 3 * MIN);
  assert.equal(out[0].deployment, true);
  assert.equal(out[0].explanation, null);
  assert.equal(out[0].source, null);
});

test("open row matched to an explanation gives one incident", () => {
  const out = mergeIncidents([expl(T0)], [open(T0 + 60 * 1000)], T0 + 10 * MIN);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "closed");
  assert.equal(out[0].tier, "medium");
});

test("open row exactly 120 seconds from an explanation is merged", () => {
  const out = mergeIncidents([expl(T0)], [open(T0 + 120 * 1000)], T0 + 10 * MIN);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "closed");
});

test("open row 121 seconds from an explanation is a separate incident", () => {
  const out = mergeIncidents([expl(T0)], [open(T0 + 121 * 1000)], T0 + 4 * MIN);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.status), ["open", "closed"]);
});

test("open row 3 minutes from an explanation is a separate incident", () => {
  const out = mergeIncidents([expl(T0)], [open(T0 + 3 * MIN)], T0 + 4 * MIN);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.status), ["open", "closed"]);
});

test("awaiting_explanation after the window", () => {
  // minutes 3, so the window ends at start + 8 minutes
  assert.equal(mergeIncidents([], [open(T0)], T0 + 8 * MIN - 1)[0].status, "open");
  assert.equal(mergeIncidents([], [open(T0)], T0 + 8 * MIN)[0].status, "awaiting_explanation");
});

test("null and missing fields do not throw", () => {
  const out = mergeIncidents(
    [{ time: T0, tier: null, explanation: null, minutes: null }, { tier: "low" }],
    [{ time: T0 + 30 * MIN }, null],
    T0 + 31 * MIN
  );
  assert.equal(out.length, 2);
  const closed = out.find((i) => i.status === "closed");
  assert.equal(closed.tier, null);
  assert.equal(closed.explanation, null);
  assert.equal(closed.minutes, 0);
  assert.equal(closed.end, T0);
  assert.equal(closed.peakScore, null);
  assert.equal(closed.deployment, false);
  const other = out.find((i) => i.status !== "closed");
  assert.equal(other.status, "open");
  assert.equal(other.action, null);
  assert.deepEqual(mergeIncidents(undefined, undefined, T0), []);
});

test("newest first", () => {
  const out = mergeIncidents(
    [expl(T0), expl(T0 + 60 * MIN)],
    [open(T0 + 30 * MIN), open(T0 + 90 * MIN)],
    T0 + 200 * MIN
  );
  assert.deepEqual(out.map((i) => i.start), [T0 + 90 * MIN, T0 + 60 * MIN, T0 + 30 * MIN, T0]);
});
