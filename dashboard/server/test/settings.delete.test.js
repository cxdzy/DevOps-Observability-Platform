// Delete and restore of servers and projects in Settings (settings.js, Delete and restore), and what
// the forecast job does with an open warning when a project is archived.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startApp } = require("./helpers");
const { PROMETHEUS_URL } = require("../prometheus");
const { SCHEMA } = require("../db");
const { createRegistry } = require("../registry");
const { createForecastJob } = require("../forecast/job");
const { createFakeDb } = require("./fake-db");

const PASSWORD = "a long enough password";

// Prometheus answers nothing; these routes never need it.
function stubProm(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(PROMETHEUS_URL)) return original(url, init);
    return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result: [], activeTargets: [] } }), { headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });
}

async function setup(t, role = "admin") {
  stubProm(t);
  const app = await startApp();
  t.after(app.close);
  await app.addUser(`${role}@example.com`, role, PASSWORD);
  const { cookie } = await app.login(`${role}@example.com`, PASSWORD);
  const headers = { cookie };
  return {
    app,
    get: (p) => app.request(p, { headers }),
    post: (p, json = {}, extra = {}) => app.request(p, { method: "POST", json, headers: { ...headers, ...extra } }),
  };
}

async function addProject(s, name, containers, server = "main") {
  const res = await s.post("/api/settings/projects", { name, server_key: server, containers });
  assert.equal(res.status, 201, await res.clone().text());
}

async function addServer(s, key = "shop-node", status = "active", address = "100.64.0.12") {
  await s.app.db.transaction(async (ops) => {
    await ops.insertServer({ key, name: key, role: "application", location: "Home lab", address, builtin: false, status, node_job: "node-registry", cadvisor_job: "cadvisor-registry" });
  });
}

// Image history and detected deployments, as the image watcher would have written them.
async function addHistory(s, project, server, container, n = 2) {
  await s.app.db.transaction(async (ops) => {
    await ops.upsertContainerImage({ serverKey: server, containerName: container, image: `${container}:v${n}` });
    for (let i = 1; i <= n; i++) {
      await ops.insertDetectedDeployment({ projectKey: project, serverKey: server, containerName: container, oldImage: `${container}:v${i - 1}`, newImage: `${container}:v${i}` });
    }
  });
}

const reg = (s) => s.app.db.registry;
const logRows = (s, action) => reg(s).log.filter((r) => r.action === action);

test("delete and restore need an admin session, the exact Origin and JSON", async (t) => {
  const s = await setup(t);
  await addProject(s, "shop", ["shop-api"]);
  await s.post("/api/settings/projects/shop/archive");
  const viewer = await setup(t, "viewer");
  const routes = ["/api/settings/projects/shop/delete", "/api/settings/projects/shop/restore", "/api/settings/servers/main/delete", "/api/settings/servers/main/restore"];
  for (const p of routes) {
    assert.equal((await s.app.request(p, { method: "POST", json: { name: "shop" } })).status, 401, p);
    assert.equal((await viewer.post(p, { name: "shop" })).status, 403, p);
    assert.equal((await s.post(p, { name: "shop" }, { origin: "https://evil.example" })).status, 403, p);
    const text = await s.app.request(p, { method: "POST", headers: { cookie: (await s.app.login("admin@example.com", PASSWORD)).cookie, origin: "http://localhost:3100", "content-type": "text/plain" }, body: "x" });
    assert.equal(text.status, 415, p);
  }
  for (const p of ["/api/settings/projects/shop/delete-preview", "/api/settings/servers/main/delete-preview"]) {
    assert.equal((await s.app.request(p)).status, 401, p);
    assert.equal((await viewer.get(p)).status, 403, p);
  }
  assert.ok(reg(s).projects.some((p) => p.key === "shop"));
});

test("an active project or server cannot be deleted, and built-ins never", async (t) => {
  const s = await setup(t);
  await addProject(s, "shop", ["shop-api"]);
  await addServer(s);
  let res = await s.post("/api/settings/projects/shop/delete", { name: "shop" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Archive the project first/);
  res = await s.post("/api/settings/servers/shop-node/delete", { name: "shop-node" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Archive the server first/);
  assert.equal((await s.post("/api/settings/projects/sample-service/delete", { name: "sample-service" })).status, 409);
  assert.equal((await s.post("/api/settings/servers/main/delete", { name: "fyp-main" })).status, 409);
  assert.equal((await s.post("/api/settings/servers/old/delete", { name: "staging" })).status, 409);
  assert.equal((await s.post("/api/settings/projects/nope/delete", { name: "nope" })).status, 404);
  assert.equal((await s.post("/api/settings/servers/nope/delete", { name: "nope" })).status, 404);
  assert.equal(reg(s).projects.length, 2);
  assert.equal(reg(s).servers.length, 3);
});

test("deleting a project needs its exact name and removes its links, deployments and image history", async (t) => {
  const s = await setup(t);
  await addProject(s, "shop", ["shop-api", "shop-web"]);
  await addHistory(s, "shop", "main", "shop-api", 3);
  await addHistory(s, "shop", "main", "shop-web", 1);
  // Another project's history must stay.
  await addProject(s, "blog", ["blog-web"]);
  await addHistory(s, "blog", "main", "blog-web", 2);
  assert.equal((await s.post("/api/settings/projects/shop/archive")).status, 200);

  const preview = await (await s.get("/api/settings/projects/shop/delete-preview")).json();
  assert.deepEqual(preview, { name: "shop", status: "archived", server_name: "fyp-main", deployments: 4, links: 2, images: 2 });

  for (const name of ["Shop", " shop", "shop ", "", undefined, 1]) {
    const res = await s.post("/api/settings/projects/shop/delete", { name });
    assert.equal(res.status, 400, String(name));
    assert.equal((await res.json()).field, "name");
  }
  const res = await s.post("/api/settings/projects/shop/delete", { name: "shop" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: "shop", name: "shop", deployments: 4, links: 2, images: 2 });

  assert.ok(!reg(s).projects.some((p) => p.key === "shop"));
  assert.ok(!reg(s).detected.some((d) => d.project_key === "shop"));
  assert.deepEqual(reg(s).containerImages.map((c) => c.container_name), ["blog-web"]);
  assert.equal(reg(s).detected.filter((d) => d.project_key === "blog").length, 2);
  const rows = logRows(s, "Deleted project");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, "shop");
  assert.equal(rows[0].user_email, "admin@example.com");
  assert.match(rows[0].detail, /^Deleted project shop on fyp-main, 4 deployments removed\./);
  // The containers are free to pick again.
  await addProject(s, "shop2", ["shop-api", "shop-web"]);
});

test("image history of a container that another project now uses is kept", async (t) => {
  const s = await setup(t);
  await addProject(s, "shop", ["shop-api"]);
  await addHistory(s, "shop", "main", "shop-api", 1);
  await s.post("/api/settings/projects/shop/archive");
  await addProject(s, "shop-new", ["shop-api"]);
  const res = await s.post("/api/settings/projects/shop/delete", { name: "shop" });
  assert.equal((await res.json()).images, 0);
  assert.deepEqual(reg(s).containerImages.map((c) => c.container_name), ["shop-api"]);
});

test("a failed delete changes nothing", async (t) => {
  const s = await setup(t);
  await addProject(s, "shop", ["shop-api"]);
  await addHistory(s, "shop", "main", "shop-api", 2);
  await s.post("/api/settings/projects/shop/archive");
  const real = s.app.db.transaction;
  s.app.db.transaction = (fn) => real((ops) => fn({ ...ops, insertLog: async () => { throw new Error("log write failed"); } }));
  const res = await s.post("/api/settings/projects/shop/delete", { name: "shop" });
  s.app.db.transaction = real;
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal error" });
  assert.ok(reg(s).projects.some((p) => p.key === "shop"));
  assert.equal(reg(s).detected.length, 2);
  assert.equal(reg(s).containerImages.length, 1);
});

test("a server is deleted only after its projects, and leaves the targets files", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-delete-"));
  const before = process.env.TARGETS_DIR;
  process.env.TARGETS_DIR = dir;
  t.after(() => {
    if (before === undefined) delete process.env.TARGETS_DIR;
    else process.env.TARGETS_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const s = await setup(t);
  await addServer(s);
  await addProject(s, "shop", ["shop-api"], "shop-node");
  await addHistory(s, "shop", "shop-node", "shop-api", 1);
  await s.post("/api/settings/projects/shop/archive");
  assert.equal((await s.post("/api/settings/servers/shop-node/archive")).status, 200);
  const servers = () => JSON.parse(fs.readFileSync(path.join(dir, "node.json"), "utf8")).map((g) => g.labels.server);

  const preview = await (await s.get("/api/settings/servers/shop-node/delete-preview")).json();
  assert.deepEqual(preview, { name: "shop-node", status: "archived", projects: ["shop"], images: 1 });
  let res = await s.post("/api/settings/servers/shop-node/delete", { name: "shop-node" });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "Delete these projects first: shop.");

  assert.equal((await s.post("/api/settings/projects/shop/delete", { name: "shop" })).status, 200);
  // Restore puts it back in the targets files as pending.
  res = await s.post("/api/settings/servers/shop-node/restore");
  assert.equal(res.status, 200);
  const restored = await res.json();
  assert.equal(restored.status, "pending");
  assert.equal(restored.targets_error, null);
  assert.deepEqual(servers(), ["shop-node"]);
  assert.equal(logRows(s, "Restored server").length, 1);

  await s.post("/api/settings/servers/shop-node/archive");
  assert.deepEqual(servers(), []);
  assert.equal((await s.post("/api/settings/servers/shop-node/delete", { name: "shop-nodE" })).status, 400);
  res = await s.post("/api/settings/servers/shop-node/delete", { name: "shop-node" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: "shop-node", name: "shop-node", images: 0, targets_error: null });
  assert.ok(!reg(s).servers.some((x) => x.key === "shop-node"));
  assert.deepEqual(servers(), []);
  assert.match(fs.readFileSync(path.join(dir, "cadvisor.json"), "utf8"), /^\[\]/);
  const row = logRows(s, "Deleted server")[0];
  assert.equal(row.target, "shop-node");
  assert.match(row.detail, /^Deleted archived server shop-node\./);
});

test("a pending server is deleted directly, as a cancel", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-delete-"));
  const before = process.env.TARGETS_DIR;
  process.env.TARGETS_DIR = dir;
  t.after(() => {
    if (before === undefined) delete process.env.TARGETS_DIR;
    else process.env.TARGETS_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const s = await setup(t);
  const created = await s.post("/api/settings/servers", { name: "half-done", role: "application", location: "Home lab", address: "100.64.0.20" });
  assert.equal(created.status, 201);
  assert.match(fs.readFileSync(path.join(dir, "node.json"), "utf8"), /half-done/);
  const res = await s.post("/api/settings/servers/half-done/delete", { name: "half-done" });
  assert.equal(res.status, 200);
  assert.ok(!reg(s).servers.some((x) => x.key === "half-done"));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "node.json"), "utf8"), /half-done/);
  assert.match(logRows(s, "Deleted server")[0].detail, /^Deleted pending server half-done\./);
});

test("when the targets file cannot be written the delete stays and the answer says so", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "settings-delete-"));
  const before = process.env.TARGETS_DIR;
  process.env.TARGETS_DIR = path.join(parent, "missing");
  t.after(() => {
    if (before === undefined) delete process.env.TARGETS_DIR;
    else process.env.TARGETS_DIR = before;
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const s = await setup(t);
  await addServer(s, "shop-node", "pending");
  const res = await s.post("/api/settings/servers/shop-node/delete", { name: "shop-node" });
  assert.equal(res.status, 200);
  assert.match((await res.json()).targets_error, /^The dashboard cannot write the Prometheus targets file\. The change was saved/);
  assert.ok(!reg(s).servers.some((x) => x.key === "shop-node"));
});

test("a project is restored only when its containers are free and its server is active", async (t) => {
  const s = await setup(t);
  await addProject(s, "shop", ["shop-api", "shop-web"]);
  // An edit released shop-web earlier; the archive released shop-api. Restore brings back shop-api only.
  assert.equal((await s.app.request("/api/settings/projects/shop", { method: "PATCH", json: { containers: ["shop-api"] }, headers: { cookie: (await s.app.login("admin@example.com", PASSWORD)).cookie } })).status, 200);
  await new Promise((r) => setTimeout(r, 5));
  await s.post("/api/settings/projects/shop/archive");
  assert.equal((await s.post("/api/settings/projects/shop/restore", {})).status === 200, true);
  assert.deepEqual(reg(s).projects.find((p) => p.key === "shop").containers, ["shop-api"]);
  assert.equal((await s.post("/api/settings/projects/shop/restore")).status, 409);

  await s.post("/api/settings/projects/shop/archive");
  await addProject(s, "thief", ["shop-api"]);
  const res = await s.post("/api/settings/projects/shop/restore");
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "These containers are taken: shop-api (in thief). Free them first.", field: "containers" });
  assert.equal(reg(s).projects.find((p) => p.key === "shop").status, "archived");
  assert.equal(logRows(s, "Restored project").length, 1);
});

test("a project on an archived server is restored only after the server", async (t) => {
  const s = await setup(t);
  await addServer(s);
  await addProject(s, "shop", ["shop-api"], "shop-node");
  await s.post("/api/settings/projects/shop/archive");
  await s.post("/api/settings/servers/shop-node/archive");
  const res = await s.post("/api/settings/projects/shop/restore");
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Restore the server first/);
  assert.equal((await s.post("/api/settings/servers/main/restore")).status, 409);
});

test("a server whose address was taken meanwhile is not restored", async (t) => {
  const s = await setup(t);
  await addServer(s, "shop-node", "archived", "100.64.0.12");
  await addServer(s, "new-node", "pending", "100.64.0.12");
  const res = await s.post("/api/settings/servers/shop-node/restore");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).field, "address");
});

test("the change log keeps its rows and stays append only", async (t) => {
  const s = await setup(t);
  await addProject(s, "shop", ["shop-api"]);
  await s.post("/api/settings/projects/shop/archive");
  await s.post("/api/settings/projects/shop/delete", { name: "shop" });
  const actions = reg(s).log.map((r) => r.action);
  assert.deepEqual(actions.slice(-3), ["Added project", "Archived project", "Deleted project"]);
  assert.ok(reg(s).log.filter((r) => r.target === "shop").length === 3);
  const body = await (await s.get("/api/settings/log?limit=50")).text();
  assert.ok(!body.includes("$2") && !body.includes(PASSWORD));
  // The table still refuses UPDATE, DELETE and TRUNCATE.
  assert.match(SCHEMA, /CREATE TRIGGER settings_log_readonly BEFORE UPDATE OR DELETE ON settings_log/);
  assert.match(SCHEMA, /CREATE TRIGGER settings_log_no_truncate BEFORE TRUNCATE ON settings_log/);
  assert.doesNotMatch(SCHEMA, /REFERENCES (servers|projects)[^;]*\n[^;]*settings_log|settings_log[^;]*REFERENCES/);
});

test("the delete routes are rate limited per admin", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 30; i++) assert.equal((await s.post("/api/settings/projects/nope/delete", { name: "nope" })).status, 404);
  assert.equal((await s.post("/api/settings/projects/nope/delete", { name: "nope" })).status, 429);
});

test("archiving a project closes its open forecast warning as container_gone on the next run", async () => {
  const db = createFakeDb();
  const t0 = Date.UTC(2026, 10, 25, 8, 0, 0);
  const clock = { t: t0 };
  await db.transaction(async (ops) => {
    await ops.insertProject({ key: "shop", name: "shop", server_key: "main", repo_url: null, deploy_source: "image", automation: "monitored", builtin: false, status: "active", containers: ["shop-api"] });
  });
  await db.insertForecastEvent({ resource: "memory", server: "main", project: "shop", container: "shop-api", mountpoint: null, openedAt: new Date(t0 - 600000), estMinutes: 40, limitValue: 100, level: 90, slope: 1, r2: 0.9, windowMin: 30, configVersion: "test" });
  const registry = createRegistry({ db, now: () => clock.t, targets: null, log: () => {} });
  // Prometheus is down, so the run cannot judge the container: the warning stays open.
  const prometheus = { queryRange: async () => { throw new Error("prometheus is down"); } };
  const job = createForecastJob({ db, registry, prometheus, now: () => clock.t, log: () => {} });
  await job.tick();
  const open = () => db.forecastEvents.filter((e) => e.closed_at === null);
  assert.equal(open().length, 1);

  await db.transaction(async (ops) => {
    await ops.updateProject("shop", { status: "archived" });
    await ops.setContainers("shop", "main", []);
  });
  await registry.reload();
  clock.t += 60000;
  await job.tick();
  assert.equal(open().length, 0);
  const row = db.forecastEvents[0];
  assert.equal(row.close_reason, "container_gone");
  // The row stays as history.
  assert.equal(db.forecastEvents.length, 1);
});
