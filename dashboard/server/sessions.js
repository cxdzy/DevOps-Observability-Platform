// Session token rules. The cookie holds a random token; the database stores only its SHA-256 hash,
// so a leaked sessions table cannot be used to sign in.
const crypto = require("crypto");

const SESSION_MS = 8 * 60 * 60 * 1000;
const RENEW_EVERY_MS = 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function newSessionToken() {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, idHash: hashToken(token) };
}

function isValidTokenFormat(token) {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

function isExpired(expiresAt, nowMs) {
  return new Date(expiresAt).getTime() <= nowMs;
}

// Sliding renewal at most once per hour: a session is renewed when at least an hour has passed
// since it was created or last renewed, which is when less than 7 of its 8 hours remain.
function needsRenewal(expiresAt, nowMs) {
  return new Date(expiresAt).getTime() - nowMs <= SESSION_MS - RENEW_EVERY_MS;
}

function newExpiry(nowMs) {
  return new Date(nowMs + SESSION_MS);
}

module.exports = {
  SESSION_MS,
  RENEW_EVERY_MS,
  hashToken,
  newSessionToken,
  isValidTokenFormat,
  isExpired,
  needsRenewal,
  newExpiry,
};
