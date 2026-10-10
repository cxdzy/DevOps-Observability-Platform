"""
Explanation report.

Compares the explanations written by the explainer service (measurement
incident_explanation) with the injector's ground truth log, and prints
  - how many incidents were explained, and how many by the model or by the fallback template,
  - how often the explained main signal and tier match the injected fault,
  - how often the model's first answer was rejected by the grounding check, and why,
  - the model's response time,
and saves a CSV with every explanation next to its ground truth, so the text can be read
and scored by hand (the manual score is the thesis result for explanation quality).

Usage
  python3 explanation_report.py                      all explanations
  python3 explanation_report.py --since 2026-10-09T13:00:00Z
  python3 explanation_report.py --show 5             also print the 5 latest explanations
  python3 explanation_report.py --csv                save explanation_report_<date>.csv
"""

import argparse
import json
import os
from datetime import timedelta

import pandas as pd
from influxdb import InfluxDBClient

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
GROUND_TRUTH_LOG = os.path.join(SCRIPT_DIR, "ground_truth_log.jsonl")
EXPECTED_SIGNAL = {"/simulate/cpu-spike": "cpu", "/simulate/memory-leak": "memory",
                   "/simulate/latency-spike": "latency"}


def load_explanations(client, since):
    query = "SELECT * FROM incident_explanation"
    if since:
        query += f" WHERE time >= '{pd.Timestamp(since).isoformat()}'"
    df = pd.DataFrame(list(client.query(query).get_points()))
    if df.empty:
        raise SystemExit("No explanations found in InfluxDB yet.")
    df["explanation"] = df["explanation"].str.replace("\\n", "\n", regex=False)
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df["end_time"] = pd.to_datetime(df["end_time"], utc=True)
    return df.sort_values("time").reset_index(drop=True)


def load_injections():
    with open(GROUND_TRUTH_LOG) as f:
        records = [json.loads(line) for line in f if line.strip()]
    for r in records:
        r["start"] = pd.Timestamp(r["timestamp"])
        r["end"] = r["start"] + timedelta(seconds=r["duration_seconds"])
    return records


def match(row, injections):
    """The injection whose window (from one minute before its start to two minutes after its end)
    overlaps the incident. Returns the one that starts closest to the incident start."""
    lo, hi = row["time"] - timedelta(minutes=1), row["end_time"] + timedelta(minutes=1)
    hits = [r for r in injections if r["start"] - timedelta(minutes=1) <= hi and r["end"] + timedelta(minutes=2) >= lo]
    if not hits:
        return None
    return min(hits, key=lambda r: abs((r["start"] - row["time"]).total_seconds()))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since")
    parser.add_argument("--show", type=int, default=0)
    parser.add_argument("--csv", action="store_true")
    args = parser.parse_args()

    client = InfluxDBClient(host="localhost", port=8086, database="prometheus")
    df = load_explanations(client, args.since)
    injections = load_injections()

    truth_signal, truth_tier = [], []
    for _, row in df.iterrows():
        m = match(row, injections)
        truth_signal.append(EXPECTED_SIGNAL.get(m["scenario"]) if m else "none")
        truth_tier.append(m["tier"] if m else "none")
    df["truth_signal"], df["truth_tier"] = truth_signal, truth_tier
    df["signal_ok"] = df["signal"] == df["truth_signal"]
    df["tier_ok"] = df["tier"] == df["truth_tier"]

    n = len(df)
    print(f"\nExplained incidents: {n}")
    print(f"  written by the model:      {(df['source'] == 'llm').sum()}")
    print(f"  fixed template (fallback): {(df['source'] == 'template').sum()}")
    first_try = ((df["source"] == "llm") & (df["attempts"] == 1)).sum()
    print(f"  model accepted on first try: {first_try} ({first_try / n:.0%})")
    print(f"  incidents with no matching injection: {(df['truth_signal'] == 'none').sum()}")

    matched = df[df["truth_signal"] != "none"]
    if len(matched):
        print(f"\nAgainst the ground truth ({len(matched)} matched incidents)")
        print(f"  main signal correct: {matched['signal_ok'].sum()} ({matched['signal_ok'].mean():.0%})")
        print(f"  tier correct:        {matched['tier_ok'].sum()} ({matched['tier_ok'].mean():.0%})")
        print("\nBy injected fault:")
        by = matched.groupby("truth_signal").agg(incidents=("signal", "size"), signal_ok=("signal_ok", "mean"),
                                                 tier_ok=("tier_ok", "mean"),
                                                 template=("source", lambda s: (s == "template").mean()))
        print(by.round(2).to_string())

    unmatched = df[df["truth_signal"] == "none"]
    if len(unmatched):
        print("\nIncidents with no matching injection (real load, or a false alarm worth a look):")
        for _, row in unmatched.iterrows():
            print(f"  {row['time']:%Y-%m-%d %H:%M} to {row['end_time']:%H:%M}  {row['signal']} / {row['tier']} "
                  f"/ {row['minutes']} min")

    llm = df[df["source"] == "llm"]
    if len(llm):
        print(f"\nModel response time (ms): median {llm['llm_latency_ms'].median():.0f}, "
              f"max {llm['llm_latency_ms'].max():.0f}; tokens per incident median {llm['tokens'].median():.0f}")
    rejected = df[df["rejected"].fillna("") != ""]
    if len(rejected):
        print("\nWhy the grounding check rejected the model's text:")
        reasons = rejected["rejected"].str.split("; ").explode().str.replace(r"\d+(\.\d+)?", "N", regex=True)
        print(reasons.value_counts().head(10).to_string())

    if args.show:
        for _, row in df.tail(args.show).iterrows():
            print(f"\n[{row['time']:%Y-%m-%d %H:%M}] {row['signal']} / {row['tier']} / {row['source']} "
                  f"(truth: {row['truth_signal']})\n{row['explanation']}")

    if args.csv:
        name = f"explanation_report_{pd.Timestamp.now(tz='UTC'):%Y%m%d}.csv"
        cols = ["time", "end_time", "minutes", "signal", "truth_signal", "signal_ok", "tier", "truth_tier",
                "tier_ok", "action", "deployment", "source", "attempts", "llm_latency_ms", "tokens",
                "rejected", "explanation"]
        df[cols].assign(manual_score_1to5="").to_csv(name, index=False)
        print(f"\nSaved {name}. Fill the column manual_score_1to5 after reading each explanation.")


if __name__ == "__main__":
    main()
