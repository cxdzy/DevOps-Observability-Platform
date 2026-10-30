// Tests for the security review fixes: trusted proxy, per-email limit, long emails, absolute session
// limit, re-login, cache headers, cookie names, DATABASE_URL check, and the user script rules.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const bcrypt = require("bcryptjs");
const { startApp } = require("./helpers");
const { hashToken } = require("../sessions");
const { cookieName, serializeCookie } = require("../cookies");
const { isValidDatabaseUrl } = require("../db");
const { passwordProblem } = require("../scripts/common");
const { createUserAccount, setUserPassword, disableUserAccount } = require("../scripts/actions");
const { createFakeDb } = require("./fake-db");

const HOUR = 60 * 60 * 1000;
const PASSWORD = "correct horse battery";

test("untrusted peer: spoofed CF-Connecting-IP and X-Forwarded-For are ignored and the limiter still counts", async (t) => {
  const app = await startApp({ trustLoopback: false });
  t.after(app.close);
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const { res } = await app.login("victim@example.com", "guess-" + i, {
      "cf-connecting-ip": `10.1.0.${i}`,
      "x-forwarded-for": `10.2.0.${i}`,
    });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  // The log shows the socket address, not the spoofed one.
  assert.ok(app.logs.every((l) => !l.includes("10.1.0.") && !l.includes("10.2.0.")));
  assert.ok(app.logs.some((l) => l.includes('"ip":"127.0.0.1"')));
});

test("trusted peer: CF-Connecting-IP is honoured as the client address", async (t) => {
  const app = await startApp(); // 127.0.0.1 plays cloudflared
  t.after(app.close);
  await app.login("someone@example.com", "bad", { "cf-connecting-ip": "203.0.113.9" });
  assert.ok(app.logs.some((l) => l.includes('"ip":"203.0.113.9"')));
  // Different client addresses have separate per-IP+email budgets.
  for (let i = 0; i < 5; i++) await app.login("other@example.com", "bad", { "cf-connecting-ip": "203.0.113.10" });
  assert.equal((await app.login("other@example.com", "bad", { "cf-connecting-ip": "203.0.113.10" })).res.status, 429);
  assert.equal((await app.login("other@example.com", "bad", { "cf-connecting-ip": "203.0.113.11" })).res.status, 401);
});

test("per-email limit: the 11th failure from rotating addresses is blocked, also for unknown emails", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.addUser("known@example.com", "viewer", PASSWORD);
  for (const email of ["known@example.com", "unknown@example.com"]) {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const { res } = await app.login(i % 2 ? email.toUpperCase() : email, "bad-" + i, { "cf-connecting-ip": `198.18.${email.length}.${i}` });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [...Array(10).fill(401), 429], email);
  }
  // While blocked, the correct password is refused too; the body is the shared 429 body.
  const blocked = await app.login("known@example.com", PASSWORD, { "cf-connecting-ip": "198.18.99.1" });
  assert.equal(blocked.res.status, 429);
  assert.deepEqual(await blocked.res.json(), { error: "Too many attempts, try again later" });
});

test("per-email limit does not count successful logins", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.addUser("ok@example.com", "viewer", PASSWORD);
  const ip = (i) => ({ "cf-connecting-ip": `198.19.0.${i}` });
  for (let i = 0; i < 9; i++) assert.equal((await app.login("ok@example.com", "bad", ip(i))).res.status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await app.login("ok@example.com", PASSWORD, ip(20 + i))).res.status, 200);
  // Ninth failure so far plus one more is the tenth: still allowed. The next one is blocked.
  assert.equal((await app.login("ok@example.com", "bad", ip(40))).res.status, 401);
  assert.equal((await app.login("ok@example.com", "bad", ip(41))).res.status, 429);
});

test("an email longer than 254 characters is refused before keying or bcrypt", async (t) => {
  const original = bcrypt.compare;
  let compares = 0;
  bcrypt.compare = async (...args) => {
    compares++;
    return original(...args);
  };
  t.after(() => {
    bcrypt.compare = original;
  });
  const app = await startApp({ trustLoopback: false });
  t.after(app.close);
  const long = "a".repeat(243) + "@example.com"; // 255 characters
  assert.equal(long.length, 255);
  // 40 attempts from one address: the per-IP limiter (30) would block them if they reached it.
  for (let i = 0; i < 40; i++) {
    const { res } = await app.login(long, "x");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Invalid email or password" });
  }
  assert.equal(compares, 0);
  // 254 characters is a normal attempt.
  const ok = "a".repeat(242) + "@example.com";
  await app.login(ok, "x");
  assert.equal(compares, 1);
});

test("absolute session limit: renewals stop at the cap and the session ends there", async (t) => {
  const app = await startApp({ config: { sessionMaxAgeMs: 24 * HOUR } });
  t.after(app.close);
  await app.addUser("long@example.com", "viewer", PASSWORD);
  const { cookie } = await app.login("long@example.com", PASSWORD, { "cf-connecting-ip": "198.20.0.1" });
  const id = hashToken(cookie.split("=")[1]);
  const start = app.clock.t;
  // Active every hour for 23 hours: the sliding expiry never goes past start + 24 h.
  for (let h = 1; h <= 23; h++) {
    app.clock.t = start + h * HOUR;
    assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 200, `hour ${h}`);
    assert.ok(app.db.sessions.get(id).expiresAt.getTime() <= start + 24 * HOUR);
  }
  assert.equal(app.db.sessions.get(id).expiresAt.getTime(), start + 24 * HOUR);
  app.clock.t = start + 24 * HOUR;
  assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 401);
  assert.equal(app.db.sessions.has(id), false);
});

test("a session older than the cap is refused even if its expiry says otherwise", async (t) => {
  const app = await startApp({ config: { sessionMaxAgeMs: 24 * HOUR } });
  t.after(app.close);
  await app.addUser("old@example.com", "viewer", PASSWORD);
  const { cookie } = await app.login("old@example.com", PASSWORD, { "cf-connecting-ip": "198.20.0.2" });
  const id = hashToken(cookie.split("=")[1]);
  const s = app.db.sessions.get(id);
  s.createdAt = new Date(app.clock.t - 25 * HOUR); // created long ago
  s.expiresAt = new Date(app.clock.t + 7 * HOUR); // but the expiry was pushed forward
  assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 401);
  assert.equal(app.db.sessions.has(id), false);
});

test("logging in again deletes the session the browser already had", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.addUser("re@example.com", "viewer", PASSWORD);
  const first = await app.login("re@example.com", PASSWORD, { "cf-connecting-ip": "198.20.0.3" });
  const second = await app.login("re@example.com", PASSWORD, { cookie: first.cookie, "cf-connecting-ip": "198.20.0.3" });
  assert.notEqual(second.cookie, first.cookie);
  assert.equal(app.db.sessions.size, 1);
  assert.equal(app.db.sessions.has(hashToken(first.cookie.split("=")[1])), false);
  assert.equal((await app.request("/auth/me", { headers: { cookie: first.cookie } })).status, 401);
  assert.equal((await app.request("/auth/me", { headers: { cookie: second.cookie } })).status, 200);
});

test("Cache-Control: no-store on every /api and /auth response", async (t) => {
  const app = await startApp({ query: async () => [] });
  t.after(app.close);
  await app.addUser("cc@example.com", "viewer", PASSWORD);
  const { res: loginRes, cookie } = await app.login("cc@example.com", PASSWORD, { "cf-connecting-ip": "198.20.0.4" });
  const responses = [
    loginRes,
    await app.request("/api/health"),
    await app.request("/api/anomaly"),
    await app.request("/api/anomaly", { headers: { cookie } }),
    await app.request("/api/nope", { headers: { cookie } }),
    await app.request("/auth/me", { headers: { cookie } }),
    await app.request("/auth/me"),
    await app.request("/auth/config"),
    await app.request("/auth/google"),
    await app.login("cc@example.com", "bad", { "cf-connecting-ip": "198.20.0.5" }).then((r) => r.res),
    await app.request("/auth/logout", { json: {}, headers: { cookie } }),
  ];
  for (const r of responses) assert.equal(r.headers.get("cache-control"), "no-store", r.url);
});

test("static files: hashed assets cached for a year, the page revalidated", async (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "dash-dist-"));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>t</title>");
  fs.writeFileSync(path.join(dist, "assets", "index-abc123.js"), "console.log(1)");
  const app = await startApp({ config: { clientDist: dist } });
  t.after(app.close);
  const asset = await app.request("/assets/index-abc123.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  for (const p of ["/", "/index.html", "/some/page"]) {
    const page = await app.request(p);
    assert.equal(page.status, 200, p);
    assert.equal(page.headers.get("cache-control"), "no-cache", p);
  }
  assert.equal((await app.request("/assets/missing.js")).status, 404);
});

test("cookie names: __Host- prefix exactly when cookies are Secure", async (t) => {
  assert.equal(cookieName("dash_session", true), "__Host-dash_session");
  assert.equal(cookieName("dash_session", false), "dash_session");
  assert.throws(() => serializeCookie("__Host-x", "v", { secure: false }), /Secure/);
  assert.throws(() => serializeCookie("__Host-x", "v", { secure: true, path: "/auth" }), /Path/);
  assert.match(serializeCookie("__Host-x", "v", { secure: true }), /^__Host-x=v; Path=\/;.*; Secure/);

  const secure = await startApp({ config: { cookieSecure: true } });
  t.after(secure.close);
  await secure.addUser("h@example.com", "viewer", PASSWORD);
  const { res, cookie } = await secure.login("h@example.com", PASSWORD, { "cf-connecting-ip": "198.20.0.6" });
  const set = res.headers.getSetCookie().find((c) => c.startsWith("__Host-dash_session="));
  assert.match(set, /; Path=\/;/);
  assert.match(set, /; Secure/);
  assert.doesNotMatch(set, /Domain=/i);
  assert.equal((await secure.request("/auth/me", { headers: { cookie } })).status, 200);
  // The unprefixed name is not read when Secure cookies are on.
  const plain = cookie.replace("__Host-", "");
  assert.equal((await secure.request("/auth/me", { headers: { cookie: plain } })).status, 401);
  const out = await secure.request("/auth/logout", { json: {}, headers: { cookie } });
  assert.ok(out.headers.getSetCookie().some((c) => c.startsWith("__Host-dash_session=;") && /Max-Age=0/.test(c)));
  assert.equal(secure.db.sessions.size, 0);

  const plainApp = await startApp({ config: { cookieSecure: false } });
  t.after(plainApp.close);
  await plainApp.addUser("p@example.com", "viewer", PASSWORD);
  const p = await plainApp.login("p@example.com", PASSWORD, { "cf-connecting-ip": "198.20.0.7" });
  const pset = p.res.headers.getSetCookie().find((c) => c.startsWith("dash_session="));
  assert.ok(pset);
  assert.doesNotMatch(pset, /Secure/);
});

test("DATABASE_URL check accepts normal URLs and rejects ones pg cannot parse", () => {
  assert.equal(isValidDatabaseUrl("postgres://dashboard:abc123@postgres:5432/dashboard"), true);
  assert.equal(isValidDatabaseUrl("postgresql://dashboard:abc%23123@postgres:5432/dashboard"), true);
  for (const bad of ["", undefined, "postgres://dashboard:S3cr#t/pw@postgres:5432/dashboard", "postgres://dashboard:ab%zz@postgres:5432/dashboard", "mysql://u:p@h/db", "not a url"]) {
    assert.equal(isValidDatabaseUrl(bad), false, String(bad));
  }
});

test("an invalid DATABASE_URL stops the server with a clear message and never prints the value", () => {
  for (const url of ["postgres://dashboard:S3cr#t/pw@postgres:5432/dashboard", "postgres://dashboard:ab%zzSECRET@postgres:5432/dashboard"]) {
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "index.js")], {
      env: { ...process.env, DATABASE_URL: url, PORT: "0" },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), "DATABASE_URL is not a valid URL, check DASHBOARD_DB_PASSWORD");
    assert.ok(!(r.stdout + r.stderr).includes("S3cr") && !(r.stdout + r.stderr).includes("SECRET"));
  }
});

test("script password rules: at least 12 characters, at most 72 bytes", () => {
  assert.match(passwordProblem("a".repeat(11)), /at least 12/);
  assert.equal(passwordProblem("a".repeat(12)), null);
  assert.equal(passwordProblem("a".repeat(72)), null);
  assert.match(passwordProblem("a".repeat(73)), /at most 72 bytes/);
  // Bytes, not characters: 36 two-byte characters fit, 37 do not.
  assert.equal(passwordProblem("é".repeat(36)), null);
  assert.match(passwordProblem("é".repeat(37)), /at most 72 bytes/);
});

test("set-password and disable-user end the user's sessions and leave others alone", async () => {
  const db = createFakeDb();
  await createUserAccount(db, { email: "a@example.com", role: "viewer", passwordHash: "h" });
  await createUserAccount(db, { email: "b@example.com", role: "viewer", passwordHash: "h" });
  await assert.rejects(createUserAccount(db, { email: "a@example.com", role: "viewer", passwordHash: null }), /already exists/);
  const [a, b] = db.users;
  const add = (id, user) => db.createSession({ idHash: id, userId: user.id, createdAt: new Date(), expiresAt: new Date(Date.now() + HOUR) });
  await add("a1", a);
  await add("a2", a);
  await add("b1", b);

  const msg = await setUserPassword(db, "a@example.com", "new-hash");
  assert.match(msg, /sessions were ended/);
  assert.equal(db.users[0].password_hash, "new-hash");
  assert.deepEqual([...db.sessions.keys()], ["b1"]);

  await disableUserAccount(db, "b@example.com");
  assert.equal(db.users[1].disabled, true);
  assert.equal(db.sessions.size, 0);

  await assert.rejects(setUserPassword(db, "nobody@example.com", "x"), /No user/);
  await assert.rejects(disableUserAccount(db, "nobody@example.com"), /No user/);
});
