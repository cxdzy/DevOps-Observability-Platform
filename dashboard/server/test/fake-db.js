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
    projects: SEED_PROJECTS.map((p) => ({ ...p, containers: [...p.containers], released: [], created_at: at, updated_at: at })),
    log: [{ id: 1, at, user_email: SEED_USER, action: "Imported", target: "registry", detail: "Built-in records added: server main, server old, project sample-service" }],
    nextLogId: 2,
    containerImages: [],
    detected: [],
    nextDetectedId: 1,
  };
}

function cloneRegistry(r) {
  return {
    servers: r.servers.map((s) => ({ ...s })),
    projects: r.projects.map((p) => ({ ...p, containers: [...p.containers], released: p.released.map((x) => ({ ...x })) })),
    log: r.log.map((l) => ({ ...l })),
    nextLogId: r.nextLogId,
    containerImages: r.containerImages.map((c) => ({ ...c })),
    detected: r.detected.map((d) => ({ ...d })),
    nextDetectedId: r.nextDetectedId,
  };
}

// Same unique rule as the project_containers table: a container name belongs to one project per
// server while its link is not released (released links are in p.released, not p.containers).
function checkContainers(r, projectKey, serverKey, names) {
  for (const name of names) {
    const taken = r.projects.some((x) => x.key !== projectKey && x.server_key === serverKey && x.containers.includes(name));
    if (taken) throw uniqueViolation("project_containers_live_idx");
  }
}

// Every link of a project (live and released), as { server_key, container_name }.
function linksOf(p) {
  return [...p.containers.map((name) => ({ server_key: p.server_key, container_name: name })), ...p.released.map((x) => ({ server_key: x.server_key, container_name: x.container_name }))];
}
// True when another project links this image row's container live.
function liveElsewhere(r, projectKey, ci) {
  return r.projects.some((o) => o.key !== projectKey && o.server_key === ci.server_key && o.containers.includes(ci.container_name));
}
function deleteCounts(r, projectKey) {
  const p = r.projects.find((x) => x.key === projectKey);
  if (!p) return { deployments: 0, links: 0, images: 0 };
  const mine = linksOf(p);
  return {
    deployments: r.detected.filter((d) => d.project_key === projectKey).length,
    links: mine.length,
    images: r.containerImages.filter((ci) => mine.some((l) => l.server_key === ci.server_key && l.container_name === ci.container_name) && !liveElsewhere(r, projectKey, ci)).length,
  };
}

// The same operations as registryOps in db.js, with the same unique rules as the tables.
function registryOps(r, now) {
  const SERVER_EDITABLE = ["role", "location", "address", "status"];
  const PROJECT_EDITABLE = ["repo_url", "status", "rollback"];
  return {
    async listServers() {
      return r.servers.map((s) => ({ ...s }));
    },
    async listProjects() {
      return r.projects.map(({ released, ...p }) => ({ ...p, containers: [...p.containers].sort() }));
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
      r.projects.push({ builtin: false, rollback: "none", ...row, containers: [...(containers || [])], released: [], created_at: now(), updated_at: now() });
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
      // Like the table: dropped links are released, not deleted; a re-added name is taken back.
      const at = now();
      for (const name of p.containers) if (!names.includes(name)) p.released.push({ container_name: name, server_key: serverKey, released_at: at });
      p.released = p.released.filter((x) => !names.includes(x.container_name));
      p.containers = [...names];
    },
    async listContainerLinks(projectKey) {
      const p = r.projects.find((x) => x.key === projectKey);
      if (!p) return [];
      const live = p.containers.map((name) => ({ project_key: p.key, container_name: name, server_key: p.server_key, released_at: null }));
      const gone = p.released.map((x) => ({ project_key: p.key, ...x }));
      return [...live, ...gone].sort((a, b) => a.container_name.localeCompare(b.container_name));
    },
    // The image watcher's tables. Detections can only be inserted, like the real table.
    async listContainerImages() {
      return r.containerImages.map((c) => ({ ...c }));
    },
    async upsertContainerImage({ serverKey, containerName, image, seenAt }) {
      const row = r.containerImages.find((c) => c.server_key === serverKey && c.container_name === containerName);
      if (row) Object.assign(row, { image, seen_at: seenAt || now() });
      else r.containerImages.push({ server_key: serverKey, container_name: containerName, image, seen_at: seenAt || now() });
    },
    async insertDetectedDeployment({ projectKey, serverKey, containerName, oldImage, newImage, detectedAt }) {
      r.detected.push({
        id: r.nextDetectedId++,
        project_key: projectKey,
        server_key: serverKey,
        container_name: containerName,
        old_image: oldImage,
        new_image: newImage,
        detected_at: detectedAt || now(),
      });
    },
    async listDetectedDeployments(projectKey, since, limit) {
      const cutoff = since ? new Date(since).getTime() : null;
      const rows = r.detected
        .filter((d) => d.project_key === projectKey && (cutoff === null || new Date(d.detected_at).getTime() > cutoff))
        .sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at) || b.id - a.id);
      return (limit ? rows.slice(0, limit) : rows).map((d) => ({ ...d }));
    },
    // Permanent delete, with the same rules and counts as db.js.
    async projectDeleteCounts(projectKey) {
      return deleteCounts(r, projectKey);
    },
    async deleteProject(projectKey) {
      const p = r.projects.find((x) => x.key === projectKey);
      if (!p) return { deployments: 0, links: 0, images: 0 };
      const counts = deleteCounts(r, projectKey);
      const mine = linksOf(p);
      r.containerImages = r.containerImages.filter(
        (ci) => !(mine.some((l) => l.server_key === ci.server_key && l.container_name === ci.container_name) && !liveElsewhere(r, projectKey, ci))
      );
      r.detected = r.detected.filter((d) => d.project_key !== projectKey);
      r.projects = r.projects.filter((x) => x.key !== projectKey);
      return counts;
    },
    async serverDeleteCounts(serverKey) {
      return { images: r.containerImages.filter((c) => c.server_key === serverKey).length };
    },
    async deleteServer(serverKey) {
      const images = r.containerImages.filter((c) => c.server_key === serverKey).length;
      r.containerImages = r.containerImages.filter((c) => c.server_key !== serverKey);
      r.servers = r.servers.filter((s) => s.key !== serverKey);
      return { images };
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
  let watcherBusy = false;
  const now = () => new Date();
  // forecast_events, with the same open row rule as forecast_events_open_idx.
  const forecastEvents = [];
  let nextForecastId = 1;
  const forecastKey = (e) => [e.resource, e.server, e.container || "", e.mountpoint || ""].join("|");
  const copyEvent = (e) => ({ ...e });

  // The user operations of registryOps in db.js, with the same rules (unique email, fixed columns).
  const USER_EDITABLE = ["role", "disabled", "password_hash", "must_change_password"];
  const userRow = (u) => ({ ...u });
  const userOps = {
    async listUsers(at) {
      const t = new Date(at).getTime();
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        disabled: u.disabled,
        must_change_password: u.must_change_password,
        created_at: u.created_at,
        last_login_at: u.last_login_at,
        has_password: u.password_hash !== null && u.password_hash !== undefined,
        sessions: [...sessions.values()].filter((s) => s.userId === u.id && s.expiresAt.getTime() > t).length,
      }));
    },
    async findUserById(id) {
      const u = users.find((x) => x.id === String(id));
      return u ? userRow(u) : null;
    },
    async findUserByEmail(email) {
      const u = users.find((x) => x.email === email);
      return u ? userRow(u) : null;
    },
    async insertUser({ email, role, passwordHash, mustChangePassword }) {
      if (users.some((x) => x.email === email)) throw uniqueViolation("users_email_key");
      const user = { id: String(nextId++), email, role, password_hash: passwordHash, disabled: false, must_change_password: Boolean(mustChangePassword), created_at: now(), last_login_at: null };
      users.push(user);
      return userRow(user);
    },
    async updateUser(id, patch) {
      const u = users.find((x) => x.id === String(id));
      if (!u) return;
      for (const c of Object.keys(patch)) if (USER_EDITABLE.includes(c)) u[c] = patch[c];
    },
    async countActiveAdmins() {
      return users.filter((u) => u.role === "admin" && !u.disabled).length;
    },
    async endUserSessions(userId, keepIdHash = null) {
      let n = 0;
      for (const [k, s] of sessions) {
        if (s.userId === String(userId) && k !== keepIdHash) {
          sessions.delete(k);
          n++;
        }
      }
      return n;
    },
  };

  return {
    listUsers: userOps.listUsers,
    findUserById: userOps.findUserById,
    users,
    forecastEvents,
    async listOpenForecastEvents() {
      return forecastEvents.filter((e) => e.closed_at === null).map(copyEvent);
    },
    async insertForecastEvent(e) {
      const key = forecastKey(e);
      const open = forecastEvents.find((x) => x.closed_at === null && forecastKey(x) === key);
      if (open) return copyEvent(open);
      const row = {
        id: String(nextForecastId++),
        resource: e.resource,
        server: e.server,
        project: e.project ?? null,
        container: e.container ?? null,
        mountpoint: e.mountpoint ?? null,
        opened_at: new Date(e.openedAt),
        closed_at: null,
        close_reason: null,
        est_minutes_at_open: e.estMinutes ?? null,
        est_minutes_latest: e.estMinutes ?? null,
        limit_value: e.limitValue ?? null,
        level_at_open: e.level ?? null,
        slope_per_min: e.slope ?? null,
        r2: e.r2 ?? null,
        window_min: e.windowMin ?? null,
        config_version: e.configVersion,
      };
      forecastEvents.push(row);
      return copyEvent(row);
    },
    async updateForecastEstimate(id, estMinutes) {
      const row = forecastEvents.find((x) => x.id === String(id) && x.closed_at === null);
      if (row) row.est_minutes_latest = estMinutes;
    },
    async closeForecastEvent(id, closedAt, reason, estMinutes) {
      const row = forecastEvents.find((x) => x.id === String(id) && x.closed_at === null);
      if (!row) return;
      row.closed_at = new Date(closedAt);
      row.close_reason = reason;
      if (estMinutes !== null && estMinutes !== undefined) row.est_minutes_latest = estMinutes;
    },
    async listForecastEvents(from, to, limit) {
      const f = new Date(from).getTime();
      const t = new Date(to).getTime();
      return forecastEvents
        .filter((e) => e.opened_at.getTime() < t && (e.closed_at === null || e.closed_at.getTime() >= f))
        .sort((a, b) => a.opened_at - b.opened_at || Number(a.id) - Number(b.id))
        .slice(0, limit)
        .map(copyEvent);
    },
    async listNewForecastEvents(since, limit, afterId = null) {
      const s = new Date(since).getTime();
      return forecastEvents
        .filter((e) => e.opened_at.getTime() > s || (afterId !== null && e.opened_at.getTime() === s && Number(e.id) > Number(afterId)))
        .sort((a, b) => a.opened_at - b.opened_at || Number(a.id) - Number(b.id))
        .slice(0, limit)
        .map(copyEvent);
    },
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
    async projectDeleteCounts(key) {
      return registryOps(registry, now).projectDeleteCounts(key);
    },
    async serverDeleteCounts(key) {
      return registryOps(registry, now).serverDeleteCounts(key);
    },
    async listDetectedDeployments(projectKey, since, limit) {
      return registryOps(registry, now).listDetectedDeployments(projectKey, since, limit);
    },
    // Like the real one: a second caller while the lock is held gets { locked: false } at once. The
    // work runs on a copy, and only the watcher's two tables are kept when it finishes without
    // error, so a registry change committed meanwhile is not lost (the lock does not block those).
    async withWatcherLock(fn) {
      if (watcherBusy) return { locked: false };
      watcherBusy = true;
      try {
        const copy = cloneRegistry(registry);
        const value = await fn(registryOps(copy, now));
        registry = { ...registry, containerImages: copy.containerImages, detected: copy.detected, nextDetectedId: copy.nextDetectedId };
        return { locked: true, value };
      } finally {
        watcherBusy = false;
      }
    },
    // Runs fn(ops) on a copy of the registry; the copy is kept only when fn finishes without error.
    // Users and sessions are changed in place and put back as they were when fn throws.
    async transaction(fn) {
      const copy = cloneRegistry(registry);
      const savedUsers = users.map((u) => ({ ...u }));
      const savedSessions = [...sessions].map(([k, s]) => [k, { ...s }]);
      try {
        const result = await fn({ ...registryOps(copy, now), ...userOps });
        registry = copy;
        return result;
      } catch (err) {
        users.splice(0, users.length, ...savedUsers);
        sessions.clear();
        for (const [k, s] of savedSessions) sessions.set(k, s);
        throw err;
      }
    },
    async findUserByEmail(email) {
      const u = users.find((x) => x.email === email);
      return u ? { ...u } : null;
    },
    async createUser({ email, role, passwordHash, disabled = false, mustChangePassword = false }) {
      if (users.some((x) => x.email === email)) throw uniqueViolation("users_email_key");
      const user = { id: String(nextId++), email, role, password_hash: passwordHash, disabled, must_change_password: Boolean(mustChangePassword), created_at: now(), last_login_at: null };
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
      return { idHash, createdAt: s.createdAt, expiresAt: s.expiresAt, user: { id: u.id, email: u.email, role: u.role, disabled: u.disabled, mustChangePassword: u.must_change_password === true } };
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
