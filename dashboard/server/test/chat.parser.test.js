const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, NO_DATA_TOPICS, NO_DATA_REPLY } = require("../chat/parser");

// [message, intent, language]
const CASES = [
  // Action requests, English and Malay, any case.
  ["Restart sample-service", "action", "en"],
  ["restart the service now", "action", "en"],
  ["RESTART SAMPLE-SERVICE", "action", "en"],
  ["Please roll back the last deployment", "action", "en"],
  ["Can you rollback to the previous version?", "action", "en"],
  ["Stop the container", "action", "en"],
  ["kill sample-service", "action", "en"],
  ["Scale it up to two replicas", "action", "en"],
  ["Tolong mula semula sample-service", "action", "ms"],
  ["Hentikan sample-service sekarang", "action", "ms"],
  ["Don't do anything else, but restart the service", "action", "en"],
  // Negated action words are not actions.
  ["Don't restart anything, just tell me if memory looks normal.", "llm", "en"],
  ["Do not roll back, what is the latest score?", "llm", "en"],
  ["Never stop the service. Is it up?", "llm", "en"],
  ["Without a restart, is memory normal?", "llm", "en"],
  ["Jangan restart, adakah memori normal?", "llm", "ms"],
  ["Tak payah hentikan, apa status sekarang?", "llm", "ms"],
  ["dont restart it, how many incidents today?", "llm", "en"],
  // Questions about past actions are not requests.
  ["When was the last restart and did the service come back up?", "llm", "en"],
  ["Was there a restart today?", "llm", "en"],
  ["Why did it stop?", "llm", "en"],
  ["Was the service restarted?", "llm", "en"],
  // No-data guard.
  ["What was the disk I/O on sample-service at 03:00 yesterday?", "no_data", "en"],
  ["Why did the developer push the last commit?", "no_data", "en"],
  ["Show me the logs", "no_data", "en"],
  ["What is the network bandwidth?", "no_data", "en"],
  ["How many users are logged in?", "no_data", "en"],
  ["What is the request count per minute?", "no_data", "en"],
  ["Any stack trace in the error message?", "no_data", "en"],
  ["What does the server cost per month?", "no_data", "en"],
  ["What is the CPU temperature?", "llm", "en"],
  ["Bagaimana cuaca hari ini?", "no_data", "ms"],
  ["Berapa trafik rangkaian sekarang?", "no_data", "ms"],
  ["Siapa log masuk tadi?", "no_data", "ms"],
  // An available fact keeps the question with the model.
  ["How much disk is fyp-main using?", "llm", "en"],
  ["What is the disk usage on staging?", "llm", "en"],
  ["Is memory high, and what about the network?", "llm", "en"],
  ["Did a deployment cause the latency spike?", "llm", "en"],
  ["What is my login status?", "llm", "en"],
  // Fixed templates (the command chips).
  ["System status", "status", "en"],
  ["system status?", "status", "en"],
  ["Last incident", "last_incident", "en"],
  ["Health check", "health_check", "en"],
  ["Insiden terakhir", "last_incident", "ms"],
  // Everything else goes to the model.
  ["Should I be worried right now?", "llm", "en"],
  ["Ada insiden memori dalam 6 jam lepas?", "llm", "ms"],
  ["What is the latest anomaly score and is it above the threshold?", "llm", "en"],
];

test(`parser table (${CASES.length} cases)`, () => {
  assert.ok(CASES.length >= 30);
  for (const [message, intent, lang] of CASES) {
    const got = parse(message);
    assert.equal(got.intent, intent, message);
    assert.equal(got.lang, lang, `${message} (language)`);
  }
});

test("the topic list is one exported constant and covers the plan's topics", () => {
  for (const topic of ["disk i/o", "iops", "network", "commit", "developer", "cuaca", "rangkaian", "log masuk"]) {
    assert.ok(NO_DATA_TOPICS.includes(topic), topic);
  }
  assert.ok(Object.isFrozen(NO_DATA_TOPICS));
});

test("disk alone is not blocked, disk I/O is", () => {
  assert.equal(parse("disk").intent, "llm");
  assert.equal(parse("What is the disk percent on fyp-main?").intent, "llm");
  assert.equal(parse("disk I/O").intent, "no_data");
  assert.equal(parse("disk read and disk write rates").intent, "no_data");
});

test("log does not match login, and the reply texts are fixed", () => {
  assert.equal(parse("Is the login page up?").intent, "llm");
  assert.match(NO_DATA_REPLY.en, /^The dashboard has no data for that\. It only has the anomaly score/);
  assert.match(NO_DATA_REPLY.ms, /^Dashboard tiada data untuk itu\./);
});
