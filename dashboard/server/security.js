// Request checks shared by the auth routes: origin, client IP, rate limit keys and log masking.
const net = require("net");
const { ipKeyGenerator } = require("express-rate-limit");

function normaliseEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// TRUST_PROXY is a hop count; "0", "false" or "" turn it off. Default 1.
function parseTrustProxy(value) {
  if (value === undefined) return 1;
  const text = String(value).trim().toLowerCase();
  if (text === "" || text === "false") return false;
  if (text === "true") return 1;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? (n === 0 ? false : n) : 1;
}

// Only an exact match of the Origin header counts. A missing Origin is rejected.
function originAllowed(origin, appOrigin) {
  return typeof origin === "string" && origin === appOrigin;
}

// Cloudflare puts the real client address in CF-Connecting-IP. It is only believed when the
// app is configured to trust a proxy; otherwise anyone could set it.
function clientIp(req, trustProxy) {
  const cf = req.headers["cf-connecting-ip"];
  if (trustProxy && typeof cf === "string" && net.isIP(cf.trim())) return cf.trim();
  return req.ip || "";
}

// ipKeyGenerator groups IPv6 addresses by /56 so one host cannot rotate addresses to dodge the limit.
function ipKey(ip) {
  return ipKeyGenerator(ip || "unknown");
}

function loginIpEmailKey(ip, email) {
  return `${ipKey(ip)}|${normaliseEmail(email)}`;
}

function loginIpKey(ip) {
  return ipKey(ip);
}

// "alice@example.com" -> "al***@example.com", for logs only.
function maskEmail(email) {
  const value = normaliseEmail(email);
  const at = value.lastIndexOf("@");
  if (at < 1) return value ? `${value.slice(0, 2)}***` : "(empty)";
  return `${value.slice(0, Math.min(2, at))}***@${value.slice(at + 1)}`;
}

module.exports = {
  normaliseEmail,
  parseTrustProxy,
  originAllowed,
  clientIp,
  loginIpEmailKey,
  loginIpKey,
  maskEmail,
};
