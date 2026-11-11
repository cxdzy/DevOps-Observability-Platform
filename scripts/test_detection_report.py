"""
Tests for detection_report.py --save, with a stub InfluxDB client (no network).

Run from the repository root:  python -m unittest scripts/test_detection_report.py

The synthetic data is 180 minutes starting at 2026-11-10 23:00 UTC, so it crosses midnight:
  23:10 cpu-spike, detected (peak 0.700)
  23:30 memory-leak ramp, 600 s, detected; the trend check warns at 23:33, the model flags at 23:37 (lead 4 min)
  00:20 latency-spike, missed (peak 0.500)
  00:40 cpu-spike, detected (peak 0.680)
  00:05 one flagged minute outside every injection (a false alarm, score 0.650)
  01:30 one early-warning minute outside every injection (a false early warning)
plus one injection that did not trigger, which the report ignores.
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detection_report as dr  # noqa: E402

START = pd.Timestamp("2026-11-10T23:00:00Z")
THRESHOLD = 0.6


def stamp(text):
    return pd.Timestamp(text, tz="UTC")


def synthetic_scores():
    rows = []
    for i in range(180):
        minute = START + pd.Timedelta(minutes=i)
        rows.append({
            "time": minute.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "score": 0.30 + (i % 5) * 0.01,
            "is_anomaly": 0,
            "early_warning": 0,
            "warmup": 0,
            "cpu_rate": 0.1,
            "memory_max_mb": 100.0,
            "latency_ms": 20.0,
            "threshold": THRESHOLD,
            "model": "v10" if i < 100 else "v11",
        })
    by_time = {r["time"]: r for r in rows}

    def set_minute(text, **fields):
        by_time[stamp(text).strftime("%Y-%m-%dT%H:%M:%SZ")].update(fields)

    set_minute("2026-11-10T23:10:00Z", score=0.70, is_anomaly=1)
    set_minute("2026-11-10T23:33:00Z", early_warning=1)
    set_minute("2026-11-10T23:37:00Z", score=0.65, is_anomaly=1)
    set_minute("2026-11-10T23:38:00Z", score=0.65, is_anomaly=1)
    set_minute("2026-11-11T00:05:00Z", score=0.65, is_anomaly=1)
    set_minute("2026-11-11T00:20:00Z", score=0.50)
    set_minute("2026-11-11T00:40:00Z", score=0.68, is_anomaly=1)
    set_minute("2026-11-11T01:30:00Z", early_warning=1)
    return rows


def synthetic_truth():
    def record(time, scenario, duration, **extra):
        return {"timestamp": time, "scenario": scenario, "duration_seconds": duration, "triggered_successfully": True, **extra}

    return [
        record("2026-11-10T23:10:00+00:00", "/simulate/cpu-spike", 30),
        record("2026-11-10T23:30:00+00:00", "/simulate/memory-leak", 600, shape="ramp", ramp_up_seconds=200),
        record("2026-11-11T00:20:00+00:00", "/simulate/latency-spike", 60),
        record("2026-11-11T00:40:00+00:00", "/simulate/cpu-spike", 30),
        {"timestamp": "2026-11-11T01:00:00+00:00", "scenario": "/simulate/cpu-spike", "duration_seconds": 30, "triggered_successfully": False},
    ]


class StubClient:
    """Answers the one score query and records what is written."""

    def __init__(self, rows):
        self.rows = rows
        self.queries = []
        self.writes = []

    def query(self, text):
        self.queries.append(text)
        result = mock.Mock()
        result.get_points.return_value = iter(self.rows)
        return result

    def write_points(self, points, *args, **kwargs):
        self.writes.append(points)
        return True


class DetectionReportSaveTest(unittest.TestCase):
    def setUp(self):
        handle, self.log_path = tempfile.mkstemp(suffix=".jsonl")
        with os.fdopen(handle, "w") as f:
            for record in synthetic_truth():
                f.write(json.dumps(record) + "\n")
        self.addCleanup(os.remove, self.log_path)

    def run_main(self, args):
        client = StubClient(synthetic_scores())
        out = io.StringIO()
        fixed_now = datetime(2026, 11, 11, 4, 30, 0, 123456, tzinfo=timezone.utc)
        with mock.patch.object(dr, "InfluxDBClient", return_value=client), \
                mock.patch.object(dr, "GROUND_TRUTH_LOG", self.log_path), \
                mock.patch.object(dr, "utc_now", return_value=fixed_now), \
                contextlib.redirect_stdout(out):
            dr.main(args)
        return client, out.getvalue()

    def test_printout_is_the_same_with_and_without_save(self):
        _, plain = self.run_main(["--table"])
        client, saved = self.run_main(["--table", "--save"])
        lines = saved.rstrip("\n").split("\n")
        self.assertEqual(lines[-1], "Saved run 2026-11-11T04:30:00Z")
        self.assertEqual("\n".join(lines[:-1]) + "\n", plain)
        self.assertEqual(len(client.writes), 1)

    def test_without_save_nothing_is_written(self):
        client, plain = self.run_main([])
        self.assertEqual(client.writes, [])
        self.assertNotIn("Saved run", plain)

    def points(self):
        client, _ = self.run_main(["--save"])
        written = client.writes[0]
        for p in written:
            self.assertEqual(p["tags"]["run_id"], "2026-11-11T04:30:00Z")
        return written

    def test_run_point(self):
        run = [p for p in self.points() if p["measurement"] == "evaluation_run"]
        self.assertEqual(len(run), 1)
        self.assertEqual(run[0]["time"], datetime(2026, 11, 11, 4, 30, 0, tzinfo=timezone.utc))
        f = run[0]["fields"]
        self.assertEqual(f["since"], "2026-11-10T23:00:00Z")
        self.assertEqual(f["until"], "2026-11-11T01:59:00Z")
        self.assertEqual(f["scored_minutes"], 180)
        self.assertEqual((f["injections"], f["detected"]), (4, 3))
        self.assertAlmostEqual(f["detection_rate"], 0.75)
        self.assertEqual(f["flagged_minutes"], 5)
        self.assertEqual(f["normal_minutes"], 161)
        self.assertEqual(f["false_alarms"], 1)
        self.assertAlmostEqual(f["false_alarm_rate"], 1 / 161)
        self.assertAlmostEqual(f["top_normal_score"], 0.65)
        self.assertAlmostEqual(f["threshold"], THRESHOLD)
        self.assertAlmostEqual(f["margin"], THRESHOLD - 0.65)
        self.assertEqual(f["ramp_injections"], 1)
        self.assertEqual(f["warned_before_flag"], 1)
        self.assertAlmostEqual(f["lead_median_min"], 4)
        self.assertAlmostEqual(f["lead_max_min"], 4)
        self.assertEqual(f["false_ew_minutes"], 1)
        self.assertEqual(f["excluded"], 0)
        self.assertEqual(f["model"], "v11")
        self.assertIn("p99_normal_score", f)
        for name in ("scored_minutes", "injections", "detected", "flagged_minutes", "normal_minutes", "false_alarms",
                     "ramp_injections", "warned_before_flag", "false_ew_minutes", "excluded"):
            self.assertIsInstance(f[name], int, name)
        for name in ("detection_rate", "false_alarm_rate", "top_normal_score", "threshold", "margin", "lead_median_min"):
            self.assertIsInstance(f[name], float, name)

    def test_fault_points(self):
        faults = {p["tags"]["fault"]: p["fields"] for p in self.points() if p["measurement"] == "evaluation_fault"}
        self.assertEqual(set(faults), {"cpu-spike", "memory-leak", "latency-spike"})
        cpu = faults["cpu-spike"]
        self.assertEqual((cpu["injections"], cpu["detected"], cpu["missed"]), (2, 2, 0))
        self.assertAlmostEqual(cpu["detection_rate"], 1.0)
        self.assertAlmostEqual(cpu["median_peak_score"], 0.69)
        self.assertEqual(cpu["missed_example"], "")
        mem = faults["memory-leak"]
        self.assertEqual((mem["injections"], mem["detected"], mem["missed"]), (1, 1, 0))
        lat = faults["latency-spike"]
        self.assertEqual((lat["injections"], lat["detected"], lat["missed"]), (1, 0, 1))
        self.assertAlmostEqual(lat["detection_rate"], 0.0)
        self.assertEqual(lat["missed_example"], "2026-11-11T00:20:00Z, peak score 0.500")

    def test_day_points(self):
        days = {p["tags"]["day"]: p for p in self.points() if p["measurement"] == "evaluation_day"}
        self.assertEqual(set(days), {"2026-11-10", "2026-11-11"})
        first, second = days["2026-11-10"], days["2026-11-11"]
        self.assertEqual(first["time"], datetime(2026, 11, 10, 0, 0, tzinfo=timezone.utc))
        self.assertEqual(second["time"], datetime(2026, 11, 11, 0, 0, tzinfo=timezone.utc))
        a, b = first["fields"], second["fields"]
        self.assertEqual((a["scored_minutes"], a["normal_minutes"], a["false_alarms"], a["flagged_minutes"], a["injections"]), (60, 46, 0, 3, 2))
        self.assertAlmostEqual(a["false_alarm_rate"], 0.0)
        self.assertEqual((b["scored_minutes"], b["normal_minutes"], b["false_alarms"], b["flagged_minutes"], b["injections"]), (120, 115, 1, 2, 2))
        self.assertAlmostEqual(b["false_alarm_rate"], 1 / 115)

    def test_every_field_has_its_one_type(self):
        # InfluxDB 1.x rejects a write when a field changes type, so each field must always have the same one.
        ints, floats, texts = int, float, str
        schema = {
            "evaluation_run": {
                "since": texts, "until": texts, "model": texts,
                "scored_minutes": ints, "injections": ints, "detected": ints, "flagged_minutes": ints,
                "normal_minutes": ints, "false_alarms": ints, "ramp_injections": ints, "warned_before_flag": ints,
                "false_ew_minutes": ints, "excluded": ints,
                "detection_rate": floats, "false_alarm_rate": floats, "top_normal_score": floats,
                "p99_normal_score": floats, "threshold": floats, "margin": floats, "lead_median_min": floats,
                "lead_max_min": floats,
            },
            "evaluation_fault": {
                "injections": ints, "detected": ints, "missed": ints, "detection_rate": floats,
                "median_peak_score": floats, "missed_example": texts,
            },
            "evaluation_day": {
                "scored_minutes": ints, "normal_minutes": ints, "false_alarms": ints, "flagged_minutes": ints,
                "injections": ints, "false_alarm_rate": floats,
            },
        }
        tags = {"evaluation_run": {"run_id"}, "evaluation_fault": {"run_id", "fault"}, "evaluation_day": {"run_id", "day"}}
        written = self.points()
        self.assertEqual({p["measurement"] for p in written}, set(schema))
        for p in written:
            m = p["measurement"]
            self.assertEqual(set(p["tags"]), tags[m], m)
            self.assertTrue(set(p["fields"]) <= set(schema[m]), f"{m}: {set(p['fields']) - set(schema[m])}")
            for name, value in p["fields"].items():
                # type() rather than isinstance, so a bool or a numpy number does not pass as an int or float.
                self.assertIs(type(value), schema[m][name], f"{m}.{name} is {type(value).__name__}")
            self.assertIsInstance(p["time"], datetime)
            self.assertIsNotNone(p["time"].tzinfo)

    def test_an_excluded_period_is_counted(self):
        client, _ = self.run_main(["--save", "--exclude", "2026-11-11T00:15:00Z", "2026-11-11T00:30:00Z"])
        run = client.writes[0][0]["fields"]
        self.assertEqual(run["excluded"], 1)
        self.assertEqual(run["injections"], 3)          # the latency spike at 00:20 is left out

    def test_a_failed_write_exits_with_an_error_after_the_report(self):
        client = StubClient(synthetic_scores())
        client.write_points = mock.Mock(side_effect=ConnectionError("influxdb down"))
        out = io.StringIO()
        with mock.patch.object(dr, "InfluxDBClient", return_value=client), \
                mock.patch.object(dr, "GROUND_TRUTH_LOG", self.log_path), \
                contextlib.redirect_stdout(out):
            with self.assertRaises(ConnectionError):
                dr.main(["--save"])
        self.assertIn("Highest-scoring normal minutes", out.getvalue())
        self.assertNotIn("Saved run", out.getvalue())

    def test_fields_that_cannot_be_computed_are_left_out(self):
        # No injections at all: no detection rate, no lead time, no fault points.
        with open(self.log_path, "w") as f:
            f.write("")
        client, out = self.run_main(["--save"])
        run = client.writes[0][0]["fields"]
        for name in ("detection_rate", "lead_median_min", "lead_max_min"):
            self.assertNotIn(name, run)
        self.assertEqual(run["injections"], 0)
        self.assertEqual([p for p in client.writes[0] if p["measurement"] == "evaluation_fault"], [])
        self.assertIn("Saved run", out)


if __name__ == "__main__":
    unittest.main()
