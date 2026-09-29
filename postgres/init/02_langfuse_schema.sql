-- Langfuse Backend — PostgreSQL Relational Database
-- Stores LLM interaction logs for observability and evaluation

CREATE SCHEMA IF NOT EXISTS langfuse;

CREATE TABLE langfuse.trace (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(200) NOT NULL,
    timestamp_id    TIMESTAMP NOT NULL,
    metadata        JSONB,
    user_id         VARCHAR(100),
    anomaly_score   DOUBLE PRECISION NOT NULL
);

CREATE TABLE langfuse.observation (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id            UUID NOT NULL REFERENCES langfuse.trace(id),
    type                VARCHAR(50) NOT NULL,
    input               TEXT,
    output              TEXT,
    latency_ms          DOUBLE PRECISION,
    usage_total_tokens  INTEGER,
    model               VARCHAR(100),
    start_time          TIMESTAMP NOT NULL
);

CREATE INDEX idx_observation_trace ON langfuse.observation(trace_id);

-- Seed data: incident explanation traces, one per severity tier

INSERT INTO langfuse.trace (id, name, timestamp_id, metadata, user_id, anomaly_score) VALUES
('c1111111-1111-1111-1111-111111111111', 'incident-explanation', '2026-09-25 14:22:10', '{"container": "api-gateway", "tier": "low"}', 'system', 0.68),
('c2222222-2222-2222-2222-222222222222', 'incident-explanation', '2026-09-26 09:05:44', '{"container": "auth-service", "tier": "medium"}', 'system', 0.79),
('c3333333-3333-3333-3333-333333333333', 'incident-explanation', '2026-09-27 21:40:02', '{"container": "payment-worker", "tier": "high"}', 'system', 0.93);

INSERT INTO langfuse.observation (trace_id, type, input, output, latency_ms, usage_total_tokens, model, start_time) VALUES
('c1111111-1111-1111-1111-111111111111', 'generation',
 'Explain anomaly: container api-gateway, cpu_usage_percent 71, memory_usage_bytes elevated, anomaly_score 0.68',
 'CPU usage on api-gateway rose moderately above baseline. No recent deployment was detected. Recommended action: monitor, no restart needed yet.',
 1840, 96, 'llama3.2:3b', '2026-09-25 14:22:10'),

('c2222222-2222-2222-2222-222222222222', 'generation',
 'Explain anomaly: container auth-service, memory_usage_bytes spike, anomaly_score 0.79, deployment 4 min ago',
 'Memory usage on auth-service spiked shortly after the latest deployment, consistent with a memory leak introduced in the new build. Recommended action: restart the container.',
 2310, 118, 'llama3.2:3b', '2026-09-26 09:05:44'),

('c3333333-3333-3333-3333-333333333333', 'generation',
 'Explain anomaly: container payment-worker, request_latency_ms critical, anomaly_score 0.93, deployment 2 min ago',
 'Request latency on payment-worker degraded sharply immediately after deployment, indicating a regression in the new release. Recommended action: roll back to the last known good image.',
 2705, 134, 'llama3.2:3b', '2026-09-27 21:40:02');
