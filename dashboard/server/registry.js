// The server and project registry. It loads the servers and projects from PostgreSQL, keeps them
// for 30 seconds, and reloads at once after any write. It also builds each server's PromQL
// selectors. A selector is made only from a validated server key and job names that were checked
// against a strict pattern, so nothing from a request ever reaches a query string.
const { SEED_SERVERS, SEED_PROJECTS } = require("./db");

const KEY_RE = /^[a-z][a-z0-9-]{1,30}$/;
const JOB_RE = /^[a-z][a-z0-9_-]{0,40}$/;
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ROLES = Object.freeze(["platform", "staging", "application"]);
const MAX_LOCATION = 60;
const MAX_REPO_URL = 200;
const MAX_CONTAINERS = 50;

// Servers added in the dashboard are scraped by these two jobs and told apart by a server label.
// The targets files that Prometheus reads are written by targets.js after every registry change.
const REGISTRY_NODE_JOB = "node-registry";
const REGISTRY_CADVISOR_JOB = "cadvisor-registry";

const CACHE_MS = 30 * 1000;
const RETRY_MS = 5 * 1000;

// "Tencent Cloud, Singapore" -> provider "Tencent Cloud" and place "Singapore". A location with no
// comma has no provider. The Overview card and the Resources header show the two parts.
function splitLocation(location) {
  const text = String(location || "");
  const i = text.indexOf(",");
  if (i < 0) return { provider: "", place: text.trim() };
  return { provider: text.slice(0, i).trim(), place: text.slice(i + 1).trim() };
}

function capitalise(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

// The label selectors for one server row, or null when the row holds anything unexpected. Built-in
// servers use their own job names; every other server uses the registry jobs plus server="<key>".
function selectorsFor(row) {
  if (!row || typeof row.key !== "string" || !KEY_RE.test(row.key)) return null;
  if (row.builtin) {
    if (!JOB_RE.test(row.node_job) || !JOB_RE.test(row.cadvisor_job)) return null;
    return { nodeSel: `job="${row.node_job}"`, cadvisorSel: `job="${row.cadvisor_job}"` };
  }
  return {
    nodeSel: `job="${REGISTRY_NODE_JOB}",server="${row.key}"`,
    cadvisorSel: `job="${REGISTRY_CADVISOR_JOB}",server="${row.key}"`,
  };
}

// A server row with the fields the query builders and the views use.
function toServer(row) {
  const sel = selectorsFor(row);
  if (!sel) return null;
  const { provider, place } = splitLocation(row.location);
  return Object.freeze({
    key: row.key,
    name: row.name,
    displayName: row.name,
    role: row.role,
    roleLabel: capitalise(row.role),
    location: row.location,
    provider,
    place,
    address: row.address || null,
    builtin: Boolean(row.builtin),
    status: row.status,
    nodeJob: row.builtin ? row.node_job : REGISTRY_NODE_JOB,
    cadvisorJob: row.builtin ? row.cadvisor_job : REGISTRY_CADVISOR_JOB,
    nodeSel: sel.nodeSel,
    cadvisorSel: sel.cadvisorSel,
  });
}

function buildSnapshot(serverRows, projectRows, version) {
  const servers = serverRows.map(toServer).filter(Boolean);
  const projects = projectRows.map((p) => Object.freeze({ ...p, containers: [...(p.containers || [])] }));
  return Object.freeze({
    version,
    servers,
    activeServers: servers.filter((s) => s.status === "active"),
    projects,
  });
}

// The built-in servers and project, used until the database has been read and whenever it cannot be.
function seedSnapshot() {
  return buildSnapshot(SEED_SERVERS, SEED_PROJECTS, 0);
}

// The writer for the folder targetsDir() names, or null. targets.js is loaded here, not at the top,
// because it uses the input checks from this file.
function defaultWriter(log) {
  const { createTargetsWriter, targetsDir } = require("./targets");
  const dir = targetsDir();
  return dir ? createTargetsWriter({ dir, log }) : null;
}

// db may be left out (tests and scripts); the registry then holds only the built-in servers.
// targets is a writer from targets.js (null for none). When it is left out, one is made only when
// there is a database and targetsDir() names a folder: TARGETS_DIR, or /app/targets in the
// production container. Tests and local runs therefore never write files by accident. The writer
// runs once at start and after every successful read of the database, and skips a write when
// the files would not change.
function createRegistry({ db = null, now = Date.now, log = console.log, targets } = {}) {
  let snapshot = seedSnapshot();
  const writer = targets !== undefined ? targets : db ? defaultWriter(log) : null;
  let loadedAt = db ? -Infinity : Infinity;
  let version = 0;
  let inflight = null;

  async function refresh() {
    try {
      const [serverRows, projectRows] = await Promise.all([db.listServers(), db.listProjects()]);
      version += 1;
      snapshot = buildSnapshot(serverRows, projectRows, version);
      loadedAt = now();
      if (writer) await writer.write(snapshot.servers);
    } catch (err) {
      // Keep the last good data and try again soon, so a database hiccup does not take the
      // Overview and Resources pages down.
      loadedAt = now() - CACHE_MS + RETRY_MS;
      log(JSON.stringify({ event: "registry_load_failed", error: String(err && err.message) }));
    }
  }

  // Starts a read and makes it the one later callers wait for.
  function start(after) {
    const run = after.then(refresh).finally(() => {
      if (inflight === run) inflight = null;
    });
    inflight = run;
    return run;
  }

  // Cached for 30 seconds. Never throws. A forced load (after a write) never reuses a read that
  // was already running, because that read may have started before the write was committed; it
  // waits for that read and then reads again.
  async function load({ force = false } = {}) {
    if (!db) return snapshot;
    if (force) {
      await start(inflight || Promise.resolve());
      return snapshot;
    }
    if (now() - loadedAt < CACHE_MS) return snapshot;
    await (inflight || start(Promise.resolve()));
    return snapshot;
  }

  // The last loaded data, without waiting. Used by the Prometheus allow lists.
  function current() {
    return snapshot;
  }

  // Call after a write has been committed.
  function reload() {
    return load({ force: true });
  }

  // { ok, error } for the Prometheus targets files. The error is a sentence for the check route.
  function targetsStatus() {
    return writer ? writer.status() : { ok: true, error: null };
  }

  // Writes the targets files once at start. The database may not be ready yet, so a failed first
  // read is tried again every few seconds until one works.
  if (writer && db) {
    const startup = async () => {
      await reload();
      if (version === 0) setTimeout(startup, RETRY_MS).unref();
    };
    startup();
  }

  // Memoises fn(snapshot) until the registry changes. Allow lists use it so the list is rebuilt
  // only when the servers change, and the same array object is returned in between.
  function derived(fn) {
    let seen = -1;
    let value;
    return () => {
      const s = snapshot;
      if (s.version !== seen) {
        value = fn(s);
        seen = s.version;
      }
      return value;
    };
  }

  return { load, current, reload, derived, targetsStatus };
}

// ---- Input checks used by the settings routes. Each returns null or { error, field }.

// A server or project name is also its key, so it must be a valid key.
function normaliseName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function nameProblem(name) {
  if (!KEY_RE.test(name)) {
    return {
      error: "The name must start with a letter and use only lowercase letters, digits and hyphens, 2 to 31 characters long.",
      field: "name",
    };
  }
  return null;
}

function roleProblem(role) {
  if (!ROLES.includes(role)) return { error: "The role must be platform, staging or application.", field: "role" };
  return null;
}

function locationProblem(location) {
  if (typeof location !== "string" || location.trim() === "") {
    return { error: "Enter a location, for example a provider and a city.", field: "location" };
  }
  if (location.trim().length > MAX_LOCATION) {
    return { error: `The location can be at most ${MAX_LOCATION} characters.`, field: "location" };
  }
  if (/[\u0000-\u001f\u007f]/.test(location)) {
    return { error: "The location cannot contain control characters.", field: "location" };
  }
  return null;
}

// An IPv4 address in 100.64.0.0/10 (the Tailscale range): the first part is 100 and the second is
// 64 to 127. Octets must be plain decimal with no leading zeros. Spaces are refused, not trimmed.
function addressProblem(address) {
  const field = "address";
  if (typeof address !== "string" || address === "") return { error: "Enter the Tailscale address of the server.", field };
  if (/\s/.test(address)) return { error: "The address cannot contain spaces.", field };
  const m = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(address);
  if (!m || m.slice(1).some((o) => o.length > 1 && o[0] === "0" || Number(o) > 255)) {
    return { error: "The address must be an IPv4 address such as 100.64.0.12.", field };
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a !== 100 || b < 64 || b > 127) {
    return { error: "The address must be a Tailscale address, from 100.64.0.0 to 100.127.255.255. Public and private addresses are not accepted.", field };
  }
  return null;
}

// null or "" means no repository. Otherwise an https URL with a host, no credentials, at most 200 characters.
function repoUrlProblem(value) {
  if (value === null || value === undefined || value === "") return null;
  const field = "repo_url";
  if (typeof value !== "string") return { error: "The repository address must be text.", field };
  if (value.length > MAX_REPO_URL) return { error: `The repository address can be at most ${MAX_REPO_URL} characters.`, field };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: "The repository address must be a full https address.", field };
  }
  // The literal prefix is checked as well, because the URL parser also accepts forms such as
  // "HTTPS://" or "https:host" that the database CHECK (^https://) refuses.
  if (!value.startsWith("https://") || url.protocol !== "https:" || !url.hostname || /[\s\u0000-\u001f\u007f]/.test(value)) {
    return { error: "The repository address must be a full https address.", field };
  }
  if (url.username || url.password) return { error: "The repository address cannot contain a user name or password.", field };
  return null;
}

// The container list of a project: 1 to 50 distinct valid names.
function containersProblem(list) {
  const field = "containers";
  if (!Array.isArray(list) || list.length === 0) return { error: "Pick at least one container.", field };
  if (list.length > MAX_CONTAINERS) return { error: `A project can have at most ${MAX_CONTAINERS} containers.`, field };
  for (const name of list) {
    if (typeof name !== "string" || !CONTAINER_RE.test(name)) {
      return { error: "A container name can use letters, digits, dots, underscores and hyphens only.", field };
    }
  }
  if (new Set(list).size !== list.length) return { error: "Each container can be picked only once.", field };
  return null;
}

module.exports = {
  createRegistry,
  toServer,
  selectorsFor,
  splitLocation,
  normaliseName,
  nameProblem,
  roleProblem,
  locationProblem,
  addressProblem,
  repoUrlProblem,
  containersProblem,
  KEY_RE,
  CONTAINER_RE,
  ROLES,
  REGISTRY_NODE_JOB,
  REGISTRY_CADVISOR_JOB,
  CACHE_MS,
};
