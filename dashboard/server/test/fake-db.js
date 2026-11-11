// In-memory stand-in for db.js with the same interface, for route tests without PostgreSQL.
const { SEED_SERVERS, SEED_PROJECTS, SEED_USER } = require("../db");

// A unique violation, as pg reports it.
function uniqueViolation(what) {
  const err = new Error(`duplicate key value violates unique constraint (${what})`);
  err.code = "23505";
  return err;
}

// The registry tables as plain arrays. A transaction works on its own copy, which replaces the
// real state only on commit, so a rollback is simply dropping the copy.
function seedRegistry() {
  const at = new Date(Date.UTC(2026, 9, 1));
  return {
    servers: SEED_SERVERS.map((s) => ({ ...s, created_at: at, updated_at: at })),
    projects: SEED_PROJECTS.map((p) => ({ ...p, containers: [...p.containers], created_at: at, updated_at: at })),
    log: [{ id: 1, at, user_email: SEED_USER, action: "Imported", target: "registry", detail: "Built-in records added: server main, server old, project sample-service" }],
    nextLogId: 2,
  };
}

function cloneRegistry(r) {
  return {
    servers: r.servers.map((s) => ({ ...s })),
    projects: r.projects.map((p) => ({ ...p, containers: [...p.containers] })),
    log: r.log.map((l) => ({ ...l })),
    nextLogId: r.nextLogId,
  };
}

// Same unique rule as the project_containers table: a container name belongs to one project per server.
function checkContainers(r, projectKey, serverKey, names) {
  for (const name of names) {
    const taken = r.projects.some((x) => x.key !== projectKey && x.server_key === serverKey && x.containers.includes(name));
    if (taken) throw uniqueViolation("project_containers_server_key_container_name_key");
  }
}

// The same operations as registryOps in db.js, with the same unique rules as the tables.
function registryOps(r, now) {
  const SERVER_EDITABLE = ["role", "location", "address", "status"];
  const PROJECT_EDITABLE = ["repo_url", "status"];
  return {
    async listServers() {
      return r.servers.map((s) => ({ ...s }));
    },
    async listProjects() {
      return r.projects.map((p) => ({ ...p, containers: [...p.containers].sort() }));
    },
    async insertServer(s) {
      if (r.servers.some((x) => x.key === s.key)) throw uniqueViolation("servers_pkey");
      if (r.servers.some((x) => x.name === s.name)) throw uniqueViolation("servers_name_idx");
      if (s.address && s.status !== "archived" && r.servers.some((x) => x.address === s.address && x.status !== "archived")) {
        throw uniqueViolation("servers_address_idx");
      }
      r.servers.push({ builtin: false, ...s, created_at: now(), updated_at: now() });
    },
    async updateServer(key, patch) {
      const s = r.servers.find((x) => x.key === key);
      if (!s) return;
      const next = { ...s };
      for (const c of Object.keys(patch)) if (SERVER_EDITABLE.includes(c)) next[c] = patch[c];
      if (next.address && next.status !== "archived" && r.servers.some((x) => x !== s && x.address === next.address && x.status !== "archived")) {
        throw uniqueViolation("servers_address_idx");
      }
      Object.assign(s, next, { updated_at: now() });
    },
    async insertProject(p) {
      if (r.projects.some((x) => x.key === p.key || x.name === p.name)) throw uniqueViolation("projects_pkey");
      checkContainers(r, p.key, p.server_key, p.containers || []);
      const { containers, ...row } = p;
      r.projects.push({ builtin: false, ...row, containers: [...(containers || [])], created_at: now(), updated_at: now() });
    },
    async updateProject(key, patch) {
      const p = r.projects.find((x) => x.key === key);
      if (!p) return;
      for (const c of Object.keys(patch)) if (PROJECT_EDITABLE.includes(c)) p[c] = patch[c];
      p.updated_at = now();
    },
    async setContainers(projectKey, serverKey, names) {
      const p = r.projects.find((x) => x.key === projectKey);
      if (!p) return;
      checkContainers(r, projectKey, serverKey, names);
      p.containers = [...names];
    },
    async insertLog({ userEmail, action, target, detail }) {
      r.log.push({ id: r.nextLogId++, at: now(), user_email: userEmail, action, target, detail: detail || "" });
    },
    async listLog(limit) {
      return r.log.slice().reverse().slice(0, limit).map((l) => ({ ...l }));
    },
  };
}

function createFakeDb() {
  let nextId = 1;
  const users = [];
  const sessions = new Map();
  let registry = seedRegistry();
  const now = () => new Date();

  return {
    users,
    sessions,
    // The registry tables, for tests that check what was stored.
    get registry() {
      return registry;
    },
    async init() {},
    async listServers() {
      return registryOps(registry, now).listServers();
    },
    async listProjects() {
      return registryOps(registry, now).listProjects();
    },
    async listLog(limit) {
      return registryOps(registry, now).listLog(limit);
    },
    // Runs fn(ops) on a copy of the registry; the copy is kept only when fn finishes without error.
    async transaction(fn) {
      const copy = cloneRegistry(registry);
      const result = await fn(registryOps(copy, now));
      registry = copy;
      return result;
    },
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
    async createSession({ idHash, userId, createdAt, expiresAt, userAgent }) {
      sessions.set(idHash, { idHash, userId, createdAt: new Date(createdAt), expiresAt: new Date(expiresAt), userAgent });
    },
    async getSession(idHash) {
      const s = sessions.get(idHash);
      if (!s) return null;
      const u = users.find((x) => x.id === s.userId);
      if (!u) return null;
      return { idHash, createdAt: s.createdAt, expiresAt: s.expiresAt, user: { id: u.id, email: u.email, role: u.role, disabled: u.disabled } };
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
