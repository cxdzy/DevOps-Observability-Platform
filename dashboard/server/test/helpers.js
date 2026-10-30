// Starts the app on a random port with a fake database, fake InfluxDB query and a controllable clock.
const bcrypt = require("bcryptjs");
const { createApp } = require("../app");
const { createFakeDb } = require("./fake-db");

const ORIGIN = "http://localhost:3100";

async function startApp(options = {}) {
  const db = options.db || createFakeDb();
  const clock = { t: Date.UTC(2026, 9, 30, 8, 0, 0) };
  const logs = [];
  const { app } = createApp({
    db,
    query: options.query || (async () => []),
    influxUrl: "http://127.0.0.1:1",
    now: () => clock.t,
    log: (line) => logs.push(line),
    oidc: options.oidc,
    // By default the test client (127.0.0.1) plays the trusted proxy, so tests can choose the client
    // address with CF-Connecting-IP. trustLoopback: false makes it an untrusted direct caller.
    trusted: { has: (ip) => options.trustLoopback !== false && ip === "127.0.0.1" },
    config: {
      appOrigin: ORIGIN,
      cookieSecure: false,
      googleClientId: options.googleClientId || "",
      googleClientSecret: "",
      clientDist: null,
      bcryptCost: 4,
      ...options.config,
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(path, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      if (headers.origin === undefined) headers.origin = ORIGIN;
    }
    return fetch(base + path, {
      method: init.method || (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      redirect: "manual",
    });
  }

  async function addUser(email, role, password, extra = {}) {
    const passwordHash = password ? await bcrypt.hash(password, 4) : null;
    return db.createUser({ email, role, passwordHash, ...extra });
  }

  // Returns the session cookie pair ("dash_session=...") from a response, or null.
  function sessionCookie(res) {
    const all = res.headers.getSetCookie();
    const c = all.find((x) => /^(__Host-)?dash_session=[0-9a-f]/.test(x));
    return c ? c.split(";")[0] : null;
  }

  async function login(email, password, headers = {}) {
    const res = await request("/auth/login", { json: { email, password }, headers });
    return { res, cookie: sessionCookie(res) };
  }

  return {
    db,
    clock,
    logs,
    base,
    request,
    addUser,
    login,
    sessionCookie,
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { startApp, ORIGIN };
