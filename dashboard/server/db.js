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

CREATE TABLE IF NOT EXISTS servers (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]{1,30}$'),
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('platform', 'staging', 'application')),
  location text NOT NULL CHECK (char_length(location) <= 60),
  address text,
  builtin boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('pending', 'active', 'archived')),
  node_job text NOT NULL,
  cadvisor_job text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS servers_name_idx ON servers (name);
CREATE UNIQUE INDEX IF NOT EXISTS servers_address_idx ON servers (address) WHERE address IS NOT NULL AND status <> 'archived';
CREATE TABLE IF NOT EXISTS projects (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]{1,30}$'),
  name text NOT NULL UNIQUE,
  server_key text NOT NULL REFERENCES servers(key),
  repo_url text CHECK (repo_url IS NULL OR (repo_url ~ '^https://' AND char_length(repo_url) <= 200)),
  deploy_source text NOT NULL CHECK (deploy_source IN ('ci', 'image')),
  automation text NOT NULL CHECK (automation IN ('approval', 'monitored')),
  builtin boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_containers (
  project_key text NOT NULL REFERENCES projects(key),
  container_name text NOT NULL CHECK (container_name ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'),
  server_key text NOT NULL REFERENCES servers(key),
  released_at timestamptz,
  PRIMARY KEY (project_key, container_name)
);
-- Links are never deleted: archiving a project sets released_at. A container belongs to one
-- project per server only while its link is not released. Databases made before this change had
-- UNIQUE (server_key, container_name); it is dropped once, only if it exists.
ALTER TABLE project_containers ADD COLUMN IF NOT EXISTS released_at timestamptz;
DO $
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'project_containers'::regclass AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE project_containers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$;
CREATE UNIQUE INDEX IF NOT EXISTS project_containers_live_idx
  ON project_containers (server_key, container_name) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS settings_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_email text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  detail text NOT NULL DEFAULT ''
);
CREATE OR REPLACE FUNCTION settings_log_readonly() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'settings_log rows are never updated or deleted';
END;
$$ LANGUAGE plpgsql;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'settings_log_readonly' AND tgrelid = 'settings_log'::regclass) THEN
    CREATE TRIGGER settings_log_readonly BEFORE UPDATE OR DELETE ON settings_log
      FOR EACH ROW EXECUTE FUNCTION settings_log_readonly();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'settings_log_no_truncate' AND tgrelid = 'settings_log'::regclass) THEN
    CREATE TRIGGER settings_log_no_truncate BEFORE TRUNCATE ON settings_log
      FOR EACH STATEMENT EXECUTE FUNCTION settings_log_readonly();
  END IF;
END
$$;
`;

// The records the registry starts with. Written on start when missing (and logged once as
// "Imported"). The keys main and old stay because earlier hashes and queries use them.
const SEED_SERVERS = Object.freeze([
  Object.freeze({ key: "main", name: "fyp-main", role: "platform", location: "Tencent Cloud, Singapore", address: null, builtin: true, status: "active", node_job: "node-exporter", cadvisor_job: "cadvisor" }),
  Object.freeze({ key: "old", name: "staging", role: "staging", location: "Hetzner, Finland", address: null, builtin: true, status: "active", node_job: "node-exporter-old", cadvisor_job: "cadvisor-old" }),
]);
const SEED_PROJECTS = Object.freeze([
  Object.freeze({ key: "sample-service", name: "sample-service", server_key: "main", repo_url: null, deploy_source: "ci", automation: "approval", builtin: true, status: "active", containers: Object.freeze(["sample-service"]) }),
]);
const SEED_USER = "system";

const USER_COLUMNS = "id, email, role, password_hash, disabled";

const SERVER_COLUMNS = "key, name, role, location, address, builtin, status, node_job, cadvisor_job, created_at, updated_at";
// Columns a route may change. The names are fixed here, so they are never taken from a request.
const SERVER_EDITABLE = ["role", "location", "address", "status"];
const PROJECT_EDITABLE = ["repo_url", "status"];

// Registry reads and writes on one connection (a pool for reads, a client inside a transaction).
function registryOps(runner) {
  const q = (text, params) => runner.query(text, params);

  function update(table, key, patch, allowed) {
    const columns = Object.keys(patch).filter((c) => allowed.includes(c));
    if (!columns.length) return Promise.resolve();
    const sets = columns.map((c, i) => `${c} = $${i + 2}`);
    return q(`UPDATE ${table} SET ${sets.join(", ")}, updated_at = now() WHERE key = $1`, [key, ...columns.map((c) => patch[c])]);
  }

  // Links a container to a project. A link released earlier for the same project is taken back.
  async function addContainers(projectKey, serverKey, names) {
    for (const name of names) {
      await q(
        `INSERT INTO project_containers (project_key, container_name, server_key) VALUES ($1, $2, $3)
         ON CONFLICT (project_key, container_name) DO UPDATE SET server_key = EXCLUDED.server_key, released_at = NULL`,
        [projectKey, name, serverKey]
      );
    }
  }

  return {
    async listServers() {
      return (await q(`SELECT ${SERVER_COLUMNS} FROM servers ORDER BY created_at, key`)).rows;
    },
    async listProjects() {
      return (
        await q(
          `SELECT p.key, p.name, p.server_key, p.repo_url, p.deploy_source, p.automation, p.builtin, p.status, p.created_at, p.updated_at,
                  COALESCE(array_agg(c.container_name ORDER BY c.container_name) FILTER (WHERE c.container_name IS NOT NULL), '{}') AS containers
             FROM projects p LEFT JOIN project_containers c ON c.project_key = p.key AND c.released_at IS NULL
            GROUP BY p.key ORDER BY p.created_at, p.key`
        )
      ).rows;
    },
    async insertServer(s) {
      await q(
        `INSERT INTO servers (key, name, role, location, address, builtin, status, node_job, cadvisor_job)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [s.key, s.name, s.role, s.location, s.address, Boolean(s.builtin), s.status, s.node_job, s.cadvisor_job]
      );
    },
    updateServer(key, patch) {
      return update("servers", key, patch, SERVER_EDITABLE);
    },
    async insertProject(p) {
      await q(
        `INSERT INTO projects (key, name, server_key, repo_url, deploy_source, automation, builtin, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [p.key, p.name, p.server_key, p.repo_url, p.deploy_source, p.automation, Boolean(p.builtin), p.status]
      );
      await addContainers(p.key, p.server_key, p.containers || []);
    },
    updateProject(key, patch) {
      return update("projects", key, patch, PROJECT_EDITABLE);
    },
    // Sets the live container links of a project. Links that are no longer wanted are released
    // (released_at set), never deleted, so an empty list releases them all.
    async setContainers(projectKey, serverKey, names) {
      await q(
        "UPDATE project_containers SET released_at = now() WHERE project_key = $1 AND released_at IS NULL AND NOT (container_name = ANY($2::text[]))",
        [projectKey, names]
      );
      await addContainers(projectKey, serverKey, names);
    },
    // Every link of a project, released ones included, oldest first. For tests and audits.
    async listContainerLinks(projectKey) {
      return (
        await q("SELECT project_key, container_name, server_key, released_at FROM project_containers WHERE project_key = $1 ORDER BY container_name", [projectKey])
      ).rows;
    },
    // The only write to settings_log is this insert. There is no update or delete anywhere.
    async insertLog({ userEmail, action, target, detail }) {
      await q("INSERT INTO settings_log (user_email, action, target, detail) VALUES ($1, $2, $3, $4)", [userEmail, action, target, detail || ""]);
    },
    async listLog(limit) {
      return (await q("SELECT id, at, user_email, action, target, detail FROM settings_log ORDER BY id DESC LIMIT $1", [limit])).rows;
    },
  };
}

// Inserts the built-in records that are missing and logs one "Imported" row when it added any.
async function seedRegistry(ops) {
  const have = new Set((await ops.listServers()).map((s) => s.key));
  const haveProjects = new Set((await ops.listProjects()).map((p) => p.key));
  const added = [];
  for (const s of SEED_SERVERS) {
    if (!have.has(s.key)) {
      await ops.insertServer(s);
      added.push(`server ${s.key}`);
    }
  }
  for (const p of SEED_PROJECTS) {
    if (!haveProjects.has(p.key)) {
      await ops.insertProject(p);
      added.push(`project ${p.key}`);
    }
  }
  if (added.length) {
    await ops.insertLog({ userEmail: SEED_USER, action: "Imported", target: "registry", detail: `Built-in records added: ${added.join(", ")}` });
  }
}

// Lock id for the advisory lock that makes registry writes run one at a time.
const REGISTRY_LOCK = 7351001;

function createDb(pool) {
  async function one(text, params) {
    const { rows } = await pool.query(text, params);
    return rows[0] || null;
  }

  // Runs fn(ops, client) in one transaction. Any error rolls everything back, so a change and its
  // settings_log row are saved together or not at all.
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [REGISTRY_LOCK]);
      const result = await fn(registryOps(client), client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original error is the one that matters.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  const reads = registryOps(pool);

  return {
    // The schema and the seed run in one transaction under the registry lock, so two processes
    // starting at the same time on an empty database do not race on CREATE TABLE or the triggers,
    // and the second one finds the seed rows and adds nothing. Every statement is safe to repeat.
    async init() {
      await transaction(async (ops, client) => {
        await client.query(SCHEMA);
        await seedRegistry(ops);
      });
    },

    transaction,
    listServers: reads.listServers,
    listProjects: reads.listProjects,
    listLog: reads.listLog,

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

module.exports = { createDb, isValidDatabaseUrl, SCHEMA, SEED_SERVERS, SEED_PROJECTS, SEED_USER };
