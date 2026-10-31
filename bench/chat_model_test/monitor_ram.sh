#!/usr/bin/env bash
# RAM monitor for the chat model test (Phase 6, 6B-2). Runs on the host, next to run_bench.py.
# Every 5 s (start to start) it appends one line to RUN/ram.csv:
#   utc, ollama-bench memory in MiB (docker stats), host MemAvailable in MiB, vmstat si, vmstat so
# If MemAvailable falls below 1024 MiB it writes RUN/ABORT, stops ollama-bench and exits.
# run_bench.py sees the ABORT file and stops cleanly.
#
#   bash bench/chat_model_test/monitor_ram.sh bench/chat_model_test/results/RUN &
set -u

RUN_DIR="${1:?usage: monitor_ram.sh RUN_DIR}"
CONTAINER="${BENCH_CONTAINER:-ollama-bench}"
LIMIT_MIB="${ABORT_BELOW_MIB:-1024}"
INTERVAL="${INTERVAL_S:-5}"
OUT="$RUN_DIR/ram.csv"

mkdir -p "$RUN_DIR"
[ -s "$OUT" ] || echo "utc,bench_mib,mem_available_mib,si,so" > "$OUT"

# docker stats MemUsage looks like "1.234GiB / 4GiB"; prints the used part in MiB, or nothing.
bench_mib() {
  docker stats --no-stream --format '{{.MemUsage}}' "$CONTAINER" 2>/dev/null | awk '
    { v = $1; n = v + 0; u = v; sub(/^[0-9.]+/, "", u)
      if (u == "B") n = n / 1048576; else if (u == "KiB" || u == "kB") n = n / 1024
      else if (u == "GiB" || u == "GB") n = n * 1024; else if (u == "TiB") n = n * 1048576
      printf "%.0f", n; exit }'
}

while true; do
  started=$(date +%s)
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  avail=$(awk '/^MemAvailable:/ { printf "%.0f", $2 / 1024 }' /proc/meminfo)
  # The first vmstat line is the average since boot, so take the second sample.
  si=""; so=""
  read -r si so < <(vmstat 1 2 2>/dev/null | tail -1 | awk '{ print $7, $8 }') || true
  echo "$now,$(bench_mib),$avail,$si,$so" >> "$OUT"
  if [ -n "$avail" ] && [ "$avail" -lt "$LIMIT_MIB" ]; then
    echo "$now MemAvailable ${avail} MiB below ${LIMIT_MIB} MiB: stopping $CONTAINER" | tee "$RUN_DIR/ABORT"
    docker stop "$CONTAINER" >/dev/null 2>&1
    exit 1
  fi
  # docker stats and vmstat take about 3 s, so sleep only for the rest of the interval.
  left=$(( INTERVAL - ($(date +%s) - started) ))
  [ "$left" -gt 0 ] && sleep "$left"
done
