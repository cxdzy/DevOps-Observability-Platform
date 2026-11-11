// Tests for the settings routes: access, input checks, the registry rules, the change log and
// the transaction around every write. Prometheus is replaced by a stub on the global fetch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { startApp, ORIGIN } = require("./helpers");
const { PROMETHEUS_URL } = require("../prometheus");
const { PLATFORM_CONTAINERS, NODE_EXPORTER_IMAGE, CADVISOR_IMAGE } = require("../settings");

const PASSWORD = "a long enough password";
const NODE_SEL = 'job="node-registry",server="shop-node"';
const CADVISOR_SEL = 'job="cadvisor-registry",server="shop-node"';

// Answers requests to the Prometheus URL from answer(query), which returns [{ metric, value }] or
// throws; everything else goes to the real fetch. Returns the queries that were sent.
function stubProm(t, answer = () => []) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(PROMETHEUS_URL)) return original(url, init);
    const q = new URL(href).searchParams.get("query");
    sent.push(q);
    const rows = answer(q);
    const result = rows.map((r) => ({ metric: r.metric || {}, value: [1700000000, String(r.value)] }));
    return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result } }), {
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  return sent;
}

async function setup(t, role = "admin") {
  const app = await startApp();
  t.after(app.close);
  await app.addUser(`${role}@example.com`, role, PASSWORD);
  const { cookie } = await app.login(`${role}@example.com`, PASSWORD);
  const headers = { cookie };
  return {
    app,
    get: (p) => app.request(p, { headers }),
    post: (p, json = {}, extra = {}) => app.request(p, { method: "POST", json, headers: { ...headers, ...extra } }),
    patch: (p, json = {}) => app.request(p, { method: "PATCH", json, headers }),
    del: (p) => app.request(p, { method: "DELETE", headers }),
    cookie,
  };
}

// Puts an active server straight into the fake database.
async function addActiveServer(app, key = "shop-node", address = "100.64.0.12") {
  await app.db.transaction(async (ops) => {
    await ops.insertServer({ key, name: key, role: "application", location: "Home lab", address, builtin: false, status: "active", node_job: "node-registry", cadvisor_job: "cadvisor-registry" });
  });
}

const goodServer = { name: "shop-node", role: "application", location: "Home lab", address: "100.64.0.12" };

async function createServer(s, body = goodServer) {
  const res = await s.post("/api/settings/servers", body);
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}

test("every settings route needs a session and is admin only", async (t) => {
  const none = await startApp();
  t.after(none.close);
  const viewer = await setup(t, "viewer");
  const routes = [
    ["GET", "/api/settings/servers"],
    ["POST", "/api/settings/servers"],
    ["PATCH", "/api/settings/servers/main"],
    ["POST", "/api/settings/servers/main/archive"],
    ["GET", "/api/settings/servers/main/command"],
    ["GET", "/api/settings/servers/main/check"],
    ["POST", "/api/settings/servers/main/activate"],
    ["GET", "/api/settings/servers/main/containers"],
    ["GET", "/api/settings/projects"],
    ["POST", "/api/settings/projects"],
    ["PATCH", "/api/settings/projects/sample-service"],
    ["POST", "/api/settings/projects/sample-service/archive"],
    ["GET", "/api/settings/log"],
  ];
  for (const [method, p] of routes) {
    const anon = await none.request(p, { method, json: method === "GET" ? undefined : {} });
    assert.equal(anon.status, 401, `${method} ${p} anonymous`);
    const res = await viewer.app.request(p, { method, json: method === "GET" ? undefined : {}, headers: { cookie: viewer.cookie } });
    assert.equal(res.status, 403, `${method} ${p} viewer`);
  }
});

test("GET /api/servers lists the active servers for a viewer", async (t) => {
  const viewer = await setup(t, "viewer");
  const res = await viewer.get("/api/servers");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [
    { key: "main", name: "fyp-main", role: "platform", location: "Tencent Cloud, Singapore" },
    { key: "old", name: "staging", role: "staging", location: "Hetzner, Finland" },
  ]);
  // A pending server is not listed.
  await viewer.app.db.transaction(async (ops) => {
    await ops.insertServer({ key: "later", name: "later", role: "application", location: "x", address: "100.64.0.20", status: "pending", node_job: "node-registry", cadvisor_job: "cadvisor-registry" });
  });
  await viewer.app.db.listServers();
  const again = await (await viewer.get("/api/servers")).json();
  assert.equal(again.length, 2);
});

test("writes need a JSON body and the exact Origin", async (t) => {
  const s = await setup(t);
  const wrongOrigin = await s.post("/api/settings/servers", goodServer, { origin: "http://evil.example" });
  assert.equal(wrongOrigin.status, 403);
  const noOrigin = await s.app.request("/api/settings/servers", {
    method: "POST",
    headers: { cookie: s.cookie, "content-type": "application/json" },
    body: JSON.stringify(goodServer),
  });
  assert.equal(noOrigin.status, 403);
  const notJson = await s.app.request("/api/settings/servers", {
    method: "POST",
    headers: { cookie: s.cookie, origin: ORIGIN, "content-type": "text/plain" },
    body: JSON.stringify(goodServer),
  });
  assert.equal(notJson.status, 415);
  const writes = [
    ["POST", "/api/settings/servers"],
    ["PATCH", "/api/settings/servers/old"],
    ["POST", "/api/settings/servers/main/archive"],
    ["POST", "/api/settings/servers/x/activate"],
    ["POST", "/api/settings/projects"],
    ["PATCH", "/api/settings/projects/sample-service"],
    ["POST", "/api/settings/projects/x/archive"],
  ];
  for (const [method, p] of writes) {
    const evil = await s.app.request(p, { method, json: { location: "Elsewhere" }, headers: { cookie: s.cookie, origin: "http://evil.example" } });
    assert.equal(evil.status, 403, `${method} ${p} wrong origin`);
    const missing = await s.app.request(p, {
      method,
      headers: { cookie: s.cookie, "content-type": "application/json" },
      body: JSON.stringify({ location: "Elsewhere" }),
    });
    assert.equal(missing.status, 403, `${method} ${p} no origin`);
    const text = await s.app.request(p, {
      method,
      headers: { cookie: s.cookie, origin: ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify({ location: "Elsewhere" }),
    });
    assert.equal(text.status, 415, `${method} ${p} not json`);
  }
  assert.equal((await s.app.db.listServers()).length, 2);
  assert.equal((await s.app.db.listServers()).find((r) => r.key === "old").location, "Hetzner, Finland");
  assert.equal((await s.app.db.listLog(200)).length, 1);
});

test("adding a server creates it pending and writes the log row", async (t) => {
  stubProm(t);
  const s = await setup(t);
  const created = await createServer(s);
  assert.deepEqual(created, {
    key: "shop-node",
    name: "shop-node",
    role: "application",
    location: "Home lab",
    address: "100.64.0.12",
    builtin: false,
    status: "pending",
    nodeUp: null,
    cadvisorUp: null,
    lastSeen: null,
  });
  const rows = await s.app.db.listServers();
  const row = rows.find((r) => r.key === "shop-node");
  assert.equal(row.node_job, "node-registry");
  assert.equal(row.cadvisor_job, "cadvisor-registry");
  const log = await (await s.get("/api/settings/log")).json();
  assert.equal(log[0].action, "Added server");
  assert.equal(log[0].target, "shop-node");
  assert.equal(log[0].user_email, "admin@example.com");
  assert.match(log[0].detail, /100\.64\.0\.12/);
  // The list shows it with exporter flags from Prometheus (false: no series yet).
  const list = await (await s.get("/api/settings/servers")).json();
  const mine = list.find((x) => x.key === "shop-node");
  assert.equal(mine.nodeUp, false);
  assert.equal(mine.cadvisorUp, false);
  assert.equal(mine.lastSeen, null);
  // Pending servers are not yet in the lists the views use.
  assert.equal((await (await s.get("/api/servers")).json()).some((x) => x.key === "shop-node"), false);
});

test("the server name is trimmed and lowercased, and must be a valid key", async (t) => {
  const s = await setup(t);
  const ok = await s.post("/api/settings/servers", { ...goodServer, name: "  Shop-Node " });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).key, "shop-node");
  for (const name of ["a", "1abc", "has space", "under_score", "x".repeat(32), "", null, 5, "-lead"]) {
    const res = await s.post("/api/settings/servers", { ...goodServer, name, address: "100.64.0.99" });
    assert.equal(res.status, 400, JSON.stringify(name));
    const body = await res.json();
    assert.equal(body.field, "name");
    assert.ok(body.error.length > 10);
  }
  // 31 characters is the longest key.
  const long = await s.post("/api/settings/servers", { ...goodServer, name: "a" + "b".repeat(30), address: "100.64.0.98" });
  assert.equal(long.status, 201);
});

test("role and location are checked", async (t) => {
  const s = await setup(t);
  for (const role of ["admin", "", undefined, 3]) {
    const res = await s.post("/api/settings/servers", { ...goodServer, role });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).field, "role");
  }
  for (const location of ["", "   ", undefined, 4, "x".repeat(61), "bad\nline"]) {
    const res = await s.post("/api/settings/servers", { ...goodServer, location });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).field, "location");
  }
  const edge = await s.post("/api/settings/servers", { ...goodServer, location: "x".repeat(60) });
  assert.equal(edge.status, 201);
});

test("only Tailscale addresses (100.64.0.0/10) are accepted", async (t) => {
  const s = await setup(t);
  const bad = [
    "8.8.8.8", // public
    "1.2.3.4",
    "100.63.255.255", // just below the range
    "100.128.0.1", // just above the range
    "10.0.0.1",
    "192.168.1.5",
    "127.0.0.1",
    "100.64.0.12.5",
    "100.64.0",
    "100.064.0.1",
    "100.64.0.256",
    "100.64.0.12:9100",
    "http://100.64.0.12",
    "100.64.0.12; rm -rf /",
    "::1",
    "fe80::1",
    "::ffff:100.64.0.12",
    "100.64.0.1/32",
    " 100.64.0.12", // whitespace is refused, not trimmed
    "100.64.0.12 ",
    "100.64.0.12\n",
    "\t100.64.0.12",
    "100.64. 0.12",
    "100.64.0.012",
    "100.300.0.1",
    "example.com",
    "",
    null,
    12,
  ];
  for (const address of bad) {
    const res = await s.post("/api/settings/servers", { ...goodServer, address });
    assert.equal(res.status, 400, JSON.stringify(address));
    const body = await res.json();
    assert.equal(body.field, "address", JSON.stringify(address));
    assert.ok(body.error.length > 10);
  }
  for (const [i, address] of ["100.64.0.0", "100.127.255.255", "100.100.100.100"].entries()) {
    const res = await s.post("/api/settings/servers", { ...goodServer, name: `ok-${i}`, address });
    assert.equal(res.status, 201, address);
  }
  assert.equal((await s.app.db.listServers()).length, 5);
});

test("a name or an address already in use is a 409", async (t) => {
  const s = await setup(t);
  await createServer(s);
  const sameName = await s.post("/api/settings/servers", { ...goodServer, address: "100.64.0.13" });
  assert.equal(sameName.status, 409);
  assert.equal((await sameName.json()).field, "name");
  const sameAddress = await s.post("/api/settings/servers", { ...goodServer, name: "other-node" });
  assert.equal(sameAddress.status, 409);
  assert.equal((await sameAddress.json()).field, "address");
  // The built-in keys and display names are taken too.
  for (const name of ["main", "old", "fyp-main", "staging"]) {
    const res = await s.post("/api/settings/servers", { ...goodServer, name, address: "100.64.0.50" });
    assert.equal(res.status, 409, name);
    assert.equal((await res.json()).field, "name");
  }
  assert.equal((await s.app.db.listServers()).length, 3);
});

test("PATCH changes role and location; the address only while pending", async (t) => {
  const s = await setup(t);
  await createServer(s);
  const res = await s.patch("/api/settings/servers/shop-node", { role: "staging", location: "Office" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, "staging");
  assert.equal(body.location, "Office");
  const moved = await s.patch("/api/settings/servers/shop-node", { address: "100.64.0.77" });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).address, "100.64.0.77");
  const taken = await s.post("/api/settings/servers", { ...goodServer, name: "second", address: "100.64.0.78" });
  assert.equal(taken.status, 201);
  const clash = await s.patch("/api/settings/servers/shop-node", { address: "100.64.0.78" });
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).field, "address");
  const badAddress = await s.patch("/api/settings/servers/shop-node", { address: "8.8.8.8" });
  assert.equal(badAddress.status, 400);
  assert.equal((await badAddress.json()).field, "address");
  // Nothing to change, a bad role, an unknown server.
  assert.equal((await s.patch("/api/settings/servers/shop-node", {})).status, 400);
  const badRole = await s.patch("/api/settings/servers/shop-node", { role: "boss" });
  assert.equal(badRole.status, 400);
  assert.equal((await badRole.json()).field, "role");
  assert.equal((await s.patch("/api/settings/servers/nope", { role: "staging" })).status, 404);
  assert.equal((await s.patch("/api/settings/servers/Not%20A%20Key", { role: "staging" })).status, 404);
  const log = await (await s.get("/api/settings/log")).json();
  assert.ok(log.some((l) => l.action === "Edited server" && l.target === "shop-node" && /role application to staging/.test(l.detail)));
  // Once active, the address is fixed.
  await addActiveServer(s.app, "live-node", "100.64.0.30");
  const fixed = await s.patch("/api/settings/servers/live-node", { address: "100.64.0.31" });
  assert.equal(fixed.status, 400);
  assert.equal((await fixed.json()).field, "address");
});

test("built-in servers accept role and location only", async (t) => {
  const s = await setup(t);
  const ok = await s.patch("/api/settings/servers/old", { location: "Hetzner, Helsinki" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).location, "Hetzner, Helsinki");
  const address = await s.patch("/api/settings/servers/old", { address: "100.64.0.5" });
  assert.equal(address.status, 400);
  assert.equal((await address.json()).field, "address");
  const row = (await s.app.db.listServers()).find((r) => r.key === "old");
  assert.equal(row.address, null);
  assert.equal(row.node_job, "node-exporter-old");
});

test("archive rules: not for built-ins, not with active projects, and the name stays taken", async (t) => {
  const s = await setup(t);
  for (const key of ["main", "old"]) {
    const res = await s.post(`/api/settings/servers/${key}/archive`);
    assert.equal(res.status, 409, key);
    assert.match((await res.json()).error, /built-in/i);
  }
  await addActiveServer(s.app);
  const project = await s.post("/api/settings/projects", { name: "shop", server_key: "shop-node", containers: ["shop-web"] });
  assert.equal(project.status, 201);
  const blocked = await s.post("/api/settings/servers/shop-node/archive");
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /shop/);
  assert.equal((await s.post("/api/settings/projects/shop/archive")).status, 200);
  const done = await s.post("/api/settings/servers/shop-node/archive");
  assert.equal(done.status, 200);
  assert.equal((await done.json()).status, "archived");
  assert.equal((await s.post("/api/settings/servers/shop-node/archive")).status, 409);
  assert.equal((await s.post("/api/settings/servers/nope/archive")).status, 404);
  // The record stays, the name cannot be used again, but the address can.
  assert.equal((await s.app.db.listServers()).some((r) => r.key === "shop-node" && r.status === "archived"), true);
  const again = await s.post("/api/settings/servers", goodServer);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).field, "name");
  const reuse = await s.post("/api/settings/servers", { ...goodServer, name: "shop-node-2" });
  assert.equal(reuse.status, 201);
  // An archived server is not in the lists the views use.
  assert.equal((await (await s.get("/api/servers")).json()).some((x) => x.key === "shop-node"), false);
  const log = await (await s.get("/api/settings/log?limit=200")).json();
  assert.ok(log.some((l) => l.action === "Archived server" && l.target === "shop-node"));
});

test("the command carries the validated address and the image versions from one place", async (t) => {
  const s = await setup(t);
  await createServer(s);
  const res = await s.get("/api/settings/servers/shop-node/command");
  assert.equal(res.status, 200);
  const { command } = await res.json();
  assert.match(command, /--web\.listen-address=100\.64\.0\.12:9100/);
  assert.match(command, /-p 100\.64\.0\.12:8080:8080/);
  assert.ok(command.includes(NODE_EXPORTER_IMAGE));
  assert.ok(command.includes(CADVISOR_IMAGE));
  assert.equal(command.match(/docker run/g).length, 2);
  // The versions are the ones in docker-compose.yml on fyp-main.
  const compose = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docker-compose.yml"), "utf8");
  assert.ok(compose.includes(`image: ${NODE_EXPORTER_IMAGE}`));
  assert.ok(compose.includes(`image: ${CADVISOR_IMAGE}`));
  assert.equal((await s.get("/api/settings/servers/main/command")).status, 409);
  assert.equal((await s.get("/api/settings/servers/nope/command")).status, 404);
});

test("the platform container list matches docker-compose.yml", () => {
  const compose = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docker-compose.yml"), "utf8");
  const names = [...compose.matchAll(/container_name:\s*(\S+)/g)].map((m) => m[1]);
  assert.deepEqual([...PLATFORM_CONTAINERS].sort(), names.sort());
});

test("check reports Not added to Prometheus yet when there are no series", async (t) => {
  const sent = stubProm(t, () => []);
  const s = await setup(t);
  await createServer(s);
  const res = await s.get("/api/settings/servers/shop-node/check");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    node: { up: false, lastScrape: null, error: "Not added to Prometheus yet" },
    cadvisor: { up: false, lastScrape: null, error: "Not added to Prometheus yet" },
  });
  assert.ok(sent.includes(`up{${NODE_SEL}}`));
  assert.ok(sent.includes(`up{${CADVISOR_SEL}}`));
});

test("check reads up and the last scrape, and explains a down exporter", async (t) => {
  stubProm(t, (q) => {
    if (q === `up{${NODE_SEL}}`) return [{ value: 1 }];
    if (q === `timestamp(up{${NODE_SEL}})`) return [{ value: 1700000000 }];
    if (q === `up{${CADVISOR_SEL}}`) return [{ value: 0 }];
    return [];
  });
  const s = await setup(t);
  await createServer(s);
  const body = await (await s.get("/api/settings/servers/shop-node/check")).json();
  assert.equal(body.node.up, true);
  assert.equal(body.node.lastScrape, new Date(1700000000 * 1000).toISOString());
  assert.equal(body.node.error, null);
  assert.equal(body.cadvisor.up, false);
  assert.match(body.cadvisor.error, /cannot reach/);
});

test("check says so in words when Prometheus is down", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(PROMETHEUS_URL)) throw new TypeError("fetch failed");
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const s = await setup(t);
  await createServer(s);
  const body = await (await s.get("/api/settings/servers/shop-node/check")).json();
  assert.equal(body.node.up, false);
  assert.equal(body.node.error, "Prometheus is not reachable");
  // The list shows null (unknown), not false.
  const list = await (await s.get("/api/settings/servers")).json();
  const mine = list.find((x) => x.key === "shop-node");
  assert.equal(mine.nodeUp, null);
  assert.equal(mine.cadvisorUp, null);
});

test("a built-in server is checked with its own job selector", async (t) => {
  const sent = stubProm(t, (q) => (q === 'up{job="node-exporter-old"}' ? [{ value: 1 }] : []));
  const s = await setup(t);
  const body = await (await s.get("/api/settings/servers/old/check")).json();
  assert.equal(body.node.up, true);
  assert.ok(sent.includes('up{job="cadvisor-old"}'));
});

test("activate needs both exporters up", async (t) => {
  let cadvisorUp = false;
  stubProm(t, (q) => {
    if (q === `up{${NODE_SEL}}`) return [{ value: 1 }];
    if (q === `up{${CADVISOR_SEL}}`) return cadvisorUp ? [{ value: 1 }] : [];
    return [];
  });
  const s = await setup(t);
  await createServer(s);
  const refused = await s.post("/api/settings/servers/shop-node/activate");
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /cAdvisor/);
  assert.equal((await s.app.db.listServers()).find((r) => r.key === "shop-node").status, "pending");

  cadvisorUp = true;
  const ok = await s.post("/api/settings/servers/shop-node/activate");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, "active");
  const log = await (await s.get("/api/settings/log")).json();
  assert.equal(log[0].action, "Activated server");
  // Now the views get it, and the second activation is refused.
  assert.equal((await (await s.get("/api/servers")).json()).some((x) => x.key === "shop-node"), true);
  assert.equal((await s.post("/api/settings/servers/shop-node/activate")).status, 409);
  assert.equal((await s.post("/api/settings/servers/nope/activate")).status, 404);
});

test("containers: what cAdvisor sees, with the reason when one cannot be picked", async (t) => {
  const sent = stubProm(t, (q) => {
    if (q === 'sum by (name) (container_memory_working_set_bytes{job="cadvisor",name!=""})') {
      return [{ metric: { name: "worker" }, value: 1 }, { metric: { name: "sample-service" }, value: 1 }, { metric: { name: "extra" }, value: 1 }, { metric: { name: "extra" }, value: 2 }];
    }
    if (q === `sum by (name) (container_memory_working_set_bytes{${CADVISOR_SEL},name!=""})`) {
      return [{ metric: { name: "worker" }, value: 1 }, { metric: { name: "shop-web" }, value: 1 }, { metric: { name: "shop-db" }, value: 1 }];
    }
    return [];
  });
  const s = await setup(t);
  const main = await (await s.get("/api/settings/servers/main/containers")).json();
  assert.deepEqual(main, [
    { name: "extra", available: true, reason: null },
    { name: "sample-service", available: false, reason: "Already in sample-service" },
    { name: "worker", available: false, reason: "Used by the platform" },
  ]);
  // The platform names are refused on every server, not only on main.
  await addActiveServer(s.app);
  assert.equal((await s.post("/api/settings/projects", { name: "shop", server_key: "shop-node", containers: ["shop-web"] })).status, 201);
  const shop = await (await s.get("/api/settings/servers/shop-node/containers")).json();
  assert.deepEqual(shop, [
    { name: "shop-db", available: true, reason: null },
    { name: "shop-web", available: false, reason: "Already in shop" },
    { name: "worker", available: false, reason: "Used by the platform" },
  ]);
  assert.ok(sent.includes(`sum by (name) (container_memory_working_set_bytes{${CADVISOR_SEL},name!=""})`));
  // A pending server and an unknown one have nothing to list.
  await createServer(s, { ...goodServer, name: "pending-one", address: "100.64.0.40" });
  assert.equal((await s.get("/api/settings/servers/pending-one/containers")).status, 409);
  assert.equal((await s.get("/api/settings/servers/nope/containers")).status, 404);
});

test("containers answers 502 when Prometheus is down", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(PROMETHEUS_URL)) throw new TypeError("fetch failed");
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const s = await setup(t);
  const res = await s.get("/api/settings/servers/main/containers");
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Prometheus/);
});

test("GET /api/settings/projects lists the built-in project", async (t) => {
  const s = await setup(t);
  const list = await (await s.get("/api/settings/projects")).json();
  assert.deepEqual(list, [
    {
      key: "sample-service",
      name: "sample-service",
      server_key: "main",
      server_name: "fyp-main",
      repo_url: null,
      deploy_source: "ci",
      automation: "approval",
      builtin: true,
      status: "active",
      containers: ["sample-service"],
    },
  ]);
});

test("adding a project: always image and monitored, with the log row", async (t) => {
  const s = await setup(t);
  await addActiveServer(s.app);
  const res = await s.post("/api/settings/projects", {
    name: "Shop",
    server_key: "shop-node",
    repo_url: "https://github.com/example/shop",
    containers: ["shop-web", "shop.db_1"],
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.key, "shop");
  assert.equal(body.deploy_source, "image");
  assert.equal(body.automation, "monitored");
  assert.equal(body.builtin, false);
  assert.equal(body.status, "active");
  assert.deepEqual(body.containers, ["shop-web", "shop.db_1"]);
  assert.equal(body.repo_url, "https://github.com/example/shop");
  const log = await (await s.get("/api/settings/log")).json();
  assert.equal(log[0].action, "Added project");
  assert.equal(log[0].target, "shop");
  assert.match(log[0].detail, /shop-web/);
  // Sending the allowed values explicitly is fine; the other choices are refused.
  assert.equal((await s.post("/api/settings/projects", { name: "shop-b", server_key: "shop-node", containers: ["b"], deploy_source: "image", automation: "monitored" })).status, 201);
  for (const extra of [{ deploy_source: "ci" }, { automation: "approval" }, { deploy_source: "git" }, { automation: "auto" }]) {
    const refused = await s.post("/api/settings/projects", { name: "shop-c", server_key: "shop-node", containers: ["c"], ...extra });
    assert.equal(refused.status, 400, JSON.stringify(extra));
  }
  assert.equal((await s.app.db.listProjects()).length, 3);
});

test("project input errors name their field", async (t) => {
  const s = await setup(t);
  await addActiveServer(s.app);
  await createServer(s, { ...goodServer, name: "waiting", address: "100.64.0.41" });
  const base = { name: "shop", server_key: "shop-node", containers: ["shop-web"] };
  const cases = [
    [{ name: "Bad Name" }, 400, "name"],
    [{ name: "" }, 400, "name"],
    [{ server_key: undefined }, 400, "server_key"],
    [{ server_key: "nope" }, 400, "server_key"],
    [{ server_key: "waiting" }, 400, "server_key"],
    [{ server_key: 5 }, 400, "server_key"],
    [{ repo_url: "http://github.com/example/shop" }, 400, "repo_url"],
    [{ repo_url: "ftp://example.com/x" }, 400, "repo_url"],
    [{ repo_url: "javascript:alert(1)" }, 400, "repo_url"],
    [{ repo_url: "data:text/html,hello" }, 400, "repo_url"],
    [{ repo_url: "HTTPS://github.com/example/shop" }, 400, "repo_url"],
    [{ repo_url: "https:github.com/example/shop" }, 400, "repo_url"],
    [{ repo_url: "https:\\\\github.com/example/shop" }, 400, "repo_url"],
    [{ repo_url: " https://github.com/example/shop" }, 400, "repo_url"],
    [{ repo_url: "https://github.com/example/\u0001shop" }, 400, "repo_url"],
    [{ repo_url: "https://example.com/" + "a".repeat(181) }, 400, "repo_url"],
    [{ repo_url: "https://user:pass@example.com/x" }, 400, "repo_url"],
    [{ repo_url: "https://example.com/" + "a".repeat(190) }, 400, "repo_url"],
    [{ repo_url: "not a url" }, 400, "repo_url"],
    [{ repo_url: 7 }, 400, "repo_url"],
    [{ containers: [] }, 400, "containers"],
    [{ containers: undefined }, 400, "containers"],
    [{ containers: "shop-web" }, 400, "containers"],
    [{ containers: ["-bad"] }, 400, "containers"],
    [{ containers: ["has space"] }, 400, "containers"],
    [{ containers: ["x".repeat(129)] }, 400, "containers"],
    [{ containers: ["a", "a"] }, 400, "containers"],
    [{ containers: [1] }, 400, "containers"],
  ];
  for (const [change, status, field] of cases) {
    const res = await s.post("/api/settings/projects", { ...base, ...change });
    assert.equal(res.status, status, JSON.stringify(change));
    assert.equal((await res.json()).field, field, JSON.stringify(change));
  }
  // The longest valid repository address and container name.
  const edge = await s.post("/api/settings/projects", { ...base, repo_url: "https://example.com/" + "a".repeat(180), containers: ["a".repeat(128)] });
  assert.equal(edge.status, 201);
});

test("project container conflicts and a duplicate name are 409", async (t) => {
  const s = await setup(t);
  await addActiveServer(s.app);
  const platform = await s.post("/api/settings/projects", { name: "p1", server_key: "main", containers: ["grafana"] });
  assert.equal(platform.status, 409);
  const body = await platform.json();
  assert.equal(body.field, "containers");
  assert.match(body.error, /platform/);
  const taken = await s.post("/api/settings/projects", { name: "p2", server_key: "main", containers: ["sample-service"] });
  assert.equal(taken.status, 409);
  assert.match((await taken.json()).error, /sample-service/);
  // A platform name is refused on every server, not only on main.
  assert.equal((await s.post("/api/settings/projects", { name: "p3", server_key: "shop-node", containers: ["grafana"] })).status, 409);
  assert.equal((await s.post("/api/settings/projects", { name: "p3", server_key: "shop-node", containers: ["shop-web"] })).status, 201);
  const dup = await s.post("/api/settings/projects", { name: "p3", server_key: "shop-node", containers: ["other"] });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).field, "name");
  const dupBuiltin = await s.post("/api/settings/projects", { name: "sample-service", server_key: "shop-node", containers: ["other"] });
  assert.equal(dupBuiltin.status, 409);
  // The same container name on another server is a different container.
  assert.equal((await s.post("/api/settings/projects", { name: "p4", server_key: "old", containers: ["shop-web"] })).status, 201);
});

test("editing a project: repository and containers, and the built-in limits", async (t) => {
  const s = await setup(t);
  await addActiveServer(s.app);
  await s.post("/api/settings/projects", { name: "shop", server_key: "shop-node", containers: ["a"] });
  await s.post("/api/settings/projects", { name: "other", server_key: "shop-node", containers: ["b"] });
  const ok = await s.patch("/api/settings/projects/shop", { repo_url: "https://github.com/example/shop", containers: ["a", "c"] });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.containers, ["a", "c"]);
  assert.equal(body.repo_url, "https://github.com/example/shop");
  const cleared = await s.patch("/api/settings/projects/shop", { repo_url: null });
  assert.equal((await cleared.json()).repo_url, null);
  const clash = await s.patch("/api/settings/projects/shop", { containers: ["b"] });
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).field, "containers");
  const bad = await s.patch("/api/settings/projects/shop", { repo_url: "http://x.example" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).field, "repo_url");
  assert.equal((await s.patch("/api/settings/projects/shop", {})).status, 400);
  assert.equal((await s.patch("/api/settings/projects/shop", { automation: "approval" })).status, 400);
  assert.equal((await s.patch("/api/settings/projects/nope", { repo_url: null })).status, 404);
  // The built-in project may get a repository address, but its containers stay.
  const repo = await s.patch("/api/settings/projects/sample-service", { repo_url: "https://github.com/example/sample" });
  assert.equal(repo.status, 200);
  const containers = await s.patch("/api/settings/projects/sample-service", { containers: ["sample-service", "x"] });
  assert.equal(containers.status, 400);
  assert.equal((await containers.json()).field, "containers");
  const row = (await s.app.db.listProjects()).find((p) => p.key === "sample-service");
  assert.deepEqual(row.containers, ["sample-service"]);
  assert.equal(row.deploy_source, "ci");
  assert.equal(row.automation, "approval");
});

test("archiving a project: not for built-ins; it frees the containers and keeps the record", async (t) => {
  const s = await setup(t);
  await addActiveServer(s.app);
  const builtin = await s.post("/api/settings/projects/sample-service/archive");
  assert.equal(builtin.status, 409);
  await s.post("/api/settings/projects", { name: "shop", server_key: "shop-node", containers: ["a"] });
  const res = await s.post("/api/settings/projects/shop/archive");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "archived");
  assert.deepEqual(body.containers, []);
  assert.equal((await s.post("/api/settings/projects/shop/archive")).status, 409);
  assert.equal((await s.patch("/api/settings/projects/shop", { repo_url: null })).status, 409);
  assert.equal((await s.post("/api/settings/projects/nope/archive")).status, 404);
  assert.ok((await s.app.db.listProjects()).some((p) => p.key === "shop" && p.status === "archived"));
  // The container can be used by a new project, the old name stays taken.
  assert.equal((await s.post("/api/settings/projects", { name: "shop-2", server_key: "shop-node", containers: ["a"] })).status, 201);
  assert.equal((await s.post("/api/settings/projects", { name: "shop", server_key: "shop-node", containers: ["z"] })).status, 409);
  const log = await (await s.get("/api/settings/log?limit=200")).json();
  const entry = log.find((l) => l.action === "Archived project");
  assert.equal(entry.target, "shop");
  assert.match(entry.detail, /Released containers: a/);
  // The archived project's link is kept, with the time it was released, next to the new live one.
  const kept = await s.app.db.transaction((ops) => ops.listContainerLinks("shop"));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].container_name, "a");
  assert.ok(kept[0].released_at instanceof Date);
  const live = await s.app.db.transaction((ops) => ops.listContainerLinks("shop-2"));
  assert.deepEqual(live.map((l) => [l.container_name, l.released_at]), [["a", null]]);
});

test("editing containers releases the dropped ones and takes a re-added one back", async (t) => {
  const s = await setup(t);
  await addActiveServer(s.app);
  await s.post("/api/settings/projects", { name: "shop", server_key: "shop-node", containers: ["a", "b"] });
  assert.equal((await s.patch("/api/settings/projects/shop", { containers: ["a"] })).status, 200);
  let links = await s.app.db.transaction((ops) => ops.listContainerLinks("shop"));
  assert.deepEqual(links.map((l) => [l.container_name, l.released_at === null]), [["a", true], ["b", false]]);
  // b is free for another project while released, and back in shop once re-added.
  assert.equal((await s.patch("/api/settings/projects/shop", { containers: ["a", "b"] })).status, 200);
  links = await s.app.db.transaction((ops) => ops.listContainerLinks("shop"));
  assert.deepEqual(links.map((l) => [l.container_name, l.released_at === null]), [["a", true], ["b", true]]);
  const row = (await s.app.db.listProjects()).find((p) => p.key === "shop");
  assert.deepEqual(row.containers, ["a", "b"]);
});

test("staging's copies of the platform containers are refused like on main", async (t) => {
  // The container names cAdvisor reported on staging in the browser check of 12 Nov 2026.
  const STAGING = ["cadvisor", "fyp-postgres", "grafana", "influxdb", "kotone-bot", "mlflow", "node-exporter", "sample-service", "ts-proxy-cadvisor", "ts-proxy-node"];
  stubProm(t, (q) =>
    q === 'sum by (name) (container_memory_working_set_bytes{job="cadvisor-old",name!=""})' ? STAGING.map((name) => ({ metric: { name }, value: 1 })) : []
  );
  const s = await setup(t);
  const list = await (await s.get("/api/settings/servers/old/containers")).json();
  const platform = new Set(["cadvisor", "fyp-postgres", "grafana", "influxdb", "mlflow", "node-exporter"]);
  assert.deepEqual(list.map((c) => c.name), STAGING);
  for (const c of list) {
    if (platform.has(c.name)) assert.deepEqual(c, { name: c.name, available: false, reason: "Used by the platform" });
    else assert.deepEqual(c, { name: c.name, available: true, reason: null });
  }
  const res = await s.post("/api/settings/projects", { name: "grab", server_key: "old", containers: ["influxdb"] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).field, "containers");
  assert.equal((await s.post("/api/settings/projects", { name: "kotone", server_key: "old", containers: ["kotone-bot"] })).status, 201);
});

test("the log: default 50, 200 allowed, newest first, other limits refused", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 55; i++) {
    await s.patch("/api/settings/servers/old", { location: `Hetzner, Spot ${i}` });
  }
  const def = await (await s.get("/api/settings/log")).json();
  assert.equal(def.length, 50);
  assert.equal(def[0].action, "Edited server");
  assert.ok(def[0].id > def[1].id);
  assert.deepEqual(Object.keys(def[0]).sort(), ["action", "at", "detail", "id", "target", "user_email"]);
  assert.ok(!Number.isNaN(Date.parse(def[0].at)));
  const all = await (await s.get("/api/settings/log?limit=200")).json();
  assert.equal(all.length, 56);
  assert.equal(all[all.length - 1].action, "Imported");
  for (const limit of ["10", "51", "abc", "", "-1", "1e3", "200x"]) {
    const res = await s.get(`/api/settings/log?limit=${limit}`);
    assert.equal(res.status, 400, limit);
  }
});

test("a failed log write rolls the change back", async (t) => {
  stubProm(t);
  const s = await setup(t);
  await createServer(s);
  const real = s.app.db.transaction.bind(s.app.db);
  s.app.db.transaction = (fn) =>
    real((ops) =>
      fn({
        ...ops,
        insertLog: async () => {
          throw new Error("log write failed");
        },
      })
    );
  const before = JSON.stringify(s.app.db.registry);
  const attempts = [
    s.post("/api/settings/servers", { ...goodServer, name: "second", address: "100.64.0.50" }),
    s.patch("/api/settings/servers/shop-node", { role: "staging" }),
    s.post("/api/settings/servers/shop-node/archive"),
    s.post("/api/settings/projects", { name: "pp", server_key: "main", containers: ["free-one"] }),
    s.patch("/api/settings/projects/sample-service", { repo_url: "https://github.com/example/x" }),
  ];
  for (const res of await Promise.all(attempts)) {
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "internal error" });
  }
  assert.equal(JSON.stringify(s.app.db.registry), before);
  s.app.db.transaction = real;
  assert.equal((await s.get("/api/settings/servers")).status, 200);
  const rows = await s.app.db.listServers();
  assert.equal(rows.find((r) => r.key === "shop-node").role, "application");
  assert.equal(rows.find((r) => r.key === "shop-node").status, "pending");
  assert.equal(rows.some((r) => r.key === "second"), false);
});

test("a failure in a write leaves the registry cache and the log untouched", async (t) => {
  const s = await setup(t);
  const before = (await s.app.db.listLog(200)).length;
  const res = await s.post("/api/settings/servers", { ...goodServer, address: "8.8.8.8" });
  assert.equal(res.status, 400);
  assert.equal((await s.app.db.listLog(200)).length, before);
});

test("there is no way to delete: no DELETE routes, and the code never updates or deletes the log", async (t) => {
  const s = await setup(t);
  for (const p of ["/api/settings/servers/main", "/api/settings/projects/sample-service", "/api/settings/log", "/api/settings/servers", "/api/settings/projects"]) {
    assert.equal((await s.del(p)).status, 404, p);
  }
  assert.equal((await s.app.db.listServers()).length, 2);
  const dir = path.join(__dirname, "..");
  assert.ok(!/router\.delete|\.delete\(/.test(fs.readFileSync(path.join(dir, "settings.js"), "utf8")));
  const dbSource = fs.readFileSync(path.join(dir, "db.js"), "utf8");
  assert.ok(!/DELETE\s+FROM\s+settings_log/i.test(dbSource));
  assert.ok(!/UPDATE\s+settings_log/i.test(dbSource));
  const ops = await s.app.db.transaction(async (o) => Object.keys(o));
  assert.ok(!ops.some((name) => /deleteLog|updateLog|removeLog|clearLog/i.test(name)));
});

test("an admin can sign in after the registry loads from a database that fails once", async (t) => {
  // A failing registry read must not break the signed-in routes that use the built-in servers.
  const s = await setup(t);
  const real = s.app.db.listServers;
  s.app.db.listServers = async () => {
    throw new Error("db down");
  };
  const res = await s.get("/api/servers");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).length, 2);
  s.app.db.listServers = real;
});

test("main keeps the platform names even after its role is edited", async (t) => {
  stubProm(t, (q) =>
    q === 'sum by (name) (container_memory_working_set_bytes{job="cadvisor",name!=""})' ? [{ metric: { name: "n8n" }, value: 1 }] : []
  );
  const s = await setup(t);
  assert.equal((await s.patch("/api/settings/servers/main", { role: "application" })).status, 200);
  const list = await (await s.get("/api/settings/servers/main/containers")).json();
  assert.deepEqual(list, [{ name: "n8n", available: false, reason: "Used by the platform" }]);
  const res = await s.post("/api/settings/projects", { name: "grab", server_key: "main", containers: ["n8n"] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).field, "containers");
});

test("PATCH refuses an address with spaces instead of trimming it", async (t) => {
  const s = await setup(t);
  await createServer(s);
  for (const address of [" 100.64.0.13", "100.64.0.13 ", "100.64.0.13\n"]) {
    const res = await s.patch("/api/settings/servers/shop-node", { address });
    assert.equal(res.status, 400, JSON.stringify(address));
    assert.equal((await res.json()).field, "address");
  }
  assert.equal((await s.app.db.listServers()).find((r) => r.key === "shop-node").address, "100.64.0.12");
});
