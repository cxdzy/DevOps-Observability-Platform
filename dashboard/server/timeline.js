// The timeline of one incident, built only from rows that are stored: early_warning, anomaly_score,
// incident_open, remediation_action and incident_explanation. A step whose data is missing is left
// out; nothing is guessed. buildSteps is a pure function so it can be unit tested without HTTP.
//
// "Asked on Telegram" is left out on purpose: the time the approval question was sent is not stored
// yet (remediation_action is written only when the request is answered), so there is nothing to show.

const { outcomeOf, familyOf } = require("./events");
const { matchRestarts, MATCH_WINDOW_MS: ACTION_MATCH_MS } = require("./remediation");

const MINUTE = 60000;
// The window around an incident: this long before the start and after the end.
const BEFORE_MS = 30 * MINUTE;
const AFTER_MS = 20 * MINUTE;
// The whole window never covers more than this.
const MAX_WINDOW_MS = 6 * 60 * MINUTE;
// The latest early warning counts when it came at most this long before the incident.
const WARNING_LOOKBACK_MS = 30 * MINUTE;
// The first flagged minute is looked for from this long before the incident start.
const FIRST_FLAG_SLACK_MS = 2 * MINUTE;
// Flagged minutes at most this far apart belong to one incident (the explainer's INCIDENT_GAP_MINUTES).
const INCIDENT_GAP_MS = 2 * MINUTE;
// An incident closes after this many quiet minutes (the explainer's CLOSE_AFTER_MINUTES default).
const QUIET_MINUTES_TO_CLOSE = 4;
// A warm-up run belongs to an action when it starts from this long before to this long after it.
const WARMUP_BEFORE_MS = 2 * MINUTE;
const WARMUP_AFTER_MS = 5 * MINUTE;
// The explanation row has the incident's start as its time; allow the explainer's merge window.
const EXPLANATION_MATCH_MS = 2 * MINUTE;
// The explainer writes incident_open and incident_explanation at the same start, but the incident
// list treats rows up to 120 s apart as one incident, so the open row is looked for in this window
// and the nearest one is used. Two incidents always start more than 2 minutes apart.
const OPEN_MATCH_MS = 2 * MINUTE;
// start must be inside this many days.
const MAX_AGE_MS = 15 * 24 * 60 * MINUTE;

const JOB_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function flag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function step(time, kind, title, detail, source, family) {
  return { time, kind, title, detail, source, family };
}

// Validates the query string. Returns { start, job } or { error }. Nothing here reaches a query
// unless it passed.
function parseParams(query, nowMs) {
  const rawStart = query.start;
  const rawJob = query.job;
  if (typeof rawStart !== "string" || !/^\d{1,16}$/.test(rawStart)) {
    return { error: "start must be an integer in milliseconds" };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start > nowMs || start < nowMs - MAX_AGE_MS) {
    return { error: "start must be within the last 15 days" };
  }
  if (typeof rawJob !== "string" || !JOB_PATTERN.test(rawJob)) {
    return { error: "job is not valid" };
  }
  return { start, job: rawJob };
}

// The window in ms for an incident from start to end (see incidentEnd): from 30 minutes before the
// start to 20 minutes after the end, but never later than 6 hours after the start.
function windowOf(start, end) {
  const from = start - BEFORE_MS;
  const to = Math.min(Math.max(start, end) + AFTER_MS, start + MAX_WINDOW_MS);
  return { from, to, end };
}

// The end of an incident. The explanation's end_time when it is stored (the explainer's last
// flagged minute). Otherwise the last is_anomaly = 1 minute for this job at or after the start and
// before the next incident_open for the same job, so a long incident with few flagged minutes still
// gets its whole span. Without either, start plus its flagged minutes. flagged is any list of
// anomaly_score rows; nextStart is the next incident's start or null.
function incidentEnd(start, minutes, explanation, flagged, nextStart) {
  const stored = explanation ? Date.parse(text(explanation.end_time) || "") : NaN;
  if (Number.isFinite(stored)) return Math.round(stored);
  let last = null;
  for (const p of flagged || []) {
    if (!valid(p) || !isFlagged(p)) continue;
    const t = num(p.time);
    if (t < start || (nextStart !== null && t >= nextStart)) continue;
    if (last === null || t > last) last = t;
  }
  return last !== null ? last : start + Math.max(0, minutes) * MINUTE;
}

// The actions that belong to this incident: each remediation_action row is matched to an incident
// the same way the Remediation view does it (matchRestarts in remediation.js: same job, the latest
// incident that started at or before the action and at most 30 minutes earlier), and only the rows
// matched to this incident's start (within the open-row tolerance) are kept. Rollback rows follow
// the same rule, so "Rollback not run" depends only on this incident. opens are the incident_open
// rows for the job around the window; rows from InfluxDB are filtered by job already, so job is set
// on both before matching. Returns rows oldest first in the shape buildSteps reads.
function ownActions(actions, opens, start, job) {
  const withJob = (rows) => (rows || []).filter(valid).map((r) => ({ ...r, job }));
  return matchRestarts(withJob(actions), withJob(opens))
    .filter((a) => a.incident && Math.abs(a.incident.start - start) <= OPEN_MATCH_MS)
    .sort((a, b) => a.time - b.time);
}

const valid = (r) => r && num(r.time) !== null;
const isFlagged = (p) => num(p.is_anomaly) === 1 && num(p.warmup) !== 1;

// Runs of warm-up minutes, each minute 60 s after the one before. end is the last minute's time.
function warmupRuns(points) {
  const runs = [];
  let current = null;
  for (const p of points) {
    if (num(p.warmup) !== 1) {
      current = null;
      continue;
    }
    const t = num(p.time);
    if (current && t - current.end === MINUTE) {
      current.end = t;
      current.minutes += 1;
    } else {
      current = { start: t, end: t, minutes: 1 };
      runs.push(current);
    }
  }
  return runs;
}

// The worker's signal names as words for a sentence start.
const SIGNAL_LABEL = { cpu: "CPU", memory: "Memory", latency: "Latency" };

function warningStep(row) {
  const signal = text(row.signal);
  const minutes = num(row.minutes_to_threshold);
  const what = signal ? SIGNAL_LABEL[signal] || cap(signal) : "A signal";
  const eta = minutes === null ? "towards its flag level" : `about ${Math.max(0, Math.round(minutes))} min to its flag level`;
  const rising = minutes === null ? `${what} rising ${eta}.` : `${what} rising, ${eta}.`;
  return step(num(row.time), "early_warning", "Early warning", `${rising} Watch only, nothing was started.`, "early_warning", "warn");
}

function firstFlagStep(p) {
  const score = num(p.score);
  const threshold = num(p.threshold);
  const parts = [];
  if (score !== null && threshold !== null) {
    parts.push(`Score ${score.toFixed(3)} ${score > threshold ? "above" : "against"} the ${threshold.toFixed(3)} threshold.`);
  } else if (score !== null) {
    parts.push(`Score ${score.toFixed(3)}.`);
  }
  const signal = text(p.signal);
  const tier = text(p.tier);
  const rest = [signal ? `Signal ${signal}` : null, tier ? `tier ${tier}` : null].filter(Boolean).join(", ");
  if (rest) parts.push(`${rest}.`);
  return step(num(p.time), "first_flag", "First flagged minute", parts.join(" ") || "This minute was flagged.", "anomaly_score", "flag");
}

const PLANNED = { restart: "restart planned", rollback: "rollback planned", notify: "notification only" };

function openedStep(open) {
  const tier = text(open.tier);
  const planned = PLANNED[text(open.action)] || null;
  const detail = [tier ? cap(tier) : null, planned].filter(Boolean).join(", ");
  return step(num(open.time), "incident_open", "Incident opened", detail ? `${detail}.` : "An incident was recorded.", "incident_open", "flag");
}

const SKIP_REASON = {
  skipped_cooldown: { reason: "cooldown", sentence: "A restart had run recently, so the cooldown held this one back." },
  skipped_closed: { reason: "incident already closed", sentence: "The incident had closed before the request was answered." },
  skipped_simulated: { reason: "simulated incident", sentence: "The incident came from a fault injection test, so nothing was run." },
  skipped_no_previous_image: { reason: "no previous image", sentence: "There was no earlier image to go back to." },
  skipped_no_deployment: { reason: "no recent deployment", sentence: "There was no real CI deployment in the last 15 minutes, so no rollback was run." },
};

function actionStep(row) {
  const action = text(row.action) || "restart";
  const verbed = action === "rollback" ? "rolled back" : "restarted";
  const mode = text(row.mode);
  const outcome = outcomeOf(row);
  const family = familyOf(outcome);
  const up = num(row.service_up);
  let title;
  let detail;
  if (outcome === "success" || outcome === "failed") {
    title = mode === "auto" ? "Ran automatically" : mode === "approved" ? "Approved" : cap(verbed);
    const how = mode === "approved" ? "approved on Telegram" : mode === "auto" ? "run without asking" : "run";
    detail = outcome === "success" ? `The service was ${verbed} (${how}).` : `The ${action} was ${how}, but it did not succeed.`;
    if (up === 1) detail += " Back up 60 s later.";
    else if (up === 0) detail += " Still down 60 s later.";
  } else if (outcome === "rejected") {
    title = "Rejected";
    detail = `The ${action} request was rejected, so nothing was ${verbed}.`;
  } else if (outcome === "expired") {
    title = "Expired";
    detail = `Nobody answered before the ${action} request expired, so nothing was ${verbed}.`;
  } else if (SKIP_REASON[outcome]) {
    title = `Skipped, ${SKIP_REASON[outcome].reason}`;
    detail = SKIP_REASON[outcome].sentence;
  } else if (outcome) {
    title = cap(outcome.replace(/_/g, " "));
    detail = `The ${action} request ended with outcome ${outcome}.`;
  } else {
    title = "Action recorded";
    detail = `A ${action} request was logged without an outcome.`;
  }
  return step(num(row.time), "action", title, detail, "remediation_action", family);
}

function warmupStep(run) {
  return step(
    run.start,
    "warmup",
    `Warm-up, ${plural(run.minutes, "minute")}`,
    "Scored but never flagged while the restarted service settled.",
    "anomaly_score",
    "warmup"
  );
}

function explanationStep(row) {
  const source = text(row.source);
  const attempts = num(row.attempts);
  let detail;
  if (source === "llm") {
    detail = "Written by the local LLM";
    detail += attempts === null ? "." : attempts === 1 ? ", accepted at the first attempt." : `, accepted at attempt ${attempts}.`;
  } else if (source === "template") {
    detail = "Template used";
    detail += attempts === null || attempts < 1 ? "." : ` after ${plural(attempts, "attempt")} with the local LLM.`;
  } else {
    detail = "The explanation was stored.";
  }
  // The write time is not stored (the row carries the incident start), so this step has no time.
  return step(null, "explanation", "Explanation written", detail, "incident_explanation", "info");
}

function rollbackStep(open) {
  const tier = text(open.tier);
  const deployment = flag(open.deployment);
  const missing = [];
  if (tier !== null && tier !== "high") missing.push(`The incident was ${tier} tier.`);
  if (!deployment) missing.push("There was no real deployment in the last 15 minutes.");
  const why = missing.length ? missing.join(" ") : "Both conditions were met, but no rollback was recorded.";
  return step(
    null,
    "rollback_not_run",
    "Rollback not run",
    `A rollback only follows a high-tier incident with a real CI deployment in the last 15 minutes. ${why}`,
    "rule",
    "not_run"
  );
}

// open: the incident_open row. rows: { scores, warning, actions, explanation }, each a list of rows
// from InfluxDB (scores and actions) or one row or null (warning, explanation). Returns the steps in
// time order; steps with no stored time come last, in the order they were built.
function buildSteps(open, rows) {
  const start = num(open.time);
  const scores = (rows.scores || []).filter(valid).sort((a, b) => num(a.time) - num(b.time));
  const actions = (rows.actions || []).filter(valid).sort((a, b) => num(a.time) - num(b.time));
  const steps = [];

  if (valid(rows.warning)) steps.push(warningStep(rows.warning));

  // First flagged minute, and the chain of flagged minutes it starts (gaps up to INCIDENT_GAP_MS).
  const first = scores.find((p) => isFlagged(p) && num(p.time) >= start - FIRST_FLAG_SLACK_MS);
  let lastFlag = null;
  if (first) {
    steps.push(firstFlagStep(first));
    lastFlag = num(first.time);
    for (const p of scores) {
      const t = num(p.time);
      if (t > lastFlag && isFlagged(p) && t - lastFlag <= INCIDENT_GAP_MS) lastFlag = t;
    }
  }

  steps.push(openedStep(open));

  for (const a of actions) steps.push(actionStep(a));

  // Warm-up after an action that ran. A run is used once. The run can start in the minute before
  // the action's logged time, so it is sorted by the later of the two and stays after its action.
  const sortAt = new Map();
  const used = new Set();
  const runs = warmupRuns(scores);
  for (const a of actions) {
    const outcome = outcomeOf(a);
    if (outcome !== "success" && outcome !== "failed") continue;
    const at = num(a.time);
    const run = runs.find((r) => !used.has(r) && r.start >= at - WARMUP_BEFORE_MS && r.start <= at + WARMUP_AFTER_MS);
    if (run) {
      used.add(run);
      const s = warmupStep(run);
      sortAt.set(s, Math.max(run.start, at));
      steps.push(s);
    }
  }

  // Closed. The explainer closes an incident on the clock: once QUIET_MINUTES_TO_CLOSE minutes have
  // passed after its last flagged minute. A later flag more than INCIDENT_GAP_MS away is a new
  // incident and does not keep this one open. The last flag is the explanation's end_time when it
  // is stored; otherwise the chain above, and then only when a scored minute shows that the quiet
  // time has passed (a chain cut short by the window end has no such minute).
  const storedEnd = rows.explanation ? Date.parse(text(rows.explanation.end_time) || "") : NaN;
  const closeFrom = Number.isFinite(storedEnd) ? storedEnd : lastFlag;
  if (closeFrom !== null) {
    const closedAt = closeFrom + QUIET_MINUTES_TO_CLOSE * MINUTE;
    const reached = Number.isFinite(storedEnd) || scores.some((p) => num(p.time) >= closedAt);
    if (reached) {
      const quiet = scores.filter((p) => num(p.time) > closeFrom && num(p.time) <= closedAt && !isFlagged(p)).length;
      const detail =
        quiet >= QUIET_MINUTES_TO_CLOSE
          ? `${plural(QUIET_MINUTES_TO_CLOSE, "quiet minute")} after the last flag.`
          : `${plural(QUIET_MINUTES_TO_CLOSE, "minute")} after the last flag, the explainer's quiet time.`;
      steps.push(step(closedAt, "incident_closed", "Incident closed", detail, "anomaly_score", "info"));
    }
  }

  if (valid(rows.explanation)) steps.push(explanationStep(rows.explanation));

  if (!actions.some((a) => (text(a.action) || "restart") === "rollback")) steps.push(rollbackStep(open));

  // Stable sort: steps with the same time keep the order they were built in.
  const timed = steps.filter((s) => s.time !== null).map((s, i) => ({ s, i, at: sortAt.has(s) ? sortAt.get(s) : s.time }));
  timed.sort((a, b) => a.at - b.at || a.i - b.i);
  return [...timed.map((x) => x.s), ...steps.filter((s) => s.time === null)];
}

// requested and job are validated by parseParams, so only digits and [a-z0-9_-] reach the queries;
// every later number is computed from them or from the stored start, rounded to an integer.
// Returns null when no incident_open row exists for them. Throws when InfluxDB fails.
// The row nearest to start (incident_open or incident_explanation), or null.
function nearestRow(rows, start) {
  let best = null;
  for (const r of rows || []) {
    if (!valid(r)) continue;
    if (best === null || Math.abs(num(r.time) - start) < Math.abs(num(best.time) - start)) best = r;
  }
  return best;
}

async function loadTimeline(query, requested, job) {
  // incident_open is written by the explainer while the incident is open, rewritten at the same
  // timestamp as it grows, so there is one row per incident and it holds the latest minutes and tier.
  const openRows = await query(
    'SELECT "tier","action","signal","peak_score","minutes","deployment" FROM "incident_open" ' +
      `WHERE "job" = '${job}' AND time >= ${String(requested - OPEN_MATCH_MS)}ms AND time <= ${String(requested + OPEN_MATCH_MS)}ms ORDER BY time ASC`
  );
  const open = nearestRow(openRows, requested);
  if (!open) return null;
  // From here on the stored start is used, an integer read back from InfluxDB.
  const start = Math.round(num(open.time));
  const s = String(start);
  const minutes = Math.max(0, Math.round(num(open.minutes) || 0));
  const latest = String(start + MAX_WINDOW_MS);

  // Second round: what decides the end, and the incidents an action could be matched to (an action
  // can answer an incident that started up to 30 minutes before it, so the list starts that much
  // before the window).
  const [explanations, opens, flagged] = await Promise.all([
    query(
      'SELECT "end_time","source","attempts","minutes" FROM "incident_explanation" ' +
        `WHERE "job" = '${job}' AND time >= ${String(start - EXPLANATION_MATCH_MS)}ms AND time <= ${String(start + EXPLANATION_MATCH_MS)}ms ORDER BY time ASC`
    ),
    query(
      'SELECT "tier","peak_score" FROM "incident_open" ' +
        `WHERE "job" = '${job}' AND time >= ${String(start - BEFORE_MS - ACTION_MATCH_MS)}ms AND time <= ${latest}ms ORDER BY time ASC`
    ),
    query(
      'SELECT "is_anomaly","warmup" FROM "anomaly_score" ' +
        `WHERE "job" = '${job}' AND "is_anomaly" = 1 AND time >= ${s}ms AND time <= ${latest}ms ORDER BY time ASC`
    ),
  ]);
  const explanation = nearestRow(explanations, start);
  const next = (opens || []).filter(valid).map((r) => num(r.time)).filter((x) => x > start + OPEN_MATCH_MS);
  const nextStart = next.length ? Math.min(...next) : null;
  const end = incidentEnd(start, minutes, explanation, flagged, nextStart);
  const { from, to } = windowOf(start, end);
  const f = String(from);
  const t = String(Math.round(to));

  const [scores, warnings, actions] = await Promise.all([
    query(
      'SELECT "score","threshold","is_anomaly","tier","tier_level","signal","cpu_rate","memory_mb","latency_ms","recent_deployment","model","early_warning","ew_signal","ew_minutes","ew_slope","ew_r2","warmup" ' +
        `FROM "anomaly_score" WHERE "job" = '${job}' AND time >= ${f}ms AND time <= ${t}ms ORDER BY time ASC`
    ),
    query(
      'SELECT "signal","minutes_to_threshold","slope_per_min" FROM "early_warning" ' +
        `WHERE "job" = '${job}' AND time >= ${String(start - WARNING_LOOKBACK_MS)}ms AND time <= ${s}ms ORDER BY time DESC LIMIT 1`
    ),
    query(
      'SELECT "action","mode","outcome","signal","minutes","service_up" FROM "remediation_action" ' +
        `WHERE "job" = '${job}' AND time >= ${f}ms AND time <= ${t}ms ORDER BY time ASC`
    ),
  ]);
  const steps = buildSteps({ ...open, time: start }, {
    scores,
    warning: warnings.find(valid) || null,
    actions: ownActions(actions, opens, start, job),
    explanation,
  });
  return {
    start,
    job,
    from,
    to,
    tier: text(open.tier),
    minutes,
    deployment: flag(open.deployment),
    points: scores,
    steps,
  };
}

module.exports = { parseParams, windowOf, incidentEnd, ownActions, buildSteps, loadTimeline, QUIET_MINUTES_TO_CLOSE };
