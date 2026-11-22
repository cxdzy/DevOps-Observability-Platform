// Evaluation report for the forecast warnings. Read only: it selects forecast_events and the
// registry from PostgreSQL in a read-only session and reads history from Prometheus. It writes to
// no database and sends nothing.
//
//   docker compose exec dashboard node server/scripts/forecast-report.js \
//     --from 2026-11-22T00:00:00Z --to 2026-11-23T00:00:00Z [--exclude <UTC> <UTC>]...
//
// For every warning opened in the window it finds the outcome in Prometheus history: for memory
// the first time the working set reached 95 percent of the limit and the first restart or OOM
// kill after the warning; for disk the first time the disk reached 95 percent used. A warning is
// true when an outcome comes within 1.5 times the estimate at open plus 10 minutes. Misses (a 95
// percent event or an OOM kill with no warning open in the 120 minutes before it) are listed
// separately. --exclude drops warnings opened and events found in that window (it may repeat).
const { FORECAST_CONFIG } = require("../forecast/config");

const MINUTE_MS = 60 * 1000;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const USAGE = "Usage: node server/scripts/forecast-report.js --from <UTC> --to <UTC> [--exclude <UTC> <UTC>]...";

// ---- Arguments

function parseTime(value, name) {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO UTC time such as 2026-11-22T08:00:00Z. ${USAGE}`);
  }
  return Date.parse(value);
}

function parseArgs(argv) {
  let from = null;
  let to = null;
  const excludes = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") from = parseTime(argv[++i], "--from");
    else if (a === "--to") to = parseTime(argv[++i], "--to");
    else if (a === "--exclude") {
      const s = parseTime(argv[++i], "--exclude start");
      const e = parseTime(argv[++i], "--exclude end");
      if (e <= s) throw new Error("--exclude end must be after its start.");
      excludes.push([s, e]);
    } else throw new Error(`Unknown argument ${a}. ${USAGE}`);
  }
  if (from === null || to === null) throw new Error(USAGE);
  if (to <= from) throw new Error("--to must be after --from.");
  return { from, to, excludes };
}

// ---- Pure evaluation

const excluded = (ms, excludes) => excludes.some(([s, e]) => ms >= s && ms < e);
const ms = (v) => (v === null || v === undefined ? null : new Date(v).getTime());
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const clean = (s) => (Array.isArray(s) ? s : []).filter((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]));

function valueAt(series, t) {
  let v = null;
  for (const [pt, pv] of series) {
    if (pt > t) break;
    v = pv;
  }
  return v;
}

// The first time at or after fromMs (and before toMs) that used / limit reached pct percent.
// limit is a series, or a series of sizes for disk where used = size - avail.
function firstReach(points, limits, pct, fromMs, toMs) {
  for (const [t, v] of points) {
    if (t < fromMs || t > toMs) continue;
    const limit = valueAt(limits, t);
    if (finite(limit) && limit > 0 && v * 100 >= limit * pct) return t;
  }
  return null;
}

// The first start time change or OOM counter rise after fromMs.
function firstRestart(starts, ooms, fromMs, toMs) {
  let best = null;
  for (const series of [starts, ooms]) {
    for (let i = 1; i < series.length; i++) {
      const [t, v] = series[i];
      if (t <= fromMs || t > toMs) continue;
      const changed = series === starts ? v !== series[i - 1][1] : v > series[i - 1][1];
      if (changed) {
        if (best === null || t < best) best = t;
        break;
      }
    }
  }
  return best;
}

// Used bytes per available point, with the size last reported at or before that point.
function diskUsed(h) {
  const size = clean(h.size);
  return clean(h.avail)
    .map((p) => [p[0], valueAt(size, p[0]), p[1]])
    .filter((p) => finite(p[1]))
    .map(([t, s, a]) => [t, s - a]);
}

const keyFor = (w) => (w.resource === "disk" ? `disk|${w.server}|${w.mountpoint}` : `memory|${w.server}|${w.container}`);

// warning: a forecast_events row. history: by key, { ws, limit, start, oom } for a container and
// { size, avail } for a disk. Returns the outcome row.
function outcomeFor(w, history, to, config) {
  const r = config.report;
  const opened = ms(w.opened_at);
  const h = history[keyFor(w)] || {};
  const est = finite(Number(w.est_minutes_at_open)) && w.est_minutes_at_open !== null ? Number(w.est_minutes_at_open) : null;
  const out = { reachAt: null, restartAt: null, outcomeAt: null, deadline: null, verdict: "not scored", leadMin: null, errorMin: null };
  if (w.resource === "disk") {
    const size = clean(h.size);
    out.reachAt = firstReach(diskUsed(h), size, r.outcomePct, opened, to);
  } else {
    out.reachAt = w.resource === "memory" ? firstReach(clean(h.ws), clean(h.limit), r.outcomePct, opened, to) : null;
    out.restartAt = firstRestart(clean(h.start), clean(h.oom), opened, to);
  }
  const times = [out.reachAt, out.restartAt].filter((t) => t !== null);
  out.outcomeAt = times.length ? Math.min(...times) : null;
  // Restart-loop warnings have no estimate, so they are listed but not scored.
  if (w.resource === "restarts" || est === null) return out;
  out.deadline = opened + (r.estFactor * est + r.estPlusMin) * MINUTE_MS;
  if (out.outcomeAt !== null && out.outcomeAt <= out.deadline) {
    out.verdict = "true";
    out.leadMin = (out.outcomeAt - opened) / MINUTE_MS;
    out.errorMin = est - out.leadMin;
  } else if (out.deadline <= to) {
    out.verdict = "false";
  } else {
    // The deadline is after the end of the report window and nothing has happened yet.
    out.verdict = "undecided";
  }
  return out;
}

// Events with no warning open in the lookback before them: memory 95 percent crossings and OOM
// kills per container, disk 95 percent crossings per filesystem.
function findMisses(warnings, history, from, to, excludes, config) {
  const r = config.report;
  const misses = [];
  const openNear = (match, t) =>
    warnings.some((w) => match(w) && ms(w.opened_at) <= t && (w.closed_at === null || w.closed_at === undefined || ms(w.closed_at) >= t - r.missLookbackMin * MINUTE_MS));
  for (const [key, h] of Object.entries(history)) {
    const [kind, server, name] = key.split("|");
    const events = [];
    if (kind === "memory") {
      const ws = clean(h.ws);
      const limit = clean(h.limit);
      let above = false;
      for (const [t, v] of ws) {
        const l = valueAt(limit, t);
        const now = finite(l) && l > 0 && v * 100 >= l * r.outcomePct;
        if (now && !above) events.push({ t, what: `memory reached ${r.outcomePct} percent of the limit` });
        above = now;
      }
      const oom = clean(h.oom);
      for (let i = 1; i < oom.length; i++) if (oom[i][1] > oom[i - 1][1]) events.push({ t: oom[i][0], what: "OOM kill" });
    } else if (kind === "disk") {
      const size = clean(h.size);
      let above = false;
      for (const [t, v] of diskUsed(h)) {
        const s = valueAt(size, t);
        const now = finite(s) && s > 0 && v * 100 >= s * r.outcomePct;
        if (now && !above) events.push({ t, what: `disk reached ${r.outcomePct} percent used` });
        above = now;
      }
    }
    for (const e of events) {
      if (e.t < from || e.t >= to || excluded(e.t, excludes)) continue;
      const match =
        kind === "disk"
          ? (w) => w.resource === "disk" && w.server === server && w.mountpoint === name
          : (w) => (w.resource === "memory" || w.resource === "restarts") && w.server === server && w.container === name;
      if (!openNear(match, e.t)) misses.push({ kind, server, name, at: e.t, what: e.what });
    }
  }
  return misses.sort((a, b) => a.at - b.at);
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const utc = (t) => (t === null || t === undefined ? "none" : new Date(t).toISOString().replace(".000Z", "Z"));
const minutes = (m) => (m === null || m === undefined ? "none" : `${m.toFixed(1)} min`);
const signed = (m) => (m === null || m === undefined ? "none" : `${m >= 0 ? "+" : ""}${m.toFixed(1)} min`);

// The whole report as { rows, misses, summary, markdown }.
function buildReport({ from, to, excludes = [], warnings, history, config = FORECAST_CONFIG }) {
  const kept = warnings.filter((w) => {
    const t = ms(w.opened_at);
    return t >= from && t < to && !excluded(t, excludes);
  });
  const rows = kept.map((w) => ({ warning: w, ...outcomeFor(w, history, to, config) }));
  const misses = findMisses(warnings, history, from, to, excludes, config);
  const scored = rows.filter((r) => r.verdict === "true" || r.verdict === "false");
  const trueRows = rows.filter((r) => r.verdict === "true");
  const summary = {
    warnings: rows.length,
    scored: scored.length,
    true: trueRows.length,
    false: rows.filter((r) => r.verdict === "false").length,
    undecided: rows.filter((r) => r.verdict === "undecided").length,
    notScored: rows.filter((r) => r.verdict === "not scored").length,
    misses: misses.length,
    medianLeadMin: median(trueRows.map((r) => r.leadMin)),
    medianAbsErrorMin: median(trueRows.map((r) => Math.abs(r.errorMin))),
  };

  const lines = [];
  lines.push(`# Forecast report, ${utc(from)} to ${utc(to)}`, "");
  if (excludes.length) lines.push(`Excluded: ${excludes.map(([s, e]) => `${utc(s)} to ${utc(e)}`).join(", ")}`, "");
  lines.push(`Config version ${config.version}. True means an outcome within ${config.report.estFactor} times the estimate at open plus ${config.report.estPlusMin} minutes.`, "");
  lines.push("## Warnings", "");
  if (!rows.length) lines.push("No warnings were opened in this window.", "");
  else {
    lines.push("| Container | Resource | Opened (UTC) | Estimate at open | 95 percent reached | Restart or OOM | Outcome | Lead time | Estimate error |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const w = r.warning;
      const what = w.resource === "disk" ? `${w.server} ${w.mountpoint}` : `${w.server} ${w.container}`;
      lines.push(
        `| ${what} | ${w.resource} | ${utc(ms(w.opened_at))} | ${minutes(w.est_minutes_at_open === null ? null : Number(w.est_minutes_at_open))} | ${utc(r.reachAt)} | ${w.resource === "disk" ? "n/a" : utc(r.restartAt)} | ${r.verdict} | ${minutes(r.leadMin)} | ${signed(r.errorMin)} |`
      );
    }
    lines.push("");
  }
  lines.push("## Summary", "");
  lines.push(`- Warnings: ${summary.warnings} (${summary.scored} scored)`);
  lines.push(`- True warnings: ${summary.true}`);
  lines.push(`- False warnings: ${summary.false}`);
  if (summary.undecided) lines.push(`- Undecided (the deadline is after the end of the window): ${summary.undecided}`);
  if (summary.notScored) lines.push(`- Restart-loop warnings, listed but not scored (they have no estimate): ${summary.notScored}`);
  lines.push(`- Median lead time: ${minutes(summary.medianLeadMin)}`);
  lines.push(`- Lead time per true warning: ${trueRows.length ? trueRows.map((r) => minutes(r.leadMin)).join(", ") : "none"}`);
  lines.push(`- Estimate error (estimate at open minus actual minutes) per true warning: ${trueRows.length ? trueRows.map((r) => signed(r.errorMin)).join(", ") : "none"}`);
  lines.push(`- Median absolute estimate error: ${minutes(summary.medianAbsErrorMin)}`, "");
  lines.push("## Misses", "");
  if (!misses.length) lines.push("None.");
  else {
    lines.push("| Where | Time (UTC) | Event |", "|---|---|---|");
    for (const m of misses) lines.push(`| ${m.server} ${m.name} | ${utc(m.at)} | ${m.what} |`);
  }
  return { rows, misses, summary, markdown: lines.join("\n") + "\n" };
}

// ---- Reading the data (only when run as a script)

async function readHistory(prom, targets, from, to, config) {
  const { memoryQuery, diskQuery } = require("../forecast/job");
  const r = config.report;
  const history = {};
  const chunk = r.chunkHours * 60 * MINUTE_MS;
  async function range(q, step, fn) {
    for (let s = from; s < to; s += chunk) {
      const e = Math.min(to, s + chunk);
      const rows = await prom.queryRange(q, Math.floor(s / 1000), Math.floor(e / 1000), step);
      for (const row of rows) fn(row);
    }
  }
  for (const t of targets) {
    const mq = memoryQuery(t.server, t.containers.map((c) => c.name));
    if (mq) {
      await range(mq, r.stepSec, (row) => {
        const m = row.labels.m;
        const name = row.labels.name;
        if (!name || !["ws", "limit", "start", "oom"].includes(m)) return;
        const h = (history[`memory|${t.server.key}|${name}`] ||= { ws: [], limit: [], start: [], oom: [] });
        h[m].push(...row.values);
      });
    }
    const dq = diskQuery(t.server, config);
    if (dq) {
      await range(dq, r.diskStepSec, (row) => {
        const m = row.labels.m;
        if (!["size", "avail"].includes(m)) return;
        const h = (history[`disk|${t.server.key}|${row.labels.mountpoint}`] ||= { size: [], avail: [] });
        h[m].push(...row.values);
      });
    }
  }
  for (const h of Object.values(history)) for (const k of Object.keys(h)) h[k].sort((a, b) => a[0] - b[0]);
  return history;
}

async function main() {
  const { Pool } = require("pg");
  const { createDb, isValidDatabaseUrl } = require("../db");
  const { createRegistry } = require("../registry");
  const { createPrometheus } = require("../prometheus");
  const { buildTargets, memoryQuery, diskQuery } = require("../forecast/job");

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (!isValidDatabaseUrl(process.env.DATABASE_URL)) {
    console.error("DATABASE_URL is not set or not valid.");
    process.exit(1);
  }
  const config = FORECAST_CONFIG;
  // Every transaction on these connections is read only, so nothing here can write.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: "-c default_transaction_read_only=on" });
  try {
    const lookback = config.report.missLookbackMin * MINUTE_MS;
    const { rows: warnings } = await pool.query(
      `SELECT id, resource, server, project, container, mountpoint, opened_at, closed_at, close_reason, est_minutes_at_open, config_version
         FROM forecast_events WHERE opened_at < $2 AND (closed_at IS NULL OR closed_at >= $1) ORDER BY opened_at, id`,
      [new Date(args.from - lookback), new Date(args.to)]
    );
    // The registry without a targets writer, so no file is written either.
    const registry = createRegistry({ db: createDb(pool), targets: null, log: () => {} });
    const snap = await registry.load();
    const targets = buildTargets(snap, config);
    const allowed = targets.flatMap((t) => [memoryQuery(t.server, t.containers.map((c) => c.name)), diskQuery(t.server, config)].filter(Boolean));
    const prom = createPrometheus({ allowed });
    const history = await readHistory(prom, targets, args.from - lookback, args.to, config);
    const report = buildReport({ from: args.from, to: args.to, excludes: args.excludes, warnings, history, config });
    process.stdout.write(report.markdown);
  } catch (err) {
    console.error(`The report could not be made: ${String(err && err.message)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { parseArgs, outcomeFor, findMisses, buildReport };
