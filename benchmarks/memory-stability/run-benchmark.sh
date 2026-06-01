#!/usr/bin/env bash
# Memory-stability benchmark: GioJS vs Next.js 15
# Runs autocannon (-c 50 -d 60) against each server 3 times,
# sampling RSS every 5 s. Writes raw files that collect.js reads.
#
# Usage: bash benchmarks/memory-stability/run-benchmark.sh
set -euo pipefail

RUNS="${RUNS:-3}"
CONNECTIONS="${CONNECTIONS:-50}"
DURATION="${DURATION:-60}"
URL="${URL:-http://localhost:3000/posts/1}"
SAMPLE_SECS="${SAMPLE_SECS:-5}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

wait_port() {
    local port=$1 timeout=${2:-60} elapsed=0
    while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
        sleep 0.5
        elapsed=$((elapsed + 1))
        if (( elapsed > timeout * 2 )); then
            echo "Timed out waiting for port $port" >&2
            return 1
        fi
    done
}

sample_memory() {
    local pid=$1 duration=$2 interval=$3 out=$4
    local elapsed=0
    > "$out"
    while (( elapsed <= duration )); do
        if [[ -r /proc/$pid/status ]]; then
            rss=$(awk '/VmRSS/ {print $2 * 1024}' /proc/$pid/status)
        else
            rss=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{print $1 * 1024}')
        fi
        echo "${elapsed}:${rss:-0}" >> "$out"
        if (( elapsed < duration )); then sleep "$interval"; fi
        elapsed=$(( elapsed + interval ))
    done
}

# ── autocannon check ──────────────────────────────────────────────────────────
if ! command -v autocannon &>/dev/null; then
    echo 'autocannon not found — installing globally...'
    npm install -g autocannon
fi

# ── GioJS runs ────────────────────────────────────────────────────────────────
echo ""
echo "=== GioJS ($RUNS runs) ==="

for run in $(seq 1 "$RUNS"); do
    echo "GioJS run $run/$RUNS..."

    cargo run --release --manifest-path "$ROOT/Cargo.toml" -p giojs-server &>/dev/null &
    GIOJS_PID=$!

    wait_port 3000
    autocannon -c "$CONNECTIONS" -d "$DURATION" "$URL" &>/dev/null &
    AC_PID=$!

    sample_memory "$GIOJS_PID" "$DURATION" "$SAMPLE_SECS" "$SCRIPT_DIR/out-giojs-$run.txt"

    wait "$AC_PID" 2>/dev/null || true
    kill "$GIOJS_PID" 2>/dev/null || true
    sleep 2
done

# ── Next.js runs ──────────────────────────────────────────────────────────────
NEXT_DIR="$SCRIPT_DIR/next-baseline"
echo ""
echo "=== Next.js 15 ($RUNS runs) ==="

if [[ ! -d "$NEXT_DIR/node_modules" ]]; then
    echo 'Installing Next.js dependencies...'
    npm install --prefix "$NEXT_DIR"
fi
if [[ ! -d "$NEXT_DIR/.next" ]]; then
    echo 'Building Next.js app...'
    npm run build --prefix "$NEXT_DIR"
fi

for run in $(seq 1 "$RUNS"); do
    echo "Next.js run $run/$RUNS..."

    node "$NEXT_DIR/node_modules/.bin/next" start &
    NEXT_PID=$!

    wait_port 3000
    autocannon -c "$CONNECTIONS" -d "$DURATION" "$URL" &>/dev/null &
    AC_PID=$!

    sample_memory "$NEXT_PID" "$DURATION" "$SAMPLE_SECS" "$SCRIPT_DIR/out-nextjs-$run.txt"

    wait "$AC_PID" 2>/dev/null || true
    kill "$NEXT_PID" 2>/dev/null || true
    sleep 2
done

echo ""
echo "Raw samples written to $SCRIPT_DIR"
echo "Run: node benchmarks/memory-stability/collect.js"
