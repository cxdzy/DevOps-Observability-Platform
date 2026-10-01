"""
Anomaly Injector — generates labeled training and evaluation data.

Periodically triggers simulated failures on sample-service (CPU spike, memory
leak, latency spike) matching the three severity tiers in the remediation
table. Every injection is logged with its exact start/end time and type to
ground_truth_log.jsonl, which is later used to calculate precision, recall
and false positive rate for the Isolation Forest model (Chapter 3, Section 6).

Also writes a DEPLOYMENT_EVENT point directly to InfluxDB for medium/high
tier injections, since those are framed as deployment-triggered incidents
(matching the ERD's DEPLOYMENT_EVENT measurement).

Run: python3 anomaly_injector.py
Stop: Ctrl+C (or run under systemd/cron for continuous background operation)
"""

import json
import random
import time
import uuid
from datetime import datetime, timezone

import requests

SAMPLE_SERVICE_URL = "http://localhost:4000"
INFLUXDB_URL = "http://localhost:8086"
INFLUXDB_DB = "prometheus"
LOG_FILE = "ground_truth_log.jsonl"

# Roughly how often to attempt an injection, in seconds. Randomized within
# this range so injections don't fall on a perfectly predictable schedule.
MIN_INTERVAL_SECONDS = 600   # 10 minutes
MAX_INTERVAL_SECONDS = 1800  # 30 minutes

SCENARIOS = [
    {
        "tier": "low",
        "endpoint": "/simulate/cpu-spike",
        "params": {"duration": 30},
        "weight": 0.5,
    },
    {
        "tier": "medium",
        "endpoint": "/simulate/memory-leak",
        "params": {"sizeMb": 150, "duration": 90},
        "weight": 0.3,
    },
    {
        "tier": "high",
        "endpoint": "/simulate/latency-spike",
        "params": {"delayMs": 3000, "duration": 60},
        "weight": 0.2,
    },
]


def log_event(record):
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(record) + "\n")
    print(f"[{record['timestamp']}] {record['tier'].upper()} tier: {record['scenario']} "
          f"(duration {record['duration_seconds']}s)")


def write_deployment_event(commit_sha, is_recent):
    """Writes a DEPLOYMENT_EVENT point to InfluxDB using line protocol,
    matching the ERD's InfluxDB deployment_event measurement."""
    timestamp_ns = int(time.time() * 1e9)
    line = (
        f"deployment_event,container_name=sample-service,branch=master "
        f"commit_sha=\"{commit_sha}\",pipeline_run_id=\"{uuid.uuid4()}\","
        f"is_recent={str(is_recent).lower()} {timestamp_ns}"
    )
    try:
        resp = requests.post(
            f"{INFLUXDB_URL}/write",
            params={"db": INFLUXDB_DB},
            data=line,
            timeout=5,
        )
        if resp.status_code != 204:
            print(f"  Warning: InfluxDB write returned {resp.status_code}: {resp.text}")
    except requests.RequestException as e:
        print(f"  Warning: could not write deployment event to InfluxDB: {e}")


def choose_scenario():
    weights = [s["weight"] for s in SCENARIOS]
    return random.choices(SCENARIOS, weights=weights, k=1)[0]


def inject(scenario):
    start = datetime.now(timezone.utc).isoformat()
    try:
        resp = requests.post(
            f"{SAMPLE_SERVICE_URL}{scenario['endpoint']}",
            params=scenario["params"],
            timeout=5,
        )
        success = resp.status_code == 202
    except requests.RequestException as e:
        print(f"  Error triggering {scenario['endpoint']}: {e}")
        success = False

    duration = scenario["params"].get("duration", 30)

    record = {
        "timestamp": start,
        "tier": scenario["tier"],
        "scenario": scenario["endpoint"],
        "params": scenario["params"],
        "duration_seconds": duration,
        "triggered_successfully": success,
    }
    log_event(record)

    # Medium and high tier scenarios are framed as deployment-triggered,
    # matching the three-tier remediation table's "recent deployment detected"
    # condition for the high tier.
    if scenario["tier"] in ("medium", "high"):
        write_deployment_event(commit_sha=uuid.uuid4().hex[:7], is_recent=True)

    return duration


def main():
    print(f"Anomaly injector started. Logging to {LOG_FILE}")
    print(f"Injection interval: {MIN_INTERVAL_SECONDS}-{MAX_INTERVAL_SECONDS}s (randomized)\n")

    while True:
        scenario = choose_scenario()
        duration = inject(scenario)

        # Wait out the injection's own duration plus a randomized gap before
        # the next one, so injections don't overlap unpredictably.
        gap = random.randint(MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)
        time.sleep(duration + gap)


if __name__ == "__main__":
    main()
