// Read-only MLflow model registry helper (MLflow 2.17 REST API). GET only, three endpoints, and
// every parameter comes from the constants below, never from a request.
const MLFLOW_URL = process.env.MLFLOW_URL || "http://mlflow:5000";
const TIMEOUT_MS = 5000;

// The registered model and aliases the worker uses (worker/worker.py: MODEL_NAME, MODEL_ALIAS and
// the "previous" alias set on promotion).
const MODEL_NAME = "anomaly-detector";
const ALIASES = Object.freeze(["champion", "previous"]);
// The registry holds one version per training or promotion, far fewer than this.
const SEARCH_MAX_RESULTS = 200;

const ENDPOINTS = Object.freeze({
  model: "/api/2.0/mlflow/registered-models/get",
  alias: "/api/2.0/mlflow/registered-models/alias",
  search: "/api/2.0/mlflow/model-versions/search",
});

function createMlflow({ url = MLFLOW_URL } = {}) {
  // Returns the parsed body, or null for 404 (for example an alias that is not set yet).
  async function get(endpoint, params) {
    const res = await fetch(`${url}${endpoint}?${new URLSearchParams(params)}`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`mlflow returned ${res.status}`);
    return res.json();
  }

  return {
    registeredModel: () => get(ENDPOINTS.model, { name: MODEL_NAME }),
    // alias must be one of ALIASES.
    versionByAlias(alias) {
      if (!ALIASES.includes(alias)) throw new Error("unknown alias");
      return get(ENDPOINTS.alias, { name: MODEL_NAME, alias });
    },
    searchVersions: () =>
      get(ENDPOINTS.search, { filter: `name='${MODEL_NAME}'`, max_results: String(SEARCH_MAX_RESULTS) }),
  };
}

module.exports = { createMlflow, MLFLOW_URL, MODEL_NAME, ALIASES, ENDPOINTS };
