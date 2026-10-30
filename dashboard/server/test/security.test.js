const test = require("node:test");
const assert = require("node:assert/strict");
const sec = require("../security");

test("origin check needs an exact match and rejects a missing origin", () => {
  const app = "http://localhost:3100";
  assert.equal(sec.originAllowed("http://localhost:3100", app), true);
  for (const bad of [undefined, "", "null", "http://127.0.0.1:3100", "http://localhost:3100/", "https://localhost:3100", "http://localhost:31000", "http://evil.example"]) {
    assert.equal(sec.originAllowed(bad, app), false, String(bad));
  }
});

test("rate limit keys: email is trimmed and lowercased, IP and email both count", () => {
  assert.equal(sec.loginIpEmailKey("1.2.3.4", "  Alice@Example.COM "), sec.loginIpEmailKey("1.2.3.4", "alice@example.com"));
  assert.notEqual(sec.loginIpEmailKey("1.2.3.4", "a@x.com"), sec.loginIpEmailKey("1.2.3.4", "b@x.com"));
  assert.notEqual(sec.loginIpEmailKey("1.2.3.4", "a@x.com"), sec.loginIpEmailKey("1.2.3.5", "a@x.com"));
  assert.equal(sec.loginIpKey("1.2.3.4"), "1.2.3.4");
  // IPv6 addresses in the same /56 share a key, so rotating addresses does not help.
  assert.equal(sec.loginIpKey("2001:db8:0:1::1"), sec.loginIpKey("2001:db8:0:2::9"));
  assert.notEqual(sec.loginIpKey("2001:db8:0:100::1"), sec.loginIpKey("2001:db8:0:1::1"));
  assert.equal(sec.loginIpEmailKey("1.2.3.4", undefined), "1.2.3.4|");
});

test("CF-Connecting-IP is used only when a proxy is trusted and the value is an IP", () => {
  const req = (cf) => ({ ip: "10.0.0.1", headers: cf === undefined ? {} : { "cf-connecting-ip": cf } });
  assert.equal(sec.clientIp(req("203.0.113.7"), 1), "203.0.113.7");
  assert.equal(sec.clientIp(req("203.0.113.7"), false), "10.0.0.1");
  assert.equal(sec.clientIp(req(undefined), 1), "10.0.0.1");
  assert.equal(sec.clientIp(req("not-an-ip"), 1), "10.0.0.1");
});

test("TRUST_PROXY parsing", () => {
  assert.equal(sec.parseTrustProxy(undefined), 1);
  assert.equal(sec.parseTrustProxy("1"), 1);
  assert.equal(sec.parseTrustProxy("2"), 2);
  assert.equal(sec.parseTrustProxy("0"), false);
  assert.equal(sec.parseTrustProxy("false"), false);
  assert.equal(sec.parseTrustProxy(""), false);
  assert.equal(sec.parseTrustProxy("true"), 1);
  assert.equal(sec.parseTrustProxy("junk"), 1);
});

test("emails in logs keep only the first two characters and the domain", () => {
  assert.equal(sec.maskEmail("Alice@Example.com"), "al***@example.com");
  assert.equal(sec.maskEmail("a@x.com"), "a***@x.com");
  assert.equal(sec.maskEmail(""), "(empty)");
  assert.equal(sec.maskEmail("nodomain"), "no***");
});
