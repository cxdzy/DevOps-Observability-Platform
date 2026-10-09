"""
Explainer: plain-English incident explanations.

Every 30 seconds it
  1. reads the minutes the anomaly worker flagged (measurement "anomaly_score"),
  2. groups consecutive flagged minutes into incidents and waits until an incident
     has ended (CLOSE_AFTER_MINUTES without a new flagged minute),
  3. builds a packet of FACTS from the worker's own fields (which signal moved, by how
     much against its normal level, tier, action, recent deployment),
  4. retrieves similar past incidents from Chroma (optional),
  5. asks the local Ollama model to put the facts into three plain sentences,
  6. CHECKS the text against the facts (numbers, signal, action, deployment, forbidden
     topics, structure). If the check fails the model gets one retry, and after that a
     fixed template built from the facts is used, so a wrong explanation is never shown,
  7. logs the call (prompt, output, latency, tokens) to PostgreSQL, writes the result to
     InfluxDB as the measurement "incident_explanation", and stores the incident in Chroma.

The model never decides what happened. The worker's attribution decides that, and the
model only rewrites it. The "possible cause" is a fixed rule of thumb per signal, not a
diagnosis, and the explanations say "likely" for that reason.
"""

import json
import logging
import os
import re
import time
from datetime import timedelta

import pandas as pd
import requests
from influxdb import InfluxDBClient

INFLUXDB_HOST = os.environ.get("INFLUXDB_HOST", "influxdb")
INFLUXDB_PORT = int(os.environ.get("INFLUXDB_PORT", "8086"))
INFLUXDB_DB = os.environ.get("INFLUXDB_DB", "prometheus")
JOB = os.environ.get("JOB", "sample-service")
SCORE_MEASUREMENT = os.environ.get("SCORE_MEASUREMENT", "anomaly_score")
EXPLANATION_MEASUREMENT = os.environ.get("EXPLANATION_MEASUREMENT", "incident_explanation")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:1.5b")
LLM_TIMEOUT_S = int(os.environ.get("LLM_TIMEOUT_S", "240"))
LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", "0.2"))
LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "220"))
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "2"))

LOOP_SECONDS = int(os.environ.get("LOOP_SECONDS", "30"))
INCIDENT_GAP_MINUTES = int(os.environ.get("INCIDENT_GAP_MINUTES", "2"))    # flagged minutes this close are one incident
CLOSE_AFTER_MINUTES = int(os.environ.get("CLOSE_AFTER_MINUTES", "4"))      # an incident is explained after this quiet time
BACKFILL_HOURS = float(os.environ.get("BACKFILL_HOURS", "2"))              # history explained on the first start
MAX_PER_CYCLE = int(os.environ.get("MAX_PER_CYCLE", "3"))
SIMILAR_COUNT = int(os.environ.get("SIMILAR_COUNT", "2"))
USE_CHROMA = os.environ.get("USE_CHROMA", "1") == "1"
CHROMA_PATH = os.environ.get("CHROMA_PATH", "/data/chroma")
CHROMA_COLLECTION = os.environ.get("CHROMA_COLLECTION", "incident_memory")

# Normal levels used only when a scored minute carries no base_* fields (older points)
FALLBACK_BASE = {"cpu_rate": 0.0101, "memory_max_mb": 27.2, "latency_ms": 5.0}
SIGNAL_COLUMN = {"cpu": "cpu_rate", "memory": "memory_max_mb", "latency": "latency_ms"}

CAUSE_HINT = {
    "cpu": "a CPU-heavy task or a busy loop in the service",
    "memory": "a memory leak or a large memory allocation",
    "latency_deploy": "a slow request path, possibly a regression in the recent deployment",
    "latency": "a slow request path or an overloaded service",
    "unclear": "no single cause is clear from the metrics",
}
ACTION_TEXT = {
    "notify": "no automatic action is taken at this tier, only a notification, so keep watching the service",
    "restart": "the system response for this tier is to restart the container",
    "rollback": "the system response for this tier is to roll back to the previous image",
}

log = logging.getLogger("explainer")


# ------------------------------------------------------------------ incidents

def find_incidents(flagged):
    """Groups flagged minutes (DataFrame indexed by time) into incidents."""
    incidents = []
    if flagged.empty:
        return incidents
    flagged = flagged.sort_index()
    current = [flagged.index[0]]
    for ts in flagged.index[1:]:
        if ts - current[-1] <= timedelta(minutes=INCIDENT_GAP_MINUTES):
            current.append(ts)
        else:
            incidents.append(current)
            current = [ts]
    incidents.append(current)
    return [{"start": c[0], "end": c[-1], "rows": flagged.loc[c]} for c in incidents]


def _num(value, default=0.0):
    try:
        v = float(value)
        return default if v != v else v
    except (TypeError, ValueError):
        return default


def _text(row, key, default=""):
    value = row.get(key, default)
    return default if value is None or (isinstance(value, float) and value != value) else str(value)


def build_facts(incident):
    """The facts packet for one incident, from the worker's own fields."""
    rows = incident["rows"]
    top = rows.sort_values("tier_level", ascending=False, kind="stable").iloc[0]
    signal = _text(top, "signal", "unclear")
    if signal not in SIGNAL_COLUMN:
        signal = "unclear"
    action = _text(top, "action", "notify")
    if action not in ACTION_TEXT:
        action = "notify"
    deployed = bool(rows["recent_deployment"].fillna(0).astype(float).max()) if "recent_deployment" in rows else False

    peak, base = {}, {}
    for name, column in SIGNAL_COLUMN.items():
        peak[name] = _num(rows[column].max()) if column in rows else 0.0
        base_col = f"base_{column}"
        base[name] = _num(rows[base_col].mean(), FALLBACK_BASE[column]) if base_col in rows else FALLBACK_BASE[column]

    moved = [s for s in _text(top, "signals").split(",") if s in SIGNAL_COLUMN]
    secondary = [s for s in moved if s != signal]

    if signal == "latency":
        cause = CAUSE_HINT["latency_deploy" if deployed else "latency"]
    else:
        cause = CAUSE_HINT.get(signal, CAUSE_HINT["unclear"])

    return {
        "start": incident["start"], "end": incident["end"], "minutes": int(len(rows)),
        "tier": _text(top, "tier", "low"), "tier_level": int(_num(top.get("tier_level"), 1)),
        "action": action, "signal": signal, "secondary": secondary,
        "deployment": deployed, "cause": cause,
        "peak": peak, "base": base,
        "peak_score": round(_num(rows["score"].max()), 3) if "score" in rows else 0.0,
    }


def _fmt(signal, value):
    if signal == "cpu":
        return f"{value * 100:.0f}% of one CPU core" if value >= 0.1 else f"{value * 100:.1f}% of one CPU core"
    if signal == "memory":
        return f"{value:.0f} MB"
    return f"{value:.0f} ms"


def multiple(facts, signal):
    base = max(facts["base"][signal], 1e-9)
    ratio = facts["peak"][signal] / base
    return round(ratio) if ratio >= 10 else round(ratio, 1)


def facts_text(facts):
    sig = facts["signal"]
    lines = ["Service: sample-service (a small web API)",
             f"Incident length: {facts['minutes']} minute(s) flagged as unusual by the anomaly detector"]
    if sig in SIGNAL_COLUMN:
        lines.append(f"Main signal: {sig}, peak {_fmt(sig, facts['peak'][sig])}, normally about "
                     f"{_fmt(sig, facts['base'][sig])}, about {multiple(facts, sig)} times normal")
    else:
        lines.append("Main signal: none stands out clearly")
    for s in facts["secondary"]:
        lines.append(f"Also raised: {s}, peak {_fmt(s, facts['peak'][s])} (normally about {_fmt(s, facts['base'][s])})")
    lines.append(f"Recent deployment in the last 15 minutes: {'yes' if facts['deployment'] else 'no'}")
    lines.append(f"Severity tier: {facts['tier']}")
    lines.append(f"System response: {ACTION_TEXT[facts['action']]}")
    lines.append(f"Possible cause (rule of thumb, not a diagnosis): {facts['cause']}")
    return "\n".join(lines)


def summary_for_memory(facts):
    """One line per incident for Chroma. Built from facts, never from model output."""
    sig = facts["signal"]
    peak = f", peak {_fmt(sig, facts['peak'][sig])}" if sig in SIGNAL_COLUMN else ""
    return (f"{sig} incident, tier {facts['tier']}, {facts['minutes']} minute(s){peak}, "
            f"deployment {'yes' if facts['deployment'] else 'no'}, response: {facts['action']}")


# ------------------------------------------------------------ prompt and checks

SYSTEM_PROMPT = (
    "You write short incident notes for an operations dashboard. Rules: use ONLY the facts given, "
    "never invent numbers, names, causes or components, and do not mention anything that is not in the facts. "
    "Write exactly three lines of plain English, no markdown, in this form:\n"
    "What happened: ...\nLikely cause: ...\nNext step: ...\n"
    "Say 'likely' or 'possibly' for the cause. Keep every line under 30 words."
)

EXAMPLE_FACTS = (
    "Service: sample-service (a small web API)\n"
    "Incident length: 2 minute(s) flagged as unusual by the anomaly detector\n"
    "Main signal: memory, peak 170 MB, normally about 27 MB, about 6.3 times normal\n"
    "Recent deployment in the last 15 minutes: no\n"
    "Severity tier: medium\n"
    "System response: the system response for this tier is to restart the container\n"
    "Possible cause (rule of thumb, not a diagnosis): a memory leak or a large memory allocation"
)
EXAMPLE_NOTE = (
    "What happened: Memory use climbed to 170 MB, about 6.3 times its normal 27 MB, for 2 minutes.\n"
    "Likely cause: Likely a memory leak or a large memory allocation.\n"
    "Next step: The system response for this tier is to restart the container."
)


def build_messages(facts, similar, problems=None):
    user = f"Example facts:\n{EXAMPLE_FACTS}\n\nExample note:\n{EXAMPLE_NOTE}\n\nFacts:\n{facts_text(facts)}\n"
    if similar:
        user += ("\nSimilar past incidents (context only, do not copy their numbers):\n"
                 + "\n".join(f"- {s}" for s in similar) + "\n")
    if problems:
        user += "\nYour previous note was rejected because: " + "; ".join(problems) + ". Fix this and use only the facts.\n"
    user += "\nNote:"
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


KEYWORDS = {"cpu": ["cpu", "processor"], "memory": ["memory", "ram"],
            "latency": ["latency", "slow", "response time"]}
ACTION_WORDS = {"restart": ["restart"], "rollback": ["roll back", "rollback", "previous image"],
                "notify": ["monitor", "watch", "notification", "no automatic action", "no action"]}
FORBIDDEN = ["database", "disk", "network", "ddos", "attack", "security", "hardware", "kubernetes",
             "load balancer", "firewall", "dns", "ssl", "certificate"]
DEPLOY_WORDS = ["deployment", "deployed", "release", "new build", "code change", "rollout"]
NEGATIONS = ["no ", "not ", "without", "n't", "unnecessary", "none", "neither", "nor "]
LABELS = ["what happened:", "likely cause:", "next step:"]


def _mentions(text, words):
    return [m.start() for w in words for m in re.finditer(re.escape(w), text)]


def _positive_mention(text, words):
    """True if a word appears at least once without a negation just before it."""
    for pos in _mentions(text, words):
        before = text[max(0, pos - 28):pos]
        if not any(n in before for n in NEGATIONS):
            return True
    return False


def allowed_numbers(facts):
    numbers = {float(facts["minutes"])}
    for s in SIGNAL_COLUMN:
        for value in (facts["peak"][s], facts["base"][s]):
            if s == "cpu":
                numbers.update({round(value * 100), round(value * 100, 1)})
            else:
                numbers.add(round(value))
        base = max(facts["base"][s], 1e-9)
        ratio = facts["peak"][s] / base
        numbers.update({round(ratio), round(ratio, 1)})
    return {float(n) for n in numbers}


def check_explanation(text, facts):
    """Returns a list of problems. An empty list means the text is grounded in the facts."""
    problems = []
    low = text.lower()
    if not text.strip():
        return ["empty answer"]
    if len(text) > 700:
        problems.append("too long")
    if not all(label in low for label in LABELS):
        problems.append("it must have the three lines What happened, Likely cause and Next step")

    allowed = allowed_numbers(facts)
    for m in re.finditer(r"\d+(?:\.\d+)?", text):
        x = float(m.group())
        if not any(abs(x - a) <= max(0.5, 0.05 * a) for a in allowed):
            problems.append(f"the number {m.group()} is not in the facts")
            break

    sig = facts["signal"]
    if sig in KEYWORDS and not any(k in low for k in KEYWORDS[sig]):
        problems.append(f"it does not mention the main signal ({sig})")
    mentioned_ok = {sig, *facts["secondary"]}
    for other, words in KEYWORDS.items():
        if other not in mentioned_ok and any(w in low for w in words):
            problems.append(f"it mentions {other}, which did not move")
            break

    for word in FORBIDDEN:
        if word in low:
            problems.append(f"it mentions {word}, which is not in the facts")
            break

    action = facts["action"]
    if not _positive_mention(low, ACTION_WORDS[action]) and action != "notify":
        problems.append(f"the next step must say the response ({action})")
    for other, words in ACTION_WORDS.items():
        if other != action and other != "notify" and _positive_mention(low, words):
            problems.append(f"it mentions a {other}, but the response is {action}")
            break

    if not facts["deployment"] and _positive_mention(low, DEPLOY_WORDS):
        problems.append("it mentions a deployment, but there was none")
    if facts["deployment"] and re.search(
            r"(no|not any|without( a| any)?|not (due|related|caused)[a-z ]* (to|by)( a| the| any)?)( recent)? (deployment|release|rollout)", low):
        problems.append("it says there was no deployment, but there was one")
    return problems


def template_explanation(facts):
    """Fixed text built only from the facts. Used when the model fails the check."""
    sig = facts["signal"]
    n = facts["minutes"]
    minutes = f"{n} minute" + ("" if n == 1 else "s")
    if sig in SIGNAL_COLUMN:
        word = {"cpu": "CPU use", "memory": "Memory use", "latency": "Response time"}[sig]
        what = (f"{word} rose to {_fmt(sig, facts['peak'][sig])}, about {multiple(facts, sig)} times its normal "
                f"{_fmt(sig, facts['base'][sig])}, for {minutes}.")
    else:
        what = f"The anomaly detector flagged {minutes} as unusual, but no single signal stands out."
    cause_line = (f"Likely {facts['cause']}." if sig in SIGNAL_COLUMN
                  else "No single cause is clear from the metrics.")
    return (f"What happened: {what}\n"
            f"Likely cause: {cause_line}\n"
            f"Next step: {ACTION_TEXT[facts['action']][0].upper() + ACTION_TEXT[facts['action']][1:]}.")


# ------------------------------------------------------------------ LLM call

def call_ollama(messages):
    """Returns (text, latency_ms, total_tokens)."""
    started = time.time()
    response = requests.post(
        f"{OLLAMA_URL}/api/chat",
        json={"model": OLLAMA_MODEL, "messages": messages, "stream": False,
              "options": {"temperature": LLM_TEMPERATURE, "num_predict": LLM_MAX_TOKENS, "num_ctx": 2048}},
        timeout=LLM_TIMEOUT_S,
    )
    response.raise_for_status()
    body = response.json()
    tokens = int(body.get("prompt_eval_count", 0)) + int(body.get("eval_count", 0))
    return body["message"]["content"].strip(), (time.time() - started) * 1000.0, tokens


def explain(facts, similar, llm=call_ollama):
    """Runs the model with up to MAX_ATTEMPTS and returns a result dict."""
    problems, attempts, latency, tokens, prompt = None, 0, 0.0, 0, ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        attempts = attempt
        messages = build_messages(facts, similar, problems)
        prompt = messages[-1]["content"]
        try:
            text, ms, used = llm(messages)
        except Exception as e:
            log.warning("model call failed (%s)", e)
            problems = [f"call failed: {e}"]
            continue
        latency += ms
        tokens += used
        problems = check_explanation(text, facts)
        if not problems:
            return {"text": text, "source": "llm", "attempts": attempts, "latency_ms": latency,
                    "tokens": tokens, "problems": "", "prompt": prompt}
        log.info("attempt %d rejected: %s", attempt, "; ".join(problems))
    return {"text": template_explanation(facts), "source": "template", "attempts": attempts,
            "latency_ms": latency, "tokens": tokens, "problems": "; ".join(problems or []), "prompt": prompt}


# ------------------------------------------------------------ optional services

class Memory:
    """Past incidents in Chroma. Disabled quietly if Chroma is unavailable."""

    def __init__(self, enabled=USE_CHROMA, path=CHROMA_PATH, embedding_function=None):
        self.collection = None
        if not enabled:
            return
        try:
            import chromadb
            client = chromadb.PersistentClient(path=path)
            kwargs = {"embedding_function": embedding_function} if embedding_function else {}
            self.collection = client.get_or_create_collection(CHROMA_COLLECTION, **kwargs)
            log.info("chroma ready, %d past incidents stored", self.collection.count())
        except Exception as e:
            log.warning("chroma disabled (%s)", e)

    def similar(self, facts, n=SIMILAR_COUNT):
        if self.collection is None or self.collection.count() == 0:
            return []
        try:
            result = self.collection.query(query_texts=[summary_for_memory(facts)],
                                           n_results=min(n, self.collection.count()))
            return [f"{doc} (stored {meta.get('time', '')})"
                    for doc, meta in zip(result["documents"][0], result["metadatas"][0])]
        except Exception as e:
            log.warning("chroma query failed (%s)", e)
            return []

    def add(self, facts):
        if self.collection is None:
            return
        try:
            self.collection.upsert(
                ids=[facts["start"].isoformat()], documents=[summary_for_memory(facts)],
                metadatas=[{"tier": facts["tier"], "signal": facts["signal"], "action": facts["action"],
                            "time": facts["start"].strftime("%Y-%m-%d %H:%M"), "status": "recommended"}])
        except Exception as e:
            log.warning("chroma write failed (%s)", e)


class CallLog:
    """LLM call log in the existing langfuse.trace and langfuse.observation tables (Langfuse itself is not deployed)."""

    def __init__(self):
        self.conn = None

    def _connect(self):
        import psycopg2
        return psycopg2.connect(
            host=os.environ.get("POSTGRES_HOST", "postgres"), port=int(os.environ.get("POSTGRES_PORT", "5432")),
            user=os.environ["POSTGRES_USER"], password=os.environ["POSTGRES_PASSWORD"],
            dbname=os.environ["POSTGRES_DB"], connect_timeout=5)

    def record(self, facts, result):
        try:
            if self.conn is None or self.conn.closed:
                self.conn = self._connect()
            with self.conn, self.conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO langfuse.trace (name, timestamp_id, metadata, user_id, anomaly_score) "
                    "VALUES (%s, %s, %s, %s, %s) RETURNING id",
                    ("incident-explanation", facts["start"].tz_convert("UTC").tz_localize(None).to_pydatetime(),
                     json.dumps({"container": JOB, "tier": facts["tier"], "signal": facts["signal"],
                                 "action": facts["action"], "source": result["source"],
                                 "attempts": result["attempts"], "rejected": result["problems"]}),
                     "system", facts["peak_score"]))
                trace_id = cur.fetchone()[0]
                cur.execute(
                    "INSERT INTO langfuse.observation (trace_id, type, input, output, latency_ms, "
                    "usage_total_tokens, model, start_time) VALUES (%s, %s, %s, %s, %s, %s, %s, now())",
                    (trace_id, "generation", result["prompt"], result["text"], result["latency_ms"],
                     result["tokens"], OLLAMA_MODEL))
        except Exception as e:
            log.warning("could not log the call to PostgreSQL (%s)", e)
            self.conn = None


# ----------------------------------------------------------------- main cycle

def last_processed_end(influx):
    query = (f'SELECT "end_time" FROM "{EXPLANATION_MEASUREMENT}" WHERE "job" = \'{JOB}\' '
             f'ORDER BY time DESC LIMIT 1')
    points = list(influx.query(query).get_points())
    return pd.Timestamp(points[0]["end_time"]) if points else None


def read_flagged(influx, since):
    query = (f'SELECT * FROM "{SCORE_MEASUREMENT}" WHERE "job" = \'{JOB}\' AND "is_anomaly" = 1 '
             f"AND time > '{since.isoformat()}'")
    df = pd.DataFrame(list(influx.query(query).get_points()))
    if df.empty:
        return df
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df.set_index("time").sort_index()


def write_result(influx, facts, result, similar):
    influx.write_points([{
        "measurement": EXPLANATION_MEASUREMENT,
        "tags": {"job": JOB},
        "time": facts["start"].isoformat(),
        "fields": {
            "end_time": facts["end"].isoformat(), "minutes": facts["minutes"],
            "tier": facts["tier"], "tier_level": facts["tier_level"], "action": facts["action"],
            "signal": facts["signal"], "deployment": int(facts["deployment"]),
            "peak_score": facts["peak_score"], "explanation": result["text"],
            "source": result["source"], "attempts": result["attempts"],
            "llm_latency_ms": float(result["latency_ms"]), "tokens": int(result["tokens"]),
            "rejected": result["problems"], "model": OLLAMA_MODEL, "similar": " | ".join(similar),
        },
    }])


def run_cycle(influx, memory, call_log, llm=call_ollama, now=None):
    """Explains every closed, not yet explained incident. Returns the number explained."""
    now = now or pd.Timestamp.now(tz="UTC")
    since = last_processed_end(influx) or (now - timedelta(hours=BACKFILL_HOURS))
    flagged = read_flagged(influx, since)
    done = 0
    for incident in find_incidents(flagged):
        if incident["end"] > now - timedelta(minutes=CLOSE_AFTER_MINUTES):
            break                                   # still open
        if done >= MAX_PER_CYCLE:
            break
        facts = build_facts(incident)
        similar = memory.similar(facts)
        result = explain(facts, similar, llm)
        write_result(influx, facts, result, similar)
        call_log.record(facts, result)
        memory.add(facts)
        log.info("explained incident %s (%s, tier %s, %s after %d attempt(s)):\n%s",
                 facts["start"].strftime("%Y-%m-%d %H:%M"), facts["signal"], facts["tier"],
                 result["source"], result["attempts"], result["text"])
        done += 1
    return done


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for noisy in ("chromadb.telemetry.product.posthog", "chromadb.telemetry"):
        logging.getLogger(noisy).setLevel(logging.CRITICAL)
    log.info("starting: model=%s, ollama=%s, influx=%s:%s", OLLAMA_MODEL, OLLAMA_URL, INFLUXDB_HOST, INFLUXDB_PORT)
    influx = InfluxDBClient(host=INFLUXDB_HOST, port=INFLUXDB_PORT, database=INFLUXDB_DB)
    memory = Memory()
    call_log = CallLog()
    while True:
        started = time.time()
        try:
            run_cycle(influx, memory, call_log)
        except Exception:
            log.exception("cycle failed, will retry")
        time.sleep(max(1, LOOP_SECONDS - (time.time() - started)))


if __name__ == "__main__":
    main()
