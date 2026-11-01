"""Swap test for chat on the production Ollama (Phase 6, 6B-3, chat plan sections 12 and 14).

With OLLAMA_MAX_LOADED_MODELS=1 Ollama keeps one model resident, so an explanation after a chat
question (or the other way round) unloads one model and loads the other. This test measures that
cost against the production ollama container. It is read-only otherwise: nothing is written except
the output folder, and the only Ollama calls are /api/show, /api/chat and, on ABORT, an unload of
the chat model.

  1. Baseline: 3 explainer calls in a row to the explainer model (no switch).
  2. --rounds rounds of one explainer call, then one chat call to the chat model.
     The explainer call is the explainer's own build_messages for the first stored explanation
     incident in --facts, with the explainer's options (call_ollama). The chat call is the chat
     route's message: system_prompt.txt, a new "Request <8 hex>" line, the FACTS block and
     Q13 "Should I be worried right now?", with the chat options and keep_alive 5m.
  Both are sent with stream false, as in production. 5 s wait between calls. Every call is
  appended to OUT/swap.jsonl as soon as it ends.

Pass rule (fixed before the run): chat total median at most 25 s and p95 at most 35 s, including
the switch; explainer total median in the rounds at most 1.5 times the baseline median; no failed
call. RAM is checked separately with monitor_ram.sh OUT ollama on the host (see README.md). If
OUT/ABORT appears, the test unloads the chat model, prints a line and exits with code 2.

Run inside the explainer image (see README.md):
  python /bench/swap_test.py --facts /bench/results/RUN/facts.json --out /bench/results/RUN-swap
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True          # no __pycache__ in the mounted /bench folder
sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_bench import CHAT_OPTIONS, chat_messages, request_id, show_model  # noqa: E402
from snapshot_facts import find_file, incident_from_stored, load_explainer  # noqa: E402
from summarize import median, p95  # noqa: E402

OLLAMA_URL = os.environ.get("SWAP_OLLAMA_URL", "http://ollama:11434")
QUESTION = "Should I be worried right now?"     # Q13
CHAT_KEEP_ALIVE = "5m"                          # the dashboard's CHAT_KEEP_ALIVE
BASELINE_CALLS = 3
WAIT_S = 5
TIMEOUT_S = 180
CHAT_MEDIAN_MAX_S = 25.0
CHAT_P95_MAX_S = 35.0
EXPLAINER_FACTOR_MAX = 1.5
ABORT_MESSAGE = "ABORT: chat model unloaded, explainer unaffected"


class Aborted(Exception):
    pass


def post_chat(payload, url=OLLAMA_URL, timeout=TIMEOUT_S):
    """One /api/chat call with stream false. Returns the timing record (client clock for total_s)."""
    import requests
    t0 = time.monotonic()
    r = requests.post(f"{url}/api/chat", json=payload, timeout=(10, timeout))
    total = time.monotonic() - t0
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    body = r.json()
    if body.get("error"):
        raise RuntimeError(f"ollama error: {body['error']}")
    eval_n = int(body.get("eval_count", 0))
    eval_s = body.get("eval_duration", 0) / 1e9
    return {"total_s": total, "load_s": body.get("load_duration", 0) / 1e9,
            "prompt_tokens": int(body.get("prompt_eval_count", 0)), "eval_tokens": eval_n,
            "tok_s": eval_n / eval_s if eval_s > 0 else None,
            "answer": (body.get("message") or {}).get("content", "")}


def unload(model, url=OLLAMA_URL):
    import requests
    requests.post(f"{url}/api/generate", json={"model": model, "keep_alive": 0}, timeout=30)


def plan(rounds):
    """The call order: (phase, round, role). Pure, for the tests."""
    calls = [("baseline", i + 1, "explainer") for i in range(BASELINE_CALLS)]
    for i in range(rounds):
        calls += [("round", i + 1, "explainer"), ("round", i + 1, "chat")]
    return calls


def evaluate(rows):
    """Applies the fixed pass rule to the swap.jsonl rows. Returns a dict with the medians, p95
    values, passed and the reasons it failed. Pure, for the tests."""
    def totals(phase, role):
        return [r["total_s"] for r in rows if r["phase"] == phase and r["role"] == role and r["status"] == "ok"]
    base, expl, chat = totals("baseline", "explainer"), totals("round", "explainer"), totals("round", "chat")
    out = {"baseline_explainer": {"n": len(base), "median_s": median(base), "p95_s": p95(base)},
           "explainer": {"n": len(expl), "median_s": median(expl), "p95_s": p95(expl)},
           "chat": {"n": len(chat), "median_s": median(chat), "p95_s": p95(chat)}}
    reasons = []
    failed = [r for r in rows if r["status"] != "ok"]
    if failed:
        reasons.append(f"{len(failed)} failed call(s)")
    if not chat or not expl or not base:
        reasons.append("missing calls")
    else:
        if out["chat"]["median_s"] > CHAT_MEDIAN_MAX_S:
            reasons.append(f"chat median {out['chat']['median_s']:.2f} s above {CHAT_MEDIAN_MAX_S:.0f} s")
        if out["chat"]["p95_s"] > CHAT_P95_MAX_S:
            reasons.append(f"chat p95 {out['chat']['p95_s']:.2f} s above {CHAT_P95_MAX_S:.0f} s")
        limit = EXPLAINER_FACTOR_MAX * out["baseline_explainer"]["median_s"]
        if out["explainer"]["median_s"] > limit:
            reasons.append(f"explainer median {out['explainer']['median_s']:.2f} s above {limit:.2f} s "
                           f"({EXPLAINER_FACTOR_MAX} x baseline)")
    out["passed"], out["reasons"] = not reasons, reasons
    return out


class SwapTest:
    def __init__(self, out_dir, explainer_payload, chat_payload, call=post_chat, sleep=time.sleep, unload_fn=unload):
        """explainer_payload: dict; chat_payload: function returning a new dict per call."""
        self.dir = Path(out_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.jsonl = self.dir / "swap.jsonl"
        self.abort_file = self.dir / "ABORT"
        self.explainer_payload, self.chat_payload = explainer_payload, chat_payload
        self.call, self.sleep, self.unload = call, sleep, unload_fn

    def check_abort(self):
        if self.abort_file.exists():
            raise Aborted()

    def run(self, rounds):
        rows = []
        for n, (phase, rnd, role) in enumerate(plan(rounds)):
            self.check_abort()
            if n:
                self.sleep(WAIT_S)
                self.check_abort()
            payload = self.explainer_payload if role == "explainer" else self.chat_payload()
            row = {"phase": phase, "round": rnd, "role": role, "model": payload["model"],
                   "t_start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            try:
                result = self.call(payload)
                result.pop("answer", None)
                row.update(result, status="ok", error="")
            except Exception as e:
                self.check_abort()
                row.update({k: None for k in ("total_s", "load_s", "prompt_tokens", "eval_tokens", "tok_s")},
                           status="failed", error=f"{type(e).__name__}: {e}"[:300])
            with self.jsonl.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            print(f"{phase} {rnd} {role} {row['model']}: {row['status']} "
                  f"total {row['total_s'] if row['total_s'] is None else round(row['total_s'], 2)} s, "
                  f"load {row['load_s'] if row['load_s'] is None else round(row['load_s'], 2)} s", flush=True)
            rows.append(row)
        return rows

    def run_or_abort(self, rounds, chat_model):
        """Runs the test. On ABORT unloads the chat model and exits with code 2."""
        try:
            return self.run(rounds)
        except Aborted:
            try:
                self.unload(chat_model)
            finally:
                print(ABORT_MESSAGE, flush=True)
            sys.exit(2)


def print_summary(result):
    for key, label in (("baseline_explainer", "explainer, no switch"), ("explainer", "explainer, after chat"),
                       ("chat", "chat, after explainer")):
        s = result[key]
        med = "n/a" if s["median_s"] is None else f"{s['median_s']:.2f}"
        p = "n/a" if s["p95_s"] is None else f"{s['p95_s']:.2f}"
        print(f"{label}: n {s['n']}, median {med} s, p95 {p} s")
    print("PASS" if result["passed"] else "FAIL: " + "; ".join(result["reasons"]))


def main():
    ap = argparse.ArgumentParser(description="swap test for chat on the production Ollama")
    ap.add_argument("--chat-model", default="qwen2.5:3b")
    ap.add_argument("--explainer-model", default="qwen2.5:1.5b")
    ap.add_argument("--facts", required=True, help="facts.json from the bench")
    ap.add_argument("--rounds", type=int, default=10)
    ap.add_argument("--out", required=True, help="results folder (gets swap.jsonl and swap_summary.json)")
    args = ap.parse_args()

    out = Path(args.out)
    if (out / "swap.jsonl").exists():
        sys.exit(f"{out / 'swap.jsonl'} already exists; use a new results folder")
    if (out / "ABORT").exists():
        sys.exit(f"{out / 'ABORT'} exists. Check RAM and use a new results folder")
    facts = json.loads(Path(args.facts).read_text(encoding="utf-8"))
    if not facts.get("explanation_incidents"):
        sys.exit("facts.json has no explanation incidents")

    ex = load_explainer()
    stored = facts["explanation_incidents"][0]
    f = ex.build_facts(incident_from_stored(stored))
    explainer_payload = {"model": args.explainer_model, "messages": ex.build_messages(f, [], None), "stream": False,
                         "options": {"temperature": ex.LLM_TEMPERATURE, "num_predict": ex.LLM_MAX_TOKENS, "num_ctx": 2048}}

    system_prompt = find_file("BENCH_SYSTEM_PROMPT", "/chatprompt/system_prompt.txt",
                              ("dashboard", "server", "chat", "system_prompt.txt")).read_text(encoding="utf-8").strip()
    think = show_model(args.chat_model, url=OLLAMA_URL)["think"]

    def chat_payload():
        payload = {"model": args.chat_model, "stream": False, "keep_alive": CHAT_KEEP_ALIVE, "options": dict(CHAT_OPTIONS),
                   "messages": chat_messages(system_prompt, facts["facts_text"], QUESTION, request_id())}
        if think:
            payload["think"] = False
        return payload

    print(f"ollama {OLLAMA_URL}, chat {args.chat_model} (think false sent: {think}), explainer {args.explainer_model}, "
          f"incident {stored['id']} {stored['start']}, {args.rounds} rounds", flush=True)
    rows = SwapTest(out, explainer_payload, chat_payload).run_or_abort(args.rounds, args.chat_model)
    result = evaluate(rows)
    (out / "swap_summary.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print_summary(result)
    sys.exit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
