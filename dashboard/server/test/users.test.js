// User management (Settings, Users), the own account routes and the must change password gate.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startApp } = require("./helpers");
const { temporaryPassword, passwordProblem } = require("../passwords");
const { createUserAccount, setUserPassword, disableUserAccount } = require("../scripts/actions");

const PASSWORD = "a long enough password";
const NEW_PASSWORD = "another long password";
const TOKEN = "t".repeat(40);
const forecastJob = { snapshot: () => ({ last_run_at: null, containers: [], disks: [] }), start() {}, stop() {} };

// An app with a signed-in admin (admin@example.com) and helpers that send that admin's cookie.
async function setup(t, options = {}) {
  const app = await startApp({ forecastJob, ...options });
  t.after(app.close);
  const admin = await app.addUser("admin@example.com", "admin", PASSWORD);
  const { cookie } = await app.login("admin@example.com", PASSWORD);
  return { app, admin, cookie, ...as(app, cookie) };
}

function as(app, cookie) {
  const headers = cookie ? { cookie } : {};
  return {
    get: (p) => app.request(p, { headers }),
    post: (p, json = {}, extra = {}) => app.request(p, { method: "POST", json, headers: { ...headers, ...extra } }),
  };
}

async function signIn(app, email, password) {
  const { res, cookie } = await app.login(email, password);
  assert.equal(res.status, 200, `sign-in of ${email}`);
  return { cookie, body: await res.json(), ...as(app, cookie) };
}

async function addUser(s, body) {
  const res = await s.post("/api/settings/users", body);
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}

function sessionsOf(app, id) {
  return [...app.db.sessions.values()].filter((x) => x.userId === String(id)).length;
}

function logRows(app) {
  return app.db.registry.log.filter((r) => r.user_email !== "system");
}

test("the temporary password is random letters and digits, at least 16 characters", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const p = temporaryPassword();
    assert.match(p, /^[A-Za-z0-9]{20}$/);
    assert.equal(passwordProblem(p), null);
    seen.add(p);
  }
  assert.equal(seen.size, 50);
  assert.equal(temporaryPassword(16).length, 16);
  assert.throws(() => temporaryPassword(15));
});

test("every users route is admin only: 401 without a session, 403 for a viewer", async (t) => {
  const s = await setup(t);
  await s.app.addUser("viewer@example.com", "viewer", PASSWORD);
  const viewer = await signIn(s.app, "viewer@example.com", PASSWORD);
  const anon = as(s.app, null);
  const routes = [
    ["GET", "/api/settings/users"],
    ["POST", "/api/settings/users"],
    ["POST", `/api/settings/users/${s.admin.id}/role`],
    ["POST", `/api/settings/users/${s.admin.id}/disable`],
    ["POST", `/api/settings/users/${s.admin.id}/enable`],
    ["POST", `/api/settings/users/${s.admin.id}/reset-password`],
    ["POST", `/api/settings/users/${s.admin.id}/sign-out`],
  ];
  for (const [method, path] of routes) {
    const body = { email: "x@example.com", role: "admin", method: "google", confirm: PASSWORD };
    const v = method === "GET" ? await viewer.get(path) : await viewer.post(path, body);
    assert.equal(v.status, 403, `viewer ${method} ${path}`);
    const a = method === "GET" ? await anon.get(path) : await anon.post(path, body);
    assert.equal(a.status, 401, `anonymous ${method} ${path}`);
  }
  // Nothing changed.
  assert.equal(s.app.db.users.length, 2);
  assert.equal(s.app.db.users.find((u) => u.id === String(s.admin.id)).role, "admin");
});

test("writes need the exact Origin and JSON", async (t) => {
  const s = await setup(t);
  const bad = await s.post("/api/settings/users", { email: "v@example.com", role: "viewer", method: "google" }, { origin: "https://evil.example" });
  assert.equal(bad.status, 403);
  const none = await s.app.request("/api/settings/users", { method: "POST", headers: { cookie: s.cookie, "content-type": "application/json" }, body: "{}" });
  assert.equal(none.status, 403);
  const text = await s.app.request("/api/settings/users", { method: "POST", headers: { cookie: s.cookie, origin: "http://localhost:3100", "content-type": "text/plain" }, body: "x" });
  assert.equal(text.status, 415);
  const pw = await s.post("/api/account/password", { current_password: PASSWORD, new_password: NEW_PASSWORD }, { origin: "https://evil.example" });
  assert.equal(pw.status, 403);
  assert.equal(s.app.db.users.length, 1);
});

test("an admin adds a viewer with Google only and a viewer with a temporary password", async (t) => {
  const s = await setup(t);
  const google = await addUser(s, { email: " Grace@Example.com ", role: "viewer", method: "google" });
  assert.equal(google.temporary_password, null);
  assert.deepEqual(
    { email: google.user.email, role: google.user.role, method: google.user.method, status: google.user.status, must: google.user.must_change_password },
    { email: "grace@example.com", role: "viewer", method: "google", status: "active", must: false }
  );
  assert.equal(s.app.db.users.find((u) => u.email === "grace@example.com").password_hash, null);

  const pw = await addUser(s, { email: "pat@example.com", role: "viewer", method: "password" });
  const temp = pw.temporary_password;
  assert.match(temp, /^[A-Za-z0-9]{16,}$/);
  assert.equal(pw.user.method, "password");
  assert.equal(pw.user.must_change_password, true);
  // Stored only as a bcrypt hash.
  const stored = s.app.db.users.find((u) => u.email === "pat@example.com");
  assert.notEqual(stored.password_hash, temp);
  assert.ok(!stored.password_hash.includes(temp));
  assert.ok(await bcrypt.compare(temp, stored.password_hash));
  assert.equal(stored.must_change_password, true);

  // Shown once: the list never has it, nor any hash.
  const list = await (await s.get("/api/settings/users")).text();
  assert.ok(!list.includes(temp));
  assert.ok(!list.includes("$2"));
  assert.ok(!/password_hash/.test(list));
  const rows = JSON.parse(list);
  assert.deepEqual(rows.map((r) => [r.email, r.method, r.status]), [
    ["admin@example.com", "password", "active"],
    ["grace@example.com", "google", "active"],
    ["pat@example.com", "password", "active"],
  ]);
  assert.equal(rows[0].sessions, 1);
});

test("an invalid or duplicate email, role or method is refused", async (t) => {
  const s = await setup(t);
  for (const email of ["", "no-at-sign", "a@b", "two@@example.com", "sp ace@example.com", `${"a".repeat(250)}@example.com`, 42, null]) {
    const res = await s.post("/api/settings/users", { email, role: "viewer", method: "google" });
    assert.equal(res.status, 400, String(email));
    assert.equal((await res.json()).field, "email");
  }
  const dup = await s.post("/api/settings/users", { email: "ADMIN@example.com", role: "viewer", method: "google" });
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: "A user with this email already exists.", field: "email" });
  assert.equal((await s.post("/api/settings/users", { email: "v@example.com", role: "owner", method: "google" })).status, 400);
  assert.equal((await s.post("/api/settings/users", { email: "v@example.com", role: "viewer", method: "magic" })).status, 400);
  assert.equal(s.app.db.users.length, 1);
});

test("adding an admin or making someone admin needs the acting admin's password", async (t) => {
  const s = await setup(t);
  const none = await s.post("/api/settings/users", { email: "boss@example.com", role: "admin", method: "google" });
  assert.equal(none.status, 403);
  assert.equal((await none.json()).field, "confirm");
  const wrong = await s.post("/api/settings/users", { email: "boss@example.com", role: "admin", method: "google", confirm: "not my password" });
  assert.equal(wrong.status, 403);
  assert.equal(s.app.db.users.length, 1);

  const ok = await addUser(s, { email: "boss@example.com", role: "admin", method: "password", confirm: PASSWORD });
  assert.equal(ok.user.role, "admin");

  const viewer = await addUser(s, { email: "v@example.com", role: "viewer", method: "google" });
  const promote = await s.post(`/api/settings/users/${viewer.user.id}/role`, { role: "admin" });
  assert.equal(promote.status, 403);
  assert.equal(s.app.db.users.find((u) => u.email === "v@example.com").role, "viewer");
  const promoted = await s.post(`/api/settings/users/${viewer.user.id}/role`, { role: "admin", confirm: PASSWORD });
  assert.equal(promoted.status, 200);
});

test("an admin who signs in only with Google confirms by typing the target email", async (t) => {
  const s = await setup(t);
  const googleAdmin = await s.app.addUser("gadmin@example.com", "admin", null);
  // Sign the Google-only admin in the way Google sign-in does, through startSession.
  const { token, idHash } = require("../sessions").newSessionToken();
  await s.app.db.createSession({ idHash, userId: googleAdmin.id, createdAt: new Date(s.app.clock.t), expiresAt: new Date(s.app.clock.t + 3600000), userAgent: "test" });
  const g = as(s.app, `dash_session=${token}`);
  const body = { email: "new-admin@example.com", role: "admin", method: "google" };
  assert.equal((await g.post("/api/settings/users", { ...body, confirm: "someone@example.com" })).status, 403);
  assert.equal((await g.post("/api/settings/users", { ...body, confirm: " New-Admin@example.com " })).status, 201);
});

test("a role change ends every session of that user", async (t) => {
  const s = await setup(t);
  const v = await s.app.addUser("v@example.com", "viewer", PASSWORD);
  const one = await signIn(s.app, "v@example.com", PASSWORD);
  await signIn(s.app, "v@example.com", PASSWORD);
  assert.equal(sessionsOf(s.app, v.id), 2);
  const res = await s.post(`/api/settings/users/${v.id}/role`, { role: "admin", confirm: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, "admin");
  assert.equal(sessionsOf(s.app, v.id), 0);
  assert.equal((await one.get("/auth/me")).status, 401);
  // And back to viewer, which needs no confirmation.
  await signIn(s.app, "v@example.com", PASSWORD);
  const back = await s.post(`/api/settings/users/${v.id}/role`, { role: "viewer" });
  assert.equal(back.status, 200);
  assert.equal(sessionsOf(s.app, v.id), 0);
  assert.equal((await s.post(`/api/settings/users/${v.id}/role`, { role: "viewer" })).status, 409);
});

test("disable ends the sessions and blocks sign-in; enable allows it again", async (t) => {
  const s = await setup(t);
  const v = await s.app.addUser("v@example.com", "viewer", PASSWORD);
  const signedIn = await signIn(s.app, "v@example.com", PASSWORD);
  const res = await s.post(`/api/settings/users/${v.id}/disable`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "disabled");
  assert.equal(sessionsOf(s.app, v.id), 0);
  assert.equal((await signedIn.get("/auth/me")).status, 401);
  assert.equal((await s.app.login("v@example.com", PASSWORD)).res.status, 401);
  assert.equal((await s.post(`/api/settings/users/${v.id}/disable`)).status, 409);
  // Still listed: nothing is deleted.
  const list = await (await s.get("/api/settings/users")).json();
  assert.equal(list.find((u) => u.email === "v@example.com").status, "disabled");

  const enabled = await s.post(`/api/settings/users/${v.id}/enable`);
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).status, "active");
  assert.equal((await s.app.login("v@example.com", PASSWORD)).res.status, 200);
  assert.equal((await s.post(`/api/settings/users/${v.id}/enable`)).status, 409);
});

test("an admin cannot disable or demote themselves, reset their own password or sign themselves out here", async (t) => {
  const s = await setup(t);
  await s.app.addUser("other@example.com", "admin", PASSWORD);
  const id = s.admin.id;
  assert.equal((await s.post(`/api/settings/users/${id}/disable`)).status, 409);
  assert.equal((await s.post(`/api/settings/users/${id}/role`, { role: "viewer" })).status, 409);
  assert.equal((await s.post(`/api/settings/users/${id}/reset-password`, { confirm: PASSWORD })).status, 409);
  assert.equal((await s.post(`/api/settings/users/${id}/sign-out`)).status, 409);
  const me = s.app.db.users.find((u) => u.id === String(id));
  assert.deepEqual([me.role, me.disabled], ["admin", false]);
  assert.equal(sessionsOf(s.app, id), 1);
});

test("the last active admin cannot be disabled or demoted", async (t) => {
  const s = await setup(t);
  const other = await s.app.addUser("other@example.com", "admin", PASSWORD);
  // The acting admin always counts, so the rule only matters when two admins act at the same time.
  // Here the database answers as if the other change had already been saved.
  const realTransaction = s.app.db.transaction;
  s.app.db.transaction = (fn) => realTransaction((ops) => fn({ ...ops, countActiveAdmins: async () => 1 }));
  for (const [path, body] of [["disable", {}], ["role", { role: "viewer" }]]) {
    const res = await s.post(`/api/settings/users/${other.id}/${path}`, body);
    assert.equal(res.status, 409, path);
    assert.match((await res.json()).error, /last active admin/);
  }
  s.app.db.transaction = realTransaction;
  const row = s.app.db.users.find((u) => u.id === String(other.id));
  assert.deepEqual([row.role, row.disabled], ["admin", false]);
  // With two active admins the same change is allowed.
  assert.equal((await s.post(`/api/settings/users/${other.id}/role`, { role: "viewer" })).status, 200);
});

test("unknown or malformed ids give 404", async (t) => {
  const s = await setup(t);
  for (const id of ["999", "0", "abc", "1;drop", "-1"]) {
    for (const action of ["role", "disable", "enable", "reset-password", "sign-out"]) {
      const res = await s.post(`/api/settings/users/${id}/${action}`, { role: "viewer", confirm: PASSWORD });
      assert.equal(res.status, 404, `${id} ${action}`);
    }
  }
});

test("sign out everywhere ends every session of the user", async (t) => {
  const s = await setup(t);
  const v = await s.app.addUser("v@example.com", "viewer", PASSWORD);
  await signIn(s.app, "v@example.com", PASSWORD);
  await signIn(s.app, "v@example.com", PASSWORD);
  const res = await s.post(`/api/settings/users/${v.id}/sign-out`);
  assert.equal(res.status, 200);
  assert.equal(sessionsOf(s.app, v.id), 0);
});

test("a reset gives a new temporary password once, ends the sessions and forces a change at the next sign-in", async (t) => {
  const s = await setup(t);
  const v = await s.app.addUser("v@example.com", "viewer", PASSWORD);
  const old = await signIn(s.app, "v@example.com", PASSWORD);
  assert.equal((await s.post(`/api/settings/users/${v.id}/reset-password`, {})).status, 403);
  const res = await s.post(`/api/settings/users/${v.id}/reset-password`, { confirm: PASSWORD });
  assert.equal(res.status, 200);
  const { user, temporary_password: temp } = await res.json();
  assert.equal(user.must_change_password, true);
  assert.match(temp, /^[A-Za-z0-9]{16,}$/);
  assert.equal((await old.get("/auth/me")).status, 401);
  assert.equal((await s.app.login("v@example.com", PASSWORD)).res.status, 401);

  const next = await signIn(s.app, "v@example.com", temp);
  assert.deepEqual(next.body, { email: "v@example.com", role: "viewer", must_change_password: true });
  // A Google-only account has nothing to reset.
  const g = await s.app.addUser("g@example.com", "viewer", null);
  assert.equal((await s.post(`/api/settings/users/${g.id}/reset-password`, { confirm: PASSWORD })).status, 409);
});

test("while a password must be changed every other route answers 403 password_change_required", async (t) => {
  const s = await setup(t);
  await s.app.addUser("v@example.com", "viewer", PASSWORD, { mustChangePassword: true });
  const v = await signIn(s.app, "v@example.com", PASSWORD);
  for (const path of ["/api/status", "/api/servers", "/api/forecast", "/api/forecast/events", "/api/incidents", "/api/settings/users"]) {
    const res = await v.get(path);
    assert.equal(res.status, 403, path);
    assert.equal((await res.json()).code, "password_change_required", path);
  }
  assert.equal((await v.post("/api/chat", { message: "hi" })).status, 403);
  // Allowed: the profile, the password change and sign out.
  const me = await v.get("/auth/me");
  assert.equal(me.status, 200);
  assert.equal((await me.json()).must_change_password, true);
  const account = await v.get("/api/account");
  assert.equal(account.status, 200);
  assert.deepEqual(await account.json(), { email: "v@example.com", role: "viewer", method: "password", must_change_password: true, sessions: 1 });

  const changed = await v.post("/api/account/password", { current_password: PASSWORD, new_password: NEW_PASSWORD });
  assert.equal(changed.status, 200);
  assert.equal((await v.get("/api/forecast")).status, 200);
  assert.equal((await v.get("/auth/me").then((r) => r.json())).must_change_password, undefined);
  assert.equal((await v.post("/auth/logout")).status, 204);
});

test("a normal session still reads /api/forecast", async (t) => {
  const s = await setup(t);
  await s.app.addUser("v@example.com", "viewer", PASSWORD);
  const v = await signIn(s.app, "v@example.com", PASSWORD);
  assert.equal((await v.get("/api/forecast")).status, 200);
});

test("the internal forecast route is not behind the session gate", async (t) => {
  // Without a token configured it answers 404, with or without a gated session.
  const off = await setup(t);
  await off.app.addUser("v@example.com", "viewer", PASSWORD, { mustChangePassword: true });
  const gated = await signIn(off.app, "v@example.com", PASSWORD);
  const since = "?since=2026-10-30T07:00:00Z";
  assert.equal((await off.app.request(`/api/internal/forecast/new${since}`)).status, 404);
  assert.equal((await gated.get(`/api/internal/forecast/new${since}`)).status, 404);

  // With a token, the token decides: no session needed, and a gated session does not block it.
  const on = await setup(t, { forecastToken: TOKEN });
  await on.app.addUser("v@example.com", "viewer", PASSWORD, { mustChangePassword: true });
  const gatedOn = await signIn(on.app, "v@example.com", PASSWORD);
  const ok = await on.app.request(`/api/internal/forecast/new${since}`, { headers: { "x-notify-token": TOKEN } });
  assert.equal(ok.status, 200);
  const withCookie = await on.app.request(`/api/internal/forecast/new${since}`, { headers: { "x-notify-token": TOKEN, cookie: gatedOn.cookie } });
  assert.equal(withCookie.status, 200);
  assert.equal((await on.app.request(`/api/internal/forecast/new${since}`, { headers: { cookie: gatedOn.cookie } })).status, 401);
});

test("change password checks the current password, the length and reuse, and keeps only this session", async (t) => {
  const s = await setup(t);
  const other = await signIn(s.app, "admin@example.com", PASSWORD);
  const cases = [
    [{ current_password: "wrong password!!", new_password: NEW_PASSWORD }, "current_password"],
    [{ new_password: NEW_PASSWORD }, "current_password"],
    [{ current_password: PASSWORD, new_password: "short" }, "new_password"],
    [{ current_password: PASSWORD, new_password: "x".repeat(73) }, "new_password"],
    [{ current_password: PASSWORD, new_password: PASSWORD }, "new_password"],
  ];
  for (const [body, field] of cases) {
    const res = await s.post("/api/account/password", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).field, field);
  }
  const ok = await s.post("/api/account/password", { current_password: PASSWORD, new_password: NEW_PASSWORD });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { must_change_password: false, sessions_ended: 1 });
  assert.equal((await s.get("/auth/me")).status, 200);
  assert.equal((await other.get("/auth/me")).status, 401);
  assert.equal((await s.app.login("admin@example.com", PASSWORD)).res.status, 401);
  assert.equal((await s.app.login("admin@example.com", NEW_PASSWORD)).res.status, 200);
  // A Google-only account has no password to change.
  await s.app.addUser("g@example.com", "viewer", null);
  const { token, idHash } = require("../sessions").newSessionToken();
  const g = s.app.db.users.find((u) => u.email === "g@example.com");
  await s.app.db.createSession({ idHash, userId: g.id, createdAt: new Date(s.app.clock.t), expiresAt: new Date(s.app.clock.t + 3600000), userAgent: "t" });
  const gs = as(s.app, `dash_session=${token}`);
  assert.equal((await gs.post("/api/account/password", { current_password: "", new_password: NEW_PASSWORD })).status, 409);
});

test("a user signs out their other sessions and keeps this one", async (t) => {
  const s = await setup(t);
  await signIn(s.app, "admin@example.com", PASSWORD);
  await signIn(s.app, "admin@example.com", PASSWORD);
  const res = await s.post("/api/account/sign-out-others");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sessions_ended: 2 });
  assert.equal(sessionsOf(s.app, s.admin.id), 1);
  assert.equal((await s.get("/auth/me")).status, 200);
});

test("wrong current passwords are rate limited per user", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await s.post("/api/account/password", { current_password: "wrong password!!", new_password: NEW_PASSWORD })).status, 400);
  }
  assert.equal((await s.post("/api/account/password", { current_password: PASSWORD, new_password: NEW_PASSWORD })).status, 429);
});

test("the users write routes are rate limited per admin", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 30; i++) assert.equal((await s.post("/api/settings/users/999/sign-out")).status, 404);
  assert.equal((await s.post("/api/settings/users/999/sign-out")).status, 429);
  assert.equal((await s.get("/api/settings/users")).status, 200);
});

test("every change has one change log row with the admin and the email, and no secret anywhere", async (t) => {
  const s = await setup(t);
  const temps = [];
  const added = await addUser(s, { email: "v@example.com", role: "viewer", method: "password" });
  temps.push(added.temporary_password);
  const id = added.user.id;
  await s.post(`/api/settings/users/${id}/role`, { role: "admin", confirm: PASSWORD });
  await s.post(`/api/settings/users/${id}/role`, { role: "viewer" });
  await s.post(`/api/settings/users/${id}/disable`);
  await s.post(`/api/settings/users/${id}/enable`);
  const reset = await (await s.post(`/api/settings/users/${id}/reset-password`, { confirm: PASSWORD })).json();
  temps.push(reset.temporary_password);
  await s.post(`/api/settings/users/${id}/sign-out`);
  // Refused changes write no row.
  await s.post(`/api/settings/users/${s.admin.id}/disable`);

  const rows = logRows(s.app);
  assert.deepEqual(rows.map((r) => r.action), [
    "Added user",
    "Changed user role",
    "Changed user role",
    "Disabled user",
    "Enabled user",
    "Reset user password",
    "Signed user out everywhere",
  ]);
  for (const r of rows) {
    assert.equal(r.user_email, "admin@example.com");
    assert.equal(r.target, "v@example.com");
  }
  const hashes = s.app.db.users.map((u) => u.password_hash).filter(Boolean);
  const tokens = [...s.app.db.sessions.keys()];
  const everything = JSON.stringify(rows) + JSON.stringify(s.app.logs) + (await (await s.get("/api/settings/log?limit=50")).text());
  for (const secret of [...temps, ...hashes, ...tokens, PASSWORD]) assert.ok(!everything.includes(secret), "a secret reached the log");
  assert.ok(!everything.includes("$2"));
});

test("the user scripts still work next to the routes", async (t) => {
  const s = await setup(t);
  assert.match(await createUserAccount(s.app.db, { email: "script@example.com", role: "viewer", passwordHash: await bcrypt.hash(PASSWORD, 4) }), /Created viewer/);
  const list = await (await s.get("/api/settings/users")).json();
  assert.equal(list.find((u) => u.email === "script@example.com").must_change_password, false);
  const v = await signIn(s.app, "script@example.com", PASSWORD);
  assert.equal((await v.get("/api/status")).status !== 403, true);
  await assert.rejects(createUserAccount(s.app.db, { email: "script@example.com", role: "viewer", passwordHash: null }), /already exists/);
  assert.match(await setUserPassword(s.app.db, "script@example.com", await bcrypt.hash(NEW_PASSWORD, 4)), /Password changed/);
  assert.equal((await v.get("/auth/me")).status, 401);
  assert.equal((await s.app.login("script@example.com", NEW_PASSWORD)).res.status, 200);
  assert.match(await disableUserAccount(s.app.db, "script@example.com"), /Disabled/);
  assert.equal((await s.app.login("script@example.com", NEW_PASSWORD)).res.status, 401);
  // The routes see what the scripts did.
  const after = await (await s.get("/api/settings/users")).json();
  assert.equal(after.find((u) => u.email === "script@example.com").status, "disabled");
});

test("failed confirmations are limited like failed logins and logged without the password", async (t) => {
  const s = await setup(t);
  const body = { email: "boss@example.com", role: "admin", method: "google", confirm: "a wrong guess!!" };
  for (let i = 0; i < 10; i++) assert.equal((await s.post("/api/settings/users", body)).status, 403);
  assert.equal((await s.post("/api/settings/users", { ...body, confirm: PASSWORD })).status, 429);
  const lines = s.app.logs.filter((l) => l.includes("user_confirm_failed"));
  assert.equal(lines.length, 10);
  assert.ok(lines.every((l) => !l.includes("a wrong guess") && !l.includes("admin@example.com")));
  // Successful writes do not use up the confirmation limit.
  const other = await setup(t);
  for (let i = 0; i < 12; i++) assert.equal((await other.post("/api/settings/users", { email: `v${i}@example.com`, role: "viewer", method: "google" })).status, 201);
});

test("an own password change loses to an admin reset that happened after the check", async (t) => {
  const s = await setup(t);
  // The reset lands between the route's password check and its transaction.
  const real = s.app.db.transaction;
  s.app.db.transaction = async (fn) => {
    s.app.db.transaction = real;
    s.app.db.users.find((u) => u.email === "admin@example.com").password_hash = "reset-by-another-admin";
    return real(fn);
  };
  const res = await s.post("/api/account/password", { current_password: PASSWORD, new_password: NEW_PASSWORD });
  assert.equal(res.status, 409);
  assert.equal(s.app.db.users.find((u) => u.email === "admin@example.com").password_hash, "reset-by-another-admin");
});
