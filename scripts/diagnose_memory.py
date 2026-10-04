"""
Memory diagnosis: why are memory-leak injections detected less often than
CPU and latency spikes?

Read-only. Uses the raw 15-second memory readings of the sample service, the
ground truth log and the feature engineering of train_anomaly_model.py.

It answers four questions
  1. How much does memory (RSS) really rise during a memory-leak injection?
  2. How long does it stay elevated afterwards?
  3. Can memory alone separate leak minutes from normal minutes? (the share of
     leak minutes above the 99th percentile of normal minutes)
  4. How do full-coverage and partial-coverage minutes differ?

Outputs: memory_diagnosis.png, memory_diagnosis.csv (one row per injection),
and a printed summary.

Run: python3 diagnose_memory.py 2>&1 | tee diagnose_output.txt
"""

import os

import numpy as np
import pandas as pd

import train_anomaly_model as t

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PNG_PATH = os.path.join(SCRIPT_DIR, "memory_diagnosis.png")
CSV_PATH = os.path.join(SCRIPT_DIR, "memory_diagnosis.csv")
MIB = 1024 * 1024
RESIDUAL_MINUTES = (1, 3, 5, 10)


def memory_series_mb(raw):
    """Raw RSS in MiB at the scrape resolution (15 s)."""
    s = pd.concat([f["value"] for f in raw["memory"]]).sort_index()
    return s[~s.index.duplicated()] / MIB


def injection_dynamics(rss, records, spans):
    """One row per memory-leak injection: baseline, peak, rise and what is left afterwards."""
    rows = []
    for rec in records:
        if rec["tier"] != "medium" or not rec.get("triggered_successfully"):
            continue
        ws, we = t.injection_span(rec)
        if any(ws < e and we > s for s, e in spans):
            continue  # contaminated by a benchmark or reboot
        before = rss[(rss.index >= ws - pd.Timedelta(minutes=5)) & (rss.index < ws - pd.Timedelta(seconds=30))]
        window = rss[(rss.index >= ws) & (rss.index <= we + pd.Timedelta(seconds=30))]
        if len(before) < 8 or window.empty:
            continue
        baseline = float(before.median())
        row = {"start": ws, "baseline_mb": baseline, "peak_mb": float(window.max())}
        row["rise_mb"] = row["peak_mb"] - baseline
        for m in RESIDUAL_MINUTES:
            at = we + pd.Timedelta(minutes=m)
            after = rss[(rss.index >= at) & (rss.index < at + pd.Timedelta(seconds=30))]
            row[f"residual_{m}min_mb"] = float(after.iloc[0]) - baseline if len(after) else np.nan
        rows.append(row)
    return pd.DataFrame(rows)


def separability(features, tiers, cover):
    """Could a single memory threshold, set at the 99th percentile of normal minutes,
    find the leak minutes? Reported separately for mostly-covered and partly-covered minutes."""
    normal = tiers.isna().to_numpy()
    medium = (tiers == "medium").to_numpy()
    full = medium & (cover >= t.FULL_COVER_S)
    partial = medium & (cover < t.FULL_COVER_S)
    rows = []
    for col in ("memory_mb", "memory_max_mb"):
        v = features[col].to_numpy()
        thr = float(np.percentile(v[normal], 99))
        rows.append({
            "feature": col,
            "normal_median": float(np.median(v[normal])),
            "normal_p99": thr,
            "full_median": float(np.median(v[full])) if full.any() else np.nan,
            "partial_median": float(np.median(v[partial])) if partial.any() else np.nan,
            "full_above_p99": float((v[full] > thr).mean()) if full.any() else np.nan,
            "partial_above_p99": float((v[partial] > thr).mean()) if partial.any() else np.nan,
            "n_full": int(full.sum()),
            "n_partial": int(partial.sum()),
        })
    return pd.DataFrame(rows)


def make_plot(rss, dyn, features, tiers, cover, path):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib is not installed, skipping the plot")
        return False

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

    traces = []
    for _, r in dyn.iterrows():
        s = r["start"]
        seg = rss[(rss.index >= s - pd.Timedelta(minutes=5)) & (rss.index <= s + pd.Timedelta(minutes=15))]
        x = np.round(((seg.index - s).total_seconds() / 60) * 4) / 4   # 15 s grid, in minutes
        y = seg.to_numpy() - r["baseline_mb"]
        ax1.plot(x, y, color="0.75", lw=0.7)
        traces.append(pd.Series(y, index=x))
    if traces:
        median = pd.concat([tr[~tr.index.duplicated()] for tr in traces], axis=1).median(axis=1).sort_index()
        ax1.plot(median.index, median.values, color="C3", lw=2, label="median")
    ax1.axvspan(0, 1.5, color="C1", alpha=0.15, label="injection (90 s)")
    ax1.axhline(0, color="k", lw=0.5)
    ax1.set_xlabel("minutes from injection start")
    ax1.set_ylabel("memory change vs baseline (MiB)")
    ax1.set_title(f"Memory around {len(dyn)} memory-leak injections")
    ax1.legend()

    normal = tiers.isna().to_numpy()
    medium = (tiers == "medium").to_numpy()
    groups = [features["memory_max_mb"][normal],
              features["memory_max_mb"][medium & (cover < t.FULL_COVER_S)],
              features["memory_max_mb"][medium & (cover >= t.FULL_COVER_S)]]
    ax2.boxplot(groups)
    ax2.set_xticklabels([f"normal\n(n={len(groups[0])})", f"leak, partial\n(n={len(groups[1])})",
                         f"leak, mostly covered\n(n={len(groups[2])})"])
    ax2.set_ylabel("per-minute maximum memory (MiB)")
    ax2.set_title("Can memory alone separate leak minutes?")

    fig.savefig(path, dpi=130, bbox_inches="tight")
    return True


def main():
    print("Loading ground truth and metrics...")
    ground_truth = t.load_ground_truth()
    raw = t.fetch_raw()
    rss = memory_series_mb(raw)

    features = t.build_features(raw)
    spans, _ = t.expand_exclusions(t.EXCLUDE_WINDOWS, ground_truth)
    features, _ = t.drop_excluded(features, spans)
    tiers, cover = t.label_rows(features, ground_truth)

    dyn = injection_dynamics(rss, ground_truth, spans)
    print(f"\n1. RAW MEMORY AROUND {len(dyn)} MEMORY-LEAK INJECTIONS (15-second readings, MiB)\n")
    if dyn.empty:
        print("No usable memory-leak injections found.")
        return
    dyn.to_csv(CSV_PATH, index=False)
    summary = dyn.drop(columns="start").describe().loc[["min", "25%", "50%", "75%", "max"]]
    print(summary.to_string(float_format=lambda v: f"{v:7.1f}"))
    print(f"\nBaseline memory before an injection: median {dyn['baseline_mb'].median():.0f} MiB, "
          f"spread between injections {dyn['baseline_mb'].std():.0f} MiB (standard deviation)")
    print(f"Injections where memory rose by at least 100 MiB: {(dyn['rise_mb'] >= 100).mean() * 100:.0f} percent")
    print("Median memory still above baseline after the injection ended: "
          + ", ".join(f"{m} min: {dyn[f'residual_{m}min_mb'].median():.0f} MiB" for m in RESIDUAL_MINUTES))

    sep = separability(features, tiers, cover)
    print("\n2. CAN MEMORY ALONE SEPARATE LEAK MINUTES FROM NORMAL MINUTES?\n")
    print(sep.to_string(index=False, float_format=lambda v: f"{v:.2f}"))
    print("\nfull_above_p99 / partial_above_p99 = share of leak minutes whose memory exceeds the 99th percentile "
          "of normal minutes, i.e. the recall a single memory threshold would reach at about 1 percent false alarms.")

    print("\n3. AUTOMATIC READING (check it against the plot)\n")
    rise = dyn["rise_mb"].median()
    if rise < 100:
        print(f"- Memory rises by a median of only {rise:.0f} MiB, well under the 150 MiB the endpoint allocates. "
              "The injection may not be doing what we assume.")
    else:
        print(f"- Memory rises by a median of {rise:.0f} MiB, so the injection does what it should.")
    res5 = dyn["residual_5min_mb"].median()
    if res5 > 50:
        print(f"- Memory is still {res5:.0f} MiB above baseline 5 minutes after the injection: the service gives "
              "the memory back slowly. Those later minutes look anomalous but are labelled normal.")
    else:
        print(f"- Memory is back near baseline within 5 minutes (median {res5:.0f} MiB above).")
    best = sep[sep.feature == "memory_max_mb"].iloc[0]
    if best["full_above_p99"] >= 0.8:
        print(f"- A single memory threshold finds {best['full_above_p99'] * 100:.0f} percent of mostly-covered leak minutes, "
              "so the signal is clear and the multivariate model is the weak link.")
    else:
        print(f"- A single memory threshold finds only {best['full_above_p99'] * 100:.0f} percent of mostly-covered leak minutes, "
              "so memory itself overlaps with normal behaviour.")

    if make_plot(rss, dyn, features, tiers, cover, PNG_PATH):
        print(f"\nPlot saved to {PNG_PATH}")
    print(f"Per-injection table saved to {CSV_PATH}")


if __name__ == "__main__":
    main()
