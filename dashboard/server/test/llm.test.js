const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { loadLlm, DAYS, SQL, EXPLAIN_TRACE, DAY_MS } = require("../llm");
const { TRACE_NAME: CHAT_TRACE } = require("../chat/log");

// 30 Oct 2026, 08:00 UTC, the same clock the test app uses.
const NOW = Date.UTC(2026, 9, 30, 8, 0, 0);
const TODAY = Date.UTC(2026, 9, 30);

// Strings that must never reach a response. The fake rows carry them under the column names of the
// real tables, as if a query had selected them.
const SECRET_INPUT = "SECRET-PROMPT-7f3a Why is memory high on the sample service";
const SECRET_OUTPUT = "SECRET-ANSWER-91bc What happened: memory rose";
const SECRET_USER = "SECRET-USER-5d20@example.com";

// A fake pg pool. Each query is answered by which SQL constant it is (and which trace name it was
// given for the models query); every query sent is recorded.
function fakePool({ fail = false, rows = {} } = {}) {
  const sent = [];
  const leak = { input: SECRET_INPUT, output: SECRET_OUTPUT, user_id: SECRET_USER };
  const defaults = {
    explanationTotal: [{ total: "40", llm: "36", template: "4", first_try: "30", median_ms: 30700, p95_ms: 61000, median_tokens: "240", ...leak }],
    explanationDaily: [
      { day: String(TODAY - DAY_MS), total: "18", llm: "17", template: "1", first_try: "15", median_ms: 29000, p95_ms: 58000, ...leak },
      { day: String(TODAY), total: "22", llm: "19", template: "3", first_try: "15", median_ms: 31000, p95_ms: 70000, ...leak },
    ],
    attempts: [{ attempts: 1, n: "30" }, { attempts: 2, n: "10" }],
    rejections: [
      { reason: "the number N is not in the facts", n: "5", ...leak },
      { reason: "it mentions a deployment, but there was none", n: "2" },
    ],
    models: { [EXPLAIN_TRACE]: [{ model: "qwen2.5:1.5b", n: "40" }], [CHAT_TRACE]: [{ model: "qwen2.5:1.5b", n: "14" }] },
    chatTotal: [{ replies: "12", llm: "10", fallback: "2", checked: "14", passed: "11", median_reply_s: 6.5, median_tok_s: 8.1, ...leak }],
    chatDaily: [{ day: String(TODAY), replies: "12", llm: "10", fallback: "2", checked: "14", passed: "11", median_reply_s: 6.5, median_tok_s: 8.1 }],
    chatKinds: [{ kind: "llm", n: "10" }, { kind: "fallback", n: "2" }],
    recent: [
      { time: String(NOW - 60000), name: EXPLAIN_TRACE, model: "qwen2.5:1.5b", latency_ms: 29400, tokens: 250, source: "llm", kind: null, attempts: "1", check_passed: null, rejected: "", ...leak },
      { time: String(NOW - 120000), name: CHAT_TRACE, model: "qwen2.5:1.5b", latency_ms: 6400, tokens: 60, source: null, kind: "llm", attempts: "1", check_passed: "true", rejected: null, ...leak },
    ],
  };
  const data = { ...defaults, ...rows };
  return {
    sent,
    async query(sql, params) {
      sent.push({ sql, params });
      if (fail) throw new Error("connection refused");
      for (const [name, text] of Object.entries(SQL)) {
        if (sql === text) {
          const value = data[name];
          return { rows: name === "models" ? value[params[0]] : value };
        }
      }
      throw new Error("unexpected SQL");
    },
  };
}

async function signedIn(t, pool) {
  const app = await startApp({ config: { llmPool: pool } });
  t.after(app.close);
  await app.addUser("viewer@example.com", "viewer", "a long enough password");
  const { cookie } = await app.login("viewer@example.com", "a long enough password");
  return (path) => app.request(path, { headers: { cookie } });
}

test("GET /api/llm needs a session", async (t) => {
  const app = await startApp({ config: { llmPool: fakePool() } });
  t.after(app.close);
  assert.equal((await app.request("/api/llm")).status, 401);
});

test("days must be 1, 7 or 30, and a bad value sends no query", async (t) => {
  const pool = fakePool();
  const get = await signedIn(t, pool);
  assert.deepEqual(DAYS, [1, 7, 30]);
  for (const bad of ["0", "2", "14", "31", "-7", "7.5", "abc", "7d", "7;DROP", "1e1", ""]) {
    const res = await get(`/api/llm?days=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, `days=${bad}`);
    assert.match((await res.json()).error, /days must be one of 1, 7, 30/);
  }
  assert.equal((await get("/api/llm?days=1&days=7")).status, 400);
  assert.equal(pool.sent.length, 0);
});

test("no pool gives 503, and the days check still comes first", async (t) => {
  const get = await signedIn(t, null);
  const res = await get("/api/llm?days=7");
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "LLM logging is not configured" });
  assert.equal((await get("/api/llm?days=9")).status, 400);
});

test("a query error gives 502", async (t) => {
  const get = await signedIn(t, fakePool({ fail: true }));
  const res = await get("/api/llm?days=7");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "the call log is unreachable" });
});

test("every query is parameterised with a constant trace name and a UTC start", async (t) => {
  const pool = fakePool();
  const get = await signedIn(t, pool);
  assert.equal((await get("/api/llm?days=7")).status, 200);
  assert.equal(pool.sent.length, 10);
  const since = new Date(NOW - 7 * DAY_MS).toISOString().replace("Z", "");
  for (const { sql, params } of pool.sent) {
    assert.match(sql, /\$1/);
    assert.match(sql, /\$2::timestamp/);
    assert.ok([EXPLAIN_TRACE, CHAT_TRACE].includes(params[0]), "the trace name is a constant");
    assert.equal(params[1], since);
    assert.ok(params.length === 2 || (params.length === 3 && params[2] === CHAT_TRACE));
    // The request value never appears in the SQL text.
    assert.doesNotMatch(sql, /interval|'7'|7 days/);
  }
  const names = pool.sent.map((s) => s.params[0]);
  assert.ok(names.includes(EXPLAIN_TRACE) && names.includes(CHAT_TRACE));
});

test("no query selects a prompt, an answer or a user id", () => {
  for (const [name, sql] of Object.entries(SQL)) {
    assert.doesNotMatch(sql, /\binput\b/i, `${name} reads input`);
    assert.doesNotMatch(sql, /\boutput\b/i, `${name} reads output`);
    assert.doesNotMatch(sql, /user_id/i, `${name} reads user_id`);
    assert.match(sql, /^SELECT /);
  }
});

test("the response holds the figures and none of the prompts, answers or user ids", async (t) => {
  const get = await signedIn(t, fakePool());
  const res = await get("/api/llm?days=7");
  assert.equal(res.status, 200);
  const raw = await res.text();
  for (const secret of [SECRET_INPUT, SECRET_OUTPUT, SECRET_USER, "SECRET-"]) {
    assert.ok(!raw.includes(secret), `the body leaks ${secret}`);
  }
  const keys = [];
  JSON.parse(raw, function walk(key, value) {
    keys.push(key);
    return value;
  });
  for (const forbidden of ["input", "output", "prompt", "prompts", "answer", "user_id", "userId", "user"]) {
    assert.ok(!keys.includes(forbidden), `the body has a ${forbidden} key`);
  }

  const body = JSON.parse(raw);
  assert.equal(body.days, 7);
  assert.equal(body.from, TODAY - 7 * DAY_MS);
  assert.equal(body.to, TODAY + DAY_MS);
  const e = body.explanations;
  assert.equal(e.total, 40);
  assert.equal(e.llm, 36);
  assert.equal(e.template, 4);
  assert.equal(e.firstTryRate, 0.75);
  assert.equal(e.templateRate, 0.1);
  assert.equal(e.medianMs, 30700);
  assert.equal(e.p95Ms, 61000);
  assert.equal(e.medianTokens, 240);
  assert.deepEqual(e.attempts, [{ attempts: 1, count: 30 }, { attempts: 2, count: 10 }]);
  assert.deepEqual(e.rejections[0], { reason: "the number N is not in the facts", count: 5 });
  assert.deepEqual(e.models, [{ model: "qwen2.5:1.5b", count: 40 }]);
  // Eight UTC dates from 23 Oct to 30 Oct, the empty ones filled with zeros.
  assert.equal(e.daily.length, 8);
  assert.equal(e.daily[0].day, TODAY - 7 * DAY_MS);
  assert.deepEqual(e.daily[0], { day: TODAY - 7 * DAY_MS, count: 0, llm: 0, template: 0, firstTry: 0, medianMs: null, p95Ms: null });
  assert.equal(e.daily[6].count, 18);
  assert.equal(e.daily[7].template, 3);
  const c = body.chat;
  assert.equal(c.replies, 12);
  assert.equal(c.checkRate, 11 / 14);
  assert.equal(c.medianReplyS, 6.5);
  assert.equal(c.medianTokS, 8.1);
  assert.deepEqual(c.kinds, [{ kind: "llm", count: 10 }, { kind: "fallback", count: 2 }]);
  assert.equal(c.daily.length, 8);
  assert.equal(c.daily[7].replies, 12);
  assert.equal(c.daily[0].checkRate, null);
  assert.equal(body.recent.length, 2);
  assert.deepEqual(body.recent[0], {
    time: NOW - 60000, trace: "explanation", model: "qwen2.5:1.5b", latencyMs: 29400, tokens: 250,
    source: "llm", kind: null, attempts: 1, checkPassed: null, rejected: null,
  });
  assert.equal(body.recent[1].trace, "chat");
  assert.equal(body.recent[1].checkPassed, true);
});

test("an empty call log gives zeros and nulls, never invented values", async () => {
  const empty = {
    explanationTotal: [{ total: "0", llm: "0", template: "0", first_try: "0", median_ms: null, p95_ms: null, median_tokens: null }],
    explanationDaily: [], attempts: [], rejections: [], models: { [EXPLAIN_TRACE]: [], [CHAT_TRACE]: [] },
    chatTotal: [{ replies: "0", llm: "0", fallback: "0", checked: "0", passed: "0", median_reply_s: null, median_tok_s: null }],
    chatDaily: [], chatKinds: [], recent: [],
  };
  const body = await loadLlm(fakePool({ rows: empty }), 1, NOW);
  assert.equal(body.explanations.total, 0);
  assert.equal(body.explanations.firstTryRate, null);
  assert.equal(body.explanations.medianMs, null);
  assert.equal(body.chat.checkRate, null);
  assert.equal(body.chat.medianTokS, null);
  assert.deepEqual(body.recent, []);
  // One day back from 08:00 reaches into the day before: two UTC dates.
  assert.equal(body.explanations.daily.length, 2);
});
