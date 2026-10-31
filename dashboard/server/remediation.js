// Restarts from the remediation_action measurement, which the n8n workflow 5b writes only when a
// restart actually ran (mode is "auto" or "approved"). Each restart gets the open incident it most
// likely answered: same job, started at or before the restart and at most 30 minutes earlier.

const MATCH_WINDOW_MS = 30 * 60 * 1000;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

// rows and openRows come from InfluxDB; returns restarts newest first.
function matchRestarts(rows, openRows) {
  const incidents = (openRows || [])
    .filter((r) => r && num(r.time) !== null)
    .map((r) => ({ start: num(r.time), job: text(r.job), tier: text(r.tier), peak_score: num(r.peak_score) }));

  return (rows || [])
    .filter((r) => r && num(r.time) !== null)
    .map((r) => {
      const time = num(r.time);
      const job = text(r.job);
      let match = null;
      for (const i of incidents) {
        if (i.job !== job || i.start > time || time - i.start > MATCH_WINDOW_MS) continue;
        if (!match || i.start > match.start) match = i;
      }
      return {
        time,
        mode: text(r.mode),
        signal: text(r.signal),
        minutes: num(r.minutes),
        service_up: num(r.service_up),
        incident: match ? { start: match.start, tier: match.tier, peak_score: match.peak_score } : null,
      };
    })
    .sort((a, b) => b.time - a.time);
}

// hours is a validated integer from the route, never request text.
async function loadRemediation(query, hours) {
  const h = String(Math.trunc(Number(hours)));
  const [rows, openRows] = await Promise.all([
    query(
      'SELECT "mode","job","signal","minutes","service_up" FROM "remediation_action" ' +
        `WHERE time > now() - ${h}h ORDER BY time DESC`
    ),
    // Incidents can start up to 30 minutes before the oldest restart in the range.
    query(
      'SELECT "job","tier","peak_score" FROM "incident_open" ' +
        `WHERE time > now() - ${h}h - 30m ORDER BY time ASC`
    ),
  ]);
  return matchRestarts(rows, openRows);
}

module.exports = { loadRemediation, matchRestarts, MATCH_WINDOW_MS };
