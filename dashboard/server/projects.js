// GET /api/projects: every active project with the state of its containers, its status, its last
// deployment, its rollback and a 24 hour strip of 15 minute cells. The container data comes from
// resources.containers() (cAdvisor), so the queries and their allow list are the ones that file
// already has. Nothing from a request reaches a query: the route takes no input.
const { loadStatus } = require("./status");
const { loadIncidents } = require("./overview");
const { rollbackBlock } = require("./deployments");

const CELL_MS = 15 * 60 * 1000;
const STRIP_HOURS = 24;
// The only project the incident logic (the anomaly model) watches.
const INCIDENT_PROJECT = "sample-service";

// The strip of one project. cellsByContainer is a list of the cells of each of its containers (the
// state of each 15 minute cell as resources.js reports it, or null for a container with no data).
// A cell is down when no container was seen in it although one was seen earlier in the day. Order
// of priority: down, incident, deploy, restart, up.
function buildStrip(times, cellsByContainer, incidents, deploys) {
  let seenBefore = false;
  return times.map((t, i) => {
    const states = cellsByContainer.map((cells) => (cells && cells[i] ? cells[i].state : "nodata"));
    const present = states.some((s) => s !== "nodata");
    const from = t - CELL_MS;
    let state;
    if (!present) state = seenBefore ? "down" : "nodata";
    else if (incidents.some((w) => w.start <= t && w.end > from)) state = "incident";
    else if (deploys.some((d) => d > from && d <= t)) state = "deploy";
    else if (states.includes("restarted")) state = "restart";
    else state = "up";
    if (present) seenBefore = true;
    return state;
  });
}

function createProjects({ registry, resources, deployments, query, now = Date.now }) {
  // The cAdvisor data of each server that has a project, or null when Prometheus failed for it.
  async function containerData(serverKeys) {
    const results = await Promise.allSettled(serverKeys.map((k) => resources.containers(k)));
    return new Map(serverKeys.map((k, i) => [k, results[i].status === "fulfilled" ? results[i].value : null]));
  }

  async function load() {
    await registry.load();
    const snap = registry.current();
    const servers = new Map(snap.activeServers.map((s) => [s.key, s]));
    const projects = snap.projects.filter((p) => p.status === "active" && servers.has(p.server_key));
    if (!projects.length) return [];

    const serverKeys = [...new Set(projects.map((p) => p.server_key))];
    const nowMs = now();
    const [data, status, incidentRows, perProject] = await Promise.all([
      containerData(serverKeys),
      // The incident marks are optional: when InfluxDB fails they are left out, not guessed.
      loadStatus(query, nowMs).catch(() => null),
      loadIncidents(query, STRIP_HOURS, nowMs).catch(() => []),
      // Deployments that are not available are null, which shows as no last deployment.
      Promise.all(
        projects.map(async (p) => {
          const [latest, recent] = await Promise.all([
            deployments.runs(p, { limit: 1 }).catch(() => null),
            deployments.runs(p, { hours: STRIP_HOURS }).catch(() => []),
          ]);
          return { latest: latest && latest[0] ? latest[0] : null, recent };
        })
      ),
    ]);
    if ([...data.values()].every((d) => d === null)) {
      const err = new Error("prometheus unreachable");
      err.code = "PROMETHEUS_DOWN";
      throw err;
    }

    const incidents = incidentRows.map((i) => ({ start: i.start, end: Math.max(i.end, i.start + 60000) }));
    const incidentNow = Boolean(status && status.state === "incident");

    return projects.map((p, idx) => {
      const server = servers.get(p.server_key);
      const d = data.get(p.server_key);
      const byName = new Map(d ? d.containers.map((c) => [c.name, c]) : []);
      const rows = p.containers.map((name) => byName.get(name) || null);
      const containers = p.containers.map((name, i) => {
        const c = rows[i];
        return {
          name,
          up: Boolean(c && c.memBytes !== null),
          restarts24h: c ? c.restarts24h : null,
          memBytes: c ? c.memBytes : null,
          limitBytes: c ? c.limitBytes : null,
        };
      });

      const upCount = containers.filter((c) => c.up).length;
      const seen = rows.some((c) => c !== null);
      let state;
      if (!d || !seen) state = "no_data";
      else if (upCount === 0) state = "down";
      else if (upCount < containers.length) state = "partial";
      else if (p.key === INCIDENT_PROJECT && incidentNow) state = "incident";
      else state = "healthy";

      const times = d ? cellTimes(d) : [];
      const strip = times.length
        ? buildStrip(
            times,
            rows.map((c) => (c ? c.cells : null)),
            p.key === INCIDENT_PROJECT ? incidents : [],
            perProject[idx].recent.map((r) => r.at)
          )
        : Array.from({ length: (STRIP_HOURS * 3600000) / CELL_MS }, () => "nodata");

      const latest = perProject[idx].latest;
      return {
        key: p.key,
        name: p.name,
        server: { key: server.key, name: server.name },
        containers,
        status: state,
        watchedByModel: p.automation === "approval",
        automation: p.automation,
        deploySource: p.deploy_source,
        lastDeploy: latest ? { at: latest.at, source: latest.source, ref: latest.ref } : null,
        rollback: rollbackBlock(p.rollback || "none", latest, nowMs),
        strip,
      };
    });
  }

  return { load };
}

// The end time of each of the 96 cells, from the end time and step in the resources answer.
function cellTimes(data) {
  const cells = (STRIP_HOURS * 3600000) / CELL_MS;
  return Array.from({ length: cells }, (_, i) => data.end - (cells - 1 - i) * CELL_MS);
}

module.exports = { createProjects, buildStrip, CELL_MS };
