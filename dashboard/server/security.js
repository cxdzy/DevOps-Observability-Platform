// Request checks shared by the auth routes: origin, client IP, rate limit keys and log masking.
const crypto = require("crypto");
const dns = require("dns");
const net = require("net");
const { ipKeyGenerator } = require("express-rate-limit");

const MAX_EMAIL_LENGTH = 254;

function normaliseEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Only an exact match of the Origin header counts. A missing Origin is rejected.
function originAllowed(origin, appOrigin) {
  return typeof origin === "string" && origin === appOrigin;
}

// "::ffff:1.2.3.4" -> "1.2.3.4", so IPv4 peers compare equal however the socket reports them.
function normaliseIp(address) {
  const value = String(address || "").trim().toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1] : value;
}

// TRUSTED_PROXY_HOSTS: comma separated hostnames, default "cloudflared". "none" trusts nobody.
function parseHostList(value) {
  if (value === undefined || String(value).trim() === "") return ["cloudflared"];
  if (String(value).trim().toLowerCase() === "none") return [];
  return String(value).split(",").map((h) => h.trim()).filter(Boolean);
}

// The addresses of the trusted proxy hosts, looked up with dns.lookup. A host that fails to
// resolve contributes nothing, so a lookup failure never leaves stale addresses trusted.
function createTrustedProxies(hosts, lookup = dns.promises.lookup) {
  let addresses = new Set();
  return {
    async refresh() {
      const next = new Set();
      for (const host of hosts) {
        try {
          for (const { address } of await lookup(host, { all: true })) next.add(normaliseIp(address));
        } catch {
          // Unresolvable host: trust nothing for it.
        }
      }
      addresses = next;
      return addresses.size;
    },
    has(address) {
      return addresses.has(normaliseIp(address));
    },
  };
}

// Cloudflare puts the real client address in CF-Connecting-IP. It is believed only when the TCP
// peer is one of the trusted proxies (cloudflared); X-Forwarded-For is never used. Everyone else,
// including callers through the localhost port mapping, is identified by the socket address.
function clientIp(req, trusted) {
  const peer = normaliseIp(req.socket && req.socket.remoteAddress);
  const cf = req.headers["cf-connecting-ip"];
  if (trusted && trusted.has(peer) && typeof cf === "string" && net.isIP(cf.trim())) return normaliseIp(cf);
  return peer;
}

// ipKeyGenerator groups IPv6 addresses by /56 so one host cannot rotate addresses to dodge the limit.
function ipKey(ip) {
  return ipKeyGenerator(ip || "unknown");
}

// Fixed-size key for an email address, whatever was sent.
function emailKey(email) {
  return crypto.createHash("sha256").update(normaliseEmail(email)).digest("hex");
}

function loginIpEmailKey(ip, email) {
  return `${ipKey(ip)}|${emailKey(email)}`;
}

function loginIpKey(ip) {
  return ipKey(ip);
}

// "alice@example.com" -> "al***@example.com", for logs only.
function maskEmail(email) {
  const value = normaliseEmail(email).slice(0, MAX_EMAIL_LENGTH);
  const at = value.lastIndexOf("@");
  if (at < 1) return value ? `${value.slice(0, 2)}***` : "(empty)";
  return `${value.slice(0, Math.min(2, at))}***@${value.slice(at + 1)}`;
}

module.exports = {
  MAX_EMAIL_LENGTH,
  normaliseEmail,
  normaliseIp,
  parseHostList,
  createTrustedProxies,
  originAllowed,
  clientIp,
  emailKey,
  loginIpEmailKey,
  loginIpKey,
  maskEmail,
};
