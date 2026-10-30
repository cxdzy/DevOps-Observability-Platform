// All SQL for users and sessions. Routes and scripts use only these functions, so tests can
// swap in an in-memory fake with the same interface (test/fake-db.js).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email <> ''),
  role text NOT NULL CHECK (role IN ('admin', 'viewer')),
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  disabled boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
`;

const USER_COLUMNS = "id, email, role, password_hash, disabled";

function createDb(pool) {
  async function one(text, params) {
    const { rows } = await pool.query(text, params);
    return rows[0] || null;
  }

  return {
    async init() {
      await pool.query(SCHEMA);
    },

    findUserByEmail(email) {
      return one(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [email]);
    },

    async createUser({ email, role, passwordHash }) {
      return one(
        `INSERT INTO users (email, role, password_hash) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
        [email, role, passwordHash]
      );
    },

    async setPassword(userId, passwordHash) {
      await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, passwordHash]);
    },

    async disableUser(userId) {
      await pool.query("UPDATE users SET disabled = true WHERE id = $1", [userId]);
    },

    async recordLogin(userId, at) {
      await pool.query("UPDATE users SET last_login_at = $2 WHERE id = $1", [userId, at]);
    },

    // createdAt comes from the app clock, the same clock that checks the absolute session limit.
    async createSession({ idHash, userId, createdAt, expiresAt, userAgent }) {
      await pool.query(
        "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES ($1, $2, $3, $4, $5)",
        [idHash, userId, createdAt, expiresAt, userAgent]
      );
    },

    // The session with its user, or null.
    async getSession(idHash) {
      const row = await one(
        `SELECT s.id, s.created_at, s.expires_at, u.id AS user_id, u.email, u.role, u.disabled
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1`,
        [idHash]
      );
      if (!row) return null;
      return {
        idHash: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        user: { id: row.user_id, email: row.email, role: row.role, disabled: row.disabled },
      };
    },

    async renewSession(idHash, expiresAt) {
      await pool.query("UPDATE sessions SET expires_at = $2 WHERE id = $1", [idHash, expiresAt]);
    },

    async deleteSession(idHash) {
      await pool.query("DELETE FROM sessions WHERE id = $1", [idHash]);
    },

    async deleteUserSessions(userId) {
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    },

    // Returns the number of rows removed.
    async deleteExpiredSessions(now) {
      const res = await pool.query("DELETE FROM sessions WHERE expires_at <= $1", [now]);
      return res.rowCount;
    },
  };
}

// True when the connection string parses the way pg will parse it. Never logs the value, which
// contains the password.
function isValidDatabaseUrl(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    // pg-connection-string parses with this base and then percent-decodes the user and password.
    const url = new URL(value, "postgres://base");
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return /^postgres(ql)?:$/.test(url.protocol) && url.hostname !== "" && url.hostname !== "base";
  } catch {
    return false;
  }
}

module.exports = { createDb, isValidDatabaseUrl, SCHEMA };
