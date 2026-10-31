"""Runs the chat model test (Phase 6, 6B-2) against the separate ollama-bench container.

For each model: one warm-up call (its load_duration is the cold load; the call is not scored),
then every chat question --reps times and every explanation once. Repetitions are the outer
loop. Settings are section 5 of the chat plan:
  chat questions: /api/chat, stream true, system_prompt.txt as the system message and
                  "Request <8 random hex>", a newline, the FACTS block, a blank line and
                  "QUESTION: <text>" as the user message. The request line is new on every call,
                  so Ollama can reuse only the cached system prompt, as in production where FACTS
                  change between questions. temperature 0, seed 42, num_predict 200, num_ctx 2048
  explanations:   the explainer's own build_messages(facts, similar=[]) and call options
                  (LLM_TEMPERATURE, LLM_MAX_TOKENS, num_ctx 2048), stream true, and
                  check_explanation on the answer (first attempt only, no retry)
  think false is sent only to models whose /api/show capabilities include thinking.

Every call is appended to RUN/raw.jsonl as soon as it ends, so the run can be restarted: rows
already present are skipped. Model start and end times are written as events so ram.csv can be
joined. If RUN/ABORT exists (written by monitor_ram.sh) the run stops cleanly; a call that failed
because of the abort is not recorded, so it runs again on resume. Remove ABORT to resume.

  BENCH_OLLAMA_URL=http://ollama-bench:11434 python /bench/run_bench.py --run /bench/results/RUN \
      --models qwen2.5:1.5b,llama3.2:3b [--items Q2,Q4] [--reps 3]
"""
import argparse
import json
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

sys.dont_write_bytecode = True          # no __pycache__ in the mounted /bench folder
sys.path.insert(0, str(Path(__file__).resolve().parent))
from snapshot_facts import find_file, incident_from_stored, load_explainer  # noqa: E402

OLLAMA_URL = os.environ.get("BENCH_OLLAMA_URL", "http://ollama-bench:11434")
CHAT_OPTIONS = {"temperature": 0, "seed": 42, "num_predict": 200, "num_ctx": 2048}
TIMEOUT_S = 180
HERE = Path(__file__).resolve().parent


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


# ------------------------------------------------------------------ Ollama calls

def parse_stream(events, t0):
    """events: (client time, raw line) pairs of an /api/chat stream. Returns the timing record.
    Client times give TTFT (first non-empty content) and reply time (last chunk); the final
    chunk gives Ollama's own counters, which are in nanoseconds."""
    pieces, ttft, final, t_last = [], None, None, t0
    for t, line in events:
        if not line or not line.strip():
            continue
        obj = json.loads(line)
        t_last = t
        if obj.get("error"):
            raise RuntimeError(f"ollama error: {obj['error']}")
        piece = (obj.get("message") or {}).get("content") or ""
        if piece:
            if ttft is None:
                ttft = t - t0
            pieces.append(piece)
        if obj.get("done"):
            final = obj
            break
    if final is None:
        raise RuntimeError("stream ended without a final chunk")

    def seconds(key):
        return final.get(key, 0) / 1e9
    eval_s, prompt_s = seconds("eval_duration"), seconds("prompt_eval_duration")
    eval_n, prompt_n = int(final.get("eval_count", 0)), int(final.get("prompt_eval_count", 0))
    return {
        "ttft_s": ttft, "total_s": t_last - t0, "load_s": seconds("load_duration"),
        "prompt_tokens": prompt_n, "prompt_eval_s": prompt_s, "eval_tokens": eval_n, "eval_s": eval_s,
        "tok_s": eval_n / eval_s if eval_s > 0 else None,
        "prompt_tok_s": prompt_n / prompt_s if prompt_s > 0 else None,
        "done_reason": final.get("done_reason"), "answer": "".join(pieces),
    }


def stream_chat(payload, url=OLLAMA_URL, timeout=TIMEOUT_S):
    """One streamed /api/chat call with a total time limit (requests only limits each read)."""
    import requests
    t0 = time.monotonic()
    deadline = t0 + timeout
    with requests.post(f"{url}/api/chat", json=payload, stream=True, timeout=(10, timeout)) as r:
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")

        def events():
            for line in r.iter_lines():
                now = time.monotonic()
                if now > deadline:
                    raise TimeoutError(f"timeout after {timeout} s")
                yield now, line
        return parse_stream(events(), t0)


def show_model(model, url=OLLAMA_URL):
    """Capabilities and details from /api/show, plus size and digest from /api/tags."""
    import requests
    r = requests.post(f"{url}/api/show", json={"model": model}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"/api/show HTTP {r.status_code}: {r.text[:200]}")
    body = r.json()
    details = body.get("details") or {}
    info = {"capabilities": body.get("capabilities") or [],
            "parameter_size": details.get("parameter_size"), "quantization_level": details.get("quantization_level"),
            "family": details.get("family"), "size_bytes": None, "digest": None}
    try:
        tags = requests.get(f"{url}/api/tags", timeout=30).json().get("models") or []
        names = {model, model if ":" in model else f"{model}:latest"}
        for m in tags:
            if m.get("name") in names or m.get("model") in names:
                info["size_bytes"], info["digest"] = m.get("size"), m.get("digest")
    except Exception:
        pass
    info["think"] = "thinking" in info["capabilities"]
    return info


def unload_model(model, url=OLLAMA_URL):
    import requests
    try:
        requests.post(f"{url}/api/generate", json={"model": model, "keep_alive": 0}, timeout=30)
    except Exception:
        pass


def ollama_version(url=OLLAMA_URL):
    import requests
    try:
        return requests.get(f"{url}/api/version", timeout=10).json().get("version")
    except Exception as e:
        return f"unknown ({type(e).__name__})"


# ------------------------------------------------------------------ items

def request_id():
    return secrets.token_hex(4)


def chat_messages(system_prompt, facts_text, question, request):
    return [{"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Request {request}\n{facts_text}\n\nQUESTION: {question}"}]


def load_items(facts, questions, system_prompt, wanted=None, explainer=None):
    """Question items, then explanation items (E1 to E5). wanted: set of item ids or None for all."""
    items = []
    for q in questions:
        if wanted is None or q["id"] in wanted:
            items.append({"id": q["id"], "kind": "question", "options": dict(CHAT_OPTIONS),
                          "make_messages": (lambda request, text=q["text"]:
                                            chat_messages(system_prompt, facts["facts_text"], text, request))})
    stored = [e for e in facts.get("explanation_incidents", []) if wanted is None or e["id"] in wanted]
    if stored:
        ex = explainer or load_explainer()
        options = {"temperature": ex.LLM_TEMPERATURE, "num_predict": ex.LLM_MAX_TOKENS, "num_ctx": 2048}
        for e in stored:
            f = ex.build_facts(incident_from_stored(e))
            if ex.facts_text(f) != e["facts_text"]:
                raise SystemExit(f"{e['id']}: rebuilt facts differ from facts.json, stopping")
            items.append({"id": e["id"], "kind": "explanation", "options": dict(options),
                          "messages": ex.build_messages(f, [], None), "facts": f, "check": ex.check_explanation})
    if wanted is not None:
        missing = wanted - {i["id"] for i in items}
        if missing:
            raise SystemExit("unknown item ids: " + ", ".join(sorted(missing)))
    return items


# ------------------------------------------------------------------ the run

class Bench:
    def __init__(self, run_dir, call=stream_chat, clock=utc_now):
        self.dir = Path(run_dir)
        self.raw = self.dir / "raw.jsonl"
        self.abort_file = self.dir / "ABORT"
        self.call, self.clock = call, clock
        self.run = self.dir.name
        self.done, self.warmups = set(), {}
        if self.raw.exists():
            for line in self.raw.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("kind") in ("question", "explanation"):
                    self.done.add((row["model"], row["item_id"], row["kind"], row["rep"]))
                elif row.get("kind") == "warmup":
                    self.warmups[row["model"]] = max(self.warmups.get(row["model"], 0), row["rep"])

    def aborted(self):
        return self.abort_file.exists()

    def append(self, obj):
        with self.raw.open("a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")

    def event(self, name, model, **extra):
        self.append({"event": name, "run": self.run, "model": model, "t": self.clock(), **extra})

    def call_item(self, model, item, kind, rep, think):
        """Runs one call and appends its row. Returns the row, or None if the run was aborted."""
        request = None
        if "make_messages" in item:                     # chat question: new request line every call
            request = request_id()
            messages = item["make_messages"](request)
        else:
            messages = item["messages"]
        payload = {"model": model, "messages": messages, "stream": True, "options": item["options"]}
        if think:
            payload["think"] = False
        row = {"run": self.run, "model": model, "item_id": item["id"], "kind": kind, "rep": rep,
               "t_start": self.clock(), "think_false_sent": bool(think), "request_id": request}
        try:
            row.update(self.call(payload), status="ok", error="")
        except Exception as e:
            if self.aborted():
                return None
            row.update({k: None for k in ("ttft_s", "total_s", "load_s", "prompt_tokens", "prompt_eval_s",
                                          "eval_tokens", "eval_s", "tok_s", "prompt_tok_s", "done_reason")},
                       answer="", status="failed", error=f"{type(e).__name__}: {e}"[:300])
        if kind == "explanation":
            reasons = item["check"](row["answer"].strip(), item["facts"]) if row["status"] == "ok" else ["call failed"]
            row["validator_pass"], row["validator_reasons"] = not reasons, reasons
        self.append(row)
        if kind != "warmup":
            self.done.add((model, item["id"], kind, rep))
        return row

    def run_model(self, model, items, reps, info):
        """Returns done, skipped, aborted or load_failed."""
        # Explanations run once per incident (plan section 5, amended 1 Nov), questions --reps times.
        todo = [(rep, it) for rep in range(1, reps + 1) for it in items
                if (it["kind"] != "explanation" or rep == 1) and (model, it["id"], it["kind"], rep) not in self.done]
        if not todo:
            return "skipped"
        if self.aborted():
            return "aborted"
        self.event("model_start", model, **info)
        warm_rep = self.warmups.get(model, 0) + 1
        self.warmups[model] = warm_rep
        row = self.call_item(model, items[0], "warmup", warm_rep, info.get("think"))
        if row is None:
            self.event("model_end", model, result="aborted")
            return "aborted"
        if row["status"] != "ok":
            self.event("model_end", model, result="load_failed", error=row["error"])
            return "load_failed"
        for rep, item in todo:
            if self.aborted() or self.call_item(model, item, item["kind"], rep, info.get("think")) is None:
                self.event("model_end", model, result="aborted")
                return "aborted"
        self.event("model_end", model, result="done")
        return "done"


def main():
    ap = argparse.ArgumentParser(description="chat model test runner")
    ap.add_argument("--run", required=True, help="run folder (holds facts.json, gets raw.jsonl)")
    ap.add_argument("--models", required=True, help="comma-separated Ollama tags")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--items", help="comma-separated item ids (default: all questions and explanations)")
    ap.add_argument("--timeout", type=int, default=TIMEOUT_S)
    args = ap.parse_args()

    if urlparse(OLLAMA_URL).hostname == "ollama":
        sys.exit("BENCH_OLLAMA_URL points at the production ollama container; use ollama-bench")
    run_dir = Path(args.run)
    facts_path = run_dir / "facts.json"
    if not facts_path.exists():
        sys.exit(f"{facts_path} is missing; run snapshot_facts.py first")
    if (run_dir / "ABORT").exists():
        sys.exit(f"{run_dir / 'ABORT'} exists. Check RAM, remove the file and start again to resume")

    facts = json.loads(facts_path.read_text(encoding="utf-8"))
    questions = json.loads((HERE / "questions.json").read_text(encoding="utf-8"))
    system_prompt = find_file("BENCH_SYSTEM_PROMPT", "/chatprompt/system_prompt.txt",
                              ("dashboard", "server", "chat", "system_prompt.txt")).read_text(encoding="utf-8").strip()
    wanted = {s.strip() for s in args.items.split(",") if s.strip()} if args.items else None
    items = load_items(facts, questions, system_prompt, wanted)
    models = [m.strip() for m in args.models.split(",") if m.strip()]

    bench = Bench(run_dir, call=lambda p: stream_chat(p, timeout=args.timeout))
    bench.append({"event": "run_info", "run": bench.run, "t": utc_now(), "ollama_url": OLLAMA_URL,
                  "ollama_version": ollama_version(), "models": models, "items": [i["id"] for i in items],
                  "reps": args.reps, "timeout_s": args.timeout, "chat_options": CHAT_OPTIONS,
                  "explanation_options": next((i["options"] for i in items if i["kind"] == "explanation"), None),
                  "similar": "[] for explanations (no Chroma)", "num_thread": "Ollama default, not set by the bench",
                  "client_cpu_count": os.cpu_count()})

    for model in models:
        if bench.aborted():
            print("ABORT file found, stopping. Remove it and run the same command to resume.")
            return
        try:
            info = show_model(model)
        except Exception as e:
            if bench.aborted():
                continue
            bench.event("model_error", model, error=f"{type(e).__name__}: {e}"[:300])
            print(f"{model}: not available ({e})")
            continue
        print(f"{model}: start (think false sent: {info['think']})", flush=True)
        result = bench.run_model(model, items, args.reps, info)
        print(f"{model}: {result}", flush=True)
        if result == "aborted":
            print("ABORT file found, stopping. Remove it and run the same command to resume.")
            return
        if result in ("done", "load_failed"):
            unload_model(model)


if __name__ == "__main__":
    main()
