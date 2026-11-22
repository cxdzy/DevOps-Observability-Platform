const test = require("node:test");
const assert = require("node:assert/strict");
const { checkAnswer } = require("../chat/check");
const fixture = require("./fixtures/facts_compact.json");

const FACTS = fixture.cases.find((c) => c.name === "more_than_8").facts_text;

test("accepts answers that copy numbers and times from FACTS", () => {
  for (const answer of [
    "sample-service is up. The latest anomaly score is 0.346 at 13:48, below the threshold 0.602.",
    "There were 11 incidents in the last 6 hours; the highest peak was 0.751 at 12:10.",
    "Memory is 124 MB against a normal 124 MB, so it looks normal.",
    "fyp-main uses 2.6 of 7.5 GiB and 36 % disk.",
    "Ya, ada 2 insiden memori dalam 6 jam lepas.",
    "Nothing looks wrong right now.",
    "The last CI deployment was at 20:19 23 Oct.",
  ]) {
    assert.deepEqual(checkAnswer(answer, FACTS), [], answer);
  }
});

test("rejects numbers and times that are not in FACTS", () => {
  assert.deepEqual(checkAnswer("The score is 0.35.", FACTS), ["number 0.35 is not in the FACTS or the question"]);
  assert.deepEqual(checkAnswer("It started at 14:05.", FACTS), ["time 14:05 is not in the FACTS or the question"]);
  // A number inside a FACTS number does not count: 34 is not 0.346.
  assert.deepEqual(checkAnswer("Memory is at 34 percent.", FACTS), ["number 34 is not in the FACTS or the question"]);
  assert.deepEqual(checkAnswer("Disk I/O was 55% and 36%.", FACTS), []); // numbers are in FACTS: the guard handles this
  assert.deepEqual(checkAnswer("There were 12 incidents.", FACTS), ["number 12 is not in the FACTS or the question"]);
});

test("rejects action claims in English and Malay", () => {
  for (const [answer, word] of [
    ["I restarted sample-service.", "restarted"],
    ["The service was rolled back to v9.", "rolled back"],
    ["I stopped the container.", "stopped"],
    ["Saya telah restart perkhidmatan.", "telah restart"],
    ["Perkhidmatan telah dimulakan semula.", "dimulakan semula"],
  ]) {
    const problems = checkAnswer(answer, FACTS);
    assert.ok(problems.includes(`claims an action ("${word}")`), answer);
  }
  assert.deepEqual(checkAnswer("Restarts need an admin request and a Telegram approval.", FACTS), []);
});

test("numbers and times from the question are allowed, invented ones are still rejected", () => {
  const question = "how many high incidents in 24hours";
  const ok = "The dashboard has no data for the number of high incidents in the last 24 hours.";
  assert.deepEqual(checkAnswer(ok, FACTS), ["number 24 is not in the FACTS or the question"]);
  assert.deepEqual(checkAnswer(ok, FACTS, question), []);
  assert.deepEqual(checkAnswer("There were 17 high incidents in 24 hours.", FACTS, question),
    ["number 17 is not in the FACTS or the question"]);
  assert.deepEqual(checkAnswer("Nothing happened at 03:00.", FACTS, "What happened at 03:00?"), []);
  assert.deepEqual(checkAnswer("Nothing happened at 04:00.", FACTS, "What happened at 03:00?"),
    ["time 04:00 is not in the FACTS or the question"]);
});

test("an empty answer fails", () => {
  assert.deepEqual(checkAnswer("  ", FACTS), ["empty answer"]);
});

// ------------------------------------------------------------------ direction and tier

// FACTS like the live ones that the model got wrong: threshold 0.458, a medium incident at 06:32.
const LIVE = [
  "FACTS (snapshot 2026-11-22T00:40:00Z, times in MYT, UTC+8)",
  "anomaly latest: 08:39, score 0.310, threshold 0.458, flagged no, tier none",
  "incidents last 6 h: 3 (low 1, medium 2, high 0)",
  "highest peak: 0.718 at 06:32 (tier medium, signal memory)",
  "- 08:17, tier medium, signal memory, 1 min, peak 0.461, deployment no, closed.",
  "- 06:44, tier low, signal cpu, 2 min, peak 0.707, deployment no, closed.",
  "- 06:32, tier medium, signal memory, 3 min, peak 0.718, deployment no, closed.",
  "CONTEXT: the user was just asking about the incident at 08:17, tier medium, signal memory.",
  "Only the facts above are available. Logs, commit messages and metrics not listed are not available.",
].join("\n");

test("direction: the stated comparison must match the score and the threshold", () => {
  assert.deepEqual(checkAnswer("The score 0.718 has not reached the threshold 0.458.", LIVE), ["says 0.718 is below the threshold 0.458"]);
  assert.deepEqual(checkAnswer("0.718 has not reached 0.458.", LIVE), ["says 0.718 is below the threshold 0.458"]);
  for (const wrong of [
    "The peak 0.718 is not yet at the threshold 0.458.",
    "The peak 0.718 is below the threshold 0.458.",
    "The peak 0.718 did not exceed the threshold 0.458.",
    "The peak 0.718 didn't cross the threshold 0.458.",
  ]) assert.deepEqual(checkAnswer(wrong, LIVE), ["says 0.718 is below the threshold 0.458"], wrong);
  for (const wrong of [
    "The latest score 0.310 is above the threshold 0.458.",
    "The latest score 0.310 exceeded the threshold 0.458.",
    "The latest score 0.310 crossed the threshold 0.458.",
    "The latest score 0.310 is over the threshold 0.458.",
  ]) assert.deepEqual(checkAnswer(wrong, LIVE), ["says 0.310 is above the threshold 0.458"], wrong);
});

test("direction: correct comparisons pass, in English and Malay", () => {
  for (const right of [
    "The latest score 0.310 is below the threshold 0.458.",
    "The latest score 0.310 has not reached the threshold 0.458.",
    "The latest score 0.310 did not exceed the threshold 0.458.",
    "The peak 0.718 was above the threshold 0.458.",
    "The peak 0.718 exceeded the threshold 0.458 at 06:32.",
    "The peak 0.718 passed the threshold 0.458.",
    "Over the past hour the latest score 0.310 stayed under the threshold 0.458.",
    "Skor terkini 0.310 di bawah ambang 0.458.",
    "Skor terkini 0.310 belum melepasi ambang 0.458.",
    "Skor terkini 0.310 kurang daripada ambang 0.458.",
    "Puncak 0.718 melepasi ambang 0.458.",
    "Puncak 0.718 lebih tinggi daripada ambang 0.458.",
  ]) assert.deepEqual(checkAnswer(right, LIVE), [], right);
});

test("direction: Malay sentences that state the wrong direction fail", () => {
  assert.deepEqual(checkAnswer("Puncak 0.718 belum melepasi ambang 0.458.", LIVE), ["says 0.718 is below the threshold 0.458"]);
  assert.deepEqual(checkAnswer("Puncak 0.718 di bawah ambang 0.458.", LIVE), ["says 0.718 is below the threshold 0.458"]);
  assert.deepEqual(checkAnswer("Skor terkini 0.310 melepasi ambang 0.458.", LIVE), ["says 0.310 is above the threshold 0.458"]);
  assert.deepEqual(checkAnswer("Skor terkini 0.310 lebih daripada ambang 0.458.", LIVE), ["says 0.310 is above the threshold 0.458"]);
});

test("direction: sentences without a comparison, a threshold or a second score are left alone", () => {
  for (const neutral of [
    "The latest score is 0.310 and the threshold is 0.458.",
    "The threshold is 0.458.",
    "The score went above normal at 06:32.",
    "The peak 0.718 was the highest in the last 6 hours.",
    "Skor terkini 0.310, ambang 0.458.",
  ]) assert.deepEqual(checkAnswer(neutral, LIVE), [], neutral);
  // Each sentence is checked on its own: the score and the threshold are in different sentences.
  assert.deepEqual(checkAnswer("The peak was 0.718 at 06:32. The threshold 0.458 has not been reached since.", LIVE), []);
});

test("tier: a tier named with a time must match the incident at that time", () => {
  assert.deepEqual(checkAnswer("Memory peaked at 06:32 (tier low, signal memory).", LIVE),
    ["says tier low at 06:32, which no incident in the FACTS has"]);
  assert.deepEqual(checkAnswer("The high incident at 08:17 was short.", LIVE), ["says tier high at 08:17, which no incident in the FACTS has"]);
  assert.deepEqual(checkAnswer("Insiden pada 06:44 ialah tier medium.", LIVE), ["says tier medium at 06:44, which no incident in the FACTS has"]);
  assert.deepEqual(checkAnswer("Insiden tahap tinggi pada 06:32.", LIVE), ["says tier high at 06:32, which no incident in the FACTS has"]);
  for (const right of [
    "Memory peaked at 06:32 (tier medium, signal memory).",
    "The incident at 08:17 was tier medium.",
    "A low-tier incident started at 06:44.",
    "The medium incident at 06:32 lasted 3 min.",
    "Insiden pada 06:44 ialah tier low.",
    "Insiden tahap sederhana pada 08:17.",
    // Only low, medium and high are checked.
    "The latest minute at 08:39 is tier none and not flagged.",
  ]) assert.deepEqual(checkAnswer(right, LIVE), [], right);
});

test("tier: sentences without both a tier and a time are left alone", () => {
  for (const neutral of [
    "Tier medium offers a container restart.",
    "Memory was high at 06:32.",
    "The incident at 06:32 lasted 3 min.",
    "There were 2 medium incidents in the last 6 hours.",
  ]) assert.deepEqual(checkAnswer(neutral, LIVE), [], neutral);
});

// ------------------------------------------------------------------ absence claims

// The live case at 08:48 MYT: incidents at 08:17 and 08:19 in the last hour, 13 in 6 hours.
const HOUR = [
  "FACTS (snapshot 2026-11-22T00:48:00Z, times in MYT, UTC+8)",
  "anomaly latest: 08:46, score 0.361, threshold 0.458, flagged no, tier none",
  "incidents last 6 h: 13 (low 5, medium 8, high 0)",
  "highest peak: 0.718 at 06:32 (tier low, signal cpu)",
  "- 08:19, tier medium, signal memory, 1 min, peak 0.470, deployment no, closed.",
  "- 08:17, tier medium, signal memory, 1 min, peak 0.461, deployment no, closed.",
  "- 07:43, tier medium, signal memory, 2 min, peak 0.500, deployment no, closed.",
  "- 06:32, tier low, signal cpu, 1 min, peak 0.718, deployment no, closed.",
  "- (9 older incidents not listed)",
  "Only the facts above are available. Logs, commit messages and metrics not listed are not available.",
].join("\n");
// Quiet: no incident in 6 hours, latest minute not flagged.
const QUIET = [
  "FACTS (snapshot 2026-11-22T00:48:00Z, times in MYT, UTC+8)",
  "anomaly latest: 08:46, score 0.361, threshold 0.458, flagged no, tier none",
  "incidents last 6 h: 0 (low 0, medium 0, high 0)",
  "highest peak: none",
  "Only the facts above are available. Logs, commit messages and metrics not listed are not available.",
].join("\n");
// Nothing in the last hour, but an incident earlier in the 6 hours, and the latest minute flagged.
const EARLIER = [
  "FACTS (snapshot 2026-11-22T00:48:00Z, times in MYT, UTC+8)",
  "anomaly latest: 08:46, score 0.512, threshold 0.458, flagged yes, tier low",
  "incidents last 6 h: 1 (low 1, medium 0, high 0)",
  "- 06:32, tier low, signal cpu, 1 min, peak 0.718, deployment no, closed.",
  "Only the facts above are available. Logs, commit messages and metrics not listed are not available.",
].join("\n");

test("absence: the live false claim fails, in the FACTS window and in a named window", () => {
  assert.deepEqual(checkAnswer("There were no flagged anomalies or incidents reported.", HOUR),
    ["says there were no incidents, but the FACTS list 13 in the last 6 h"]);
  assert.deepEqual(checkAnswer("There were no incidents in the last hour.", HOUR),
    ["says there were no incidents, but the FACTS list 2 in the last 1 h"]);
  assert.deepEqual(checkAnswer("Nothing was flagged in the past 30 minutes.", HOUR, "Anything in the last 30 minutes?"),
    ["says there were no incidents, but the FACTS list 2 in the last 30 min"]);
  assert.deepEqual(checkAnswer("No anomalies over the last 2 hours; none were reported.", HOUR),
    ["says there were no incidents, but the FACTS list 3 in the last 2 h"]);
});

test("absence: correct claims pass", () => {
  assert.deepEqual(checkAnswer("There were no incidents in the last 6 hours.", QUIET), []);
  assert.deepEqual(checkAnswer("No anomalies were flagged and none were reported.", QUIET), []);
  // The named window is quiet even though the 6 hours are not.
  assert.deepEqual(checkAnswer("There were no incidents in the last hour.", EARLIER), []);
  assert.deepEqual(checkAnswer("Tiada insiden dalam sejam lepas.", EARLIER), []);
  assert.deepEqual(checkAnswer("There are no anomalies right now.", HOUR), []);
});

test("absence: Malay claims", () => {
  assert.deepEqual(checkAnswer("Tiada insiden dalam sejam lepas.", HOUR), ["says there were no incidents, but the FACTS list 2 in the last 1 h"]);
  assert.deepEqual(checkAnswer("Tiada anomali yang dilaporkan.", HOUR), ["says there were no incidents, but the FACTS list 13 in the last 6 h"]);
  assert.deepEqual(checkAnswer("Tiada apa-apa yang ditanda dalam 2 jam lepas.", HOUR), ["says there were no incidents, but the FACTS list 3 in the last 2 h"]);
  assert.deepEqual(checkAnswer("Tidak ada insiden dalam 6 jam lepas.", QUIET), []);
  assert.deepEqual(checkAnswer("Tiada apa-apa yang perlu dirisaukan.", HOUR), []);
});

test("absence: the present is checked against the latest minute only", () => {
  assert.deepEqual(checkAnswer("Nothing is flagged right now.", EARLIER), ["says nothing is flagged now, but the latest minute is flagged"]);
  assert.deepEqual(checkAnswer("Tiada anomali sekarang.", HOUR), []);
});

test("absence: negated, partial and subset sentences are left alone", () => {
  for (const neutral of [
    "Not every minute was flagged.",
    "Not all incidents were linked to a deployment.",
    "No incident is still open.",
    "There were no high incidents in the last hour.",
    "No incident was linked to a deployment.",
    "There were no memory incidents in the last hour.",
    "Tiada insiden terbuka.",
    "Two incidents were flagged in the last hour, at 08:17 and 08:19.",
  ]) assert.deepEqual(checkAnswer(neutral, HOUR), [], neutral);
});

test("absence: a false no-incident reply is retried once, then replaced by the fallback, with the reason logged", async (t) => {
  const { startApp } = require("./helpers");
  const { RETRY_LINE } = require("../routes/chat");
  const T = Date.UTC(2026, 9, 30, 8, 0, 0); // the helpers' clock
  // Two incidents, both inside the last hour from 16:00: 15:00 to 15:02 (closed) and 15:50 (open).
  const query = async (q) => {
    if (q.startsWith('SELECT * FROM "anomaly_score"')) {
      return [{ time: T - 120000, score: 0.347, threshold: 0.602, is_anomaly: 0, tier: "none", model: "v10",
        cpu_rate: 0.0029, memory_max_mb: 127, latency_ms: 1.5, base_cpu_rate: 0.0028, base_memory_max_mb: 124, base_latency_ms: 1.5 }];
    }
    if (q.includes('FROM "incident_explanation"')) {
      return [{ time: T - 3600000, tier: "medium", signal: "memory", minutes: 2, peak_score: 0.661, deployment: 0, explanation: "What happened: Memory." }];
    }
    if (q.includes('FROM "incident_open"')) return [{ time: T - 600000, tier: "low", signal: "cpu", minutes: 1, peak_score: 0.703, deployment: 0 }];
    return [];
  };
  const calls = [];
  const ollama = {
    canThink: async () => false,
    ping: async () => true,
    async chat(messages) {
      calls.push(messages);
      const text = calls.length === 1 ? "There were no flagged anomalies or incidents reported." : "Tiada insiden dalam sejam lepas.";
      return { text, promptTokens: 1, evalTokens: 1, evalMs: 1, loadMs: 0, latencyMs: 1 };
    },
  };
  const records = [];
  const chatLog = { enabled: true, async record(c, reply) { records.push({ calls: c, reply }); }, async stats() { return {}; } };
  const app = await startApp({ query, config: { chat: { prometheus: { query: async () => [] }, ollama, chatLog, env: {}, log: () => {} } } });
  t.after(app.close);
  await app.addUser("viewer@example.com", "viewer", "a long enough password");
  const { cookie } = await app.login("viewer@example.com", "a long enough password");
  const body = await (await app.request("/api/chat", { json: { message: "Summarise the last hour" }, headers: { cookie } })).json();
  assert.equal(calls.length, 2);
  assert.ok(calls[1][1].content.endsWith(`\n${RETRY_LINE}`));
  assert.equal(body.kind, "fallback");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(records[0].calls.map((c) => [c.attempt, c.checkPassed, c.rejected]), [
    [1, false, "says there were no incidents, but the FACTS list 2 in the last 6 h"],
    [2, false, "says there were no incidents, but the FACTS list 2 in the last 1 h"],
  ]);
});
