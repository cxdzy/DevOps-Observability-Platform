// Timeline events for the dashboard: deployments, retraining, early warnings, incidents and
// remediation actions. Each source is queried on its own, so one failing source leaves only its
// own events out. buildEvents is a pure function so it can be unit tested without HTTP.

// The most events one response holds. Over it, the oldest incidents and actions go first, so the
// rare deployments, retrains and early warnings stay on the lane.
const MAX_EVENTS = 2000;
const KEPT_KINDS = new Set(["deploy", "retrain", "early_warning"]);

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

// Must match outcomeOf in remediation.js (not exported there). A test compares the two.
function outcomeOf(r) {
  const outcome = text(r.outcome);
  if (outcome) return outcome;
  const mode = text(r.mode);
  if (mode === "auto" || mode === "approved") return num(r.service_up) === 1 ? "success" : "failed";
  return mode;
}

// success is "worked", failed is "failed", everything else (expired, rejected, skipped_*, none) is "not_run".
function familyOf(outcome) {
  if (outcome === "success") return "worked";
  if (outcome === "failed") return "failed";
  return "not_run";
}

function version(v) {
  const s = text(v);
  if (s === null) return null;
  return /^v/i.test(s) ? s : `v${s}`;
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function deployEvent(r) {
  const commit = text(r.commit_sha);
  const shortCommit = commit === null ? null : commit.slice(0, 7);
  return {
    time: Number(r.time),
    kind: "deploy",
    label: shortCommit ? `Deployment ${shortCommit}` : "Deployment",
    detail: { commit, shortCommit, branch: text(r.branch), runId: text(r.pipeline_run_id) },
  };
}

function retrainEvent(r) {
  const promoted = flag(r.promoted);
  const newVersion = version(r.new_version);
  const championVersion = version(r.champion_version);
  const shown = promoted ? newVersion : championVersion;
  const verb = promoted ? "promoted" : "kept";
  return {
    time: Number(r.time),
    kind: "retrain",
    label: shown ? `Retraining ${verb} ${shown}` : `Retraining ${verb}`,
    detail: { promoted, newVersion, championVersion },
  };
}

function warningEvent(r) {
  const signal = text(r.signal);
  return {
    time: Number(r.time),
    kind: "early_warning",
    label: signal ? `Early warning, ${signal}` : "Early warning",
    detail: { signal, minutes: num(r.minutes_to_threshold) },
  };
}

function incidentEvent(r) {
  const tier = text(r.tier);
  return {
    time: Number(r.time),
    kind: "incident",
    label: tier ? `Incident, ${tier}` : "Incident",
    detail: { tier, peakScore: num(r.peak_score), job: text(r.job) },
  };
}

function actionEvent(r) {
  const action = text(r.action) || "restart";
  const outcome = outcomeOf(r);
  const family = familyOf(outcome);
  let result = "not run";
  if (family === "worked") result = "worked";
  else if (family === "failed") result = "failed";
  else if (outcome) result = `not run (${outcome})`;
  return {
    time: Number(r.time),
    kind: "action",
    label: `${cap(action)}, ${result}`,
    detail: { action, mode: text(r.mode), outcome, family },
  };
}

const valid = (r) => r && num(r.time) !== null;

// Keeps at most max events. Incidents and actions are dropped oldest first; deployments, retrains
// and early warnings are dropped (oldest first) only when they alone are more than max.
// events must be sorted by time. Returns { events, truncated }.
function capEvents(events, max = MAX_EVENTS) {
  if (events.length <= max) return { events, truncated: false };
  const kept = events.filter((e) => KEPT_KINDS.has(e.kind));
  const rest = events.filter((e) => !KEPT_KINDS.has(e.kind));
  const chosen = kept.length >= max ? kept.slice(kept.length - max) : [...kept, ...rest.slice(rest.length - (max - kept.length))];
  chosen.sort((a, b) => a.time - b.time);
  return { events: chosen, truncated: true };
}

// rows: { deploy, retrain, warning, incident, action }, each an array of rows or missing.
// Returns { events, truncated }: the events sorted by time, capped by capEvents.
function buildEvents(rows) {
  const events = [
    ...(rows.deploy || []).filter(valid).filter((r) => r.source === "ci").map(deployEvent),
    ...(rows.retrain || []).filter(valid).map(retrainEvent),
    ...(rows.warning || []).filter(valid).map(warningEvent),
    ...(rows.incident || []).filter(valid).map(incidentEvent),
    ...(rows.action || []).filter(valid).map(actionEvent),
  ];
  events.sort((a, b) => a.time - b.time);
  return capEvents(events);
}

// hours is a validated integer from the route, never request text.
async function loadEvents(query, hours) {
  const h = String(Math.trunc(Number(hours)));
  const range = `time > now() - ${h}h ORDER BY time ASC`;
  const sources = [
    ["deploy", "deployments", `SELECT "commit_sha","branch","pipeline_run_id","source" FROM "deployment_event" WHERE "source" = 'ci' AND ${range}`],
    ["retrain", "retraining", `SELECT "promoted","new_version","champion_version" FROM "model_retrain" WHERE ${range}`],
    ["warning", "early warnings", `SELECT "signal","minutes_to_threshold" FROM "early_warning" WHERE ${range}`],
    ["incident", "incidents", `SELECT "tier","peak_score","job" FROM "incident_open" WHERE ${range}`],
    ["action", "actions", `SELECT "action","mode","outcome","service_up","job" FROM "remediation_action" WHERE ${range}`],
  ];
  const results = await Promise.allSettled(sources.map((s) => query(s[2])));
  const rows = {};
  const unavailable = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") rows[sources[i][0]] = r.value;
    else unavailable.push(sources[i][1]);
  });
  if (unavailable.length === sources.length) return null;
  const { events, truncated } = buildEvents(rows);
  return truncated ? { events, unavailable, truncated } : { events, unavailable };
}

module.exports = { loadEvents, buildEvents, capEvents, outcomeOf, familyOf, MAX_EVENTS };
