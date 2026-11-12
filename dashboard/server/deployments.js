// Deployments per project, and the image watcher that finds deployments of projects without a CI
// pipeline. A project that deploys with CI has deployment_event rows in InfluxDB. A project that
// deploys from an image has no event, so the watcher asks Prometheus (cAdvisor's image label) which
// image each container runs and records a row in detected_deployments when it changes.
//
// Nothing from a request reaches a query. The project key and the number of days are checked
// against the registry and a fixed list first. Container names come from the registry and are
// checked again here before they go into InfluxQL or PromQL.
const { createPrometheus } = require("./prometheus");
const { CONTAINER_RE } = require("./registry");

const DAYS = Object.freeze([7, 30, 90]);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WATCH_INTERVAL_MS = 60 * 1000;
// Severe latency is rolled back only when a deployment happened in the last 15 minutes.
const ROLLBACK_WINDOW_MS = 15 * 60 * 1000;
const MAX_RUNS = 100;

const ROLLBACK_TEXT = Object.freeze({
  own_pipeline: "Rollback is handled by the project's own pipeline",
  none: "No rollback from this platform",
});

function text(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

// ---- PromQL for the image watcher

// A container name as a regex alternative. The text is a regex first (dots and other special
// characters escaped) and then a PromQL string, where every backslash is written twice.
function escapeName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\/g, "\\\\");
}

// The current image of each container of a project. container_last_seen is the time the
// container was last seen, so when a recreated container briefly has two series the newest image
// can be told from the old one. Returns null when the project has no valid container name.
function imageQuery(server, containers) {
  const names = [...new Set((containers || []).filter((n) => typeof n === "string" && CONTAINER_RE.test(n)))].sort();
  if (!names.length) return null;
  return `max by (name, image) (container_last_seen{${server.cadvisorSel},name=~"${names.map(escapeName).join("|")}"})`;
}

// ---- Runs

// InfluxQL for the CI deployments of a project. The names pass CONTAINER_RE, which allows no
// quote or other character that could end the string; hours and limit are whole numbers made here.
function ciQuery(containers, hours, limit) {
  const names = [...new Set((containers || []).filter((n) => typeof n === "string" && CONTAINER_RE.test(n)))].sort();
  if (!names.length) return null;
  const match = names.map((n) => `"container_name" = '${n}'`).join(" OR ");
  let q =
    'SELECT "commit_sha","pipeline_run_id","branch","previous_image" FROM "deployment_event" ' +
    `WHERE "source" = 'ci' AND (${match})`;
  if (hours) q += ` AND time > now() - ${Math.trunc(hours)}h`;
  q += " ORDER BY time DESC";
  if (limit) q += ` LIMIT ${Math.trunc(limit)}`;
  return q;
}

function ciRun(row) {
  const runId = text(row.pipeline_run_id);
  const branch = text(row.branch);
  return {
    at: Number(row.time),
    source: "ci",
    ref: text(row.commit_sha),
    previousRef: text(row.previous_image),
    detail: [branch ? `Branch ${branch}` : null, runId ? `run ${runId}` : null].filter(Boolean).join(", ") || null,
    runId,
    branch,
  };
}

function imageRun(row) {
  return {
    at: new Date(row.detected_at).getTime(),
    source: "image",
    ref: row.new_image,
    previousRef: row.old_image,
    detail: `Container ${row.container_name}`,
    runId: null,
    branch: null,
  };
}

// Monday 00:00 UTC of the week that holds ms, as YYYY-MM-DD.
function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

// One entry per week from the week of fromMs to the week of toMs, empty weeks included.
function weeklyCounts(runs, fromMs, toMs) {
  const counts = new Map();
  for (let t = Date.parse(weekStart(fromMs)); t <= toMs; t += 7 * DAY_MS) counts.set(weekStart(t), 0);
  for (const r of runs) {
    const w = weekStart(r.at);
    if (counts.has(w)) counts.set(w, counts.get(w) + 1);
  }
  return [...counts].map(([week, count]) => ({ week, count }));
}

// The rollback block for a project. n8n rolls back only within 15 minutes of a deployment; ready
// says whether that holds right now.
function rollbackBlock(mode, latest, nowMs) {
  if (mode === "n8n") {
    const age = latest ? nowMs - latest.at : null;
    const ready = age !== null && age >= 0 && age <= ROLLBACK_WINDOW_MS;
    return {
      mode,
      ready,
      text: ready
        ? "Rollback is ready. The last deployment is less than 15 minutes old, so a severe latency problem would be rolled back after approval."
        : "No rollback is possible right now. A rollback is offered only within 15 minutes of a deployment.",
    };
  }
  return { mode, ready: false, text: ROLLBACK_TEXT[mode] || ROLLBACK_TEXT.none };
}

// deps: { db, registry, query, prometheus, now, log }. prometheus is for the watcher and lets
// tests pass a client; the default one follows the registry.
function createDeployments({ db, registry, query, prometheus, now = Date.now, log = console.log }) {
  // The watcher's query for every active image project, rebuilt only when the registry changes.
  function watched(snap) {
    const servers = new Map(snap.activeServers.map((s) => [s.key, s]));
    const out = [];
    for (const p of snap.projects) {
      if (p.status !== "active" || p.deploy_source !== "image") continue;
      const server = servers.get(p.server_key);
      const q = server ? imageQuery(server, p.containers) : null;
      if (q) out.push({ project: p, server, query: q });
    }
    return out;
  }
  const watchedList = registry.derived(watched);
  const allowed = registry.derived((snap) => watched(snap).map((w) => w.query));
  const prom = prometheus || createPrometheus({ allowed });

  // The newest runs of a project, newest first. hours limits how far back (null for no limit) and
  // limit how many (null for all). Throws when InfluxDB or the database fails.
  async function runs(project, { hours = null, limit = null } = {}) {
    if (project.deploy_source === "ci") {
      const q = ciQuery(project.containers, hours, limit);
      if (!q) return [];
      return (await query(q)).filter((r) => r && r.time !== undefined && r.time !== null).map(ciRun);
    }
    const since = hours ? new Date(now() - hours * HOUR_MS) : null;
    return (await db.listDetectedDeployments(project.key, since, limit)).map(imageRun);
  }

  // The body of GET /api/deployments. project is a registry project row, days one of DAYS.
  async function load(project, days) {
    const nowMs = now();
    const [inWindow, newest] = await Promise.all([runs(project, { hours: days * 24 }), runs(project, { limit: 1 })]);
    const latest = newest[0] || null;
    return {
      project: project.key,
      runs: inWindow.slice(0, MAX_RUNS),
      weeks: weeklyCounts(inWindow, nowMs - days * DAY_MS, nowMs),
      latest,
      rollback: rollbackBlock(project.rollback || "none", latest, nowMs),
    };
  }

  // ---- The watcher

  let timer = null;
  let running = false;
  let promFailing = false;
  let dbFailing = false;

  // Looks at every active image project once. Never throws. A Prometheus or database failure
  // skips the tick and is logged once until the next tick that works.
  async function tick() {
    if (running) return;
    running = true;
    try {
      await registry.load();
      const list = watchedList();
      if (!list.length) return;

      // Ask Prometheus first and take the lock only to write, so the lock is held briefly.
      const seen = [];
      try {
        for (const w of list) {
          const rows = await prom.query(w.query);
          // Per container the image with the newest last-seen time. When two images tie or have
          // no time the container is skipped this tick rather than guessed.
          const best = new Map();
          for (const r of rows) {
            const name = r.labels && r.labels.name;
            const image = r.labels && r.labels.image;
            if (typeof name !== "string" || typeof image !== "string" || !image || !w.project.containers.includes(name)) continue;
            const cur = best.get(name);
            if (!cur) best.set(name, { image, value: r.value, tied: false });
            else if (r.value !== null && (cur.value === null || r.value > cur.value)) best.set(name, { image, value: r.value, tied: false });
            else if (r.value === cur.value && image !== cur.image) cur.tied = true;
          }
          for (const [name, b] of best) if (!b.tied) seen.push({ project: w.project, server: w.server, name, image: b.image });
        }
        promFailing = false;
      } catch (err) {
        if (!promFailing) log(JSON.stringify({ event: "image_watcher_prometheus_failed", error: String(err && err.message) }));
        promFailing = true;
        return;
      }

      try {
        await db.withWatcherLock(async (ops) => {
          const known = new Map((await ops.listContainerImages()).map((r) => [`${r.server_key}|${r.container_name}`, r.image]));
          const at = new Date(now());
          for (const s of seen) {
            const old = known.get(`${s.server.key}|${s.name}`);
            if (old === s.image) continue;
            // The first sighting only stores the image. A different image is a deployment.
            if (old !== undefined) {
              await ops.insertDetectedDeployment({
                projectKey: s.project.key,
                serverKey: s.server.key,
                containerName: s.name,
                oldImage: old,
                newImage: s.image,
                detectedAt: at,
              });
            }
            await ops.upsertContainerImage({ serverKey: s.server.key, containerName: s.name, image: s.image, seenAt: at });
          }
        });
        dbFailing = false;
      } catch (err) {
        if (!dbFailing) log(JSON.stringify({ event: "image_watcher_db_failed", error: String(err && err.message) }));
        dbFailing = true;
      }
    } catch (err) {
      log(JSON.stringify({ event: "image_watcher_failed", error: String(err && err.message) }));
    } finally {
      running = false;
    }
  }

  // The timer does not keep the process alive. start() twice does nothing.
  function start(intervalMs = WATCH_INTERVAL_MS) {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref();
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { load, runs, tick, start, stop, allowed };
}

module.exports = { createDeployments, imageQuery, ciQuery, escapeName, rollbackBlock, weeklyCounts, DAYS, WATCH_INTERVAL_MS, ROLLBACK_WINDOW_MS };
