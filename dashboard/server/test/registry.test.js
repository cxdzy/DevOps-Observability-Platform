// Tests for the registry: selectors, the 30 second cache, reload after a write, and input checks.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRegistry,
  selectorsFor,
  toServer,
  splitLocation,
  normaliseName,
  nameProblem,
  roleProblem,
  locationProblem,
  addressProblem,
  repoUrlProblem,
  containersProblem,
  CACHE_MS,
} = require("../registry");
const { createFakeDb } = require("./fake-db");
const { SCHEMA } = require("../db");

const SERVER_ROW = { key: "shop-node", name: "shop-node", role: "application", location: "Home lab", address: "100.64.0.12", builtin: false, status: "active", node_job: "node-registry", cadvisor_job: "cadvisor-registry" };

test("built-in servers are selected by their own jobs, the others by the registry jobs and a server label", async () => {
  const db = createFakeDb();
  const [main, old] = await db.listServers();
  assert.deepEqual(selectorsFor(main), { nodeSel: 'job="node-exporter"', cadvisorSel: 'job="cadvisor"' });
  assert.deepEqual(selectorsFor(old), { nodeSel: 'job="node-exporter-old"', cadvisorSel: 'job="cadvisor-old"' });
  assert.deepEqual(selectorsFor(SERVER_ROW), {
    nodeSel: 'job="node-registry",server="shop-node"',
    cadvisorSel: 'job="cadvisor-registry",server="shop-node"',
  });
  // The jobs stored on a non-built-in row are ignored: only the constants are used.
  assert.equal(selectorsFor({ ...SERVER_ROW, node_job: 'x"} or vector(1) #' }).nodeSel, 'job="node-registry",server="shop-node"');
});

test("a row with an unsafe key or job gets no selector", () => {
  for (const key of ['a"b', "A-B", "x", "a b", "1ab", "a".repeat(32), "", null, undefined, 'x"} or up{job="y']) {
    assert.equal(selectorsFor({ ...SERVER_ROW, key }), null, String(key));
    assert.equal(toServer({ ...SERVER_ROW, key }), null);
  }
  assert.equal(selectorsFor({ ...SERVER_ROW, key: "main", builtin: true, node_job: 'bad"job', cadvisor_job: "cadvisor" }), null);
  assert.equal(selectorsFor(null), null);
});

test("the location is split into provider and place for the cards", () => {
  assert.deepEqual(splitLocation("Tencent Cloud, Singapore"), { provider: "Tencent Cloud", place: "Singapore" });
  assert.deepEqual(splitLocation("Home lab"), { provider: "", place: "Home lab" });
  assert.deepEqual(splitLocation("A, B, C"), { provider: "A", place: "B, C" });
});

test("the registry starts with the built-in servers and reads the database once per 30 seconds", async () => {
  const db = createFakeDb();
  let reads = 0;
  const real = db.listServers;
  db.listServers = async () => {
    reads += 1;
    return real();
  };
  const clock = { t: 1_000_000 };
  const registry = createRegistry({ db, now: () => clock.t, log: () => {} });
  // Before the first load the built-in servers are known.
  assert.deepEqual(registry.current().activeServers.map((s) => s.key), ["main", "old"]);
  await registry.load();
  await registry.load();
  assert.equal(reads, 1);
  clock.t += CACHE_MS - 1;
  await registry.load();
  assert.equal(reads, 1);
  clock.t += 1;
  await registry.load();
  assert.equal(reads, 2);
});

test("reload picks up a write at once and bumps the version", async () => {
  const db = createFakeDb();
  const registry = createRegistry({ db, now: () => 5, log: () => {} });
  await registry.load();
  const v1 = registry.current().version;
  await db.transaction(async (ops) => ops.insertServer(SERVER_ROW));
  await registry.load();
  assert.deepEqual(registry.current().activeServers.map((s) => s.key), ["main", "old"]); // still cached
  await registry.reload();
  assert.deepEqual(registry.current().activeServers.map((s) => s.key), ["main", "old", "shop-node"]);
  assert.ok(registry.current().version > v1);
  const shop = registry.current().activeServers[2];
  assert.equal(shop.nodeSel, 'job="node-registry",server="shop-node"');
  assert.equal(shop.roleLabel, "Application");
  assert.equal(shop.provider, "");
  assert.equal(shop.place, "Home lab");
  assert.ok(Object.isFrozen(shop));
  // Archived and pending servers are known but not active.
  await db.transaction(async (ops) => ops.updateServer("shop-node", { status: "archived" }));
  await registry.reload();
  assert.equal(registry.current().servers.length, 3);
  assert.equal(registry.current().activeServers.length, 2);
});

test("a database error keeps the last good data and never throws", async () => {
  const db = createFakeDb();
  const logs = [];
  const registry = createRegistry({ db, now: () => 5, log: (l) => logs.push(l) });
  await db.transaction(async (ops) => ops.insertServer(SERVER_ROW));
  await registry.reload();
  assert.equal(registry.current().activeServers.length, 3);
  db.listServers = async () => {
    throw new Error("db down");
  };
  const snapshot = await registry.reload();
  assert.equal(snapshot.activeServers.length, 3);
  assert.ok(logs.some((l) => l.includes("registry_load_failed")));
});

test("derived values are rebuilt only when the registry changes", async () => {
  const db = createFakeDb();
  const registry = createRegistry({ db, now: () => 5, log: () => {} });
  let builds = 0;
  const list = registry.derived((snap) => {
    builds += 1;
    return snap.activeServers.map((s) => s.key);
  });
  assert.equal(list(), list());
  assert.equal(builds, 1);
  await registry.load();
  const a = list();
  assert.equal(list(), a);
  assert.equal(builds, 2);
  await db.transaction(async (ops) => ops.insertServer(SERVER_ROW));
  await registry.reload();
  assert.deepEqual(list(), ["main", "old", "shop-node"]);
  assert.equal(builds, 3);
});

test("a registry without a database holds the built-in servers", async () => {
  const registry = createRegistry();
  const snap = await registry.load();
  assert.deepEqual(snap.activeServers.map((s) => s.key), ["main", "old"]);
  assert.equal(snap.projects[0].key, "sample-service");
  const main = snap.activeServers[0];
  assert.equal(main.displayName, "fyp-main");
  assert.equal(main.roleLabel, "Platform");
  assert.equal(main.provider, "Tencent Cloud");
  assert.equal(main.place, "Singapore");
});

test("name, role, location, address, repository and container checks", () => {
  assert.equal(normaliseName("  Shop-Node "), "shop-node");
  assert.equal(normaliseName(5), "");
  assert.equal(nameProblem("shop-node"), null);
  assert.equal(nameProblem("ab"), null);
  assert.equal(nameProblem("a").field, "name");
  assert.equal(nameProblem("a".repeat(31)), null);
  assert.equal(nameProblem("a".repeat(32)).field, "name");
  assert.equal(roleProblem("platform"), null);
  assert.equal(roleProblem("other").field, "role");
  assert.equal(locationProblem("x".repeat(60)), null);
  assert.equal(locationProblem("x".repeat(61)).field, "location");
  for (const ok of ["100.64.0.0", "100.100.1.1", "100.127.255.255"]) assert.equal(addressProblem(ok), null, ok);
  for (const bad of ["100.63.255.255", "100.128.0.0", "8.8.8.8", "100.64.0.256", "100.64.0", " ", "100.64.00.1", "100.64.0.1/32"]) {
    assert.equal(addressProblem(bad).field, "address", bad);
  }
  assert.equal(repoUrlProblem(null), null);
  assert.equal(repoUrlProblem(""), null);
  assert.equal(repoUrlProblem("https://github.com/a/b"), null);
  assert.equal(repoUrlProblem("http://github.com/a/b").field, "repo_url");
  assert.equal(containersProblem(["a", "b.c_d-1"]), null);
  assert.equal(containersProblem([]).field, "containers");
  assert.equal(containersProblem(["a"].concat(Array.from({ length: 50 }, (_, i) => "c" + i))).field, "containers");
});

test("the schema defines the four registry tables and keeps the log append-only", () => {
  for (const table of ["servers", "projects", "project_containers", "settings_log"]) {
    assert.match(SCHEMA, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
  }
  assert.match(SCHEMA, /UNIQUE \(server_key, container_name\)/);
  assert.match(SCHEMA, /BEFORE UPDATE OR DELETE ON settings_log/);
});

test("a reload during a slow read reads again, so it sees the write", async () => {
  const db = createFakeDb();
  const registry = createRegistry({ db, now: () => 5, log: () => {} });
  const realList = db.listServers.bind(db);
  // The first read takes its rows, then waits until it is released.
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  db.listServers = async () => {
    calls += 1;
    const rows = await realList();
    if (calls === 1) await gate;
    return rows;
  };
  const slow = registry.load();
  await new Promise((r) => setImmediate(r));
  await db.transaction(async (ops) => ops.insertServer(SERVER_ROW));
  const forced = registry.reload();
  release();
  await Promise.all([slow, forced]);
  assert.equal(calls, 2);
  assert.deepEqual(registry.current().activeServers.map((s) => s.key), ["main", "old", "shop-node"]);
});

test("with TARGETS_DIR set the registry writes the targets files at start without any request", async (t) => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-targets-"));
  const before = process.env.TARGETS_DIR;
  process.env.TARGETS_DIR = dir;
  t.after(() => {
    if (before === undefined) delete process.env.TARGETS_DIR;
    else process.env.TARGETS_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = createFakeDb();
  await db.transaction(async (ops) => ops.insertServer(SERVER_ROW));
  const registry = createRegistry({ db, log: () => {} });
  await registry.load();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "node.json"), "utf8")), [
    { targets: ["100.64.0.12:9100"], labels: { server: "shop-node", instance: "shop-node" } },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "cadvisor.json"), "utf8"))[0].targets, ["100.64.0.12:8080"]);
});
