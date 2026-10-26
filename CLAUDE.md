# CLAUDE.md

Final year project: an intelligent DevOps observability platform. It monitors a sample service, detects anomalies with an Isolation Forest model, explains incidents in plain English with a local LLM, and sends alerts to Telegram. Automated remediation is being built in phases. Everything runs in Docker Compose on one Linux server.

## Rules for every change

- Change only the files the task names. If another file seems to need a change, say so and wait.
- Run `git diff --stat` before committing and show it. Only the intended files may appear.
- The Grafana port line in `docker-compose.yml` must stay exactly `"127.0.0.1:3001:3000"`. Check it after any change to that file.
- Never run prune commands (`docker system prune`, `docker volume prune`, and similar).
- Never change firewall settings.
- Never open, print or commit `.env` files, tokens, passwords or keys. This repository is public.
- Commit as the repository owner (cxdzy). Do not add co-author or attribution lines to commit messages.
- Push to `master`.
- Write documentation and comments in plain English without em dashes.

## Where things are

| Path | What it is |
|---|---|
| `docker-compose.yml` | All services: prometheus, influxdb, grafana, node-exporter, cadvisor, mlflow, postgres, ollama, worker, explainer, n8n, cloudflared |
| `worker/worker.py` | Scores one minute of metrics at a time with the champion model and writes `anomaly_score` points. It has no incident logic |
| `explainer/explainer.py` | Groups flagged minutes into incidents, asks the LLM to explain them, writes `incident_explanation` after an incident closes, and writes `incident_open` while an incident is open |
| `scripts/train_anomaly_model.py` | Feature engineering and the training experiments (Isolation Forest and One-Class SVM, logged to MLflow). The nightly retraining schedule and promotion guards are in `worker/worker.py`, which reuses this file. `DATA_START` limits training data to after the last baseline change. The worker image copies this file, so changing it needs a worker rebuild |
| `scripts/anomaly_injector.py` | Injects faults into the sample service on a schedule (cpu-spike low, memory-leak medium, latency-spike high) and writes `scripts/ground_truth_log.jsonl` |
| `scripts/detection_report.py` | Compares detections against the ground truth log |
| `sample-service/` | The monitored Node.js service, deployed by GitHub Actions |
| `prometheus/`, `grafana/` | Monitoring configuration and provisioned dashboards |
| `n8n/workflows/` | Exported n8n workflows (backup only, n8n runs its own copy). Remove `instanceId` from the exported JSON before committing |

## How the pipeline behaves

- Prometheus scrapes every 15 seconds and writes to InfluxDB (database `prometheus`).
- The worker scores each minute 30 to 90 seconds after it ends (it waits 30 seconds for late samples and runs once a minute). Each point carries score, tier, action, signal and the metric values.
- Tiers: low is a notification only, medium is a container restart, high is a rollback. Severe latency is high only if a deployment happened in the last 15 minutes; without one it is medium (restart).
- An incident is a group of flagged minutes with gaps of at most 2 minutes. It closes after 4 quiet minutes. The explanation point is timestamped at the incident start and is written only after the incident closes.
- Anything that must act while an incident is still running has to use `incident_open`, not `incident_explanation`.
- The detection reference (median and 99th percentile of recent unflagged minutes) refreshes every 30 minutes and falls back to fixed constants if fewer than 200 unflagged minutes exist.
- Retraining runs nightly at 19:00 UTC. A new model is promoted only if it passes the recall and margin guards.

## Deploying

1. Change files in the repository and push to `master`.
2. On the server run `git pull`.
3. Rebuild only the changed service, for example `docker compose up -d --build explainer`. Configuration-only changes (for example `prometheus.yml`) need a restart of that service, not a rebuild.
4. Check `docker compose ps` and the service logs.

## Fixed project decisions

- Docker Compose only. No Kubernetes.
- The LLM runs locally through Ollama. No cloud LLM APIs and no fine-tuning. Models must stay at 7B parameters or smaller.
- Isolation Forest is the baseline model.
- One server for the platform. No multi-cloud deployment, no native mobile app.
- New tools or services outside the current stack must be flagged and justified before they are added.

## Current phase status

- Phases 1 to 4 (pipeline, monitoring, detection, LLM explanations): done.
- Phase 5a (notifications through n8n and Telegram): done.
- Phase 5b (automatic restart for medium incidents) and 5c (rollback for high incidents): in progress or planned.
- Phase 6 (Vue.js dashboard and Telegram chatbot): not started.
