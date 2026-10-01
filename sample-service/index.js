const express = require('express');
const client = require('prom-client');

const app = express();
const PORT = process.env.PORT || 4000;

// Default Node.js process metrics (memory, CPU, event loop lag, etc.)
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Custom metric: request counter, labeled by route and status code
const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['route', 'status_code'],
});
register.registerMetric(httpRequestCounter);

// Custom metric: request latency histogram
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request latency in milliseconds',
  labelNames: ['route'],
  buckets: [10, 50, 100, 250, 500, 1000, 2500],
});
register.registerMetric(httpRequestDuration);

// Anomaly injection state, read by middleware below and set by /simulate/* routes
let memoryLeakBuffers = [];
let artificialLatencyMs = 0;

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    httpRequestCounter.inc({ route: req.path, status_code: res.statusCode });
    httpRequestDuration.observe({ route: req.path }, duration);
  });
  next();
});

// Apply artificial latency to all non-simulate requests, if a latency-spike is active
app.use((req, res, next) => {
  if (artificialLatencyMs > 0 && !req.path.startsWith('/simulate')) {
    setTimeout(next, artificialLatencyMs);
  } else {
    next();
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'sample-service' });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/', (req, res) => {
  res.status(200).json({ message: 'FYP sample service is running' });
});

// --- Anomaly injection endpoints ---
// Used by scripts/anomaly_injector.py to generate labeled training data
// for the Isolation Forest model. Not part of normal application behavior.

// Low tier: moderate CPU spike, no deployment correlation
app.post('/simulate/cpu-spike', (req, res) => {
  const durationSeconds = parseInt(req.query.duration) || 30;
  const endTime = Date.now() + durationSeconds * 1000;

  res.status(202).json({ status: 'cpu-spike started', duration_seconds: durationSeconds });

  // Busy-loop a portion of CPU time without fully blocking the event loop forever
  const burn = () => {
    const start = Date.now();
    while (Date.now() - start < 50) {
      Math.sqrt(Math.random() * 999999);
    }
    if (Date.now() < endTime) {
      setImmediate(burn);
    }
  };
  burn();
});

// Medium tier: memory pressure building up, simulates a leak after deployment
app.post('/simulate/memory-leak', (req, res) => {
  const sizeMb = parseInt(req.query.sizeMb) || 100;
  const durationSeconds = parseInt(req.query.duration) || 60;

  const buffer = Buffer.alloc(sizeMb * 1024 * 1024, 'x');
  memoryLeakBuffers.push(buffer);

  setTimeout(() => {
    memoryLeakBuffers = [];
  }, durationSeconds * 1000);

  res.status(202).json({
    status: 'memory-leak started',
    size_mb: sizeMb,
    duration_seconds: durationSeconds,
  });
});

// High tier: latency degradation, simulates a bad deployment regression
app.post('/simulate/latency-spike', (req, res) => {
  const delayMs = parseInt(req.query.delayMs) || 2000;
  const durationSeconds = parseInt(req.query.duration) || 60;

  artificialLatencyMs = delayMs;

  setTimeout(() => {
    artificialLatencyMs = 0;
  }, durationSeconds * 1000);

  res.status(202).json({
    status: 'latency-spike started',
    delay_ms: delayMs,
    duration_seconds: durationSeconds,
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`sample-service listening on port ${PORT}`);
  });
}

module.exports = app;

