# GioJS Benchmarks

This directory holds reproducible benchmark procedures and their raw results.
Nothing here is published without a machine, a date, and a command you can
re-run yourself. See also:

- [`memory-stability.md`](./memory-stability.md) — RSS over time, GioJS vs Next.js
- [`compression-baseline.md`](./compression-baseline.md) — compression ratios/throughput

## The harness: `gio bench`

`gio bench` ships with `@gio.js/server` and is a zero-dependency HTTP load
generator (plain `node:http`, keep-alive connections). It reports requests/s,
latency p50/p90/p99/max, non-200 count, bytes/s — and the `X-Gio-Cache`
value of the last response, so a cache-hit benchmark labels itself and cannot
be silently confused with a cache-miss one.

```
gio bench <url> [--connections 32] [--duration 10] [--warmup 2]
gio bench --suite /,/public/logo.svg --base http://localhost:3000
```

- Warmup requests are sent but excluded from all statistics.
- `--suite` runs each path sequentially and prints an aligned table.
- Percentiles use nearest-rank over every recorded request (no sampling).

## Reproducing a GioJS vs `next start` comparison honestly

Numbers only mean something when both sides get the same treatment. The
procedure:

1. **Same machine, same session.** Close browsers/IDEs/background indexers.
   Plug in a laptop and disable power saving; thermal throttling mid-run
   invalidates the comparison.
2. **Same app.** Port the identical pages, data, and payload sizes. A 2 kB
   page vs a 40 kB page is a payload benchmark, not a framework benchmark.
3. **Production mode only.** `giojs-server` (GioJS has no separate build
   step) vs `next build && next start`. Never benchmark either dev server.
4. **Warm up both servers** before measuring: `gio bench` does this via
   `--warmup` (default 2 s). JIT warmup and cache population happen on both
   sides before any number is recorded.
5. **Label the cache state.** Check the printed `x-gio-cache` value. A GioJS
   cache `hit` vs an uncached Next.js render is an apples-to-oranges result —
   report it as "cached vs uncached", or benchmark a `bypass`/`miss` route
   for the apples-to-apples SSR comparison.
6. **Multiple runs, report the median.** At least 3 runs per target per
   server, interleaved (A, B, A, B, ...) so drift affects both equally.
7. **Publish the full setup:** CPU, RAM, OS, Node version, GioJS and Next.js
   versions, exact commands, and all runs — not just the best one.

Example session (run each block 3 times, alternating servers):

```
# Terminal 1: server under test (one at a time, same port)
gio start            # or: next start

# Terminal 2:
gio bench --suite /,/posts/1 --base http://localhost:3000 --connections 32 --duration 10
```

## Caveat: this is a localhost microbenchmark

`gio bench` measures server processing on loopback. It excludes real network
latency, TLS handshakes, CDN caching, and client rendering — the things that
usually dominate what a user feels. A server that is 5x faster on localhost
is not 5x faster in the field. Use these numbers to compare server
implementations under identical conditions, not to promise user-facing
speedups.

No results are checked into this directory unless they were produced by the
procedure above, with the environment recorded alongside them.
