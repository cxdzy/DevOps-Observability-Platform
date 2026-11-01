const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, ORIGIN } = require("./helpers");
const { createOllama, OllamaError } = require("../chat/ollama");
const { createLimits } = require("../chat/limits");
const { createChatLog, langfuseUrl } = require("../chat/log");
const { SYSTEM_PROMPT, RETRY_LINE } = require("../routes/chat");

const T = Date.UTC(2026, 9, 30, 8, 0, 0); // the helpers' clock

function fakeQuery() {
  return async (q) => {
    if (q.startsWith('SELECT * FROM "anomaly_score"')) {
      return [{ time: T - 120000, score: 0.347, threshold: 0.602, is_anomaly: 0, tier: "none", model: "v10",
        cpu_rate: 0.0029, memory_max_mb: 127, latency_ms: 1.5, base_cpu_rate: 0.0028, base_memory_max_mb: 124, base_latency_ms: 1.5 }];
    }
    if (q.includes('FROM "incident_explanation"')) {
      return [{ time: T - 3600000, tier: "medium", signal: "memory", minutes: 2, peak_score: 0.661, deployment: 0,
        explanation: "What happened: Memory use spiked to 276 MB." }];
    }
    if (q.includes('FROM "incident_open"')) return [{ time: T - 600000, tier: "low", signal: "cpu", minutes: 1, peak_score: 0.703, deployment: 0 }];
    return [];
  };
}

const prometheus = { query: async () => [] };

// answers: texts (or Errors to throw) returned by the model call in order.
function fakeOllama(answers = ["The latest anomaly score is 0.347 at 15:58."]) {
  const calls = [];
  return {
    calls,
    model: "fake-model",
    canThink: async () => false,
    ping: async () => true,
    async chat(messages, timeoutMs) {
      calls.push({ messages, timeoutMs });
      const next = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next();
      return { text: next, promptTokens: 800, evalTokens: 40, evalMs: 2000, loadMs: 5, latencyMs: 2500 };
    },
  };
}

function fakeLog({ fail = false } = {}) {
  const records = [];
  return {
    records,
    enabled: true,
    async record(calls, reply) {
      if (fail) throw new Error("database down");
      records.push({ calls, reply });
    },
    async stats() {
      return { replies: 3, medianReplyS: 11.8, medianTokS: 8.1 };
    },
  };
}

async function setup(t, { role = "admin", ollama = fakeOllama(), chatLog = fakeLog(), env = {}, limits } = {}) {
  const app = await startApp({ query: fakeQuery(), config: { chat: { prometheus, ollama, chatLog, env, limits, log: () => {} } } });
  t.after(app.close);
  await app.addUser(`${role}@example.com`, role, "a long enough password");
  const { cookie } = await app.login(`${role}@example.com`, "a long enough password");
  const ask = (message) => app.request("/api/chat", { json: { message }, headers: { cookie } });
  const stats = () => app.request("/api/chat/stats", { headers: { cookie } });
  return { app, ask, stats, cookie, ollama, chatLog };
}

test("chat needs a session", async (t) => {
  const app = await startApp({ query: fakeQuery(), config: { chat: { prometheus, ollama: fakeOllama(), chatLog: fakeLog() } } });
  t.after(app.close);
  assert.equal((await app.request("/api/chat", { json: { message: "hi" } })).status, 401);
  assert.equal((await app.request("/api/chat/stats")).status, 401);
});

test("JSON and the app origin are required", async (t) => {
  const { app, cookie } = await setup(t);
  const bad = await app.request("/api/chat", { json: { message: "hi" }, headers: { cookie, origin: "https://evil.example" } });
  assert.equal(bad.status, 403);
  const text = await app.request("/api/chat", { method: "POST", body: "message=hi", headers: { cookie, origin: ORIGIN, "content-type": "text/plain" } });
  assert.equal(text.status, 415);
});

test("message length: 1 to 500 characters after trimming and removing control characters", async (t) => {
  const { ask, ollama } = await setup(t);
  assert.equal((await ask("x".repeat(501))).status, 400);
  assert.equal((await ask(" \u0000\u0007 ")).status, 400);
  assert.equal((await ask(42)).status, 400);
  const ok = await ask(`  ${"y".repeat(500)}  `);
  assert.equal(ok.status, 200);
  assert.equal(ollama.calls.length, 1);
  assert.match(ollama.calls[0].messages[1].content, /QUESTION: y{500}$/);
});

test("model question: messages, facts and response shape", async (t) => {
  const { ask, ollama, chatLog } = await setup(t);
  const res = await ask("Should I be worried\u0007 right now?");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "llm");
  assert.equal(body.answer, "The latest anomaly score is 0.347 at 15:58.");
  assert.equal(body.model, "qwen2.5:1.5b");
  assert.ok(Array.isArray(body.sources) && body.sources.length > 0);
  assert.equal(typeof body.elapsed_s, "number");
  const [system, user] = ollama.calls[0].messages;
  assert.deepEqual(system, { role: "system", content: SYSTEM_PROMPT });
  assert.match(user.content, /^Request [0-9a-f]{8}\nFACTS \(snapshot /);
  assert.match(user.content, /\n\nQUESTION: Should I be worried right now\?$/);
  assert.match(user.content, /^incidents last 6 h: 2 \(low 1, medium 1, high 0\)$/m);
  assert.ok(ollama.calls[0].timeoutMs <= 90000 && ollama.calls[0].timeoutMs > 80000);
  // Stateless: a second question sends no earlier turns, and gets a new request line.
  await ask("And now?");
  assert.equal(ollama.calls[1].messages.length, 2);
  assert.notEqual(ollama.calls[1].messages[1].content.slice(0, 17), user.content.slice(0, 17));
  await new Promise((r) => setImmediate(r));
  assert.equal(chatLog.records.length, 2);
  const rec = chatLog.records[0];
  assert.deepEqual(rec.reply.role, "admin");
  assert.equal(rec.reply.kind, "llm");
  assert.equal(rec.calls[0].attempt, 1);
  assert.equal(rec.calls[0].checkPassed, true);
  assert.ok(!JSON.stringify(rec).includes("@example.com"), "no email in the log");
});

test("an answer with a number not in FACTS is retried once, then replaced by the fallback", async (t) => {
  const ollama = fakeOllama(["The score is 0.99.", "I restarted it at 09:99."]);
  const { ask, chatLog } = await setup(t, { ollama });
  const body = await (await ask("What is the score?")).json();
  assert.equal(ollama.calls.length, 2);
  assert.ok(ollama.calls[1].messages[1].content.endsWith(`\n${RETRY_LINE}`));
  assert.equal(body.kind, "fallback");
  assert.equal(body.answer, "I could not answer that reliably from the data. The dashboard covers the last 6 hours: " +
    "incidents last 6 h: 2 (low 1, medium 1, high 0); by signal: cpu 1, memory 1, latency 0, unclear 0. " +
    "Ask about a specific incident, the score or a node.");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(chatLog.records[0].calls.map((c) => [c.attempt, c.checkPassed]), [[1, false], [2, false]]);
  assert.equal(chatLog.records[0].reply.kind, "fallback");
});

test("the fallback is in Malay for a Malay question", async (t) => {
  const ollama = fakeOllama(["Skor ialah 0.99.", "Skor ialah 0.98."]);
  const { ask } = await setup(t, { ollama });
  const body = await (await ask("Apa skor sekarang?")).json();
  assert.equal(body.kind, "fallback");
  assert.match(body.answer, /^Saya tidak dapat menjawab soalan itu dengan tepat daripada data\. Dashboard meliputi 6 jam lepas: incidents last 6 h: 2 /);
  assert.match(body.answer, /\. Tanya tentang insiden tertentu, skor atau nod\.$/);
});

test("a number from the question passes the check", async (t) => {
  const ollama = fakeOllama(["The dashboard has no data for the last 48 hours of scores."]);
  const { ask } = await setup(t, { ollama });
  const body = await (await ask("What were the scores over 48 hours?")).json();
  assert.equal(body.kind, "llm");
  assert.equal(ollama.calls.length, 1);
});

test("incident counts are template answers that state the 6 hour window", async (t) => {
  const { ask, ollama } = await setup(t, { env: { CHAT_RATE_PER_HOUR: "1" } });
  const head = "In the last 6 hours (the dashboard keeps no older incident data here): 2 incidents, high 0, medium 1, low 1.";
  const high = await (await ask("how many high incidents in 24hours")).json();
  assert.equal(high.kind, "template");
  assert.equal(high.answer, `${head} Older incidents are on the Incidents page.`);
  assert.deepEqual(high.sources, ["incident records"]);
  const sig = await (await ask("How many cpu incidents in the last 6 hours?")).json();
  assert.equal(sig.answer, `${head} By signal: cpu 1, memory 1, latency 0, unclear 0.`);
  const malay = await (await ask("Berapa insiden memori minggu ini?")).json();
  assert.equal(malay.answer, "Dalam 6 jam lepas (dashboard tidak menyimpan data insiden yang lebih lama di sini): 2 insiden, " +
    "high 0, medium 1, low 1. Mengikut isyarat: cpu 1, memory 1, latency 0, unclear 0. Insiden yang lebih lama ada di halaman Incidents.");
  assert.equal(ollama.calls.length, 0);
});

test("a retry that passes is a normal model answer", async (t) => {
  const ollama = fakeOllama(["The score is 0.99.", "The score is 0.347."]);
  const { ask } = await setup(t, { ollama });
  const body = await (await ask("What is the score?")).json();
  assert.equal(body.kind, "llm");
  assert.equal(body.answer, "The score is 0.347.");
});

test("Ollama down or timing out gives 503 and nothing else", async (t) => {
  const ollama = fakeOllama([new OllamaError("timeout")]);
  const { ask } = await setup(t, { ollama });
  const res = await ask("What is the score?");
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "The local model did not answer. Nothing was changed." });
});

test("a question that got a 503 is not counted toward the rate limit", async (t) => {
  const ollama = fakeOllama([new OllamaError("unreachable"), "The score is 0.347."]);
  const { ask, stats } = await setup(t, { ollama, env: { CHAT_RATE_PER_HOUR: "1" } });
  assert.equal((await ask("What is the score?")).status, 503);
  assert.equal((await (await stats()).json()).questionsLeft, 1);
  assert.equal((await ask("What is the score?")).status, 200);
  assert.equal((await (await stats()).json()).questionsLeft, 0);
});

test("a logging failure does not break the reply", async (t) => {
  const { ask } = await setup(t, { chatLog: fakeLog({ fail: true }) });
  const res = await ask("What is the score?");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).kind, "llm");
});

test("action words: fixed replies for admin and viewer, no model call", async (t) => {
  const admin = await setup(t, { role: "admin" });
  const a = await (await admin.ask("Restart sample-service")).json();
  assert.equal(a.kind, "action_unavailable");
  assert.equal(a.answer, "Restart requests from the dashboard are not connected yet. Use the Telegram approval for now.");
  const viewer = await setup(t, { role: "viewer" });
  const v = await (await viewer.ask("roll back the deployment")).json();
  assert.equal(v.kind, "action_unavailable");
  assert.equal(v.answer, "Only an admin can request a restart, and every restart needs a Telegram approval.");
  assert.equal(admin.ollama.calls.length + viewer.ollama.calls.length, 0);
  // A negated action word is a normal question.
  const q = await (await viewer.ask("Don't restart anything, just tell me if memory looks normal.")).json();
  assert.equal(q.kind, "llm");
});

test("guard and template replies do not call the model or use the rate limit", async (t) => {
  const { ask, ollama, stats } = await setup(t, { env: { CHAT_RATE_PER_HOUR: "1" } });
  const guard = await (await ask("What was the disk I/O on sample-service at 03:00 yesterday?")).json();
  assert.equal(guard.kind, "guard");
  assert.match(guard.answer, /^The dashboard has no data for that\./);
  const malay = await (await ask("Bagaimana cuaca hari ini?")).json();
  assert.match(malay.answer, /^Dashboard tiada data untuk itu\./);
  const last = await (await ask("Last incident")).json();
  assert.equal(last.kind, "template");
  assert.match(last.answer, /^The last incident started at 15:50: tier low, signal cpu, 1 min, peak 0\.703, open\.$/);
  assert.deepEqual(last.incidents, [{ start: T - 600000, tier: "low" }]);
  const status = await (await ask("System status")).json();
  assert.equal(status.kind, "template");
  assert.match(status.answer, /2 incidents in the last 6 hours, 1 still open\./);
  const health = await (await ask("Health check")).json();
  assert.equal(health.kind, "template");
  assert.match(health.answer, /There is no data for fyp-main\./);
  assert.equal(ollama.calls.length, 0);
  assert.equal((await (await stats()).json()).questionsLeft, 1);
});

test("rate limit: CHAT_RATE_PER_HOUR model questions per user per rolling hour", async (t) => {
  const { app, ask, stats } = await setup(t, { env: { CHAT_RATE_PER_HOUR: "2" } });
  assert.equal((await ask("one?")).status, 200);
  app.clock.t += 10 * 60 * 1000;
  assert.equal((await ask("two?")).status, 200);
  assert.equal((await (await stats()).json()).questionsLeft, 0);
  const res = await ask("three?");
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.nextFreeAt, T + 60 * 60 * 1000);
  assert.match(body.error, /^You have used all 2 questions for this hour\. The next one is free at 17:00 MYT\.$/);
  app.clock.t = T + 60 * 60 * 1000 + 1;
  assert.equal((await ask("four?")).status, 200);
});

test("queue: one call in flight, one waiting, the next gets 429 busy", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { await gate; return { text: "ok", promptTokens: 1, evalTokens: 1, evalMs: 1, loadMs: 0, latencyMs: 1 }; };
  const ollama = fakeOllama([slow, slow, slow]);
  const { ask, app } = await setup(t, { ollama });
  await app.addUser("other@example.com", "viewer", "a long enough password");
  const other = await app.login("other@example.com", "a long enough password");
  const first = ask("first?");
  await new Promise((r) => setTimeout(r, 50));
  const second = ask("second?");
  await new Promise((r) => setTimeout(r, 50));
  const third = await app.request("/api/chat", { json: { message: "third?" }, headers: { cookie: other.cookie } });
  assert.equal(third.status, 429);
  assert.deepEqual(await third.json(), { error: "The assistant is busy. Try again in a minute." });
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(ollama.calls.length, 2);
  // The busy reply did not use a question of the third user.
  assert.equal((await (await app.request("/api/chat/stats", { headers: { cookie: other.cookie } })).json()).questionsLeft, 20);
});

test("stats: model, replies, medians and questions left", async (t) => {
  const { stats } = await setup(t, { env: { CHAT_MODEL: "qwen2.5:3b" } });
  const body = await (await stats()).json();
  assert.deepEqual(body, { model: "qwen2.5:3b", replies: 3, medianReplyS: 11.8, medianTokS: 8.1, questionsLeft: 20, perHour: 20, ollamaUp: true });
});

test("limits module: rolling hour and slot release", async () => {
  let now = 0;
  const limits = createLimits({ perHour: 1, now: () => now });
  assert.deepEqual(limits.checkRate(1), { ok: true });
  limits.consume(1);
  assert.deepEqual(limits.checkRate(1), { ok: false, nextFreeAt: 3600000 });
  now = 3600001;
  assert.deepEqual(limits.checkRate(1), { ok: true });
  const r1 = await limits.acquire();
  const waiting = limits.acquire();
  assert.equal(limits.acquire(), null);
  r1();
  r1(); // releasing twice frees only once
  const r2 = await waiting;
  assert.notEqual(limits.acquire(), null); // the slot is held by r2, one may wait again
  r2();
});

// ------------------------------------------------------------------ ollama.js

function fakeFetch({ capabilities = ["completion"], chat } = {}) {
  const sent = [];
  const impl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    sent.push({ url, body, method: init.method });
    if (url.endsWith("/api/show")) return new Response(JSON.stringify({ capabilities }), { status: 200 });
    if (url.endsWith("/api/chat")) {
      if (chat) return chat(init);
      return new Response(JSON.stringify({ message: { content: " hi " }, prompt_eval_count: 5, eval_count: 7,
        eval_duration: 2e9, load_duration: 3e8 }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return { impl, sent };
}

test("think false is sent only for a thinking-capable model, and /api/show is cached", async () => {
  const thinking = fakeFetch({ capabilities: ["completion", "thinking"] });
  const a = createOllama({ url: "http://o", model: "qwen3.5:2b", keepAlive: "5m", fetchImpl: thinking.impl });
  const r = await a.chat([{ role: "user", content: "x" }], 1000);
  await a.chat([{ role: "user", content: "y" }], 1000);
  assert.deepEqual(r, { text: "hi", promptTokens: 5, evalTokens: 7, evalMs: 2000, loadMs: 300, latencyMs: r.latencyMs });
  const chats = thinking.sent.filter((s) => s.url.endsWith("/api/chat"));
  assert.equal(chats[0].body.think, false);
  assert.equal(chats[0].body.stream, false);
  assert.equal(chats[0].body.keep_alive, "5m");
  assert.deepEqual(chats[0].body.options, { temperature: 0, seed: 42, num_predict: 200, num_ctx: 2048 });
  assert.equal(thinking.sent.filter((s) => s.url.endsWith("/api/show")).length, 1);

  const plain = fakeFetch();
  const b = createOllama({ url: "http://o", model: "qwen2.5:1.5b", fetchImpl: plain.impl });
  await b.chat([{ role: "user", content: "x" }], 1000);
  assert.ok(!("think" in plain.sent.find((s) => s.url.endsWith("/api/chat")).body));
});

test("an /api/show failure is not cached and sends no think flag", async () => {
  let up = false;
  const base = fakeFetch({ capabilities: ["thinking"] });
  const impl = async (url, init) => {
    if (url.endsWith("/api/show") && !up) throw new TypeError("fetch failed");
    return base.impl(url, init);
  };
  const o = createOllama({ url: "http://o", model: "m", fetchImpl: impl });
  assert.equal(await o.canThink(), false);
  up = true;
  assert.equal(await o.canThink(), true);
});

test("ollama client timeout and errors are OllamaError", async () => {
  const hang = fakeFetch({ chat: (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) });
  const o = createOllama({ url: "http://o", model: "m", fetchImpl: hang.impl });
  await assert.rejects(o.chat([], 30), (err) => err instanceof OllamaError && err.message === "timeout");
  const bad = fakeFetch({ chat: () => new Response("{}", { status: 500 }) });
  await assert.rejects(createOllama({ url: "http://o", model: "m", fetchImpl: bad.impl }).chat([], 1000), OllamaError);
  const down = createOllama({ url: "http://o", model: "m", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(down.chat([], 1000), (err) => err.message === "unreachable");
});

// ------------------------------------------------------------------ log.js

test("log: two inserts per call in the explainer's columns, failures are swallowed", async () => {
  const sql = [];
  const client = {
    async query(text, params) {
      sql.push({ text, params });
      if (text.startsWith("INSERT INTO langfuse.trace")) return { rows: [{ id: "trace-1" }] };
      return { rows: [] };
    },
    release() {},
  };
  const logLines = [];
  const chatLog = createChatLog({ pool: { connect: async () => client, query: async () => ({ rows: [] }) }, log: (l) => logLines.push(l) });
  await chatLog.record(
    [{ prompt: "P", answer: "A", latencyMs: 2500, promptTokens: 800, evalTokens: 40, evalMs: 2000, loadMs: 5, attempt: 1, checkPassed: true }],
    { kind: "llm", model: "qwen2.5:1.5b", userId: 7, role: "viewer", replyS: 2.6, anomalyScore: 0.347 }
  );
  const writes = sql.filter((s) => /^INSERT/.test(s.text));
  assert.equal(writes.length, 2);
  assert.match(writes[0].text, /^INSERT INTO langfuse\.trace \(name, timestamp_id, metadata, user_id, anomaly_score\)/);
  assert.equal(writes[0].params[0], "dashboard-chat");
  assert.deepEqual(JSON.parse(writes[0].params[2]), { kind: "llm", attempt: 1, check_passed: true, user_id: "7", role: "viewer",
    prompt_tokens: 800, completion_tokens: 40, eval_duration_ms: 2000, load_duration_ms: 5, reply_s: 2.6 });
  assert.match(writes[1].text, /^INSERT INTO langfuse\.observation \(trace_id, type, input, output, latency_ms, usage_total_tokens, model, start_time\)/);
  assert.deepEqual(writes[1].params, ["trace-1", "generation", "P", "A", 2500, 840, "qwen2.5:1.5b"]);
  // Only the two inserts and the transaction around them.
  for (const s of sql) assert.match(s.text, /^(BEGIN|COMMIT|ROLLBACK|INSERT INTO langfuse\.(trace|observation) )/);

  const broken = createChatLog({ pool: { connect: async () => { throw new Error("no route"); } }, log: (l) => logLines.push(l) });
  await broken.record([{ attempt: 1 }], { userId: 1 });
  assert.match(logLines.at(-1), /^could not log the chat call to PostgreSQL/);
  assert.deepEqual(await createChatLog({ pool: null }).stats(), { replies: null, medianReplyS: null, medianTokS: null });
});

test("the langfuse URL keeps the dashboard role and swaps only the database", () => {
  assert.equal(langfuseUrl("postgres://dashboard:pw@postgres:5432/dashboard", "fyp_observability"),
    "postgres://dashboard:pw@postgres:5432/fyp_observability");
  assert.equal(langfuseUrl("postgres://dashboard:pw@postgres:5432/dashboard", ""), null);
  assert.equal(langfuseUrl("", "x"), null);
});
