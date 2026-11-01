const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/facts_compact.json");
const { createFacts, renderFacts, toIncidentValues, pyFixed, fmtTime, PROM_QUERIES } = require("../chat/facts");
const { mergeIncidents } = require("../incidents");

// fixtures/facts_compact.json was rendered by bench/chat_model_test/snapshot_facts.py from the
// values stored next to each text, so the same values must give exactly the same FACTS here.
for (const c of fixture.cases) {
  test(`FACTS parity with the benchmark renderer: ${c.name}`, () => {
    assert.equal(renderFacts(c.values, Date.parse(c.snapshot_utc)).text, c.facts_text);
  });
}

test("the fixture covers more than 8, exactly 8, 0 incidents and missing values", () => {
  const byName = Object.fromEntries(fixture.cases.map((c) => [c.name, c.facts_text]));
  assert.match(byName.more_than_8, /^- \(3 older incidents not listed\)$/m);
  assert.equal((byName.exactly_8.match(/^- \d\d:\d\d/gm) || []).length, 8);
  assert.doesNotMatch(byName.exactly_8, /older incidents not listed/);
  assert.match(byName.no_incidents, /^incidents last 6 h: 0 \(low 0, medium 0, high 0\)\nby signal: cpu 0, memory 0, latency 0, unclear 0\nhighest peak: none\nlinked to deployment: none$/m);
  assert.match(byName.missing, /^anomaly latest: no data$/m);
  assert.match(byName.missing, /^node fyp-main: memory no data of no data GiB, disk no data %, containers no data$/m);
  // Only the newest listed incident keeps its What happened text.
  assert.equal((byName.more_than_8.match(/What happened:/g) || []).length, 1);
});

test("numbers round like Python, ties to the even digit", () => {
  assert.equal(pyFixed(124.5, 0), "124");
  assert.equal(pyFixed(125.5, 0), "126");
  assert.equal(pyFixed(1.25, 1), "1.2");
  assert.equal(pyFixed(0.125, 2), "0.12");
  assert.equal(pyFixed(0.3465, 3), "0.346");
  assert.equal(pyFixed(2.65, 1), "2.6");
  assert.equal(pyFixed(0.00285, 4), "0.0029");
  assert.equal(pyFixed(16, 0), "16");
});

test("times are MYT whatever the server time zone", () => {
  const snap = Date.parse("2026-11-01T05:50:30Z");
  assert.equal(fmtTime(Date.parse("2026-11-01T05:48:00Z"), snap), "13:48");
  assert.equal(fmtTime(Date.parse("2026-10-31T15:59:00Z"), snap), "23:59 31 Oct");
  assert.equal(fmtTime(Date.parse("2026-10-31T16:00:00Z"), snap), "00:00");
});

test("dashboard incidents map to the benchmark shape", () => {
  const T = Date.parse("2026-11-01T04:00:00Z");
  const merged = mergeIncidents(
    [{ time: T, tier: "medium", signal: "memory", minutes: 2, peak_score: 0.66, deployment: 0,
       explanation: "What happened: Memory rose.\\nLikely cause: x\\nNext step: y" }],
    [{ time: T + 600000, tier: null, signal: null, minutes: 1.9, peak_score: null, deployment: 1 },
     { time: T - 3600000, tier: "low", signal: "cpu", minutes: 1, peak_score: 0.61, deployment: 0 }],
    T + 600000
  );
  const v = toIncidentValues(merged);
  assert.equal(v.count, 3);
  assert.deepEqual(v.by_tier, { low: 1, medium: 1, high: 0 });
  assert.deepEqual(v.items[0], { start_ms: T + 600000, tier: "none", signal: "none", minutes: 1, peak_score: null,
    deployment: true, status: "open", what_happened: null });
  assert.equal(v.items[1].what_happened, "Memory rose.");
  // awaiting_explanation in the dashboard is "open" in FACTS, as in the benchmark.
  assert.equal(merged[2].status, "awaiting_explanation");
  assert.equal(v.items[2].status, "open");
});

function fakeSources({ influxDown = false, promDown = false } = {}) {
  const T = Date.parse("2026-11-01T05:48:00Z");
  const queries = [];
  const query = async (q) => {
    queries.push(q);
    if (influxDown) throw new Error("influxdb returned 500");
    if (q.startsWith('SELECT * FROM "anomaly_score"')) {
      return [{ time: T, score: 0.3465, threshold: 0.6024, is_anomaly: 0, tier: "none", model: "v10", cpu_rate: 0.00285,
        memory_max_mb: 124.5, latency_ms: 1.45, base_cpu_rate: 0.0028, base_memory_max_mb: 123.5, base_latency_ms: 1.25 }];
    }
    if (q.includes('FROM "model_retrain"')) return [{ time: Date.parse("2026-10-31T19:01:20Z"), promoted: 0, new_version: "" }];
    if (q.includes('FROM "incident_explanation"')) {
      return [{ time: Date.parse("2026-11-01T04:48:00Z"), tier: "medium", signal: "memory", minutes: 2, peak_score: 0.661,
        deployment: 0, explanation: "What happened: Memory use spiked.\\nLikely cause: x" }];
    }
    if (q.includes('FROM "deployment_event"')) return [{ time: Date.parse("2026-10-23T12:19:00Z") }];
    return [];
  };
  const GIB = 2 ** 30;
  const answers = {
    [PROM_QUERIES.service_up]: [{ labels: { job: "sample-service" }, value: 1 }],
    [PROM_QUERIES.node_up]: [{ labels: { job: "node-exporter" }, value: 1 }, { labels: { job: "node-exporter-old" }, value: 1 }],
    [PROM_QUERIES.mem_total]: [{ labels: { job: "node-exporter" }, value: 7.5 * GIB }, { labels: { job: "node-exporter-old" }, value: 3.7 * GIB }],
    [PROM_QUERIES.mem_available]: [{ labels: { job: "node-exporter" }, value: 4.9 * GIB }, { labels: { job: "node-exporter-old" }, value: 2.5 * GIB }],
    [PROM_QUERIES.disk_size]: [{ labels: { job: "node-exporter" }, value: 100 }, { labels: { job: "node-exporter-old" }, value: 100 }],
    [PROM_QUERIES.disk_available]: [{ labels: { job: "node-exporter" }, value: 64 }, { labels: { job: "node-exporter-old" }, value: 45 }],
    [PROM_QUERIES.containers]: [{ labels: { job: "cadvisor" }, value: 16 }, { labels: { job: "cadvisor-old" }, value: 10 }],
  };
  const prometheus = { query: async (q) => { if (promDown) throw new Error("down"); assert.ok(q in answers, q); return answers[q]; } };
  return { query, prometheus, queries, now: () => Date.parse("2026-11-01T05:50:30.400Z") };
}

test("gather builds the FACTS from InfluxDB and Prometheus with read-only queries", async () => {
  const s = fakeSources();
  const f = await createFacts(s).gather();
  assert.equal(f.snapshotMs, Date.parse("2026-11-01T05:50:30Z"));
  assert.equal(f.latestScore, 0.3465);
  assert.equal(f.text, [
    "FACTS (snapshot 2026-11-01T05:50:30Z, times in MYT, UTC+8)",
    "service sample-service: up yes",
    "anomaly latest: 13:48, score 0.346, threshold 0.602, flagged no, tier none",
    "sample-service now: 13:48, cpu_rate 0.0029, memory 124 MB, latency 1.4 ms",
    "model: champion v10, threshold 0.602, last retraining 03:01, result kept champion",
    "normal reference: cpu_rate 0.0028, memory 124 MB, latency 1.2 ms",
    "incidents last 6 h: 1 (low 0, medium 1, high 0)",
    "by signal: cpu 0, memory 1, latency 0, unclear 0",
    "highest peak: 0.661 at 12:48 (tier medium, signal memory)",
    "linked to deployment: none",
    "- 12:48, tier medium, signal memory, 2 min, peak 0.661, deployment no, closed. What happened: Memory use spiked.",
    "last restart: none in the last 30 days",
    "last CI deployment: 20:19 23 Oct",
    "node fyp-main: memory 2.6 of 7.5 GiB, disk 36 %, containers 16",
    "node staging: monitored yes, memory 1.2 of 3.7 GiB, disk 55 %, containers 10",
    "Only the facts above are available. Logs, commit messages and metrics not listed are not available.",
  ].join("\n"));
  for (const q of s.queries) assert.match(q, /^SELECT /);
  assert.ok(s.queries.some((q) => q.includes("now() - 6h")), "incidents of the last 6 hours");
  assert.ok(s.queries.some((q) => q.includes('"remediation_action"') && q.includes("now() - 30d")));
  assert.ok(s.queries.some((q) => q.includes("\"source\" = 'ci'")));
});

test("a failed source shows no data instead of failing", async () => {
  const f = await createFacts(fakeSources({ influxDown: true, promDown: true })).gather();
  assert.match(f.text, /^service sample-service: up no data$/m);
  assert.match(f.text, /^anomaly latest: no data$/m);
  assert.match(f.text, /^incidents last 6 h: no data$/m);
  assert.match(f.text, /^node staging: monitored no data$/m);
  assert.equal(f.latestScore, null);
});
