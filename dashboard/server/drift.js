// Drift view: the daily false alarm rate from the saved detection report, the detection reference the
// worker keeps (measurement reference_level) and the model promotions (measurement model_retrain).
// buildDrift is a pure function so it can be unit tested without HTTP.
//
// evaluation_day is written by detection_report.py --save, one point per UTC day at 00:00 of that day, with
// the tag run_id (the UTC time of the run, ISO format). Several runs can cover the same day. The rule is:
// for each day the point from the NEWEST run wins, because a later run saw more of that day (the day of an
// earlier run was still partly unfinished) and may have used corrected ground truth. Days that only an
// older run covers are kept, so a later run over a shorter span does not remove history.

const DAY_MS = 24 * 60 * 60 * 1000;

// The days values the view offers. Anything else is a 400.
const DAYS = [7, 14, 30, 60];

// A day counts as a drift day when more than this share of its normal minutes were flagged (a fraction).
const EPISODE_RATE = 0.01;

// The worker's job tag for the monitored service.
const JOB = "sample-service";

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

function version(v) {
  const s = text(v);
  if (s === null) return null;
  return /^v/i.test(s) ? s : `v${s}`;
}

function startOfDay(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

// The run time as milliseconds, or null when the tag is missing or not a date.
function runTime(r) {
  const t = Date.parse(text(r.run_id) || "");
  return Number.isFinite(t) ? t : null;
}

// One entry per day, oldest first. rows come from InfluxDB, now is in ms.
function pickDays(rows, days, now) {
  const first = startOfDay(now) - (days - 1) * DAY_MS;
  const best = new Map();
  for (const r of rows || []) {
    const time = num(r && r.time);
    if (time === null) continue;
    const day = startOfDay(time);
    if (day < first || day > now) continue;
    const run = runTime(r);
    const old = best.get(day);
    // A point with no readable run time loses to any point that has one; later rows win ties.
    const rank = run === null ? -Infinity : run;
    if (!old || rank >= old.rank) best.set(day, { run, rank, row: r });
  }
  return [...best.keys()]
    .sort((a, b) => a - b)
    .map((day) => {
      const { run, row } = best.get(day);
      const normal = num(row.normal_minutes);
      const alarms = num(row.false_alarms);
      let rate = num(row.false_alarm_rate);
      if (rate === null && normal !== null && normal > 0 && alarms !== null) rate = alarms / normal;
      return {
        day,
        run,
        rate,
        false_alarms: alarms,
        normal_minutes: normal,
        scored_minutes: num(row.scored_minutes),
        flagged_minutes: num(row.flagged_minutes),
        injections: num(row.injections),
      };
    });
}

// Runs of consecutive days whose rate is above the threshold. A day with no rate, or a day with no
// report at all, ends a run. end is the end of the last day (exclusive).
function findEpisodes(days) {
  const episodes = [];
  let run = null;
  for (const d of days) {
    const high = d.rate !== null && d.rate > EPISODE_RATE;
    if (high && run && d.day - run.lastDay === DAY_MS) {
      run.days += 1;
      run.lastDay = d.day;
      run.peak_rate = Math.max(run.peak_rate, d.rate);
      run.false_alarms += d.false_alarms || 0;
    } else if (high) {
      run = { start: d.day, lastDay: d.day, days: 1, peak_rate: d.rate, false_alarms: d.false_alarms || 0 };
      episodes.push(run);
    } else {
      run = null;
    }
  }
  return episodes.map((e) => ({
    start: e.start,
    end: e.lastDay + DAY_MS,
    days: e.days,
    peak_rate: e.peak_rate,
    false_alarms: e.false_alarms,
  }));
}

function referencePoint(r) {
  return {
    time: Number(r.time),
    memory_median: num(r.memory_max_mb_median),
    memory_p99: num(r.memory_max_mb_p99),
    cpu_median: num(r.cpu_rate_median),
    cpu_p99: num(r.cpu_rate_p99),
    latency_median: num(r.latency_ms_median),
    latency_p99: num(r.latency_ms_p99),
    rejected: text(r.rejected) ? String(r.rejected).split(",") : [],
  };
}

function buildDrift({ evaluationRows, referenceRows, latestReferenceRows, retrainRows, days, now }) {
  const dayList = pickDays(evaluationRows, days, now);
  const reference = (referenceRows || []).filter((r) => r && num(r.time) !== null).map(referencePoint);
  const latestRows = (latestReferenceRows || []).filter((r) => r && num(r.time) !== null);
  const latest = latestRows.length ? referencePoint(latestRows[0]) : null;
  const from = startOfDay(now) - (days - 1) * DAY_MS;
  // The query reaches up to a day before the first shown day; promotions there are left out so the
  // count matches the chart. Reference points before it are kept, so the line starts at the left edge.
  const promotions = (retrainRows || [])
    .filter((r) => r && num(r.time) !== null && num(r.time) >= from && flag(r.promoted))
    .map((r) => ({
      time: Number(r.time),
      old_version: version(r.champion_version),
      new_version: version(r.new_version),
      old_f1: num(r.champion_f1),
      new_f1: num(r.challenger_f1),
    }))
    .sort((a, b) => a.time - b.time);
  return {
    days: dayList,
    reference,
    latest_reference: latest,
    promotions,
    episodes: findEpisodes(dayList),
    episode_rate: EPISODE_RATE,
    from,
    to: startOfDay(now) + DAY_MS,
  };
}

// days is a validated integer from the route, never request text.
async function loadDrift(query, days, now) {
  const d = String(Math.trunc(Number(days)));
  const widened = String(Math.trunc(Number(days)) + 1);
  const referenceFields =
    '"memory_max_mb_median","memory_max_mb_p99","cpu_rate_median","cpu_rate_p99","latency_ms_median","latency_ms_p99","rejected"';
  const [evaluationRows, referenceRows, latestReferenceRows, retrainRows] = await Promise.all([
    // One day more than asked, so the first day (a point at 00:00) is inside the range; pickDays trims it.
    query(
      'SELECT "run_id","scored_minutes","normal_minutes","false_alarms","false_alarm_rate","flagged_minutes","injections" ' +
        `FROM "evaluation_day" WHERE time > now() - ${widened}d ORDER BY time ASC`
    ),
    query(
      `SELECT ${referenceFields} FROM "reference_level" WHERE "job" = '${JOB}' AND time > now() - ${d}d ORDER BY time ASC`
    ),
    query(`SELECT ${referenceFields} FROM "reference_level" WHERE "job" = '${JOB}' ORDER BY time DESC LIMIT 1`),
    query(
      'SELECT "promoted","new_version","champion_version","champion_f1","challenger_f1" ' +
        `FROM "model_retrain" WHERE time > now() - ${d}d ORDER BY time ASC`
    ),
  ]);
  return buildDrift({ evaluationRows, referenceRows, latestReferenceRows, retrainRows, days: Number(d), now });
}

module.exports = { loadDrift, buildDrift, pickDays, findEpisodes, DAYS, EPISODE_RATE, DAY_MS };
