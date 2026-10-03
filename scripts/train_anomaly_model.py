"""
Anomaly model training for the observability platform.

Trains Isolation Forest and One-Class SVM models on sample-service metrics
from InfluxDB and logs every run to MLflow, so the two algorithms and two
feature sets can be compared on identical data.

Pipeline
  1. Read the raw series of the sample-service job (and only that job).
  2. Convert counters (CPU seconds, request duration sum and count) into
     per-minute rates. A counter only ever increases and resets to zero when
     the service restarts, so raw counter values are not valid model inputs.
  3. Drop every minute that overlaps an excluded window (benchmarks, reboots).
  4. Label the minutes that an injection covers for at least 10 seconds. Labels
     are used only to evaluate the models. Both algorithms are unsupervised
     and never see them.
  5. Split chronologically: train 60 percent, validation 20 percent, test 20
     percent. Models are fitted on the training part. The configuration with the
     best validation F1 is selected, and its test scores are the ones to report,
     because the test part was not used to choose it.
  6. Every configuration runs with two feature sets: the baseline, and the
     baseline plus the per-minute maximum of memory. Recall for memory
     injections is also split by how much of the minute the injection covers,
     to test whether per-minute averaging dilutes short memory spikes.

Outputs: MLflow runs, and training_results.csv next to this script.

Run: python3 train_anomaly_model.py 2>&1 | tee train_output.txt
"""

import json
import os

import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
from influxdb import InfluxDBClient
from mlflow.tracking import MlflowClient
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import OneClassSVM

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

INFLUXDB_HOST = os.environ.get("INFLUXDB_HOST", "localhost")
INFLUXDB_PORT = int(os.environ.get("INFLUXDB_PORT", "8086"))
INFLUXDB_DB = "prometheus"
JOB = "sample-service"
LOOKBACK_HOURS = 168

MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000")
MLFLOW_EXPERIMENT_NAME = "anomaly-detection-v2"

GROUND_TRUTH_LOG = os.path.join(SCRIPT_DIR, "ground_truth_log.jsonl")
RESULTS_CSV = os.path.join(SCRIPT_DIR, "training_results.csv")

RESAMPLE = "1min"
MAX_GAP_S = 120          # a longer gap between two samples is treated as missing data

ALL_FEATURES = ["cpu_rate", "memory_mb", "memory_max_mb", "latency_ms"]
FEATURE_SETS = {
    "baseline": ["cpu_rate", "memory_mb", "latency_ms"],
    "memory_max": ["cpu_rate", "memory_mb", "memory_max_mb", "latency_ms"],
}

# A minute is labelled anomalous if an injection covers at least this many of its
# 60 seconds. A smaller overlap barely moves the per-minute averages, so labelling
# it would only create "missed anomalies" that no model could ever find.
LABEL_MIN_OVERLAP_S = 10

# Injections within this many seconds of an excluded window are excluded as well.
EXCLUSION_PAD_S = 60

# Minutes an injection covers for at least this long count as "mostly covered".
FULL_COVER_S = 45

TRAIN_FRACTION = 0.6
VAL_FRACTION = 0.2       # the remaining 20 percent is the test part
MIN_ROWS = 300
RANDOM_STATE = 42

# Periods in which the metrics do not represent normal behaviour. UTC.
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

    mib = 1024 * 1024
    mem_mean = pd.concat([f["value"].resample(RESAMPLE).mean() for f in raw["memory"]])
    mem_max = pd.concat([f["value"].resample(RESAMPLE).max() for f in raw["memory"]])
    memory_mb = mem_mean.groupby(level=0).mean() / mib
    memory_max_mb = mem_max.groupby(level=0).max() / mib

    total_ms = per_minute_increase(raw["lat_sum"])
    total_requests = per_minute_increase(raw["lat_cnt"])
    latency_ms = total_ms / total_requests.where(total_requests > 0)

    features = pd.concat(
        [
            cpu_rate.rename("cpu_rate"),
            memory_mb.rename("memory_mb"),
            memory_max_mb.rename("memory_max_mb"),
            latency_ms.rename("latency_ms"),
        ],
        axis=1,
    )
    return features.dropna()[ALL_FEATURES]


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
    """Returns (tier, cover). tier is the severity tier of the injection that covers
    each minute for at least LABEL_MIN_OVERLAP_S seconds, or None for normal minutes.
    cover is the number of seconds of that minute the injection covers."""
    tier = pd.Series([None] * len(features), index=features.index, dtype=object)
    cover = np.zeros(len(features))
    for rec in ground_truth:
        if not rec.get("triggered_successfully"):
            continue
        ws, we = injection_span(rec)
        ov = overlap_seconds(features.index, ws, we)
        mask = ov >= LABEL_MIN_OVERLAP_S
        tier[mask] = rec["tier"]
        cover[mask] = np.maximum(cover[mask], ov[mask])
    return tier, cover


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


def evaluate(y_true, y_pred, scores, tiers, cover):
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
    medium = tiers == "medium"
    for label, mask in (("full", medium & (cover >= FULL_COVER_S)),
                        ("partial", medium & (cover < FULL_COVER_S))):
        metrics[f"n_medium_{label}"] = int(mask.sum())
        if mask.any():
            metrics[f"recall_medium_{label}"] = round(float(y_pred[mask].mean()), 4)
    return metrics


def run_experiments(features, tiers, cover, info):
    n = len(features)
    if n < MIN_ROWS:
        raise RuntimeError(
            f"Only {n} usable minutes after exclusions (need {MIN_ROWS}). Let more data accumulate."
        )

    i1 = int(n * TRAIN_FRACTION)
    i2 = int(n * (TRAIN_FRACTION + VAL_FRACTION))
    y = tiers.notna().to_numpy()
    tier_arr = tiers.to_numpy()
    splits = {"val": slice(i1, i2), "test": slice(i2, n)}

    print(f"  Train {i1} / validation {i2 - i1} / test {n - i2} minutes. "
          f"Labelled anomalous: train {int(y[:i1].sum())}, validation {int(y[i1:i2].sum())}, "
          f"test {int(y[i2:].sum())}")

    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    mlflow.set_experiment(MLFLOW_EXPERIMENT_NAME)

    results = []
    for fset, cols in FEATURE_SETS.items():
        X = features[cols].to_numpy()
        for cfg in candidate_models():
            model = cfg["build"]()
            model.fit(X[:i1])

            metrics = {}
            for split_name, sl in splits.items():
                pred = model.predict(X[sl]) == -1
                scores = -model.score_samples(X[sl])  # higher means more anomalous
                m = evaluate(y[sl], pred, scores, tier_arr[sl], cover[sl])
                metrics.update({f"{split_name}_{k}": v for k, v in m.items()})

            run_name = f"{fset}__{cfg['name']}"
            with mlflow.start_run(run_name=run_name):
                mlflow.log_params({
                    "feature_set": fset,
                    "features": ",".join(cols),
                    "algorithm": cfg["algorithm"],
                    **cfg["params"],
                    "lookback_hours": LOOKBACK_HOURS,
                    "train_fraction": TRAIN_FRACTION,
                    "val_fraction": VAL_FRACTION,
                    "train_minutes": i1,
                    "val_minutes": i2 - i1,
                    "test_minutes": n - i2,
                    "minutes_excluded": info["minutes_excluded"],
                    "injections_in_log": info["injections_in_log"],
                    "label_min_overlap_s": LABEL_MIN_OVERLAP_S,
                    "train_start": str(features.index[0]),
                    "val_start": str(features.index[i1]),
                    "test_start": str(features.index[i2]),
                    "test_end": str(features.index[-1]),
                })
                mlflow.log_metrics({k: v for k, v in metrics.items() if v is not None})
                mlflow.sklearn.log_model(model, "model")
                run_id = mlflow.active_run().info.run_id

            results.append({"run": run_name, "run_id": run_id, "feature_set": fset,
                            "algorithm": cfg["algorithm"], **cfg["params"], **metrics})
            print(f"  {run_name}: validation F1 {metrics['val_f1_score']}, test F1 {metrics['test_f1_score']}")

    best = max(results, key=lambda r: (r["val_f1_score"], r.get("val_roc_auc", 0)))
    MlflowClient().set_tag(best["run_id"], "selected", "true")
    return results, best


def print_summary(results, best):
    table = pd.DataFrame(results)
    table["pick"] = np.where(table["run_id"] == best["run_id"], "*", "")
    table.to_csv(RESULTS_CSV, index=False)

    fmt = lambda v: f"{v:.3f}"
    t1 = table.sort_values("val_f1_score", ascending=False)[
        ["pick", "run", "val_f1_score", "test_f1_score", "test_precision", "test_recall",
         "test_false_positive_rate", "test_roc_auc"]
    ].rename(columns={"val_f1_score": "f1_val", "test_f1_score": "f1_test", "test_precision": "prec",
                      "test_recall": "rec", "test_false_positive_rate": "fpr", "test_roc_auc": "auc"})
    print("\nSelection on validation F1 (* = selected). Report the test columns for the selected run.\n")
    print(t1.to_string(index=False, float_format=fmt))

    t2 = table.sort_values("val_f1_score", ascending=False)[
        ["pick", "run", "test_recall_low", "test_recall_medium", "test_recall_high",
         "test_recall_medium_full", "test_recall_medium_partial"]
    ].rename(columns={"test_recall_low": "low", "test_recall_medium": "med", "test_recall_high": "high",
                      "test_recall_medium_full": "med_full", "test_recall_medium_partial": "med_part"})
    print("\nTest recall per injection type. med_full = minutes a memory injection covers for 45 s or more,")
    print("med_part = minutes it covers for less (the part a per-minute average dilutes).\n")
    print(t2.to_string(index=False, float_format=fmt))
    first = results[0]
    print(f"\nMinutes behind med_full / med_part in the test part: "
          f"{first['test_n_medium_full']} / {first['test_n_medium_partial']}")
    print(f"Full results saved to {RESULTS_CSV}")


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

    tiers, cover = label_rows(features, ground_truth)
    print(f"  {int(tiers.notna().sum())} of {len(features)} minutes labelled anomalous "
          f"({tiers.notna().mean() * 100:.1f} percent)")

    print("Training and logging to MLflow...")
    results, best = run_experiments(
        features, tiers, cover,
        {"minutes_excluded": dropped, "injections_in_log": len(ground_truth)},
    )
    print_summary(results, best)
    print(f"\nDone. Compare the runs at http://localhost:5000 (experiment '{MLFLOW_EXPERIMENT_NAME}').")


if __name__ == "__main__":
    main()
