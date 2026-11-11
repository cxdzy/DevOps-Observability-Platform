// Data for the Overview page: servers and containers from Prometheus, recent activity from InfluxDB.
// Every query is a constant here; nothing from the request is ever put into a query.
const { createPrometheus } = require("./prometheus");
const { mergeIncidents } = require("./incidents");
const { createRegistry } = require("./registry");

// The servers come from the registry (registry.js). The two built-in servers use the scrape jobs in
// prometheus/prometheus.yml, with the constant queries below. Servers added in the dashboard get
// the same queries with their own selector (see extraQueries), one set per server.

const NODE_JOBS = 'job=~"node-exporter|node-exporter-old"';
const CADVISOR_JOBS = 'job=~"cadvisor|cadvisor-old"';
const ROOT_FS = 'mountpoint="/",fstype!~"tmpfs|overlay"';

const QUERIES = Object.freeze({
  uname: `node_uname_info{${NODE_JOBS}}`,
  up: `up{${NODE_JOBS}}`,
  memTotal: `node_memory_MemTotal_bytes{${NODE_JOBS}}`,
  memAvailable: `node_memory_MemAvailable_bytes{${NODE_JOBS}}`,
  diskSize: `node_filesystem_size_bytes{${NODE_JOBS},${ROOT_FS}}`,
  diskAvailable: `node_filesystem_avail_bytes{${NODE_JOBS},${ROOT_FS}}`,
  cpuCount: `count by (job) (node_cpu_seconds_total{${NODE_JOBS},mode="idle"})`,
  cpuBusy: `1 - avg by (job) (rate(node_cpu_seconds_total{${NODE_JOBS},mode="idle"}[5m]))`,
  containers: `count by (job) (count by (job, name) (container_memory_working_set_bytes{${CADVISOR_JOBS},name!=""}))`,
  services: 'container_memory_working_set_bytes{job="cadvisor",name!=""}',
});

// The same node queries for one server added in the dashboard. %N is replaced by the server's node
// selector and %C by its cAdvisor selector from the registry, built from the validated key only
// (see registry.js).
const EXTRA_TEMPLATES = Object.freeze({
  uname: "node_uname_info{%N}",
  up: "up{%N}",
  memTotal: "node_memory_MemTotal_bytes{%N}",
  memAvailable: "node_memory_MemAvailable_bytes{%N}",
  diskSize: `node_filesystem_size_bytes{%N,${ROOT_FS}}`,
  diskAvailable: `node_filesystem_avail_bytes{%N,${ROOT_FS}}`,
  cpuCount: 'count by (job) (node_cpu_seconds_total{%N,mode="idle"})',
  cpuBusy: '1 - avg by (job) (rate(node_cpu_seconds_total{%N,mode="idle"}[5m]))',
  containers: 'count by (job) (count by (job, name) (container_memory_working_set_bytes{%C,name!=""}))',
});

// The query strings of one registry server, by name.
function extraQueries(server) {
  return Object.fromEntries(
    Object.entries(EXTRA_TEMPLATES).map(([k, t]) => [k, t.replace(/%N/g, server.nodeSel).replace(/%C/g, server.cadvisorSel)])
  );
}

// Containers expected on the main server: the container_name values in docker-compose.yml, plus
// sample-service, which the CI workflow starts with docker run on the same network.
const EXPECTED = [
  { name: "sample-service", role: "Monitored service" },
  { name: "worker", role: "Detection" },
  { name: "explainer", role: "Explanations" },
  { name: "ollama", role: "LLM" },
  { name: "influxdb", role: "Metrics store" },
  { name: "prometheus", role: "Scraping" },
  { name: "node-exporter", role: "Host metrics" },
  { name: "cadvisor", role: "Container metrics" },
  { name: "grafana", role: "Dashboards" },
  { name: "mlflow", role: "Model registry" },
  { name: "fyp-postgres", role: "Database" },
  { name: "n8n", role: "Notifications" },
  { name: "cloudflared", role: "Tunnel" },
  { name: "docker-socket-proxy", role: "Docker API proxy" },
  { name: "dashboard", role: "Dashboard" },
];

// InfluxDB queries for the activity list.
const INCIDENT_HOURS = 168;
const EXPLANATION_QUERY =
  'SELECT "tier","action","signal","peak_score","minutes","source","deployment","explanation","job" ' +
  'FROM "incident_explanation" WHERE time > now() - %Hh ORDER BY time ASC';
const OPEN_QUERY =
  'SELECT "tier","tier_level","action","signal","peak_score","minutes","deployment","job" ' +
  'FROM "incident_open" WHERE time > now() - %Hh ORDER BY time ASC';
// Only real deployments from the CI workflow; the fault injector writes source=simulated.
const DEPLOY_QUERY =
  'SELECT "commit_sha","pipeline_run_id","branch" FROM "deployment_event" WHERE "source" = \'ci\' ORDER BY time DESC LIMIT 1';
const RETRAIN_QUERY =
  'SELECT "promoted","new_version","champion_version","champion_f1","challenger_f1" FROM "model_retrain" ORDER BY time DESC LIMIT 1';
const ACTIVITY_LIMIT = 5;

// hours is always a validated integer from the caller, never request text.
async function loadIncidents(query, hours, nowMs) {
  const h = String(Math.trunc(Number(hours)));
  const [expl, open] = await Promise.all([
    query(EXPLANATION_QUERY.replace("%H", h)),
    query(OPEN_QUERY.replace("%H", h)),
  ]);
  return mergeIncidents(expl, open, nowMs);
}

function byJob(rows) {
  const map = new Map();
  for (const row of rows) {
    const job = row.labels.job;
    if (job && !map.has(job)) map.set(job, row);
  }
  return map;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// InfluxDB values: a missing field is null, never 0.
function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return numberOrNull(Number(value));
}

function text(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

// registry: from registry.js; without one only the built-in servers are shown.
function createOverview({ query, prometheus, registry = createRegistry() }) {
  // The allow list is the constant queries plus those of the active registry servers. It is
  // rebuilt only when the registry changes.
  const allowed = registry.derived((snap) => [
    ...Object.values(QUERIES),
    ...snap.activeServers.filter((s) => !s.builtin).flatMap((s) => Object.values(extraQueries(s))),
  ]);
  const prom = prometheus || createPrometheus({ allowed });

  async function nodes() {
    await registry.load();
    const servers = registry.current().activeServers;
    const extra = servers.filter((s) => !s.builtin);
    const names = Object.keys(QUERIES).filter((k) => k !== "services");
    const extraNames = Object.keys(EXTRA_TEMPLATES);
    const [results, extraResults] = await Promise.all([
      Promise.all(names.map((k) => prom.query(QUERIES[k]))),
      Promise.all(extra.map((s) => Promise.all(extraNames.map((k) => prom.query(extraQueries(s)[k]))))),
    ]);
    const r = Object.fromEntries(names.map((k, i) => [k, byJob(results[i])]));
    const extraBy = new Map(extra.map((s, i) => [s.key, Object.fromEntries(extraNames.map((k, j) => [k, extraResults[i][j]]))]));

    return servers.map((s) => {
      // One reader per server: built-in servers pick their job out of the shared results, the
      // others read their own queries.
      const row = (name, job) => (s.builtin ? r[name].get(job) : extraBy.get(s.key)[name][0]);
      const value = (name, job) => numberOrNull(row(name, job)?.value);
      const up = value("up", s.nodeJob);
      return {
        key: s.key,
        displayName: s.displayName,
        hostname: text(row("uname", s.nodeJob)?.labels.nodename),
        role: s.roleLabel,
        provider: s.provider,
        location: s.place,
        up: up === null ? null : up === 1,
        memoryTotalBytes: value("memTotal", s.nodeJob),
        memoryAvailableBytes: value("memAvailable", s.nodeJob),
        diskSizeBytes: value("diskSize", s.nodeJob),
        diskAvailableBytes: value("diskAvailable", s.nodeJob),
        cpuCount: value("cpuCount", s.nodeJob),
        cpuBusy: value("cpuBusy", s.nodeJob),
        containers: value("containers", s.cadvisorJob),
      };
    });
  }

  async function services() {
    const rows = await prom.query(QUERIES.services);
    const seen = new Map();
    for (const row of rows) {
      const name = text(row.labels.name);
      if (name && !seen.has(name)) seen.set(name, { name, memoryBytes: numberOrNull(row.value) });
    }
    // No named container at all means cAdvisor is not running or cannot read Docker, not that
    // every service is down. unknown tells the client not to list the services as missing.
    return {
      expected: EXPECTED,
      containers: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
      unknown: seen.size === 0,
    };
  }

  async function activity(nowMs) {
    const [incidents, deploys, retrains] = await Promise.all([
      loadIncidents(query, INCIDENT_HOURS, nowMs),
      query(DEPLOY_QUERY),
      query(RETRAIN_QUERY),
    ]);
    // The latest CI deployment and the latest retraining always keep a slot when they exist;
    // the newest closed incidents fill the rest.
    const fixed = [];
    const deploy = deploys[0];
    if (deploy && deploy.time) {
      fixed.push({
        type: "deployment",
        time: Number(deploy.time),
        commit: text(deploy.commit_sha),
        runId: text(deploy.pipeline_run_id),
        branch: text(deploy.branch),
      });
    }
    const retrain = retrains[0];
    if (retrain && retrain.time) {
      fixed.push({
        type: "retrain",
        time: Number(retrain.time),
        promoted: Number(retrain.promoted) === 1,
        newVersion: text(retrain.new_version),
        championVersion: text(retrain.champion_version),
        championF1: toNumber(retrain.champion_f1),
        challengerF1: toNumber(retrain.challenger_f1),
      });
    }
    // mergeIncidents returns the newest first.
    const recent = incidents
      .filter((i) => i.status === "closed")
      .slice(0, ACTIVITY_LIMIT - fixed.length)
      .map((i) => ({
        type: "incident",
        time: i.start,
        tier: i.tier,
        signal: i.signal,
        action: i.action,
        minutes: i.minutes,
        peakScore: i.peakScore,
      }));
    return [...fixed, ...recent].sort((a, b) => b.time - a.time);
  }

  return { nodes, services, activity };
}

module.exports = { createOverview, loadIncidents, QUERIES, EXPECTED, extraQueries };
