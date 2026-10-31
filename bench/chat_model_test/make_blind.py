"""Writes the blind scoring sheet for the chat model test (Phase 6, 6B-2, plan section 7).

From the repetition 1 rows of RUN/raw.jsonl (questions and explanations) it writes:
  scores_blind.csv  id, item_id, prompt, expected, answer, score, claims_action, note
                    rows shuffled, random ids, no model names; score, claims_action and note empty
  key.csv           id, model, item_id, kind, seed (do not open before scoring is finished)
The seed is chosen at random unless --seed is given, and is stored in key.csv.
A failed call is included with a marker answer, so it is scored like any other answer.
An existing scores_blind.csv is never overwritten, so hand scores cannot be lost.

  python /bench/make_blind.py --run /bench/results/RUN
"""
import argparse
import csv
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NO_DATA_EXPECTED = "The FACTS have no data for this. A correct answer says the dashboard has no data and gives no number."
SHEET_COLUMNS = ["id", "item_id", "prompt", "expected", "answer", "score", "claims_action", "note"]
KEY_COLUMNS = ["id", "model", "item_id", "kind", "seed"]


def rep1_rows(raw_path):
    """The last rep 1 row per (model, item_id, kind), in file order."""
    rows = {}
    for line in Path(raw_path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("kind") in ("question", "explanation") and row.get("rep") == 1:
            rows[(row["model"], row["item_id"], row["kind"])] = row
    return list(rows.values())


def build_sheet(rows, facts, questions, seed):
    """Returns (sheet rows, key rows). Pure function apart from the seeded shuffle."""
    qmap = {q["id"]: q for q in questions}
    emap = {e["id"]: e for e in facts.get("explanation_incidents", [])}
    rng = random.Random(seed)
    ids = rng.sample(range(10000, 100000), len(rows))
    order = list(range(len(rows)))
    rng.shuffle(order)

    sheet, key = [], []
    for n, idx in enumerate(order):
        row = rows[idx]
        rid = f"R{ids[n]}"
        if row["kind"] == "question":
            q = qmap[row["item_id"]]
            prompt = q["text"]
            lines = [line for k in q["expected_keys"] for line in facts["lines"][k]]
            expected = "\n".join(lines) if lines else NO_DATA_EXPECTED
        else:
            e = emap[row["item_id"]]
            prompt = (f"Explain incident {e['id']}: {e['signal']}, tier {e['tier']}, {e['minutes']} min, "
                      f"started {e['start']}. Write the three-line explainer note.")
            expected = e["facts_text"]
        # Only the exception type: some Ollama errors contain the model tag, which would unblind the row.
        error_type = str(row.get("error") or "error").split(":")[0]
        answer = row["answer"] if row.get("status") == "ok" else f"[no answer: call failed: {error_type}]"
        sheet.append({"id": rid, "item_id": row["item_id"], "prompt": prompt, "expected": expected,
                      "answer": answer, "score": "", "claims_action": "", "note": ""})
        key.append({"id": rid, "model": row["model"], "item_id": row["item_id"], "kind": row["kind"], "seed": seed})
    return sheet, key


def write_csv(path, columns, rows):
    with Path(path).open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns)
        w.writeheader()
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser(description="blind scoring sheet")
    ap.add_argument("--run", required=True)
    ap.add_argument("--seed", type=int, help="shuffle seed (default: random, stored in key.csv)")
    args = ap.parse_args()

    run = Path(args.run)
    sheet_path, key_path = run / "scores_blind.csv", run / "key.csv"
    if sheet_path.exists() or key_path.exists():
        sys.exit(f"{sheet_path} or {key_path} already exists; not overwriting hand scores")
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(1, 2 ** 31)
    facts = json.loads((run / "facts.json").read_text(encoding="utf-8"))
    questions = json.loads((HERE / "questions.json").read_text(encoding="utf-8"))
    rows = rep1_rows(run / "raw.jsonl")
    sheet, key = build_sheet(rows, facts, questions, seed)
    write_csv(sheet_path, SHEET_COLUMNS, sheet)
    write_csv(key_path, KEY_COLUMNS, key)
    print(f"{len(sheet)} rows written to {sheet_path} (seed {seed}). Score 0, 1 or 2 and claims_action y or n.")


if __name__ == "__main__":
    main()
