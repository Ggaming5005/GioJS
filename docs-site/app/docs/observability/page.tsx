import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Deployment &amp; Operations</div>
      <h1>Observability</h1>
      <p className="page-subtitle">Health checks, Prometheus metrics, request IDs and JSON logs, and the dev dashboard.</p>
      <p>Two endpoints are served directly by Rust:</p>
      <ul>
        <li><strong>/_gio/health</strong> - liveness probe, always on</li>
        <li><strong>/_gio/metrics</strong> - Prometheus metrics, opt-in via [metrics] in gio.toml</li>
      </ul>
      <CodeBlock lang="toml" code={`[metrics]
enabled = true
token = "a-long-random-secret"   # secure it for production`} />
      <h2>Metrics</h2>
      <p>
        Request series carry a <code>route</code> label: the matched route{' '}
        <em>pattern</em> (<code>/posts/:id</code>), never the raw path, so one series
        covers every post and the number of series is bounded by your routes. Cache hits
        keep the pattern of the render they replay, and a request a plugin&apos;s{' '}
        <code>onRequest</code> hook rewrote is labeled with the route it rendered.
      </p>
      <table>
        <thead>
          <tr><th>Metric</th><th>Type</th><th>Labels</th></tr>
        </thead>
        <tbody>
          <tr><td><code>gio_requests_total</code></td><td>counter</td><td><code>method</code>, <code>status</code>, <code>cache</code>, <code>route</code></td></tr>
          <tr><td><code>gio_request_duration_seconds</code></td><td>histogram</td><td><code>route</code></td></tr>
          <tr><td><code>gio_node_ipc_latency_seconds</code></td><td>histogram (Rust to Node round trip)</td><td><code>route</code></td></tr>
          <tr><td><code>gio_cache_entries</code>, <code>gio_cache_size_bytes</code></td><td>gauge</td><td>-</td></tr>
          <tr><td><code>gio_prefetch_rejected_total</code></td><td>counter</td><td>-</td></tr>
          <tr><td><code>gio_image_processed_total</code></td><td>counter</td><td><code>format</code></td></tr>
          <tr><td><code>gio_ratelimit_checked_total</code>, <code>gio_ratelimit_rejected_total</code></td><td>counter</td><td><code>path</code> (and <code>rule</code>)</td></tr>
          <tr><td><code>gio_memory_bytes</code></td><td>gauge (Rust server process only)</td><td><code>type="rss"</code></td></tr>
          <tr><td><code>gio_workers</code></td><td>gauge (Node render workers configured)</td><td>-</td></tr>
          <tr><td><code>gio_worker_ready</code></td><td>gauge (1 while the worker is connected)</td><td><code>worker</code></td></tr>
          <tr><td><code>gio_worker_in_flight</code></td><td>gauge (requests, streaming renders and SSE streams)</td><td><code>worker</code></td></tr>
          <tr><td><code>gio_worker_restarts_total</code></td><td>counter</td><td><code>worker</code></td></tr>
        </tbody>
      </table>
      <p>
        The <code>gio_worker_*</code> series carry one value per Node worker, labeled by its
        index in the pool (<code>worker=&quot;0&quot;</code> to{' '}
        <code>worker=&quot;N-1&quot;</code>, see{' '}
        <a href="/docs/configuration#render-workers">Render workers</a>): a worker whose{' '}
        <code>gio_worker_in_flight</code> stays high while the others idle is busy with
        long renders or streams, and a climbing <code>gio_worker_restarts_total</code> is a
        worker that keeps crashing. <code>gio_memory_bytes</code> measures the Rust server
        alone - each Node worker is a separate process, so watch worker memory with your
        process or container tools.
      </p>
      <p>
        Besides patterns - and the fixed paths of <code>app/sitemap.ts</code>,{' '}
        <code>app/robots.ts</code> and <code>app/manifest.ts</code> (<code>/sitemap.xml</code>,
        ...) - <code>route</code> takes three reserved values:{' '}
        <code>static</code> (public/ files, hashed chunks, app CSS), <code>internal</code>{' '}
        (the server&apos;s own <code>/_gio/*</code> endpoints) and <code>unmatched</code>{' '}
        (no app route: a 404 for an unknown path, or a render the worker never answered).{' '}
        <code>cache</code> is the tier that answered: <code>hit</code>, <code>stale</code>,{' '}
        <code>miss</code>, <code>stream</code>, <code>error</code>, <code>static</code>{' '}
        or <code>bypass</code>. Each label is bounded on its own, so request data can never
        grow the exposition without bound: a <code>method</code> other than the nine
        standard ones (<code>GET</code>, <code>POST</code>, ...) is reported as{' '}
        <code>_other</code>, and so is any route pattern past the first 1024 distinct ones
        (the reserved values always keep their name). The number of series therefore grows
        with your routes, not with traffic; a backstop of 16384{' '}
        <code>gio_requests_total</code> series, far above what an app&apos;s routes produce,
        counts anything beyond it under <code>_other</code> in every label. The rate-limit counters key by
        request path and cap at 512 values each. Slowest routes at the 95th percentile:
      </p>
      <CodeBlock lang="bash" code={`histogram_quantile(0.95,
  sum by (route, le) (rate(gio_request_duration_seconds_bucket[5m])))`} />
      <h2>Request IDs</h2>
      <p>
        Every request gets an id, returned as the <code>X-Request-Id</code> response header
        on every response - pages, cache hits, static files, redirects and errors. The same
        id ties together both processes&apos; logs. The Rust server (filtered by{' '}
        <code>RUST_LOG</code>) emits each line for the request inside a{' '}
        <code>request</code> span, which no level filter drops - at{' '}
        <code>RUST_LOG=warn</code> or <code>error</code> the warnings and errors still
        carry the id:
      </p>
      <CodeBlock lang="bash" code={`INFO request{request_id=0b8e3c52-7a1d-4f0e-9c3b-5d2a6e8f1a47}: giojs_server: request completed method=GET path=/posts/7 status=500 cache="miss"
ERROR giojs_server::ipc: Node render error [RENDER_ERROR]: Internal Server Error digest=3f9a1c0b7e2d request_id=0b8e3c52-7a1d-4f0e-9c3b-5d2a6e8f1a47`} />
      <p>
        and every JSON line the Node worker writes while handling the request carries it as{' '}
        <code>requestId</code>, alongside the error <code>digest</code> a production error page
        shows:
      </p>
      <CodeBlock lang="bash" code={`{"level":"error","msg":"ssr render failed","requestId":"0b8e3c52-7a1d-4f0e-9c3b-5d2a6e8f1a47","path":"/posts/7","digest":"3f9a1c0b7e2d","error":"connect ECONNREFUSED ..."}`} />
      <p>
        So a user&apos;s error reference leads to the worker line with the real error, and
        its <code>requestId</code> to everything else that request did. Route handlers and{' '}
        <code>getServerSideProps</code> can read the id as <code>req.requestId</code> /{' '}
        <code>ctx.requestId</code> to pass it to downstream services. Behind a trusted proxy
        (<code>[server] trusted_proxies</code>), a valid incoming <code>X-Request-Id</code>{' '}
        - nginx&apos;s <code>$request_id</code>, say - is kept, so one id spans the
        proxy&apos;s access log too; from anyone else it is replaced. Many proxies pass a
        client&apos;s own header through rather than setting one; behind those, set{' '}
        <code>accept_request_id = false</code> and GioJS generates every id. See{' '}
        <a href="/docs/configuration">Configuration</a>.
      </p>
      <p>
        Work that outlives its response keeps the id of the request that started it: a
        stale-while-revalidate refresh, the Suspense holes of a PPR cache hit and the tail
        of a streamed body log under the triggering request&apos;s id in both processes.
      </p>
      <h2>JSON logs</h2>
      <p>
        The Node worker always writes JSON lines; the Rust server writes human-readable
        text by default. For a log shipper (Loki, Datadog, CloudWatch, Elastic), switch the
        server to JSON too, in <code>gio.toml</code> or - overriding it - the environment:
      </p>
      <CodeBlock lang="toml" code={`[logging]
format = "json"   # or GIO_LOG_FORMAT=json; "text" is the default`} />
      <p>
        Both processes then emit one JSON object per line on the same stream, with the
        same core keys - <code>ts</code> (RFC 3339, UTC), <code>level</code> (lowercase),{' '}
        <code>msg</code> - plus the event&apos;s own fields. Server lines also carry{' '}
        <code>target</code> (the Rust module), and the fields of the spans they were logged
        in are flattened into the line, so every line of a request has a top-level{' '}
        <code>request_id</code>; worker lines carry the same id as <code>requestId</code>:
      </p>
      <CodeBlock lang="bash" code={`{"ts":"2026-10-06T12:00:01.204518Z","level":"info","msg":"request completed","target":"giojs_server","cache":"miss","encoding":"br","method":"GET","path":"/posts/7","prefetch":"n/a","request_id":"0b8e3c52-7a1d-4f0e-9c3b-5d2a6e8f1a47","status":"200"}
{"ts":"2026-10-06T12:00:01.198Z","level":"info","msg":"cart loaded","requestId":"0b8e3c52-7a1d-4f0e-9c3b-5d2a6e8f1a47","items":3}`} />
      <p>
        Parse <code>ts</code> as the timestamp and <code>level</code> as the severity, and
        map <code>request_id</code> and <code>requestId</code> to one field (a Loki{' '}
        <code>| json | line_format</code>, a Datadog remapper, a CloudWatch Logs Insights{' '}
        <code>coalesce(request_id, requestId)</code>) to follow a request across both
        processes. <code>RUST_LOG</code> and <code>GIO_LOG_LEVEL</code> filter the two
        sides as before. An unknown <code>format</code> in gio.toml is a startup error; an
        unknown <code>GIO_LOG_FORMAT</code> is ignored with a warning.
      </p>
      <h2>Dev dashboard</h2>
      <p>In development, /_gio/devtools shows live request logs, route manifest, cache stats, a memory sparkline, and IPC latency - generated entirely in Rust.</p>
      <p>
        The dashboard and its endpoints only answer to localhost hosts
        (<code>localhost</code>, <code>*.localhost</code>, <code>127.0.0.1</code>,{' '}
        <code>[::1]</code>), so other websites cannot read them through DNS
        rebinding, and its state and stream endpoints also refuse cross-site
        requests. To open it through another
        hostname or LAN IP, list that host under <code>[dev] allowed_hosts</code>{' '}
        - see <a href="/docs/configuration">Configuration</a>.
      </p>
      <CodeBlock lang="toml" code={`[dev]
allowed_hosts = ["192.168.1.20", "myvm.local"]`} />
    </>
  );
}
