#!/bin/sh
set -e

exec mlflow server \
  --host 0.0.0.0 \
  --port 5000 \
  --backend-store-uri "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?options=-csearch_path=mlflow" \
  --default-artifact-root /mlflow/artifacts
