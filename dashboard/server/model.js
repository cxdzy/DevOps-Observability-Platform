// Data for the Model view: the MLflow registry (champion, previous, recent versions) and, from
// InfluxDB, the decision threshold each version used and the latest retraining record.
// MLflow and InfluxDB are read independently, so one being down does not hide the other.
const { createMlflow } = require("./mlflow");

const VERSION_LIMIT = 8;
// Threshold lookups are one query per model tag value, so only the newest few are read.
const THRESHOLD_LIMIT = 12;

// Promotion rules, copied from the defaults in worker/worker.py (PROMOTE_MARGIN, MIN_TEST_ANOMALIES,
// MIN_TEST_INJECTIONS, MIN_INJECTION_DETECTION, MIN_RECALL, RETRAIN_HOUR_UTC). Keep them in step.
const RULES = Object.freeze({
  promoteMargin: 0.01,
  minTestAnomalies: 10,
  minTestInjections: 20,
  minInjectionDetection: 0.95,
  minRecall: 0.6,
  retrainHourUtc: 19,
});

// anomaly_score has "model" as a tag (for example v10) and "threshold" as a field.
const MODEL_TAGS_QUERY = 'SHOW TAG VALUES FROM "anomaly_score" WITH KEY = "model"';
const THRESHOLD_QUERY = 'SELECT last("threshold") FROM "anomaly_score" WHERE "model" = \'%M\'';
const RETRAIN_QUERY = 'SELECT * FROM "model_retrain" ORDER BY time DESC LIMIT 1';
const MODEL_TAG = /^v(\d{1,6})$/;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// One registry model version as the client needs it.
function toVersion(mv, aliases) {
  if (!mv || mv.version === undefined) return null;
  const version = String(mv.version);
  const tag = (mv.tags || []).find((t) => t.key === "test_f1");
  return {
    version,
    createdAt: num(mv.creation_timestamp),
    testF1: tag ? num(tag.value) : null,
    runId: mv.run_id ? String(mv.run_id).slice(0, 8) : null,
    aliases: aliases.filter((a) => a.version === version).map((a) => a.alias),
  };
}

async function loadRegistry(mlflow) {
  const [registered, champion, previous, search] = await Promise.all([
    mlflow.registeredModel(),
    mlflow.versionByAlias("champion"),
    mlflow.versionByAlias("previous"),
    mlflow.searchVersions(),
  ]);
  const aliases = ((registered && registered.registered_model && registered.registered_model.aliases) || [])
    .map((a) => ({ alias: String(a.alias), version: String(a.version) }));
  const versions = ((search && search.model_versions) || [])
    .map((mv) => toVersion(mv, aliases))
    .filter(Boolean)
    .sort((a, b) => Number(b.version) - Number(a.version))
    .slice(0, VERSION_LIMIT);
  return {
    champion: toVersion(champion && champion.model_version, aliases),
    previous: toVersion(previous && previous.model_version, aliases),
    versions,
  };
}

async function loadInflux(query) {
  const [tags, retrains] = await Promise.all([query(MODEL_TAGS_QUERY), query(RETRAIN_QUERY)]);
  // Only well-formed tag values (v and digits) are put into a query.
  const models = tags
    .map((row) => String(row.value || ""))
    .filter((v) => MODEL_TAG.test(v))
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
    .slice(0, THRESHOLD_LIMIT);
  const rows = await Promise.all(models.map((m) => query(THRESHOLD_QUERY.replace("%M", m))));
  const thresholds = models.map((model, i) => ({
    model,
    version: model.slice(1),
    threshold: rows[i][0] ? num(rows[i][0].last) : null,
    lastSeen: rows[i][0] ? num(rows[i][0].time) : null,
  }));
  return { thresholds, lastRetrain: retrains[0] || null };
}

function createModel({ query, mlflow }) {
  const client = mlflow || createMlflow();

  // Throws only when both sources fail.
  async function load() {
    const [registry, influx] = await Promise.allSettled([loadRegistry(client), loadInflux(query)]);
    if (registry.status === "rejected" && influx.status === "rejected") {
      throw new Error("mlflow and influxdb unreachable");
    }
    const r = registry.status === "fulfilled" ? registry.value : { champion: null, previous: null, versions: null };
    const i = influx.status === "fulfilled" ? influx.value : { thresholds: null, lastRetrain: null };
    return {
      champion: r.champion,
      previous: r.previous,
      versions: r.versions,
      thresholds: i.thresholds,
      lastRetrain: i.lastRetrain,
      rules: RULES,
      mlflowOk: registry.status === "fulfilled",
      influxOk: influx.status === "fulfilled",
    };
  }

  return { load };
}

module.exports = { createModel, RULES, VERSION_LIMIT };
