const test = require("node:test");
const assert = require("node:assert/strict");
const { checkAnswer } = require("../chat/check");
const fixture = require("./fixtures/facts_compact.json");

const FACTS = fixture.cases.find((c) => c.name === "more_than_8").facts_text;

test("accepts answers that copy numbers and times from FACTS", () => {
  for (const answer of [
    "sample-service is up. The latest anomaly score is 0.346 at 13:48, below the threshold 0.602.",
    "There were 11 incidents in the last 6 hours; the highest peak was 0.751 at 12:10.",
    "Memory is 124 MB against a normal 124 MB, so it looks normal.",
    "fyp-main uses 2.6 of 7.5 GiB and 36 % disk.",
    "Ya, ada 2 insiden memori dalam 6 jam lepas.",
    "Nothing looks wrong right now.",
    "The last CI deployment was at 20:19 23 Oct.",
  ]) {
    assert.deepEqual(checkAnswer(answer, FACTS), [], answer);
  }
});

test("rejects numbers and times that are not in FACTS", () => {
  assert.deepEqual(checkAnswer("The score is 0.35.", FACTS), ["number 0.35 is not in the FACTS or the question"]);
  assert.deepEqual(checkAnswer("It started at 14:05.", FACTS), ["time 14:05 is not in the FACTS or the question"]);
  // A number inside a FACTS number does not count: 34 is not 0.346.
  assert.deepEqual(checkAnswer("Memory is at 34 percent.", FACTS), ["number 34 is not in the FACTS or the question"]);
  assert.deepEqual(checkAnswer("Disk I/O was 55% and 36%.", FACTS), []); // numbers are in FACTS: the guard handles this
  assert.deepEqual(checkAnswer("There were 12 incidents.", FACTS), ["number 12 is not in the FACTS or the question"]);
});

test("rejects action claims in English and Malay", () => {
  for (const [answer, word] of [
    ["I restarted sample-service.", "restarted"],
    ["The service was rolled back to v9.", "rolled back"],
    ["I stopped the container.", "stopped"],
    ["Saya telah restart perkhidmatan.", "telah restart"],
    ["Perkhidmatan telah dimulakan semula.", "dimulakan semula"],
  ]) {
    const problems = checkAnswer(answer, FACTS);
    assert.ok(problems.includes(`claims an action ("${word}")`), answer);
  }
  assert.deepEqual(checkAnswer("Restarts need an admin request and a Telegram approval.", FACTS), []);
});

test("numbers and times from the question are allowed, invented ones are still rejected", () => {
  const question = "how many high incidents in 24hours";
  const ok = "The dashboard has no data for the number of high incidents in the last 24 hours.";
  assert.deepEqual(checkAnswer(ok, FACTS), ["number 24 is not in the FACTS or the question"]);
  assert.deepEqual(checkAnswer(ok, FACTS, question), []);
  assert.deepEqual(checkAnswer("There were 17 high incidents in 24 hours.", FACTS, question),
    ["number 17 is not in the FACTS or the question"]);
  assert.deepEqual(checkAnswer("Nothing happened at 03:00.", FACTS, "What happened at 03:00?"), []);
  assert.deepEqual(checkAnswer("Nothing happened at 04:00.", FACTS, "What happened at 03:00?"),
    ["time 04:00 is not in the FACTS or the question"]);
});

test("an empty answer fails", () => {
  assert.deepEqual(checkAnswer("  ", FACTS), ["empty answer"]);
});
