"""
Scoring worker: live anomaly scores with signal attribution.

Every minute it
  1. loads the champion model from the MLflow model registry and checks
     whether a newer champion has been promoted,
  2. reads the latest raw sample-service metrics from InfluxDB,
  3. builds the same per-minute features the model was trained on,
  4. scores every completed minute that has not been scored yet,
  5. for every minute the model flags, works out WHICH signal moved (CPU, memory
     or latency), checks for a recent deployment, and derives a tier and an action,
  6. writes the result back to InfluxDB as the measurement "anomaly_score", so
     Grafana, n8n and the LLM step can read it.

Why attribution instead of score thresholds: the anomaly score only says how
unusual a minute is. All fault types score in the same range, so the score cannot
separate a harmless CPU spike from a memory leak. The tier therefore comes from
the signal that moved, and the score only decides whether to act at all.

  model flags the minute, latency SEVERE, recent deployment      tier 3 (high)    rollback
  model flags the minute, latency SEVERE, no deployment          tier 2 (medium)  restart
  model flags the minute, memory moved                           tier 2 (medium)  restart
  model flags the minute, CPU moved                              tier 1 (low)     notify
  model flags the minute, only a mild latency rise or no signal  tier 1 (low)     notify

Latency is SEVERE at DEV_SEVERE (50) normal spreads, about 140 ms above normal. Milder rises
are symptoms of other faults (a memory leak briefly gives about 60 ms, a CPU spike about 15 ms).

A signal has "moved" when it is at least DEV_MIN times its normal upper spread
above its normal median. The normal range is measured from the last
REFERENCE_HOURS hours of minutes the model called normal.

If the registry has no champion yet, the run tagged "selected" in the source
experiment is registered as the first champion.

Nightly retraining (part 2). Once a day at RETRAIN_HOUR_UTC it rebuilds the labelled
dataset from the last week of live metrics and the ground truth log, trains the same
candidate grid as the training script (Isolation Forest and One-Class SVM, two feature
sets), and picks the best candidate on validation F1. The candidate becomes the new
champion only if its test F1 beats the current champion's test F1 on the SAME test
minutes by at least PROMOTE_MARGIN. The previous champion keeps the alias "previous"
so a bad promotion can be undone in the MLflow UI. Every attempt is written to InfluxDB
as the measurement "model_retrain" for Grafana and the report.

  python worker.py                 run the scoring loop (with the nightly retraining)
  python worker.py --retrain-now   run one retraining cycle and exit
"""

import gc
import logging
import os
import sys
import time
from datetime import timedelta

import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
from influxdb import InfluxDBClient
from mlflow.exceptions import MlflowException
from mlflow.tracking import MlflowClient

import train_anomaly_model as t

INFLUXDB_HOST = os.environ.get("INFLUXDB_HOST", "influxdb")
INFLUXDB_PORT = int(os.environ.get("INFLUXDB_PORT", "8086"))
INFLUXDB_DB = os.environ.get("INFLUXDB_DB", "prometheus")
MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://mlflow:5000")

JOB = os.environ.get("JOB", "sample-service")
MODEL_NAME = os.environ.get("MODEL_NAME", "anomaly-detector")
MODEL_ALIAS = os.environ.get("MODEL_ALIAS", "champion")
SOURCE_EXPERIMENT = os.environ.get("SOURCE_EXPERIMENT", "anomaly-detection-v3")
SCORE_MEASUREMENT = os.environ.get("SCORE_MEASUREMENT", "anomaly_score")
DEPLOY_MEASUREMENT = os.environ.get("DEPLOY_MEASUREMENT", "deployment_event")

LOOP_SECONDS = int(os.environ.get("LOOP_SECONDS", "60"))
SETTLE_SECONDS = int(os.environ.get("SETTLE_SECONDS", "30"))       # wait for the last samples to arrive
BACKFILL_MINUTES = int(os.environ.get("BACKFILL_MINUTES", "360"))  # history scored on the first start
RELOAD_CHECK_SECONDS = int(os.environ.get("RELOAD_CHECK_SECONDS", "300"))

# Attribution settings
DEPLOY_WINDOW_MINUTES = int(os.environ.get("DEPLOY_WINDOW_MINUTES", "15"))
DEV_MIN = float(os.environ.get("DEV_MIN", "3"))
DEV_SEVERE = float(os.environ.get("DEV_SEVERE", "50"))   # latency this far above normal decides the tier
REFERENCE_HOURS = int(os.environ.get("REFERENCE_HOURS", "24"))
REFERENCE_REFRESH_SECONDS = int(os.environ.get("REFERENCE_REFRESH_SECONDS", "1800"))
MIN_REFERENCE_POINTS = int(os.environ.get("MIN_REFERENCE_POINTS", "200"))

# Nightly retraining
RETRAIN_HOUR_UTC = int(os.environ.get("RETRAIN_HOUR_UTC", "19"))          # 19:00 UTC is 03:00 in Malaysia
RETRAIN_ON_START = os.environ.get("RETRAIN_ON_START", "0") == "1"
RETRAIN_EXPERIMENT = os.environ.get("RETRAIN_EXPERIMENT", "anomaly-retraining")
PROMOTE_MARGIN = float(os.environ.get("PROMOTE_MARGIN", "0.01"))          # test F1 the challenger must win by
MIN_TEST_ANOMALIES = int(os.environ.get("MIN_TEST_ANOMALIES", "10"))      # below this the comparison is not trusted
RETRAIN_MEASUREMENT = os.environ.get("RETRAIN_MEASUREMENT", "model_retrain")
t.GROUND_TRUTH_LOG = os.environ.get("GROUND_TRUTH_LOG", "/data/ground_truth_log.jsonl")

# signal name -> feature column
SIGNALS = {"cpu": "cpu_rate", "memory": "memory_max_mb", "latency": "latency_ms"}

# (median, p99) used until enough normal minutes exist to measure the real range
FALLBACK_REFERENCE = {
    "cpu_rate": (0.01, 0.03),
    "memory_max_mb": (45.0, 65.0),
    "latency_ms": (3.0, 15.0),
}
# smallest spread (p99 - median) that counts, so a very quiet signal does not
# make tiny changes look like large deviations
MIN_SPREAD = {"cpu_rate": 0.005, "memory_max_mb": 5.0, "latency_ms": 2.0}

TIER_NAMES = {0: "none", 1: "low", 2: "medium", 3: "high"}

log = logging.getLogger("worker")


def decision_threshold(model):
    """The score above which the model flags a minute (score = -score_samples, flagged when below offset_)."""
    estimator = model[-1] if hasattr(model, "steps") else model
    return float(-np.ravel(estimator.offset_)[0])


class Champion:
    def __init__(self, model, columns, version, run_id):
        self.model = model
        self.columns = columns
        self.version = str(version)
        self.run_id = run_id
        self.threshold = decision_threshold(model)


# ------------------------------------------------------------------ registry

def ensure_champion(client):
    """The registry's champion version, registering the selected run if there is none."""
    try:
        return client.get_model_version_by_alias(MODEL_NAME, MODEL_ALIAS)
    except MlflowException:
        pass

    experiment = client.get_experiment_by_name(SOURCE_EXPERIMENT)
    if experiment is None:
        raise RuntimeError(f"No champion and no experiment '{SOURCE_EXPERIMENT}' to take one from")
    runs = client.search_runs(
        [experiment.experiment_id],
        filter_string="tags.selected = 'true'",
        order_by=["attributes.start_time DESC"],
        max_results=1,
    )
    if not runs:
        raise RuntimeError(f"No run tagged selected in '{SOURCE_EXPERIMENT}'. Run the training script first.")

    run = runs[0]
    version = mlflow.register_model(f"runs:/{run.info.run_id}/model", MODEL_NAME)
    client.set_registered_model_alias(MODEL_NAME, MODEL_ALIAS, version.version)
    log.info("registered run %s (%s) as %s@%s, version %s",
             run.info.run_id[:8], run.info.run_name, MODEL_NAME, MODEL_ALIAS, version.version)
    return client.get_model_version_by_alias(MODEL_NAME, MODEL_ALIAS)


def load_champion(client):
    version = ensure_champion(client)
    run = client.get_run(version.run_id)
    columns = run.data.params["features"].split(",")
    model = mlflow.sklearn.load_model(f"models:/{MODEL_NAME}/{version.version}")
    champion = Champion(model, columns, version.version, version.run_id)
    log.info("loaded %s version %s (run %s), features: %s, decision threshold %.3f", MODEL_NAME,
             version.version, version.run_id[:8], ", ".join(columns), champion.threshold)
    return champion


def maybe_reload(client, champion):
    current = client.get_model_version_by_alias(MODEL_NAME, MODEL_ALIAS)
    if str(current.version) != champion.version:
        log.info("champion changed from version %s to %s, reloading", champion.version, current.version)
        return load_champion(client)
    return champion


# --------------------------------------------------------------- attribution

def load_reference(influx, now=None):
    """Median and p99 of each signal over the last REFERENCE_HOURS hours of normal minutes.

    Returns (reference, source) where reference maps column -> (median, p99) and
    source is "measured" or "fallback".
    """
    now = now or pd.Timestamp.now(tz="UTC")
    since = (now - timedelta(hours=REFERENCE_HOURS)).isoformat()
    cols = ", ".join(f'"{c}"' for c in SIGNALS.values())
    query = (f'SELECT {cols} FROM "{SCORE_MEASUREMENT}" '
             f'WHERE "job" = \'{JOB}\' AND "is_anomaly" = 0 AND time >= \'{since}\'')
    df = pd.DataFrame(list(influx.query(query).get_points()))
    if len(df) < MIN_REFERENCE_POINTS:
        return dict(FALLBACK_REFERENCE), "fallback"

    reference = {}
    for column in SIGNALS.values():
        values = pd.to_numeric(df[column], errors="coerce").dropna()
        if values.empty:
            reference[column] = FALLBACK_REFERENCE[column]
        else:
            reference[column] = (float(values.median()), float(values.quantile(0.99)))
    return reference, "measured"


def get_reference(influx, state, now=None):
    """The reference, refreshed at most every REFERENCE_REFRESH_SECONDS."""
    clock = time.time()
    if state.get("reference") is None or clock >= state.get("reference_until", 0):
        reference, source = load_reference(influx, now)
        state["reference"] = reference
        state["reference_source"] = source
        state["reference_until"] = clock + REFERENCE_REFRESH_SECONDS
        log.info("reference (%s): %s", source,
                 ", ".join(f"{c} median {m:.3g} p99 {p:.3g}" for c, (m, p) in reference.items()))
    return state["reference"]


def read_deployments(influx, since):
    """Timestamps of deployment events at or after `since`."""
    query = (f'SELECT "commit_sha" FROM "{DEPLOY_MEASUREMENT}" '
             f"WHERE time >= '{pd.Timestamp(since).isoformat()}'")
    try:
        points = list(influx.query(query).get_points())
    except Exception:
        log.exception("could not read deployment events")
        return []
    return sorted(pd.to_datetime([p["time"] for p in points], utc=True))


def deployed_recently(minute, deployments):
    """True if a deployment happened within DEPLOY_WINDOW_MINUTES before the end of this minute."""
    end = minute + timedelta(minutes=1)
    start = end - timedelta(minutes=DEPLOY_WINDOW_MINUTES)
    return any(start <= d <= end for d in deployments)


def deviation(column, value, reference):
    """How many normal spreads the value sits above its normal median (never negative)."""
    median, p99 = reference[column]
    spread = max(p99 - median, MIN_SPREAD[column])
    return max(0.0, (float(value) - median) / spread)


def classify(row, flagged, reference, deployed):
    """Tier, action and the signals behind them for one minute."""
    devs = {name: deviation(column, row[column], reference) for name, column in SIGNALS.items()}
    moved = [name for name, d in sorted(devs.items(), key=lambda kv: -kv[1]) if d >= DEV_MIN]

    result = {
        "tier_level": 0, "tier": "none", "action": "none", "signal": "none",
        "signals": "", "recent_deployment": int(bool(deployed)), "devs": devs,
    }
    if not flagged:
        return result

    result["signals"] = ",".join(moved)
    # Signals are not on the same scale, so "which moved most" is not a fair test: the
    # first minute of a memory leak briefly slows the service (latency about 60 ms) and a
    # CPU spike lifts latency to about 15 ms. Latency therefore only decides the tier when
    # it is SEVERE (DEV_SEVERE normal spreads, about 140 ms). Below that, memory comes
    # first, then CPU, and a mild latency rise on its own is only a notification.
    if devs["latency"] >= DEV_SEVERE:
        signal = "latency"
        level, action = (3, "rollback") if deployed else (2, "restart")
    elif "memory" in moved:
        signal, level, action = "memory", 2, "restart"
    elif "cpu" in moved:
        signal, level, action = "cpu", 1, "notify"
    elif "latency" in moved:
        signal, level, action = "latency", 1, "notify"
    else:
        signal, level, action = "unclear", 1, "notify"
    result.update(tier_level=level, tier=TIER_NAMES[level], action=action, signal=signal)
    return result


# ------------------------------------------------------------------- scoring

def score_features(champion, features):
    X = features[champion.columns].to_numpy()
    scores = -champion.model.score_samples(X)          # higher means more anomalous
    flagged = champion.model.predict(X) == -1          # the model's own decision
    return scores, flagged


def make_points(champion, features, scores, flagged, reference, deployments):
    points = []
    for (minute, row), score, flag in zip(features.iterrows(), scores, flagged):
        c = classify(row, bool(flag), reference, deployed_recently(minute, deployments))
        fields = {
            "score": float(score),
            "threshold": champion.threshold,
            "is_anomaly": int(flag),
            "tier_level": c["tier_level"],
            "tier": c["tier"],
            "action": c["action"],
            "signal": c["signal"],
            "signals": c["signals"],
            "recent_deployment": c["recent_deployment"],
            "dev_cpu": float(c["devs"]["cpu"]),
            "dev_memory": float(c["devs"]["memory"]),
            "dev_latency": float(c["devs"]["latency"]),
            **{c_name: float(row[c_name]) for c_name in t.ALL_FEATURES},
        }
        for column, (median, _) in reference.items():
            fields[f"base_{column}"] = float(median)
        points.append({
            "measurement": SCORE_MEASUREMENT,
            "tags": {"job": JOB, "model": f"v{champion.version}"},
            "time": minute.isoformat(),
            "fields": fields,
        })
    return points


def read_last_scored(influx):
    query = f'SELECT last("score") FROM "{SCORE_MEASUREMENT}" WHERE "job" = \'{JOB}\''
    points = list(influx.query(query).get_points())
    return pd.to_datetime(points[0]["time"], utc=True) if points else None


def score_pending(influx, champion, now=None, state=None):
    """Scores every completed, not yet scored minute. Returns the number of minutes written."""
    state = state if state is not None else {}
    now = now or pd.Timestamp.now(tz="UTC")
    last_complete = (now - timedelta(seconds=60 + SETTLE_SECONDS)).floor("min")

    last_scored = read_last_scored(influx)
    first = (last_complete - timedelta(minutes=BACKFILL_MINUTES) if last_scored is None
             else last_scored + timedelta(minutes=1))
    if first > last_complete:
        return 0

    lookback_minutes = int((now - first).total_seconds() // 60) + 5   # 5 extra for the rate warm-up
    raw = t.fetch_raw(lookback=f"{lookback_minutes}m", job=JOB, verbose=False, client=influx)
    features = t.build_features(raw)
    pending = features[(features.index >= first) & (features.index <= last_complete)]
    if pending.empty:
        return 0

    scores, flagged = score_features(champion, pending)
    reference = get_reference(influx, state, now)
    deployments = read_deployments(influx, first - timedelta(minutes=DEPLOY_WINDOW_MINUTES))
    points = make_points(champion, pending, scores, flagged, reference, deployments)
    influx.write_points(points)

    for p, flag in zip(points, flagged):
        f = p["fields"]
        if flag:
            log.warning("ALERT %s tier=%s action=%s signal=%s (signals: %s) score=%.3f deployment=%s "
                        "cpu=%.3f mem=%.0f MB latency=%.0f ms",
                        p["time"], f["tier"], f["action"], f["signal"], f["signals"] or "-", f["score"],
                        bool(f["recent_deployment"]), f["cpu_rate"], f["memory_max_mb"], f["latency_ms"])
    log.info("scored %d minute(s) up to %s, latest score %.3f (tier %s, flagged %s, model v%s)",
             len(pending), pending.index[-1].strftime("%Y-%m-%d %H:%M"), scores[-1],
             points[-1]["fields"]["tier"], bool(flagged[-1]), champion.version)
    return len(pending)


# ---------------------------------------------------------------- retraining

def next_retrain_time(now=None):
    now = now or pd.Timestamp.now(tz="UTC")
    target = now.floor("D") + timedelta(hours=RETRAIN_HOUR_UTC)
    return target if target > now else target + timedelta(days=1)


def load_dataset(influx):
    """The labelled dataset the training script builds, from the live metrics."""
    ground_truth = t.load_ground_truth()
    features = t.build_features(t.fetch_raw(job=JOB, verbose=False, client=influx))
    injections = len(ground_truth)
    if t.DATA_START:
        cutoff = pd.Timestamp(t.DATA_START)
        features = features[features.index >= cutoff]
        injections = sum(1 for r in ground_truth if pd.Timestamp(r["timestamp"]) >= cutoff)
    spans, _ = t.expand_exclusions(t.EXCLUDE_WINDOWS, ground_truth)
    features, dropped = t.drop_excluded(features, spans)
    tiers, cover = t.label_rows(features, ground_truth)
    return features, tiers, cover, {"minutes_excluded": dropped, "injections_in_log": injections}


def champion_test_metrics(champion, features, tiers, cover):
    """The champion's own decisions on the test minutes of the new dataset."""
    i2 = int(len(features) * (t.TRAIN_FRACTION + t.VAL_FRACTION))
    X = features[champion.columns].to_numpy()[i2:]
    pred = champion.model.predict(X) == -1
    scores = -champion.model.score_samples(X)
    return t.evaluate(tiers.notna().to_numpy()[i2:], pred, scores, tiers.to_numpy()[i2:], cover[i2:])


def promote(client, run_id, challenger_f1, champion_f1):
    """Registers the run as a new model version and moves the champion alias to it."""
    old = client.get_model_version_by_alias(MODEL_NAME, MODEL_ALIAS)
    version = mlflow.register_model(f"runs:/{run_id}/model", MODEL_NAME)
    client.set_registered_model_alias(MODEL_NAME, "previous", old.version)
    client.set_registered_model_alias(MODEL_NAME, MODEL_ALIAS, version.version)
    client.set_model_version_tag(MODEL_NAME, version.version, "test_f1", f"{challenger_f1:.4f}")
    client.set_model_version_tag(MODEL_NAME, version.version, "replaced_champion_test_f1", f"{champion_f1:.4f}")
    return str(version.version)


def retrain(influx, mlflow_client, champion):
    """One retraining cycle. Returns a dict describing what happened."""
    features, tiers, cover, info = load_dataset(influx)
    i2 = int(len(features) * (t.TRAIN_FRACTION + t.VAL_FRACTION))
    test_anomalies = int(tiers.notna().to_numpy()[i2:].sum())

    t.MLFLOW_EXPERIMENT_NAME = RETRAIN_EXPERIMENT
    results, best = t.run_experiments(features, tiers, cover, info)      # raises if there is too little data
    challenger_f1 = float(best["test_f1_score"])
    cm = champion_test_metrics(champion, features, tiers, cover)
    champion_f1 = float(cm["f1_score"])

    outcome = {
        "minutes": len(features), "injections": info["injections_in_log"], "test_anomalies": test_anomalies,
        "test_start": str(features.index[i2]),
        "challenger_run": best["run"], "challenger_f1": challenger_f1,
        "challenger_tp": int(best["test_true_positives"]), "challenger_fp": int(best["test_false_positives"]),
        "challenger_fn": int(best["test_false_negatives"]),
        "champion_version": champion.version, "champion_f1": champion_f1,
        "champion_tp": int(cm["true_positives"]), "champion_fp": int(cm["false_positives"]),
        "champion_fn": int(cm["false_negatives"]),
        "promoted": 0, "new_version": "", "reason": "",
    }
    if test_anomalies < MIN_TEST_ANOMALIES:
        outcome["reason"] = f"only {test_anomalies} anomalous test minutes"
    elif challenger_f1 < champion_f1 + PROMOTE_MARGIN:
        outcome["reason"] = f"challenger {challenger_f1:.3f} does not beat champion {champion_f1:.3f} by {PROMOTE_MARGIN}"
    else:
        outcome["new_version"] = promote(mlflow_client, best["run_id"], challenger_f1, champion_f1)
        outcome["promoted"] = 1
        outcome["reason"] = f"challenger {challenger_f1:.3f} beats champion {champion_f1:.3f}"
    log.info("retraining finished: %s (%d minutes, %d injections, %d anomalous test minutes). Best candidate %s",
             "PROMOTED to version " + outcome["new_version"] if outcome["promoted"] else "champion kept",
             outcome["minutes"], outcome["injections"], test_anomalies, best["run"])
    log.info("retraining reason: %s", outcome["reason"])

    influx.write_points([{
        "measurement": RETRAIN_MEASUREMENT,
        "tags": {"job": JOB},
        "time": pd.Timestamp.now(tz="UTC").isoformat(),
        "fields": {k: (v if isinstance(v, (int, float)) else str(v)) for k, v in outcome.items()},
    }])
    return outcome


def retrain_safely(influx, mlflow_client, champion):
    """Runs retraining without ever stopping the scoring loop. Returns the champion to use next."""
    try:
        log.info("retraining started")
        retrain(influx, mlflow_client, champion)
        champion = maybe_reload(mlflow_client, champion)
    except Exception:
        log.exception("retraining failed, keeping the current champion")
    gc.collect()
    return champion


# ---------------------------------------------------------------------- main

def wait_for_champion(client):
    while True:
        try:
            return load_champion(client)
        except Exception as e:
            log.warning("cannot load the champion yet (%s), retrying in 15 s", e)
            time.sleep(15)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("starting: job=%s, influx=%s:%s, mlflow=%s", JOB, INFLUXDB_HOST, INFLUXDB_PORT, MLFLOW_TRACKING_URI)

    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    mlflow_client = MlflowClient()
    influx = InfluxDBClient(host=INFLUXDB_HOST, port=INFLUXDB_PORT, database=INFLUXDB_DB)

    champion = wait_for_champion(mlflow_client)

    if "--retrain-now" in sys.argv:
        outcome = retrain(influx, mlflow_client, champion)
        print(outcome)
        return

    next_reload = time.time() + RELOAD_CHECK_SECONDS
    next_retrain = pd.Timestamp.now(tz="UTC") if RETRAIN_ON_START else next_retrain_time()
    log.info("next retraining at %s UTC", next_retrain.strftime("%Y-%m-%d %H:%M"))
    state = {}

    while True:
        started = time.time()
        try:
            if started >= next_reload:
                champion = maybe_reload(mlflow_client, champion)
                next_reload = started + RELOAD_CHECK_SECONDS
            score_pending(influx, champion, state=state)
            if pd.Timestamp.now(tz="UTC") >= next_retrain:
                champion = retrain_safely(influx, mlflow_client, champion)
                next_retrain = next_retrain_time()
                log.info("next retraining at %s UTC", next_retrain.strftime("%Y-%m-%d %H:%M"))
        except Exception:
            log.exception("loop failed, will retry next minute")
        time.sleep(max(1, LOOP_SECONDS - (time.time() - started)))


if __name__ == "__main__":
    main()
