// Chat call log in langfuse.trace and langfuse.observation, the same tables and columns the
// explainer writes (CallLog in explainer/explainer.py). These two INSERTs and the stats SELECT are
// the only SQL here. The pool connects to LANGFUSE_DB_NAME with the dashboard role and password
// from DATABASE_URL (granted by dashboard/db/dashboard_chat_grant.sql). No email is logged.
// A logging failure is written to the console and never reaches the reply.
const { Pool } = require("pg");

const TRACE_NAME = "dashboard-chat";

// DATABASE_URL with its database name replaced. pg reads the database from the URL, so the name
// has to be changed there, not passed next to it. Returns null when either value is missing or the
// URL does not parse. The URL holds the password, so it is never logged.
function langfuseUrl(databaseUrl, dbName) {
  if (!databaseUrl || !dbName) return null;
  try {
    const url = new URL(databaseUrl);
    url.pathname = `/${encodeURIComponent(dbName)}`;
    return url.toString();
  } catch {
    return null;
  }
}

function createPool(env = process.env) {
  const connectionString = langfuseUrl(env.DATABASE_URL, env.LANGFUSE_DB_NAME);
  if (!connectionString) return null;
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000 });
  pool.on("error", (err) => console.error("langfuse pool error:", err.message));
  return pool;
}

// pool: a pg pool, or null to turn logging off. log: console-style line logger.
function createChatLog({ pool, log = console.error } = {}) {
  // calls: [{ prompt, answer, latencyMs, promptTokens, evalTokens, evalMs, loadMs, attempt, checkPassed }]
  // reply: { kind, model, userId, role, replyS, anomalyScore }
  async function record(calls, reply) {
    if (!pool) return;
    try {
      for (const call of calls) {
        const metadata = {
          kind: reply.kind,
          attempt: call.attempt,
          check_passed: call.checkPassed,
          user_id: String(reply.userId),
          role: reply.role,
          prompt_tokens: call.promptTokens,
          completion_tokens: call.evalTokens,
          eval_duration_ms: call.evalMs,
          load_duration_ms: call.loadMs,
          reply_s: reply.replyS,
        };
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const { rows } = await client.query(
            "INSERT INTO langfuse.trace (name, timestamp_id, metadata, user_id, anomaly_score) " +
              "VALUES ($1, $2, $3, $4, $5) RETURNING id",
            // timestamp_id is a timestamp without time zone, in UTC like the explainer's rows.
            [TRACE_NAME, new Date().toISOString().replace("Z", ""), JSON.stringify(metadata), String(reply.userId), reply.anomalyScore ?? 0]
          );
          await client.query(
            "INSERT INTO langfuse.observation (trace_id, type, input, output, latency_ms, usage_total_tokens, model, start_time) " +
              "VALUES ($1, $2, $3, $4, $5, $6, $7, now())",
            [rows[0].id, "generation", call.prompt, call.answer, call.latencyMs, (call.promptTokens || 0) + (call.evalTokens || 0), reply.model]
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
    } catch (err) {
      log(`could not log the chat call to PostgreSQL (${err && err.message})`);
    }
  }

  // Replies in the last 24 hours (first attempts only), median reply time and median tokens per
  // second over every call. Returns nulls when logging is off or the query fails.
  async function stats() {
    const empty = { replies: null, medianReplyS: null, medianTokS: null };
    if (!pool) return empty;
    try {
      const { rows } = await pool.query(
        "SELECT count(*) FILTER (WHERE metadata->>'attempt' = '1') AS replies, " +
          "percentile_cont(0.5) WITHIN GROUP (ORDER BY (metadata->>'reply_s')::float) " +
          "FILTER (WHERE metadata->>'attempt' = '1') AS median_reply_s, " +
          "percentile_cont(0.5) WITHIN GROUP (ORDER BY (metadata->>'completion_tokens')::float / " +
          "NULLIF((metadata->>'eval_duration_ms')::float, 0) * 1000) AS median_tok_s " +
          "FROM langfuse.trace WHERE name = $1 AND timestamp_id > (now() AT TIME ZONE 'UTC') - interval '24 hours'",
        [TRACE_NAME]
      );
      const r = rows[0] || {};
      const n = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
      return { replies: n(r.replies) ?? 0, medianReplyS: n(r.median_reply_s), medianTokS: n(r.median_tok_s) };
    } catch (err) {
      log(`could not read chat stats from PostgreSQL (${err && err.message})`);
      return empty;
    }
  }

  return { record, stats, enabled: Boolean(pool) };
}

module.exports = { createChatLog, createPool, langfuseUrl, TRACE_NAME };
