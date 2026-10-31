"""Takes the frozen facts snapshot for the chat model test (Phase 6, 6B-2).

Read-only. InfluxDB is queried with SELECT statements only (settings from the explainer's
environment: INFLUXDB_HOST, INFLUXDB_PORT, INFLUXDB_DB) and Prometheus with instant queries over
its HTTP API (PROM_URL, default http://prometheus:9090). Nothing is written anywhere except the
output file.

facts.json holds:
  values      the structured values behind each FACTS line. service_now is the scored minute of
              "anomaly latest" (cpu_rate, memory_max_mb, latency_ms on that anomaly_score point);
              memory_max_mb is the field the normal reference uses (reference_level
              memory_max_mb_median and base_memory_max_mb), so the two are comparable
  lines       the rendered FACTS lines for each value key (questions.json expected_keys point here)
  facts_text  the full FACTS block in the format of the chat plan, section 10 (times in MYT)
  explanation_incidents  5 past incidents for the explanation test, newest first, each with the
              scored rows that the explainer's build_facts needs and the facts text it gives

Run inside the explainer image (see README.md):
  python /bench/snapshot_facts.py --out /bench/results/RUN/facts.json

The helpers load_explainer and incident_from_stored are also used by run_bench.py.
"""
import argparse
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

MYT = timezone(timedelta(hours=8))
JOB = "sample-service"
SERVICE_UP_JOB = "sample-service"
INCIDENT_HOURS = 6
RESTART_DAYS = 30
MATCH_WINDOW_MS = 120 * 1000          # same as dashboard/server/incidents.js
VALUE_KEYS = ["service_up", "anomaly_latest", "service_now", "model", "reference", "incidents_6h",
              "last_restart", "last_ci_deployment", "node_fyp_main", "node_staging"]
FOOTER = "Only the facts above are available. Logs, commit messages and metrics not listed are not available."

# The scored-row columns build_facts reads (explainer/explainer.py).
ROW_COLUMNS = ["tier_level", "tier", "signal", "signals", "action", "recent_deployment", "score",
               "cpu_rate", "memory_max_mb", "latency_ms",
               "base_cpu_rate", "base_memory_max_mb", "base_latency_ms"]
# Incidents wanted for the explanation test: (signal, tier or None for any tier, how many).
EXPLANATION_PICK = [("memory", "medium", 2), ("cpu", "low", 2), ("latency", None, 1)]

NODE_JOBS = 'job=~"node-exporter|node-exporter-old"'
ROOT_FS = 'mountpoint="/",fstype!~"tmpfs|overlay"'
PROM_QUERIES = {
    "service_up": f'up{{job="{SERVICE_UP_JOB}"}}',
    "node_up": f"up{{{NODE_JOBS}}}",
    "mem_total": f"node_memory_MemTotal_bytes{{{NODE_JOBS}}}",
    "mem_available": f"node_memory_MemAvailable_bytes{{{NODE_JOBS}}}",
    "disk_size": f"node_filesystem_size_bytes{{{NODE_JOBS},{ROOT_FS}}}",
    "disk_available": f"node_filesystem_avail_bytes{{{NODE_JOBS},{ROOT_FS}}}",
    "containers": 'count by (job) (count by (job, name) (container_memory_working_set_bytes{job=~"cadvisor|cadvisor-old",name!=""}))',
}
NODES = [("node_fyp_main", "node-exporter", "cadvisor"), ("node_staging", "node-exporter-old", "cadvisor-old")]


# ------------------------------------------------------------------ shared helpers

def _candidates(env_name, container_path, repo_parts):
    paths = []
    if os.environ.get(env_name):
        paths.append(Path(os.environ[env_name]))
    paths.append(Path(container_path))
    try:
        paths.append(Path(__file__).resolve().parents[2].joinpath(*repo_parts))
    except IndexError:
        pass
    return paths


def load_explainer():
    """Imports explainer/explainer.py by file path (/app/explainer.py in the explainer image).
    The import has no side effects: Chroma and the database clients are only created in main()."""
    for path in _candidates("EXPLAINER_PY", "/app/explainer.py", ("explainer", "explainer.py")):
        if path.is_file():
            spec = importlib.util.spec_from_file_location("explainer", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    raise SystemExit("explainer.py not found (set EXPLAINER_PY)")


def find_file(env_name, container_path, repo_parts):
    for path in _candidates(env_name, container_path, repo_parts):
        if path.is_file():
            return path
    raise SystemExit(f"{repo_parts[-1]} not found (set {env_name})")


def incident_from_stored(stored):
    """Rebuilds the incident dict build_facts expects from a facts.json explanation incident."""
    import pandas as pd
    df = pd.DataFrame(stored["rows"])
    for column in df.columns:
        if column != "time" and column not in ("tier", "signal", "signals", "action"):
            df[column] = pd.to_numeric(df[column], errors="coerce")
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df = df.set_index("time").sort_index()
    return {"start": pd.Timestamp(stored["start"]), "end": pd.Timestamp(stored["end"]), "rows": df}


# ------------------------------------------------------------------ rendering

def to_myt(ms):
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).astimezone(MYT)


def fmt_time(ms, snapshot):
    """HH:MM on the snapshot's MYT day, otherwise HH:MM D Mon (for example 03:01 31 Oct)."""
    t = to_myt(ms)
    if t.date() == snapshot.astimezone(MYT).date():
        return t.strftime("%H:%M")
    return f"{t.strftime('%H:%M')} {t.day} {t.strftime('%b')}"


def yes_no(value):
    return "no data" if value is None else ("yes" if value else "no")


def _num(value, digits):
    return "no data" if value is None else f"{value:.{digits}f}"


def render_lines(values, snapshot):
    """Rendered FACTS lines per value key. Pure function, no I/O."""
    lines = {}
    lines["service_up"] = [f"service sample-service: up {yes_no(values.get('service_up'))}"]

    a = values.get("anomaly_latest")
    lines["anomaly_latest"] = ["anomaly latest: no data" if not a else
                               f"anomaly latest: {fmt_time(a['time_ms'], snapshot)}, score {_num(a['score'], 3)}, "
                               f"threshold {_num(a['threshold'], 3)}, flagged {yes_no(a['flagged'])}, tier {a['tier'] or 'no data'}"]

    now = values.get("service_now")
    lines["service_now"] = ["sample-service now: no data" if not now else
                            f"sample-service now: {fmt_time(now['time_ms'], snapshot)}, cpu_rate {_num(now['cpu_rate'], 4)}, "
                            f"memory {_num(now['memory_max_mb'], 0)} MB, latency {_num(now['latency_ms'], 1)} ms"]

    m = values.get("model")
    if not m or not m.get("champion"):
        lines["model"] = ["model: no data"]
    else:
        r = m.get("last_retrain")
        if not r:
            retrain = "last retraining none recorded"
        else:
            result = f"promoted v{r['new_version']}" if r["promoted"] else "kept champion"
            retrain = f"last retraining {fmt_time(r['time_ms'], snapshot)}, result {result}"
        lines["model"] = [f"model: champion {m['champion']}, threshold {_num(m['threshold'], 3)}, {retrain}"]

    ref = values.get("reference")
    lines["reference"] = ["normal reference: no data" if not ref else
                          f"normal reference: cpu_rate {_num(ref['cpu_rate'], 4)}, memory {_num(ref['memory_max_mb'], 0)} MB, "
                          f"latency {_num(ref['latency_ms'], 1)} ms"]

    inc = values.get("incidents_6h")
    if inc is None:
        lines["incidents_6h"] = [f"incidents last {INCIDENT_HOURS} h: no data"]
    else:
        t = inc["by_tier"]
        out = [f"incidents last {INCIDENT_HOURS} h: {inc['count']} (low {t['low']}, medium {t['medium']}, high {t['high']})"]
        for i in inc["items"]:
            line = (f"- {fmt_time(i['start_ms'], snapshot)}, tier {i['tier']}, signal {i['signal']}, {i['minutes']} min, "
                    f"peak {_num(i['peak_score'], 3)}, deployment {yes_no(i['deployment'])}, {i['status']}.")
            if i.get("what_happened"):
                line += f" What happened: {i['what_happened']}"
            out.append(line)
        lines["incidents_6h"] = out

    rs = values.get("last_restart")
    lines["last_restart"] = [f"last restart: none in the last {RESTART_DAYS} days" if not rs else
                             f"last restart: {fmt_time(rs['time_ms'], snapshot)}, mode {rs['mode'] or 'no data'}, "
                             f"signal {rs['signal'] or 'no data'}, service up after {yes_no(rs['service_up'])}"]

    d = values.get("last_ci_deployment")
    lines["last_ci_deployment"] = ["last CI deployment: none recorded" if not d else
                                   f"last CI deployment: {fmt_time(d['time_ms'], snapshot)}"]

    for key, name, monitored in (("node_fyp_main", "fyp-main", False), ("node_staging", "staging", True)):
        n = values.get(key) or {}
        parts = []
        if monitored:
            parts.append(f"monitored {yes_no(n.get('up'))}")
        if not monitored or n.get("up"):
            parts.append(f"memory {_num(n.get('mem_used_gib'), 1)} of {_num(n.get('mem_total_gib'), 1)} GiB")
            parts.append(f"disk {_num(n.get('disk_pct'), 0)} %")
            parts.append(f"containers {'no data' if n.get('containers') is None else int(n['containers'])}")
        lines[key] = [f"node {name}: " + ", ".join(parts)]
    return lines


def render_facts(values, snapshot):
    """Returns (facts_text, lines). The format is section 10 of the chat plan."""
    lines = render_lines(values, snapshot)
    header = f"FACTS (snapshot {snapshot.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}, times in MYT, UTC+8)"
    body = [line for key in VALUE_KEYS for line in lines[key]]
    return "\n".join([header, *body, FOOTER]), lines


# ------------------------------------------------------------------ incidents

def _flag(value):
    return value is True or value == 1 or value == "1" or value == "true"


def _float(value):
    try:
        v = float(value)
        return None if v != v else v
    except (TypeError, ValueError):
        return None


def what_happened(explanation):
    """The text after 'What happened:' in a stored explanation (newlines may be stored as \\n)."""
    if not explanation:
        return None
    for line in str(explanation).replace("\\n", "\n").split("\n"):
        m = re.match(r"\s*what happened:\s*(.*)$", line, flags=re.IGNORECASE)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return None


def merge_incidents(expl_rows, open_rows):
    """Closed (incident_explanation) and open (incident_open) rows as one list, newest first.
    Same matching as dashboard/server/incidents.js: an open row within 2 minutes of a closed
    row is the same incident."""
    items = []
    closed_times = []
    for r in expl_rows:
        if r.get("time") is None:
            continue
        closed_times.append(int(r["time"]))
        items.append({"start_ms": int(r["time"]), "tier": r.get("tier") or "none", "signal": r.get("signal") or "none",
                      "minutes": int(_float(r.get("minutes")) or 0), "peak_score": _float(r.get("peak_score")),
                      "deployment": _flag(r.get("deployment")), "status": "closed",
                      "what_happened": what_happened(r.get("explanation"))})
    for r in open_rows:
        if r.get("time") is None:
            continue
        start = int(r["time"])
        if any(abs(c - start) <= MATCH_WINDOW_MS for c in closed_times):
            continue
        items.append({"start_ms": start, "tier": r.get("tier") or "none", "signal": r.get("signal") or "none",
                      "minutes": int(_float(r.get("minutes")) or 0), "peak_score": _float(r.get("peak_score")),
                      "deployment": _flag(r.get("deployment")), "status": "open", "what_happened": None})
    items.sort(key=lambda i: -i["start_ms"])
    by_tier = {t: sum(1 for i in items if i["tier"] == t) for t in ("low", "medium", "high")}
    return {"count": len(items), "by_tier": by_tier, "items": items}


# ------------------------------------------------------------------ data access

def select_only(q):
    text = q.strip()
    if not re.match(r"(?i)^select\b", text) or re.search(r"(?i)\binto\b", text) or ";" in text:
        raise ValueError("only plain SELECT statements are allowed")
    return text


def make_influx_query():
    from influxdb import InfluxDBClient
    client = InfluxDBClient(host=os.environ.get("INFLUXDB_HOST", "influxdb"),
                            port=int(os.environ.get("INFLUXDB_PORT", "8086")),
                            database=os.environ.get("INFLUXDB_DB", "prometheus"))

    def query(q):
        return list(client.query(select_only(q), epoch="ms").get_points())
    return query


def make_prom_query(url):
    import requests

    def query(q):
        r = requests.get(f"{url}/api/v1/query", params={"query": q}, timeout=10)
        r.raise_for_status()
        body = r.json()
        if body.get("status") != "success" or body["data"]["resultType"] != "vector":
            raise RuntimeError("unexpected Prometheus response")
        return [{"labels": item["metric"], "value": _float(item["value"][1])} for item in body["data"]["result"]]
    return query


def _by_job(rows):
    out = {}
    for row in rows:
        job = row["labels"].get("job")
        if job and job not in out:
            out[job] = row["value"]
    return out


def collect_values(influx, prom):
    values = {}
    up = prom(PROM_QUERIES["service_up"])
    values["service_up"] = (up[0]["value"] == 1) if up and up[0]["value"] is not None else None

    latest = influx(f"SELECT * FROM \"anomaly_score\" WHERE \"job\" = '{JOB}' ORDER BY time DESC LIMIT 1")
    p = latest[0] if latest else None
    values["anomaly_latest"] = None if not p else {
        "time_ms": int(p["time"]), "score": _float(p.get("score")), "threshold": _float(p.get("threshold")),
        "flagged": _flag(p.get("is_anomaly")), "tier": p.get("tier")}

    # Same minute as "anomaly latest". memory_max_mb is the field the normal reference is built from.
    values["service_now"] = None if not p else {
        "time_ms": int(p["time"]), **{c: _float(p.get(c)) for c in ("cpu_rate", "memory_max_mb", "latency_ms")}}

    retrains = influx('SELECT "promoted","new_version","champion_version" FROM "model_retrain" ORDER BY time DESC LIMIT 1')
    r = retrains[0] if retrains else None
    values["model"] = None if not p else {
        "champion": p.get("model"), "threshold": _float(p.get("threshold")),
        "last_retrain": None if not r else {"time_ms": int(r["time"]), "promoted": _float(r.get("promoted")) == 1,
                                            "new_version": str(r.get("new_version") or "")}}

    # base_* on the latest scored minute is the reference the worker is using right now.
    if p and all(_float(p.get(f"base_{c}")) is not None for c in ("cpu_rate", "memory_max_mb", "latency_ms")):
        values["reference"] = {c: _float(p.get(f"base_{c}")) for c in ("cpu_rate", "memory_max_mb", "latency_ms")}
    else:
        ref = influx('SELECT * FROM "reference_level" ORDER BY time DESC LIMIT 1')
        values["reference"] = None if not ref else {c: _float(ref[0].get(f"{c}_median")) for c in ("cpu_rate", "memory_max_mb", "latency_ms")}

    expl = influx('SELECT "tier","signal","peak_score","minutes","deployment","explanation" FROM "incident_explanation" '
                  f'WHERE time > now() - {INCIDENT_HOURS}h ORDER BY time ASC')
    opened = influx('SELECT "tier","signal","peak_score","minutes","deployment" FROM "incident_open" '
                    f'WHERE time > now() - {INCIDENT_HOURS}h ORDER BY time ASC')
    values["incidents_6h"] = merge_incidents(expl, opened)

    restarts = influx('SELECT "mode","signal","service_up" FROM "remediation_action" '
                      f'WHERE time > now() - {RESTART_DAYS}d ORDER BY time DESC LIMIT 1')
    rs = restarts[0] if restarts else None
    values["last_restart"] = None if not rs else {
        "time_ms": int(rs["time"]), "mode": rs.get("mode"), "signal": rs.get("signal"),
        "service_up": None if _float(rs.get("service_up")) is None else _float(rs.get("service_up")) == 1}

    deploys = influx('SELECT "commit_sha" FROM "deployment_event" WHERE "source" = \'ci\' ORDER BY time DESC LIMIT 1')
    values["last_ci_deployment"] = {"time_ms": int(deploys[0]["time"])} if deploys else None

    prom_rows = {k: _by_job(prom(q)) for k, q in PROM_QUERIES.items() if k != "service_up"}
    for key, node_job, cadvisor_job in NODES:
        node_up = prom_rows["node_up"].get(node_job)
        total, avail = prom_rows["mem_total"].get(node_job), prom_rows["mem_available"].get(node_job)
        size, free = prom_rows["disk_size"].get(node_job), prom_rows["disk_available"].get(node_job)
        values[key] = {
            "up": None if node_up is None else node_up == 1,
            "mem_used_gib": None if total is None or avail is None else (total - avail) / 2 ** 30,
            "mem_total_gib": None if total is None else total / 2 ** 30,
            "disk_pct": None if not size or free is None else (1 - free / size) * 100,
            "containers": prom_rows["containers"].get(cadvisor_job),
        }
    return values


def _iso_ms(ms):
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def collect_explanation_incidents(influx, explainer, days):
    rows = influx('SELECT "end_time","tier","signal","minutes","explanation","source" FROM "incident_explanation" '
                  f"WHERE \"job\" = '{JOB}' AND time > now() - {int(days)}d ORDER BY time DESC")
    picked, notes = [], []
    for signal, tier, count in EXPLANATION_PICK:
        found = [r for r in rows if r.get("signal") == signal and (tier is None or r.get("tier") == tier)
                 and r.get("end_time")][:count]
        if len(found) < count:
            notes.append(f"only {len(found)} of {count} {signal} {tier or 'any tier'} incidents in the last {days} days")
        picked.extend(found)
    picked.sort(key=lambda r: -int(r["time"]))

    out = []
    for r in picked:
        start_ms = int(r["time"])
        end = datetime.fromisoformat(str(r["end_time"]).replace("Z", "+00:00")).astimezone(timezone.utc)
        end_iso = end.strftime("%Y-%m-%dT%H:%M:%SZ")      # rebuilt from the parsed time, never raw text
        scored = influx(f"SELECT * FROM \"anomaly_score\" WHERE \"job\" = '{JOB}' AND \"is_anomaly\" = 1 "
                        f"AND time >= '{_iso_ms(start_ms)}' AND time <= '{end_iso}' ORDER BY time ASC")
        if not scored:
            notes.append(f"incident at {_iso_ms(start_ms)} skipped: no scored rows found")
            continue
        stored = {
            "id": f"E{len(out) + 1}", "start": _iso_ms(start_ms), "end": end_iso,
            "signal": r.get("signal"), "tier": r.get("tier"), "minutes": int(_float(r.get("minutes")) or 0),
            "production_explanation": str(r.get("explanation") or "").replace("\\n", "\n"),
            "production_source": r.get("source"),
            "rows": [{"time": _iso_ms(int(s["time"])), **{c: s.get(c) for c in ROW_COLUMNS}} for s in scored],
        }
        facts = explainer.build_facts(incident_from_stored(stored))
        stored["facts_text"] = explainer.facts_text(facts)
        out.append(stored)
    return out, notes


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, help="path of facts.json")
    ap.add_argument("--days", type=int, default=30, help="look-back for the explanation incidents")
    args = ap.parse_args()

    out = Path(args.out)
    if out.exists():
        sys.exit(f"{out} already exists; the snapshot is taken once and not overwritten")
    explainer = load_explainer()
    influx = make_influx_query()
    prom = make_prom_query(os.environ.get("PROM_URL", "http://prometheus:9090"))

    snapshot = datetime.now(timezone.utc).replace(microsecond=0)
    values = collect_values(influx, prom)
    text, lines = render_facts(values, snapshot)
    incidents, notes = collect_explanation_incidents(influx, explainer, args.days)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"snapshot_utc": snapshot.strftime("%Y-%m-%dT%H:%M:%SZ"), "values": values,
                               "lines": lines, "facts_text": text, "explanation_incidents": incidents,
                               "notes": notes}, indent=2), encoding="utf-8")
    print(text)
    print(f"\n{len(incidents)} explanation incidents: " + ", ".join(f"{i['id']} {i['signal']} {i['tier']} {i['start']}" for i in incidents))
    for note in notes:
        print("NOTE:", note)
    print(f"written {out}")


if __name__ == "__main__":
    main()
