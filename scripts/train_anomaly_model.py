"""
Isolation Forest training script for anomaly detection.

Pulls CPU, memory and request latency metrics for sample-service from
InfluxDB, trains an Isolation Forest model, evaluates it against the
ground truth log produced by anomaly_injector.py, and logs the run
(params, metrics, and the model artifact) to MLflow.

Run: python3 train_anomaly_model.py
"""

import json
import os
from datetime import datetime, timezone

import mlflow
import mlflow.sklearn
import pandas as pd
from influxdb import InfluxDBClient
from sklearn.ensemble import IsolationForest

INFLUXDB_HOST = "localhost"
INFLUXDB_PORT = 8086
INFLUXDB_DB = "prometheus"

MLFLOW_TRACKING_URI = "http://localhost:5000"
MLFLOW_EXPERIMENT_NAME = "isolation-forest-sample-service"

GROUND_TRUTH_LOG = os.path.join(os.path.dirname(__file__), "ground_truth_log.jsonl")

# How far back to pull training data, in hours
LOOKBACK_HOURS = 72

# Isolation Forest hyperparameters
CONTAMINATION = 0.05
N_ESTIMATORS = 100
RANDOM_STATE = 42


def fetch_metrics():
    """Pulls CPU usage, memory usage, and request latency for sample-service
    from InfluxDB and merges them into a single time-indexed DataFrame."""
    client = InfluxDBClient(host=INFLUXDB_HOST, port=INFLUXDB_PORT, database=INFLUXDB_DB)

    queries = {
        "cpu_usage": f"""
            SELECT mean("value") AS cpu_usage
            FROM "process_cpu_seconds_total"
            WHERE time > now() - {LOOKBACK_HOURS}h
            GROUP BY time(1m) fill(previous)
        """,
        "memory_usage": f"""
            SELECT mean("value") AS memory_usage
            FROM "process_resident_memory_bytes"
            WHERE time > now() - {LOOKBACK_HOURS}h
            GROUP BY time(1m) fill(previous)
        """,
        "request_latency": f"""
            SELECT mean("value") AS request_latency
            FROM "http_request_duration_ms_sum"
            WHERE time > now() - {LOOKBACK_HOURS}h
            GROUP BY time(1m) fill(previous)
        """,
    }

    frames = []
    for metric_name, query in queries.items():
        result = client.query(query)
        points = list(result.get_points())
        if not points:
            print(f"  Warning: no data returned for {metric_name}, skipping")
            continue
        df = pd.DataFrame(points)
        df["time"] = pd.to_datetime(df["time"])
        df = df.set_index("time")
        frames.append(df[[metric_name]])

    if not frames:
        raise RuntimeError(
            "No metrics returned from InfluxDB. Check that Prometheus remote_write "
            "is working and that enough time has passed since deployment."
        )

    merged = pd.concat(frames, axis=1).dropna()
    return merged


def load_ground_truth():
    """Loads the anomaly injector's log of known injected incidents, used
    only for evaluation (precision/recall), not for training, since
    Isolation Forest is unsupervised."""
    if not os.path.exists(GROUND_TRUTH_LOG):
        print("  Warning: no ground_truth_log.jsonl found, evaluation will be skipped")
        return []

    records = []
    with open(GROUND_TRUTH_LOG) as f:
        for line in f:
            if line.strip():
                records.append(json.loads(line))
    return records


def label_known_anomalies(df, ground_truth):
    """Marks rows that fall within a known injected anomaly window.
    Used only for evaluation metrics, not fed into training."""
    df = df.copy()
    df["is_known_anomaly"] = False

    for record in ground_truth:
        if not record.get("triggered_successfully"):
            continue
        start = pd.to_datetime(record["timestamp"])
        end = start + pd.Timedelta(seconds=record["duration_seconds"])
        mask = (df.index >= start) & (df.index <= end)
        df.loc[mask, "is_known_anomaly"] = True

    return df


def evaluate(df):
    """Computes precision, recall and false positive rate against the
    known injected anomalies, where available."""
    if "is_known_anomaly" not in df.columns or df["is_known_anomaly"].sum() == 0:
        return {}

    true_positive = ((df["predicted_anomaly"]) & (df["is_known_anomaly"])).sum()
    false_positive = ((df["predicted_anomaly"]) & (~df["is_known_anomaly"])).sum()
    false_negative = ((~df["predicted_anomaly"]) & (df["is_known_anomaly"])).sum()
    true_negative = ((~df["predicted_anomaly"]) & (~df["is_known_anomaly"])).sum()

    precision = true_positive / (true_positive + false_positive) if (true_positive + false_positive) > 0 else 0
    recall = true_positive / (true_positive + false_negative) if (true_positive + false_negative) > 0 else 0
    false_positive_rate = false_positive / (false_positive + true_negative) if (false_positive + true_negative) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "false_positive_rate": round(false_positive_rate, 4),
        "f1_score": round(f1, 4),
        "true_positives": int(true_positive),
        "false_positives": int(false_positive),
        "false_negatives": int(false_negative),
        "true_negatives": int(true_negative),
    }


def main():
    print(f"Fetching last {LOOKBACK_HOURS}h of metrics from InfluxDB...")
    df = fetch_metrics()
    print(f"  Retrieved {len(df)} data points")

    feature_columns = [c for c in ["cpu_usage", "memory_usage", "request_latency"] if c in df.columns]
    if len(feature_columns) < 2:
        raise RuntimeError(
            f"Only {len(feature_columns)} feature(s) available ({feature_columns}). "
            "Need at least 2 for a meaningful model. Let more data accumulate."
        )
    print(f"  Using features: {feature_columns}")

    ground_truth = load_ground_truth()
    print(f"  Loaded {len(ground_truth)} ground truth injection records")

    df = label_known_anomalies(df, ground_truth)

    print("\nTraining Isolation Forest...")
    model = IsolationForest(
        contamination=CONTAMINATION,
        n_estimators=N_ESTIMATORS,
        random_state=RANDOM_STATE,
    )
    model.fit(df[feature_columns])

    # -1 = anomaly, 1 = normal in sklearn's convention; convert to boolean
    df["predicted_anomaly"] = model.predict(df[feature_columns]) == -1
    df["anomaly_score"] = -model.score_samples(df[feature_columns])  # higher = more anomalous

    anomaly_count = df["predicted_anomaly"].sum()
    print(f"  Flagged {anomaly_count} / {len(df)} points as anomalous "
          f"({anomaly_count / len(df) * 100:.1f}%)")

    metrics = evaluate(df)
    if metrics:
        print(f"\nEvaluation against {df['is_known_anomaly'].sum()} known injected anomaly points:")
        for k, v in metrics.items():
            print(f"  {k}: {v}")
    else:
        print("\nNo known anomalies in this window yet, skipping evaluation metrics. "
              "Let the injector run longer for a meaningful evaluation.")

    print("\nLogging to MLflow...")
    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    mlflow.set_experiment(MLFLOW_EXPERIMENT_NAME)

    with mlflow.start_run(run_name=f"isoforest-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"):
        mlflow.log_param("contamination", CONTAMINATION)
        mlflow.log_param("n_estimators", N_ESTIMATORS)
        mlflow.log_param("lookback_hours", LOOKBACK_HOURS)
        mlflow.log_param("features", ",".join(feature_columns))
        mlflow.log_param("training_samples", len(df))

        mlflow.log_metric("anomalies_flagged", int(anomaly_count))
        mlflow.log_metric("anomaly_rate", anomaly_count / len(df))
        for k, v in metrics.items():
            if isinstance(v, (int, float)):
                mlflow.log_metric(k, v)

        mlflow.sklearn.log_model(model, "isolation_forest_model")

        run_id = mlflow.active_run().info.run_id
        print(f"  Logged as MLflow run: {run_id}")

    print("\nDone. View results at http://localhost:5000 (via your SSH tunnel)")


if __name__ == "__main__":
    main()
