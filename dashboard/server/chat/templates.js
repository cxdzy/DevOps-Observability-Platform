// Fixed answers to follow-up questions about one incident (cause, start, duration, deployment, the
// incident summary) and the "which incident do you mean" reply. Every value comes from the
// server's own incident record and scored minutes; a value that is missing is shown as "no data".
// Times are MYT, formatted by facts.fmtTime like the rest of the chat.
const { fmtTime, pyFixed } = require("./facts");

const JOB = "sample-service";
const SIGNAL_COLUMN = { cpu: "cpu_rate", memory: "memory_max_mb", latency: "latency_ms" };
const UNIT = { cpu_rate: ["", 4], memory_max_mb: [" MB", 0], latency_ms: [" ms", 1] };
const MAX_EXPLANATION = 400;
const CHOICES = 4;

// ------------------------------------------------------------------ incident detail

// Read-only query for the scored minutes of one incident. The bounds are the server's own record
// times, checked as safe integers, so nothing from the request reaches the query text.
function minutesQuery(startMs, endMs) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs < startMs) return null;
  return 'SELECT "score","threshold","cpu_rate","memory_max_mb","latency_ms",' +
    '"base_cpu_rate","base_memory_max_mb","base_latency_ms" ' +
    `FROM "anomaly_score" WHERE "job" = '${JOB}' AND time >= ${startMs}ms AND time < ${endMs}ms`;
}

function float(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The "What happened" and "Likely cause" lines of a stored explanation, or the whole text when it
// has neither, on one line and at most MAX_EXPLANATION characters. null when there is none.
function explanationText(explanation) {
  if (!explanation) return null;
  const lines = String(explanation).replace(/\\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  const picked = lines.filter((l) => /^(what happened|likely cause):/i.test(l));
  let text = (picked.length ? picked : lines).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > MAX_EXPLANATION) text = `${text.slice(0, MAX_EXPLANATION - 3).trimEnd()}...`;
  return text;
}

// { peakValue, reference, threshold, explanation } for the cause answer. rawIncidents are the
// merged incidents (incidents.js) of the same window; reference is the facts' normal reference,
// used when a scored minute has no base_* value. Failed reads give null values.
async function loadDetail(query, item, rawIncidents, reference) {
  const detail = { column: SIGNAL_COLUMN[item.signal] || null, peakValue: null, reference: null, threshold: null, explanation: null };
  const raw = (rawIncidents || []).find((i) => i.start === item.start_ms);
  detail.explanation = raw ? explanationText(raw.explanation) : null;

  const endMs = item.start_ms + Math.max(1, item.minutes || 0) * 60000;
  const q = minutesQuery(item.start_ms, endMs);
  let rows = [];
  if (q) {
    try {
      rows = (await query(q)) || [];
    } catch {
      rows = [];
    }
  }
  // The threshold of the minute with the highest score.
  let top = null;
  for (const r of rows) {
    const s = float(r.score);
    if (s !== null && (!top || s > float(top.score))) top = r;
  }
  if (top) detail.threshold = float(top.threshold);
  if (detail.column) {
    let peak = null;
    for (const r of rows) {
      const v = float(r[detail.column]);
      if (v !== null && (!peak || v > float(peak[detail.column]))) peak = r;
    }
    if (peak) {
      detail.peakValue = float(peak[detail.column]);
      detail.reference = float(peak[`base_${detail.column}`]);
    }
    if (detail.reference === null && reference) detail.reference = float(reference[detail.column]);
  }
  return detail;
}

// ------------------------------------------------------------------ answer text

const TEXT = {
  en: {
    noData: "no data",
    name: (time) => `The incident at ${time}`,
    yes: "yes", no: "no",
    cause: {
      signal: (name, tier, signal) => `${name} (tier ${tier}) was triggered by the ${signal} signal.`,
      unclear: (name, tier) => `${name} (tier ${tier}) had no single clear signal.`,
      ratio: (peak, ratio, ref) => `Its peak was ${peak}, ${ratio} the normal reference of ${ref}.`,
      score: (score, threshold) => `The peak anomaly score was ${score} against a threshold of ${threshold}.`,
      deployment: (yes) => (yes ? "It was linked to a deployment." : "It was not linked to a deployment."),
      deploymentUnknown: "There is no data on whether it was linked to a deployment.",
      stored: (text) => `Stored explanation: ${text}`,
      times: (r) => `${r} times`,
      end: "The dashboard has no logs or commit data, so it cannot name a root cause beyond the signal.",
    },
    start: (name, time, end, open) => (open
      ? `${name} started at ${time} MYT and is still open.`
      : `${name} started at ${time} MYT and ended at ${end} MYT.`),
    duration: (name, minutes, time, end, open) => (open
      ? `${name} has lasted ${minutes} min so far, since ${time} MYT. It is still open.`
      : `${name} lasted ${minutes} min, from ${time} to ${end} MYT.`),
    deployment: (name, yes) => (yes
      ? `Yes. ${name} is marked as linked to a deployment.`
      : `No. ${name} is not linked to a deployment.`),
    summary: (name, i, peak, status) => `${name}: tier ${i.tier}, signal ${i.signal}, ${i.minutes} min, peak ${peak}, ${status}` +
      `${i.deployment ? ", after a deployment" : ""}.`,
    status: { open: "open", closed: "closed" },
    whatHappened: (text) => ` What happened: ${text}`,
    which: "Which incident do you mean? Pick one of the latest incidents below.",
    whichNone: "Which incident do you mean? There were no incidents in the last 6 hours.",
    whichNoData: "Which incident do you mean? There is no incident data right now.",
    noEarlier: "There is no earlier incident in the last 6 hours.",
    noLater: "There is no later incident in the last 6 hours.",
  },
  ms: {
    noData: "tiada data",
    name: (time) => `Insiden pada ${time}`,
    yes: "ya", no: "tidak",
    cause: {
      signal: (name, tier, signal) => `${name} (tier ${tier}) dicetuskan oleh isyarat ${signal}.`,
      unclear: (name, tier) => `${name} (tier ${tier}) tiada satu isyarat yang jelas.`,
      ratio: (peak, ratio, ref) => `Puncaknya ${peak}, ${ratio} rujukan normal ${ref}.`,
      score: (score, threshold) => `Skor anomali puncak ialah ${score} berbanding ambang ${threshold}.`,
      deployment: (yes) => (yes ? "Ia berkaitan dengan deployment." : "Ia tidak berkaitan dengan deployment."),
      deploymentUnknown: "Tiada data sama ada ia berkaitan dengan deployment.",
      stored: (text) => `Penjelasan yang disimpan: ${text}`,
      times: (r) => `${r} kali`,
      end: "Dashboard tiada data log atau commit, jadi ia tidak dapat menamakan punca sebenar selain isyarat itu.",
    },
    start: (name, time, end, open) => (open
      ? `${name} bermula pada ${time} MYT dan masih terbuka.`
      : `${name} bermula pada ${time} MYT dan tamat pada ${end} MYT.`),
    duration: (name, minutes, time, end, open) => (open
      ? `${name} telah berlangsung ${minutes} minit setakat ini, sejak ${time} MYT. Ia masih terbuka.`
      : `${name} berlangsung ${minutes} minit, dari ${time} hingga ${end} MYT.`),
    deployment: (name, yes) => (yes
      ? `Ya. ${name} ditanda berkaitan dengan deployment.`
      : `Tidak. ${name} tidak berkaitan dengan deployment.`),
    summary: (name, i, peak, status) => `${name}: tier ${i.tier}, isyarat ${i.signal}, ${i.minutes} minit, puncak ${peak}, ${status}` +
      `${i.deployment ? ", selepas deployment" : ""}.`,
    status: { open: "terbuka", closed: "ditutup" },
    whatHappened: (text) => ` Apa yang berlaku: ${text}`,
    which: "Insiden yang mana satu? Pilih salah satu insiden terkini di bawah.",
    whichNone: "Insiden yang mana satu? Tiada insiden dalam 6 jam lepas.",
    whichNoData: "Insiden yang mana satu? Tiada data insiden sekarang.",
    noEarlier: "Tiada insiden yang lebih awal dalam 6 jam lepas.",
    noLater: "Tiada insiden yang lebih lewat dalam 6 jam lepas.",
  },
};

function textFor(lang) {
  return TEXT[lang] || TEXT.en;
}

function value(v, column, noData) {
  if (v === null || v === undefined) return noData;
  const [unit, digits] = UNIT[column] || ["", 3];
  return `${pyFixed(v, digits)}${unit}`;
}

function isOpen(item) {
  return item.status !== "closed";
}

function causeText(item, detail, snap, lang) {
  const t = textFor(lang);
  const c = t.cause;
  const name = t.name(fmtTime(item.start_ms, snap));
  const d = detail || {};
  const parts = [];
  const column = SIGNAL_COLUMN[item.signal];
  if (column) {
    parts.push(c.signal(name, item.tier, item.signal));
    const peak = value(d.peakValue, column, t.noData);
    const ref = value(d.reference, column, t.noData);
    const ratio = d.peakValue !== null && d.peakValue !== undefined && d.reference ? c.times(pyFixed(d.peakValue / d.reference, 1)) : t.noData;
    parts.push(c.ratio(peak, ratio, ref));
  } else {
    parts.push(c.unclear(name, item.tier));
  }
  const score = item.peak_score === null || item.peak_score === undefined ? t.noData : pyFixed(item.peak_score, 3);
  const threshold = d.threshold === null || d.threshold === undefined ? t.noData : pyFixed(d.threshold, 3);
  parts.push(c.score(score, threshold));
  parts.push(typeof item.deployment === "boolean" ? c.deployment(item.deployment) : c.deploymentUnknown);
  if (d.explanation) parts.push(c.stored(d.explanation));
  parts.push(c.end);
  return parts.join(" ");
}

function endTime(item, snap) {
  return fmtTime(item.start_ms + (item.minutes || 0) * 60000, snap);
}

function startText(item, detail, snap, lang) {
  const t = textFor(lang);
  const time = fmtTime(item.start_ms, snap);
  return t.start(t.name(time), time, endTime(item, snap), isOpen(item));
}

function durationText(item, detail, snap, lang) {
  const t = textFor(lang);
  const time = fmtTime(item.start_ms, snap);
  const minutes = Number.isFinite(item.minutes) ? item.minutes : t.noData;
  return t.duration(t.name(time), minutes, time, endTime(item, snap), isOpen(item));
}

function deploymentText(item, detail, snap, lang) {
  const t = textFor(lang);
  return t.deployment(t.name(fmtTime(item.start_ms, snap)), item.deployment === true);
}

function summaryText(item, detail, snap, lang) {
  const t = textFor(lang);
  const peak = item.peak_score === null || item.peak_score === undefined ? t.noData : pyFixed(item.peak_score, 3);
  let text = t.summary(t.name(fmtTime(item.start_ms, snap)), item, peak, isOpen(item) ? t.status.open : t.status.closed);
  if (item.what_happened) text += t.whatHappened(item.what_happened);
  return text;
}

const FOLLOWUP_TEMPLATES = {
  cause: causeText, start: startText, duration: durationText, deployment: deploymentText, last_incident: summaryText,
};

// The reply when the context names no incident that is still in the window.
function whichText(incidents, lang) {
  const t = textFor(lang);
  if (!incidents) return t.whichNoData;
  return incidents.items.length ? t.which : t.whichNone;
}

function endText(nav, lang) {
  const t = textFor(lang);
  return nav === "previous" ? t.noEarlier : t.noLater;
}

module.exports = {
  FOLLOWUP_TEMPLATES, causeText, startText, durationText, deploymentText, summaryText, whichText, endText,
  loadDetail, minutesQuery, explanationText, CHOICES,
};
