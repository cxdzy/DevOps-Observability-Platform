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
// cookie came back intact and returns the claims chosen by the test. Like openid-client, it rejects a
// state that does not match the callback URL, and a verifier or nonce Google did not issue for.
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
      if (!gotTx || gotTx.state !== currentUrl.searchParams.get("state")) throw new Error("state mismatch");
      if (gotTx.verifier !== tx.verifier || gotTx.nonce !== tx.nonce) throw new Error("invalid_grant");
      if (claims instanceof Error) throw claims;
      return claims;
    },
  };
}

async function runFlow(t, claims, setup, options = {}) {
  const oidc = fakeOidc(claims);
  const app = await startApp({ googleClientId: "client-id", oidc, ...options });
  t.after(app.close);
  if (setup) await setup(app);
  const start = await app.request("/auth/google");
  assert.equal(start.status, 302);
  assert.equal(start.headers.get("location"), "https://accounts.google.com/o/oauth2/v2/auth?x=1");
  const txSet = start.headers.getSetCookie().find((c) => /^(__Host-)?dash_oidc=/.test(c));
  assert.match(txSet, /HttpOnly/);
  assert.match(txSet, /SameSite=Lax/);
  assert.match(txSet, /Max-Age=600/);
  assert.match(txSet, /Path=\/;/);
  const txCookie = options.tamper ? options.tamper(txSet.split(";")[0]) : txSet.split(";")[0];
  const cb = await app.request("/auth/google/callback?code=abc&state=state-1", { headers: { cookie: txCookie } });
  return { app, oidc, cb, txSet };
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
  assert.ok(cb.headers.getSetCookie().some((c) => /^(__Host-)?dash_oidc=;/.test(c) && /Max-Age=0/.test(c)));
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

// A tampered transaction cookie must never produce a session: unreadable, not JSON, or with a
// state, verifier or nonce other than the ones issued for this browser.
const b64 = (obj) => Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)).toString("base64url");
for (const [name, tamper] of [
  ["not base64 JSON", (c) => c.replace(/=.*/, "=%%%garbage")],
  ["base64 but not JSON", (c) => c.replace(/=.*/, "=" + b64("not json"))],
  ["changed state", (c) => c.replace(/=.*/, "=" + b64({ verifier: "v".repeat(43), state: "state-2", nonce: "nonce-1" }))],
  ["changed verifier", (c) => c.replace(/=.*/, "=" + b64({ verifier: "w".repeat(43), state: "state-1", nonce: "nonce-1" }))],
  ["changed nonce", (c) => c.replace(/=.*/, "=" + b64({ verifier: "v".repeat(43), state: "state-1", nonce: "other" }))],
  ["empty object", (c) => c.replace(/=.*/, "=" + b64({}))],
]) {
  test(`callback: tampered transaction cookie (${name}) is denied`, async (t) => {
    const { app, cb } = await runFlow(t, verified("tam@example.com"), (a) => a.addUser("tam@example.com", "admin", null), { tamper });
    assert.equal(cb.headers.get("location"), "/login?error=denied");
    assert.equal(app.sessionCookie(cb), null);
    assert.equal(app.db.sessions.size, 0);
    assert.ok(app.logs.some((l) => l.includes("google_login_failed")));
  });
}

test("with Secure cookies the transaction and session cookies use the __Host- prefix", async (t) => {
  const { app, cb, txSet } = await runFlow(t, verified("sec@example.com"), (a) => a.addUser("sec@example.com", "viewer", null), {
    config: { cookieSecure: true },
  });
  assert.match(txSet, /^__Host-dash_oidc=/);
  assert.match(txSet, /; Secure/);
  assert.doesNotMatch(txSet, /Domain=/i);
  const session = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-dash_session="));
  assert.ok(session);
  assert.match(session, /Path=\/;/);
  assert.match(session, /; Secure/);
  assert.doesNotMatch(session, /Domain=/i);
  assert.ok(cb.headers.getSetCookie().some((c) => c.startsWith("__Host-dash_oidc=;") && /Max-Age=0/.test(c)));
  assert.equal(app.db.sessions.size, 1);
});

test("the redirect to Google uses the real openid-client with PKCE S256, state, nonce and prompt=select_account", async (t) => {
  const { openidClient } = require("../google");
  // Google's endpoints, without the network discovery call.
  const oidc = openidClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    discover: (client) =>
      new client.Configuration(
        {
          issuer: "https://accounts.google.com",
          authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: "https://oauth2.googleapis.com/token",
          jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        },
        "client-id",
        undefined,
        client.ClientSecretPost("client-secret")
      ),
  });
  const app = await startApp({ googleClientId: "client-id", oidc });
  t.after(app.close);
  const res = await app.request("/auth/google");
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get("location"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = url.searchParams;
  assert.equal(q.get("prompt"), "select_account");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(q.get("state"));
  assert.ok(q.get("nonce"));
  assert.equal(q.get("scope"), "openid email profile");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), "client-id");
  assert.equal(q.get("redirect_uri"), "http://localhost:3100/auth/google/callback");
  // The state and nonce in the URL are the ones kept in the transaction cookie.
  const tx = res.headers.getSetCookie().find((c) => c.startsWith("dash_oidc="));
  const saved = JSON.parse(Buffer.from(decodeURIComponent(tx.split(";")[0].split("=")[1]), "base64url").toString("utf8"));
  assert.equal(saved.state, q.get("state"));
  assert.equal(saved.nonce, q.get("nonce"));
});
