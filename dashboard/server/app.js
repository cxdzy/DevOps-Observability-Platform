// Builds the Express app from its dependencies so tests can pass fakes (database, InfluxDB, Google).
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const { createAuth } = require("./auth");
const { createGoogle } = require("./google");
const { mergeIncidents } = require("./incidents");

// Returns the validated hours value, or null after sending a 400.
function hoursParam(req, res) {
  const raw = req.query.hours;
  if (raw === undefined) return 24;
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw.trim())) {
    res.status(400).json({ error: "hours must be an integer" });
    return null;
  }
  return Math.min(168, Math.max(1, parseInt(raw, 10)));
}

// reka-ui 2.11 renders one small <style> block each in ScrollArea and Select to hide native
// scrollbars. They are allowed by hash instead of 'unsafe-inline'. After a reka-ui upgrade
// the browser console names the new hash; without it only the native scrollbar shows.
const REKA_STYLE_HASHES = [
  "'sha256-6kJHBrMeYPjuL963zk84BmND3Z4cszEoZMFiRK2nkPY='", // ScrollAreaViewport
  "'sha256-60LHlRjW/B3CtzIoE/Lf1/NEDvko9efWMFaGVhHu/cs='", // SelectViewport
];

// HSTS and upgrade-insecure-requests only when the site itself is served over HTTPS; on a plain
// http origin they would send the browser to an https address that does not exist.
function securityHeaders(https) {
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "script-src-attr": ["'none'"],
    "style-src": ["'self'", ...REKA_STYLE_HASHES],
    "img-src": ["'self'"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  if (https) directives["upgrade-insecure-requests"] = [];
  return helmet({
    contentSecurityPolicy: { useDefaults: false, directives },
    strictTransportSecurity: https ? undefined : false,
  });
}

// Trusts no proxy; used when no trusted set is passed.
const TRUST_NOBODY = { has: () => false };

// deps: { db, query, influxUrl, config, trusted, now, log, oidc }
// config: { appOrigin, cookieSecure, sessionMaxAgeMs, googleClientId, googleClientSecret, clientDist, bcryptCost }
// trusted: the resolved trusted proxy addresses (security.createTrustedProxies).
function createApp(deps) {
  const { db, query, config } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || console.log;

  const app = express();
  app.disable("x-powered-by");
  // Forwarded headers are never trusted by Express; the client address comes from security.clientIp.
  // Nothing uses req.ip, req.secure or req.protocol: HSTS follows APP_ORIGIN, cookies COOKIE_SECURE.
  app.set("trust proxy", false);
  app.use(securityHeaders(config.appOrigin.startsWith("https://")));
  // API and auth responses are per user and must never be cached.
  app.use(["/api", "/auth"], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  const auth = createAuth({ db, now, log, trusted: deps.trusted || TRUST_NOBODY, ...config });
  const google = createGoogle({
    db,
    auth,
    log,
    oidc: deps.oidc,
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    appOrigin: config.appOrigin,
    cookieSecure: config.cookieSecure,
  });

  app.get("/auth/config", (req, res) => res.json({ google: google.enabled }));
  app.use("/auth", auth.router);
  app.use("/auth", google.router);
  app.use("/auth", (req, res) => res.status(404).json({ error: "not found" }));

  // Public, used by the container healthcheck.
  app.get("/api/health", async (req, res) => {
    let influx = false;
    try {
      const r = await fetch(`${deps.influxUrl}/ping`, { signal: AbortSignal.timeout(2000) });
      influx = r.ok;
    } catch (err) {
      influx = false;
    }
    res.json({ status: "ok", time: new Date().toISOString(), influx });
  });

  // Everything else under /api needs a session.
  app.use("/api", auth.requireAuth);

  app.get("/api/anomaly/latest", async (req, res) => {
    try {
      const rows = await query('SELECT * FROM "anomaly_score" ORDER BY time DESC LIMIT 1');
      res.json(rows[0] || {});
    } catch (err) {
      res.status(502).json({ error: "influxdb unreachable" });
    }
  });

  app.get("/api/anomaly", async (req, res) => {
    const hours = hoursParam(req, res);
    if (hours === null) return;
    try {
      const rows = await query(
        'SELECT "score","threshold","is_anomaly","tier","tier_level","signal","cpu_rate","memory_mb","latency_ms","recent_deployment","model" ' +
          `FROM "anomaly_score" WHERE time > now() - ${hours}h ORDER BY time ASC`
      );
      res.json(rows);
    } catch (err) {
      res.status(502).json({ error: "influxdb unreachable" });
    }
  });

  app.get("/api/incidents", async (req, res) => {
    const hours = hoursParam(req, res);
    if (hours === null) return;
    try {
      const [expl, open] = await Promise.all([
        query(
          'SELECT "tier","action","signal","peak_score","minutes","source","deployment","explanation" ' +
            `FROM "incident_explanation" WHERE time > now() - ${hours}h ORDER BY time ASC`
        ),
        query(
          'SELECT "tier","tier_level","action","signal","peak_score","minutes","deployment" ' +
            `FROM "incident_open" WHERE time > now() - ${hours}h ORDER BY time ASC`
        ),
      ]);
      res.json(mergeIncidents(expl, open, now()));
    } catch (err) {
      res.status(502).json({ error: "influxdb unreachable" });
    }
  });

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // The page and its assets are public so the login screen can load; all data comes from /api.
  // Built assets have content hashes in their names, so they can be cached for a year; the page
  // itself must be revalidated so a new build is picked up.
  if (config.clientDist) {
    const assetsDir = path.join(config.clientDist, "assets") + path.sep;
    app.use(
      express.static(config.clientDist, {
        cacheControl: false,
        setHeaders(res, filePath) {
          const immutable = filePath.startsWith(assetsDir);
          res.set("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
        },
      })
    );
    app.get("*", (req, res) => {
      if (path.extname(req.path)) {
        return res.status(404).type("text").send("Not found");
      }
      res.sendFile(path.join(config.clientDist, "index.html"), { cacheControl: false, headers: { "Cache-Control": "no-cache" } }, (err) => {
        if (err && !res.headersSent) {
          res.status(404).type("text").send("Not found");
        }
      });
    });
  }

  // Never send a stack trace to the browser. Body parser errors (bad JSON, too large) keep their 4xx status.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log(JSON.stringify({ event: "server_error", path: req.path, error: String(err && err.message) }));
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  });

  return { app, auth, google };
}

module.exports = { createApp };
