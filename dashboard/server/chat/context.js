// The chat's follow-up context: which incident the user was just asking about. The browser keeps
// it and sends it with each question; the server validates it, looks the incident up again in its
// own incident records, and returns the updated context with every reply. Values from the context
// are only compared with server data. They are never put into a prompt or a query: anything a
// reply says about an incident comes from the incident record found here. Pure functions, no I/O.

const MAX_BYTES = 2048;
const MAX_SHOWN = 8;
const WINDOW_H = 6;
// Same window as mergeIncidents (incidents.js): while an incident is open its start comes from
// incident_open, after it closes from incident_explanation, and the two can differ by up to 2 min.
const MATCH_WINDOW_MS = 120 * 1000;

const TIERS = ["low", "medium", "high", "none"];
const SIGNALS = ["cpu", "memory", "latency", "unclear", "none"];
// The answer kinds a later "previous" or "next" repeats. last_incident is the incident summary.
const INTENTS = ["cause", "start", "duration", "deployment", "last_incident"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function emptyContext() {
  return { last_incident: null, last_intent: null, last_window_h: WINDOW_H, shown: [] };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

// Milliseconds for a strict UTC ISO timestamp, else null.
function isoMs(value) {
  if (typeof value !== "string" || !ISO.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Rejects dates that parse but do not exist, such as 2026-02-30.
  const back = new Date(ms).toISOString();
  return back.slice(0, 19) === value.slice(0, 19) ? ms : null;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

// Returns a clean context. Anything invalid (wrong type, too big, too many entries, a bad
// timestamp, a tier or signal outside the known lists) gives the empty context. Unknown keys are
// dropped.
function validateContext(raw) {
  if (raw === null || raw === undefined) return emptyContext();
  if (!isPlainObject(raw)) return emptyContext();
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    return emptyContext();
  }
  if (size > MAX_BYTES) return emptyContext();

  const out = emptyContext();
  const li = raw.last_incident;
  if (li !== null && li !== undefined) {
    if (!isPlainObject(li)) return emptyContext();
    const ms = isoMs(li.start);
    if (ms === null || !TIERS.includes(li.tier) || !SIGNALS.includes(li.signal)) return emptyContext();
    out.last_incident = { start: toIso(ms), tier: li.tier, signal: li.signal };
  }
  const intent = raw.last_intent;
  if (intent !== null && intent !== undefined) {
    if (!INTENTS.includes(intent)) return emptyContext();
    out.last_intent = intent;
  }
  const hours = raw.last_window_h;
  if (hours !== null && hours !== undefined) {
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 7) return emptyContext();
  }
  const shown = raw.shown;
  if (shown !== null && shown !== undefined) {
    if (!Array.isArray(shown) || shown.length > MAX_SHOWN) return emptyContext();
    const list = [];
    for (const s of shown) {
      const ms = isoMs(s);
      if (ms === null) return emptyContext();
      list.push(toIso(ms));
    }
    out.shown = list;
  }
  return out;
}

// The incident record (facts item, newest first) the context points at: the nearest start within
// MATCH_WINDOW_MS. null when there is no context or the incident is no longer in the window.
function resolveIncident(context, items) {
  if (!context || !context.last_incident || !Array.isArray(items)) return null;
  const ms = isoMs(context.last_incident.start);
  if (ms === null) return null;
  let best = null;
  for (const item of items) {
    const d = Math.abs(item.start_ms - ms);
    if (d <= MATCH_WINDOW_MS && (!best || d < Math.abs(best.start_ms - ms))) best = item;
  }
  return best;
}

// The older (previous) or newer (next) neighbour of item in the newest-first list, or null.
function neighbour(items, item, direction) {
  const i = items.indexOf(item);
  if (i < 0) return null;
  const j = direction === "previous" ? i + 1 : i - 1;
  return j >= 0 && j < items.length ? items[j] : null;
}

function incidentRef(item) {
  return {
    start: toIso(item.start_ms),
    tier: TIERS.includes(item.tier) ? item.tier : "none",
    signal: SIGNALS.includes(item.signal) ? item.signal : "unclear",
  };
}

// A new context about item, built from the record's own values (start, tier, signal).
function aboutIncident(context, item, intent) {
  const base = context || emptyContext();
  return {
    ...base,
    last_incident: incidentRef(item),
    last_intent: INTENTS.includes(intent) ? intent : base.last_intent,
    last_window_h: WINDOW_H,
    shown: [toIso(item.start_ms)],
  };
}

// The context with the incidents a reply showed as chips.
function withShown(context, items) {
  const base = context || emptyContext();
  return { ...base, shown: items.slice(0, MAX_SHOWN).map((i) => toIso(i.start_ms)) };
}

module.exports = {
  validateContext, resolveIncident, neighbour, aboutIncident, withShown, emptyContext, isoMs, incidentRef,
  MAX_BYTES, MAX_SHOWN, MATCH_WINDOW_MS, TIERS, SIGNALS, INTENTS,
};
