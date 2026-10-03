"""
LLM benchmark, round 2: realistic incident scenarios, one per remediation tier.

Round 1 (benchmark_llm.py) showed which models fit inside the 1.6GB memory cap
and how fast they run. Round 2 tests whether the models that fit can write the
incident explanations the platform actually needs.

In the real system n8n chooses the action from the severity tier and the LLM
only explains it, so each prompt states the tier and the automated action taken.
The fourth scenario adds retrieved past incidents, as the Chroma RAG step will.

An automatic rubric scores each answer. It is a rough keyword proxy for the
"LLM explanation accuracy" metric and does NOT replace reading the answers,
which are written to the results file in full.

Usage:
  python3 benchmark_llm_round2.py
  python3 benchmark_llm_round2.py llama3.2:1b gemma3:1b
  python3 benchmark_llm_round2.py --delete-after

Run inside tmux. The run window is written into the results file so it can be
excluded from anomaly model training data.
"""

import argparse
import re
import time
from datetime import datetime, timezone

import requests

OLLAMA_URL = "http://localhost:11434"
RESULTS_FILE = "llm_benchmark_round2.md"
MEMORY_CAP_MB = 1600

DEFAULT_MODELS = ["llama3.2:1b", "gemma3:1b", "qwen2.5:1.5b", "qwen3:0.6b"]
THINKING_MODELS = ("qwen3", "deepseek-r1")

SYSTEM_PROMPT = (
    "You are an incident assistant for a DevOps platform. You receive structured "
    "incident data and write a short plain-English explanation for a non-expert. "
    "Rules: use at most three sentences. A high anomaly_score means something is "
    "wrong and never means the system is stable. If a deployment finished "
    "recently, name it as the likely cause. State the automated action that was "
    "taken. Plain text only, no markdown, no bullet points."
)

RESTART = r"restart"
ROLLBACK = r"roll(ed|ing)?[ -]?back|revert"
WATCH = r"monitor|watch|observe|keep an eye|check again"

SCENARIOS = [
    {
        "name": "low",
        "prompt": (
            "Incident data:\n"
            "- container: api-gateway\n"
            "- cpu_usage_percent: rose from 35 to 71 over 5 minutes\n"
            "- anomaly_score: 0.68\n"
            "- recent deployment: none\n"
            "- severity tier: low\n"
            "- automated action taken: none, notification only\n\n"
            "Write the incident summary and advice on what to watch."
        ),
        "needs_deployment": False,
        "expected_action": WATCH,
        "needs_past": False,
    },
    {
        "name": "medium",
        "prompt": (
            "Incident data:\n"
            "- container: auth-service\n"
            "- memory_usage_bytes: rose from 120 MB to 270 MB within 90 seconds\n"
            "- anomaly_score: 0.79\n"
            "- recent deployment: finished 4 minutes ago\n"
            "- severity tier: medium\n"
            "- automated action taken: container restarted\n\n"
            "Confirm the restart and explain the most likely root cause."
        ),
        "needs_deployment": True,
        "expected_action": RESTART,
        "needs_past": False,
    },
    {
        "name": "high",
        "prompt": (
            "Incident data:\n"
            "- container: payment-worker\n"
            "- request_latency_ms: rose from 120 to 3100 within 60 seconds\n"
            "- anomaly_score: 0.93\n"
            "- recent deployment: finished 2 minutes ago\n"
            "- severity tier: high\n"
            "- automated action taken: rolled back to the last good image\n\n"
            "Write the rollback report and a recommended fix."
        ),
        "needs_deployment": True,
        "expected_action": ROLLBACK,
        "needs_past": False,
    },
    {
        "name": "medium_rag",
        "prompt": (
            "Incident data:\n"
            "- container: auth-service\n"
            "- memory_usage_bytes: rose from 120 MB to 270 MB within 90 seconds\n"
            "- anomaly_score: 0.79\n"
            "- recent deployment: finished 4 minutes ago\n"
            "- severity tier: medium\n"
            "- automated action taken: container restarted\n\n"
            "Similar past incidents:\n"
            "1. auth-service, memory spike after a deployment, restarted, resolved in 45 seconds.\n"
            "2. payment-worker, latency regression after a deployment, rolled back, resolved in 120 seconds.\n\n"
            "Confirm the restart, explain the most likely root cause, and say how "
            "this compares with the past incidents."
        ),
        "needs_deployment": True,
        "expected_action": RESTART,
        "needs_past": True,
    },
]

DEPLOY = r"deploy|release|rollout|new version|new build"
CONTRADICTION = (
    r"\b(system|service|container|issue|problem) (is|appears|seems)( to be)? "
    r"(stable|healthy|fine|resolved)\b|\b(likely|already) (resolved|fixed)\b"
)
PAST = r"previous|past|earlier|similar|before|compar"


def wait_for_ollama(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if requests.get(f"{OLLAMA_URL}/api/tags", timeout=5).status_code == 200:
                return True
        except requests.RequestException:
            pass
        time.sleep(3)
    return False


def installed_models():
    r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=10)
    r.raise_for_status()
    return {m["name"] for m in r.json().get("models", [])}


def pull(model):
    print(f"  Pulling {model} (download happens once)...")
    r = requests.post(
        f"{OLLAMA_URL}/api/pull",
        json={"model": model, "stream": False},
        timeout=1800,
    )
    r.raise_for_status()


def loaded_size_mb():
    try:
        r = requests.get(f"{OLLAMA_URL}/api/ps", timeout=10)
        models = r.json().get("models", [])
        if models:
            return round(models[0]["size"] / 1024 / 1024)
    except (requests.RequestException, ValueError, KeyError):
        pass
    return None


def unload(model):
    try:
        requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": model, "keep_alive": 0},
            timeout=30,
        )
    except requests.RequestException:
        pass


def delete(model):
    try:
        requests.delete(
            f"{OLLAMA_URL}/api/delete",
            json={"model": model, "name": model},
            timeout=30,
        )
    except requests.RequestException:
        pass


def strip_thinking(text):
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def check(answer, scenario):
    """Keyword rubric. Each value is True, False, or None when not applicable."""
    text = answer.lower()
    has_markdown = bool(re.search(r"\*\*|^#|^\s*[-*] |`", answer, re.MULTILINE))
    return {
        "deployment": bool(re.search(DEPLOY, text)) if scenario["needs_deployment"] else None,
        "action": bool(re.search(scenario["expected_action"], text)),
        "format": (not has_markdown) and len(answer.split()) <= 100,
        "no_contradiction": not re.search(CONTRADICTION, text),
        "past": bool(re.search(PAST, text)) if scenario["needs_past"] else None,
    }


def score(checks):
    applicable = [v for v in checks.values() if v is not None]
    return sum(applicable), len(applicable)


def run_scenario(model, scenario):
    payload = {
        "model": model,
        "system": SYSTEM_PROMPT,
        "prompt": scenario["prompt"],
        "stream": False,
        "keep_alive": "1m",
        "options": {"num_ctx": 2048, "num_predict": 256, "temperature": 0.2},
    }
    if model.startswith(THINKING_MODELS):
        payload["think"] = False

    started = time.time()
    try:
        r = requests.post(f"{OLLAMA_URL}/api/generate", json=payload, timeout=900)
        r.raise_for_status()
    except requests.RequestException as e:
        return {"scenario": scenario["name"], "status": f"FAILED ({type(e).__name__})"}

    wall_s = time.time() - started
    data = r.json()
    eval_count = data.get("eval_count", 0)
    eval_s = data.get("eval_duration", 0) / 1e9
    answer = strip_thinking(data.get("response", ""))
    checks = check(answer, scenario)

    return {
        "scenario": scenario["name"],
        "status": "ok",
        "tokens_per_sec": round(eval_count / eval_s, 1) if eval_s > 0 else 0,
        "wall_s": round(wall_s, 1),
        "ram_mb": loaded_size_mb(),
        "truncated": data.get("done_reason") == "length",
        "answer": answer,
        "checks": checks,
    }


def mark(value):
    if value is None:
        return "n/a"
    return "pass" if value else "FAIL"


def write_report(all_results, started_at, finished_at):
    lines = [
        "# LLM Benchmark Results, Round 2",
        "",
        f"Run window (UTC): {started_at} to {finished_at}",
        "Exclude this window from anomaly model training data: CPU was heavily loaded by inference.",
        "",
        "The rubric is a keyword proxy and can mis-score. Read the answers below before trusting it.",
        "",
        "## Summary",
        "",
        f"| Model | Rubric score | Avg tokens/sec | Avg time per answer (s) | Peak RAM (MB) | Headroom under {MEMORY_CAP_MB} MB cap |",
        "|---|---|---|---|---|---|",
    ]

    for model, runs in all_results.items():
        ok = [r for r in runs if r["status"] == "ok"]
        if not ok:
            lines.append(f"| {model} | FAILED | | | | |")
            continue
        passed = total = 0
        for r in ok:
            p, t = score(r["checks"])
            passed += p
            total += t
        rams = [r["ram_mb"] for r in ok if r["ram_mb"]]
        peak = max(rams) if rams else None
        lines.append(
            f"| {model} | {passed}/{total} | "
            f"{round(sum(r['tokens_per_sec'] for r in ok) / len(ok), 1)} | "
            f"{round(sum(r['wall_s'] for r in ok) / len(ok), 1)} | "
            f"{peak if peak else 'n/a'} | {MEMORY_CAP_MB - peak if peak else 'n/a'} |"
        )

    lines += [
        "",
        "## Rubric detail",
        "",
        "| Model | Scenario | Deployment named | Action stated | Plain format | No contradiction | Used past incidents | Truncated | Time (s) |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for model, runs in all_results.items():
        for r in runs:
            if r["status"] != "ok":
                lines.append(f"| {model} | {r['scenario']} | {r['status']} | | | | | | |")
                continue
            c = r["checks"]
            lines.append(
                f"| {model} | {r['scenario']} | {mark(c['deployment'])} | {mark(c['action'])} | "
                f"{mark(c['format'])} | {mark(c['no_contradiction'])} | {mark(c['past'])} | "
                f"{'yes' if r['truncated'] else 'no'} | {r['wall_s']} |"
            )

    lines += ["", "## Answers", ""]
    for scenario in SCENARIOS:
        lines += [f"### Scenario: {scenario['name']}", ""]
        for model, runs in all_results.items():
            for r in runs:
                if r["scenario"] == scenario["name"] and r["status"] == "ok":
                    lines += [f"**{model}**", "", r["answer"] or "(empty answer)", ""]

    with open(RESULTS_FILE, "w") as f:
        f.write("\n".join(lines))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("models", nargs="*", default=DEFAULT_MODELS)
    parser.add_argument("--delete-after", action="store_true")
    args = parser.parse_args()

    if not wait_for_ollama(60):
        raise SystemExit("Ollama is not reachable on localhost:11434. Is the container running?")

    started_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    all_results = {}

    for model in args.models:
        print(f"\n=== {model} ===")
        try:
            if model not in installed_models():
                pull(model)
        except requests.RequestException as e:
            print(f"  Could not pull {model}: {e}")
            all_results[model] = [{"scenario": "all", "status": f"FAILED to pull ({type(e).__name__})"}]
            continue

        runs = []
        for scenario in SCENARIOS:
            result = run_scenario(model, scenario)
            runs.append(result)
            if result["status"] == "ok":
                p, t = score(result["checks"])
                print(f"  {scenario['name']}: {p}/{t} rubric, {result['tokens_per_sec']} tok/s, "
                      f"{result['wall_s']}s, {result['ram_mb']} MB")
            else:
                print(f"  {scenario['name']}: {result['status']}")
                print("  Waiting for Ollama to come back, skipping remaining scenarios...")
                wait_for_ollama(180)
                break

        all_results[model] = runs
        unload(model)
        if args.delete_after:
            delete(model)

    finished_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    write_report(all_results, started_at, finished_at)
    print(f"\nDone. Results written to {RESULTS_FILE}")


if __name__ == "__main__":
    main()
