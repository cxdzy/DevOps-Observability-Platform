// Builds the Express app from its dependencies so tests can pass fakes (database, InfluxDB, Google).
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const { createAuth } = require("./auth");
const { createGoogle } = require("./google");
const { createOverview, loadIncidents } = require("./overview");
const { loadRemediation } = require("./remediation");
const { createModel } = require("./model");

// Returns the validated hours value, or null after sending a 400. Values are clamped to 1..max.
function hoursParam(req, res, fallback = 24, max = 168) {
  const raw = req.query.hours;
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw.trim())) {
    res.status(400).json({ error: "hours must be an integer" });
    return null;
  }
  return Math.min(max, Math.max(1, parseInt(raw, 10)));
}

// HSTS and upgrade-insecure-requests only when the site itself is served over HTTPS; on a plain
// http origin they would send the browser to an https address that does not exist.
function securityHeaders(https) {
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "script-src-attr": ["'none'"],
    "style-src": ["'self'"],
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

// deps: { db, query, influxUrl, config, trusted, now, log, oidc, prometheus, mlflow }
// prometheus: a client from prometheus.js; tests pass a stub. Defaults to PROMETHEUS_URL.
// mlflow: a client from mlflow.js. Defaults to MLFLOW_URL.
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

  // Restarts run by the n8n workflow, last 7 days by default, up to 30 days.
  app.get("/api/remediation", async (req, res) => {
    const hours = hoursParam(req, res, 168, 720);
    if (hours === null) return;
    try {
      res.json(await loadRemediation(query, hours));
    } catch (err) {
      res.status(502).json({ error: "influxdb unreachable" });
    }
  });

  // Registry and retraining data. Partial data is returned when only one source fails.
  const model = createModel({ query, mlflow: deps.mlflow });
  app.get("/api/model", async (req, res) => {
    try {
      res.json(await model.load());
    } catch (err) {
      res.status(502).json({ error: "mlflow and influxdb unreachable" });
    }
  });

  app.get("/api/incidents", async (req, res) => {
    const hours = hoursParam(req, res);
    if (hours === null) return;
    try {
      res.json(await loadIncidents(query, hours, now()));
    } catch (err) {
      res.status(502).json({ error: "influxdb unreachable" });
    }
  });

  // Overview data. Each route fails on its own, so one unreachable source does not hide the others.
  const overview = createOverview({ query, prometheus: deps.prometheus });

  app.get("/api/nodes", async (req, res) => {
    try {
      res.json(await overview.nodes());
    } catch (err) {
      res.status(502).json({ error: "prometheus unreachable" });
    }
  });

  app.get("/api/services", async (req, res) => {
    try {
      res.json(await overview.services());
    } catch (err) {
      res.status(502).json({ error: "prometheus unreachable" });
    }
  });

  app.get("/api/activity", async (req, res) => {
    try {
      res.json(await overview.activity(now()));
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
