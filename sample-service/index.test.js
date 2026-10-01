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

  test('POST /simulate/latency-spike accepts the request', async () => {
    const res = await request(app).post('/simulate/latency-spike?delayMs=10&duration=1');
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('latency-spike started');
  });
});
