// Forecast routes, mounted at /api before the session check:
//   GET /api/forecast                 current state per container and per server (signed-in users)
//   GET /api/forecast/events?from=&to= warning history (signed-in users)
//   GET /api/internal/forecast/new?since=  new warnings for the later Telegram workflow. No session;
//     it needs the x-notify-token header. Without a token of at least 32 characters configured the
//     route answers 404 as if it did not exist. Each event carries server_name from the registry,
//     the same source /api/forecast uses, or the server key when the registry does not know it.
// Every route only reads. No answer has message text, a secret or a stack trace.
const crypto = require("crypto");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { clientIp, loginIpKey } = require("../security");
const { FORECAST_CONFIG } = require("../forecast/config");

const MIB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

function round(value, digits) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}
function scaled(value, by, digits) {
  return typeof value === "number" && Number.isFinite(value) ? round(value / by, digits) : null;
}
function iso(value) {
  if (value === null || value === undefined) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
// An ISO UTC time ("2026-11-22T08:00:00Z") as ms, or null.
function parseIso(value) {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function containerOut(e) {
  return {
    server: e.server,
    server_name: e.server_name,
    project: e.project,
    container: e.container,
    state: e.state,
    reason: e.reason ?? null,
    est_minutes: round(e.est_minutes, 1),
    limit_mb: scaled(e.limit_bytes, MIB, 1),
    level_mb: scaled(e.level_bytes, MIB, 1),
    slope_mb_per_min: scaled(e.slope_bytes_per_min, MIB, 3),
    r2: round(e.r2, 3),
    restarts: Number.isInteger(e.restarts) ? e.restarts : null,
    oom: typeof e.oom === "boolean" ? e.oom : null,
    since: iso(e.since),
    updated_at: iso(e.updated_at),
  };
}

function diskOut(e) {
  return {
    server: e.server,
    server_name: e.server_name,
    mountpoint: e.mountpoint,
    state: e.state,
    reason: e.reason ?? null,
    est_hours: scaled(e.est_minutes, 60, 1),
    used_pct: round(e.used_pct, 1),
    slope_pct_per_hour: round(e.slope_pct_per_hour, 3),
    r2: round(e.r2, 3),
    since: iso(e.since),
    updated_at: iso(e.updated_at),
  };
}

function eventOut(row) {
  const num = (v) => (v === null || v === undefined ? null : round(Number(v), 3));
  return {
    id: String(row.id),
    resource: row.resource,
    server: row.server,
    project: row.project ?? null,
    container: row.container ?? null,
    mountpoint: row.mountpoint ?? null,
    opened_at: iso(row.opened_at),
    closed_at: iso(row.closed_at),
    close_reason: row.close_reason ?? null,
    est_minutes_at_open: num(row.est_minutes_at_open),
    est_minutes_latest: num(row.est_minutes_latest),
    limit_value: num(row.limit_value),
    level_at_open: num(row.level_at_open),
    slope_per_min: num(row.slope_per_min),
    r2: num(row.r2),
    window_min: num(row.window_min),
    config_version: row.config_version,
  };
}

// The fields the notify workflow may read. No close data, no config, no text. names maps a server
// key to its registry name; an unknown key falls back to the key itself.
function newOut(row, names) {
  const e = eventOut(row);
  return {
    id: e.id,
    resource: e.resource,
    server: e.server,
    server_name: names.get(e.server) ?? e.server,
    project: e.project,
    container: e.container,
    mountpoint: e.mountpoint,
    opened_at: e.opened_at,
    est_minutes_at_open: e.est_minutes_at_open,
    limit_value: e.limit_value,
    level_at_open: e.level_at_open,
    slope_per_min: e.slope_per_min,
  };
}

// Constant time comparison of two strings of any length: both are hashed first.
function sameToken(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// deps: { job, db, auth, registry, trusted, now, token, config }. token is the configured notify token
// (FORECAST_NOTIFY_TOKEN); it is read once and never logged or sent. registry gives the server names
// (left out, every event's server_name is its key).
function createForecastRouter({ job, db, auth, registry = null, trusted, now = Date.now, token, config = FORECAST_CONFIG }) {
  const router = express.Router();
  const enabled = typeof token === "string" && token.length >= config.internal.minTokenLength;

  // ---- Internal route. The checks run in this order: exists, rate limit, token.
  const notFound = (req, res) => res.status(404).json({ error: "not found" });
  const limit = rateLimit({
    windowMs: 60 * 1000,
    limit: config.internal.ratePerMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    keyGenerator: (req) => `forecast|${loginIpKey(clientIp(req, trusted))}`,
    handler: (req, res) => res.status(429).json({ error: "Too many requests, try again later" }),
  });
  router.get(
    "/internal/forecast/new",
    (req, res, next) => (enabled ? next() : notFound(req, res)),
    limit,
    (req, res, next) => {
      const given = req.headers["x-notify-token"];
      if (typeof given !== "string" || !sameToken(given, token)) return res.status(401).json({ error: "unauthorized" });
      next();
    },
    async (req, res) => {
      const since = parseIso(req.query.since);
      if (since === null) return res.status(400).json({ error: "since must be an ISO UTC time such as 2026-11-22T08:00:00Z" });
      // after_id: the id of the last row already read. Rows opened in one run share opened_at, so a
      // poller sends since = that row's opened_at and after_id = its id, and misses nothing.
      const rawAfter = req.query.after_id;
      if (rawAfter !== undefined && (typeof rawAfter !== "string" || !/^\d{1,18}$/.test(rawAfter))) {
        return res.status(400).json({ error: "after_id must be a whole number" });
      }
      try {
        const rows = await db.listNewForecastEvents(new Date(since), config.internal.maxRows, rawAfter === undefined ? null : rawAfter);
        // registry.load never throws; it is cached for 30 seconds and keeps the last good data.
        const snap = registry ? await registry.load() : null;
        const names = new Map(snap ? snap.servers.map((s) => [s.key, s.name]) : []);
        res.json({ events: rows.slice(0, config.internal.maxRows).map((row) => newOut(row, names)) });
      } catch (err) {
        res.status(502).json({ error: "the forecast history is unavailable" });
      }
    }
  );

  // ---- Signed-in routes.
  router.get("/forecast", auth.requireAuth, (req, res) => {
    const snap = job.snapshot();
    res.json({
      last_run_at: snap.last_run_at,
      containers: snap.containers.map(containerOut),
      disks: snap.disks.map(diskOut),
    });
  });

  router.get("/forecast/events", auth.requireAuth, async (req, res) => {
    const nowMs = now();
    const to = req.query.to === undefined ? nowMs : parseIso(req.query.to);
    const from = req.query.from === undefined ? (to ?? nowMs) - config.events.defaultHours * HOUR_MS : parseIso(req.query.from);
    if (from === null || to === null) return res.status(400).json({ error: "from and to must be ISO UTC times such as 2026-11-22T08:00:00Z" });
    if (to <= from) return res.status(400).json({ error: "to must be after from" });
    if (to - from > config.events.maxDays * DAY_MS) return res.status(400).json({ error: `the window may be at most ${config.events.maxDays} days` });
    try {
      // One more row than shown tells whether the answer was cut.
      const rows = await db.listForecastEvents(new Date(from), new Date(to), config.events.maxRows + 1);
      res.json({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        truncated: rows.length > config.events.maxRows,
        events: rows.slice(0, config.events.maxRows).map(eventOut),
      });
    } catch (err) {
      res.status(502).json({ error: "the forecast history is unavailable" });
    }
  });

  return router;
}

module.exports = { createForecastRouter, sameToken, parseIso };
