// Starts the app on a random port with a fake database, fake InfluxDB query and a controllable clock.
const bcrypt = require("bcryptjs");
const { createApp } = require("../app");
const { createFakeDb } = require("./fake-db");

const ORIGIN = "http://localhost:3100";

// Ports that fetch refuses with "bad port": the "bad port" list of the Fetch standard, which undici
// uses. undici does not export it, so it is copied here. listen(0) can land on one of them now and
// then (6000, 6665 to 6669 and 10080 are inside common dynamic port ranges).
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const LISTEN_ATTEMPTS = 10;

// Listens on a random port that fetch can reach: on a blocked port it closes and listens again,
// up to LISTEN_ATTEMPTS times.
async function listenOnFetchablePort(app) {
  for (let attempt = 1; ; attempt++) {
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    if (!FETCH_BLOCKED_PORTS.has(server.address().port)) return server;
    await new Promise((resolve) => server.close(resolve));
    if (attempt >= LISTEN_ATTEMPTS) throw new Error(`listen(0) gave a port fetch blocks ${LISTEN_ATTEMPTS} times`);
  }
}

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
      // No langfuse pool unless a test passes one, so tests never build a pool from the real environment.
      llmPool: null,
      ...options.config,
    },
  });
  const server = await listenOnFetchablePort(app);
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
