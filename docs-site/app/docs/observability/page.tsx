import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Deployment</div>
      <h1>Observability</h1>
      <p className="page-subtitle">Health checks, Prometheus metrics, request IDs in logs, and the dev dashboard.</p>
      <p>Two endpoints are served directly by Rust:</p>
      <ul>
        <li><strong>/_gio/health</strong> - liveness probe, always on</li>
        <li><strong>/_gio/metrics</strong> - Prometheus metrics, opt-in via [metrics] in gio.toml</li>
      </ul>
      <CodeBlock lang="toml" code={`[metrics]
enabled = true
token = "a-long-random-secret"   # secure it for production`} />
      <h2>Request IDs</h2>
      <p>
        Every request gets an id, returned as the <code>X-Request-Id</code> response header
        on every response - pages, cache hits, static files, redirects and errors. The same
        id ties together both processes&apos; logs. The Rust server (filtered by{' '}
        <code>RUST_LOG</code>) emits each line for the request inside a{' '}
        <code>request</code> span:
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
        - nginx&apos;s <code>$request_id</code>, ingress-nginx&apos;s - is kept, so one id
        spans the proxy&apos;s access log too; from anyone else it is replaced. See{' '}
        <a href="/docs/configuration">Configuration</a>.
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
