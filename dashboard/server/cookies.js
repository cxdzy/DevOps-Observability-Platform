// Minimal cookie header parsing and Set-Cookie building (no extra dependency).

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Ignore a malformed value instead of failing the request.
    }
  }
  return out;
}

// opts: { maxAgeMs, path, httpOnly, secure, sameSite }
function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || "/"}`);
  if (opts.maxAgeMs !== undefined) {
    const seconds = Math.max(0, Math.floor(opts.maxAgeMs / 1000));
    parts.push(`Max-Age=${seconds}`);
    parts.push(`Expires=${new Date(Date.now() + seconds * 1000).toUTCString()}`);
  }
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite || "Lax"}`);
  return parts.join("; ");
}

function clearCookie(name, opts = {}) {
  return serializeCookie(name, "", { ...opts, maxAgeMs: 0 });
}

module.exports = { parseCookies, serializeCookie, clearCookie };
