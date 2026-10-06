"""
Scoring worker, part 1: live anomaly scores.

Every minute it
  1. loads the champion model from the MLflow model registry and checks
     whether a newer champion has been promoted,
  2. reads the latest raw sample-service metrics from InfluxDB,
  3. builds the same per-minute features the model was trained on,
  4. scores every completed minute that has not been scored yet,
  5. writes the scores, and the features behind them, back to InfluxDB as the
     measurement "anomaly_score", so Grafana, n8n and the LLM step can read them.

If the registry has no champion yet, the run tagged "selected" in the source
experiment is registered as the first champion.

Nightly retraining and champion promotion are added in part 2.
"""

import logging
import os
import time
from datetime import timedelta

import mlflow
import mlflow.sklearn
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

LOOP_SECONDS = int(os.environ.get("LOOP_SECONDS", "60"))
SETTLE_SECONDS = int(os.environ.get("SETTLE_SECONDS", "30"))       # wait for the last samples to arrive
BACKFILL_MINUTES = int(os.environ.get("BACKFILL_MINUTES", "360"))  # history scored on the first start
RELOAD_CHECK_SECONDS = int(os.environ.get("RELOAD_CHECK_SECONDS", "300"))

# Alert tiers from the project proposal. NOT calibrated yet: the model's own
# decision threshold (is_anomaly) can sit below TIER_LOW, so a flagged minute
# may still show tier "none" until the thresholds are calibrated on validation scores.
TIER_LOW = float(os.environ.get("TIER_LOW", "0.65"))
TIER_MEDIUM = float(os.environ.get("TIER_MEDIUM", "0.75"))
TIER_HIGH = float(os.environ.get("TIER_HIGH", "0.88"))

log = logging.getLogger("worker")


class Champion:
    def __init__(self, model, columns, version, run_id):
        self.model = model
        self.columns = columns
        self.version = str(version)
        self.run_id = run_id


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
    log.info("loaded %s version %s (run %s), features: %s", MODEL_NAME, version.version,
             version.run_id[:8], ", ".join(columns))
    return Champion(model, columns, version.version, version.run_id)


def maybe_reload(client, champion):
    current = client.get_model_version_by_alias(MODEL_NAME, MODEL_ALIAS)
    if str(current.version) != champion.version:
        log.info("champion changed from version %s to %s, reloading", champion.version, current.version)
        return load_champion(client)
    return champion


# ------------------------------------------------------------------- scoring

def tier_for(score):
    if score >= TIER_HIGH:
        return 3, "high"
    if score >= TIER_MEDIUM:
        return 2, "medium"
    if score >= TIER_LOW:
        return 1, "low"
    return 0, "none"


def score_features(champion, features):
    X = features[champion.columns].to_numpy()
    scores = -champion.model.score_samples(X)          # higher means more anomalous
    flagged = champion.model.predict(X) == -1          # the model's own decision
    return scores, flagged


def make_points(champion, features, scores, flagged):
    points = []
    for (minute, row), score, flag in zip(features.iterrows(), scores, flagged):
        level, name = tier_for(float(score))
        points.append({
            "measurement": SCORE_MEASUREMENT,
            "tags": {"job": JOB, "model": f"v{champion.version}"},
            "time": minute.isoformat(),
            "fields": {
                "score": float(score),
                "is_anomaly": int(flag),
                "tier_level": level,
                "tier": name,
                **{c: float(row[c]) for c in t.ALL_FEATURES},
            },
        })
    return points


def read_last_scored(influx):
    query = f'SELECT last("score") FROM "{SCORE_MEASUREMENT}" WHERE "job" = \'{JOB}\''
    points = list(influx.query(query).get_points())
    return pd.to_datetime(points[0]["time"], utc=True) if points else None


def score_pending(influx, champion, now=None):
    """Scores every completed, not yet scored minute. Returns the number of minutes written."""
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
    influx.write_points(make_points(champion, pending, scores, flagged))
    level, name = tier_for(float(scores[-1]))
    log.info("scored %d minute(s) up to %s, latest score %.3f (tier %s, flagged %s, model v%s)",
             len(pending), pending.index[-1].strftime("%Y-%m-%d %H:%M"), scores[-1], name,
             bool(flagged[-1]), champion.version)
    return len(pending)


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
    log.warning("tier thresholds %.2f / %.2f / %.2f are not calibrated yet", TIER_LOW, TIER_MEDIUM, TIER_HIGH)

    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    mlflow_client = MlflowClient()
    influx = InfluxDBClient(host=INFLUXDB_HOST, port=INFLUXDB_PORT, database=INFLUXDB_DB)

    champion = wait_for_champion(mlflow_client)
    next_reload = time.time() + RELOAD_CHECK_SECONDS

    while True:
        started = time.time()
        try:
            if started >= next_reload:
                champion = maybe_reload(mlflow_client, champion)
                next_reload = started + RELOAD_CHECK_SECONDS
            score_pending(influx, champion)
        except Exception:
            log.exception("loop failed, will retry next minute")
        time.sleep(max(1, LOOP_SECONDS - (time.time() - started)))


if __name__ == "__main__":
    main()
