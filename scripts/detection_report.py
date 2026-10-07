"""
Detection report for the live anomaly scores.

Compares the scores that the worker wrote to InfluxDB (measurement anomaly_score)
with the injector's ground truth log, and prints
  - how many injections were detected, in total and per fault type,
  - how many flagged minutes fall outside every injection window (false alarms),
  - the highest-scoring normal minutes, to see how close a false alarm came.

An injection counts as detected if at least one minute is flagged between the minute
it starts in and one minute after it ends.

Usage
  python3 detection_report.py                       all scored minutes
  python3 detection_report.py --since 2026-10-06T07:00:00Z
  python3 detection_report.py --table               also one line per injection
  python3 detection_report.py --csv                 also save detection_report_<date>.csv
"""

import argparse
import json
import os
from datetime import datetime, timedelta, timezone

import pandas as pd
from influxdb import InfluxDBClient

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
GROUND_TRUTH_LOG = os.path.join(SCRIPT_DIR, "ground_truth_log.jsonl")


def load_scores(client, since):
    query = 'SELECT score, is_anomaly, cpu_rate, memory_max_mb, latency_ms FROM anomaly_score'
    if since:
        query += f" WHERE time >= '{pd.Timestamp(since).isoformat()}'"
    df = pd.DataFrame(list(client.query(query).get_points()))
    if df.empty:
        raise SystemExit("No scores found in InfluxDB yet.")
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df.set_index("time").sort_index()


def analyse(df, records):
    covered = pd.Series(False, index=df.index)
    rows = []
    for r in records:
        if not r.get("triggered_successfully"):
            continue
        start = pd.Timestamp(r["timestamp"])
        end = start + timedelta(seconds=r["duration_seconds"])
        inside = (df.index >= start.floor("min")) & (df.index <= end + timedelta(minutes=1))
        if not inside.any():
            continue                      # injection outside the scored period
        covered |= inside
        w = df[inside]
        rows.append({
            "start": start.strftime("%m-%d %H:%M:%S"),
            "kind": r["scenario"].split("/")[-1],
            "secs": r["duration_seconds"],
            "max_score": round(float(w.score.max()), 3),
            "flagged_min": int(w.is_anomaly.sum()),
            "max_cpu_rate": round(float(w.cpu_rate.max()), 2),
            "max_mem_mb": round(float(w.memory_max_mb.max())),
            "max_lat_ms": round(float(w.latency_ms.max())),
        })
    return pd.DataFrame(rows), covered


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--since", help="only use scores and injections from this UTC time, e.g. 2026-10-06T07:00:00Z")
    parser.add_argument("--table", action="store_true", help="print one line per injection")
    parser.add_argument("--csv", action="store_true", help="save the per-injection table as detection_report_<date>.csv")
    parser.add_argument("--host", default="localhost")
    args = parser.parse_args(argv)

    client = InfluxDBClient(host=args.host, port=8086, database="prometheus")
    df = load_scores(client, args.since)
    with open(GROUND_TRUTH_LOG) as f:
        records = [json.loads(line) for line in f if line.strip()]

    table, covered = analyse(df, records)
    flag = df.is_anomaly == 1
    normal = df[~covered]
    false_alarms = int((flag & ~covered).sum())

    print(f"Scored minutes: {len(df)} ({df.index.min():%m-%d %H:%M} to {df.index.max():%m-%d %H:%M} UTC)")
    if table.empty:
        print("No injections fall inside that period.")
    else:
        detected = int((table.flagged_min > 0).sum())
        print(f"Injections in that period: {len(table)} | detected: {detected} ({detected / len(table) * 100:.0f}%)")
        if args.table:
            print()
            print(table.to_string(index=False))
        print()
        summary = table.groupby("kind").agg(
            n=("kind", "size"),
            detected=("flagged_min", lambda x: int((x > 0).sum())),
            min_score=("max_score", "min"),
            max_score=("max_score", "max"),
            flagged_min_per_injection=("flagged_min", "mean"),
        )
        print(summary.round(2).to_string())
        missed = table[table.flagged_min == 0]
        if len(missed):
            print("\nMissed injections:")
            print(missed.to_string(index=False))

    print()
    print(f"Flagged minutes: {int(flag.sum())} | inside an injection window: {int((flag & covered).sum())} "
          f"| outside (false alarms): {false_alarms}")
    n = len(normal)
    if n:
        bound = f", below about {3 / n * 100:.2f}% with 95% confidence" if false_alarms == 0 else ""
        print(f"Normal minutes: {n} | false alarm rate {false_alarms / n * 100:.2f}%{bound}")
        print(f"Highest normal score {normal.score.max():.3f} | 99th percentile {normal.score.quantile(0.99):.3f}")
        print("\nHighest-scoring normal minutes (UTC):")
        top = normal.sort_values("score", ascending=False).head(5)[["score", "cpu_rate", "memory_max_mb", "latency_ms"]]
        print(top.round(3).to_string())

    if args.csv and not table.empty:
        path = os.path.join(SCRIPT_DIR, f"detection_report_{datetime.now(timezone.utc):%Y%m%d}.csv")
        table.to_csv(path, index=False)
        print(f"\nPer-injection table saved to {path}")


if __name__ == "__main__":
    main()
