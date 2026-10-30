// Google sign-in with the authorization code flow, PKCE, state and nonce (openid-client).
// Only users already in the users table can sign in this way. Google tokens are never stored.
const express = require("express");
const { cookieName, parseCookies, serializeCookie, clearCookie } = require("./cookies");
const { normaliseEmail, maskEmail } = require("./security");

const TX_COOKIE_BASE = "dash_oidc";
const TX_MAX_AGE_MS = 10 * 60 * 1000;
const SCOPE = "openid email profile";
const DENIED_REDIRECT = "/login?error=denied";

// Pure decision for the callback: claims from a verified ID token, user row or null.
function googleDecision(claims, user) {
  if (!claims || claims.email_verified !== true) return { allow: false, reason: "email_not_verified" };
  if (!user) return { allow: false, reason: "not_in_table" };
  if (user.disabled) return { allow: false, reason: "disabled" };
  return { allow: true, reason: "allowed" };
}

// Real openid-client calls. Discovery runs on first use and is cached, so startup never
// depends on reaching Google.
function openidClient({ clientId, clientSecret }) {
  let configPromise = null;
  async function config() {
    const client = await import("openid-client");
    if (!configPromise) {
      configPromise = client
        .discovery(new URL("https://accounts.google.com"), clientId, undefined, client.ClientSecretPost(clientSecret))
        .catch((err) => {
          configPromise = null;
          throw err;
        });
    }
    return { client, config: await configPromise };
  }
  return {
    async start(redirectUri) {
      const { client, config: cfg } = await config();
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(cfg, {
        redirect_uri: redirectUri,
        scope: SCOPE,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      return { url: url.href, tx: { verifier, state, nonce } };
    },
    // Returns the verified ID token claims. The tokens themselves are dropped here.
    async finish(currentUrl, tx) {
      const { client, config: cfg } = await config();
      const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
        pkceCodeVerifier: tx.verifier,
        expectedState: tx.state,
        expectedNonce: tx.nonce,
        idTokenExpected: true,
      });
      return tokens.claims();
    },
  };
}

// opts: { db, auth, clientId, clientSecret, appOrigin, cookieSecure, oidc (for tests), log }
function createGoogle(opts) {
  const { db, auth, clientId, appOrigin, cookieSecure } = opts;
  const enabled = Boolean(clientId);
  const log = opts.log || console.log;
  const oidc = opts.oidc || (enabled ? openidClient(opts) : null);
  const redirectUri = `${appOrigin}/auth/google/callback`;
  // Path=/ because the __Host- prefix (used with Secure cookies) allows no other path.
  const TX_COOKIE = cookieName(TX_COOKIE_BASE, cookieSecure);
  const txCookieOpts = { path: "/", secure: cookieSecure, sameSite: "Lax" };

  const router = express.Router();

  router.get("/google", async (req, res, next) => {
    if (!enabled) return res.status(404).json({ error: "not found" });
    try {
      const { url, tx } = await oidc.start(redirectUri);
      const value = Buffer.from(JSON.stringify(tx)).toString("base64url");
      res.append("Set-Cookie", serializeCookie(TX_COOKIE, value, { ...txCookieOpts, maxAgeMs: TX_MAX_AGE_MS }));
      res.redirect(302, url);
    } catch (err) {
      next(err);
    }
  });

  router.get("/google/callback", async (req, res) => {
    if (!enabled) return res.status(404).json({ error: "not found" });
    // The transaction cookie is single use on every path.
    res.append("Set-Cookie", clearCookie(TX_COOKIE, txCookieOpts));
    let reason = "error";
    try {
      const raw = parseCookies(req.headers.cookie)[TX_COOKIE];
      if (!raw) throw new Error("missing transaction cookie");
      const tx = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      const claims = await oidc.finish(new URL(appOrigin + req.originalUrl), tx);
      const email = normaliseEmail(claims && claims.email);
      const user = email ? await db.findUserByEmail(email) : null;
      const decision = googleDecision(claims, user);
      reason = decision.reason;
      if (decision.allow && user) {
        await auth.startSession(req, res, user);
        return res.redirect(302, "/");
      }
      log(JSON.stringify({ event: "google_login_denied", reason, email: maskEmail(email) }));
    } catch (err) {
      log(JSON.stringify({ event: "google_login_failed", reason, error: String(err && err.message) }));
    }
    res.redirect(302, DENIED_REDIRECT);
  });

  return { router, enabled };
}

module.exports = { createGoogle, googleDecision, DENIED_REDIRECT };
