// Read-only InfluxDB 1.x helper. Only SELECT and SHOW statements are allowed, sent with GET.
const INFLUX_URL = process.env.INFLUX_URL || "http://influxdb:8086";
const INFLUX_DB = process.env.INFLUX_DB || "prometheus";

function checkQuery(q) {
  const text = String(q).trim();
  if (!/^(select|show)\b/i.test(text)) {
    throw new Error("only SELECT and SHOW statements are allowed");
  }
  // SELECT ... INTO writes data in InfluxDB 1.x even over GET.
  if (/\binto\b/i.test(text)) {
    throw new Error("INTO is not allowed");
  }
  if (text.includes(";")) {
    throw new Error("semicolons are not allowed");
  }
  return text;
}

async function query(q) {
  const text = checkQuery(q);
  const params = new URLSearchParams({ db: INFLUX_DB, epoch: "ms", q: text });
  const res = await fetch(`${INFLUX_URL}/query?${params}`, {
    method: "GET",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`influxdb returned ${res.status}`);
  }
  const body = await res.json();
  const result = body.results && body.results[0];
  if (body.error || (result && result.error)) {
    throw new Error(body.error || result.error);
  }
  const series = result && result.series && result.series[0];
  if (!series) {
    return [];
  }
  return series.values.map((row) =>
    Object.fromEntries(series.columns.map((name, i) => [name, row[i]]))
  );
}

module.exports = { query, checkQuery, INFLUX_URL };
