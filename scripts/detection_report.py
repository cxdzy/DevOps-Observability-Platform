"""
Detection report for the live anomaly scores.

Compares the scores that the worker wrote to InfluxDB (measurement anomaly_score)
with the injector's ground truth log, and prints
  - how many injections were detected, in total and per fault type,
  - how many flagged minutes fall outside every injection window (false alarms),
  - the highest-scoring normal minutes, to see how close a false alarm came,
  - the early warnings (trend check): how many injections were warned about, how many minutes before the
    model flagged them (lead time), and how many warnings fall outside every injection (false early warnings).
    A gradual injection (shape "ramp") is where a lead time can exist: a step fault is at full strength
    within seconds, so there is nothing to warn about before the model flags it.

An injection counts as detected if at least one minute is flagged between the minute
it starts in and one minute after it ends.

Usage
  python3 detection_report.py                       all scored minutes
  python3 detection_report.py --since 2026-10-06T07:00:00Z
  python3 detection_report.py --table               also one line per injection
  python3 detection_report.py --csv                 also save detection_report_<date>.csv
  python3 detection_report.py --exclude 2026-11-09T15:30:00Z 2026-11-09T15:45:00Z
                                                    leave a period out (repeatable), for example a test or an outage
  python3 detection_report.py --save                also write the results to InfluxDB for the dashboard (see build_points)
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
    query = 'SELECT score, is_anomaly, early_warning, warmup, cpu_rate, memory_max_mb, latency_ms, threshold, model FROM anomaly_score'
    if since:
        query += f" WHERE time >= '{pd.Timestamp(since).isoformat()}'"
    df = pd.DataFrame(list(client.query(query).get_points()))
    if df.empty:
        raise SystemExit("No scores found in InfluxDB yet.")
    df["time"] = pd.to_datetime(df["time"], utc=True)
    for column in ("early_warning", "warmup"):      # absent in scores written before these fields existed
        if column not in df:
            df[column] = 0
        df[column] = pd.to_numeric(df[column], errors="coerce").fillna(0).astype(int)
    for column in ("threshold", "model"):           # only stored in the report, never printed; absent in very old scores
        if column not in df:
            df[column] = None
    df["threshold"] = pd.to_numeric(df["threshold"], errors="coerce")
    return df.set_index("time").sort_index()


def first_time(w, column):
    hits = w.index[w[column] == 1]
    return hits[0] if len(hits) else None


def analyse(df, records, excluded=()):
    covered = pd.Series(False, index=df.index)
    rows = []
    starts = []
    for r in records:
        if not r.get("triggered_successfully"):
            continue
        start = pd.Timestamp(r["timestamp"])
        if any(a <= start <= b for a, b in excluded):
            continue
        end = start + timedelta(seconds=r["duration_seconds"])
        inside = (df.index >= start.floor("min")) & (df.index <= end + timedelta(minutes=1))
        if not inside.any():
            continue                      # injection outside the scored period
        covered |= inside
        w = df[inside]
        flag_at, warn_at = first_time(w, "is_anomaly"), first_time(w, "early_warning")
        lead = (flag_at - warn_at).total_seconds() / 60 if flag_at is not None and warn_at is not None else None
        starts.append(start)
        rows.append({
            "start": start.strftime("%m-%d %H:%M:%S"),
            "kind": r["scenario"].split("/")[-1],
            "shape": r.get("shape", "step"),
            "secs": r["duration_seconds"],
            "max_score": round(float(w.score.max()), 3),
            "flagged_min": int(w.is_anomaly.sum()),
            "first_flag_min": round((flag_at - start.floor("min")).total_seconds() / 60) if flag_at is not None else None,
            "warned": int(warn_at is not None),
            "lead_min": round(lead) if lead is not None else None,
            "max_cpu_rate": round(float(w.cpu_rate.max()), 2),
            "max_mem_mb": round(float(w.memory_max_mb.max())),
            "max_lat_ms": round(float(w.latency_ms.max())),
        })
    table = pd.DataFrame(rows)
    table.attrs["starts"] = starts        # full start times, row by row; the printed "start" column has no year
    return table, covered


def episodes(index):
    """Number of runs of consecutive minutes in index (a gap of more than one minute starts a new run)."""
    if len(index) == 0:
        return 0
    return 1 + int((pd.Series(index).diff().dt.total_seconds().dropna() > 60).sum())


def early_warning_stats(table, df, covered):
    """The early-warning numbers that print_early_warning shows, as one dict (also used by --save)."""
    ramps = table[table["shape"] == "ramp"] if "shape" in table else table.iloc[0:0]
    warned = ramps[ramps.warned == 1] if not ramps.empty else ramps
    before = ramps[ramps.lead_min.notna() & (ramps.lead_min > 0)] if not ramps.empty else ramps
    late = ramps[ramps.lead_min.notna() & (ramps.lead_min <= 0)] if not ramps.empty else ramps
    outside = df[(df.early_warning == 1) & ~covered]
    return {"ramps": ramps, "warned": warned, "before": before, "late": late, "outside": outside}


def print_early_warning(table, df, covered):
    print("\nEarly warning (trend check)")
    stats = early_warning_stats(table, df, covered)
    ramps = stats["ramps"]
    if ramps.empty:
        print("  No ramp injections in that period, so there is no lead time to measure yet.")
    else:
        warned, before = stats["warned"], stats["before"]
        flagged = ramps[ramps.flagged_min > 0]
        print(f"  Ramp injections: {len(ramps)} | flagged by the model: {len(flagged)} | warned by the trend check: {len(warned)}")
        print(f"  Warned before the model flagged them: {len(before)}")
        if len(before):
            print(f"  Lead time over the model's first flag (minutes): median {before.lead_min.median():.0f}, "
                  f"min {before.lead_min.min():.0f}, max {before.lead_min.max():.0f}")
        late = stats["late"]
        if len(late):
            print(f"  Warned at the same minute as the first flag or later: {len(late)}")
    outside = stats["outside"]
    n_out = int(len(outside))
    print(f"  Early-warning minutes: {int((df.early_warning == 1).sum())} | outside every injection (false): {n_out}"
          f" in {episodes(outside.index)} episode(s)")


def utc_now():
    return datetime.now(timezone.utc)


def iso_z(ts):
    """UTC time as ISO text with a Z, for example 2026-11-11T04:30:00Z."""
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def number(value):
    """value as a float, or None when it is missing or not finite (the field is then left out)."""
    if value is None or pd.isna(value):
        return None
    value = float(value)
    return None if value in (float("inf"), float("-inf")) else value


def clean(fields):
    return {k: v for k, v in fields.items() if v is not None}


def build_points(run_id, run_time, df, table, covered, excluded):
    """The points that --save writes, built from the numbers the report already computed.

    Three measurements in database prometheus, each point tagged run_id (the UTC time of the run):
      evaluation_run    one point at the run time with the headline figures
      evaluation_fault  one point per fault type (extra tag fault)
      evaluation_day    one point per UTC day at 00:00 of that day (extra tag day)
    Rates are fractions from 0 to 1 (0.015 means 1.5 percent), not percent. Counts are written as
    integers, scores and rates as floats, so a field keeps one type across runs. A figure that cannot
    be computed (for example a rate with no normal minutes) is left out, never filled in.
    """
    flag = df.is_anomaly == 1
    normal = df[~covered]
    n = len(normal)
    false_alarms = int((flag & ~covered).sum())
    injections = len(table)
    detected = int((table.flagged_min > 0).sum()) if injections else 0
    stats = early_warning_stats(table, df, covered)
    before = stats["before"]
    top = number(normal.score.max()) if n else None
    thresholds = df.threshold.dropna()
    threshold = number(thresholds.iloc[-1]) if len(thresholds) else None
    models = df.model.dropna()
    run = {
        "since": iso_z(df.index.min()),
        "until": iso_z(df.index.max()),
        "scored_minutes": len(df),
        "injections": injections,
        "detected": detected,
        "detection_rate": number(detected / injections) if injections else None,
        "flagged_minutes": int(flag.sum()),
        "normal_minutes": n,
        "false_alarms": false_alarms,
        "false_alarm_rate": number(false_alarms / n) if n else None,
        "top_normal_score": top,
        "p99_normal_score": number(normal.score.quantile(0.99)) if n else None,
        "threshold": threshold,
        "margin": number(threshold - top) if threshold is not None and top is not None else None,
        "ramp_injections": len(stats["ramps"]),
        "warned_before_flag": len(before),
        "lead_median_min": number(before.lead_min.median()) if len(before) else None,
        "lead_max_min": number(before.lead_min.max()) if len(before) else None,
        "false_ew_minutes": len(stats["outside"]),
        "excluded": len(excluded),
        "model": str(models.iloc[-1]) if len(models) else None,
    }
    points = [{"measurement": "evaluation_run", "tags": {"run_id": run_id}, "time": run_time, "fields": clean(run)}]

    starts = table.attrs.get("starts", [])
    if injections:
        for kind, group in table.groupby("kind"):
            hit = group.flagged_min > 0
            missed = group[~hit]
            example = ""
            if len(missed):
                worst = missed.sort_values("max_score").iloc[0]
                example = f"{iso_z(starts[worst.name])}, peak score {worst.max_score:.3f}"
            fault = {
                "injections": len(group),
                "detected": int(hit.sum()),
                "detection_rate": number(hit.sum() / len(group)),
                "median_peak_score": number(group.max_score.median()),
                "missed": len(missed),
                "missed_example": example,
            }
            points.append({"measurement": "evaluation_fault", "tags": {"run_id": run_id, "fault": str(kind)},
                           "time": run_time, "fields": clean(fault)})

    injection_days = pd.Series([pd.Timestamp(s).strftime("%Y-%m-%d") for s in starts], dtype=object).value_counts()
    for day, part in df.groupby(df.index.strftime("%Y-%m-%d")):
        part_normal = ~covered.loc[part.index]
        part_false = int(((part.is_anomaly == 1) & part_normal).sum())
        n_normal = int(part_normal.sum())
        fields = {
            "scored_minutes": len(part),
            "normal_minutes": n_normal,
            "false_alarms": part_false,
            "false_alarm_rate": number(part_false / n_normal) if n_normal else None,
            "flagged_minutes": int((part.is_anomaly == 1).sum()),
            "injections": int(injection_days.get(day, 0)),
        }
        points.append({"measurement": "evaluation_day", "tags": {"run_id": run_id, "day": day},
                       "time": pd.Timestamp(day, tz="UTC").to_pydatetime(), "fields": clean(fields)})
    return points


def save_report(client, run_time, df, table, covered, excluded):
    """Writes the report to InfluxDB and returns the run id."""
    run_id = iso_z(run_time)
    client.write_points(build_points(run_id, run_time, df, table, covered, excluded))
    return run_id


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--since", help="only use scores and injections from this UTC time, e.g. 2026-10-06T07:00:00Z")
    parser.add_argument("--table", action="store_true", help="print one line per injection")
    parser.add_argument("--csv", action="store_true", help="save the per-injection table as detection_report_<date>.csv")
    parser.add_argument("--exclude", nargs=2, action="append", metavar=("START", "END"), default=[],
                        help="leave this UTC period out of the report (repeatable)")
    parser.add_argument("--save", action="store_true",
                        help="after the report, write the results to InfluxDB (evaluation_run, evaluation_fault, evaluation_day) for the dashboard")
    parser.add_argument("--host", default="localhost")
    args = parser.parse_args(argv)

    client = InfluxDBClient(host=args.host, port=8086, database="prometheus")
    df = load_scores(client, args.since)
    with open(GROUND_TRUTH_LOG) as f:
        records = [json.loads(line) for line in f if line.strip()]

    excluded = [(pd.Timestamp(a, tz="UTC") if pd.Timestamp(a).tzinfo is None else pd.Timestamp(a),
                 pd.Timestamp(b, tz="UTC") if pd.Timestamp(b).tzinfo is None else pd.Timestamp(b)) for a, b in args.exclude]
    for a, b in excluded:
        df = df[(df.index < a) | (df.index > b)]
    table, covered = analyse(df, records, excluded)
    flag = df.is_anomaly == 1
    normal = df[~covered]
    false_alarms = int((flag & ~covered).sum())

    print(f"Scored minutes: {len(df)} ({df.index.min():%m-%d %H:%M} to {df.index.max():%m-%d %H:%M} UTC)"
          f" | restart warm-up minutes never flagged: {int((df.warmup == 1).sum())}")
    for a, b in excluded:
        print(f"Excluded period: {a:%m-%d %H:%M} to {b:%m-%d %H:%M} UTC")
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
        print_early_warning(table, df, covered)
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

    if args.save:
        run_id = save_report(client, utc_now().replace(microsecond=0), df, table, covered, excluded)
        print(f"Saved run {run_id}")


if __name__ == "__main__":
    main()
