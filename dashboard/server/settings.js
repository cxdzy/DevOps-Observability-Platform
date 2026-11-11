// Settings routes (admin only): servers and projects of the registry, and the change log.
// Every write runs in one database transaction together with its settings_log row, so a change
// is saved with its log entry or not at all. There is no DELETE route; records are archived.
// Errors are JSON { error: "<sentence>", field?: "<name>" } so the client can show them next to
// the field they belong to.
const express = require("express");
const { createPrometheus } = require("./prometheus");
const { originAllowed } = require("./security");
const {
  KEY_RE,
  normaliseName,
  nameProblem,
  roleProblem,
  locationProblem,
  addressProblem,
  repoUrlProblem,
  containersProblem,
} = require("./registry");

// Image versions for the commands shown in the Add server wizard. They must match the versions
// on fyp-main in docker-compose.yml (node-exporter and cadvisor), so every server runs the same.
const NODE_EXPORTER_IMAGE = "prom/node-exporter:v1.8.2";
const CADVISOR_IMAGE = "ghcr.io/google/cadvisor:0.60.5";

// The container_name values in docker-compose.yml (read once when this was written, not at
// runtime). They run on the platform server and cannot be given to a project.
const PLATFORM_CONTAINERS = Object.freeze([
  "node-exporter",
  "cadvisor",
  "influxdb",
  "fyp-postgres",
  "mlflow",
  "ollama",
  "worker",
  "explainer",
  "prometheus",
  "grafana",
  "cloudflared",
  "n8n",
  "docker-socket-proxy",
  "dashboard",
]);

// The names a project cannot take on this server. The platform runs on main, so main keeps the
// list even if its role is edited, and any other server with the platform role gets it too.
function platformNames(server) {
  return server.key === "main" || server.role === "platform" ? new Set(PLATFORM_CONTAINERS) : new Set();
}

const LOG_LIMITS = Object.freeze([50, 200]);
const NOT_REACHABLE = "Prometheus is not reachable.";

// A failed request check, sent as a JSON error body.
class ApiError extends Error {
  constructor(status, error, field) {
    super(error);
    this.status = status;
    this.field = field;
  }
}

function fail(status, problem) {
  return new ApiError(status, problem.error, problem.field);
}

// The queries the settings routes send: the up flag, the time of the last sample and the container
// names of one server, all built from the registry's selectors. Only these strings are allowed.
function queriesFor(server) {
  return {
    nodeUp: `up{${server.nodeSel}}`,
    nodeSeen: `timestamp(up{${server.nodeSel}})`,
    cadvisorUp: `up{${server.cadvisorSel}}`,
    cadvisorSeen: `timestamp(up{${server.cadvisorSel}})`,
    names: `sum by (name) (container_memory_working_set_bytes{${server.cadvisorSel},name!=""})`,
  };
}

// The two docker run commands for a server. address is already validated as a Tailscale IPv4
// address, so it is the only value put into the text.
function commandFor(address) {
  return [
    "docker run -d --name node-exporter --restart unless-stopped \\",
    "  --net host --pid host -v /:/host:ro,rslave \\",
    `  ${NODE_EXPORTER_IMAGE} \\`,
    `  --path.rootfs=/host --web.listen-address=${address}:9100`,
    "",
    "docker run -d --name cadvisor --restart unless-stopped \\",
    `  -p ${address}:8080:8080 --privileged --device /dev/kmsg \\`,
    "  -v /:/rootfs:ro -v /var/run:/var/run:ro -v /sys:/sys:ro \\",
    "  -v /var/lib/docker/:/var/lib/docker:ro \\",
    `  ${CADVISOR_IMAGE}`,
  ].join("\n");
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

// The server as the API returns it. up is { nodeUp, cadvisorUp, lastSeen } or left out.
function serverView(row, up = {}) {
  return {
    key: row.key,
    name: row.name,
    role: row.role,
    location: row.location,
    address: row.address || null,
    builtin: Boolean(row.builtin),
    status: row.status,
    nodeUp: up.nodeUp === undefined ? null : up.nodeUp,
    cadvisorUp: up.cadvisorUp === undefined ? null : up.cadvisorUp,
    lastSeen: up.lastSeen || null,
  };
}

function projectView(row, serversByKey) {
  const server = serversByKey.get(row.server_key);
  return {
    key: row.key,
    name: row.name,
    server_key: row.server_key,
    server_name: server ? server.name : row.server_key,
    repo_url: row.repo_url || null,
    deploy_source: row.deploy_source,
    automation: row.automation,
    builtin: Boolean(row.builtin),
    status: row.status,
    containers: [...(row.containers || [])],
  };
}

// deps: { auth, db, registry, prometheus, appOrigin, now }. prometheus is optional and lets tests
// pass a client; the default one follows the registry.
function createSettingsRouter({ auth, db, registry, prometheus, appOrigin }) {
  const allowed = registry.derived((snap) =>
    snap.servers.filter((s) => s.status !== "archived").flatMap((s) => Object.values(queriesFor(s)))
  );
  const prom = prometheus || createPrometheus({ allowed });

  const router = express.Router();
  router.use(auth.requireRole("admin"));

  // The same rule as the other state-changing routes: a JSON content type and an exact Origin.
  function stateChanging(req, res, next) {
    if (!req.is("application/json")) return res.status(415).json({ error: "expected application/json" });
    if (!originAllowed(req.get("origin"), appOrigin)) return res.status(403).json({ error: "bad origin" });
    next();
  }
  const json = express.json({ limit: "16kb" });
  const write = [stateChanging, json];

  // Runs a handler and turns an ApiError or a unique violation into the JSON error body. Anything
  // else goes to the app's error handler (500, no details).
  const route = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = { error: err.message };
        if (err.field) body.field = err.field;
        return res.status(err.status).json(body);
      }
      if (err && err.code === "23505") {
        return res.status(409).json({ error: "Another record already uses this name, address or container." });
      }
      next(err);
    }
  };

  const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

  // Writes one change and its log row in one transaction, then refreshes the registry.
  async function commit(req, fn) {
    const email = req.user.email;
    const result = await db.transaction(async (ops) => {
      const outcome = await fn(ops);
      await ops.insertLog({ userEmail: email, ...outcome.log });
      return outcome.result;
    });
    await registry.reload();
    return result;
  }

  function findServer(servers, key) {
    const server = KEY_RE.test(String(key)) ? servers.find((s) => s.key === key) : null;
    if (!server) throw new ApiError(404, "Server not found.");
    return server;
  }

  function findProject(projects, key) {
    const project = KEY_RE.test(String(key)) ? projects.find((p) => p.key === key) : null;
    if (!project) throw new ApiError(404, "Project not found.");
    return project;
  }

  // The result of up{} and timestamp(up{}) for one selector pair, never throws.
  async function exporterState(upQuery, seenQuery) {
    try {
      const [upRows, seenRows] = await Promise.all([prom.query(upQuery), prom.query(seenQuery)]);
      if (!upRows.length) return { up: false, lastScrape: null, error: "Not added to Prometheus yet" };
      const up = upRows[0].value === 1;
      const seen = seenRows.length && Number.isFinite(seenRows[0].value) ? new Date(seenRows[0].value * 1000).toISOString() : null;
      return {
        up,
        lastScrape: seen,
        error: up ? null : "Prometheus cannot reach the exporter. Check that the command was run and that the address is right.",
      };
    } catch {
      return { up: false, lastScrape: null, error: "Prometheus is not reachable" };
    }
  }

  async function checkServer(server) {
    const q = queriesFor(server);
    const [node, cadvisor] = await Promise.all([
      exporterState(q.nodeUp, q.nodeSeen),
      exporterState(q.cadvisorUp, q.cadvisorSeen),
    ]);
    return { node, cadvisor };
  }

  // ---- Servers

  router.get("/servers", route(async (req, res) => {
    await registry.load();
    const rows = await db.listServers();
    const views = await Promise.all(
      rows.map(async (row) => {
        const server = registry.current().servers.find((s) => s.key === row.key);
        if (!server || row.status === "archived") return serverView(row);
        const q = queriesFor(server);
        const [nodeUp, cadvisorUp, seen] = await Promise.all([
          prom.query(q.nodeUp).then((r) => r.length > 0 && r[0].value === 1, () => null),
          prom.query(q.cadvisorUp).then((r) => r.length > 0 && r[0].value === 1, () => null),
          prom.query(q.nodeSeen).then((r) => (r.length && Number.isFinite(r[0].value) ? new Date(r[0].value * 1000).toISOString() : null), () => null),
        ]);
        return serverView(row, { nodeUp, cadvisorUp, lastSeen: seen });
      })
    );
    res.json(views);
  }));

  router.post("/servers", ...write, route(async (req, res) => {
    const body = bodyOf(req);
    const name = normaliseName(body.name);
    const address = body.address;
    const problem = nameProblem(name) || roleProblem(body.role) || locationProblem(body.location) || addressProblem(address);
    if (problem) throw fail(400, problem);
    const location = body.location.trim();

    const created = await commit(req, async (ops) => {
      const servers = await ops.listServers();
      if (servers.some((s) => s.key === name || s.name === name)) {
        throw new ApiError(409, "A server with this name already exists.", "name");
      }
      if (servers.some((s) => s.address === address && s.status !== "archived")) {
        throw new ApiError(409, "Another server already uses this address.", "address");
      }
      const row = {
        key: name,
        name,
        role: body.role,
        location,
        address,
        builtin: false,
        status: "pending",
        node_job: "node-registry",
        cadvisor_job: "cadvisor-registry",
      };
      await ops.insertServer(row);
      return {
        result: serverView(row),
        log: { action: "Added server", target: name, detail: `Role ${row.role}, location ${location}, address ${address}. Waiting for the exporters.` },
      };
    });
    res.status(201).json(created);
  }));

  router.patch("/servers/:key", ...write, route(async (req, res) => {
    const body = bodyOf(req);
    const patch = {};
    if (body.role !== undefined) {
      const p = roleProblem(body.role);
      if (p) throw fail(400, p);
      patch.role = body.role;
    }
    if (body.location !== undefined) {
      const p = locationProblem(body.location);
      if (p) throw fail(400, p);
      patch.location = body.location.trim();
    }
    if (body.address !== undefined) {
      const p = addressProblem(body.address);
      if (p) throw fail(400, p);
      patch.address = body.address;
    }
    if (!Object.keys(patch).length) throw new ApiError(400, "Nothing to change. Send a role, a location or an address.");

    const updated = await commit(req, async (ops) => {
      const servers = await ops.listServers();
      const server = findServer(servers, req.params.key);
      if (server.status === "archived") throw new ApiError(409, "An archived server cannot be edited.");
      if (patch.address !== undefined) {
        if (server.builtin) throw new ApiError(400, "A built-in server has no address that can be changed.", "address");
        if (server.status !== "pending") {
          throw new ApiError(400, "The address can only be changed while the server is pending.", "address");
        }
        if (servers.some((s) => s.key !== server.key && s.address === patch.address && s.status !== "archived")) {
          throw new ApiError(409, "Another server already uses this address.", "address");
        }
      }
      await ops.updateServer(server.key, patch);
      const changes = Object.keys(patch).map((c) => `${c} ${server[c] || "none"} to ${patch[c]}`);
      return {
        result: serverView({ ...server, ...patch }),
        log: { action: "Edited server", target: server.key, detail: changes.join("; ") },
      };
    });
    res.json(updated);
  }));

  router.post("/servers/:key/archive", ...write, route(async (req, res) => {
    const archived = await commit(req, async (ops) => {
      const server = findServer(await ops.listServers(), req.params.key);
      if (server.builtin) throw new ApiError(409, "A built-in server cannot be archived.");
      if (server.status === "archived") throw new ApiError(409, "This server is already archived.");
      const active = (await ops.listProjects()).filter((p) => p.server_key === server.key && p.status === "active");
      if (active.length) {
        throw new ApiError(409, `This server still has active projects: ${active.map((p) => p.name).join(", ")}. Archive them first.`);
      }
      await ops.updateServer(server.key, { status: "archived" });
      return {
        result: serverView({ ...server, status: "archived" }),
        log: { action: "Archived server", target: server.key, detail: "Stopped showing it in the dashboard. Its history and log entries are kept." },
      };
    });
    res.json(archived);
  }));

  router.get("/servers/:key/command", route(async (req, res) => {
    const server = findServer(await db.listServers(), req.params.key);
    if (server.builtin || !server.address) throw new ApiError(409, "A built-in server already runs its exporters.");
    if (server.status === "archived") throw new ApiError(409, "An archived server has no command.");
    const problem = addressProblem(server.address);
    if (problem) throw new ApiError(409, "The stored address is not valid. Edit the server first.", "address");
    res.json({ command: commandFor(server.address) });
  }));

  router.get("/servers/:key/check", route(async (req, res) => {
    await registry.load();
    const row = findServer(await db.listServers(), req.params.key);
    if (row.status === "archived") throw new ApiError(409, "An archived server cannot be checked.");
    const server = registry.current().servers.find((s) => s.key === row.key);
    if (!server) throw new ApiError(409, "The server record is not valid.");
    res.json(await checkServer(server));
  }));

  router.post("/servers/:key/activate", ...write, route(async (req, res) => {
    await registry.load();
    // Prometheus is asked before the transaction starts, so the database is not held while waiting.
    const first = findServer(await db.listServers(), req.params.key);
    if (first.status !== "pending") throw new ApiError(409, first.status === "active" ? "This server is already active." : "An archived server cannot be activated.");
    const server = registry.current().servers.find((s) => s.key === first.key);
    if (!server) throw new ApiError(409, "The server record is not valid.");
    const check = await checkServer(server);
    if (!check.node.up || !check.cadvisor.up) {
      const parts = [];
      if (!check.node.up) parts.push(`node exporter: ${check.node.error}`);
      if (!check.cadvisor.up) parts.push(`cAdvisor: ${check.cadvisor.error}`);
      throw new ApiError(409, `Both exporters must answer before the server can be activated. ${parts.join(". ")}.`);
    }
    const activated = await commit(req, async (ops) => {
      const row = findServer(await ops.listServers(), req.params.key);
      if (row.status !== "pending") throw new ApiError(409, "This server changed while it was being checked. Reload and try again.");
      await ops.updateServer(row.key, { status: "active" });
      return {
        result: serverView({ ...row, status: "active" }, { nodeUp: true, cadvisorUp: true, lastSeen: check.node.lastScrape }),
        log: { action: "Activated server", target: row.key, detail: "Both exporters answered." },
      };
    });
    res.json(activated);
  }));

  router.get("/servers/:key/containers", route(async (req, res) => {
    await registry.load();
    const [rows, projects] = await Promise.all([db.listServers(), db.listProjects()]);
    const row = findServer(rows, req.params.key);
    if (row.status !== "active") throw new ApiError(409, "Containers can be listed only for an active server.");
    const server = registry.current().servers.find((s) => s.key === row.key);
    if (!server) throw new ApiError(409, "The server record is not valid.");

    let seen;
    try {
      const result = await prom.query(queriesFor(server).names);
      seen = [...new Set(result.map((r) => r.labels && r.labels.name).filter((n) => typeof n === "string" && n !== ""))].sort();
    } catch {
      throw new ApiError(502, NOT_REACHABLE);
    }
    const owner = new Map();
    for (const p of projects) {
      if (p.server_key === row.key && p.status === "active") for (const c of p.containers) owner.set(c, p.name);
    }
    const platform = platformNames(row);
    res.json(
      seen.map((name) => {
        if (platform.has(name)) return { name, available: false, reason: "Used by the platform" };
        if (owner.has(name)) return { name, available: false, reason: `Already in ${owner.get(name)}` };
        return { name, available: true, reason: null };
      })
    );
  }));

  // ---- Projects

  // Checks that every container is free for this project on this server. projects is the current
  // list, ownKey the project being edited (its own containers do not count as taken).
  function checkFree(server, projects, containers, ownKey) {
    const platform = platformNames(server);
    for (const name of containers) {
      if (platform.has(name)) throw new ApiError(409, `${name} is used by the platform and cannot be added to a project.`, "containers");
      const other = projects.find((p) => p.key !== ownKey && p.server_key === server.key && p.status === "active" && p.containers.includes(name));
      if (other) throw new ApiError(409, `${name} is already in the project ${other.name}.`, "containers");
    }
  }

  router.get("/projects", route(async (req, res) => {
    const [servers, projects] = await Promise.all([db.listServers(), db.listProjects()]);
    const byKey = new Map(servers.map((s) => [s.key, s]));
    res.json(projects.map((p) => projectView(p, byKey)));
  }));

  router.post("/projects", ...write, route(async (req, res) => {
    const body = bodyOf(req);
    const name = normaliseName(body.name);
    const problem = nameProblem(name) || repoUrlProblem(body.repo_url) || containersProblem(body.containers);
    if (problem) throw fail(400, problem);
    // New projects are always image deployments that are only monitored. The other choices
    // (a CI deployment, approval before actions) exist for the built-in project only.
    if (body.deploy_source !== undefined && body.deploy_source !== "image") {
      throw new ApiError(400, "New projects deploy from an image.");
    }
    if (body.automation !== undefined && body.automation !== "monitored") {
      throw new ApiError(400, "New projects are monitored only. Approval before actions is not available yet.");
    }
    const repoUrl = body.repo_url ? body.repo_url : null;

    const created = await commit(req, async (ops) => {
      const [servers, projects] = await Promise.all([ops.listServers(), ops.listProjects()]);
      const server = typeof body.server_key === "string" ? servers.find((s) => s.key === body.server_key) : null;
      if (!server || server.status !== "active") throw new ApiError(400, "Choose an active server.", "server_key");
      if (projects.some((p) => p.key === name || p.name === name)) throw new ApiError(409, "A project with this name already exists.", "name");
      checkFree(server, projects, body.containers, null);
      const row = {
        key: name,
        name,
        server_key: server.key,
        repo_url: repoUrl,
        deploy_source: "image",
        automation: "monitored",
        builtin: false,
        status: "active",
        containers: [...body.containers],
      };
      await ops.insertProject(row);
      return {
        result: projectView(row, new Map(servers.map((s) => [s.key, s]))),
        log: {
          action: "Added project",
          target: name,
          detail: `Server ${server.key}, containers ${row.containers.join(", ")}${repoUrl ? `, repository ${repoUrl}` : ""}.`,
        },
      };
    });
    res.status(201).json(created);
  }));

  router.patch("/projects/:key", ...write, route(async (req, res) => {
    const body = bodyOf(req);
    if (body.repo_url === undefined && body.containers === undefined) {
      throw new ApiError(400, "Nothing to change. Send a repository address or a container list.");
    }
    if (body.repo_url !== undefined) {
      const p = repoUrlProblem(body.repo_url);
      if (p) throw fail(400, p);
    }
    if (body.containers !== undefined) {
      const p = containersProblem(body.containers);
      if (p) throw fail(400, p);
    }
    if (body.deploy_source !== undefined || body.automation !== undefined) {
      throw new ApiError(400, "The deployment source and the automation level cannot be changed.");
    }

    const updated = await commit(req, async (ops) => {
      const [servers, projects] = await Promise.all([ops.listServers(), ops.listProjects()]);
      const project = findProject(projects, req.params.key);
      if (project.status === "archived") throw new ApiError(409, "An archived project cannot be edited.");
      if (body.containers !== undefined && project.builtin) {
        throw new ApiError(400, "The containers of a built-in project cannot be changed.", "containers");
      }
      const changes = [];
      const next = { ...project, containers: [...project.containers] };
      if (body.repo_url !== undefined) {
        next.repo_url = body.repo_url ? body.repo_url : null;
        await ops.updateProject(project.key, { repo_url: next.repo_url });
        changes.push(`repository ${project.repo_url || "none"} to ${next.repo_url || "none"}`);
      }
      if (body.containers !== undefined) {
        const server = servers.find((s) => s.key === project.server_key);
        checkFree(server, projects, body.containers, project.key);
        await ops.setContainers(project.key, project.server_key, body.containers);
        next.containers = [...body.containers];
        changes.push(`containers ${project.containers.join(", ") || "none"} to ${body.containers.join(", ")}`);
      }
      return {
        result: projectView(next, new Map(servers.map((s) => [s.key, s]))),
        log: { action: "Edited project", target: project.key, detail: changes.join("; ") },
      };
    });
    res.json(updated);
  }));

  // Archiving frees the project's containers so another project can use them. The project record
  // and its log entries stay.
  router.post("/projects/:key/archive", ...write, route(async (req, res) => {
    const archived = await commit(req, async (ops) => {
      const [servers, projects] = await Promise.all([ops.listServers(), ops.listProjects()]);
      const project = findProject(projects, req.params.key);
      if (project.builtin) throw new ApiError(409, "A built-in project cannot be archived.");
      if (project.status === "archived") throw new ApiError(409, "This project is already archived.");
      await ops.updateProject(project.key, { status: "archived" });
      await ops.setContainers(project.key, project.server_key, []);
      return {
        result: projectView({ ...project, status: "archived", containers: [] }, new Map(servers.map((s) => [s.key, s]))),
        log: {
          action: "Archived project",
          target: project.key,
          detail: `Stopped watching it. Released containers: ${project.containers.join(", ") || "none"}. The record and its log entries are kept.`,
        },
      };
    });
    res.json(archived);
  }));

  // ---- Change log

  router.get("/log", route(async (req, res) => {
    const raw = req.query.limit === undefined ? "50" : req.query.limit;
    const limit = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!LOG_LIMITS.includes(limit)) throw new ApiError(400, `limit must be ${LOG_LIMITS.join(" or ")}.`);
    const rows = await db.listLog(limit);
    res.json(
      rows.map((r) => ({ id: Number(r.id), at: iso(r.at), user_email: r.user_email, action: r.action, target: r.target, detail: r.detail }))
    );
  }));

  return router;
}

module.exports = { createSettingsRouter, commandFor, queriesFor, PLATFORM_CONTAINERS, NODE_EXPORTER_IMAGE, CADVISOR_IMAGE };
