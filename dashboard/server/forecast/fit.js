// Pure functions for the time-to-limit forecast. They take arrays and the config and return a
// result; nothing here reads a clock, the network or the database.
//
// A series is an array of [ms, value] pairs, value a number or null, oldest first.
//
// Every assessment returns { state, slope, r2, rise_pct, est_minutes, reason } plus the values the
// job stores (level, limit, window_min). slope is in units per minute, est_minutes in minutes.
// A value the data does not give is null, never a guess.

const MINUTE_MS = 60 * 1000;

function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// The pairs with a number, in time order.
function clean(series) {
  return (Array.isArray(series) ? series : []).filter((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]));
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Rolling minimum over the last k values (the value itself and the k - 1 before it). The first
// values use the ones that exist so far.
function envelope(values, k) {
  const size = Math.max(1, Math.trunc(k));
  return values.map((_, i) => Math.min(...values.slice(Math.max(0, i - size + 1), i + 1)));
}

// Theil-Sen line: the slope is the median of the slopes of every pair of points, the intercept the
// median of y - slope * x. Returns null for fewer than two distinct x values.
function theilSen(xs, ys) {
  const slopes = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const dx = xs[j] - xs[i];
      if (dx !== 0) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  if (!slopes.length) return null;
  const slope = median(slopes);
  const intercept = median(xs.map((x, i) => ys[i] - slope * x));
  return { slope, intercept };
}

// R squared of the line against the points. A series with no spread at all has nothing to
// explain, so it counts as 0 (not a steady rise).
function rSquared(xs, ys, slope, intercept) {
  if (ys.length < 2) return 0;
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < ys.length; i++) {
    ssTot += (ys[i] - mean) ** 2;
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
  }
  if (ssTot === 0) return 0;
  return Math.max(0, 1 - ssRes / ssTot);
}

// The last restart in a start time series: { at, from } where at is the new start time (ms) and
// from the time of the first point that carries it. null when the start time never changed.
function lastRestart(starts) {
  const s = clean(starts);
  let found = null;
  for (let i = 1; i < s.length; i++) {
    if (s[i][1] !== s[i - 1][1]) found = { at: s[i][1] * 1000, from: s[i][0] };
  }
  return found;
}

// Keeps the points from the last restart on. A restart is a change of the start time; a CI deploy
// (a new container id) changes it too, so it cuts the window the same way.
function cutAtRestart(points, starts) {
  const restart = lastRestart(starts);
  if (!restart) return { points: clean(points), restartAt: null };
  const from = Math.max(restart.from, restart.at);
  return { points: clean(points).filter((p) => p[0] >= from), restartAt: restart.at };
}

// The number of start time changes at or after sinceMs.
function countChanges(starts, sinceMs) {
  const s = clean(starts);
  let n = 0;
  for (let i = 1; i < s.length; i++) if (s[i][0] >= sinceMs && s[i][1] !== s[i - 1][1]) n++;
  return n;
}

// True when the OOM counter went up at or after sinceMs. A drop is a counter reset (a new
// container), not an event.
function oomIncreased(ooms, sinceMs) {
  const s = clean(ooms);
  for (let i = 1; i < s.length; i++) if (s[i][0] >= sinceMs && s[i][1] > s[i - 1][1]) return true;
  return false;
}

function empty(state, reason, extra = {}) {
  return { state, slope: null, r2: null, rise_pct: null, est_minutes: null, reason, level: null, limit: null, window_min: null, ...extra };
}

// The trend of a series against a limit with one rule (config memory or disk). points must be
// clean; limit a positive number.
function assessTrend(points, limit, rule) {
  if (points.length < 2) return empty("not_enough_data", "too_few_points", { limit });
  const t0 = points[0][0];
  const xs = points.map((p) => (p[0] - t0) / MINUTE_MS);
  const span = xs[xs.length - 1];
  if (span < rule.minMinutes) return empty("not_enough_data", "too_few_points", { limit, level: points[points.length - 1][1], window_min: span });
  const env = envelope(points.map((p) => p[1]), (rule.envelopeMin * 60) / rule.stepSec);
  const line = theilSen(xs, env);
  if (!line) return empty("not_enough_data", "too_few_points", { limit });
  const r2 = rSquared(xs, env, line.slope, line.intercept);
  const risePct = ((line.slope * span) / limit) * 100;
  const latestEnvelope = env[env.length - 1];
  const est = line.slope > 0 ? Math.max(0, (limit - latestEnvelope) / line.slope) : null;
  const warn = line.slope > 0 && r2 >= rule.minR2 && risePct >= rule.minRisePct && est !== null && est <= rule.maxEstMin;
  let reason = "trend";
  if (!warn) {
    if (!(line.slope > 0)) reason = "not_rising";
    else if (r2 < rule.minR2) reason = "not_steady";
    else if (risePct < rule.minRisePct) reason = "small_rise";
    else reason = "far";
  }
  return {
    state: warn ? "warning" : "ok",
    slope: line.slope,
    r2,
    rise_pct: risePct,
    est_minutes: est,
    reason,
    level: points[points.length - 1][1],
    limit,
    window_min: span,
  };
}

// True when the limit is a real one: above 0, below the kernel's unlimited value and not larger
// than the host memory (when the host memory is known).
function hasLimit(limit, hostBytes, config) {
  if (!finite(limit) || limit <= 0 || limit >= config.unlimitedBytes) return false;
  if (finite(hostBytes) && hostBytes > 0 && limit > hostBytes) return false;
  return true;
}

// Memory of one container. input: { points (working set), limit (latest limit), hostBytes,
// starts (start time series) }. The result also has restart_at, the time of the last restart in
// the window (ms) or null.
function assessMemory({ points, limit, hostBytes, starts }, config) {
  const rule = config.memory;
  if (!hasLimit(limit, hostBytes, config)) {
    const latest = clean(points);
    return empty("no_limit", "no_limit", { level: latest.length ? latest[latest.length - 1][1] : null, restart_at: lastRestart(starts)?.at ?? null });
  }
  const cut = cutAtRestart(points, starts);
  const result = assessTrend(cut.points, limit, rule);
  if (cut.restartAt !== null && result.state === "not_enough_data") result.reason = "restart";
  return { ...result, restart_at: cut.restartAt };
}

// One filesystem. input: { size, avail } series. The level is the used bytes (size minus
// available), the limit the latest size. used_pct is the latest used share in percent.
function assessDisk({ size, avail }, config) {
  const sizes = new Map(clean(size).map((p) => [p[0], p[1]]));
  const used = clean(avail)
    .filter((p) => sizes.has(p[0]) && sizes.get(p[0]) > 0)
    .map((p) => [p[0], sizes.get(p[0]) - p[1]]);
  if (!used.length) return { ...empty("no_data", "no_series"), used_pct: null };
  const limit = sizes.get(used[used.length - 1][0]);
  const result = assessTrend(used, limit, config.disk);
  const level = used[used.length - 1][1];
  return { ...result, level, limit, used_pct: (level / limit) * 100 };
}

// Restarts of one container in the restart window ending at nowMs. A rise of the OOM counter
// raises the same warning with the reason oom.
function assessRestarts({ starts, ooms, nowMs }, config) {
  const since = nowMs - config.restarts.windowMin * MINUTE_MS;
  const changes = countChanges(starts, since);
  const oom = oomIncreased(ooms, since);
  const looping = changes >= config.restarts.minChanges;
  const state = looping || oom ? "restarting" : "ok";
  const reason = looping ? "restarts" : oom ? "oom" : "steady";
  return { ...empty(state, reason), changes, oom };
}

module.exports = {
  clean,
  median,
  envelope,
  theilSen,
  rSquared,
  lastRestart,
  cutAtRestart,
  countChanges,
  oomIncreased,
  hasLimit,
  assessTrend,
  assessMemory,
  assessDisk,
  assessRestarts,
};
