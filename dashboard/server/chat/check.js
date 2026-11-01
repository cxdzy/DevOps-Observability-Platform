// Checks a model answer against the FACTS text it was given (chat plan section 13, step 4).
// Every HH:MM time and every number with two or more digits or a decimal point must appear in
// FACTS or in the user's question as the same token ("34" does not pass because FACTS has "0.347"),
// and the answer must not claim an action. Pure functions, no I/O.

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
  if (!String(answer).trim()) problems.push("empty answer");
  return problems;
}

module.exports = { checkAnswer, tokens };
