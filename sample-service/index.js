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

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    httpRequestCounter.inc({ route: req.path, status_code: res.statusCode });
    httpRequestDuration.observe({ route: req.path }, duration);
  });
  next();
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`sample-service listening on port ${PORT}`);
  });
}

module.exports = app;

