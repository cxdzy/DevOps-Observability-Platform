"""
Anomaly model training for the observability platform.

Trains Isolation Forest and One-Class SVM models on sample-service metrics
from InfluxDB and logs every run to MLflow, so the two algorithms can be
compared side by side.

Pipeline
  1. Read the raw series of the sample-service job (and only that job).
  2. Convert counters (CPU seconds, request duration sum and count) into
     per-minute rates. A counter only ever increases and resets to zero when
     the service restarts, so raw counter values are not valid model inputs.
  3. Drop every minute that overlaps an excluded window (benchmarks, reboots).
  4. Label the minutes that an injection covers for at least 10 seconds. Labels
     are used only to evaluate the models. Both algorithms are unsupervised and never see them.
  5. Split chronologically (first 70 percent train, last 30 percent test) and
     report precision, recall, F1, false positive rate and ROC AUC on the
     test part, plus recall per severity tier.

Run: python3 train_anomaly_model.py
"""

import json
import os

import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
from influxdb import InfluxDBClient
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import OneClassSVM

INFLUXDB_HOST = os.environ.get("INFLUXDB_HOST", "localhost")
INFLUXDB_PORT = int(os.environ.get("INFLUXDB_PORT", "8086"))
INFLUXDB_DB = "prometheus"
JOB = "sample-service"
LOOKBACK_HOURS = 168

MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000")
MLFLOW_EXPERIMENT_NAME = "anomaly-detection-sample-service"

GROUND_TRUTH_LOG = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "ground_truth_log.jsonl"
)

RESAMPLE = "1min"
MAX_GAP_S = 120          # a longer gap between two samples is treated as missing data
FEATURES = ["cpu_rate", "memory_mb", "latency_ms"]

# A minute is labelled anomalous if an injection covers at least this many of its
# 60 seconds. A smaller overlap barely moves the per-minute averages, so labelling
# it would only create "missed anomalies" that no model could ever find.
LABEL_MIN_OVERLAP_S = 10

# Injections within this many seconds of an excluded window are excluded as well.
EXCLUSION_PAD_S = 60

TRAIN_FRACTION = 0.7
MIN_ROWS = 200
RANDOM_STATE = 42

# Periods in which the metrics do not represent normal behaviour. UTC.
# Refine the reboot window with `last -x | head` if you want it exact.
EXCLUDE_WINDOWS = [
    ("2026-10-01T14:47:00Z", "2026-10-01T14:50:00Z", "two injections 16 s apart around an injector restart"),
    ("2026-10-03T17:27:37Z", "2026-10-03T17:31:51Z", "LLM benchmark round 1"),
    ("2026-10-03T18:11:07Z", "2026-10-03T18:15:45Z", "LLM benchmark round 2"),
    ("2026-10-03T18:44:00Z", "2026-10-03T18:50:00Z", "VPS reboot"),
]


# ---------------------------------------------------------------- data access

def fetch_series(client, measurement):
    """Returns one DataFrame (index: time, column: value) per series of the job."""
    query = (
        f'SELECT "value" FROM "{measurement}" '
        f"WHERE \"job\" = '{JOB}' AND time > now() - {LOOKBACK_HOURS}h GROUP BY *"
    )
    frames = []
    for _key, points in client.query(query).items():
        df = pd.DataFrame(list(points))
        if df.empty:
            continue
        df["time"] = pd.to_datetime(df["time"], utc=True)
        frames.append(df.set_index("time")[["value"]].sort_index())
    return frames


def fetch_raw():
    client = InfluxDBClient(host=INFLUXDB_HOST, port=INFLUXDB_PORT, database=INFLUXDB_DB)
    raw = {
        "cpu": fetch_series(client, "process_cpu_seconds_total"),
        "memory": fetch_series(client, "process_resident_memory_bytes"),
        "lat_sum": fetch_series(client, "http_request_duration_ms_sum"),
        "lat_cnt": fetch_series(client, "http_request_duration_ms_count"),
    }
    for name, frames in raw.items():
        points = sum(len(f) for f in frames)
        print(f"  {name}: {len(frames)} series, {points} points")
        if not frames:
            raise RuntimeError(
                f"No data for '{name}' with job={JOB}. Check Prometheus remote_write "
                "and that the sample service is being scraped."
            )
    return raw


def load_ground_truth():
    if not os.path.exists(GROUND_TRUTH_LOG):
        raise RuntimeError(f"Ground truth log not found: {GROUND_TRUTH_LOG}")
    with open(GROUND_TRUTH_LOG) as f:
        return [json.loads(line) for line in f if line.strip()]


# --------------------------------------------------------- feature engineering

def counter_increase(frame):
    """Increase of a counter between consecutive samples and the seconds elapsed.
    Counter resets (negative increase) and gaps become NaN instead of garbage."""
    s = frame.sort_index()
    dv = s["value"].diff()
    dt = s.index.to_series().diff().dt.total_seconds()
    valid = (dv >= 0) & (dt > 0) & (dt <= MAX_GAP_S)
    return dv.where(valid), dt.where(valid)


def per_minute_rate(frames):
    """Time-weighted average rate per minute, in units per second."""
    parts = []
    for f in frames:
        dv, dt = counter_increase(f)
        parts.append(pd.DataFrame({"dv": dv, "dt": dt}).resample(RESAMPLE).sum(min_count=1))
    total = pd.concat(parts).groupby(level=0).sum(min_count=1)
    return total["dv"] / total["dt"].where(total["dt"] > 0)


def per_minute_increase(frames):
    """Total increase of a counter per minute, summed over all series."""
    parts = []
    for f in frames:
        dv, _ = counter_increase(f)
        parts.append(dv.resample(RESAMPLE).sum(min_count=1))
    return pd.concat(parts).groupby(level=0).sum(min_count=1)


def build_features(raw):
    cpu_rate = per_minute_rate(raw["cpu"])

    memory = pd.concat([f["value"].resample(RESAMPLE).mean() for f in raw["memory"]])
    memory_mb = memory.groupby(level=0).mean() / (1024 * 1024)

    total_ms = per_minute_increase(raw["lat_sum"])
    total_requests = per_minute_increase(raw["lat_cnt"])
    latency_ms = total_ms / total_requests.where(total_requests > 0)

    features = pd.concat(
        [cpu_rate.rename("cpu_rate"), memory_mb.rename("memory_mb"), latency_ms.rename("latency_ms")],
        axis=1,
    )
    return features.dropna()


# ----------------------------------------------- exclusions and ground truth

EPOCH = pd.Timestamp("1970-01-01", tz="UTC")


def injection_span(record, pad_s=0):
    start = pd.Timestamp(record["timestamp"])
    end = start + pd.Timedelta(seconds=record["duration_seconds"])
    return start - pd.Timedelta(seconds=pad_s), end + pd.Timedelta(seconds=pad_s)


def overlaps(index, start, end):
    """Boolean array: does the minute starting at each index value overlap [start, end] at all?"""
    row_end = index + pd.Timedelta(RESAMPLE)
    return np.asarray((index < end) & (row_end > start))


def overlap_seconds(index, start, end):
    """Seconds of each minute (starting at each index value) that fall inside [start, end]."""
    b = ((index - EPOCH) / pd.Timedelta(seconds=1)).to_numpy()
    s = (start - EPOCH).total_seconds()
    e = (end - EPOCH).total_seconds()
    return np.clip(np.minimum(b + 60, e) - np.maximum(b, s), 0, None)


def expand_exclusions(windows, ground_truth):
    """The configured windows, plus the span of every injection that is within
    EXCLUSION_PAD_S of one of them (such an injection is contaminated by the extra load)."""
    spans = [(pd.Timestamp(s), pd.Timestamp(e)) for s, e, _ in windows]
    extra = []
    for rec in ground_truth:
        if not rec.get("triggered_successfully"):
            continue
        ws, we = injection_span(rec, EXCLUSION_PAD_S)
        if any(ws < e and we > s for s, e in spans):
            extra.append((ws, we))
    return spans + extra, len(extra)


def drop_excluded(features, spans):
    drop = np.zeros(len(features), dtype=bool)
    for s, e in spans:
        drop |= overlaps(features.index, s, e)
    return features[~drop], int(drop.sum())


def label_rows(features, ground_truth):
    """Severity tier of the injection that covers each minute for at least
    LABEL_MIN_OVERLAP_S seconds, or None for normal minutes."""
    tier = pd.Series([None] * len(features), index=features.index, dtype=object)
    for rec in ground_truth:
        if not rec.get("triggered_successfully"):
            continue
        ws, we = injection_span(rec)
        tier[overlap_seconds(features.index, ws, we) >= LABEL_MIN_OVERLAP_S] = rec["tier"]
    return tier


# ------------------------------------------------------------ models and scoring

def candidate_models():
    models = []
    for c in (0.05, 0.10, 0.15):
        models.append({
            "name": f"isolation_forest_c{round(c * 100):02d}",
            "algorithm": "isolation_forest",
            "params": {"contamination": c, "n_estimators": 200},
            "build": lambda c=c: IsolationForest(
                contamination=c, n_estimators=200, random_state=RANDOM_STATE
            ),
        })
    for nu in (0.05, 0.10, 0.15):
        models.append({
            "name": f"one_class_svm_nu{round(nu * 100):02d}",
            "algorithm": "one_class_svm",
            "params": {"nu": nu, "kernel": "rbf", "gamma": "scale"},
            "build": lambda nu=nu: make_pipeline(
                StandardScaler(), OneClassSVM(nu=nu, kernel="rbf", gamma="scale")
            ),
        })
    return models


def evaluate(y_true, y_pred, scores, tiers):
    tp = int((y_pred & y_true).sum())
    fp = int((y_pred & ~y_true).sum())
    fn = int((~y_pred & y_true).sum())
    tn = int((~y_pred & ~y_true).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    metrics = {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1_score": round(2 * precision * recall / (precision + recall), 4) if precision + recall else 0.0,
        "false_positive_rate": round(fp / (fp + tn), 4) if fp + tn else 0.0,
        "true_positives": tp, "false_positives": fp,
        "false_negatives": fn, "true_negatives": tn,
        "anomalies_flagged": int(y_pred.sum()),
    }
    if y_true.any() and (~y_true).any():
        metrics["roc_auc"] = round(float(roc_auc_score(y_true, scores)), 4)
        metrics["average_precision"] = round(float(average_precision_score(y_true, scores)), 4)
    for t in ("low", "medium", "high"):
        mask = tiers == t
        if mask.any():
            metrics[f"recall_{t}"] = round(float(y_pred[mask].mean()), 4)
    return metrics


def run_experiments(features, tiers, info):
    if len(features) < MIN_ROWS:
        raise RuntimeError(
            f"Only {len(features)} usable minutes after exclusions (need {MIN_ROWS}). "
            "Let more data accumulate."
        )

    split = int(len(features) * TRAIN_FRACTION)
    X_train = features.iloc[:split][FEATURES].to_numpy()
    X_test = features.iloc[split:][FEATURES].to_numpy()
    tiers_test = tiers.iloc[split:].to_numpy()
    y_test = pd.Series(tiers_test).notna().to_numpy()

    print(f"  Train: {len(X_train)} minutes, test: {len(X_test)} minutes, "
          f"{int(y_test.sum())} labelled anomalous in the test part")

    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    mlflow.set_experiment(MLFLOW_EXPERIMENT_NAME)

    results = []
    for cfg in candidate_models():
        model = cfg["build"]()
        model.fit(X_train)
        y_pred = model.predict(X_test) == -1
        scores = -model.score_samples(X_test)  # higher means more anomalous
        metrics = evaluate(y_test, y_pred, scores, tiers_test)

        with mlflow.start_run(run_name=cfg["name"]):
            mlflow.log_param("algorithm", cfg["algorithm"])
            mlflow.log_params(cfg["params"])
            mlflow.log_params({
                "features": ",".join(FEATURES),
                "lookback_hours": LOOKBACK_HOURS,
                "train_fraction": TRAIN_FRACTION,
                "train_minutes": len(X_train),
                "test_minutes": len(X_test),
                "test_anomaly_minutes": int(y_test.sum()),
                "minutes_excluded": info["minutes_excluded"],
                "injections_in_log": info["injections_in_log"],
                "label_min_overlap_s": LABEL_MIN_OVERLAP_S,
                "train_start": str(features.index[0]),
                "test_start": str(features.index[split]),
                "test_end": str(features.index[-1]),
            })
            mlflow.log_metrics(metrics)
            mlflow.sklearn.log_model(model, "model")
            run_id = mlflow.active_run().info.run_id

        results.append({"run": cfg["name"], "run_id": run_id, **metrics})
        print(f"  {cfg['name']}: F1 {metrics['f1_score']}, precision {metrics['precision']}, "
              f"recall {metrics['recall']}, FPR {metrics['false_positive_rate']}")
    return results


def main():
    print("Loading ground truth...")
    ground_truth = load_ground_truth()
    print(f"  {len(ground_truth)} injection records")

    print(f"Fetching the last {LOOKBACK_HOURS}h of metrics for job '{JOB}' from InfluxDB...")
    features = build_features(fetch_raw())
    print(f"  {len(features)} minutes of features: {features.index[0]} to {features.index[-1]}")

    spans, extra = expand_exclusions(EXCLUDE_WINDOWS, ground_truth)
    features, dropped = drop_excluded(features, spans)
    print(f"  Excluded {dropped} minutes ({len(EXCLUDE_WINDOWS)} windows plus {extra} overlapping injections)")

    tiers = label_rows(features, ground_truth)
    print(f"  {int(tiers.notna().sum())} of {len(features)} minutes labelled anomalous "
          f"({tiers.notna().mean() * 100:.1f} percent)")

    print("Training and logging to MLflow...")
    results = run_experiments(
        features, tiers,
        {"minutes_excluded": dropped, "injections_in_log": len(ground_truth)},
    )

    table = pd.DataFrame(results).sort_values("f1_score", ascending=False)
    columns = [c for c in ["run", "f1_score", "precision", "recall", "false_positive_rate",
                           "roc_auc", "recall_low", "recall_medium", "recall_high"] if c in table.columns]
    print("\nResults on the test period, best F1 first:\n")
    print(table[columns].to_string(index=False))
    print(f"\nDone. Compare the runs at http://localhost:5000 (via your SSH tunnel).")


if __name__ == "__main__":
    main()
