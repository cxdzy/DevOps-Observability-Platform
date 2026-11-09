const request = require('supertest');
const app = require('./index');

describe('sample-service', () => {
  test('GET /health returns 200 and status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET / returns 200', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
  });

  test('GET /metrics returns Prometheus-formatted text', async () => {
    const res = await request(app).get('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('http_requests_total');
  });

  test('POST /simulate/cpu-spike accepts the request', async () => {
    const res = await request(app).post('/simulate/cpu-spike?duration=1');
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('cpu-spike started');
  });

  test('POST /simulate/memory-leak accepts the request', async () => {
    const res = await request(app).post('/simulate/memory-leak?sizeMb=10&duration=1');
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('memory-leak started');
  });

  test('POST /simulate/memory-ramp accepts the request', async () => {
    const res = await request(app).post('/simulate/memory-ramp?sizeMb=4&steps=2&duration=1');
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('memory-ramp started');
    expect(res.body.steps).toBe(2);
  });

  test('POST /simulate/latency-spike accepts the request', async () => {
    const res = await request(app).post('/simulate/latency-spike?delayMs=10&duration=1');
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('latency-spike started');
  });
});

describe('graceful shutdown', () => {
  test('exits with code 0 shortly after SIGTERM', async () => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['index.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: '4177' },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('service did not start')), 5000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const started = Date.now();
    const code = await new Promise((resolve) => {
      child.on('exit', (c) => resolve(c));
      child.kill('SIGTERM');
    });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15000);
});
