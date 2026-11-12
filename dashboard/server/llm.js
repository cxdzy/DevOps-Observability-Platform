// LLM view: every call to the local model, read from the call log in langfuse.trace and
// langfuse.observation. The explainer writes "incident-explanation" traces (CallLog in
// explainer/explainer.py) and the chat route writes "dashboard-chat" traces (chat/log.js).
//
// Only counts, medians and short labels leave this file. Prompts (observation.input), answers
// (observation.output) and user ids (trace.user_id) are never selected, so they cannot reach the
// response. Every query is parameterised: $1 is one of the two constant trace names and $2 is the
// start of the range. The numbers in the SQL text are fixed.
//
// timestamp_id is a timestamp without time zone in UTC. For an explanation it is the start of the
// incident, for a chat call it is the time of the call. observation.start_time is the time the
// call was logged and is used for the "recent calls" list. Days are UTC dates.
const { TRACE_NAME: CHAT_TRACE } = require("./chat/log");

const EXPLAIN_TRACE = "incident-explanation";
const DAY_MS = 24 * 60 * 60 * 1000;

// The days values the view offers. Anything else is a 400.
const DAYS = [1, 7, 30];

const RECENT_LIMIT = 20;
const REJECTION_LIMIT = 8;
const MODEL_LIMIT = 5;

const RANGE = "t.name = $1 AND t.timestamp_id >= $2::timestamp";
const JOIN = "FROM langfuse.trace t LEFT JOIN langfuse.observation o ON o.trace_id = t.id";
// A UTC date as milliseconds since the epoch. The epoch of a timestamp without time zone is nominal,
// so it does not depend on the session time zone.
const DAY_COLUMN = "(extract(epoch from date_trunc('day', t.timestamp_id)) * 1000)::bigint AS day";
const MEDIAN = (expr) => `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${expr})`;
// A metadata value as a number, or NULL when it is missing or not a JSON number. A plain cast would
// fail the whole query (and so the route) on a single bad row. The keys are fixed names from this file.
const NUMBER = (key) => `(CASE WHEN jsonb_typeof(t.metadata->'${key}') = 'number' THEN (t.metadata->>'${key}')::float END)`;

// Explanations, in total or per day. Latency and tokens come from the observation.
function explanationSql(perDay) {
  return (
    `SELECT ${perDay ? DAY_COLUMN + ", " : ""}count(*) AS total, ` +
    "count(*) FILTER (WHERE t.metadata->>'source' = 'llm') AS llm, " +
    "count(*) FILTER (WHERE t.metadata->>'source' = 'template') AS template, " +
    "count(*) FILTER (WHERE t.metadata->>'source' = 'llm' AND t.metadata->>'attempts' = '1') AS first_try, " +
    `${MEDIAN("o.latency_ms")} AS median_ms, ` +
    "percentile_cont(0.95) WITHIN GROUP (ORDER BY o.latency_ms) AS p95_ms, " +
    `${MEDIAN("o.usage_total_tokens")} AS median_tokens ` +
    `${JOIN} WHERE ${RANGE}` +
    (perDay ? " GROUP BY 1 ORDER BY 1" : "")
  );
}

// The explainer writes attempts as a JSON number; only whole numbers are counted, so the cast cannot fail.
const ATTEMPTS_SQL =
  "SELECT (t.metadata->>'attempts')::int AS attempts, count(*) AS n FROM langfuse.trace t " +
  `WHERE ${RANGE} AND t.metadata->>'attempts' ~ '^[0-9]{1,6}$' GROUP BY 1 ORDER BY 1`;

// The explainer stores the problems of the last rejected attempt as one text joined with "; ".
// They are split again here, numbers are replaced by N so that "the number 276 is not in the
// facts" and "the number 310 is not in the facts" count as one reason, and the text is cut.
const REJECTIONS_SQL =
  "SELECT left(regexp_replace(r.reason, '[0-9]+([.][0-9]+)?', 'N', 'g'), 120) AS reason, count(*) AS n " +
  "FROM langfuse.trace t CROSS JOIN LATERAL unnest(string_to_array(t.metadata->>'rejected', '; ')) AS r(reason) " +
  `WHERE ${RANGE} AND coalesce(t.metadata->>'rejected', '') <> '' AND r.reason <> '' ` +
  `GROUP BY 1 ORDER BY n DESC, reason LIMIT ${REJECTION_LIMIT}`;

const MODELS_SQL =
  `SELECT o.model AS model, count(*) AS n ${JOIN} WHERE ${RANGE} AND o.model IS NOT NULL ` +
  `GROUP BY o.model ORDER BY n DESC, o.model LIMIT ${MODEL_LIMIT}`;

// Chat, in total or per day. Only calls to the model are logged (one row per attempt), so a reply
// is a row with attempt 1. The check rate and the tokens per second cover every logged call.
function chatSql(perDay) {
  return (
    `SELECT ${perDay ? DAY_COLUMN + ", " : ""}` +
    "count(*) FILTER (WHERE t.metadata->>'attempt' = '1') AS replies, " +
    "count(*) FILTER (WHERE t.metadata->>'attempt' = '1' AND t.metadata->>'kind' = 'llm') AS llm, " +
    "count(*) FILTER (WHERE t.metadata->>'attempt' = '1' AND t.metadata->>'kind' = 'fallback') AS fallback, " +
    "count(*) FILTER (WHERE t.metadata->>'check_passed' IS NOT NULL) AS checked, " +
    "count(*) FILTER (WHERE t.metadata->>'check_passed' = 'true') AS passed, " +
    `${MEDIAN(NUMBER("reply_s"))} FILTER (WHERE t.metadata->>'attempt' = '1') AS median_reply_s, ` +
    `${MEDIAN(`${NUMBER("completion_tokens")} / NULLIF(${NUMBER("eval_duration_ms")}, 0) * 1000`)} AS median_tok_s ` +
    `FROM langfuse.trace t WHERE ${RANGE}` +
    (perDay ? " GROUP BY 1 ORDER BY 1" : "")
  );
}

const CHAT_KINDS_SQL =
  "SELECT t.metadata->>'kind' AS kind, count(*) AS n FROM langfuse.trace t " +
  `WHERE ${RANGE} AND t.metadata->>'attempt' = '1' AND t.metadata->>'kind' IS NOT NULL GROUP BY 1 ORDER BY n DESC, 1`;

// The newest calls of both kinds. $1 is the explanation name, $3 the chat name. The call time is
// the time the row was written (observation.start_time). No input, output or user id is selected.
const RECENT_SQL =
  "SELECT (extract(epoch from o.start_time) * 1000)::bigint AS time, t.name AS name, o.model AS model, " +
  "o.latency_ms AS latency_ms, o.usage_total_tokens AS tokens, " +
  "t.metadata->>'source' AS source, t.metadata->>'kind' AS kind, " +
  "coalesce(t.metadata->>'attempts', t.metadata->>'attempt') AS attempts, " +
  "t.metadata->>'check_passed' AS check_passed, left(t.metadata->>'rejected', 160) AS rejected " +
  `${JOIN} WHERE t.name IN ($1, $3) AND t.timestamp_id >= $2::timestamp ` +
  `ORDER BY o.start_time DESC NULLS LAST, t.id LIMIT ${RECENT_LIMIT}`;

// Every SQL string this file sends, for the tests.
const SQL = {
  explanationTotal: explanationSql(false),
  explanationDaily: explanationSql(true),
  attempts: ATTEMPTS_SQL,
  rejections: REJECTIONS_SQL,
  models: MODELS_SQL,
  chatTotal: chatSql(false),
  chatDaily: chatSql(true),
  chatKinds: CHAT_KINDS_SQL,
  recent: RECENT_SQL,
};

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function count(value) {
  return num(value) ?? 0;
}

function text(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function startOfDay(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function rate(part, whole) {
  return whole > 0 ? part / whole : null;
}

// One entry per UTC date from the date of `from` to the date of `now`, oldest first, filled from
// the rows by date. A date with no rows gets the empty entry.
function fillDays(rows, from, now, make, empty) {
  const byDay = new Map();
  for (const r of rows) {
    const day = num(r.day);
    if (day !== null) byDay.set(startOfDay(day), r);
  }
  const out = [];
  for (let day = startOfDay(from); day <= startOfDay(now); day += DAY_MS) {
    const row = byDay.get(day);
    out.push({ day, ...(row ? make(row) : empty) });
  }
  return out;
}

const EXPLANATION_EMPTY = { count: 0, llm: 0, template: 0, firstTry: 0, medianMs: null, p95Ms: null };
function explanationFigures(r) {
  return {
    count: count(r.total),
    llm: count(r.llm),
    template: count(r.template),
    firstTry: count(r.first_try),
    medianMs: num(r.median_ms),
    p95Ms: num(r.p95_ms),
  };
}

const CHAT_EMPTY = { replies: 0, llm: 0, fallback: 0, checked: 0, passed: 0, checkRate: null, medianReplyS: null, medianTokS: null };
function chatFigures(r) {
  const checked = count(r.checked);
  const passed = count(r.passed);
  return {
    replies: count(r.replies),
    llm: count(r.llm),
    fallback: count(r.fallback),
    checked,
    passed,
    checkRate: rate(passed, checked),
    medianReplyS: num(r.median_reply_s),
    medianTokS: num(r.median_tok_s),
  };
}

// Loads the whole view. pool: a pg pool for the langfuse database, days: one of DAYS, now: ms.
// Rejects when a query fails, so the route can answer 502.
async function loadLlm(pool, days, now) {
  const from = now - days * DAY_MS;
  // The same text form the explainer and the chat route write: UTC without the Z.
  const since = new Date(from).toISOString().replace("Z", "");
  const explain = [EXPLAIN_TRACE, since];
  const chat = [CHAT_TRACE, since];
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  // One query at a time. The pool is shared with the chat log and has two connections, and a request
  // that waits in its queue for more than 3 s fails, so ten queries at once could turn into a 502
  // and hold up a chat log write.
  const eTotal = await q(SQL.explanationTotal, explain);
  const eDaily = await q(SQL.explanationDaily, explain);
  const attempts = await q(SQL.attempts, explain);
  const rejections = await q(SQL.rejections, explain);
  const eModels = await q(SQL.models, explain);
  const cTotal = await q(SQL.chatTotal, chat);
  const cDaily = await q(SQL.chatDaily, chat);
  const cKinds = await q(SQL.chatKinds, chat);
  const cModels = await q(SQL.models, chat);
  const recent = await q(SQL.recent, [EXPLAIN_TRACE, since, CHAT_TRACE]);

  const e = eTotal[0] || {};
  const total = count(e.total);
  const llm = count(e.llm);
  const c = chatFigures(cTotal[0] || {});
  const models = (rows) => rows.map((r) => ({ model: text(r.model), count: count(r.n) }));

  return {
    days,
    from: startOfDay(from),
    to: startOfDay(now) + DAY_MS,
    explanations: {
      total,
      llm,
      template: count(e.template),
      firstTry: count(e.first_try),
      // Share of all explanations that the LLM wrote on the first attempt, and share that fell back.
      firstTryRate: rate(count(e.first_try), total),
      templateRate: rate(count(e.template), total),
      medianMs: num(e.median_ms),
      p95Ms: num(e.p95_ms),
      medianTokens: num(e.median_tokens),
      attempts: attempts.map((r) => ({ attempts: count(r.attempts), count: count(r.n) })),
      rejections: rejections.map((r) => ({ reason: text(r.reason) ?? "unknown", count: count(r.n) })),
      models: models(eModels),
      daily: fillDays(eDaily, from, now, explanationFigures, EXPLANATION_EMPTY),
    },
    chat: {
      ...c,
      kinds: cKinds.map((r) => ({ kind: text(r.kind) ?? "unknown", count: count(r.n) })),
      models: models(cModels),
      daily: fillDays(cDaily, from, now, chatFigures, CHAT_EMPTY),
    },
    recent: recent.map((r) => ({
      time: num(r.time),
      trace: r.name === CHAT_TRACE ? "chat" : "explanation",
      model: text(r.model),
      latencyMs: num(r.latency_ms),
      tokens: num(r.tokens),
      source: text(r.source),
      kind: text(r.kind),
      attempts: num(r.attempts),
      checkPassed: r.check_passed === "true" ? true : r.check_passed === "false" ? false : null,
      rejected: text(r.rejected),
    })),
  };
}

module.exports = { loadLlm, DAYS, SQL, EXPLAIN_TRACE, DAY_MS };
