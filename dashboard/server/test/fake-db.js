// In-memory stand-in for db.js with the same interface, for route tests without PostgreSQL.

function createFakeDb() {
  let nextId = 1;
  const users = [];
  const sessions = new Map();

  return {
    users,
    sessions,
    async init() {},
    async findUserByEmail(email) {
      const u = users.find((x) => x.email === email);
      return u ? { ...u } : null;
    },
    async createUser({ email, role, passwordHash, disabled = false }) {
      const user = { id: String(nextId++), email, role, password_hash: passwordHash, disabled, last_login_at: null };
      users.push(user);
      return { ...user };
    },
    async setPassword(userId, passwordHash) {
      const u = users.find((x) => x.id === userId);
      if (u) u.password_hash = passwordHash;
    },
    async disableUser(userId) {
      const u = users.find((x) => x.id === userId);
      if (u) u.disabled = true;
    },
    async recordLogin(userId, at) {
      const u = users.find((x) => x.id === userId);
      if (u) u.last_login_at = at;
    },
    async createSession({ idHash, userId, expiresAt, userAgent }) {
      sessions.set(idHash, { idHash, userId, expiresAt: new Date(expiresAt), userAgent });
    },
    async getSession(idHash) {
      const s = sessions.get(idHash);
      if (!s) return null;
      const u = users.find((x) => x.id === s.userId);
      if (!u) return null;
      return { idHash, expiresAt: s.expiresAt, user: { id: u.id, email: u.email, role: u.role, disabled: u.disabled } };
    },
    async renewSession(idHash, expiresAt) {
      const s = sessions.get(idHash);
      if (s) s.expiresAt = new Date(expiresAt);
    },
    async deleteSession(idHash) {
      sessions.delete(idHash);
    },
    async deleteUserSessions(userId) {
      for (const [k, s] of sessions) if (s.userId === userId) sessions.delete(k);
    },
    async deleteExpiredSessions(now) {
      let n = 0;
      for (const [k, s] of sessions) {
        if (s.expiresAt.getTime() <= new Date(now).getTime()) {
          sessions.delete(k);
          n++;
        }
      }
      return n;
    },
  };
}

module.exports = { createFakeDb };
