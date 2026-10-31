"""Tests for the chat model test harness. No network: Ollama, InfluxDB and Prometheus are faked.

  pip install pandas==2.2.3 requests==2.32.3 influxdb==5.3.2 pytest
  pytest -p no:cacheprovider bench/chat_model_test/test_bench.py
"""
import csv
import json
import re
import sys
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_blind  # noqa: E402
import run_bench  # noqa: E402
import snapshot_facts as sf  # noqa: E402
import summarize  # noqa: E402

GIB = 2 ** 30


def ms(text):
    return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


# ------------------------------------------------------------------ FACTS rendering

SNAPSHOT = datetime(2026, 11, 1, 12, 31, tzinfo=timezone.utc)

FIXTURE_VALUES = {
    "service_up": True,
    "anomaly_latest": {"time_ms": ms("2026-11-01T12:31:00Z"), "score": 0.3391, "threshold": 0.6024,
                       "flagged": False, "tier": "none"},
    "service_now": {"time_ms": ms("2026-11-01T12:31:00Z"), "cpu_rate": 0.00312, "memory_max_mb": 137.4, "latency_ms": 1.43},
    "model": {"champion": "v10", "threshold": 0.6024,
              "last_retrain": {"time_ms": ms("2026-10-30T19:01:20Z"), "promoted": False, "new_version": ""}},
    "reference": {"cpu_rate": 0.00291, "memory_max_mb": 135.2, "latency_ms": 1.46},
    "incidents_6h": sf.merge_incidents(
        [{"time": ms("2026-11-01T10:37:00Z"), "tier": "medium", "signal": "memory", "minutes": 2, "peak_score": 0.6881,
          "deployment": 0, "explanation": "What happened: Memory use climbed to 170 MB.\\nLikely cause: Likely a leak.\\nNext step: Restart."},
         {"time": ms("2026-11-01T08:05:00Z"), "tier": "low", "signal": "cpu", "minutes": 1, "peak_score": 0.6312,
          "deployment": 0, "explanation": "What happened: CPU use rose to 85% of one CPU core.\nLikely cause: x\nNext step: y"}],
        [{"time": ms("2026-11-01T12:20:00Z"), "tier": "low", "signal": "cpu", "minutes": 3, "peak_score": 0.65, "deployment": 1},
         {"time": ms("2026-11-01T10:38:00Z"), "tier": "medium", "signal": "memory", "minutes": 2, "peak_score": 0.6881, "deployment": 0}]),
    "last_restart": None,
    "last_ci_deployment": {"time_ms": ms("2026-10-30T13:41:00Z")},
    "node_fyp_main": {"up": True, "mem_used_gib": 3.1, "mem_total_gib": 7.5, "disk_pct": 19.2, "containers": 15.0},
    "node_staging": {"up": True, "mem_used_gib": 1.94, "mem_total_gib": 3.7, "disk_pct": 60.6, "containers": 10.0},
}

EXPECTED_FACTS = """FACTS (snapshot 2026-11-01T12:31:00Z, times in MYT, UTC+8)
service sample-service: up yes
anomaly latest: 20:31, score 0.339, threshold 0.602, flagged no, tier none
sample-service now: 20:31, cpu_rate 0.0031, memory 137 MB, latency 1.4 ms
model: champion v10, threshold 0.602, last retraining 03:01 31 Oct, result kept champion
normal reference: cpu_rate 0.0029, memory 135 MB, latency 1.5 ms
incidents last 6 h: 3 (low 2, medium 1, high 0)
- 20:20, tier low, signal cpu, 3 min, peak 0.650, deployment yes, open.
- 18:37, tier medium, signal memory, 2 min, peak 0.688, deployment no, closed. What happened: Memory use climbed to 170 MB.
- 16:05, tier low, signal cpu, 1 min, peak 0.631, deployment no, closed. What happened: CPU use rose to 85% of one CPU core.
last restart: none in the last 30 days
last CI deployment: 21:41 30 Oct
node fyp-main: memory 3.1 of 7.5 GiB, disk 19 %, containers 15
node staging: monitored yes, memory 1.9 of 3.7 GiB, disk 61 %, containers 10
Only the facts above are available. Logs, commit messages and metrics not listed are not available."""


def test_facts_rendering_matches_section_10_format():
    text, lines = sf.render_facts(FIXTURE_VALUES, SNAPSHOT)
    assert text == EXPECTED_FACTS
    assert set(lines) == set(sf.VALUE_KEYS)


def test_facts_rendering_without_data():
    values = {k: None for k in sf.VALUE_KEYS}
    values["node_staging"] = {"up": False}
    text, _ = sf.render_facts(values, SNAPSHOT)
    assert "service sample-service: up no data" in text
    assert "anomaly latest: no data" in text
    assert "sample-service now: no data" in text
    assert "incidents last 6 h: no data" in text
    assert "last CI deployment: none recorded" in text
    assert "node staging: monitored no" in text


def test_select_only_guard():
    assert sf.select_only(" SELECT * FROM x ") == "SELECT * FROM x"
    for bad in ("DROP MEASUREMENT x", "SELECT * INTO y FROM x", "SELECT 1; DROP x", "SHOW DATABASES"):
        with pytest.raises(ValueError):
            sf.select_only(bad)


# ------------------------------------------------------------------ stream timing

def test_parse_stream_timing():
    t0 = 100.0
    events = [
        (100.4, b'{"message":{"role":"assistant","content":""},"done":false}'),
        (101.5, b'{"message":{"role":"assistant","content":"Yes,"},"done":false}'),
        (101.7, b""),
        (102.0, b'{"message":{"role":"assistant","content":" it is up."},"done":false}'),
        (102.5, json.dumps({"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop",
                            "total_duration": 2_400_000_000, "load_duration": 300_000_000,
                            "prompt_eval_count": 400, "prompt_eval_duration": 800_000_000,
                            "eval_count": 20, "eval_duration": 1_000_000_000}).encode()),
    ]
    r = run_bench.parse_stream(events, t0)
    assert r["ttft_s"] == pytest.approx(1.5)
    assert r["total_s"] == pytest.approx(2.5)
    assert r["load_s"] == pytest.approx(0.3)
    assert r["prompt_tokens"] == 400 and r["prompt_eval_s"] == pytest.approx(0.8)
    assert r["eval_tokens"] == 20 and r["eval_s"] == pytest.approx(1.0)
    assert r["tok_s"] == pytest.approx(20.0) and r["prompt_tok_s"] == pytest.approx(500.0)
    assert r["done_reason"] == "stop" and r["answer"] == "Yes, it is up."


def test_parse_stream_without_final_chunk_fails():
    with pytest.raises(RuntimeError):
        run_bench.parse_stream([(1.0, b'{"message":{"content":"x"},"done":false}')], 0.0)


# ------------------------------------------------------------------ resume and abort

def fake_result(answer="ok"):
    return {"ttft_s": 0.1, "total_s": 1.0, "load_s": 0.0, "prompt_tokens": 10, "prompt_eval_s": 0.1,
            "eval_tokens": 5, "eval_s": 0.5, "tok_s": 10.0, "prompt_tok_s": 100.0, "done_reason": "stop", "answer": answer}


def items(*ids):
    return [{"id": i, "kind": "question", "options": {}, "messages": [{"role": "user", "content": i}]} for i in ids]


def raw_rows(run):
    return [json.loads(line) for line in (run / "raw.jsonl").read_text(encoding="utf-8").splitlines()]


def test_resume_skips_rows_already_present(tmp_path):
    (tmp_path / "raw.jsonl").write_text(json.dumps(
        {"run": tmp_path.name, "model": "m1", "item_id": "Q1", "kind": "question", "rep": 1, "status": "ok"}) + "\n",
        encoding="utf-8")
    calls = []
    bench = run_bench.Bench(tmp_path, call=lambda p: calls.append(p["messages"][0]["content"]) or fake_result())
    assert bench.run_model("m1", items("Q1", "Q2"), 2, {"think": True}) == "done"
    # warm-up, then rep 1 Q2, rep 2 Q1, rep 2 Q2 (rep is the outer loop)
    assert calls == ["Q1", "Q2", "Q1", "Q2"]
    rows = [r for r in raw_rows(tmp_path) if r.get("kind") == "question"]
    assert [(r["item_id"], r["rep"]) for r in rows] == [("Q1", 1), ("Q2", 1), ("Q1", 2), ("Q2", 2)]
    assert all(r["think_false_sent"] for r in rows[1:])      # rows[0] was written before the run

    calls.clear()
    assert run_bench.Bench(tmp_path, call=lambda p: calls.append(1) or fake_result()).run_model(
        "m1", items("Q1", "Q2"), 2, {}) == "skipped"
    assert calls == []


def test_think_false_only_for_thinking_models(tmp_path):
    payloads = []
    bench = run_bench.Bench(tmp_path, call=lambda p: payloads.append(p) or fake_result())
    bench.run_model("plain", items("Q1"), 1, {"think": False})
    bench.run_model("thinker", items("Q1"), 1, {"think": True})
    assert all("think" not in p for p in payloads if p["model"] == "plain")
    assert all(p["think"] is False for p in payloads if p["model"] == "thinker")


def test_abort_stops_cleanly_and_resume_reruns_the_aborted_call(tmp_path):
    count = {"n": 0}

    def call(payload):
        count["n"] += 1
        if count["n"] == 3:                       # monitor_ram.sh stops ollama-bench during the call
            (tmp_path / "ABORT").write_text("low memory")
            raise ConnectionError("connection reset")
        return fake_result()

    bench = run_bench.Bench(tmp_path, call=call)
    assert bench.run_model("m1", items("Q1", "Q2", "Q3"), 1, {}) == "aborted"
    rows = raw_rows(tmp_path)
    assert [(r["kind"], r["item_id"]) for r in rows if "kind" in r] == [("warmup", "Q1"), ("question", "Q1")]
    assert rows[-1]["event"] == "model_end" and rows[-1]["result"] == "aborted"
    assert not any(r.get("status") == "failed" for r in rows)

    (tmp_path / "ABORT").unlink()
    bench = run_bench.Bench(tmp_path, call=lambda p: fake_result())
    assert bench.run_model("m1", items("Q1", "Q2", "Q3"), 1, {}) == "done"
    q = [(r["item_id"], r["rep"]) for r in raw_rows(tmp_path) if r.get("kind") == "question"]
    assert q == [("Q1", 1), ("Q2", 1), ("Q3", 1)]
    warmups = [r["rep"] for r in raw_rows(tmp_path) if r.get("kind") == "warmup"]
    assert warmups == [1, 2]


def test_abort_file_before_start_runs_nothing(tmp_path):
    (tmp_path / "ABORT").write_text("x")
    calls = []
    assert run_bench.Bench(tmp_path, call=lambda p: calls.append(1)).run_model("m1", items("Q1"), 1, {}) == "aborted"
    assert calls == [] and not (tmp_path / "raw.jsonl").exists()


def test_timeout_is_a_failed_row_not_a_crash(tmp_path):
    def call(payload):
        if payload["messages"][0]["content"] == "Q2":
            raise TimeoutError("timeout after 180 s")
        return fake_result()

    assert run_bench.Bench(tmp_path, call=call).run_model("m1", items("Q1", "Q2", "Q3"), 1, {}) == "done"
    rows = {r["item_id"]: r for r in raw_rows(tmp_path) if r.get("kind") == "question"}
    assert rows["Q2"]["status"] == "failed" and "TimeoutError" in rows["Q2"]["error"] and rows["Q2"]["total_s"] is None
    assert rows["Q3"]["status"] == "ok"


def test_failed_warmup_marks_load_failure(tmp_path):
    def call(payload):
        raise RuntimeError("HTTP 500: unable to load model")
    assert run_bench.Bench(tmp_path, call=call).run_model("m1", items("Q1"), 1, {}) == "load_failed"
    assert raw_rows(tmp_path)[-1]["result"] == "load_failed"


def test_chat_message_composition():
    msgs = run_bench.chat_messages("SYS", "FACTS (x)", "Is it up?", "0a1b2c3d")
    assert msgs == [{"role": "system", "content": "SYS"},
                    {"role": "user", "content": "Request 0a1b2c3d\nFACTS (x)\n\nQUESTION: Is it up?"}]


def test_every_chat_call_gets_a_new_request_line(tmp_path):
    facts = {"facts_text": "FACTS (snapshot)\nservice sample-service: up yes", "explanation_incidents": []}
    questions = [{"id": "Q1", "text": "Up?"}, {"id": "Q2", "text": "Score?"}]
    its = run_bench.load_items(facts, questions, "SYS", None)
    payloads = []
    bench = run_bench.Bench(tmp_path, call=lambda p: payloads.append(p) or fake_result())
    assert bench.run_model("m1", its, 3, {}) == "done"
    users = [p["messages"][1]["content"] for p in payloads]
    assert len(users) == 1 + 2 * 3                               # warm-up plus 2 questions x 3 reps
    first_lines = [u.split("\n", 1)[0] for u in users]
    assert all(re.fullmatch(r"Request [0-9a-f]{8}", line) for line in first_lines)
    assert len(set(first_lines)) == len(first_lines)             # unique per call
    assert all(u.split("\n", 1)[1].startswith("FACTS (snapshot)\n") for u in users)
    assert all(p["messages"][0] == {"role": "system", "content": "SYS"} for p in payloads)
    rows = [r for r in raw_rows(tmp_path) if r.get("kind") in ("question", "warmup")]
    assert [f"Request {r['request_id']}" for r in rows] == first_lines


# ------------------------------------------------------------------ explanation round trip

def stored_incident():
    rows = [
        {"time": "2026-10-31T10:00:00Z", "tier_level": 2, "tier": "medium", "signal": "memory", "signals": "memory,latency",
         "action": "restart", "recent_deployment": 0, "score": 0.71, "cpu_rate": 0.003, "memory_max_mb": 171.4,
         "latency_ms": 60.2, "base_cpu_rate": 0.0029, "base_memory_max_mb": 135.0, "base_latency_ms": 1.5},
        {"time": "2026-10-31T10:01:00Z", "tier_level": 2, "tier": "medium", "signal": "memory", "signals": "memory",
         "action": "restart", "recent_deployment": None, "score": 0.69, "cpu_rate": 0.003, "memory_max_mb": 168.0,
         "latency_ms": 2.0, "base_cpu_rate": None, "base_memory_max_mb": 135.0, "base_latency_ms": 1.5},
    ]
    return {"id": "E1", "start": "2026-10-31T10:00:00Z", "end": "2026-10-31T10:01:00Z", "signal": "memory",
            "tier": "medium", "minutes": 2, "rows": rows}


def test_explanation_round_trip_through_json():
    ex = sf.load_explainer()
    stored = json.loads(json.dumps(stored_incident()))
    facts = ex.build_facts(sf.incident_from_stored(stored))
    assert facts["signal"] == "memory" and facts["tier"] == "medium" and facts["minutes"] == 2
    assert facts["peak"]["memory"] == pytest.approx(171.4)
    stored["facts_text"] = ex.facts_text(facts)
    again = ex.build_facts(sf.incident_from_stored(json.loads(json.dumps(stored))))
    assert ex.facts_text(again) == stored["facts_text"]


def test_load_items_uses_explainer_prompt_without_similar_incidents():
    ex = sf.load_explainer()
    stored = stored_incident()
    stored["facts_text"] = ex.facts_text(ex.build_facts(sf.incident_from_stored(stored)))
    facts = {"facts_text": "FACTS", "explanation_incidents": [stored]}
    got = run_bench.load_items(facts, [{"id": "Q1", "text": "Up?"}], "SYS", None, ex)
    e = [i for i in got if i["kind"] == "explanation"][0]
    assert e["messages"] == ex.build_messages(e["facts"], [], None)
    assert "Similar past incidents" not in e["messages"][-1]["content"]
    assert e["options"] == {"temperature": ex.LLM_TEMPERATURE, "num_predict": ex.LLM_MAX_TOKENS, "num_ctx": 2048}
    assert [i["id"] for i in run_bench.load_items(facts, [{"id": "Q1", "text": "Up?"}], "SYS", {"Q1"}, ex)] == ["Q1"]

    stored["facts_text"] = "changed"
    with pytest.raises(SystemExit):
        run_bench.load_items(facts, [], "SYS", None, ex)


# ------------------------------------------------------------------ blind sheet

def test_blind_shuffle_keeps_id_to_model_mapping():
    facts = {"lines": {"service_up": ["service sample-service: up yes"]}, "explanation_incidents": []}
    questions = [{"id": "Q1", "text": "Up?", "expected_keys": ["service_up"]},
                 {"id": "Q11", "text": "Disk?", "expected_keys": []}]
    rows = [{"model": m, "item_id": q, "kind": "question", "rep": 1, "status": "ok", "answer": f"{m}|{q}"}
            for m in ("alpha", "beta", "gamma") for q in ("Q1", "Q11")]
    rows.append({"model": "delta", "item_id": "Q1", "kind": "question", "rep": 1, "status": "failed", "answer": "",
                 "error": "TimeoutError"})
    sheet, key = make_blind.build_sheet(rows, facts, questions, seed=1234)

    assert len(sheet) == len(rows) == len({s["id"] for s in sheet})
    assert all("model" not in s for s in sheet)
    assert [s["item_id"] + s["answer"] for s in sheet] != [r["item_id"] + r["answer"] for r in rows]   # shuffled
    model_of = {k["id"]: k["model"] for k in key}
    for s in sheet:
        if s["answer"].startswith("[no answer"):
            assert model_of[s["id"]] == "delta"
        else:
            assert s["answer"].split("|") == [model_of[s["id"]], s["item_id"]]
    assert {k["seed"] for k in key} == {1234}
    assert make_blind.build_sheet(rows, facts, questions, seed=1234) == (sheet, key)
    no_data = [s for s in sheet if s["item_id"] == "Q11"][0]
    assert no_data["expected"] == make_blind.NO_DATA_EXPECTED


def test_blind_only_uses_rep_1(tmp_path):
    lines = [{"event": "model_start", "model": "a"},
             {"model": "a", "item_id": "Q1", "kind": "warmup", "rep": 1},
             {"model": "a", "item_id": "Q1", "kind": "question", "rep": 1, "answer": "x"},
             {"model": "a", "item_id": "Q1", "kind": "question", "rep": 2, "answer": "y"}]
    (tmp_path / "raw.jsonl").write_text("\n".join(json.dumps(x) for x in lines), encoding="utf-8")
    got = make_blind.rep1_rows(tmp_path / "raw.jsonl")
    assert [(r["kind"], r["rep"], r["answer"]) for r in got] == [("question", 1, "x")]


# ------------------------------------------------------------------ summary rules

CFG = {"baseline": "qwen2.5:1.5b", "top": 4, "max_reply_s": 25.0, "margin": 0.2, "explainer_mib": 1100.0,
       "cap_base_mib": 1600.0, "cap_margin_mib": 300.0, "min_available_mib": 1536.0, "timeout_s": 180}


def metric(model, scores, params_b=3.0, reply=5.0, claims=0, peak=2500.0, avail=4200.0, load_failed=False):
    """scores: list of 15 ints for Q1..Q15."""
    item_scores = {f"Q{i + 1}": s for i, s in enumerate(scores)}
    return {"model": model, "params": f"{params_b}B", "params_b": params_b, "size_bytes": int(params_b * 1e9),
            "load_failed": load_failed, "reply_median_s": reply, "item_scores": item_scores,
            "grounding": Fraction(sum(scores), len(scores)), "action_claims": claims,
            "peak_ram_mib": peak, "min_available_mib": avail}


def scores_with_total(total):
    """15 scores of 0 to 2 that keep Q11 and Q12 at 2 and add up to total."""
    s = [2 if i in (10, 11) else 0 for i in range(15)]
    left = total - 4
    for i in range(15):
        if i in (10, 11):
            continue
        add = min(2, left)
        s[i] += add
        left -= add
    assert left == 0 and sum(s) == total
    return s


def test_stage2_margin_exactly_point_two_moves_chat():
    # 21/15 - 18/15 is 0.19999999999999996 in floats; the rule must still see 0.2.
    assert 21 / 15 - 18 / 15 < 0.2
    metrics = [metric("qwen2.5:1.5b", scores_with_total(18), params_b=1.5),
               metric("winner:3b", scores_with_total(21), params_b=3.2),
               metric("cheater:3b", scores_with_total(30), claims=1)]
    steps, chosen, status = summarize.stage2_decision(metrics, CFG)
    assert chosen == "winner:3b"
    assert status["cheater:3b"].startswith("excluded by rule 1")
    assert "claims an action" in status["cheater:3b"]


def test_stage2_below_margin_stays_on_baseline():
    metrics = [metric("qwen2.5:1.5b", scores_with_total(21), params_b=1.5),
               metric("close:3b", scores_with_total(23))]
    steps, chosen, _ = summarize.stage2_decision(metrics, CFG)
    assert chosen == "qwen2.5:1.5b"
    assert "chat stays on qwen2.5:1.5b" in steps[3][1][0]


def test_stage2_hard_failure_q12_slow_and_ram():
    q12_fail = scores_with_total(28)
    q12_fail[11] = 1
    metrics = [metric("qwen2.5:1.5b", scores_with_total(20), params_b=1.5, avail=3000.0),
               metric("noq12:3b", q12_fail),
               metric("slow:3b", scores_with_total(29), reply=25.5),
               metric("fat:3b", scores_with_total(29), avail=2600.0),
               metric("small:2b", scores_with_total(26), params_b=2.0),
               metric("big:3b", scores_with_total(26), params_b=3.8)]
    steps, chosen, status = summarize.stage2_decision(metrics, CFG)
    assert "Q12 scored 1" in status["noq12:3b"]
    assert status["slow:3b"].startswith("excluded by rule 2")
    assert status["fat:3b"].startswith("excluded by rule 2")      # 2600 - 1100 = 1500 < 1536
    assert "2600 - 1100 = 1500 MiB < 1536 MiB" in status["fat:3b"]
    assert chosen == "small:2b"                                    # tie at 26/15 goes to the smaller model
    assert status["qwen2.5:1.5b"] == "eligible, not chosen"         # baseline passes the RAM rule by definition


def test_stage1_screening():
    def m1(model, q2, q4, q11, q14, q15, **kw):
        m = metric(model, [0] * 15, **kw)
        m["item_scores"] = {"Q2": q2, "Q4": q4, "Q11": q11, "Q14": q14, "Q15": q15}
        m["grounding"] = Fraction(q2 + q4 + q11 + q14 + q15, 5)
        return m
    metrics = [m1("qwen2.5:1.5b", 1, 1, 1, 1, 1, params_b=1.5),
               m1("a", 2, 2, 2, 2, 2), m1("b", 2, 1, 2, 2, 2), m1("c", 1, 1, 2, 2, 2, params_b=3.8),
               m1("d", 1, 1, 2, 2, 2, params_b=2.0), m1("e", 0, 1, 2, 2, 2),
               m1("noq11", 2, 2, 1, 2, 2), m1("slow", 2, 2, 2, 2, 2, reply=30.0),
               m1("actor", 2, 2, 2, 2, 2, claims=1), m1("missing", 0, 0, 0, 0, 0, load_failed=True)]
    result, stage2 = summarize.stage1_decision(metrics, CFG)
    assert stage2 == ["qwen2.5:1.5b", "a", "b", "d", "c"]           # d (2.0B) before c (3.8B) on a tie
    res = {n: (r, why) for n, r, why in result}
    assert res["e"][0] == "dropped" and "only the best 4" in res["e"][1]
    assert res["noq11"] == ("dropped", "Q11 scored 1 (below 2)")
    assert "median reply time 30.00 s" in res["slow"][1]
    assert "claims an action" in res["actor"][1]
    assert res["missing"] == ("dropped", "failed to pull or load")
    assert res["qwen2.5:1.5b"][0] == "kept" and "would have been dropped" in res["qwen2.5:1.5b"][1]


def test_percentiles():
    assert summarize.median([3, 1, 2]) == 2 and summarize.median([1, 2, 3, 4]) == 2.5
    assert summarize.p95(list(range(1, 21))) == pytest.approx(19.05)
    assert summarize.billions("945.15M") == pytest.approx(0.94515) and summarize.billions("3.2B") == 3.2


def test_summarize_end_to_end(tmp_path, monkeypatch, capsys):
    run = tmp_path / "20261101-1300-s2"
    run.mkdir()
    raw = [{"event": "run_info", "t": "2026-11-01T13:00:00Z", "models": ["qwen2.5:1.5b", "other:3b"], "timeout_s": 180}]
    key, sheet, n = [], [], 0
    for model, minute, total in (("qwen2.5:1.5b", 1, 0.5), ("other:3b", 3, 2.0)):
        raw.append({"event": "model_start", "model": model, "t": f"2026-11-01T13:0{minute}:00Z",
                    "parameter_size": "1.5B" if "1.5" in model else "3.1B", "quantization_level": "Q4_K_M",
                    "think": False, "size_bytes": 986_000_000})
        raw.append({"model": model, "item_id": "Q1", "kind": "warmup", "rep": 1, "status": "ok", "load_s": 4.2,
                    "total_s": 5.0, "ttft_s": 4.5, "tok_s": 20.0})
        for rep in (1, 2, 3):
            for q in ("Q1", "Q11", "Q12"):
                raw.append({"model": model, "item_id": q, "kind": "question", "rep": rep, "status": "ok",
                            "total_s": total * rep, "ttft_s": 0.2, "tok_s": 15.0, "done_reason": "stop", "answer": "a"})
        raw.append({"event": "model_end", "model": model, "t": f"2026-11-01T13:0{minute + 1}:00Z", "result": "done"})
        for q, s in (("Q1", 2 if model == "other:3b" else 1), ("Q11", 2), ("Q12", 2)):
            n += 1
            key.append({"id": f"R{n}", "model": model, "item_id": q, "kind": "question", "seed": 7})
            sheet.append({"id": f"R{n}", "item_id": q, "prompt": "", "expected": "", "answer": "a",
                          "score": str(s), "claims_action": "n", "note": ""})
    (run / "raw.jsonl").write_text("\n".join(json.dumps(r) for r in raw), encoding="utf-8")
    for name, rows, cols in (("key.csv", key, make_blind.KEY_COLUMNS), ("scores_blind.csv", sheet, make_blind.SHEET_COLUMNS)):
        with (run / name).open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
    (run / "ram.csv").write_text("utc,bench_mib,mem_available_mib,si,so\n"
                                 "2026-11-01T13:01:30Z,1100,5000,0,0\n2026-11-01T13:03:30Z,2600,4000,0,0\n"
                                 "2026-11-01T13:03:35Z,,3900,0,0\n2026-11-01T13:09:00Z,9999,100,0,0\n", encoding="utf-8")
    (run / "models.txt").write_text("NAME            ID              SIZE      MODIFIED\n"
                                    "other:3b        357c53fb659c    1.9 GB    2 minutes ago\n", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["summarize.py", "--run", str(run), "--stage", "2"])
    summarize.main()
    md = (run / "summary.md").read_text(encoding="utf-8")
    # other:3b: 6/3 = 2.00 vs baseline 5/3 = 1.67, margin 0.33; RAM 3900 - 1100 = 2800 >= 1536
    assert "Chat model: other:3b" in md
    assert "| other:3b | 3.1B | Q4_K_M | 1.9 GB | 2600 MiB | 4.20 | 0.20 | 4.00 / 6.00 | 15.0 | 2.00 | 2, 2 | 0 | n/a |" in md
    with (run / "summary.csv").open(encoding="utf-8") as f:
        rows = {r["model"]: r for r in csv.DictReader(f)}
    assert rows["other:3b"]["result"] == "chosen" and rows["other:3b"]["min_available_mib"] == "3900.0"


def test_summarize_refuses_unfinished_scoring(tmp_path, monkeypatch):
    (tmp_path / "raw.jsonl").write_text("", encoding="utf-8")
    (tmp_path / "key.csv").write_text("id,model,item_id,kind,seed\nR1,m,Q1,question,1\n", encoding="utf-8")
    (tmp_path / "scores_blind.csv").write_text("id,item_id,prompt,expected,answer,score,claims_action,note\n"
                                               "R1,Q1,p,e,a,,,\n", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["summarize.py", "--run", str(tmp_path), "--stage", "1"])
    with pytest.raises(SystemExit):
        summarize.main()


def test_model_error_before_a_successful_resume_is_not_a_load_failure():
    events = [{"event": "model_error", "model": "m1", "t": "2026-11-01T13:00:00Z", "error": "ConnectionError"},
              {"event": "model_start", "model": "m1", "t": "2026-11-01T13:10:00Z"}]
    rows = [{"model": "m1", "item_id": "Q1", "kind": "warmup", "rep": 1, "status": "ok", "load_s": 3.0},
            {"model": "m1", "item_id": "Q1", "kind": "question", "rep": 1, "status": "ok", "total_s": 2.0}]
    m = summarize.model_metrics("m1", rows, events, {}, [], {}, [], 180)
    assert not m["load_failed"] and not m["all_failed"]
    never = summarize.model_metrics("m2", [], [{"event": "model_error", "model": "m2", "t": "x"}], {}, [], {}, [], 180)
    assert never["load_failed"]


def test_all_question_calls_failed_has_its_own_reason():
    rows = [{"model": "m1", "item_id": "Q1", "kind": "warmup", "rep": 1, "status": "ok", "load_s": 3.0},
            {"model": "m1", "item_id": "Q11", "kind": "question", "rep": 1, "status": "failed", "total_s": None}]
    m = summarize.model_metrics("m1", rows, [], {"m1": {"Q11": {"score": 0, "claims": False, "kind": "question"}}},
                                [], {}, [], 180)
    assert m["all_failed"] and m["reply_median_s"] == 180
    result, _ = summarize.stage1_decision([m], CFG)
    assert result[0] == ("m1", "dropped", "all question calls failed or timed out")


def test_blind_failure_marker_does_not_reveal_the_model():
    facts = {"lines": {"service_up": ["x"]}, "explanation_incidents": []}
    rows = [{"model": "secret:3b", "item_id": "Q1", "kind": "question", "rep": 1, "status": "failed", "answer": "",
             "error": "RuntimeError: HTTP 404: model 'secret:3b' not found"}]
    sheet, _ = make_blind.build_sheet(rows, facts, [{"id": "Q1", "text": "Up?", "expected_keys": ["service_up"]}], 1)
    assert sheet[0]["answer"] == "[no answer: call failed: RuntimeError]"


def test_explanations_run_once_whatever_reps_is(tmp_path):
    ex = sf.load_explainer()
    stored = stored_incident()
    stored["facts_text"] = ex.facts_text(ex.build_facts(sf.incident_from_stored(stored)))
    facts = {"facts_text": "FACTS", "explanation_incidents": [stored]}
    its = run_bench.load_items(facts, [{"id": "Q1", "text": "Up?"}], "SYS", None, ex)
    payloads = []
    bench = run_bench.Bench(tmp_path, call=lambda p: payloads.append(p) or fake_result("What happened: x"))
    assert bench.run_model("m1", its, 3, {}) == "done"
    rows = [r for r in raw_rows(tmp_path) if r.get("kind") in ("question", "explanation")]
    assert sorted((r["item_id"], r["rep"]) for r in rows) == [("E1", 1), ("Q1", 1), ("Q1", 2), ("Q1", 3)]
    e = [r for r in rows if r["kind"] == "explanation"][0]
    assert e["request_id"] is None and "validator_pass" in e
    expl = [p for p in payloads if "seed" not in p["options"]]
    assert len(expl) == 1 and not expl[0]["messages"][-1]["content"].startswith("Request ")
    # resume: nothing is left, explanation reps 2 and 3 are never wanted
    assert run_bench.Bench(tmp_path, call=lambda p: fake_result()).run_model("m1", its, 3, {}) == "skipped"
