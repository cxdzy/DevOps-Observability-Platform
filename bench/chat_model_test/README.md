# Chat model test (Phase 6, 6B-2)

Chooses the model for the dashboard chat. Every model answers the same frozen facts snapshot, in a
separate `ollama-bench` container, so production Ollama is never reconfigured. The rules for
dropping and choosing models are fixed in `summarize.py` before the run.

| File | What it does |
|---|---|
| `snapshot_facts.py` | Read-only snapshot (InfluxDB SELECT, Prometheus instant queries). Writes `facts.json` with the values, the FACTS text and 5 incidents for the explanation test |
| `questions.json` | Q1 to Q15 with the facts.json keys that hold each answer |
| `run_bench.py` | Runs the models against `BENCH_OLLAMA_URL` and appends every call to `raw.jsonl`. Can be resumed |
| `monitor_ram.sh` | Host RAM every 5 s into `ram.csv`; below 1024 MiB available it writes `ABORT` and stops `ollama-bench` |
| `make_blind.py` | `scores_blind.csv` (shuffled, no model names) and `key.csv` |
| `summarize.py` | `summary.csv` and `summary.md`: the Chapter 4 table and the stage 1 or stage 2 rules step by step |
| `test_bench.py` | pytest, no network |

## How a call is made

- Chat questions go to `/api/chat` with stream true. The system message is
  `dashboard/server/chat/system_prompt.txt`. The user message is the FACTS block, a blank line,
  then `QUESTION: <text>`. The options are temperature 0, seed 42, num_predict 200 and num_ctx 2048.
  The chat route must build its messages the same way.
- Explanations use the explainer's own `build_facts`, `build_messages(facts, [], None)` and call
  options, with only the model swapped. They are checked with `check_explanation` on the first
  attempt. `similar=[]` means no Chroma context, which is a limitation to state.
- `think` false is sent only to models whose `/api/show` capabilities include thinking.
- Each model gets one warm-up call. Its load time is recorded as the cold load and it is not scored.
  The repetitions are the outer loop.
- A call that takes more than 180 s is recorded as a failed row. In the summary it counts as 180 s.

## Server procedure

Full commands are in section 9 of the chat plan. In short:

1. `git pull`. Stop the host injector, write the time to `injector_stopped.txt`, and unload the
   explainer model with `docker compose exec ollama ollama stop qwen2.5:1.5b`. MemAvailable must
   be at least 4.5 GB.
2. Start `ollama-bench` (image `ollama/ollama:0.35.1`, obs-net, `--memory 4g --memory-swap 4g`,
   `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`, its own volume, no published port). Pull
   the models and keep `ollama list` as `models.txt`. Failed pulls go into `pull_errors.txt` as
   `PULL FAILED <tag>`.
3. Stage 1, inside tmux:
   ```
   bash bench/chat_model_test/monitor_ram.sh $OUT1 &
   B="docker compose run --rm --no-deps --entrypoint python -v $PWD/bench/chat_model_test:/bench \
      -v $PWD/dashboard/server/chat:/chatprompt:ro -e BENCH_OLLAMA_URL=http://ollama-bench:11434 explainer"
   $B /bench/snapshot_facts.py --out /bench/results/$RUN1/facts.json
   $B /bench/run_bench.py --run /bench/results/$RUN1 --models $MODELS --items Q2,Q4,Q11,Q14,Q15 --reps 1
   kill %1
   $B /bench/make_blind.py --run /bench/results/$RUN1
   ```
   Score `scores_blind.csv` without opening `key.csv`. Use 0, 1 or 2 for `score`, and y or n for
   `claims_action`. Mark y only when the model says that it took or will take an action itself.
   An explanation that repeats the system response listed in the facts (for example "the system
   response for this tier is to restart the container") is not an action claim. Then run `$B /bench/summarize.py --run /bench/results/$RUN1 --stage 1`. It
   prints the stage 2 `--models` list.
4. Stage 2 runs in a new run folder. Copy `facts.json` and `models.txt` from stage 1 and remove the
   stage 1 losers from `ollama-bench`. Start `monitor_ram.sh`, then run
   `run_bench.py --run ... --models <stage 2 list> --reps 3` with all 15 questions and 5
   explanations. Stop the monitor and run `make_blind.py`. Restart the injector and write
   `injector_started.txt`. Score the sheet, then run `summarize.py --stage 2`.
5. Keep the `ollama-bench` volume until the chosen model is in production, then remove the
   container and the volume.

If `ABORT` appears, the monitor has stopped `ollama-bench` and exited. Check RAM, then run
`docker start ollama-bench`, delete the `ABORT` file, start `monitor_ram.sh $OUT &` again and run
the same `run_bench.py` command. Rows already in `raw.jsonl` are skipped, and the call that was cut
off runs again.

The explainer image runs as root, so the files it writes in `results/RUN/` are owned by root. Run
`sudo chown -R $USER bench/chat_model_test/results` before editing `scores_blind.csv`.

Limitation: all questions share the system prompt and the FACTS prefix, so Ollama reuses the cached
prompt and warm reply times are lower than a chat call with a fresh FACTS block. `prompt_tokens`
and `prompt_tok_s` are recorded per call for this reason.

Keep these files under `results/RUN/` for both stages: `facts.json`, `models.txt`,
`pull_errors.txt` (if any), `raw.jsonl`, `ram.csv`, the scored `scores_blind.csv`, `key.csv`,
`summary.csv` and `summary.md`.

## Tests

```
docker run --rm -v "$PWD":/repo -w /repo python:3.12 sh -c \
  "pip install -q pandas==2.2.3 requests==2.32.3 influxdb==5.3.2 pytest && \
   pytest -p no:cacheprovider -q bench/chat_model_test/test_bench.py"
```
