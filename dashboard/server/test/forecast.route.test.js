// GET /api/forecast, GET /api/forecast/events and the internal GET /api/internal/forecast/new.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { sameToken } = require("../routes/forecast");

const PASSWORD = "a long enough password";
const TOKEN = "t".repeat(20) + "0123456789abcdefghij";
const MIB = 1024 * 1024;

// A job stand-in with a fixed snapshot.
function fakeJob(snap) {
  return { snapshot: () => snap, start() {}, stop() {}, tick: async () => {}, allowed: () => [] };
}
const SNAP = {
  last_run_at: "2026-11-22T08:00:00.000Z",
  containers: [
    {
      server: "old",
      server_name: "staging",
      project: "bot",
      container: "kotone-bot",
      state: "warning",
      reason: "trend",
      est_minutes: 41.234,
      limit_bytes: 400 * MIB,
      level_bytes: 350 * MIB,
      slope_bytes_per_min: 1.2 * MIB,
      r2: 0.98765,
      restarts: 0,
      oom: false,
      since: "2026-11-22T07:50:00.000Z",
      updated_at: "2026-11-22T08:00:00.000Z",
    },
    {
      server: "main",
      server_name: "fyp-main",
      project: "sample-service",
      container: "sample-service",
      state: "no_limit",
      reason: "no_limit",
      est_minutes: null,
      limit_bytes: null,
      level_bytes: 180 * MIB,
      slope_bytes_per_min: null,
      r2: null,
      restarts: 0,
      oom: false,
      since: null,
      updated_at: "2026-11-22T08:00:00.000Z",
    },
  ],
  disks: [
    { server: "main", server_name: "fyp-main", mountpoint: "/", state: "ok", reason: "far", est_minutes: null, used_pct: 45.06, size_bytes: 100, slope_pct_per_hour: 0.0123, r2: 0.2, since: null, updated_at: "2026-11-22T08:00:00.000Z" },
  ],
};

async function signedIn(options = {}) {
  const app = await startApp({ forecastJob: fakeJob(SNAP), ...options });
  await app.addUser("viewer@example.com", "viewer", PASSWORD);
  const { cookie } = await app.login("viewer@example.com", PASSWORD);
  return { app, get: (p, headers = {}) => app.request(p, { headers: { cookie, ...headers } }) };
}

async function addEvents(db, n, firstMs) {
  for (let i = 0; i < n; i++) {
    await db.insertForecastEvent({
      resource: "memory",
      server: "old",
      project: "bot",
      container: `c${i}`,
      mountpoint: null,
      openedAt: new Date(firstMs + i * 60000),
      estMinutes: 40 + i,
      limitValue: 400 * MIB,
      level: 350 * MIB,
      slope: MIB,
      r2: 0.95,
      windowMin: 30,
      configVersion: "test",
    });
  }
}

test("GET /api/forecast needs a session", async (t) => {
  const app = await startApp({ forecastJob: fakeJob(SNAP) });
  t.after(app.close);
  const res = await app.request("/api/forecast");
  assert.equal(res.status, 401);
  assert.equal((await app.request("/api/forecast/events")).status, 401);
});

test("GET /api/forecast returns the documented shape, in MB, with null for missing values", async (t) => {
  const { app, get } = await signedIn();
  t.after(app.close);
  const res = await get("/api/forecast");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.last_run_at, SNAP.last_run_at);
  const [bot, sample] = body.containers;
  assert.deepEqual(Object.keys(bot).sort(), [
    "container", "est_minutes", "level_mb", "limit_mb", "oom", "project", "r2", "reason", "restarts", "server", "server_name", "since", "slope_mb_per_min", "state", "updated_at",
  ]);
  assert.equal(bot.state, "warning");
  assert.equal(bot.est_minutes, 41.2);
  assert.equal(bot.limit_mb, 400);
  assert.equal(bot.level_mb, 350);
  assert.equal(bot.slope_mb_per_min, 1.2);
  assert.equal(bot.r2, 0.988);
  assert.equal(bot.since, "2026-11-22T07:50:00.000Z");
  assert.equal(sample.state, "no_limit");
  for (const k of ["est_minutes", "limit_mb", "slope_mb_per_min", "r2", "since"]) assert.equal(sample[k], null, k);
  assert.equal(sample.level_mb, 180);
  const [disk] = body.disks;
  assert.deepEqual(Object.keys(disk).sort(), ["est_hours", "mountpoint", "r2", "reason", "server", "server_name", "since", "slope_pct_per_hour", "state", "updated_at", "used_pct"]);
  assert.equal(disk.est_hours, null);
  assert.equal(disk.used_pct, 45.1);
});

test("GET /api/forecast before the first run is empty, not invented", async (t) => {
  const { app, get } = await signedIn({ forecastJob: fakeJob({ last_run_at: null, containers: [], disks: [] }) });
  t.after(app.close);
  assert.deepEqual(await (await get("/api/forecast")).json(), { last_run_at: null, containers: [], disks: [] });
});

test("GET /api/forecast/events lists warnings in the window and checks its parameters", async (t) => {
  const { app, get } = await signedIn();
  t.after(app.close);
  await addEvents(app.db, 3, Date.UTC(2026, 10, 22, 6, 0, 0));
  const res = await get("/api/forecast/events?from=2026-11-22T06:00:30Z&to=2026-11-22T07:00:00Z");
  assert.equal(res.status, 200);
  const body = await res.json();
  // Rows that are still open count from the time they opened.
  assert.equal(body.events.length, 3);
  assert.equal(body.events[0].container, "c0");
  assert.equal(body.events[0].config_version, "test");
  assert.equal((await get("/api/forecast/events?from=yesterday")).status, 400);
  assert.equal((await get("/api/forecast/events?from=2026-11-22T07:00:00Z&to=2026-11-22T06:00:00Z")).status, 400);
  assert.equal((await get("/api/forecast/events?from=2026-09-01T00:00:00Z&to=2026-11-22T06:00:00Z")).status, 400);
  const late = await (await get("/api/forecast/events?from=2026-11-22T05:00:00Z&to=2026-11-22T06:00:30Z")).json();
  assert.equal(late.events.length, 1);
});

test("the internal route is 404 when the token is unset or shorter than 32 characters", async (t) => {
  for (const forecastToken of ["", "short-token", "x".repeat(31)]) {
    const app = await startApp({ forecastJob: fakeJob(SNAP), forecastToken });
    t.after(app.close);
    const res = await app.request("/api/internal/forecast/new?since=2026-11-22T00:00:00Z", { headers: { "x-notify-token": forecastToken || "anything" } });
    assert.equal(res.status, 404, `token of length ${forecastToken.length}`);
    // The same answer as a path under /api that does not exist.
    assert.deepEqual(await res.json(), { error: "not found" });
  }
});

test("the internal route is 401 for a missing or wrong token, with the same body", async (t) => {
  const app = await startApp({ forecastJob: fakeJob(SNAP), forecastToken: TOKEN });
  t.after(app.close);
  const url = "/api/internal/forecast/new?since=2026-11-22T00:00:00Z";
  const missing = await app.request(url);
  const wrong = await app.request(url, { headers: { "x-notify-token": TOKEN.slice(0, -1) + "X" } });
  const short = await app.request(url, { headers: { "x-notify-token": "abc" } });
  for (const res of [missing, wrong, short]) {
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  }
  // A session cookie is not a way in.
  await app.addUser("admin@example.com", "admin", PASSWORD);
  const { cookie } = await app.login("admin@example.com", PASSWORD);
  assert.equal((await app.request(url, { headers: { cookie } })).status, 401);
});

test("the internal route answers with the right token, no session, at most 20 rows opened after since", async (t) => {
  const app = await startApp({ forecastJob: fakeJob(SNAP), forecastToken: TOKEN });
  t.after(app.close);
  const first = Date.UTC(2026, 10, 22, 6, 0, 0);
  await addEvents(app.db, 25, first);
  const headers = { "x-notify-token": TOKEN };
  const res = await app.request("/api/internal/forecast/new?since=2026-11-22T06:00:00Z", { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  // The row opened exactly at since is not after it.
  assert.equal(body.events.length, 20);
  assert.equal(body.events[0].container, "c1");
  assert.equal(body.events[19].container, "c20");
  assert.deepEqual(Object.keys(body.events[0]).sort(), [
    "container", "est_minutes_at_open", "id", "level_at_open", "limit_value", "mountpoint", "opened_at", "project", "resource", "server", "slope_per_min",
  ]);
  const later = await (await app.request("/api/internal/forecast/new?since=2026-11-22T06:22:00Z", { headers })).json();
  assert.deepEqual(later.events.map((e) => e.container), ["c23", "c24"]);
  assert.equal((await app.request("/api/internal/forecast/new?since=today", { headers })).status, 400);
  assert.equal((await app.request("/api/internal/forecast/new", { headers })).status, 400);
  // Nothing was written by reading.
  assert.equal(app.db.forecastEvents.length, 25);
  // No log line holds the token, whatever was asked.
  assert.ok(app.logs.every((l) => !String(l).includes(TOKEN)));
});

test("the internal route is rate limited at about 60 requests a minute", async (t) => {
  const app = await startApp({ forecastJob: fakeJob(SNAP), forecastToken: TOKEN });
  t.after(app.close);
  const statuses = [];
  for (let i = 0; i < 62; i++) statuses.push((await app.request("/api/internal/forecast/new?since=2026-11-22T06:00:00Z", { headers: { "x-notify-token": "wrong" } })).status);
  assert.equal(statuses.filter((s) => s === 401).length, 60);
  assert.equal(statuses[61], 429);
  assert.ok(app.logs.every((l) => !String(l).includes(TOKEN)));
});

test("the token comparison works for any length", () => {
  assert.equal(sameToken(TOKEN, TOKEN), true);
  assert.equal(sameToken("", TOKEN), false);
  assert.equal(sameToken(TOKEN + "x", TOKEN), false);
});

test("after_id pages through warnings that share one opened_at, so none is skipped", async (t) => {
  const app = await startApp({ forecastJob: fakeJob(SNAP), forecastToken: TOKEN });
  t.after(app.close);
  const at = Date.UTC(2026, 10, 22, 6, 0, 0);
  for (let i = 0; i < 25; i++) {
    await app.db.insertForecastEvent({ resource: "memory", server: "old", project: "bot", container: `c${i}`, mountpoint: null, openedAt: new Date(at), estMinutes: 40, configVersion: "test" });
  }
  const headers = { "x-notify-token": TOKEN };
  const first = await (await app.request("/api/internal/forecast/new?since=2026-11-22T05:59:00Z", { headers })).json();
  assert.equal(first.events.length, 20);
  const last = first.events[19];
  const next = await (await app.request(`/api/internal/forecast/new?since=${encodeURIComponent(last.opened_at)}&after_id=${last.id}`, { headers })).json();
  assert.deepEqual(next.events.map((e) => e.container), ["c20", "c21", "c22", "c23", "c24"]);
  assert.equal((await app.request("/api/internal/forecast/new?since=2026-11-22T05:59:00Z&after_id=x1", { headers })).status, 400);
});

test("GET /api/forecast/events says when it cut the answer", async (t) => {
  const { app, get } = await signedIn();
  t.after(app.close);
  await addEvents(app.db, 2, Date.UTC(2026, 10, 22, 6, 0, 0));
  const body = await (await get("/api/forecast/events?from=2026-11-22T05:00:00Z&to=2026-11-22T07:00:00Z")).json();
  assert.equal(body.truncated, false);
});
