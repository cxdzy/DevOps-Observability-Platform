// POST /api/chat and GET /api/chat/stats (Phase 6, 6B-3). Mounted after requireAuth, so every
// request has req.user. The assistant is read-only: action requests get a fixed reply and nothing
// is called, and the only writes are the two langfuse log inserts in chat/log.js.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { originAllowed } = require("../security");
const { parse, ACTION_REPLY, NO_DATA_REPLY } = require("../chat/parser");
const { createFacts, fmtTime, pyFixed, INCIDENTS_LISTED } = require("../chat/facts");
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

const TEMPLATES = { status: statusText, last_incident: lastIncidentText, health_check: healthText };

// Incident chips: the incidents a reply is about.
function chipsFor(kind, values, snap, answer) {
  const inc = values.incidents_6h;
  if (!inc) return [];
  const chip = (i) => ({ start: i.start_ms, tier: i.tier });
  if (kind === "last_incident") return inc.items.slice(0, 1).map(chip);
  if (kind === "status") return inc.items.filter((i) => i.status === "open").slice(0, 3).map(chip);
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
      const { intent, lang } = parse(message);
      const reply = (body) => res.json({ incidents: [], sources: [], model: null, ...body, elapsed_s: elapsed() });

      if (intent === "action") return reply({ kind: "action_unavailable", answer: ACTION_REPLY[role] });
      if (intent === "no_data") return reply({ kind: "guard", answer: NO_DATA_REPLY[lang] });
      if (TEMPLATES[intent]) {
        const f = await facts.gather();
        return reply({
          kind: "template",
          answer: TEMPLATES[intent](f.values, f.snapshotMs),
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
          const problems = checkAnswer(result.text, f.text);
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
        answer = statusText(f.values, f.snapshotMs);
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

module.exports = { createChatRouter, cleanMessage, buildMessages, statusText, lastIncidentText, healthText, SYSTEM_PROMPT, RETRY_LINE };
