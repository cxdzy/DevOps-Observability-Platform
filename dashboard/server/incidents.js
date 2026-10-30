// Merges incident_explanation (closed incidents) and incident_open rows into one list.
// Pure function with no I/O so it can be unit tested.

const MATCH_WINDOW_MS = 120 * 1000;

function num(value, fallback) {
  const n = Number(value);
  return value === null || value === undefined || Number.isNaN(n) ? fallback : n;
}

function text(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function flag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function toIncident(row, status, explanation) {
  const start = num(row.time, 0);
  const minutes = num(row.minutes, 0);
  return {
    start,
    end: start + minutes * 60000,
    status,
    tier: text(row.tier),
    action: text(row.action),
    signal: text(row.signal),
    peakScore: num(row.peak_score, null),
    minutes,
    deployment: flag(row.deployment),
    source: text(row.source),
    explanation,
  };
}

function mergeIncidents(explRows, openRows, nowMs) {
  const closed = (explRows || []).filter((row) => row && row.time !== undefined && row.time !== null);
  const incidents = closed.map((row) => {
    const explanation = text(row.explanation);
    return toIncident(row, "closed", explanation === null ? null : explanation.replace(/\\n/g, "\n"));
  });

  // An open row near an explanation row is the same incident, which has since closed.
  for (const row of openRows || []) {
    if (!row || row.time === undefined || row.time === null) continue;
    const start = num(row.time, 0);
    if (closed.some((c) => Math.abs(num(c.time, 0) - start) <= MATCH_WINDOW_MS)) continue;
    const incident = toIncident(row, "open", null);
    if (nowMs >= incident.start + (incident.minutes + 5) * 60000) {
      incident.status = "awaiting_explanation";
    }
    incidents.push(incident);
  }

  return incidents.sort((a, b) => b.start - a.start);
}

module.exports = { mergeIncidents };
