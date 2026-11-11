// Tests for the Prometheus targets files: content, archived servers left out, the atomic rename,
// an unwritable folder, and the registry running the writer at start and after every change.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTargetsWriter, targetsDir, groupsFor, DEFAULT_DIR, NODE_FILE, CADVISOR_FILE, NOT_WRITABLE } = require("../targets");
const { createRegistry } = require("../registry");
const { createFakeDb } = require("./fake-db");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "targets-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

function server(key, address, status = "active", builtin = false) {
  return { key, address, status, builtin };
}

test("both files list pending and active servers with server and instance labels", async (t) => {
  const dir = tempDir(t);
  const writer = createTargetsWriter({ dir, log: () => {} });
  await writer.write([server("shop-node", "100.64.0.12", "active"), server("lab", "100.100.1.2", "pending")]);
  assert.deepEqual(read(dir, NODE_FILE), [
    { targets: ["100.64.0.12:9100"], labels: { server: "shop-node", instance: "shop-node" } },
    { targets: ["100.100.1.2:9100"], labels: { server: "lab", instance: "lab" } },
  ]);
  assert.deepEqual(read(dir, CADVISOR_FILE), [
    { targets: ["100.64.0.12:8080"], labels: { server: "shop-node", instance: "shop-node" } },
    { targets: ["100.100.1.2:8080"], labels: { server: "lab", instance: "lab" } },
  ]);
  assert.deepEqual(writer.status(), { ok: true, error: null });
});

test("archived and built-in servers are left out, and only the two files exist", async (t) => {
  const dir = tempDir(t);
  const writer = createTargetsWriter({ dir, log: () => {} });
  await writer.write([
    server("main", null, "active", true),
    server("old", null, "active", true),
    server("gone", "100.64.0.20", "archived"),
    server("shop-node", "100.64.0.12", "active"),
  ]);
  assert.deepEqual(read(dir, NODE_FILE).map((g) => g.labels.server), ["shop-node"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [CADVISOR_FILE, NODE_FILE].sort());
  await writer.write([]);
  assert.deepEqual(read(dir, NODE_FILE), []);
  assert.deepEqual(read(dir, CADVISOR_FILE), []);
});

test("an address or key that fails the checks is never written", () => {
  const bad = [
    server("shop-node", "10.0.0.5"),
    server("shop-node", '100.64.0.12:9100", "x'),
    server("shop-node", "100.64.0.12\n"),
    server("Bad Key", "100.64.0.12"),
    server('x"}', "100.64.0.12"),
    server("shop-node", null),
    null,
  ];
  assert.deepEqual(groupsFor(bad, 9100), []);
});

test("a file is replaced by renaming a temporary file in the same folder", async (t) => {
  const dir = tempDir(t);
  const writer = createTargetsWriter({ dir, log: () => {} });
  await writer.write([server("a1", "100.64.0.1")]);
  const calls = [];
  const fsp = require("fs/promises");
  const realRename = fsp.rename;
  const realWrite = fsp.writeFile;
  fsp.rename = async (from, to) => {
    calls.push(["rename", path.basename(from), path.basename(to), path.dirname(from) === path.dirname(to)]);
    // At this moment the old file is still complete and the new text sits in the temporary file.
    assert.equal(read(dir, NODE_FILE)[0].labels.server, "a1");
    assert.equal(JSON.parse(fs.readFileSync(from, "utf8"))[0].labels.server, "b2");
    return realRename(from, to);
  };
  fsp.writeFile = async (file, ...rest) => {
    calls.push(["write", path.basename(file)]);
    return realWrite(file, ...rest);
  };
  t.after(() => {
    fsp.rename = realRename;
    fsp.writeFile = realWrite;
  });
  await writer.write([server("b2", "100.64.0.2")]);
  assert.deepEqual(calls, [
    ["write", ".node.json.tmp"],
    ["rename", ".node.json.tmp", "node.json", true],
    ["write", ".cadvisor.json.tmp"],
    ["rename", ".cadvisor.json.tmp", "cadvisor.json", true],
  ]);
  assert.equal(read(dir, NODE_FILE)[0].labels.server, "b2");
  assert.deepEqual(fs.readdirSync(dir).sort(), [CADVISOR_FILE, NODE_FILE].sort());
});

test("an identical list is not written again", async (t) => {
  const dir = tempDir(t);
  const writer = createTargetsWriter({ dir, log: () => {} });
  await writer.write([server("a1", "100.64.0.1")]);
  const before = fs.statSync(path.join(dir, NODE_FILE)).mtimeMs;
  fs.rmSync(path.join(dir, NODE_FILE));
  await writer.write([server("a1", "100.64.0.1")]);
  assert.equal(fs.existsSync(path.join(dir, NODE_FILE)), false);
  assert.ok(before > 0);
});

test("an unwritable folder is logged once, reported, and recovers", async (t) => {
  const dir = tempDir(t);
  const missing = path.join(dir, "not-there");
  const logs = [];
  const writer = createTargetsWriter({ dir: missing, log: (l) => logs.push(l) });
  await writer.write([server("a1", "100.64.0.1")]);
  await writer.write([server("a1", "100.64.0.1"), server("b2", "100.64.0.2")]);
  assert.deepEqual(writer.status(), { ok: false, error: "The dashboard cannot write the Prometheus targets file" });
  assert.equal(NOT_WRITABLE, "The dashboard cannot write the Prometheus targets file");
  assert.equal(logs.filter((l) => l.includes("targets_file_not_writable")).length, 1);
  assert.equal(fs.readdirSync(dir).length, 0);
  fs.mkdirSync(missing);
  await writer.write([server("a1", "100.64.0.1")]);
  assert.deepEqual(writer.status(), { ok: true, error: null });
  assert.equal(read(missing, NODE_FILE).length, 1);
});

test("the registry writes the files once at start and after every change", async (t) => {
  const dir = tempDir(t);
  const db = createFakeDb();
  await db.transaction(async (ops) =>
    ops.insertServer({ key: "shop-node", name: "shop-node", role: "application", location: "Home lab", address: "100.64.0.12", builtin: false, status: "pending", node_job: "node-registry", cadvisor_job: "cadvisor-registry" })
  );
  const registry = createRegistry({ db, now: () => 5, log: () => {}, targets: createTargetsWriter({ dir, log: () => {} }) });
  await registry.load();
  assert.deepEqual(read(dir, NODE_FILE).map((g) => g.labels.server), ["shop-node"]);
  await db.transaction(async (ops) => ops.updateServer("shop-node", { status: "archived" }));
  await registry.reload();
  assert.deepEqual(read(dir, NODE_FILE), []);
  assert.deepEqual(registry.targetsStatus(), { ok: true, error: null });
});

test("a registry made with no writer and no TARGETS_DIR writes nothing and reports ok", async () => {
  assert.equal(process.env.TARGETS_DIR, undefined);
  assert.equal(targetsDir(), null);
  const registry = createRegistry({ db: createFakeDb(), log: () => {} });
  await registry.reload();
  assert.deepEqual(registry.targetsStatus(), { ok: true, error: null });
});

test("only TARGETS_DIR or the production container picks a folder", () => {
  assert.equal(DEFAULT_DIR, "/app/targets");
  assert.equal(targetsDir({}), null);
  assert.equal(targetsDir({ DATABASE_URL: "postgres://x@db/d" }), null);
  assert.equal(targetsDir({ NODE_ENV: "production" }), null);
  assert.equal(targetsDir({ NODE_ENV: "production", DATABASE_URL: "postgres://x@db/d" }), "/app/targets");
  assert.equal(targetsDir({ TARGETS_DIR: "/tmp/t" }), "/tmp/t");
  assert.throws(() => createTargetsWriter({ log: () => {} }), /needs a folder/);
});

test("writes sent at the same time run one after another and the last list wins", async (t) => {
  const dir = tempDir(t);
  const writer = createTargetsWriter({ dir, log: () => {} });
  const lists = [[server("a1", "100.64.0.1")], [server("b2", "100.64.0.2")], [server("c3", "100.64.0.3")]];
  await Promise.all(lists.map((l) => writer.write(l)));
  assert.deepEqual(read(dir, NODE_FILE).map((g) => g.labels.server), ["c3"]);
  assert.deepEqual(read(dir, CADVISOR_FILE).map((g) => g.labels.server), ["c3"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [CADVISOR_FILE, NODE_FILE].sort());
});

test("an unwritable folder is tried again on its own once it can be written", async (t) => {
  const dir = tempDir(t);
  const missing = path.join(dir, "not-there");
  const logs = [];
  const writer = createTargetsWriter({ dir: missing, log: (l) => logs.push(l), retryMs: 20 });
  await writer.write([server("a1", "100.64.0.1")]);
  assert.equal(writer.status().ok, false);
  fs.mkdirSync(missing);
  for (let i = 0; i < 100 && !writer.status().ok; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(writer.status(), { ok: true, error: null });
  assert.equal(read(missing, NODE_FILE)[0].labels.server, "a1");
  assert.equal(logs.filter((l) => l.includes("targets_file_writable_again")).length, 1);
});

test("the files are readable by everyone, so Prometheus (user nobody) can read them", { skip: process.platform === "win32" ? "file modes are not used on Windows" : false }, async (t) => {
  const dir = tempDir(t);
  const writer = createTargetsWriter({ dir, log: () => {} });
  await writer.write([server("a1", "100.64.0.1")]);
  for (const name of [NODE_FILE, CADVISOR_FILE]) {
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o644);
  }
});
