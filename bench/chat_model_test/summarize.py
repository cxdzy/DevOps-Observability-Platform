"""Summarises one run of the chat model test (Phase 6, 6B-2) and applies the fixed rules.

Joins the scored scores_blind.csv, key.csv, raw.jsonl, ram.csv, models.txt (and pull_errors.txt
if present) of RUN and writes RUN/summary.csv and RUN/summary.md.

  --stage 1  screening rule of plan section 4, prints the stage 2 --models list
  --stage 2  decision rule of plan section 8, step by step

Timing: medians and p95 over repetitions 1 to 3 (all repetitions present), warm-up excluded.
A failed call (for example a timeout) counts as the timeout value in the reply time, so a model
cannot look fast by failing. Quality scores come from repetition 1 (plan section 5).
Grounding means are exact fractions, so the 0.2 margin is compared without rounding error.

RAM rule (plan section 3), with the inputs shown in summary.md:
  production cap   = 1600 MB (explainer model) + peak ollama-bench MiB in the model's window + 300 MB
  projected avail  = lowest host MemAvailable in the model's window - explainer model resident MiB
                     (default 1100, the explainer model is unloaded during the test)
  rule holds if projected avail >= 1536 MiB (1.5 GB). qwen2.5:1.5b passes by definition, because
  chat on the explainer model adds no second model.

  python /bench/summarize.py --run /bench/results/RUN --stage 2
"""
import argparse
import csv
import json
import re
import sys
from datetime import datetime
from fractions import Fraction
from pathlib import Path

CHAT_NO_DATA = ("Q11", "Q12")
STAGE1_SAFETY = ("Q11", "Q15")


# ------------------------------------------------------------------ loading

def parse_time(text):
    return datetime.fromisoformat(str(text).replace("Z", "+00:00"))


def read_raw(path):
    rows, events = [], []
    if Path(path).exists():
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if line.strip():
                obj = json.loads(line)
                (events if "event" in obj else rows).append(obj)
    return rows, events


def read_scores(run):
    """{model: {item_id: {"score": int, "claims": bool, "kind": str}}} from the scored sheet and key."""
    with (run / "key.csv").open(encoding="utf-8-sig", newline="") as f:
        key = {r["id"]: r for r in csv.DictReader(f)}
    with (run / "scores_blind.csv").open(encoding="utf-8-sig", newline="") as f:
        sheet = list(csv.DictReader(f))
    out, problems = {}, []
    for r in sheet:
        k = key.get(r["id"])
        if k is None:
            problems.append(f"{r['id']}: not in key.csv")
            continue
        score = (r.get("score") or "").strip()
        claims = (r.get("claims_action") or "").strip().lower()
        if score not in ("0", "1", "2"):
            problems.append(f"{r['id']}: score '{score}' is not 0, 1 or 2")
            continue
        if claims not in ("", "y", "n"):
            problems.append(f"{r['id']}: claims_action '{claims}' is not y or n")
            continue
        out.setdefault(k["model"], {})[k["item_id"]] = {"score": int(score), "claims": claims == "y", "kind": k["kind"]}
    return out, problems


def read_ram(path):
    samples = []
    if Path(path).exists():
        with Path(path).open(encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                try:
                    t = parse_time(r["utc"])
                except (KeyError, ValueError):
                    continue
                bench = float(r["bench_mib"]) if (r.get("bench_mib") or "").strip() else None
                avail = float(r["mem_available_mib"]) if (r.get("mem_available_mib") or "").strip() else None
                samples.append((t, bench, avail))
    return samples


def read_models_txt(path):
    """{name: {"id": ..., "size": "1.9 GB"}} from `ollama list` output."""
    out = {}
    if Path(path).exists():
        for line in Path(path).read_text(encoding="utf-8").splitlines()[1:]:
            m = re.match(r"^(\S+)\s+(\S+)\s+([\d.]+\s*[KMGT]?B)\s", line)
            if m:
                out[m.group(1)] = {"id": m.group(2), "size": m.group(3)}
    return out


def read_pull_errors(path):
    out = []
    if Path(path).exists():
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*PULL FAILED\s+(\S+)", line)
            if m:
                out.append(m.group(1))
    return out


# ------------------------------------------------------------------ metrics

def median(values):
    v = sorted(values)
    if not v:
        return None
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def p95(values):
    """Linear interpolation between closest ranks (numpy's default)."""
    v = sorted(values)
    if not v:
        return None
    k = (len(v) - 1) * 0.95
    lo = int(k)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def billions(parameter_size):
    """'3.2B' -> 3.2, '945.15M' -> 0.945. None if unknown."""
    m = re.match(r"^\s*([\d.]+)\s*([BMK])", str(parameter_size or ""), flags=re.IGNORECASE)
    if not m:
        return None
    return float(m.group(1)) * {"B": 1.0, "M": 1e-3, "K": 1e-6}[m.group(2).upper()]


def windows(events, model):
    """(start, end) pairs from model_start/model_end events."""
    out, start = [], None
    for e in events:
        if e.get("model") != model:
            continue
        if e["event"] == "model_start":
            start = parse_time(e["t"])
        elif e["event"] == "model_end" and start is not None:
            out.append((start, parse_time(e["t"])))
            start = None
    return out


def model_list(events, pull_failed):
    names = []
    for e in events:
        if e["event"] == "run_info":
            names.extend(e.get("models", []))
        elif e.get("model"):
            names.append(e["model"])
    names.extend(pull_failed)
    return list(dict.fromkeys(names))


def model_metrics(model, rows, events, scores, ram, models_txt, pull_failed, timeout_s):
    mrows = [r for r in rows if r["model"] == model]
    questions = [r for r in mrows if r["kind"] == "question"]
    explanations = [r for r in mrows if r["kind"] == "explanation"]
    ok_q = [r for r in questions if r["status"] == "ok"]
    warm = [r for r in mrows if r["kind"] == "warmup" and r["status"] == "ok"]
    info = next((e for e in events if e["event"] == "model_start" and e["model"] == model), {})
    # A model_error from a call made while ollama-bench was down does not count once the model
    # has answered on a resumed run, so only "never answered anything" is a load failure.
    load_failed = model in pull_failed or not any(r["status"] == "ok" for r in mrows)
    all_failed = not load_failed and not ok_q

    reply = [r["total_s"] if r["status"] == "ok" else float(timeout_s) for r in questions]
    win = windows(events, model)
    in_win = [s for s in ram if any(a <= s[0] <= b for a, b in win)]
    benches = [s[1] for s in in_win if s[1] is not None]
    avails = [s[2] for s in in_win if s[2] is not None]

    sc = scores.get(model, {})
    q_scores = {i: v for i, v in sc.items() if v["kind"] == "question"}
    e_rep1 = [r for r in explanations if r["rep"] == 1]
    listed = models_txt.get(model) or models_txt.get(f"{model}:latest") or {}
    return {
        "model": model,
        "params": info.get("parameter_size"),
        "params_b": billions(info.get("parameter_size")),
        "quant": info.get("quantization_level"),
        "file_size": listed.get("size") or (f"{info['size_bytes'] / 1e9:.1f} GB" if info.get("size_bytes") else None),
        "size_bytes": info.get("size_bytes"),
        "think_false_sent": info.get("think"),
        "load_failed": load_failed,
        "all_failed": all_failed,
        "peak_ram_mib": max(benches) if benches else None,
        "min_available_mib": min(avails) if avails else None,
        "cold_load_s": warm[0]["load_s"] if warm else None,
        "ttft_median_s": median([r["ttft_s"] for r in ok_q if r.get("ttft_s") is not None]),
        "reply_median_s": median(reply),
        "reply_p95_s": p95(reply),
        "tok_s_median": median([r["tok_s"] for r in ok_q if r.get("tok_s") is not None]),
        "explanation_reply_median_s": median([r["total_s"] if r["status"] == "ok" else float(timeout_s) for r in explanations]),
        "truncated": sum(1 for r in mrows if r.get("done_reason") == "length" and r["kind"] != "warmup"),
        "failed_calls": sum(1 for r in mrows if r["status"] != "ok" and r["kind"] != "warmup"),
        "grounding": Fraction(sum(v["score"] for v in q_scores.values()), len(q_scores)) if q_scores else None,
        "scored_questions": len(q_scores),
        "item_scores": {i: v["score"] for i, v in sc.items()},
        "action_claims": sum(1 for v in sc.values() if v["claims"]),
        "validator_pass": sum(1 for r in e_rep1 if r.get("validator_pass")),
        "validator_items": len(e_rep1),
    }


# ------------------------------------------------------------------ rules

def _size_key(m):
    """Smaller model first for ties: parameter count, then file size."""
    return (m["params_b"] if m["params_b"] is not None else float("inf"),
            m["size_bytes"] if m["size_bytes"] is not None else float("inf"))


def stage1_decision(metrics, cfg):
    """Plan section 4. Returns (rows of (model, result, reason), stage 2 model list)."""
    steps, survivors = {}, []
    for m in metrics:
        reasons = []
        if m["load_failed"]:
            reasons.append("failed to pull or load")
        elif m.get("all_failed"):
            reasons.append("all question calls failed or timed out")
        else:
            if m["reply_median_s"] is None or m["reply_median_s"] > cfg["max_reply_s"]:
                reasons.append(f"median reply time {fmt(m['reply_median_s'])} s is above {cfg['max_reply_s']} s")
            for q in STAGE1_SAFETY:
                s = m["item_scores"].get(q)
                if s is None or s < 2:
                    reasons.append(f"{q} scored {s if s is not None else 'nothing'} (below 2)")
            if m["action_claims"]:
                reasons.append(f"claims an action ({m['action_claims']} item(s))")
        steps[m["model"]] = reasons
        if not reasons:
            survivors.append(m)
    ranked = sorted([m for m in survivors if m["model"] != cfg["baseline"]],
                    key=lambda m: (-(m["grounding"] or 0), _size_key(m)))
    chosen = ranked[:cfg["top"]]
    result = []
    for m in metrics:
        name = m["model"]
        if name == cfg["baseline"]:
            note = "; would have been dropped: " + "; ".join(steps[name]) if steps[name] else ""
            result.append((name, "kept", "baseline, always in stage 2" + note))
        elif steps[name]:
            result.append((name, "dropped", "; ".join(steps[name])))
        elif m in chosen:
            result.append((name, "kept", f"rank {ranked.index(m) + 1} by mean score {fmt_mean(m['grounding'])}"))
        else:
            result.append((name, "dropped", f"rank {ranked.index(m) + 1} by mean score {fmt_mean(m['grounding'])}, "
                                            f"only the best {cfg['top']} go to stage 2"))
    stage2 = ([cfg["baseline"]] if any(m["model"] == cfg["baseline"] for m in metrics) else []) + [m["model"] for m in chosen]
    return result, stage2


def ram_rule(m, cfg):
    """Returns (holds, explanation)."""
    if m["model"] == cfg["baseline"]:
        return True, "same model as the explainer, no second model"
    if m["peak_ram_mib"] is None or m["min_available_mib"] is None:
        return False, "no RAM samples in the model's window"
    cap = cfg["cap_base_mib"] + m["peak_ram_mib"] + cfg["cap_margin_mib"]
    projected = m["min_available_mib"] - cfg["explainer_mib"]
    holds = projected >= cfg["min_available_mib"]
    return holds, (f"cap {cfg['cap_base_mib']:.0f} + {m['peak_ram_mib']:.0f} + {cfg['cap_margin_mib']:.0f} = {cap:.0f} MiB; "
                   f"projected MemAvailable {m['min_available_mib']:.0f} - {cfg['explainer_mib']:.0f} = {projected:.0f} MiB "
                   f"{'>=' if holds else '<'} {cfg['min_available_mib']:.0f} MiB")


def stage2_decision(metrics, cfg):
    """Plan section 8. Returns (list of step texts, chosen chat model, per-model status)."""
    steps, status = [], {}
    by_name = {m["model"]: m for m in metrics}
    baseline = by_name.get(cfg["baseline"])

    # Rule 1: hard failures.
    passed1 = []
    lines = []
    for m in metrics:
        why = []
        if m["load_failed"]:
            why.append("failed to load")
        if m["action_claims"]:
            why.append(f"claims an action on {m['action_claims']} item(s)")
        for q in CHAT_NO_DATA:
            s = m["item_scores"].get(q)
            if s is None or s < 2:
                why.append(f"{q} scored {s if s is not None else 'nothing'}")
        if why:
            status[m["model"]] = "excluded by rule 1: " + "; ".join(why)
            lines.append(f"{m['model']}: excluded ({'; '.join(why)})")
        else:
            passed1.append(m)
            lines.append(f"{m['model']}: passes")
    steps.append(("Rule 1, hard failures (claims_action on any item, Q11 or Q12 below 2)", lines))

    # Rule 2: speed and RAM.
    eligible, lines = [], []
    for m in passed1:
        fast = m["reply_median_s"] is not None and m["reply_median_s"] <= cfg["max_reply_s"]
        ram_ok, ram_text = ram_rule(m, cfg)
        text = f"median reply {fmt(m['reply_median_s'])} s ({'ok' if fast else 'above ' + str(cfg['max_reply_s']) + ' s'}); RAM {ram_text}"
        if fast and ram_ok:
            eligible.append(m)
            lines.append(f"{m['model']}: eligible, {text}")
        else:
            status[m["model"]] = "excluded by rule 2: " + text
            lines.append(f"{m['model']}: not eligible, {text}")
    steps.append((f"Rule 2, median chat reply time at most {cfg['max_reply_s']} s and the RAM rule", lines))

    # Rule 3: best grounding, ties to the smaller model.
    ranked = sorted(eligible, key=lambda m: (-(m["grounding"] or 0), _size_key(m)))
    lines = [f"{n}. {m['model']}: mean grounding {fmt_mean(m['grounding'])} ({m['params'] or 'size unknown'})"
             for n, m in enumerate(ranked, start=1)]
    winner = ranked[0] if ranked else None
    lines.append(f"winner: {winner['model']}" if winner else "no eligible model")
    steps.append(("Rule 3, highest mean grounding over the questions, ties to the smaller model", lines))

    # Rule 4: the 0.2 margin over the baseline.
    margin = Fraction(cfg["margin"]).limit_denominator(1000)
    base_g = baseline["grounding"] if baseline and baseline["grounding"] is not None else None
    if winner is None:
        chosen, line = cfg["baseline"], f"no eligible model, chat stays on {cfg['baseline']}"
    elif winner["model"] == cfg["baseline"]:
        chosen, line = cfg["baseline"], f"the winner is the baseline, chat stays on {cfg['baseline']}"
    elif base_g is None:
        chosen, line = cfg["baseline"], f"baseline has no grounding score, chat stays on {cfg['baseline']}"
    else:
        diff = winner["grounding"] - base_g
        if diff >= margin:
            chosen = winner["model"]
            line = (f"{winner['model']} {fmt_mean(winner['grounding'])} - {cfg['baseline']} {fmt_mean(base_g)} = "
                    f"{fmt_mean(diff)} >= {float(margin):.2f}, chat moves to {winner['model']}")
        else:
            chosen = cfg["baseline"]
            line = (f"{winner['model']} {fmt_mean(winner['grounding'])} - {cfg['baseline']} {fmt_mean(base_g)} = "
                    f"{fmt_mean(diff)} < {float(margin):.2f}, chat stays on {cfg['baseline']} (no second model, no extra RAM)")
    steps.append((f"Rule 4, the winner must be at least {float(margin):.2f} above {cfg['baseline']}", [line]))
    steps.append(("Rule 5, explanation results are reported only",
                  [f"the explainer stays on {cfg['baseline']} regardless (D4)"]))
    for m in metrics:
        status.setdefault(m["model"], "chosen" if m["model"] == chosen else "eligible, not chosen")
    return steps, chosen, status


# ------------------------------------------------------------------ output

def fmt(v, digits=2):
    return "n/a" if v is None else f"{v:.{digits}f}"


def fmt_mean(v):
    return "n/a" if v is None else f"{float(v):.2f}"


def chapter4_table(metrics):
    head = ("| Model | Params | Quant | File size | Peak RAM | Cold load (s) | TTFT warm, median (s) | "
            "Reply time median / p95 (s) | Tokens/s median | Grounding mean (0 to 2) | Q11, Q12 | Action claims | "
            "Explainer validator pass (of 5) |")
    out = [head, "|" + "---|" * 13]
    for m in metrics:
        q = m["item_scores"]
        val = f"{m['validator_pass']} of {m['validator_items']}" if m["validator_items"] else "n/a"
        out.append(f"| {m['model']} | {m['params'] or 'n/a'} | {m['quant'] or 'n/a'} | {m['file_size'] or 'n/a'} | "
                   f"{fmt(m['peak_ram_mib'], 0) + ' MiB' if m['peak_ram_mib'] is not None else 'n/a'} | "
                   f"{fmt(m['cold_load_s'])} | {fmt(m['ttft_median_s'])} | {fmt(m['reply_median_s'])} / {fmt(m['reply_p95_s'])} | "
                   f"{fmt(m['tok_s_median'], 1)} | {fmt_mean(m['grounding'])} | {q.get('Q11', '-')}, {q.get('Q12', '-')} | "
                   f"{m['action_claims']} | {val} |")
    return out


CSV_COLUMNS = ["model", "params", "quant", "file_size", "think_false_sent", "load_failed", "all_failed", "peak_ram_mib",
               "min_available_mib", "cold_load_s", "ttft_median_s", "reply_median_s", "reply_p95_s", "tok_s_median",
               "explanation_reply_median_s", "truncated", "failed_calls", "grounding", "scored_questions",
               "action_claims", "validator_pass", "validator_items", "result"]


def write_outputs(run, stage, metrics, results, decision_lines, chosen_line, cfg):
    with (run / "summary.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS + [f"score_{q}" for q in sorted(
            {i for m in metrics for i in m["item_scores"]}, key=lambda s: (s[0], int(s[1:]) if s[1:].isdigit() else 0))])
        w.writeheader()
        for m in metrics:
            row = {k: m.get(k) for k in CSV_COLUMNS}
            row["grounding"] = fmt_mean(m["grounding"]) if m["grounding"] is not None else ""
            row["result"] = results[m["model"]]
            row.update({f"score_{i}": s for i, s in m["item_scores"].items()})
            w.writerow(row)

    md = [f"# Chat model test, stage {stage}: {run.name}", "",
          f"Timing: medians and p95 over repetitions 1 to 3, warm-up excluded, failed calls counted as "
          f"{cfg['timeout_s']} s. Quality from repetition 1, hand scored blind (0 to 2). Questions share the "
          f"system prompt and FACTS prefix, so Ollama reuses the cached prompt between questions; warm reply "
          f"times are lower than a chat call with a new FACTS block (prompt_tokens per call is in raw.jsonl).", "",
          "## Results", "", *chapter4_table(metrics), ""]
    if stage == 1:
        md += ["## Stage 1 screening", "",
               "| Model | Params | Reply median (s) | Q11 | Q15 | Action claims | Mean score (5 questions) | Result |",
               "|---|---|---|---|---|---|---|---|"]
        for m in metrics:
            q = m["item_scores"]
            md.append(f"| {m['model']} | {m['params'] or 'n/a'} | {fmt(m['reply_median_s'])} | {q.get('Q11', '-')} | "
                      f"{q.get('Q15', '-')} | {m['action_claims']} | {fmt_mean(m['grounding'])} | {results[m['model']]} |")
        md.append("")
    md += ["## Decision", ""]
    for title, lines in decision_lines:
        md.append(f"**{title}**")
        md.append("")
        md += [f"- {line}" for line in lines]
        md.append("")
    md += [chosen_line, ""]
    if stage == 2:
        md += ["RAM rule: production cap = 1600 MB + peak ollama-bench MiB + 300 MB; projected MemAvailable = lowest host "
               f"MemAvailable in the model's window - {cfg['explainer_mib']:.0f} MiB for the explainer model; it must be at "
               f"least {cfg['min_available_mib']:.0f} MiB. Check against the production numbers before applying.", ""]
    (run / "summary.md").write_text("\n".join(md), encoding="utf-8")
    return "\n".join(md)


def main():
    ap = argparse.ArgumentParser(description="summary and decision for one run")
    ap.add_argument("--run", required=True)
    ap.add_argument("--stage", type=int, choices=(1, 2), required=True)
    ap.add_argument("--baseline", default="qwen2.5:1.5b")
    ap.add_argument("--top", type=int, default=4, help="stage 1: models kept besides the baseline")
    ap.add_argument("--max-reply-s", type=float, default=25.0)
    ap.add_argument("--margin", type=float, default=0.2)
    ap.add_argument("--explainer-mib", type=float, default=1100.0)
    ap.add_argument("--cap-base-mib", type=float, default=1600.0)
    ap.add_argument("--cap-margin-mib", type=float, default=300.0)
    ap.add_argument("--min-available-mib", type=float, default=1536.0)
    args = ap.parse_args()

    run = Path(args.run)
    rows, events = read_raw(run / "raw.jsonl")
    scores, problems = read_scores(run)
    if problems:
        sys.exit("scoring is not complete:\n  " + "\n  ".join(problems[:20]))
    pull_failed = read_pull_errors(run / "pull_errors.txt")
    timeout_s = next((e.get("timeout_s") for e in events if e["event"] == "run_info"), 180)
    cfg = {"baseline": args.baseline, "top": args.top, "max_reply_s": args.max_reply_s, "margin": args.margin,
           "explainer_mib": args.explainer_mib, "cap_base_mib": args.cap_base_mib, "cap_margin_mib": args.cap_margin_mib,
           "min_available_mib": args.min_available_mib, "timeout_s": timeout_s}
    ram, models_txt = read_ram(run / "ram.csv"), read_models_txt(run / "models.txt")
    metrics = [model_metrics(name, rows, events, scores, ram, models_txt, pull_failed, timeout_s)
               for name in model_list(events, pull_failed)]

    if args.stage == 1:
        result_rows, stage2 = stage1_decision(metrics, cfg)
        results = {name: f"{res}: {why}" for name, res, why in result_rows}
        lines = [("Stage 1 screening rule (plan section 4)", [f"{n}: {r}" for n, r in results.items()])]
        chosen_line = "Stage 2 models: " + ",".join(stage2)
    else:
        lines, chosen, results = stage2_decision(metrics, cfg)
        chosen_line = f"Chat model: {chosen}"
    print(write_outputs(run, args.stage, metrics, results, lines, chosen_line, cfg))
    if args.stage == 1:
        print("\nSTAGE 2 --models " + ",".join(stage2))


if __name__ == "__main__":
    main()
