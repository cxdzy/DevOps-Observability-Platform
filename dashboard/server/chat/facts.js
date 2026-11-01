// Gathers the facts for a chat question and renders the compact FACTS block (chat plan section 10).
// renderFacts is a line by line port of render_facts in bench/chat_model_test/snapshot_facts.py,
// so the model sees the same text it was tested on; test/chat.facts.test.js checks this against
// a fixture rendered by the Python code. Every query is a constant; nothing from the request is
// put into a query.
const { createPrometheus } = require("../prometheus");
const { loadIncidents } = require("../overview");

const JOB = "sample-service";
const INCIDENT_HOURS = 6;
const RESTART_DAYS = 30;
const INCIDENTS_LISTED = 8;
const SIGNALS = ["cpu", "memory", "latency", "unclear"];
const VALUE_KEYS = ["service_up", "anomaly_latest", "service_now", "model", "reference", "incidents_6h",
  "last_restart", "last_ci_deployment", "node_fyp_main", "node_staging"];
const FOOTER = "Only the facts above are available. Logs, commit messages and metrics not listed are not available.";
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const NODE_JOBS = 'job=~"node-exporter|node-exporter-old"';
const ROOT_FS = 'mountpoint="/",fstype!~"tmpfs|overlay"';
const PROM_QUERIES = Object.freeze({
  service_up: `up{job="${JOB}"}`,
  node_up: `up{${NODE_JOBS}}`,
  mem_total: `node_memory_MemTotal_bytes{${NODE_JOBS}}`,
  mem_available: `node_memory_MemAvailable_bytes{${NODE_JOBS}}`,
  disk_size: `node_filesystem_size_bytes{${NODE_JOBS},${ROOT_FS}}`,
  disk_available: `node_filesystem_avail_bytes{${NODE_JOBS},${ROOT_FS}}`,
  containers: 'count by (job) (count by (job, name) (container_memory_working_set_bytes{job=~"cadvisor|cadvisor-old",name!=""}))',
});
const NODES = [["node_fyp_main", "node-exporter", "cadvisor"], ["node_staging", "node-exporter-old", "cadvisor-old"]];

const LATEST_QUERY = `SELECT * FROM "anomaly_score" WHERE "job" = '${JOB}' ORDER BY time DESC LIMIT 1`;
const RETRAIN_QUERY = 'SELECT "promoted","new_version","champion_version" FROM "model_retrain" ORDER BY time DESC LIMIT 1';
const REFERENCE_QUERY = 'SELECT * FROM "reference_level" ORDER BY time DESC LIMIT 1';
const RESTART_QUERY = 'SELECT "mode","signal","service_up" FROM "remediation_action" ' +
  `WHERE time > now() - ${RESTART_DAYS}d ORDER BY time DESC LIMIT 1`;
const DEPLOY_QUERY = 'SELECT "commit_sha" FROM "deployment_event" WHERE "source" = \'ci\' ORDER BY time DESC LIMIT 1';

// ------------------------------------------------------------------ number and time formatting

// Python's f"{value:.{digits}f}". JavaScript's toFixed rounds an exact tie up, Python rounds it
// to the even digit (124.5 gives "124"), so ties are detected from the exact decimal expansion.
function pyFixed(value, digits) {
  const v = Number(value);
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  const exact = abs.toFixed(100);
  const dot = exact.indexOf(".");
  const tail = exact.slice(dot + 1 + digits);
  let out = abs.toFixed(digits);
  if (/^50*$/.test(tail)) {
    const truncated = digits === 0 ? exact.slice(0, dot) : exact.slice(0, dot + 1 + digits);
    if (Number(truncated[truncated.length - 1]) % 2 === 0) out = truncated;
  }
  // Python keeps the sign of a negative value even when it rounds to zero ("-0").
  return v < 0 || Object.is(v, -0) ? `-${out}` : out;
}

function num(value, digits) {
  return value === null || value === undefined ? "no data" : pyFixed(value, digits);
}

function yesNo(value) {
  return value === null || value === undefined ? "no data" : value ? "yes" : "no";
}

function mytParts(ms) {
  const d = new Date(Number(ms) + MYT_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

// HH:MM on the snapshot's MYT day, otherwise HH:MM D Mon (for example 03:01 31 Oct).
function fmtTime(ms, snapshotMs) {
  const t = mytParts(ms);
  const s = mytParts(snapshotMs);
  const hhmm = `${String(t.h).padStart(2, "0")}:${String(t.mi).padStart(2, "0")}`;
  if (t.y === s.y && t.mo === s.mo && t.day === s.day) return hhmm;
  return `${hhmm} ${t.day} ${MONTHS[t.mo]}`;
}

// Python truthiness for the values that reach the renderer.
function truthy(value) {
  return !(value === null || value === undefined || value === false || value === 0 || value === "");
}

function snapshotIso(snapshotMs) {
  return new Date(Math.floor(snapshotMs / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

// ------------------------------------------------------------------ rendering

function renderIncidents(inc, snapshotMs) {
  const head = `incidents last ${INCIDENT_HOURS} h`;
  if (inc === null || inc === undefined) {
    const line = `${head}: no data`;
    return { incidents_6h: [line], incidents_counts: [line], incidents_peak: [line], incidents_deployment: [line] };
  }
  const items = [...inc.items].sort((a, b) => b.start_ms - a.start_ms);
  const t = inc.by_tier;
  const count = `${head}: ${inc.count} (low ${t.low}, medium ${t.medium}, high ${t.high})`;
  const by = Object.fromEntries(SIGNALS.map((s) => [s, 0]));
  for (const i of items) by[SIGNALS.includes(i.signal) ? i.signal : "unclear"] += 1;
  const bySignal = "by signal: " + SIGNALS.map((s) => `${s} ${by[s]}`).join(", ");

  // Highest peak; a tie goes to the newest start, then to the first in the list.
  let top = null;
  for (const i of items) {
    if (i.peak_score === null || i.peak_score === undefined) continue;
    if (!top || i.peak_score > top.peak_score || (i.peak_score === top.peak_score && i.start_ms > top.start_ms)) top = i;
  }
  const peak = top
    ? `highest peak: ${num(top.peak_score, 3)} at ${fmtTime(top.start_ms, snapshotMs)} (tier ${top.tier}, signal ${top.signal})`
    : "highest peak: none";

  const linked = items.filter((i) => truthy(i.deployment));
  const deployment = linked.length === 0
    ? "linked to deployment: none"
    : `linked to deployment: ${linked.length} (` + linked.map((i) => fmtTime(i.start_ms, snapshotMs)).join(", ") + ")";

  const listed = items.slice(0, INCIDENTS_LISTED).map((i, n) => {
    let line = `- ${fmtTime(i.start_ms, snapshotMs)}, tier ${i.tier}, signal ${i.signal}, ${i.minutes} min, ` +
      `peak ${num(i.peak_score, 3)}, deployment ${yesNo(i.deployment)}, ${i.status}.`;
    if (n === 0 && truthy(i.what_happened)) line += ` What happened: ${i.what_happened}`;
    return line;
  });
  if (items.length > INCIDENTS_LISTED) listed.push(`- (${items.length - INCIDENTS_LISTED} older incidents not listed)`);
  return {
    incidents_6h: [count, bySignal, peak, deployment, ...listed],
    incidents_counts: [count, bySignal],
    incidents_peak: [peak],
    incidents_deployment: [deployment],
  };
}

function renderLines(values, snapshotMs) {
  const lines = {};
  const v = (key) => (values[key] === undefined ? null : values[key]);
  lines.service_up = [`service sample-service: up ${yesNo(v("service_up"))}`];

  const a = v("anomaly_latest");
  lines.anomaly_latest = [!truthy(a) ? "anomaly latest: no data"
    : `anomaly latest: ${fmtTime(a.time_ms, snapshotMs)}, score ${num(a.score, 3)}, ` +
      `threshold ${num(a.threshold, 3)}, flagged ${yesNo(a.flagged)}, tier ${truthy(a.tier) ? a.tier : "no data"}`];

  const now = v("service_now");
  lines.service_now = [!truthy(now) ? "sample-service now: no data"
    : `sample-service now: ${fmtTime(now.time_ms, snapshotMs)}, cpu_rate ${num(now.cpu_rate, 4)}, ` +
      `memory ${num(now.memory_max_mb, 0)} MB, latency ${num(now.latency_ms, 1)} ms`];

  const m = v("model");
  if (!truthy(m) || !truthy(m.champion)) {
    lines.model = ["model: no data"];
  } else {
    const r = m.last_retrain;
    let retrain;
    if (!truthy(r)) {
      retrain = "last retraining none recorded";
    } else {
      const result = truthy(r.promoted) ? `promoted v${r.new_version}` : "kept champion";
      retrain = `last retraining ${fmtTime(r.time_ms, snapshotMs)}, result ${result}`;
    }
    lines.model = [`model: champion ${m.champion}, threshold ${num(m.threshold, 3)}, ${retrain}`];
  }

  const ref = v("reference");
  lines.reference = [!truthy(ref) ? "normal reference: no data"
    : `normal reference: cpu_rate ${num(ref.cpu_rate, 4)}, memory ${num(ref.memory_max_mb, 0)} MB, ` +
      `latency ${num(ref.latency_ms, 1)} ms`];

  Object.assign(lines, renderIncidents(v("incidents_6h"), snapshotMs));

  const rs = v("last_restart");
  lines.last_restart = [!truthy(rs) ? `last restart: none in the last ${RESTART_DAYS} days`
    : `last restart: ${fmtTime(rs.time_ms, snapshotMs)}, mode ${truthy(rs.mode) ? rs.mode : "no data"}, ` +
      `signal ${truthy(rs.signal) ? rs.signal : "no data"}, service up after ${yesNo(rs.service_up)}`];

  const d = v("last_ci_deployment");
  lines.last_ci_deployment = [!truthy(d) ? "last CI deployment: none recorded"
    : `last CI deployment: ${fmtTime(d.time_ms, snapshotMs)}`];

  for (const [key, name, monitored] of [["node_fyp_main", "fyp-main", false], ["node_staging", "staging", true]]) {
    const n = v(key) || {};
    const parts = [];
    if (monitored) parts.push(`monitored ${yesNo(n.up)}`);
    if (!monitored || truthy(n.up)) {
      parts.push(`memory ${num(n.mem_used_gib, 1)} of ${num(n.mem_total_gib, 1)} GiB`);
      parts.push(`disk ${num(n.disk_pct, 0)} %`);
      parts.push(`containers ${n.containers === null || n.containers === undefined ? "no data" : Math.trunc(n.containers)}`);
    }
    lines[key] = [`node ${name}: ` + parts.join(", ")];
  }
  return lines;
}

// Returns { text, lines }. snapshotMs is the time the facts were gathered.
function renderFacts(values, snapshotMs) {
  const lines = renderLines(values, snapshotMs);
  const header = `FACTS (snapshot ${snapshotIso(snapshotMs)}, times in MYT, UTC+8)`;
  const body = VALUE_KEYS.flatMap((key) => lines[key]);
  return { text: [header, ...body, FOOTER].join("\n"), lines };
}

// ------------------------------------------------------------------ gathering

function float(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function flag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

// The text after "What happened:" in a stored explanation.
function whatHappened(explanation) {
  if (!explanation) return null;
  for (const line of String(explanation).replace(/\\n/g, "\n").split("\n")) {
    const m = /^\s*what happened:\s*(.*)$/i.exec(line);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

// The dashboard's merged incidents (incidents.js) in the shape the renderer expects. An incident
// waiting for its explanation is still "open" here, as in the benchmark.
function toIncidentValues(incidents) {
  const items = incidents.map((i) => ({
    start_ms: i.start,
    tier: i.tier || "none",
    signal: i.signal || "none",
    minutes: Math.trunc(i.minutes || 0),
    peak_score: i.peakScore === null || i.peakScore === undefined ? null : i.peakScore,
    deployment: i.deployment === true,
    status: i.status === "closed" ? "closed" : "open",
    what_happened: i.status === "closed" ? whatHappened(i.explanation) : null,
  })).sort((a, b) => b.start_ms - a.start_ms);
  const byTier = Object.fromEntries(["low", "medium", "high"].map((t) => [t, items.filter((i) => i.tier === t).length]));
  return { count: items.length, by_tier: byTier, items };
}

function byJob(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const job = row.labels && row.labels.job;
    if (job && !out.has(job)) out.set(job, row.value);
  }
  return out;
}

// Runs fn and returns its result, or fallback when the source fails. A failed source shows
// "no data" in FACTS instead of failing the question.
async function attempt(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function createFacts({ query, prometheus, now = Date.now }) {
  const prom = prometheus || createPrometheus({ allowed: Object.values(PROM_QUERIES) });

  async function influxValues() {
    const latest = await attempt(() => query(LATEST_QUERY), null);
    const p = latest && latest[0] ? latest[0] : null;
    const values = {};
    values.anomaly_latest = !p ? null : {
      time_ms: Number(p.time), score: float(p.score), threshold: float(p.threshold),
      flagged: flag(p.is_anomaly), tier: p.tier === undefined ? null : p.tier,
    };
    // Same minute as "anomaly latest"; memory_max_mb is the field the normal reference uses.
    values.service_now = !p ? null : {
      time_ms: Number(p.time), cpu_rate: float(p.cpu_rate), memory_max_mb: float(p.memory_max_mb), latency_ms: float(p.latency_ms),
    };

    const [retrains, incidents, restarts, deploys] = await Promise.all([
      attempt(() => query(RETRAIN_QUERY), []),
      attempt(() => loadIncidents(query, INCIDENT_HOURS, now()), null),
      attempt(() => query(RESTART_QUERY), []),
      attempt(() => query(DEPLOY_QUERY), []),
    ]);
    const r = retrains[0] || null;
    values.model = !p ? null : {
      champion: p.model === undefined ? null : p.model, threshold: float(p.threshold),
      last_retrain: !r ? null : { time_ms: Number(r.time), promoted: float(r.promoted) === 1, new_version: String(r.new_version || "") },
    };

    // base_* on the latest scored minute is the reference the worker uses right now.
    const cols = ["cpu_rate", "memory_max_mb", "latency_ms"];
    if (p && cols.every((c) => float(p[`base_${c}`]) !== null)) {
      values.reference = Object.fromEntries(cols.map((c) => [c, float(p[`base_${c}`])]));
    } else {
      const ref = await attempt(() => query(REFERENCE_QUERY), []);
      values.reference = !ref[0] ? null : Object.fromEntries(cols.map((c) => [c, float(ref[0][`${c}_median`])]));
    }

    values.incidents_6h = incidents === null ? null : toIncidentValues(incidents);

    const rs = restarts[0] || null;
    values.last_restart = !rs ? null : {
      time_ms: Number(rs.time), mode: rs.mode === undefined ? null : rs.mode, signal: rs.signal === undefined ? null : rs.signal,
      service_up: float(rs.service_up) === null ? null : float(rs.service_up) === 1,
    };
    values.last_ci_deployment = deploys[0] ? { time_ms: Number(deploys[0].time) } : null;
    return { values, latestScore: p ? float(p.score) : null };
  }

  async function promValues() {
    const names = Object.keys(PROM_QUERIES);
    const results = await Promise.all(names.map((k) => attempt(() => prom.query(PROM_QUERIES[k]), null)));
    const r = Object.fromEntries(names.map((k, i) => [k, results[i]]));
    const values = {};
    const up = r.service_up;
    values.service_up = up && up[0] && up[0].value !== null ? up[0].value === 1 : null;
    const rows = Object.fromEntries(names.filter((k) => k !== "service_up").map((k) => [k, byJob(r[k])]));
    const get = (name, job) => { const x = rows[name].get(job); return x === undefined ? null : x; };
    for (const [key, nodeJob, cadvisorJob] of NODES) {
      const nodeUp = get("node_up", nodeJob);
      const total = get("mem_total", nodeJob);
      const avail = get("mem_available", nodeJob);
      const size = get("disk_size", nodeJob);
      const free = get("disk_available", nodeJob);
      values[key] = {
        up: nodeUp === null ? null : nodeUp === 1,
        mem_used_gib: total === null || avail === null ? null : (total - avail) / 2 ** 30,
        mem_total_gib: total === null ? null : total / 2 ** 30,
        disk_pct: !size || free === null ? null : (1 - free / size) * 100,
        containers: get("containers", cadvisorJob),
      };
    }
    return values;
  }

  // Returns { values, text, snapshotMs, latestScore }.
  async function gather() {
    const snapshotMs = Math.floor(now() / 1000) * 1000;
    const [influx, promV] = await Promise.all([influxValues(), promValues()]);
    const values = { service_up: promV.service_up, ...influx.values, node_fyp_main: promV.node_fyp_main, node_staging: promV.node_staging };
    return { values, snapshotMs, text: renderFacts(values, snapshotMs).text, latestScore: influx.latestScore };
  }

  return { gather };
}

module.exports = {
  createFacts, renderFacts, renderLines, toIncidentValues, whatHappened, fmtTime, pyFixed,
  PROM_QUERIES, VALUE_KEYS, INCIDENTS_LISTED,
};
