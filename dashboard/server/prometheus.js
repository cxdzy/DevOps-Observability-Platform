// Read-only Prometheus helper. Only instant queries (/api/v1/query) are sent, with GET, and only
// query strings from an allow list (the constants in overview.js), never text from a request.
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const TIMEOUT_MS = 5000;

// allowed: the query strings this client may send.
function createPrometheus({ allowed, url = PROMETHEUS_URL }) {
  const allowList = new Set(allowed);

  // Returns the result vector as [{ labels, value }]; value is a number or null.
  async function query(q) {
    if (!allowList.has(q)) {
      throw new Error("query is not in the allow list");
    }
    const params = new URLSearchParams({ query: q });
    const res = await fetch(`${url}/api/v1/query?${params}`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`prometheus returned ${res.status}`);
    }
    const body = await res.json();
    if (!body || body.status !== "success" || !body.data || body.data.resultType !== "vector") {
      throw new Error("prometheus returned an unexpected response");
    }
    return body.data.result.map((item) => {
      const n = Number(item.value && item.value[1]);
      return { labels: { ...item.metric }, value: Number.isFinite(n) ? n : null };
    });
  }

  return { query };
}

module.exports = { createPrometheus, PROMETHEUS_URL };
