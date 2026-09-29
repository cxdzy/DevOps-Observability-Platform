## Database Demo — Query Sheet

Four databases, matching the ERD's four-database architecture.

### 1. InfluxDB — time-series metrics (live data)

Open Grafana (port 3001) and show the Prometheus and InfluxDB dashboards. This is real
data collected from the VPS since the stack was deployed, not seed data. Mention that
Prometheus keeps 15 days locally, and InfluxDB retains the full history as the training
set for the Isolation Forest model.

### 2. MLflow backend — PostgreSQL

Connect with `psql` or a GUI client to `localhost:5433`, database `fyp_observability`.

```sql
-- All experiments
SELECT * FROM mlflow.experiment;

-- All runs for the Isolation Forest baseline experiment, with their metrics
SELECT e.name AS experiment, r.run_id, r.status, m.key, m.value
FROM mlflow.experiment e
JOIN mlflow.run r ON r.experiment_id = e.experiment_id
JOIN mlflow.metric m ON m.run_id = r.run_id
WHERE e.name = 'isolation-forest-baseline'
ORDER BY r.run_id, m.key;

-- Compare Isolation Forest vs One-Class SVM on F1 score
SELECT e.name AS experiment, m.value AS f1_score
FROM mlflow.experiment e
JOIN mlflow.run r ON r.experiment_id = e.experiment_id
JOIN mlflow.metric m ON m.run_id = r.run_id
WHERE m.key = 'f1_score'
ORDER BY m.value DESC;
```

### 3. Langfuse backend — PostgreSQL

```sql
-- Every LLM incident explanation, with the trace that triggered it
SELECT t.anomaly_score, t.metadata->>'tier' AS tier, o.model, o.latency_ms, o.output
FROM langfuse.trace t
JOIN langfuse.observation o ON o.trace_id = t.id
ORDER BY t.timestamp_id;

-- Average LLM latency and token usage per severity tier
SELECT t.metadata->>'tier' AS tier,
       ROUND(AVG(o.latency_ms)::numeric, 0) AS avg_latency_ms,
       ROUND(AVG(o.usage_total_tokens)::numeric, 0) AS avg_tokens
FROM langfuse.trace t
JOIN langfuse.observation o ON o.trace_id = t.id
GROUP BY t.metadata->>'tier';
```

### 4. Chroma — vector database

Run on the VPS:

```bash
cd chroma
pip install -r requirements.txt --break-system-packages
python3 setup_chroma.py
```

This stores three past incidents as embeddings, then runs a similarity search with a
new query about an auth-service memory issue. It should return the auth-service
incident as the closest match, demonstrating RAG-style retrieval: past incidents
inform how the LLM explains a new, similar one.

### Talking points if asked why four databases instead of one

- InfluxDB is optimised for high-frequency time-series writes, which a relational
  database handles poorly at scale.
- Chroma performs vector similarity search, which PostgreSQL cannot do natively at
  the scale or speed this project needs.
- MLflow and Langfuse ship with PostgreSQL as their standard supported backend, so
  reusing PostgreSQL for both keeps the stack simpler while still isolating each
  tool's data using separate schemas (`mlflow` and `langfuse`).
