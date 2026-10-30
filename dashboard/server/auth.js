// Email and password login, server-side sessions, and the auth middleware.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { cookieName, parseCookies, serializeCookie, clearCookie } = require("./cookies");
const sessions = require("./sessions");
const {
  MAX_EMAIL_LENGTH,
  normaliseEmail,
  originAllowed,
  clientIp,
  emailKey,
  loginIpEmailKey,
  loginIpKey,
  maskEmail,
} = require("./security");

const SESSION_COOKIE_BASE = "dash_session";
const GENERIC_LOGIN_ERROR = "Invalid email or password";
const MAX_PASSWORD_LENGTH = 1024;

// opts: { db, appOrigin, cookieSecure, trusted (createTrustedProxies), sessionMaxAgeMs = 24 h,
//         bcryptCost = 12, now = Date.now, log = console.log }
function createAuth(opts) {
  const { db, appOrigin, cookieSecure, trusted } = opts;
  const sessionMaxAgeMs = opts.sessionMaxAgeMs || sessions.DEFAULT_MAX_AGE_MS;
  const SESSION_COOKIE = cookieName(SESSION_COOKIE_BASE, cookieSecure);
  const bcryptCost = opts.bcryptCost || 12;
  const now = opts.now || Date.now;
  const log = opts.log || console.log;

  // Compared against when there is no usable hash, so every failed login costs one bcrypt compare.
  // Made at startup from random bytes; no fixed hash lives in the repository.
  // Started now so the first failed login is not slower than later ones.
  let dummyHash = null;
  function getDummyHash() {
    if (!dummyHash) dummyHash = bcrypt.hash(crypto.randomBytes(32).toString("hex"), bcryptCost);
    return dummyHash;
  }
  getDummyHash();

  function sessionCookie(token, expiresAt) {
    return serializeCookie(SESSION_COOKIE, token, {
      maxAgeMs: new Date(expiresAt).getTime() - now(),
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "Lax",
    });
  }

  function clearSessionCookie() {
    return clearCookie(SESSION_COOKIE, { secure: cookieSecure, sameSite: "Lax" });
  }

  async function startSession(req, res, user) {
    const { token, idHash } = sessions.newSessionToken();
    const userAgent = String(req.get("user-agent") || "").slice(0, 255);
    const t = now();
    const expiresAt = sessions.cappedExpiry(t, t, sessionMaxAgeMs);
    await db.createSession({ idHash, userId: user.id, createdAt: new Date(t), expiresAt, userAgent });
    await db.recordLogin(user.id, new Date(t));
    res.append("Set-Cookie", sessionCookie(token, expiresAt));
  }

  // The session token the request carries and its hash, or null.
  function presentedSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return sessions.isValidTokenFormat(token) ? { token, idHash: sessions.hashToken(token) } : null;
  }

  // Sets req.user from a valid session. Sliding renewal at most once per hour, never past the
  // absolute limit; a session older than that limit is deleted.
  async function loadSession(req, res) {
    const presented = presentedSession(req);
    if (!presented) return null;
    const { token, idHash } = presented;
    const session = await db.getSession(idHash);
    if (!session) return null;
    const t = now();
    if (
      sessions.isExpired(session.expiresAt, t) ||
      sessions.isPastMaxAge(session.createdAt, t, sessionMaxAgeMs) ||
      session.user.disabled
    ) {
      await db.deleteSession(idHash);
      res.append("Set-Cookie", clearSessionCookie());
      return null;
    }
    const renewed = sessions.renewedExpiry(session.expiresAt, session.createdAt, t, sessionMaxAgeMs);
    if (renewed) {
      await db.renewSession(idHash, renewed);
      res.append("Set-Cookie", sessionCookie(token, renewed));
    }
    req.sessionIdHash = idHash;
    return session.user;
  }

  function requireAuth(req, res, next) {
    loadSession(req, res)
      .then((user) => {
        if (!user) return res.status(401).json({ error: "not signed in" });
        req.user = user;
        next();
      })
      .catch(next);
  }

  // Use after requireAuth.
  function requireRole(role) {
    return (req, res, next) => {
      if (!req.user || req.user.role !== role) return res.status(403).json({ error: "forbidden" });
      next();
    };
  }

  // CSRF protection for state-changing routes: JSON body and an exact Origin match.
  function stateChanging(req, res, next) {
    if (!req.is("application/json")) return res.status(415).json({ error: "expected application/json" });
    if (!originAllowed(req.get("origin"), appOrigin)) return res.status(403).json({ error: "bad origin" });
    next();
  }

  // Returns the user when the email and password match an enabled user with a password, else null.
  // Every path runs exactly one bcrypt compare so the response time does not reveal which case it was.
  async function verifyPassword(email, password) {
    const user = email ? await db.findUserByEmail(email) : null;
    const usable = user && !user.disabled && user.password_hash;
    const hash = usable ? user.password_hash : await getDummyHash();
    const candidate = typeof password === "string" && password.length <= MAX_PASSWORD_LENGTH ? password : "";
    const match = await bcrypt.compare(candidate, hash);
    return usable && match && candidate !== "" ? user : null;
  }

  const limitHandler = (req, res) => res.status(429).json({ error: "Too many attempts, try again later" });
  const ip = (req) => clientIp(req, trusted);
  // X-Forwarded-For is ignored on purpose (cloudflared sends it), so the library's check for it is off.
  const limiterDefaults = {
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: limitHandler,
    validate: { xForwardedForHeader: false },
  };
  const limitPerIp = rateLimit({
    ...limiterDefaults,
    windowMs: 10 * 60 * 1000,
    limit: 30,
    keyGenerator: (req) => loginIpKey(ip(req)),
  });
  const limitPerIpEmail = rateLimit({
    ...limiterDefaults,
    windowMs: 60 * 1000,
    limit: 5,
    keyGenerator: (req) => loginIpEmailKey(ip(req), req.body && req.body.email),
  });
  // Failed attempts per email address from all sources together, so rotating addresses does not
  // help. Applies to every email, known or not. Google sign-in does not pass through it.
  const limitPerEmail = rateLimit({
    ...limiterDefaults,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `email|${emailKey(req.body && req.body.email)}`,
  });

  function loginFailed(req, res, email) {
    log(JSON.stringify({ event: "login_failed", email: maskEmail(email), ip: ip(req) }));
    res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  // An address longer than any valid email is refused before any keying or bcrypt work.
  function rejectLongEmail(req, res, next) {
    const email = normaliseEmail(req.body && req.body.email);
    if (email.length > MAX_EMAIL_LENGTH) return loginFailed(req, res, email);
    next();
  }

  const router = express.Router();
  const json = express.json({ limit: "4kb" });

  const loginLimits = [rejectLongEmail, limitPerIp, limitPerIpEmail, limitPerEmail];
  router.post("/login", stateChanging, json, ...loginLimits, async (req, res, next) => {
    try {
      const email = normaliseEmail(req.body && req.body.email);
      const user = await verifyPassword(email, req.body && req.body.password);
      if (!user) return loginFailed(req, res, email);
      // A session the browser already had is ended, so only the new one stays valid.
      const previous = presentedSession(req);
      if (previous) await db.deleteSession(previous.idHash);
      await startSession(req, res, user);
      res.json({ email: user.email, role: user.role });
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", stateChanging, async (req, res, next) => {
    try {
      const presented = presentedSession(req);
      if (presented) await db.deleteSession(presented.idHash);
      res.append("Set-Cookie", clearSessionCookie());
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ email: req.user.email, role: req.user.role });
  });

  return {
    router,
    requireAuth,
    requireRole,
    startSession,
    verifyPassword,
    sessionCookieName: SESSION_COOKIE,
    GENERIC_LOGIN_ERROR,
  };
}

module.exports = { createAuth, SESSION_COOKIE_BASE };
