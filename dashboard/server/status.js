// Current system state for the dashboard header: stale, incident, recovering, watching or normal.
// All queries are constants. The decision logic is a pure function so it can be unit tested.
//
// "Waiting for approval" and "restarting" from DESIGN.md 7.3 are not built because the data for
// them does not exist yet.

const MINUTE = 60000;
const STALE_MS = 5 * MINUTE;
// The restart warm-up length. This is the default of WARMUP_MINUTES in worker/worker.py. The data
// stores only the per-minute warmup flag, not the total, so the total is assumed here.
const WARMUP_TOTAL = 3;

const LATEST_QUERY =
  'SELECT "early_warning","ew_signal","ew_minutes","warmup","tier","is_anomaly" FROM "anomaly_score" ORDER BY time DESC LIMIT 4';
const OPEN_QUERY =
  'SELECT "tier","peak_score","minutes","job" FROM "incident_open" WHERE time > now() - 24h ORDER BY time DESC';
const EXPLANATION_QUERY =
  'SELECT "end_time","job" FROM "incident_explanation" WHERE time > now() - 7d ORDER BY time DESC';

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

// The newest incident that is still open, or null.
function openIncident(openRows, explRows, nowMs) {
  const lastExplained = new Map();
  for (const e of explRows || []) {
    const t = num(e && e.time);
    if (t === null) continue;
    const job = text(e.job);
    if (!lastExplained.has(job) || t > lastExplained.get(job)) lastExplained.set(job, t);
  }
  let best = null;
  for (const r of openRows || []) {
    const start = num(r && r.time);
    if (start === null) continue;
    const job = text(r.job);
    // Open only when newer than the latest explanation for the same job (none counts as newer).
    if (lastExplained.has(job) && start <= lastExplained.get(job)) continue;
    // Same rule as incidents.js awaiting_explanation: once now is past the end plus 5 minutes the
    // incident has closed and only its explanation is pending.
    const minutes = num(r.minutes) || 0;
    if (nowMs >= start + (minutes + 5) * MINUTE) continue;
    if (!best || start > best.start) {
      best = { start, tier: text(r.tier), job, peakScore: num(r.peak_score) };
    }
  }
  return best;
}

// Which warm-up minute the latest one is, or null when it cannot be told from the rows.
function warmupStep(latestRows) {
  let n = 0;
  while (
    n < latestRows.length &&
    flag(latestRows[n].warmup) &&
    (n === 0 || num(latestRows[n - 1].time) - num(latestRows[n].time) === MINUTE)
  ) {
    n += 1;
  }
  const before = latestRows[n];
  const startVisible =
    before !== undefined &&
    num(latestRows[n - 1].time) - num(before.time) === MINUTE &&
    !flag(before.warmup);
  return startVisible && n <= WARMUP_TOTAL ? n : null;
}

// latestRows are newest first. Returns the state object.
function decideStatus(latestRows, openRows, explRows, nowMs) {
  const rows = (latestRows || []).filter((r) => r && num(r.time) !== null);
  const latest = rows[0];
  if (!latest) return { state: "stale", time: null };
  const time = num(latest.time);
  if (nowMs - time > STALE_MS) return { state: "stale", time };

  const open = openIncident(openRows, explRows, nowMs);
  if (open) {
    return { state: "incident", tier: open.tier, job: open.job, start: open.start, peakScore: open.peakScore };
  }
  if (flag(latest.warmup)) {
    const step = warmupStep(rows);
    return step === null ? { state: "recovering", time } : { state: "recovering", time, step, of: WARMUP_TOTAL };
  }
  if (flag(latest.early_warning)) {
    return { state: "watching", time, signal: text(latest.ew_signal), minutes: num(latest.ew_minutes) };
  }
  return { state: "normal", time };
}

async function loadStatus(query, nowMs) {
  const [latestRows, openRows, explRows] = await Promise.all([
    query(LATEST_QUERY),
    query(OPEN_QUERY),
    query(EXPLANATION_QUERY),
  ]);
  return decideStatus(latestRows, openRows, explRows, nowMs);
}

module.exports = { loadStatus, decideStatus, openIncident, STALE_MS, WARMUP_TOTAL };
