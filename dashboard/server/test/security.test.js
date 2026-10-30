const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const sec = require("../security");

test("origin check needs an exact match and rejects a missing origin", () => {
  const app = "http://localhost:3100";
  assert.equal(sec.originAllowed("http://localhost:3100", app), true);
  for (const bad of [undefined, "", "null", "http://127.0.0.1:3100", "http://localhost:3100/", "https://localhost:3100", "http://localhost:31000", "http://evil.example"]) {
    assert.equal(sec.originAllowed(bad, app), false, String(bad));
  }
});

test("rate limit keys: email is normalised and hashed, IP and email both count", () => {
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
  assert.equal(sec.emailKey("  Alice@Example.COM "), sha("alice@example.com"));
  assert.equal(sec.emailKey(undefined), sha(""));
  assert.equal(sec.emailKey("x".repeat(5000)).length, 64);
  assert.equal(sec.loginIpEmailKey("1.2.3.4", "  Alice@Example.COM "), sec.loginIpEmailKey("1.2.3.4", "alice@example.com"));
  assert.notEqual(sec.loginIpEmailKey("1.2.3.4", "a@x.com"), sec.loginIpEmailKey("1.2.3.4", "b@x.com"));
  assert.notEqual(sec.loginIpEmailKey("1.2.3.4", "a@x.com"), sec.loginIpEmailKey("1.2.3.5", "a@x.com"));
  assert.equal(sec.loginIpKey("1.2.3.4"), "1.2.3.4");
  // IPv6 addresses in the same /56 share a key, so rotating addresses does not help.
  assert.equal(sec.loginIpKey("2001:db8:0:1::1"), sec.loginIpKey("2001:db8:0:2::9"));
  assert.notEqual(sec.loginIpKey("2001:db8:0:100::1"), sec.loginIpKey("2001:db8:0:1::1"));
});

test("IPv4-mapped IPv6 addresses are normalised", () => {
  assert.equal(sec.normaliseIp("::ffff:172.18.0.5"), "172.18.0.5");
  assert.equal(sec.normaliseIp("::FFFF:10.0.0.1"), "10.0.0.1");
  assert.equal(sec.normaliseIp("fd00::1"), "fd00::1");
  assert.equal(sec.normaliseIp(undefined), "");
});

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
const trusts = (...ips) => ({ has: (ip) => ips.includes(sec.normaliseIp(ip)) });

test("CF-Connecting-IP is used only from a trusted peer, X-Forwarded-For never", () => {
  const cf = { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" };
  assert.equal(sec.clientIp(req("::ffff:172.18.0.9", cf), trusts("172.18.0.9")), "203.0.113.7");
  assert.equal(sec.clientIp(req("172.18.0.1", cf), trusts("172.18.0.9")), "172.18.0.1");
  assert.equal(sec.clientIp(req("172.18.0.1", { "x-forwarded-for": "198.51.100.1" }), trusts("172.18.0.1")), "172.18.0.1");
  assert.equal(sec.clientIp(req("172.18.0.9", { "cf-connecting-ip": "not-an-ip" }), trusts("172.18.0.9")), "172.18.0.9");
  assert.equal(sec.clientIp(req("172.18.0.9", { "cf-connecting-ip": "::ffff:203.0.113.8" }), trusts("172.18.0.9")), "203.0.113.8");
  assert.equal(sec.clientIp(req("172.18.0.9", cf), undefined), "172.18.0.9");
});

test("TRUSTED_PROXY_HOSTS parsing", () => {
  assert.deepEqual(sec.parseHostList(undefined), ["cloudflared"]);
  assert.deepEqual(sec.parseHostList(""), ["cloudflared"]);
  assert.deepEqual(sec.parseHostList(" cloudflared , other "), ["cloudflared", "other"]);
  assert.deepEqual(sec.parseHostList("none"), []);
});

test("trusted proxies: all addresses resolved, IPv4-mapped normalised, failure trusts nothing", async () => {
  let fail = false;
  const lookup = async (host, opts) => {
    assert.deepEqual(opts, { all: true });
    if (fail || host === "missing") throw new Error("ENOTFOUND");
    return [{ address: "::ffff:172.18.0.9", family: 6 }, { address: "fd00::9", family: 6 }];
  };
  const t = sec.createTrustedProxies(["cloudflared", "missing"], lookup);
  assert.equal(t.has("172.18.0.9"), false); // nothing before the first lookup
  assert.equal(await t.refresh(), 2);
  assert.equal(t.has("172.18.0.9"), true);
  assert.equal(t.has("::ffff:172.18.0.9"), true);
  assert.equal(t.has("fd00::9"), true);
  assert.equal(t.has("172.18.0.1"), false);
  fail = true;
  assert.equal(await t.refresh(), 0);
  assert.equal(t.has("172.18.0.9"), false); // stale addresses are dropped
});

test("emails in logs keep only the first two characters and the domain", () => {
  assert.equal(sec.maskEmail("Alice@Example.com"), "al***@example.com");
  assert.equal(sec.maskEmail("a@x.com"), "a***@x.com");
  assert.equal(sec.maskEmail(""), "(empty)");
  assert.equal(sec.maskEmail("nodomain"), "no***");
});
