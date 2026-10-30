const path = require("path");
const express = require("express");
const { query, INFLUX_URL } = require("./influx");

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
