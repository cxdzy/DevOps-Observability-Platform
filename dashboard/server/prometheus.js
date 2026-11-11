// Read-only Prometheus helper. Only instant queries (/api/v1/query) and range queries
// (/api/v1/query_range) are sent, with GET, and only query strings from an allow list (the
// constants in overview.js and resources.js), never text from a request. The one other request is
// the fixed address /api/v1/targets?state=active, which has no input at all.
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const TIMEOUT_MS = 5000;
const TARGETS_PATH = "/api/v1/targets?state=active";

// allowed: the query strings this client may send, as an array, or a function that returns the
// current array (the registry adds and removes servers). The function must return the same array
// object until the list changes; the set is rebuilt only when the object changes.
function createPrometheus({ allowed, url = PROMETHEUS_URL }) {
  const fixed = typeof allowed === "function" ? null : new Set(allowed);
  let lastList = null;
  let lastSet = null;
  const allowList = {
    has(q) {
      if (fixed) return fixed.has(q);
      const list = allowed();
      if (list !== lastList) {
        lastList = list;
        lastSet = new Set(list);
      }
      return lastSet.has(q);
    },
  };

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

  // Range query from startSec to endSec (Unix seconds) every stepSec seconds. Returns the matrix
  // as [{ labels, values: [[ms, number|null]] }]. The times are numbers the caller computed, never
  // request text; anything that is not a finite number is refused before a request is sent.
  async function queryRange(q, startSec, endSec, stepSec) {
    if (!allowList.has(q)) {
      throw new Error("query is not in the allow list");
    }
    const times = [startSec, endSec, stepSec];
    if (!times.every((n) => typeof n === "number" && Number.isFinite(n)) || stepSec <= 0 || endSec < startSec) {
      throw new Error("range times must be finite numbers with a positive step");
    }
    const params = new URLSearchParams({
      query: q,
      start: String(startSec),
      end: String(endSec),
      step: String(stepSec),
    });
    const res = await fetch(`${url}/api/v1/query_range?${params}`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`prometheus returned ${res.status}`);
    }
    const body = await res.json();
    if (!body || body.status !== "success" || !body.data || body.data.resultType !== "matrix") {
      throw new Error("prometheus returned an unexpected response");
    }
    return body.data.result.map((item) => ({
      labels: { ...item.metric },
      values: (Array.isArray(item.values) ? item.values : []).map((pair) => {
        const n = Number(pair && pair[1]);
        return [Number(pair && pair[0]) * 1000, Number.isFinite(n) ? n : null];
      }),
    }));
  }

  // The active scrape targets as [{ job, server, health, lastError, lastScrape }]. server is the
  // server label or "" when the target has none. The address is a constant; nothing from a
  // request is added to it.
  async function targets() {
    const res = await fetch(`${url}${TARGETS_PATH}`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`prometheus returned ${res.status}`);
    }
    const body = await res.json();
    if (!body || body.status !== "success" || !body.data || !Array.isArray(body.data.activeTargets)) {
      throw new Error("prometheus returned an unexpected response");
    }
    return body.data.activeTargets.map((t) => {
      const labels = (t && t.labels) || {};
      return {
        job: String(labels.job || ""),
        server: String(labels.server || ""),
        health: String((t && t.health) || "unknown"),
        lastError: String((t && t.lastError) || ""),
        lastScrape: t && t.lastScrape ? String(t.lastScrape) : null,
      };
    });
  }

  return { query, queryRange, targets };
}

module.exports = { createPrometheus, PROMETHEUS_URL };
