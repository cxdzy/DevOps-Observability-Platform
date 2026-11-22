// Fixed answers to follow-up questions about one incident (cause, start, duration, deployment,
// restart, peak, tier, the incident summary) and the "which incident do you mean" reply. Every value
// comes from the server's own incident record, scored minutes and remediation_action rows; a value
// that is missing is shown as "no data". Times are MYT, formatted by facts.fmtTime like the rest of
// the chat.
const { fmtTime, pyFixed } = require("./facts");
const { matchRestarts, MATCH_WINDOW_MS: ACTION_MATCH_MS } = require("../remediation");

const JOB = "sample-service";
const SIGNAL_COLUMN = { cpu: "cpu_rate", memory: "memory_max_mb", latency: "latency_ms" };
const UNIT = { cpu_rate: ["", 4], memory_max_mb: [" MB", 0], latency_ms: [" ms", 1] };
const MAX_EXPLANATION = 400;
const CHOICES = 4;
// Same tolerance as context.js: an incident's start can differ by up to 2 min between its rows.
const START_MATCH_MS = 120 * 1000;
const MAX_ACTIONS_SHOWN = 3;

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

// Read-only queries for the restarts and rollbacks of one incident: remediation_action rows from its
// start to 30 minutes after its end, and the incident_open rows that matchRestarts needs to decide
// which incident each action answered. Bounds are the server's own record times as safe integers.
function restartQueries(startMs, endMs) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs < startMs) return null;
  const to = endMs + ACTION_MATCH_MS;
  return {
    actions: 'SELECT "action","mode","outcome","service_up" FROM "remediation_action" ' +
      `WHERE "job" = '${JOB}' AND time >= ${startMs}ms AND time <= ${to}ms ORDER BY time ASC`,
    opens: 'SELECT "tier","peak_score" FROM "incident_open" ' +
      `WHERE "job" = '${JOB}' AND time >= ${startMs - ACTION_MATCH_MS}ms AND time <= ${to}ms ORDER BY time ASC`,
  };
}

// The actions matched to this incident (matchRestarts in remediation.js, as on the Remediation and
// incident timeline views), oldest first, or null when the rows could not be read.
async function loadRestarts(query, item) {
  const endMs = item.start_ms + Math.max(1, item.minutes || 0) * 60000;
  const q = restartQueries(item.start_ms, endMs);
  if (!q) return null;
  let actions;
  let opens;
  try {
    [actions, opens] = await Promise.all([query(q.actions), query(q.opens)]);
  } catch {
    return null;
  }
  const withJob = (rows) => (rows || []).map((r) => ({ ...r, job: JOB }));
  const openRows = withJob(opens);
  // An incident that has no incident_open row (older explainer versions) still gets its actions.
  if (!openRows.some((r) => Math.abs(Number(r.time) - item.start_ms) <= START_MATCH_MS)) {
    openRows.push({ time: item.start_ms, job: JOB, tier: item.tier, peak_score: item.peak_score });
  }
  return matchRestarts(withJob(actions), openRows)
    .filter((a) => a.incident && Math.abs(a.incident.start - item.start_ms) <= START_MATCH_MS)
    .sort((a, b) => a.time - b.time);
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
    peak: (name, score, threshold) => `${name} peaked at an anomaly score of ${score} against a threshold of ${threshold}.`,
    tier: (name, tier) => `${name} was tier ${tier}.`,
    tierNoData: (name) => `${name} has no tier data.`,
    tierMeaning: {
      low: "Tier low sends a notification only. Nothing is restarted.",
      medium: "Tier medium offers a container restart.",
      high: "Tier high offers a rollback to the previous image.",
    },
    restart: {
      noData: (name) => `There is no data on restarts or rollbacks for ${name.charAt(0).toLowerCase()}${name.slice(1)}.`,
      none: (name) => `Nothing was restarted or rolled back for ${name.charAt(0).toLowerCase()}${name.slice(1)}.`,
      head: (name) => `For ${name.charAt(0).toLowerCase()}${name.slice(1)}:`,
      more: (n) => `${n} more ${n === 1 ? "action is" : "actions are"} on the Remediation page.`,
      noun: { restart: "restart", rollback: "rollback" },
      verbed: { restart: "restarted", rollback: "rolled back" },
      how: { auto: " ran automatically and", approved: " was approved on Telegram and" },
      success: (noun, time, how) => `a ${noun} at ${time} MYT${how || ""} succeeded`,
      failed: (noun, time, how) => `a ${noun} at ${time} MYT${how || ""} did not succeed`,
      up: ", and the service was back up 60 s later",
      down: ", and the service was still down 60 s later",
      rejected: (noun, time, verbed) => `a ${noun} request at ${time} MYT was rejected, so nothing was ${verbed}`,
      expired: (noun, time, verbed) => `a ${noun} request at ${time} MYT expired without an answer, so nothing was ${verbed}`,
      skipped: (noun, time, reason) => `a ${noun} request at ${time} MYT was skipped because ${reason}`,
      other: (noun, time, outcome) => `a ${noun} request at ${time} MYT ended with outcome ${outcome}`,
      unknown: (noun, time) => `a ${noun} request at ${time} MYT has no recorded outcome`,
      reasons: {
        skipped_cooldown: "a restart had run recently (cooldown)",
        skipped_closed: "the incident had already closed",
        skipped_simulated: "the incident came from a fault injection test",
        skipped_no_previous_image: "there was no earlier image to go back to",
        skipped_no_deployment: "there was no CI deployment in the last 15 minutes",
      },
    },
    which: "Which incident do you mean? Pick one of the latest incidents below.",
    whichNone: "Which incident do you mean? There were no incidents in the last 6 hours.",
    whichNoData: "Which incident do you mean? There is no incident data right now.",
    whichTime: (clock) => `Which incident do you mean? No incident started at ${clock} MYT in the last 6 hours. Pick one of the latest incidents below.`,
    whichTimeNone: (clock) => `Which incident do you mean? No incident started at ${clock} MYT, and there were no incidents in the last 6 hours.`,
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
    peak: (name, score, threshold) => `${name} memuncak pada skor anomali ${score} berbanding ambang ${threshold}.`,
    tier: (name, tier) => `${name} ialah tier ${tier}.`,
    tierNoData: (name) => `${name} tiada data tier.`,
    tierMeaning: {
      low: "Tier low hanya menghantar notifikasi. Tiada apa yang di-restart.",
      medium: "Tier medium menawarkan restart container.",
      high: "Tier high menawarkan rollback ke imej sebelumnya.",
    },
    restart: {
      noData: (name) => `Tiada data restart atau rollback untuk ${name.charAt(0).toLowerCase()}${name.slice(1)}.`,
      none: (name) => `Tiada restart atau rollback untuk ${name.charAt(0).toLowerCase()}${name.slice(1)}.`,
      head: (name) => `Untuk ${name.charAt(0).toLowerCase()}${name.slice(1)}:`,
      more: (n) => `${n} lagi tindakan ada di halaman Remediation.`,
      noun: { restart: "restart", rollback: "rollback" },
      verbed: { restart: "di-restart", rollback: "di-rollback" },
      how: { auto: " dijalankan secara automatik dan", approved: " diluluskan di Telegram dan" },
      success: (noun, time, how) => `${noun} pada ${time} MYT${how || ""} berjaya`,
      failed: (noun, time, how) => `${noun} pada ${time} MYT${how || ""} tidak berjaya`,
      up: ", dan servis kembali aktif 60 s kemudian",
      down: ", dan servis masih tidak aktif 60 s kemudian",
      rejected: (noun, time, verbed) => `permintaan ${noun} pada ${time} MYT ditolak, jadi tiada apa yang ${verbed}`,
      expired: (noun, time, verbed) => `permintaan ${noun} pada ${time} MYT tamat tempoh tanpa jawapan, jadi tiada apa yang ${verbed}`,
      skipped: (noun, time, reason) => `permintaan ${noun} pada ${time} MYT dilangkau kerana ${reason}`,
      other: (noun, time, outcome) => `permintaan ${noun} pada ${time} MYT berakhir dengan hasil ${outcome}`,
      unknown: (noun, time) => `permintaan ${noun} pada ${time} MYT tiada hasil yang direkodkan`,
      reasons: {
        skipped_cooldown: "restart baru sahaja dijalankan (cooldown)",
        skipped_closed: "insiden sudah ditutup",
        skipped_simulated: "insiden itu daripada ujian suntikan kerosakan",
        skipped_no_previous_image: "tiada imej sebelumnya untuk kembali",
        skipped_no_deployment: "tiada deployment CI dalam 15 minit lepas",
      },
    },
    which: "Insiden yang mana satu? Pilih salah satu insiden terkini di bawah.",
    whichNone: "Insiden yang mana satu? Tiada insiden dalam 6 jam lepas.",
    whichNoData: "Insiden yang mana satu? Tiada data insiden sekarang.",
    whichTime: (clock) => `Insiden yang mana satu? Tiada insiden bermula pada ${clock} MYT dalam 6 jam lepas. Pilih salah satu insiden terkini di bawah.`,
    whichTimeNone: (clock) => `Insiden yang mana satu? Tiada insiden bermula pada ${clock} MYT, dan tiada insiden dalam 6 jam lepas.`,
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

function peakText(item, detail, snap, lang) {
  const t = textFor(lang);
  const d = detail || {};
  const score = item.peak_score === null || item.peak_score === undefined ? t.noData : pyFixed(item.peak_score, 3);
  const threshold = d.threshold === null || d.threshold === undefined ? t.noData : pyFixed(d.threshold, 3);
  return t.peak(t.name(fmtTime(item.start_ms, snap)), score, threshold);
}

function tierText(item, detail, snap, lang) {
  const t = textFor(lang);
  const name = t.name(fmtTime(item.start_ms, snap));
  const meaning = t.tierMeaning[item.tier];
  if (!meaning) return t.tierNoData(name);
  return `${t.tier(name, item.tier)} ${meaning}`;
}

function actionText(a, snap, r) {
  const kind = a.action === "rollback" ? "rollback" : "restart";
  const noun = r.noun[kind];
  const verbed = r.verbed[kind];
  const time = fmtTime(a.time, snap);
  const how = r.how[a.mode];
  if (a.outcome === "success" || a.outcome === "failed") {
    let text = a.outcome === "success" ? r.success(noun, time, how) : r.failed(noun, time, how);
    if (a.service_up === 1) text += r.up;
    else if (a.service_up === 0) text += r.down;
    return text;
  }
  if (a.outcome === "rejected") return r.rejected(noun, time, verbed);
  if (a.outcome === "expired") return r.expired(noun, time, verbed);
  if (r.reasons[a.outcome]) return r.skipped(noun, time, r.reasons[a.outcome]);
  if (a.outcome) return r.other(noun, time, String(a.outcome).replace(/[^a-z0-9_]/gi, "").slice(0, 40) || "unknown");
  return r.unknown(noun, time);
}

// detail.restarts: the actions from loadRestarts, or null when they could not be read.
function restartText(item, detail, snap, lang) {
  const t = textFor(lang);
  const r = t.restart;
  const name = t.name(fmtTime(item.start_ms, snap));
  const actions = detail ? detail.restarts : null;
  if (!Array.isArray(actions)) return r.noData(name);
  if (actions.length === 0) return r.none(name);
  const shown = actions.slice(0, MAX_ACTIONS_SHOWN).map((a) => actionText(a, snap, r));
  let text = `${r.head(name)} ${shown.join("; ")}.`;
  if (actions.length > MAX_ACTIONS_SHOWN) text += ` ${r.more(actions.length - MAX_ACTIONS_SHOWN)}`;
  return text;
}

const FOLLOWUP_TEMPLATES = {
  cause: causeText, start: startText, duration: durationText, deployment: deploymentText, restart: restartText,
  peak: peakText, tier: tierText, last_incident: summaryText,
};

// The reply when the context names no incident that is still in the window. time is the
// { hour, minute } a message named when no incident started then.
function whichText(incidents, lang, time = null) {
  const t = textFor(lang);
  if (!incidents) return t.whichNoData;
  if (time) {
    const clock = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
    return incidents.items.length ? t.whichTime(clock) : t.whichTimeNone(clock);
  }
  return incidents.items.length ? t.which : t.whichNone;
}

function endText(nav, lang) {
  const t = textFor(lang);
  return nav === "previous" ? t.noEarlier : t.noLater;
}

module.exports = {
  FOLLOWUP_TEMPLATES, causeText, startText, durationText, deploymentText, restartText, peakText, tierText, summaryText,
  whichText, endText, loadDetail, loadRestarts, minutesQuery, restartQueries, explanationText, CHOICES,
};
