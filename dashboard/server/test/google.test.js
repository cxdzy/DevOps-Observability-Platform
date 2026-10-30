const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { googleDecision } = require("../google");

const verified = (email) => ({ email, email_verified: true });

test("decision: not in table, disabled, email not verified, allowed", () => {
  const user = { id: "1", email: "a@example.com", role: "viewer", disabled: false };
  assert.deepEqual(googleDecision(verified("a@example.com"), null), { allow: false, reason: "not_in_table" });
  assert.deepEqual(googleDecision(verified("a@example.com"), { ...user, disabled: true }), { allow: false, reason: "disabled" });
  assert.deepEqual(googleDecision({ email: "a@example.com", email_verified: false }, user), { allow: false, reason: "email_not_verified" });
  assert.deepEqual(googleDecision({ email: "a@example.com" }, user), { allow: false, reason: "email_not_verified" });
  assert.deepEqual(googleDecision({ email: "a@example.com", email_verified: "true" }, user), { allow: false, reason: "email_not_verified" });
  assert.deepEqual(googleDecision(null, user), { allow: false, reason: "email_not_verified" });
  assert.deepEqual(googleDecision(verified("a@example.com"), user), { allow: true, reason: "allowed" });
});

// A stand-in for openid-client: start() returns a fixed URL, finish() checks the transaction
// cookie came back intact and returns the claims chosen by the test.
function fakeOidc(claims) {
  const tx = { verifier: "v".repeat(43), state: "state-1", nonce: "nonce-1" };
  return {
    calls: [],
    async start(redirectUri) {
      this.calls.push(["start", redirectUri]);
      return { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", tx };
    },
    async finish(currentUrl, gotTx) {
      this.calls.push(["finish", currentUrl.href]);
      assert.deepEqual(gotTx, tx);
      if (claims instanceof Error) throw claims;
      return claims;
    },
  };
}

async function runFlow(t, claims, setup) {
  const oidc = fakeOidc(claims);
  const app = await startApp({ googleClientId: "client-id", oidc });
  t.after(app.close);
  if (setup) await setup(app);
  const start = await app.request("/auth/google");
  assert.equal(start.status, 302);
  assert.equal(start.headers.get("location"), "https://accounts.google.com/o/oauth2/v2/auth?x=1");
  const txSet = start.headers.getSetCookie().find((c) => c.startsWith("dash_oidc="));
  assert.match(txSet, /HttpOnly/);
  assert.match(txSet, /SameSite=Lax/);
  assert.match(txSet, /Max-Age=600/);
  assert.match(txSet, /Path=\/auth\/google/);
  const cb = await app.request("/auth/google/callback?code=abc&state=state-1", { headers: { cookie: txSet.split(";")[0] } });
  return { app, oidc, cb };
}

test("callback: allowed user gets a session and goes to /", async (t) => {
  const { app, oidc, cb } = await runFlow(t, verified("Jo@Example.com"), (a) => a.addUser("jo@example.com", "admin", null));
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/");
  assert.ok(app.sessionCookie(cb));
  assert.equal(app.db.sessions.size, 1);
  assert.deepEqual(oidc.calls[0], ["start", "http://localhost:3100/auth/google/callback"]);
  assert.equal(oidc.calls[1][1], "http://localhost:3100/auth/google/callback?code=abc&state=state-1");
  // The transaction cookie is cleared.
  assert.ok(cb.headers.getSetCookie().some((c) => c.startsWith("dash_oidc=;") && /Max-Age=0/.test(c)));
});

for (const [name, claims, setup, event, reason] of [
  ["email not in the table", verified("stranger@example.com"), null, "google_login_denied", "not_in_table"],
  ["disabled user", verified("off@example.com"), (a) => a.addUser("off@example.com", "viewer", null, { disabled: true }), "google_login_denied", "disabled"],
  ["email not verified", { email: "kim@example.com", email_verified: false }, (a) => a.addUser("kim@example.com", "viewer", null), "google_login_denied", "email_not_verified"],
  ["token exchange fails", new Error("invalid state"), (a) => a.addUser("lee@example.com", "viewer", null), "google_login_failed", "error"],
]) {
  test(`callback: ${name} gets no session and the same denied redirect`, async (t) => {
    const { app, cb } = await runFlow(t, claims, setup);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/login?error=denied");
    assert.equal(app.sessionCookie(cb), null);
    assert.equal(app.db.sessions.size, 0);
    // The decision itself must be the reason, not an error on the way.
    const logged = app.logs.map((l) => JSON.parse(l)).filter((l) => /^google_login/.test(l.event));
    assert.deepEqual(logged.map((l) => [l.event, l.reason]), [[event, reason]]);
  });
}

test("callback without the transaction cookie is denied", async (t) => {
  const app = await startApp({ googleClientId: "client-id", oidc: fakeOidc(verified("a@example.com")) });
  t.after(app.close);
  await app.addUser("a@example.com", "viewer", null);
  const cb = await app.request("/auth/google/callback?code=abc&state=state-1");
  assert.equal(cb.headers.get("location"), "/login?error=denied");
  assert.equal(app.db.sessions.size, 0);
});

test("without GOOGLE_CLIENT_ID the Google routes are 404 and /auth/config says so", async (t) => {
  const app = await startApp();
  t.after(app.close);
  assert.deepEqual(await (await app.request("/auth/config")).json(), { google: false });
  assert.equal((await app.request("/auth/google")).status, 404);
  assert.equal((await app.request("/auth/google/callback?code=x")).status, 404);
});

test("with GOOGLE_CLIENT_ID /auth/config reports google: true", async (t) => {
  const app = await startApp({ googleClientId: "client-id", oidc: fakeOidc(null) });
  t.after(app.close);
  assert.deepEqual(await (await app.request("/auth/config")).json(), { google: true });
});
