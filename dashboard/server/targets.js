// Writes the two Prometheus file_sd target files for the servers added in the dashboard. The
// dashboard owns these files; Prometheus only reads them (node.json and cadvisor.json in the
// targets folder, refreshed every 30 seconds). Only servers that are not built-in and are pending
// or active are listed. The key and the address are checked again here with the same patterns as
// the settings routes, so nothing else can reach a file. Each file is written as a temporary file
// in the same folder and renamed over the old one, so Prometheus never reads half a file. Nothing
// but these two files (and their temporary copies) is ever written.
const fs = require("fs/promises");
const path = require("path");
const { KEY_RE, addressProblem } = require("./registry");

// The dashboard image runs from /app (WORKDIR in dashboard/Dockerfile), and docker-compose mounts
// ./prometheus/targets at /app/targets.
const DEFAULT_DIR = "/app/targets";
const NODE_FILE = "node.json";
const CADVISOR_FILE = "cadvisor.json";
const NODE_PORT = 9100;
const CADVISOR_PORT = 8080;
// Prometheus runs as nobody, so the files must be readable by everyone.
const FILE_MODE = 0o644;
// While the folder cannot be written, the last list is tried again this often.
const RETRY_MS = 30 * 1000;
const NOT_WRITABLE = "The dashboard cannot write the Prometheus targets file";

// The folder the dashboard writes to, or null when it must not write at all. TARGETS_DIR wins
// (tests set it to a temporary folder). Otherwise only the production container writes: the
// Dockerfile sets NODE_ENV=production and docker-compose sets DATABASE_URL. Tests and local runs
// have neither, so they never write into the repository's prometheus/targets folder.
function targetsDir(env = process.env) {
  if (env.TARGETS_DIR) return env.TARGETS_DIR;
  if (env.NODE_ENV === "production" && env.DATABASE_URL) return DEFAULT_DIR;
  return null;
}

// The file_sd groups for a list of servers: one group per server, so every target carries its own
// server and instance labels. Rows that fail the checks are skipped.
function groupsFor(servers, port) {
  return servers
    .filter((s) => s && !s.builtin && (s.status === "pending" || s.status === "active"))
    .filter((s) => typeof s.key === "string" && KEY_RE.test(s.key) && typeof s.address === "string" && addressProblem(s.address) === null)
    .map((s) => ({ targets: [`${s.address}:${port}`], labels: { server: s.key, instance: s.key } }));
}

// dir is required, so a writer is only ever made for a folder someone chose.
function createTargetsWriter({ dir, log = console.log, retryMs = RETRY_MS } = {}) {
  if (typeof dir !== "string" || !dir) throw new Error("createTargetsWriter needs a folder");
  let lastText = null; // what was last written successfully, to skip identical rewrites
  let failing = false;
  let latest = [];
  let retryTimer = null;
  let queue = Promise.resolve();

  // Temporary file first, then a rename in the same folder. rename replaces the old file in one
  // step on Linux; on Windows (where the tests run) Node also replaces an existing file.
  async function replaceFile(name, text) {
    const final = path.join(dir, name);
    const temp = path.join(dir, `.${name}.tmp`);
    try {
      await fs.writeFile(temp, text, { encoding: "utf8", mode: FILE_MODE });
      // mode applies only when the file is created, so set it again in case a temporary file
      // was left behind by a crash.
      await fs.chmod(temp, FILE_MODE);
      await fs.rename(temp, final);
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }

  function scheduleRetry() {
    if (retryTimer || !(retryMs > 0)) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      write(latest);
    }, retryMs);
    if (typeof retryTimer.unref === "function") retryTimer.unref();
  }

  async function writeNow(servers) {
    const nodeText = JSON.stringify(groupsFor(servers, NODE_PORT), null, 2) + "\n";
    const cadvisorText = JSON.stringify(groupsFor(servers, CADVISOR_PORT), null, 2) + "\n";
    const text = nodeText + cadvisorText;
    if (!failing && text === lastText) return;
    try {
      await replaceFile(NODE_FILE, nodeText);
      await replaceFile(CADVISOR_FILE, cadvisorText);
      lastText = text;
      if (failing) log(JSON.stringify({ event: "targets_file_writable_again", dir }));
      failing = false;
    } catch (err) {
      lastText = null;
      // Logged once; later failures stay quiet until a write works again.
      if (!failing) log(JSON.stringify({ event: "targets_file_not_writable", dir, error: String(err && err.code ? err.code : err && err.message) }));
      failing = true;
      scheduleRetry();
    }
  }

  // Writes both files for the given servers (the registry's server list). Never throws. Calls run
  // one after another, so two writes never race on the same temporary file.
  function write(servers) {
    latest = Array.isArray(servers) ? servers : [];
    const list = latest;
    queue = queue.then(() => writeNow(list)).catch(() => {});
    return queue;
  }

  // { ok, error } for the check route.
  function status() {
    return failing ? { ok: false, error: NOT_WRITABLE } : { ok: true, error: null };
  }

  return { write, status, dir };
}

module.exports = { createTargetsWriter, targetsDir, groupsFor, DEFAULT_DIR, NODE_FILE, CADVISOR_FILE, NOT_WRITABLE };
