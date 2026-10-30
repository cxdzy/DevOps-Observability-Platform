const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const s = require("../sessions");

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);

test("token is 32 random bytes as hex and the stored id is its SHA-256", () => {
  const a = s.newSessionToken();
  const b = s.newSessionToken();
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
  assert.equal(a.idHash, crypto.createHash("sha256").update(a.token).digest("hex"));
  assert.notEqual(a.idHash, a.token);
  assert.equal(s.hashToken(a.token), a.idHash);
});

test("token format check rejects anything but 64 lowercase hex characters", () => {
  assert.equal(s.isValidTokenFormat("a".repeat(64)), true);
  for (const bad of [undefined, "", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
    assert.equal(s.isValidTokenFormat(bad), false);
  }
});

test("a session lasts 8 hours", () => {
  assert.equal(s.newExpiry(T0).getTime(), T0 + 8 * HOUR);
  assert.equal(s.isExpired(new Date(T0 + 8 * HOUR), T0 + 8 * HOUR - 1), false);
  assert.equal(s.isExpired(new Date(T0 + 8 * HOUR), T0 + 8 * HOUR), true);
});

test("sliding renewal happens at most once per hour", () => {
  const expires = s.newExpiry(T0);
  assert.equal(s.needsRenewal(expires, T0), false);
  assert.equal(s.needsRenewal(expires, T0 + HOUR - 1), false);
  assert.equal(s.needsRenewal(expires, T0 + HOUR), true);
  assert.equal(s.needsRenewal(s.newExpiry(T0 + HOUR), T0 + HOUR + 1), false);
});
