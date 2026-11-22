// Checks a model answer against the FACTS text it was given (chat plan section 13, step 4).
// Every HH:MM time and every number with two or more digits or a decimal point must appear in
// FACTS or in the user's question as the same token ("34" does not pass because FACTS has "0.347"),
// and the answer must not claim an action. A sentence that compares a score with the threshold must
// state the direction the numbers have, and a sentence that gives a tier and a time must match an
// incident in FACTS. Pure functions, no I/O.

const TIME = /(?<![\d:])\d{1,2}:\d{2}(?![\d:])/g;
const NUMBER = /(?<![\d.])\d+(?:\.\d+)?(?![\d])/g;
const ACTION_CLAIMS = /\b(restarted|rolled\s+back|stopped|telah\s+restart|dimulakan\s+semula)\b/i;

// Times and numbers that need to be backed by FACTS. Times are taken out first, so "13:48" is
// not also read as the numbers 13 and 48.
function tokens(text) {
  const times = String(text).match(TIME) || [];
  const rest = String(text).replace(TIME, " ");
  const numbers = (rest.match(NUMBER) || []).filter((n) => n.includes(".") || n.length >= 2);
  return { times, numbers };
}

// Every time and number in text, short numbers included.
function allTokens(text) {
  const times = String(text).match(TIME) || [];
  const numbers = String(text).replace(TIME, " ").match(NUMBER) || [];
  return { times, numbers };
}

// ------------------------------------------------------------------ direction and tier

// An answer is checked one sentence at a time. A full stop inside a number ("0.458") does not end one.
function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// Comparison phrases, most specific first, each with the direction it states for the score against
// the threshold. Negated "above" words ("did not exceed", "tidak melepasi") are read as below.
const NEGATION = String.raw`(?:not|never|\w+n['’]t|tidak|tak|belum)\s+(?:\w+\s+){0,2}`;
// "over the past hour" is a period, not a comparison.
const UP_WORDS = String.raw`(?:above|over(?!\s+(?:the\s+)?(?:last|past|next|previous|recent|\d))|exceed(?:s|ed|ing)?|cross(?:es|ed|ing)?|pass(?:es|ed|ing)?|higher\s+than|more\s+than|greater\s+than|melepasi|melebihi|atas|lebih\s+tinggi)`;
const COMPARISONS = [
  [new RegExp(String.raw`\b${NEGATION}${UP_WORDS}`, "gi"), "below"],
  [/\b(?:not\s+(?:yet\s+)?reach(?:ed)?|not\s+yet|below|under|lower\s+than|less\s+than|beneath|bawah|belum|kurang|lebih\s+rendah|rendah\s+daripada)\b/gi, "below"],
  [new RegExp(String.raw`\b${UP_WORDS}\b`, "gi"), "above"],
  [/\blebih\b/gi, "above"],
];

// The threshold values FACTS states ("threshold 0.602").
function thresholds(factsText) {
  return new Set([...String(factsText).matchAll(/\bthreshold\s+(\d+(?:\.\d+)?)/g)].map((m) => m[1]));
}

// The direction stated by the comparison phrase nearest to the threshold (at index at), or null
// when the sentence has none. A phrase covered by a longer one ("not" + "exceeded") is not counted
// again on its own.
function direction(sentence, at) {
  const found = [];
  for (const [pattern, dir] of COMPARISONS) {
    for (const m of sentence.matchAll(pattern)) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (found.some((f) => start >= f.start && end <= f.end)) continue;
      found.push({ start, end, dir });
    }
  }
  let best = null;
  for (const f of found) {
    const distance = f.end <= at ? at - f.end : f.start - at;
    if (!best || Math.abs(distance) < Math.abs(best.distance)) best = { distance, dir: f.dir };
  }
  return best ? best.dir : null;
}

// A sentence that names a FACTS threshold, another score and a comparison phrase must state the
// direction the numbers have. "0.718 has not reached 0.458" fails.
function directionProblems(answer, factsText) {
  const limits = thresholds(factsText);
  const problems = [];
  for (const sentence of sentences(answer)) {
    const numbers = (sentence.replace(TIME, " ").match(NUMBER) || []).filter((n) => n.includes("."));
    const limit = numbers.find((n) => limits.has(n));
    if (limit === undefined) continue;
    const score = numbers.find((n) => n !== limit);
    if (score === undefined) continue;
    const at = sentence.search(new RegExp(String.raw`(?<![\d.])${limit.replace(".", "\\.")}(?![\d])`));
    const dir = direction(sentence, at);
    if (!dir) continue;
    const s = Number(score);
    const t = Number(limit);
    if (dir === "below" && s >= t) problems.push(`says ${score} is below the threshold ${limit}`);
    if (dir === "above" && s <= t) problems.push(`says ${score} is above the threshold ${limit}`);
  }
  return problems;
}

const TIER_WORDS = { low: "low", medium: "medium", high: "high", rendah: "low", sederhana: "medium", tinggi: "high" };
const TIER_NAME = "(low|medium|high|rendah|sederhana|tinggi)";
const TIER_MENTIONS = [
  new RegExp(String.raw`\b(?:tier|tahap)\s+${TIER_NAME}\b`, "gi"),
  new RegExp(String.raw`\b${TIER_NAME}[\s-]+tier\b`, "gi"),
  new RegExp(String.raw`\b${TIER_NAME}\s+(?:incident|insiden)\b`, "gi"),
  new RegExp(String.raw`\binsiden\s+${TIER_NAME}\b`, "gi"),
];
const MATCH_MINUTES = 2;

// The (time, tier) pairs FACTS states: the listed incidents, the highest peak, the CONTEXT line and
// the latest scored minute.
function tieredTimes(factsText) {
  const text = String(factsText);
  const pairs = [];
  const patterns = [
    /^- (\d{1,2}:\d{2})\b[^\n]*?, tier (\w+)/gm,
    /^highest peak: [\d.]+ at (\d{1,2}:\d{2})\b[^\n]*?\(tier (\w+)/gm,
    /^CONTEXT: [^\n]*? at (\d{1,2}:\d{2}), tier (\w+)/gm,
    /^anomaly latest: (\d{1,2}:\d{2}),[^\n]*?\btier (\w+)/gm,
  ];
  for (const p of patterns) for (const m of text.matchAll(p)) pairs.push({ time: m[1], tier: m[2].toLowerCase() });
  return pairs;
}

function clockMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function sameMinute(a, b) {
  const d = Math.abs(clockMinutes(a) - clockMinutes(b));
  return Math.min(d, 24 * 60 - d) <= MATCH_MINUTES;
}

// A sentence that names a tier and a time must match an incident in FACTS at that time (2 minute
// match) with that tier. "tier low at 06:32" fails when the 06:32 incident is medium.
function tierProblems(answer, factsText) {
  const known = tieredTimes(factsText);
  const problems = [];
  for (const sentence of sentences(answer)) {
    const times = sentence.match(TIME) || [];
    if (!times.length) continue;
    const tiers = new Set();
    for (const p of TIER_MENTIONS) for (const m of sentence.matchAll(p)) tiers.add(TIER_WORDS[m[1].toLowerCase()]);
    for (const tier of tiers) {
      const ok = times.some((t) => known.some((k) => k.tier === tier && sameMinute(k.time, t)));
      if (!ok) problems.push(`says tier ${tier} at ${times.join(", ")}, which no incident in the FACTS has`);
    }
  }
  return problems;
}

// Returns the list of problems; an empty list means the answer passed. A number or time the user
// wrote in the question ("in 24 hours") may be repeated in the answer.
function checkAnswer(answer, factsText, question = "") {
  const problems = [];
  const facts = allTokens(factsText);
  const asked = allTokens(question);
  const factTimes = new Set([...facts.times, ...asked.times]);
  const factNumbers = new Set([...facts.numbers, ...asked.numbers]);
  const found = tokens(answer);
  for (const t of found.times) if (!factTimes.has(t)) problems.push(`time ${t} is not in the FACTS or the question`);
  for (const n of found.numbers) if (!factNumbers.has(n)) problems.push(`number ${n} is not in the FACTS or the question`);
  const claim = ACTION_CLAIMS.exec(String(answer));
  if (claim) problems.push(`claims an action ("${claim[1]}")`);
  problems.push(...directionProblems(answer, factsText), ...tierProblems(answer, factsText));
  if (!String(answer).trim()) problems.push("empty answer");
  return problems;
}

module.exports = { checkAnswer, tokens, directionProblems, tierProblems };
