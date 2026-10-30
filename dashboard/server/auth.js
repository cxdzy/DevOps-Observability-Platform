// Email and password login, server-side sessions, and the auth middleware.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { parseCookies, serializeCookie, clearCookie } = require("./cookies");
const sessions = require("./sessions");
const { normaliseEmail, originAllowed, clientIp, loginIpEmailKey, loginIpKey, maskEmail } = require("./security");

const SESSION_COOKIE = "dash_session";
const GENERIC_LOGIN_ERROR = "Invalid email or password";
const MAX_PASSWORD_LENGTH = 1024;

// opts: { db, appOrigin, cookieSecure, trustProxy, bcryptCost = 12, now = Date.now, log = console.log }
function createAuth(opts) {
  const { db, appOrigin, cookieSecure, trustProxy } = opts;
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

  function sessionCookie(token) {
    return serializeCookie(SESSION_COOKIE, token, {
      maxAgeMs: sessions.SESSION_MS,
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
    await db.createSession({ idHash, userId: user.id, expiresAt: sessions.newExpiry(now()), userAgent });
    await db.recordLogin(user.id, new Date(now()));
    res.append("Set-Cookie", sessionCookie(token));
  }

  // Sets req.user from a valid session; sliding renewal at most once per hour.
  async function loadSession(req, res) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sessions.isValidTokenFormat(token)) return null;
    const idHash = sessions.hashToken(token);
    const session = await db.getSession(idHash);
    if (!session) return null;
    const t = now();
    if (sessions.isExpired(session.expiresAt, t) || session.user.disabled) {
      await db.deleteSession(idHash);
      res.append("Set-Cookie", clearSessionCookie());
      return null;
    }
    if (sessions.needsRenewal(session.expiresAt, t)) {
      await db.renewSession(idHash, sessions.newExpiry(t));
      res.append("Set-Cookie", sessionCookie(token));
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
  const limitPerIpEmail = rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => loginIpEmailKey(clientIp(req, trustProxy), req.body && req.body.email),
    handler: limitHandler,
  });
  const limitPerIp = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => loginIpKey(clientIp(req, trustProxy)),
    handler: limitHandler,
  });

  const router = express.Router();
  const json = express.json({ limit: "4kb" });

  router.post("/login", stateChanging, json, limitPerIp, limitPerIpEmail, async (req, res, next) => {
    try {
      const email = normaliseEmail(req.body && req.body.email);
      const user = await verifyPassword(email, req.body && req.body.password);
      if (!user) {
        log(JSON.stringify({ event: "login_failed", email: maskEmail(email), ip: clientIp(req, trustProxy) }));
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
      }
      await startSession(req, res, user);
      res.json({ email: user.email, role: user.role });
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", stateChanging, async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (sessions.isValidTokenFormat(token)) await db.deleteSession(sessions.hashToken(token));
      res.append("Set-Cookie", clearSessionCookie());
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ email: req.user.email, role: req.user.role });
  });

  return { router, requireAuth, requireRole, startSession, verifyPassword, GENERIC_LOGIN_ERROR };
}

module.exports = { createAuth, SESSION_COOKIE };
