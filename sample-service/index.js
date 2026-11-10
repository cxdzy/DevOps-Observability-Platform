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

// ROLLBACK DEMO ONLY. This release carries a performance regression: every normal request is slowed
// down. It exists to show the high tier end to end (deployment, latency flagged, approval, rollback to
// the previous image). Revert the commit that adds it once the demo is over.
const RELEASE_LATENCY_MS = 600;

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    httpRequestCounter.inc({ route: req.path, status_code: res.statusCode });
    httpRequestDuration.observe({ route: req.path }, duration);
  });
  next();
});

// Apply artificial latency to all non-simulate requests, if a latency-spike is active (and the demo release delay)
app.use((req, res, next) => {
  const delay = artificialLatencyMs + RELEASE_LATENCY_MS;
  if (delay > 0 && !req.path.startsWith('/simulate')) {
    setTimeout(next, delay);
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

// Medium tier: memory pressure, simulates a leak after deployment.
// The service must run with node --expose-gc. The buffer is released with an explicit
// garbage collection when the injection ends, and older garbage is collected before a new
// allocation. Without this the memory can stay resident for many minutes after the
// injection, so the metrics stop matching the ground truth log.
const collectGarbage = () => {
  if (typeof global.gc === 'function') {
    global.gc();
  }
};

app.post('/simulate/memory-leak', (req, res) => {
  const sizeMb = parseInt(req.query.sizeMb) || 100;
  const durationSeconds = parseInt(req.query.duration) || 60;

  collectGarbage();
  memoryLeakBuffers.push(Buffer.alloc(sizeMb * 1024 * 1024, 'x'));

  const releaseTimer = setTimeout(() => {
    memoryLeakBuffers = [];
    collectGarbage();
  }, durationSeconds * 1000);
  releaseTimer.unref();

  res.status(202).json({
    status: 'memory-leak started',
    size_mb: sizeMb,
    duration_seconds: durationSeconds,
  });
});

// Medium tier, gradual: a leak that grows in steps over the whole duration instead of one allocation.
// Used to measure how early the trend check warns before the model flags the minute.
app.post('/simulate/memory-ramp', (req, res) => {
  const sizeMb = parseInt(req.query.sizeMb) || 150;
  const durationSeconds = parseInt(req.query.duration) || 300;
  const steps = Math.max(1, parseInt(req.query.steps) || 10);
  const stepMb = Math.max(1, Math.round(sizeMb / steps));
  const intervalMs = Math.max(100, Math.round((durationSeconds * 1000) / steps));

  collectGarbage();
  let done = 0;
  const grow = setInterval(() => {
    memoryLeakBuffers.push(Buffer.alloc(stepMb * 1024 * 1024, 'x'));
    done += 1;
    if (done >= steps) clearInterval(grow);
  }, intervalMs);
  grow.unref();

  const releaseTimer = setTimeout(() => {
    clearInterval(grow);
    memoryLeakBuffers = [];
    collectGarbage();
  }, durationSeconds * 1000 + 1000);
  releaseTimer.unref();

  res.status(202).json({
    status: 'memory-ramp started',
    size_mb: stepMb * steps,
    steps,
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
  const server = app.listen(PORT, () => {
    console.log(`sample-service listening on port ${PORT}`);
  });

  // Graceful shutdown. As PID 1 in a container, Node ignores SIGTERM unless a handler exists,
  // so every `docker restart` would wait the full stop timeout and end in a force-kill.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Safety net in case a connection never closes (below Docker's 10 s stop timeout).
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;

