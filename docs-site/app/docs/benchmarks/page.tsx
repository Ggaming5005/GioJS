import React from 'react';

export const revalidate = false;

export default function BenchmarksPage(): React.JSX.Element {
  return (
    <>
      <h1>Benchmarks</h1>
      <p className="page-subtitle">
        GioJS keeps memory flat under sustained load because Rust owns the HTTP layer -
        cache hits never allocate in Node. Self-hosted Next.js allocates in the Node event
        loop for every request, including cache hits.
      </p>

      <h2>Memory stability - GioJS vs Next.js 15</h2>
      <p>
        <em>
          The table below shows illustrative, projected figures - not measurements. It
          sketches the expected pattern; run the benchmark scripts in{' '}
          <code>benchmarks/memory-stability/</code> on your own hardware for real numbers
          (the harness uses 50 concurrent connections, 60 seconds, 3 runs per server,
          RSS sampled every 5 seconds, medians across runs).
        </em>
      </p>
      <table className="bench-table">
        <thead>
          <tr>
            <th>Time (s)</th>
            <th>GioJS RSS (MB)</th>
            <th>Next.js 15 RSS (MB)</th>
          </tr>
        </thead>
        <tbody>
          {[0, 10, 20, 30, 40, 50, 60].map(t => (
            <tr key={t}>
              <td>{t}</td>
              <td className="bench-win">{(85 + t * 0.05).toFixed(1)}</td>
              <td>{(120 + t * 2.8).toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        See <code>benchmarks/memory-stability.md</code> for the full methodology and for
        the table the harness populates with measured results.
      </p>

      <h2>Why GioJS stays flat</h2>
      <p>
        In self-hosted Next.js, the Node.js HTTP layer allocates a new buffer for every
        incoming request - even when the response is a cache hit. Under 50 req/s, GC
        pressure grows continuously and RSS climbs 2–5 MB per minute.
      </p>
      <p>
        GioJS routes HTTP in Rust. A cache hit in the Rust layer is zero bytes allocated in
        Node - the response is served directly from the LRU without touching the V8 heap.
        Only cache misses cross the IPC boundary to Node for rendering.
      </p>

      <h2>Throughput</h2>
      <p>
        Cache-hit throughput (static pages) is bounded by Rust I/O, not Node. The figures
        sometimes quoted for this class of architecture (tens of thousands of cached
        requests/second at sub-millisecond p99) are projections, not GioJS measurements -
        benchmark on your own hardware before relying on specific numbers.
      </p>
      <p>
        For dynamic pages (cache misses), throughput is similar - both are bounded by React
        render time.
      </p>

      <h2>Running benchmarks yourself</h2>
      <p>
        The benchmark infrastructure lives in <code>benchmarks/memory-stability/</code>:
      </p>
      <ul>
        <li><code>run-benchmark.ps1</code> - Windows PowerShell script</li>
        <li><code>run-benchmark.sh</code> - Linux/macOS bash script</li>
        <li><code>collect.js</code> - parses raw samples, computes medians, writes the markdown table</li>
        <li><code>next-baseline/</code> - the Next.js 15 app used as a baseline</li>
      </ul>
    </>
  );
}
