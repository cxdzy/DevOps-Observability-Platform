// Runs db.js against a real PostgreSQL when TEST_DATABASE_URL is set; skipped otherwise.
// Use a throwaway database: the tables are emptied first.
const test = require("node:test");
const assert = require("node:assert/strict");

const url = process.env.TEST_DATABASE_URL;
const opts = { skip: url ? false : "TEST_DATABASE_URL is not set" };

test("db.js against PostgreSQL", opts, async (t) => {
  const { Pool } = require("pg");
  const { createDb } = require("../db");
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());
  const db = createDb(pool);

  await db.init();
  await db.init(); // CREATE TABLE IF NOT EXISTS is safe to repeat
  await pool.query("TRUNCATE sessions, users RESTART IDENTITY CASCADE");

  const user = await db.createUser({ email: "ann@example.com", role: "viewer", passwordHash: "h1" });
  assert.equal(user.email, "ann@example.com");
  assert.equal(user.disabled, false);
  assert.deepEqual(await db.findUserByEmail("ann@example.com"), user);
  assert.equal(await db.findUserByEmail("nobody@example.com"), null);

  // Constraints: lowercase unique email, known roles only.
  await assert.rejects(db.createUser({ email: "ann@example.com", role: "viewer", passwordHash: null }), /unique/i);
  await assert.rejects(db.createUser({ email: "Ann2@example.com", role: "viewer", passwordHash: null }), /check/i);
  await assert.rejects(db.createUser({ email: "bob@example.com", role: "root", passwordHash: null }), /check/i);
  const google = await db.createUser({ email: "gail@example.com", role: "admin", passwordHash: null });
  assert.equal(google.password_hash, null);

  const t0 = new Date("2026-10-30T08:00:00Z");
  const later = new Date("2026-10-30T16:00:00Z");
  await db.createSession({ idHash: "a".repeat(64), userId: user.id, createdAt: t0, expiresAt: later, userAgent: "test" });
  await db.createSession({ idHash: "b".repeat(64), userId: user.id, createdAt: t0, expiresAt: t0, userAgent: null });
  const s = await db.getSession("a".repeat(64));
  assert.equal(new Date(s.expiresAt).getTime(), later.getTime());
  // created_at comes from the app clock, which the absolute session limit is measured against.
  assert.equal(new Date(s.createdAt).getTime(), t0.getTime());
  assert.deepEqual(s.user, { id: user.id, email: "ann@example.com", role: "viewer", disabled: false });

  const renewed = new Date("2026-10-30T17:00:00Z");
  await db.renewSession("a".repeat(64), renewed);
  assert.equal(new Date((await db.getSession("a".repeat(64))).expiresAt).getTime(), renewed.getTime());

  assert.equal(await db.deleteExpiredSessions(t0), 1);
  assert.equal(await db.getSession("b".repeat(64)), null);

  await db.recordLogin(user.id, t0);
  const { rows } = await pool.query("SELECT last_login_at FROM users WHERE id = $1", [user.id]);
  assert.equal(new Date(rows[0].last_login_at).getTime(), t0.getTime());

  await db.setPassword(user.id, "h2");
  assert.equal((await db.findUserByEmail("ann@example.com")).password_hash, "h2");

  await db.disableUser(user.id);
  assert.equal((await db.getSession("a".repeat(64))).user.disabled, true);
  await db.deleteUserSessions(user.id);
  assert.equal(await db.getSession("a".repeat(64)), null);

  await db.deleteSession("nope");
});
