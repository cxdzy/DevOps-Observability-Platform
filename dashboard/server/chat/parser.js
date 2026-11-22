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
  "bila", "kenapa", "mengapa", "adakah", "apa", "bagaimana", "berapa", "ada"];
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
  "rangkaian", "masuk", "sistem", "risau", "masalah", "semalam", "hari", "kah", "tolong", "jangan", "payah", "hentikan", "semula",
  "ia", "dia", "mana", "punca", "puncak", "setinggi", "teruk", "naik", "pukul"];

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
// "How many minutes did that incident last" and "berapa lama insiden itu" ask for a duration and
// "pukul berapa" for a time, and "berapa tinggi" for a peak, so those are not counts.
const COUNT_PATTERNS = [
  /\bhow\s+many\b(?!\s+(?:minutes?|mins?|hours?|seconds?|secs?)\b)[^?.!]*\bincidents?\b/,
  /\b(number|count|total)\s+of\b[^?.!]*\bincidents?\b/,
  /(?<!\b(?:pukul|jam)\s)\bberapa\b(?!\s+(?:lama|minit|jam|saat|tinggi|teruk)\b)[^?.!]*\binsiden\b/,
  /\binsiden\b[^?.!]*(?<!\b(?:pukul|jam)\s)\bberapa\b(?!\s+(?:lama|minit|jam|saat|tinggi|teruk)\b)/,
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

// ------------------------------------------------------------------ follow-up questions

// Questions about the incident the user was just asking about. topic is the answer; nav moves to
// the older (previous) or newer (next) incident first. Patterns run on the normalised message.
const FOLLOWUP_TOPICS = [
  ["deployment", [
    /\b(?:linked|related|connected|due|caused|because|after|following)\b[^?.!]*\bdeploy(?:ment|ments|ed|s)?\b/,
    /\bdeploy(?:ment|ments)?\b[^?.!]*\b(?:before|cause|caused|trigger|triggered)\b/,
    /^(?:was|is|did)\s+(?:it|that|this|the incident)\s+(?:a\s+)?deploy(?:ment)?\b/,
    /\b(?:berkait(?:an)?|kaitan|disebabkan|selepas|lepas)\b[^?.!]*\bdeploy(?:ment)?\b/,
  ]],
  ["duration", [
    /\bhow\s+long\b/, /\bduration\b/, /\bhow\s+many\s+(?:minutes?|mins?)\b/, /\blast(?:ed)?\s+for\b/,
    /\bberapa\s+(?:lama|minit)\b/, /\btempoh\b/,
  ]],
  ["start", [
    /\bwhen\s+(?:did|was|does)\b[^?.!]*\b(?:start|started|begin|began|happen|happened|occur|occurred|it|that|this)\b/,
    /\bwhat\s+time\b/, /\bstart(?:ed)?\s+at\b/, /\bstart\s+time\b/,
    /\bbila\b[^?.!]*\b(?:mula|bermula|berlaku)\b/, /\b(?:pukul|jam)\s+berapa\b/, /\bmasa\s+mula\b/,
  ]],
  ["cause", [
    /\bwhy\b/, /\bcause[ds]?\b/, /\bcausing\b/, /\breason\b/, /\btrigger(?:ed|s)?\b/, /\bwhat\s+happened\b/,
    /\bkenapa\b/, /\bmengapa\b/, /\bpunca(?:nya)?\b/, /\bsebab(?:nya)?\b/, /\bapa\s+yang\s+berlaku\b/,
  ]],
  // Whether a restart or rollback ran for the incident. "Why did it restart" is a question about the
  // service and stays with the model (SERVICE_STATE).
  ["restart", [
    /\b(?:was|were|has|had)\s+(?:anything|something|it|that|this|the\s+incident)\s+(?:been\s+)?(?:restarted|rolled\s+back)\b/,
    /\bdid\s+(?:anything|something|it|that|this)\s+get\s+(?:restarted|rolled\s+back)\b/,
    /\b(?:any|a)\s+(?:restart|rollback)s?\s+(?:for|during|after|because\s+of)\s+(?:it|that|this|the\s+incident)\b/,
    /\bwhat\s+(?:action|actions|remediation)\b/, /\b(?:action|actions)\s+(?:was|were)\s+taken\b/,
    /\bada\s+(?:apa-apa\s+)?(?:restart|rollback|tindakan)\b/, /\b(?:di-?restart|di-?rollback|dimulakan\s+semula)\b/,
  ]],
  ["peak", [
    /\bhow\s+high\b/, /\bpeak(?:ed)?\b/, /\bhighest\s+score\b/, /\bmax(?:imum)?\s+score\b/,
    /\bsetinggi\s+mana\b/, /\bberapa\s+tinggi\b/, /\bpuncak(?:nya)?\b/, /\bskor\s+tertinggi\b/,
  ]],
  ["tier", [
    /\bhow\s+(?:serious|bad|severe|critical)\b/, /\bseverity\b/, /\b(?:what|which)\b[^?.!]*\btier\b/,
    /^(?:is|was)\s+(?:it|that|this)\s+(?:serious|bad|severe|critical)\b/,
    /\bteruk\b/, /\bserius\b/, /\btahap\b/, /\btier\s+apa\b/,
  ]],
];
const NAV_PATTERNS = {
  previous: [/\bthe\s+one\s+before\b/, /\b(?:previous|earlier|prior)\s+(?:one|incident)\b/, /\bbefore\s+(?:that|it|this)\b/,
    /^(?:and\s+)?(?:the\s+)?previous(?:\s+one)?$/, /\bsebelum\s+itu\b/, /\bsebelumnya\b/, /\byang\s+sebelum\b/],
  next: [/\bthe\s+one\s+after\b/, /\b(?:next|later|following)\s+(?:one|incident)\b/, /\bafter\s+(?:that|it|this)\b/,
    /^(?:and\s+)?(?:the\s+)?next(?:\s+one)?$/, /\bselepas\s+itu\b/, /\bseterusnya\b/, /\byang\s+selepas\b/],
};
// Words that point back at the incident under discussion.
const REFERENCE_WORDS = ["it", "that", "this", "the incident", "the one before", "the one after", "itu", "tersebut",
  "tadi", "sebelum itu", "selepas itu"];
// A message that names an incident (or a set of incidents) itself is not about the one in the
// context. A time that does not name an incident ("what was the score at 14:00") goes to the model.
const TIME_IN_MESSAGE = /(?<![\d:])\d{1,2}[:.]\d{2}(?![\d:])/;
// An incident named by its start time in MYT: "the incident at 18:37", "the 18:37 incident", "the one
// at 18:37", "insiden pukul 18:37", "yang pukul 18:37". Groups 1 and 2 are the hours and minutes.
const CLOCK = String.raw`(\d{1,2})[:.](\d{2})(?![\d:])`;
const NAMED_TIME = [
  new RegExp(String.raw`\b(?:incident|insiden|one)\s+(?:at|from|(?:that\s+)?start(?:ed|ing)\s+at|pada|pukul|jam)\s+(?:(?:pukul|jam)\s+)?` + CLOCK),
  new RegExp(String.raw`(?<![\d:])` + CLOCK + String.raw`\s+(?:incident|insiden)\b`),
  new RegExp(String.raw`\byang\s+(?:pada\s+)?(?:pukul|jam)\s+` + CLOCK),
];
const NAMES_INCIDENT = [
  /\b(?:last|latest|first|newest|oldest|highest|biggest|any|every|all|recent|most\s+recent)\b[^?.!]*\b(?:incident|insiden)\b/,
  /\bincidents\b/,
  /\b(?:cpu|memory|memori|latency|low|medium|high)\s+(?:incident|spike|leak|issue|problem)\b/,
  /\binsiden\s+(?:cpu|memori|latensi|terakhir|terbaru|pertama)\b/,
];
// Subjects other than an incident. A question about one of these without a reference word goes on
// to the model ("why is the score high").
const OTHER_SUBJECTS = ["score", "skor", "threshold", "ambang", "node", "nodes", "fyp-main", "staging", "model",
  "champion", "retraining", "restart", "ci", "last deployment", "latest deployment", "sample-service", "service",
  "server", "disk", "container", "containers", "nod", "cakera", "cpu", "memory", "memori", "latency", "latensi", "usage",
  "penggunaan"];
// Questions about the current time, not an incident's start.
const CLOCK_QUESTION = /\b(?:what\s+time\s+is\s+it|time\s+now|(?:pukul|jam)\s+berapa\s+sekarang)\b/;
// Questions about the present ("how bad is it now") are about the live values, not a past incident.
const PRESENT = /\b(?:now|right\s+now|currently|at\s+the\s+moment|sekarang|kini)\b/;

// Questions about the service stopping or going down are not about an incident record ("why did
// it stop"), so they go on to the model.
const SERVICE_STATE = /\b(?:stop|stopped|stops|crash|crashed|crashes|down|restart|restarts|restarted|died|berhenti|rosak)\b/;

// The start time an incident is named by, as { hour, minute }, else null. Out of range times are null.
function namedTime(text) {
  for (const p of NAMED_TIME) {
    const m = p.exec(text);
    if (!m) continue;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, phrase: m[0] };
  }
  return null;
}

// The text with negated verbs removed: "don't restart it, just tell me why" is not a question about
// the service state.
function withoutNegated(text) {
  return text.replace(/\b(?:don't|dont|do not|never|without|jangan|tak payah)\s+\S+/g, " ");
}

// Returns { topic, nav, reference, time } for a follow-up question, else null. time is set when the
// message names an incident by its start time; topic is then null for the incident summary.
function followUp(message) {
  const text = normalise(message).replace(/[?.!]+$/, "").trim();
  const named = namedTime(text);
  // The words that name the incident ("the incident that started at 9:05") are not the question.
  const asked = named ? text.replace(named.phrase, " ") : text;
  const nav = Object.keys(NAV_PATTERNS).find((n) => NAV_PATTERNS[n].some((p) => p.test(asked))) || null;
  const found = FOLLOWUP_TOPICS.find(([, patterns]) => patterns.some((p) => p.test(asked)));
  const topic = found ? found[0] : null;
  const serviceState = topic !== "restart" && SERVICE_STATE.test(withoutNegated(asked));
  if (named) {
    // "Why did the service stop during the incident at 14:00" is still about the service.
    if (serviceState) return null;
    return { topic, nav, reference: true, time: { hour: named.hour, minute: named.minute } };
  }
  if (!topic && !nav) return null;
  if (TIME_IN_MESSAGE.test(text)) return null;
  if (serviceState || CLOCK_QUESTION.test(text) || PRESENT.test(text)) return null;
  const reference = nav !== null || containsAny(text, REFERENCE_WORDS);
  if (!reference) {
    if (NAMES_INCIDENT.some((p) => p.test(text))) return null;
    // "Ada restart tak?" asks about this incident's restart, so restart is not another subject there.
    const subjects = topic === "restart" ? OTHER_SUBJECTS.filter((w) => w !== "restart") : OTHER_SUBJECTS;
    if (containsAny(text, subjects)) return null;
  }
  return { topic, nav, reference, time: null };
}

// Returns { intent, lang } with intent one of action, no_data, incident_count, worry, status,
// last_incident, health_check, followup, llm. incident_count also has tier, signal and longer (a
// period over 6 hours named); followup has topic (cause, start, duration, deployment, restart, peak,
// tier or null), nav (previous, next or null) and time ({ hour, minute } when the message names an
// incident by its start time, else null).
function parse(message) {
  const lang = isMalay(message) ? "ms" : "en";
  if (isActionRequest(message)) return { intent: "action", lang };
  if (isNoData(message)) return { intent: "no_data", lang };
  const count = countQuestion(message);
  if (count) return { intent: "incident_count", lang, ...count };
  if (isWorry(message)) return { intent: "worry", lang };
  const template = templateIntent(message);
  if (template) return { intent: template, lang };
  const follow = followUp(message);
  if (follow) return { intent: "followup", lang, topic: follow.topic, nav: follow.nav, time: follow.time };
  return { intent: "llm", lang };
}

module.exports = {
  parse, isActionRequest, isNoData, isMalay, templateIntent, countQuestion, isWorry, followUp,
  NO_DATA_TOPICS, ACTION_WORDS, NEGATIONS, ACTION_REPLY, NO_DATA_REPLY, REFERENCE_WORDS, MALAY_WORDS,
};
