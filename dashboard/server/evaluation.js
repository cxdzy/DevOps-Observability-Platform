// Saved detection reports for the Evaluation view. scripts/detection_report.py --save writes three
// measurements, each point tagged run_id (the UTC time of the run, for example 2026-11-11T04:30:00Z):
//   evaluation_run    one point per run with the headline figures
//   evaluation_fault  one point per fault type
//   evaluation_day    one point per UTC day
// Rates in them are fractions from 0 to 1, not percent. Missing fields stay null here, never filled in.
// MTTR is not stored by the report; it is computed here from incident_open and remediation_action
// for the run's period, reusing matchRestarts from remediation.js.
const { matchRestarts } = require("./remediation");

const MIN = 60000;
// The run id is exactly what the script writes: UTC, whole seconds, a trailing Z.
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_RUNS = 100;

const RUNS_QUERY = `SELECT * FROM "evaluation_run" ORDER BY time DESC LIMIT ${MAX_RUNS}`;
// Counts over everything stored, for the objectives table. InfluxDB counts the deployments and
// explanations itself, so only one row comes back. The actions are read as rows because rows written
// before outcome existed get their outcome from mode and service_up (see remediation.js); they are
// few, and the newest MAX_ACTIONS keep the query bounded.
const MAX_ACTIONS = 5000;
const DEPLOYMENTS_QUERY = 'SELECT COUNT("commit_sha") FROM "deployment_event" WHERE "source" = \'ci\'';
const EXPLANATIONS_QUERY = 'SELECT COUNT("end_time") FROM "incident_explanation"';
const ACTIONS_QUERY =
  `SELECT "action","mode","outcome","service_up" FROM "remediation_action" ORDER BY time DESC LIMIT ${MAX_ACTIONS}`;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

// True only for a real UTC time in the exact form the script writes.
function validRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 19) + "Z" === value;
}

// query is the raw req.query. Returns { run: null | run_id } or { error }.
function parseParams(query) {
  const raw = query.run;
  if (raw === undefined) return { run: null };
  if (!validRunId(raw)) return { error: "run must be a UTC time like 2026-11-11T04:30:00Z" };
  return { run: raw };
}

function runRow(r) {
  return {
    run_id: text(r.run_id),
    time: num(r.time),
    since: text(r.since),
    until: text(r.until),
    scored_minutes: num(r.scored_minutes),
    injections: num(r.injections),
    detected: num(r.detected),
    detection_rate: num(r.detection_rate),
    flagged_minutes: num(r.flagged_minutes),
    normal_minutes: num(r.normal_minutes),
    false_alarms: num(r.false_alarms),
    false_alarm_rate: num(r.false_alarm_rate),
    top_normal_score: num(r.top_normal_score),
    p99_normal_score: num(r.p99_normal_score),
    threshold: num(r.threshold),
    margin: num(r.margin),
    ramp_injections: num(r.ramp_injections),
    warned_before_flag: num(r.warned_before_flag),
    lead_median_min: num(r.lead_median_min),
    lead_max_min: num(r.lead_max_min),
    false_ew_minutes: num(r.false_ew_minutes),
    excluded: num(r.excluded),
    model: text(r.model),
  };
}

function faultRow(r) {
  return {
    fault: text(r.fault),
    injections: num(r.injections),
    detected: num(r.detected),
    detection_rate: num(r.detection_rate),
    median_peak_score: num(r.median_peak_score),
    missed: num(r.missed),
    missed_example: text(r.missed_example),
  };
}

function dayRow(r) {
  return {
    day: text(r.day),
    time: num(r.time),
    scored_minutes: num(r.scored_minutes),
    normal_minutes: num(r.normal_minutes),
    false_alarms: num(r.false_alarms),
    false_alarm_rate: num(r.false_alarm_rate),
    flagged_minutes: num(r.flagged_minutes),
    injections: num(r.injections),
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median minutes from the start of an incident (incident_open) to the action that answered it, for
// actions that worked: outcome success and service_up 1. An incident counts once, by its first such
// action. restarts and opens are the rows of remediation_action and incident_open.
function computeMttr(restarts, opens) {
  const matched = matchRestarts(restarts, opens);
  const firstByIncident = new Map();
  for (const a of matched) {
    if (a.outcome !== "success" || a.service_up !== 1 || !a.incident) continue;
    const key = a.incident.start;
    if (!firstByIncident.has(key) || a.time < firstByIncident.get(key)) firstByIncident.set(key, a.time);
  }
  const minutes = [...firstByIncident].map(([start, time]) => (time - start) / MIN);
  return { median_minutes: median(minutes), count: minutes.length };
}

// The count from a SELECT COUNT(...) answer: one row with a count column, or no row when nothing
// is stored.
function countOf(rows) {
  return (rows && rows.length && num(rows[0].count)) || 0;
}

// What the objectives table needs from the rest of the stored data: how many CI deployments and
// explanations exist, and how many restarts and rollbacks ran and brought the service back.
// deploymentCounts and explanationCounts are COUNT answers, actions are remediation_action rows.
function computeEvidence(deploymentCounts, explanationCounts, actions) {
  const matched = matchRestarts(actions, []);
  const worked = (kind) => matched.filter((a) => a.action === kind && a.outcome === "success" && a.service_up === 1).length;
  const ran = matched.filter((a) => a.outcome === "success" || a.outcome === "failed").length;
  return {
    ci_deployments: countOf(deploymentCounts),
    explanations: countOf(explanationCounts),
    actions: { ran, restart_worked: worked("restart"), rollback_worked: worked("rollback") },
  };
}

// The picker entry for a run.
function runSummary(r) {
  return { run_id: r.run_id, since: r.since, until: r.until, injections: r.injections };
}

// run is a validated run id or null (the latest). Returns null when no run exists, or the run asked
// for does not exist. Throws when InfluxDB fails on the saved report itself; the extra data
// (MTTR, objectives counts) is left null when its own queries fail.
async function loadEvaluation(query, run) {
  if (run !== null && !validRunId(run)) return null;
  const rows = (await query(RUNS_QUERY)).map(runRow).filter((r) => r.run_id !== null);
  if (rows.length === 0) return null;
  let chosen = run === null ? rows[0] : rows.find((r) => r.run_id === run);
  // Only a validated run id reaches the query text, inside quotes.
  if (!chosen && run !== null) {
    // A link to a run older than the newest MAX_RUNS still opens; the picker then lists it last.
    const own = await query(`SELECT * FROM "evaluation_run" WHERE "run_id" = '${run}'`);
    chosen = own.map(runRow).find((r) => r.run_id === run);
    if (chosen) rows.push(chosen);
  }
  if (!chosen) return null;

  const quoted = `'${chosen.run_id}'`;
  const [faults, days] = await Promise.all([
    query(`SELECT * FROM "evaluation_fault" WHERE "run_id" = ${quoted}`),
    query(`SELECT * FROM "evaluation_day" WHERE "run_id" = ${quoted} ORDER BY time ASC`),
  ]);

  // MTTR covers the run's period; an action can follow its incident by up to 30 minutes.
  let mttr = null;
  const since = validRunId(chosen.since) ? Date.parse(chosen.since) : null;
  const until = validRunId(chosen.until) ? Date.parse(chosen.until) : null;
  if (since !== null && until !== null) {
    const iso = (ms) => new Date(ms).toISOString();
    try {
      const [restarts, opens] = await Promise.all([
        query(
          'SELECT "action","mode","outcome","job","service_up" FROM "remediation_action" ' +
            `WHERE time >= '${iso(since)}' AND time <= '${iso(until + 30 * MIN)}' ORDER BY time DESC`
        ),
        query(
          'SELECT "job","tier","peak_score" FROM "incident_open" ' +
            `WHERE time >= '${iso(since)}' AND time <= '${iso(until)}' ORDER BY time ASC`
        ),
      ]);
      mttr = computeMttr(restarts, opens);
    } catch (err) {
      mttr = null;
    }
  }

  let evidence = null;
  try {
    const [deployments, explanations, actions] = await Promise.all([
      query(DEPLOYMENTS_QUERY),
      query(EXPLANATIONS_QUERY),
      query(ACTIONS_QUERY),
    ]);
    evidence = computeEvidence(deployments, explanations, actions);
  } catch (err) {
    evidence = null;
  }

  return {
    run_id: chosen.run_id,
    run: chosen,
    runs: rows.map(runSummary),
    faults: faults.map(faultRow).sort((a, b) => (b.injections || 0) - (a.injections || 0) || String(a.fault).localeCompare(String(b.fault))),
    days: days.map(dayRow),
    mttr,
    evidence,
  };
}

module.exports = {
  loadEvaluation,
  parseParams,
  validRunId,
  computeMttr,
  computeEvidence,
  RUNS_QUERY,
  DEPLOYMENTS_QUERY,
  EXPLANATIONS_QUERY,
  ACTIONS_QUERY,
};
