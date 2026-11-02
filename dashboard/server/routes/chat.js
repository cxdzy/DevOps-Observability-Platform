// POST /api/chat and GET /api/chat/stats (Phase 6, 6B-3). Mounted after requireAuth, so every
// request has req.user. The assistant is read-only: action requests get a fixed reply and nothing
// is called, and the only writes are the two langfuse log inserts in chat/log.js.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { originAllowed } = require("../security");
const { parse, ACTION_REPLY, NO_DATA_REPLY } = require("../chat/parser");
const { createFacts, renderLines, fmtTime, pyFixed, INCIDENTS_LISTED } = require("../chat/facts");
const { checkAnswer } = require("../chat/check");
const { createOllama, OllamaError } = require("../chat/ollama");
const { createLimits } = require("../chat/limits");
const { createChatLog, createPool } = require("../chat/log");

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "..", "chat", "system_prompt.txt"), "utf8").trim();
const MAX_CHARS = 500;
// One budget for both model calls, counted from the moment this request gets the model slot.
// It covers a model switch (cold load) on the first call; the retry runs only if enough is left.
const CALL_BUDGET_MS = 90 * 1000;
const MIN_RETRY_MS = 15 * 1000;
// Cloudflare ends a request after 100 s, so every reply must be sent within 95 s of arrival. A
// question that waited for the slot and would have less than 30 s for the model is turned away.
const REQUEST_BUDGET_MS = 95 * 1000;
const MIN_FIRST_CALL_MS = 30 * 1000;
const RETRY_LINE = "Your previous answer used values not in the FACTS. Use only FACTS values.";
const DOWN_MESSAGE = "The local model did not answer. Nothing was changed.";
const BUSY_MESSAGE = "The assistant is busy. Try again in a minute.";

const SOURCES = {
  status: ["anomaly scores", "incident records", "Prometheus"],
  last_incident: ["incident records"],
  incident_count: ["incident records"],
  worry: ["anomaly scores", "incident records"],
  health_check: ["Prometheus", "anomaly scores", "the remediation log", "deployment records"],
  llm: ["anomaly scores", "incident records", "the remediation log", "deployment records", "Prometheus"],
};

// Trims the message and removes control characters; line breaks become spaces.
function cleanMessage(value) {
  return String(value).replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

function requestLine() {
  return crypto.randomBytes(4).toString("hex");
}

function buildMessages(factsText, message, retry) {
  const user = `Request ${requestLine()}\n${factsText}\n\nQUESTION: ${message}` + (retry ? `\n${RETRY_LINE}` : "");
  return [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }];
}

// ------------------------------------------------------------------ fixed templates

function statusText(values, snap) {
  const up = values.service_up;
  const parts = [up === true ? "sample-service is up." : up === false ? "sample-service is down." : "There is no data on whether sample-service is up."];
  const a = values.anomaly_latest;
  if (!a) {
    parts.push("No anomaly score is recorded.");
  } else {
    const score = a.score === null ? "no data" : pyFixed(a.score, 3);
    const threshold = a.threshold === null ? "no data" : pyFixed(a.threshold, 3);
    parts.push(a.flagged
      ? `The latest anomaly score is ${score} at ${fmtTime(a.time_ms, snap)}, flagged as tier ${a.tier || "no data"} (threshold ${threshold}).`
      : `The latest anomaly score is ${score} at ${fmtTime(a.time_ms, snap)}, not flagged (threshold ${threshold}).`);
  }
  const inc = values.incidents_6h;
  if (!inc) {
    parts.push("There is no incident data right now.");
  } else {
    const open = inc.items.filter((i) => i.status === "open").length;
    parts.push(`${inc.count} ${inc.count === 1 ? "incident" : "incidents"} in the last 6 hours, ${open === 0 ? "none" : open} still open.`);
  }
  return parts.join(" ");
}

function lastIncidentText(values, snap) {
  const inc = values.incidents_6h;
  if (!inc) return "There is no incident data right now.";
  const i = inc.items[0];
  if (!i) return "There were no incidents in the last 6 hours.";
  const peak = i.peak_score === null ? "no data" : pyFixed(i.peak_score, 3);
  let text = `The last incident started at ${fmtTime(i.start_ms, snap)}: tier ${i.tier}, signal ${i.signal}, ` +
    `${i.minutes} min, peak ${peak}, ${i.status}${i.deployment ? ", after a deployment" : ""}.`;
  if (i.what_happened) text += ` What happened: ${i.what_happened}`;
  return text;
}

function nodeText(name, n) {
  if (!n || n.up === null || n.up === undefined) return `There is no data for ${name}.`;
  if (!n.up) return `${name} is not reporting.`;
  const v = (x, d, unit) => (x === null || x === undefined ? "no data" : `${pyFixed(x, d)}${unit}`);
  const containers = n.containers === null || n.containers === undefined ? "no data" : Math.trunc(n.containers);
  return `${name} uses ${v(n.mem_used_gib, 1, "")} of ${v(n.mem_total_gib, 1, " GiB")} memory and ${v(n.disk_pct, 0, " %")} disk, with ${containers} containers.`;
}

function healthText(values, snap) {
  const parts = [statusText(values, snap).split(". ")[0].replace(/\.?$/, ".")];
  parts.push(nodeText("fyp-main", values.node_fyp_main), nodeText("staging", values.node_staging));
  const rs = values.last_restart;
  parts.push(rs ? `The last restart was at ${fmtTime(rs.time_ms, snap)}${rs.service_up === true ? " and the service came back up" : ""}.`
    : "No restart in the last 30 days.");
  const d = values.last_ci_deployment;
  parts.push(d ? `The last CI deployment was at ${fmtTime(d.time_ms, snap)}.` : "No CI deployment is recorded.");
  return parts.join(" ");
}

// Incident counts always state the 6 hour window, because FACTS has no older incidents.
const COUNT_TEXT = {
  en: { head: "In the last 6 hours (the dashboard keeps no older incident data here)", incidents: "incidents",
    signal: "By signal", older: "Older incidents are on the Incidents page.", none: "There is no incident data right now." },
  ms: { head: "Dalam 6 jam lepas (dashboard tidak menyimpan data insiden yang lebih lama di sini)", incidents: "insiden",
    signal: "Mengikut isyarat", older: "Insiden yang lebih lama ada di halaman Incidents.", none: "Tiada data insiden sekarang." },
};

// parsed: the parser result; signal adds the by-signal counts, longer the pointer to the Incidents page.
function incidentCountText(values, snap, parsed = {}) {
  const t = COUNT_TEXT[parsed.lang] || COUNT_TEXT.en;
  const inc = values.incidents_6h;
  if (!inc) return t.none;
  const b = inc.by_tier;
  let text = `${t.head}: ${inc.count} ${t.incidents}, high ${b.high}, medium ${b.medium}, low ${b.low}.`;
  if (parsed.signal) {
    const by = { cpu: 0, memory: 0, latency: 0, unclear: 0 };
    for (const i of inc.items) by[i.signal in by ? i.signal : "unclear"] += 1;
    text += ` ${t.signal}: cpu ${by.cpu}, memory ${by.memory}, latency ${by.latency}, unclear ${by.unclear}.`;
  }
  if (parsed.longer) text += ` ${t.older}`;
  return text;
}

// The reply when the model's answers failed the check: the incident summary lines of FACTS.
const FALLBACK_TEXT = {
  en: ["I could not answer that reliably from the data. The dashboard covers the last 6 hours: ",
    ". Ask about a specific incident, the score or a node."],
  ms: ["Saya tidak dapat menjawab soalan itu dengan tepat daripada data. Dashboard meliputi 6 jam lepas: ",
    ". Tanya tentang insiden tertentu, skor atau nod."],
};

function fallbackText(values, snap, lang = "en") {
  const [before, after] = FALLBACK_TEXT[lang] || FALLBACK_TEXT.en;
  return before + renderLines(values, snap).incidents_counts.join("; ") + after;
}

// "Should I worry": yes when the latest minute is flagged or an incident is open, else no, with the
// values that say so. Only FACTS values are used.
const WORRY_TEXT = {
  en: {
    open: (i, time, score, threshold) => `Yes, look at it: ${i.tier} ${i.signal} incident open since ${time}, latest score ${score} (threshold ${threshold}).`,
    flagged: (tier, time, score, threshold) => `Yes, look at it: the latest minute (${time}) is flagged as tier ${tier}, latest score ${score} (threshold ${threshold}).`,
    calm: (score, threshold) => `No action needed right now: latest score ${score} is below the threshold ${threshold} and no incident is open.`,
    notFlagged: (score, threshold) => `No action needed right now: latest score ${score} is not flagged (threshold ${threshold}) and no incident is open.`,
    count: (n) => (n === 0 ? "There were no incidents in the last 6 hours." : n === 1
      ? "There was 1 incident in the last 6 hours, closed." : `There were ${n} incidents in the last 6 hours, all closed.`),
    noScore: "There is no anomaly score right now, so I cannot tell. Check the Overview page.",
    noIncidents: (score, threshold) => `The latest score ${score} is below the threshold ${threshold}, but there is no incident data right now.`,
  },
  ms: {
    open: (i, time, score, threshold) => `Ya, sila semak: insiden ${i.tier} ${i.signal} terbuka sejak ${time}, skor terkini ${score} (ambang ${threshold}).`,
    flagged: (tier, time, score, threshold) => `Ya, sila semak: minit terkini (${time}) ditanda sebagai tier ${tier}, skor terkini ${score} (ambang ${threshold}).`,
    calm: (score, threshold) => `Tiada tindakan diperlukan sekarang: skor terkini ${score} di bawah ambang ${threshold} dan tiada insiden terbuka.`,
    notFlagged: (score, threshold) => `Tiada tindakan diperlukan sekarang: skor terkini ${score} tidak ditanda (ambang ${threshold}) dan tiada insiden terbuka.`,
    count: (n) => (n === 0 ? "Tiada insiden dalam 6 jam lepas." : n === 1
      ? "Terdapat 1 insiden dalam 6 jam lepas, sudah ditutup." : `Terdapat ${n} insiden dalam 6 jam lepas, semuanya ditutup.`),
    noScore: "Tiada skor anomali sekarang, jadi saya tidak dapat menilai. Semak halaman Overview.",
    noIncidents: (score, threshold) => `Skor terkini ${score} di bawah ambang ${threshold}, tetapi tiada data insiden sekarang.`,
  },
};

function worryText(values, snap, parsed = {}) {
  const t = WORRY_TEXT[parsed.lang] || WORRY_TEXT.en;
  const a = values.anomaly_latest;
  const inc = values.incidents_6h;
  const fmt = (v) => (v === null || v === undefined ? "no data" : pyFixed(v, 3));
  const open = inc ? inc.items.find((i) => i.status === "open") : null;   // items are newest first
  if (open) return t.open(open, fmtTime(open.start_ms, snap), a ? fmt(a.score) : "no data", a ? fmt(a.threshold) : "no data");
  if (!a) return t.noScore;
  const score = fmt(a.score);
  const threshold = fmt(a.threshold);
  if (a.flagged) return t.flagged(a.tier || "no data", fmtTime(a.time_ms, snap), score, threshold);
  if (!inc) return t.noIncidents(score, threshold);
  const below = a.score !== null && a.threshold !== null && a.score < a.threshold;
  return `${below ? t.calm(score, threshold) : t.notFlagged(score, threshold)} ${t.count(inc.count)}`;
}

const TEMPLATES = {
  status: statusText, last_incident: lastIncidentText, health_check: healthText, incident_count: incidentCountText, worry: worryText,
};

// Incident chips: the incidents a reply is about.
function chipsFor(kind, values, snap, answer) {
  const inc = values.incidents_6h;
  if (!inc) return [];
  const chip = (i) => ({ start: i.start_ms, tier: i.tier });
  if (kind === "last_incident") return inc.items.slice(0, 1).map(chip);
  if (kind === "status" || kind === "worry") return inc.items.filter((i) => i.status === "open").slice(0, 3).map(chip);
  if (kind === "llm") {
    return inc.items.slice(0, INCIDENTS_LISTED).filter((i) => answer.includes(fmtTime(i.start_ms, snap))).slice(0, 4).map(chip);
  }
  return [];
}

// ------------------------------------------------------------------ router

// deps: { query, prometheus, ollama, chatLog, limits, now, appOrigin, env }. Tests pass fakes;
// otherwise the clients are built from the environment (OLLAMA_URL, CHAT_MODEL, CHAT_KEEP_ALIVE,
// CHAT_RATE_PER_HOUR, LANGFUSE_DB_NAME).
function createChatRouter(deps) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const model = env.CHAT_MODEL || "qwen2.5:1.5b";
  const ollama = deps.ollama || createOllama({ url: env.OLLAMA_URL || undefined, model, keepAlive: env.CHAT_KEEP_ALIVE || "5m" });
  const perHour = Number.parseInt(env.CHAT_RATE_PER_HOUR, 10) > 0 ? Number.parseInt(env.CHAT_RATE_PER_HOUR, 10) : 20;
  const limits = deps.limits || createLimits({ perHour, now });
  const chatLog = deps.chatLog || createChatLog({ pool: createPool(env) });
  const facts = createFacts({ query: deps.query, prometheus: deps.prometheus, now });
  const log = deps.log || console.error;

  // Learn once whether the model can think; ollama.js retries later if Ollama is not up yet.
  ollama.canThink().catch(() => {});

  const router = express.Router();
  const json = express.json({ limit: "8kb" });

  // CSRF protection as for the other state-changing routes: JSON body and an exact Origin match.
  function stateChanging(req, res, next) {
    if (!req.is("application/json")) return res.status(415).json({ error: "expected application/json" });
    if (!originAllowed(req.get("origin"), deps.appOrigin)) return res.status(403).json({ error: "bad origin" });
    next();
  }

  router.post("/", stateChanging, json, async (req, res, next) => {
    const started = Date.now();
    const elapsed = () => Math.round((Date.now() - started) / 100) / 10;
    try {
      const raw = req.body && req.body.message;
      if (typeof raw !== "string") return res.status(400).json({ error: "message must be a string" });
      const message = cleanMessage(raw);
      const length = [...message].length;
      if (length < 1 || length > MAX_CHARS) return res.status(400).json({ error: `message must be 1 to ${MAX_CHARS} characters` });

      const user = req.user;
      const role = user.role === "admin" ? "admin" : "viewer";
      const parsed = parse(message);
      const { intent, lang } = parsed;
      const reply = (body) => res.json({ incidents: [], sources: [], model: null, ...body, elapsed_s: elapsed() });

      if (intent === "action") return reply({ kind: "action_unavailable", answer: ACTION_REPLY[role] });
      if (intent === "no_data") return reply({ kind: "guard", answer: NO_DATA_REPLY[lang] });
      if (TEMPLATES[intent]) {
        const f = await facts.gather();
        return reply({
          kind: "template",
          answer: TEMPLATES[intent](f.values, f.snapshotMs, parsed),
          incidents: chipsFor(intent, f.values, f.snapshotMs, ""),
          sources: SOURCES[intent],
        });
      }

      // A question for the model.
      const rate = limits.checkRate(user.id);
      if (!rate.ok) return rateLimited(res, rate.nextFreeAt);
      const slot = limits.acquire();
      if (!slot) return res.status(429).json({ error: BUSY_MESSAGE });
      const release = await slot;
      const calls = [];
      let kind;
      let answer;
      let f;
      try {
        // Checked again: another request from the same user may have taken the last question.
        const again = limits.checkRate(user.id);
        if (!again.ok) return rateLimited(res, again.nextFreeAt);
        const deadline = Math.min(Date.now() + CALL_BUDGET_MS, started + REQUEST_BUDGET_MS);
        if (deadline - Date.now() < MIN_FIRST_CALL_MS) return res.status(429).json({ error: BUSY_MESSAGE });
        f = await facts.gather();

        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const left = deadline - Date.now();
          if (attempt === 2 && left < MIN_RETRY_MS) break;
          const messages = buildMessages(f.text, message, attempt === 2);
          let result;
          try {
            result = await ollama.chat(messages, left);
          } catch (err) {
            if (!(err instanceof OllamaError)) throw err;
            if (attempt === 1) {
              log(`chat model call failed (${err.message})`);
              return res.status(503).json({ error: DOWN_MESSAGE });
            }
            break; // the retry failed; answer from the facts instead
          }
          // Counted once the model has answered, so a question that got a 503 is not used up.
          if (attempt === 1) limits.consume(user.id);
          const problems = checkAnswer(result.text, f.text, message);
          calls.push({ ...result, prompt: messages[1].content, answer: result.text, attempt, checkPassed: problems.length === 0 });
          if (problems.length === 0) {
            kind = "llm";
            answer = result.text;
            break;
          }
        }
      } finally {
        release();
      }

      if (!kind) {
        kind = "fallback";
        answer = fallbackText(f.values, f.snapshotMs, lang);
      }
      const body = {
        kind,
        answer,
        incidents: chipsFor(kind === "llm" ? "llm" : "status", f.values, f.snapshotMs, answer),
        sources: SOURCES.llm,
        model,
        elapsed_s: elapsed(),
      };
      res.json(body);
      // After the reply, so a slow or failing database never delays or breaks it.
      chatLog.record(calls, { kind, model, userId: user.id, role, replyS: body.elapsed_s, anomalyScore: f.latestScore })
        .catch(() => {});
    } catch (err) {
      next(err);
    }
  });

  router.get("/stats", async (req, res, next) => {
    try {
      const [stats, ollamaUp] = await Promise.all([chatLog.stats(), ollama.ping()]);
      res.json({ model, ...stats, questionsLeft: limits.left(req.user.id), perHour: limits.perHour, ollamaUp });
    } catch (err) {
      next(err);
    }
  });

  function rateLimited(res, nextFreeAt) {
    const at = fmtTime(nextFreeAt, now());
    return res.status(429).json({
      error: `You have used all ${limits.perHour} questions for this hour. The next one is free at ${at} MYT.`,
      nextFreeAt,
    });
  }

  return router;
}

module.exports = {
  createChatRouter, cleanMessage, buildMessages, statusText, lastIncidentText, healthText, incidentCountText, worryText, fallbackText,
  SYSTEM_PROMPT, RETRY_LINE,
};
