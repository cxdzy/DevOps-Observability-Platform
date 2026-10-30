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

// Absolute lifetime (SESSION_MAX_AGE_HOURS): however active, a session ends this long after sign-in.
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isPastMaxAge(createdAt, nowMs, maxAgeMs) {
  return nowMs - new Date(createdAt).getTime() >= maxAgeMs;
}

// 8 hours from now, but never past the absolute limit.
function cappedExpiry(createdAt, nowMs, maxAgeMs) {
  return new Date(Math.min(nowMs + SESSION_MS, new Date(createdAt).getTime() + maxAgeMs));
}

// The new expiry for a sliding renewal, or null when no renewal is due or it would not extend the
// session (it has reached the absolute limit).
function renewedExpiry(expiresAt, createdAt, nowMs, maxAgeMs) {
  if (!needsRenewal(expiresAt, nowMs)) return null;
  const next = cappedExpiry(createdAt, nowMs, maxAgeMs);
  return next.getTime() > new Date(expiresAt).getTime() ? next : null;
}

module.exports = {
  SESSION_MS,
  RENEW_EVERY_MS,
  DEFAULT_MAX_AGE_MS,
  isPastMaxAge,
  cappedExpiry,
  renewedExpiry,
  hashToken,
  newSessionToken,
  isValidTokenFormat,
  isExpired,
  needsRenewal,
  newExpiry,
};
