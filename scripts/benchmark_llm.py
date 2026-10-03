"""
LLM benchmark for Phase 4 model selection.

Runs the same incident-explanation prompt against several small Ollama models
and records speed (tokens/sec), memory footprint, whether the model spent
tokens on a reasoning block, and the actual answer text, so the answers can be
judged by a human. Results are written to llm_benchmark_results.md.

Usage:
  python3 benchmark_llm.py                      # default candidate list
  python3 benchmark_llm.py qwen3:0.6b llama3.2:1b
  python3 benchmark_llm.py --delete-after       # remove each model after testing (saves disk)

Run it inside tmux. CPU inference on 2 vCPUs can take several minutes per model.
Note: this loads the CPU heavily, so the metrics collected during the run are
not representative baseline data. The start and end times are written into the
results file so that window can be excluded from model training.
"""

import argparse
import re
import time
from datetime import datetime, timezone

import requests

OLLAMA_URL = "http://localhost:11434"
RESULTS_FILE = "llm_benchmark_results.md"

DEFAULT_MODELS = ["qwen3:0.6b", "deepseek-r1:1.5b", "llama3.2:1b", "qwen3:1.7b"]

SYSTEM_PROMPT = (
    "You are an infrastructure assistant. Explain incidents in plain English for "
    "someone who is not an expert. Use at most three sentences, then give exactly "
    "one recommended action. Do not use markdown."
)

INCIDENT_PROMPT = (
    "Incident data: container=auth-service, memory_usage_bytes rose from 120 MB "
    "to 270 MB within 90 seconds, anomaly_score=0.79, a deployment finished 4 "
    "minutes ago. Explain what likely happened and what action should be taken."
)


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
    """Memory the loaded model occupies, as reported by Ollama itself."""
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


def benchmark(model):
    payload = {
        "model": model,
        "system": SYSTEM_PROMPT,
        "prompt": INCIDENT_PROMPT,
        "stream": False,
        "keep_alive": "1m",
        "options": {"num_ctx": 2048, "num_predict": 512, "temperature": 0.2},
    }

    started = time.time()
    try:
        r = requests.post(f"{OLLAMA_URL}/api/generate", json=payload, timeout=900)
        r.raise_for_status()
    except requests.RequestException as e:
        return {
            "model": model,
            "status": f"FAILED ({type(e).__name__}), likely out of memory",
        }

    wall_s = time.time() - started
    data = r.json()
    ram_mb = loaded_size_mb()
    unload(model)

    eval_count = data.get("eval_count", 0)
    eval_s = data.get("eval_duration", 0) / 1e9
    answer_raw = data.get("response", "")

    return {
        "model": model,
        "status": "ok",
        "load_s": round(data.get("load_duration", 0) / 1e9, 1),
        "tokens": eval_count,
        "tokens_per_sec": round(eval_count / eval_s, 1) if eval_s > 0 else 0,
        "wall_s": round(wall_s, 1),
        "ram_mb": ram_mb,
        "reasoning_block": bool(data.get("thinking")) or "<think>" in answer_raw,
        "truncated": data.get("done_reason") == "length",
        "answer": strip_thinking(answer_raw),
    }


def write_report(results, started_at, finished_at):
    lines = [
        "# LLM Benchmark Results",
        "",
        f"Run window (UTC): {started_at} to {finished_at}",
        "Exclude this window from anomaly model training data: CPU was heavily loaded by inference.",
        "",
        "## Speed and memory",
        "",
        "| Model | Status | Load (s) | Tokens | Tokens/sec | Total (s) | RAM (MB) | Reasoning block | Truncated |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        if r["status"] != "ok":
            lines.append(f"| {r['model']} | {r['status']} | | | | | | | |")
            continue
        lines.append(
            f"| {r['model']} | ok | {r['load_s']} | {r['tokens']} | {r['tokens_per_sec']} "
            f"| {r['wall_s']} | {r['ram_mb']} | {'yes' if r['reasoning_block'] else 'no'} "
            f"| {'yes' if r['truncated'] else 'no'} |"
        )

    lines += ["", "## Answers (judge quality yourself)", ""]
    for r in results:
        if r["status"] != "ok":
            continue
        lines += [f"### {r['model']}", "", r["answer"] or "(empty answer)", ""]

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
    results = []

    for model in args.models:
        print(f"\n=== {model} ===")
        try:
            if model not in installed_models():
                pull(model)
        except requests.RequestException as e:
            print(f"  Could not pull {model}: {e}")
            results.append({"model": model, "status": f"FAILED to pull ({type(e).__name__})"})
            continue

        result = benchmark(model)
        results.append(result)

        if result["status"] == "ok":
            print(f"  {result['tokens_per_sec']} tok/s, {result['ram_mb']} MB, "
                  f"{result['wall_s']}s total, reasoning block: {result['reasoning_block']}")
        else:
            print(f"  {result['status']}")
            print("  Waiting for Ollama to come back...")
            wait_for_ollama(180)

        if args.delete_after:
            delete(model)

    finished_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    write_report(results, started_at, finished_at)
    print(f"\nDone. Results written to {RESULTS_FILE}")


if __name__ == "__main__":
    main()
