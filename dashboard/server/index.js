const path = require("path");
const express = require("express");
const { query, INFLUX_URL } = require("./influx");
const { mergeIncidents } = require("./incidents");

const PORT = process.env.PORT || 3000;
const CLIENT_DIST = path.resolve(process.env.CLIENT_DIST || "/app/client/dist");

const app = express();
app.disable("x-powered-by");

app.get("/api/health", async (req, res) => {
  let influx = false;
  try {
    const r = await fetch(`${INFLUX_URL}/ping`, { signal: AbortSignal.timeout(2000) });
    influx = r.ok;
  } catch (err) {
    influx = false;
  }
  res.json({ status: "ok", time: new Date().toISOString(), influx });
});

app.get("/api/anomaly/latest", async (req, res) => {
  try {
    const rows = await query('SELECT * FROM "anomaly_score" ORDER BY time DESC LIMIT 1');
    res.json(rows[0] || {});
  } catch (err) {
    res.status(502).json({ error: "influxdb unreachable" });
  }
});

// Returns the validated hours value, or null after sending a 400.
function hoursParam(req, res) {
  const raw = req.query.hours;
  if (raw === undefined) return 24;
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw.trim())) {
    res.status(400).json({ error: "hours must be an integer" });
    return null;
  }
  return Math.min(168, Math.max(1, parseInt(raw, 10)));
}

app.get("/api/anomaly", async (req, res) => {
  const hours = hoursParam(req, res);
  if (hours === null) return;
  try {
    const rows = await query(
      'SELECT "score","threshold","is_anomaly","tier","tier_level","signal","cpu_rate","memory_mb","latency_ms","recent_deployment","model" ' +
        `FROM "anomaly_score" WHERE time > now() - ${hours}h ORDER BY time ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(502).json({ error: "influxdb unreachable" });
  }
});

app.get("/api/incidents", async (req, res) => {
  const hours = hoursParam(req, res);
  if (hours === null) return;
  try {
    const [expl, open] = await Promise.all([
      query(
        'SELECT "tier","action","signal","peak_score","minutes","source","deployment","explanation" ' +
          `FROM "incident_explanation" WHERE time > now() - ${hours}h ORDER BY time ASC`
      ),
      query(
        'SELECT "tier","tier_level","action","signal","peak_score","minutes","deployment" ' +
          `FROM "incident_open" WHERE time > now() - ${hours}h ORDER BY time ASC`
      ),
    ]);
    res.json(mergeIncidents(expl, open, Date.now()));
  } catch (err) {
    res.status(502).json({ error: "influxdb unreachable" });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "not found" });
});

app.use(express.static(CLIENT_DIST));
app.get("*", (req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).type("text").send("Not found");
  }
  res.sendFile(path.join(CLIENT_DIST, "index.html"), (err) => {
    if (err && !res.headersSent) {
      res.status(404).type("text").send("Not found");
    }
  });
});

app.listen(PORT, () => {
  console.log(`dashboard listening on ${PORT}`);
});
