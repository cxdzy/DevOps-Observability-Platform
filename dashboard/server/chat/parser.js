// Rule intents for a chat message, checked before any model call (chat plan section 13, step 2):
// action requests, the no-data guard, incident counts, "should I worry" questions, the three
// fixed-template questions, else a question for the model. Pure functions, no I/O.

// Words that ask for an action. Matched as whole words, so "restarted" or "stopped" in a question
// about the past is not a request.
const ACTION_WORDS = ["restart", "rollback", "roll back", "stop", "kill", "scale", "mula semula", "hentikan"];
// A negation up to three words before the action word means it is not a request
// ("Don't restart anything, just tell me ...").
const NEGATIONS = ["don't", "dont", "do not", "never", "without", "jangan", "tak payah"];
// A word right before the action word that makes it a noun ("the last restart", "a restart").
const NOUN_MARKERS = ["a", "an", "the", "last", "latest", "previous", "recent", "any", "no", "each", "every", "that", "this", "terakhir"];
// A message that starts with one of these is a question about the system, not a request, unless it
// also contains a request phrase ("can you", "please").
const QUESTION_STARTS = ["when", "what", "why", "how", "did", "was", "were", "has", "have", "had", "is", "are", "does",
  "bila", "kenapa", "mengapa", "adakah", "apa", "bagaimana", "berapa"];
const REQUEST_PHRASES = ["can you", "could you", "would you", "will you", "please", "pls", "tolong", "boleh", "go ahead"];

// Topics the FACTS block never contains. Each is matched as whole words, with an optional plural s.
const NO_DATA_TOPICS = Object.freeze([
  "disk i/o", "disk read", "disk write", "iops", "network", "bandwidth", "packet", "throughput", "log", "logs",
  "error message", "stack trace", "commit", "git", "pull request", "developer", "user", "users", "request count",
  "temperature", "database query", "cost", "price", "cuaca", "rangkaian", "log masuk",
]);
// Facts that FACTS does contain. A guarded question that also names one of these goes to the model,
// which answers the part it has data for. "disk" alone is the node disk percent.
const AVAILABLE_FACTS = [
  "anomaly", "score", "threshold", "flagged", "tier", "cpu", "memory", "memori", "latency", "incident", "incidents",
  "insiden", "peak", "restart", "deployment", "deploy", "model", "champion", "retraining", "reference", "normal",
  "node", "nodes", "disk", "container", "containers", "fyp-main", "staging", "up", "down", "status", "healthy", "health",
];

// Whole-message questions answered by fixed templates (the command chips and close variants).
const TEMPLATE_INTENTS = {
  status: ["system status", "status", "status sistem", "what is the system status", "how is the system"],
  last_incident: ["last incident", "latest incident", "insiden terakhir", "what was the last incident"],
  health_check: ["health check", "healthcheck", "semakan kesihatan", "run a health check"],
};

// Words that mark a Malay message, for the language of the fixed replies.
const MALAY_WORDS = ["ada", "apa", "bila", "berapa", "dalam", "jam", "lepas", "tak", "tidak", "adakah", "kenapa",
  "mengapa", "bagaimana", "sekarang", "memori", "untuk", "yang", "ini", "itu", "saya", "boleh", "insiden", "cuaca",
  "rangkaian", "masuk", "sistem", "risau", "masalah", "semalam", "hari", "kah", "tolong", "jangan", "payah", "hentikan", "semula"];

const ACTION_REPLY = {
  admin: "Restart requests from the dashboard are not connected yet. Use the Telegram approval for now.",
  viewer: "Only an admin can request a restart, and every restart needs a Telegram approval.",
};
const NO_DATA_REPLY = {
  en: "The dashboard has no data for that. It only has the anomaly score, current sample-service values, incidents " +
    "of the last 6 hours, the last restart, the last CI deployment and node memory, disk and container counts.",
  ms: "Dashboard tiada data untuk itu. Ia hanya ada skor anomali, nilai semasa sample-service, insiden 6 jam " +
    "lepas, restart terakhir, deployment CI terakhir serta memori, cakera dan bilangan container setiap nod.",
};

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s+");
}

// Whole-word pattern; letters, digits, "/" and "-" count as word characters, so "log" does not
// match "login" and "disk" does not match "disk i/o".
function wordPattern(phrase, plural = false) {
  return new RegExp(`(?<![\\p{L}\\p{N}/-])${escape(phrase)}${plural ? "s?" : ""}(?![\\p{L}\\p{N}/-])`, "giu");
}

function normalise(message) {
  return String(message).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
}

function words(text) {
  return text.split(/[^\p{L}\p{N}'/-]+/u).filter(Boolean);
}

function isMalay(message) {
  const list = words(normalise(message));
  return list.filter((w) => MALAY_WORDS.includes(w)).length >= 1;
}

function startsWithAny(text, list) {
  return list.some((p) => text === p || text.startsWith(`${p} `));
}

function containsAny(text, list) {
  return list.some((p) => wordPattern(p).test(text));
}

// True when the message asks for an action that is not negated.
function isActionRequest(message) {
  const text = normalise(message);
  const isQuestion = startsWithAny(text, QUESTION_STARTS) && !containsAny(text, REQUEST_PHRASES);
  for (const word of ACTION_WORDS) {
    const pattern = wordPattern(word);
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const before = words(text.slice(0, m.index)).slice(-3);
      const beforeText = before.join(" ");
      const negated = NEGATIONS.some((n) => wordPattern(n).test(beforeText));
      const noun = before.length > 0 && NOUN_MARKERS.includes(before[before.length - 1]);
      if (!negated && !noun && !isQuestion) return true;
    }
  }
  return false;
}

// True when the message is about a topic FACTS never contains and names no available fact.
function isNoData(message) {
  const text = normalise(message);
  let rest = text;
  let hit = false;
  for (const topic of NO_DATA_TOPICS) {
    const pattern = wordPattern(topic, !topic.endsWith("s") && !topic.includes(" "));
    if (pattern.test(rest)) {
      hit = true;
      rest = rest.replace(wordPattern(topic, !topic.endsWith("s") && !topic.includes(" ")), " ");
    }
  }
  if (!hit) return false;
  return !AVAILABLE_FACTS.some((f) => wordPattern(f).test(rest));
}

const TIERS = ["low", "medium", "high"];
const SIGNAL_WORDS = { cpu: ["cpu"], memory: ["memory", "memori"], latency: ["latency", "latensi"] };
// A question for the incident count: "how many (high) incidents", "number of incidents", or in
// Malay "berapa" with "insiden".
const COUNT_PATTERNS = [
  /\bhow\s+many\b[^?.!]*\bincidents?\b/,
  /\b(number|count|total)\s+of\b[^?.!]*\bincidents?\b/,
  /\bberapa\b[^?.!]*\binsiden\b/,
  /\binsiden\b[^?.!]*\bberapa\b/,
];
// A period longer than the 6 hours FACTS covers.
const LONGER_PERIOD = /(?<![\p{L}\p{N}])(today|yesterday|week|weeks|month|months|day|days|minggu|hari|semalam|bulan)(?![\p{L}\p{N}])/u;
const HOURS = /(?<![\p{L}\p{N}.])(\d+)\s*(hours?|hrs?|h|jam)(?![\p{L}])/gu;

// Returns { tier, signal, longer } for an incident count question, else null.
function countQuestion(message) {
  const text = normalise(message);
  if (!COUNT_PATTERNS.some((p) => p.test(text))) return null;
  const list = words(text);
  const tier = TIERS.find((t) => list.includes(t)) || null;
  const signal = Object.keys(SIGNAL_WORDS).find((s) => SIGNAL_WORDS[s].some((w) => list.includes(w))) || null;
  const longer = LONGER_PERIOD.test(text) || [...text.matchAll(HOURS)].some((m) => Number(m[1]) > 6);
  return { tier, signal, longer };
}

// "Should I worry" questions, answered from the latest score and open incidents by a template.
const WORRY_PHRASES = ["worried", "worry", "worrying", "concern", "concerned", "concerning", "anything wrong",
  "something wrong", "is everything ok", "is everything okay", "is everything fine", "everything ok", "everything okay",
  "everything fine", "all ok", "all good", "risau", "ok tak", "okay tak", "ada masalah"];

function isWorry(message) {
  return containsAny(normalise(message), WORRY_PHRASES);
}

function templateIntent(message) {
  const text = normalise(message).replace(/[?.!]+$/, "").trim();
  for (const [intent, phrases] of Object.entries(TEMPLATE_INTENTS)) {
    if (phrases.includes(text)) return intent;
  }
  return null;
}

// Returns { intent, lang } with intent one of action, no_data, incident_count, worry, status,
// last_incident, health_check, llm. incident_count also has tier, signal and longer (a period over 6 hours named).
function parse(message) {
  const lang = isMalay(message) ? "ms" : "en";
  if (isActionRequest(message)) return { intent: "action", lang };
  if (isNoData(message)) return { intent: "no_data", lang };
  const count = countQuestion(message);
  if (count) return { intent: "incident_count", lang, ...count };
  if (isWorry(message)) return { intent: "worry", lang };
  const template = templateIntent(message);
  if (template) return { intent: template, lang };
  return { intent: "llm", lang };
}

module.exports = {
  parse, isActionRequest, isNoData, isMalay, templateIntent, countQuestion, isWorry,
  NO_DATA_TOPICS, ACTION_WORDS, NEGATIONS, ACTION_REPLY, NO_DATA_REPLY,
};
