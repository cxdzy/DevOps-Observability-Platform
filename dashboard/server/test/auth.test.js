const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { hashToken } = require("../sessions");
const { createAuth } = require("../auth");

const HOUR = 60 * 60 * 1000;
const PASSWORD = "correct horse battery";

// Each test uses its own client IP so the rate limits of one test do not affect another.
let ipCounter = 10;
const ipHeader = () => ({ "cf-connecting-ip": `198.51.100.${ipCounter++}` });

test("successful login sets an httpOnly SameSite=Lax session cookie and /auth/me works", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.addUser("alice@example.com", "viewer", PASSWORD);
  const { res, cookie } = await app.login("  Alice@Example.com ", PASSWORD, ipHeader());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: "alice@example.com", role: "viewer" });
  const set = res.headers.getSetCookie().find((c) => c.startsWith("dash_session="));
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Path=\//);
  assert.match(set, /Max-Age=28800/);
  assert.doesNotMatch(set, /Secure/); // COOKIE_SECURE=false in tests

  // Only the hash of the token is stored.
  const token = cookie.split("=")[1];
  assert.ok(app.db.sessions.has(hashToken(token)));
  assert.ok(!app.db.sessions.has(token));

  const me = await app.request("/auth/me", { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { email: "alice@example.com", role: "viewer" });
});

test("unknown email, wrong password, disabled user and user without password get identical responses", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.addUser("bob@example.com", "viewer", PASSWORD);
  await app.addUser("dis@example.com", "viewer", PASSWORD, { disabled: true });
  await app.addUser("google@example.com", "viewer", null);
  const cases = [
    ["nobody@example.com", PASSWORD],
    ["bob@example.com", "wrong password here"],
    ["dis@example.com", PASSWORD],
    ["google@example.com", ""],
    ["google@example.com", "anything at all"],
  ];
  const results = [];
  for (const [email, password] of cases) {
    const { res, cookie } = await app.login(email, password, ipHeader());
    results.push({ status: res.status, body: await res.text(), cookie, type: res.headers.get("content-type") });
  }
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.equal(results[0].status, 401);
  assert.equal(results[0].body, JSON.stringify({ error: "Invalid email or password" }));
  assert.equal(results[0].cookie, null);
  assert.equal(app.db.sessions.size, 0);
});

test("every failed login path runs exactly one bcrypt compare", async (t) => {
  const bcrypt = require("bcryptjs");
  const original = bcrypt.compare;
  let calls = 0;
  bcrypt.compare = async (...args) => {
    calls++;
    return original(...args);
  };
  t.after(() => {
    bcrypt.compare = original;
  });
  const app = await startApp();
  t.after(app.close);
  await app.addUser("carol@example.com", "viewer", PASSWORD);
  await app.addUser("nopw@example.com", "viewer", null);
  for (const [email, password] of [["unknown@example.com", "x"], ["carol@example.com", "bad"], ["nopw@example.com", "x"], ["", ""]]) {
    calls = 0;
    await app.login(email, password, ipHeader());
    assert.equal(calls, 1, email);
  }
});

test("failed logins are logged without the password or the full email", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.login("secretname@example.com", "my-secret-password", ipHeader());
  const line = app.logs.find((l) => l.includes("login_failed"));
  assert.ok(line);
  assert.ok(line.includes("se***@example.com"));
  assert.ok(!line.includes("secretname"));
  assert.ok(!line.includes("my-secret-password"));
});

test("login and logout need JSON and the exact Origin", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.addUser("dave@example.com", "viewer", PASSWORD);
  const form = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:3100", ...ipHeader() },
    body: "email=dave@example.com&password=x",
  });
  assert.equal(form.status, 415);
  const wrongOrigin = await app.request("/auth/login", { json: { email: "dave@example.com", password: PASSWORD }, headers: { origin: "http://evil.example", ...ipHeader() } });
  assert.equal(wrongOrigin.status, 403);
  const noOrigin = await app.request("/auth/login", { json: { email: "dave@example.com", password: PASSWORD }, headers: { origin: "", ...ipHeader() } });
  assert.equal(noOrigin.status, 403);
  const get = await app.request("/auth/login");
  assert.equal(get.status, 404);
  const badJson = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3100", ...ipHeader() }, body: "{" });
  assert.equal(badJson.status, 400);

  const { cookie } = await app.login("dave@example.com", PASSWORD, ipHeader());
  const logoutWrongOrigin = await app.request("/auth/logout", { json: {}, headers: { cookie, origin: "http://evil.example" } });
  assert.equal(logoutWrongOrigin.status, 403);
  assert.equal(app.db.sessions.size, 1);
});

test("logout deletes the session row and clears the cookie", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.addUser("erin@example.com", "admin", PASSWORD);
  const { cookie } = await app.login("erin@example.com", PASSWORD, ipHeader());
  const out = await app.request("/auth/logout", { json: {}, headers: { cookie } });
  assert.equal(out.status, 204);
  assert.ok(out.headers.getSetCookie().some((c) => c.startsWith("dash_session=;") && /Max-Age=0/.test(c)));
  assert.equal(app.db.sessions.size, 0);
  assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 401);
});

test("5 attempts per minute per IP and email, then 429", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const ip = ipHeader();
  for (let i = 0; i < 5; i++) assert.equal((await app.login("frank@example.com", "bad", ip)).res.status, 401);
  const blocked = await app.login("FRANK@example.com", "bad", ip);
  assert.equal(blocked.res.status, 429);
  assert.deepEqual(await blocked.res.json(), { error: "Too many attempts, try again later" });
  // Another email from the same IP is still allowed.
  assert.equal((await app.login("other@example.com", "bad", ip)).res.status, 401);
});

test("30 attempts per 10 minutes per IP, then 429", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const ip = ipHeader();
  for (let i = 0; i < 30; i++) {
    const { res } = await app.login(`user${i}@example.com`, "bad", ip);
    assert.equal(res.status, 401, `attempt ${i + 1}`);
  }
  assert.equal((await app.login("fresh@example.com", "bad", ip)).res.status, 429);
});

test("/api needs a session except /api/health", async (t) => {
  const app = await startApp({ query: async () => [{ time: 1, score: 0.5 }] });
  t.after(app.close);
  assert.equal((await app.request("/api/health")).status, 200);
  for (const p of ["/api/anomaly", "/api/incidents", "/api/anomaly/latest", "/api/nope"]) {
    assert.equal((await app.request(p)).status, 401, p);
  }
  assert.equal((await app.request("/auth/me")).status, 401);
  await app.addUser("gina@example.com", "viewer", PASSWORD);
  const { cookie } = await app.login("gina@example.com", PASSWORD, ipHeader());
  const ok = await app.request("/api/anomaly?hours=1", { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), [{ time: 1, score: 0.5 }]);
});

test("expired sessions are rejected and deleted; sliding renewal at most once per hour", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.addUser("hank@example.com", "viewer", PASSWORD);
  const { cookie } = await app.login("hank@example.com", PASSWORD, ipHeader());
  const id = hashToken(cookie.split("=")[1]);
  const start = app.clock.t;
  const expiry = () => app.db.sessions.get(id).expiresAt.getTime();

  app.clock.t = start + 30 * 60 * 1000;
  const early = await app.request("/auth/me", { headers: { cookie } });
  assert.equal(early.status, 200);
  assert.equal(expiry(), start + 8 * HOUR);
  assert.ok(!early.headers.getSetCookie().some((c) => c.startsWith("dash_session=")));

  app.clock.t = start + HOUR;
  const renewed = await app.request("/auth/me", { headers: { cookie } });
  assert.equal(renewed.status, 200);
  assert.equal(expiry(), start + 9 * HOUR);
  assert.ok(renewed.headers.getSetCookie().some((c) => c.startsWith("dash_session=") && /Max-Age=28800/.test(c)));

  app.clock.t = start + 9 * HOUR;
  assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 401);
  assert.equal(app.db.sessions.has(id), false);
});

test("a disabled user's existing session stops working", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const user = await app.addUser("ivy@example.com", "viewer", PASSWORD);
  const { cookie } = await app.login("ivy@example.com", PASSWORD, ipHeader());
  await app.db.disableUser(user.id);
  assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 401);
  assert.equal(app.db.sessions.size, 0);
});

test("a forged or malformed session cookie is rejected", async (t) => {
  const app = await startApp();
  t.after(app.close);
  for (const cookie of ["dash_session=" + "a".repeat(64), "dash_session=xyz", "dash_session="]) {
    assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 401);
  }
});

test("requireRole('admin') lets admins through and blocks viewers", async () => {
  const auth = createAuth({ db: {}, appOrigin: "x", cookieSecure: false, trustProxy: false });
  const run = (user) => {
    let status = null;
    let passed = false;
    const res = { status: (s) => ((status = s), { json: () => {} }) };
    auth.requireRole("admin")({ user }, res, () => {
      passed = true;
    });
    return { status, passed };
  };
  assert.deepEqual(run({ role: "admin" }), { status: null, passed: true });
  assert.deepEqual(run({ role: "viewer" }), { status: 403, passed: false });
  assert.deepEqual(run(undefined), { status: 403, passed: false });
});

test("security headers: CSP allows only self, no X-Powered-By", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const res = await app.request("/api/health");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /connect-src 'self'(;|$)/);
  assert.match(csp, /img-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /https:|unsafe-eval|unsafe-inline|\*/);
  assert.match(csp, /style-src 'self' 'sha256-[^']+' 'sha256-[^']+'(;|$)/);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("HSTS and upgrade-insecure-requests only for an https APP_ORIGIN, whatever COOKIE_SECURE says", async (t) => {
  for (const [appOrigin, cookieSecure, https] of [
    ["http://localhost:3100", true, false],
    ["http://localhost:3100", false, false],
    ["https://dash.example.com", true, true],
  ]) {
    const app = await startApp({ config: { appOrigin, cookieSecure } });
    t.after(app.close);
    const res = await app.request("/api/health");
    assert.equal(res.headers.get("strict-transport-security") !== null, https, appOrigin);
    assert.equal(/upgrade-insecure-requests/.test(res.headers.get("content-security-policy")), https, appOrigin);
  }
});
