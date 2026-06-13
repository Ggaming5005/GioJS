import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function ConfigurationPage(): React.JSX.Element {
  return (
    <>
      <h1>Configuration</h1>
      <p className="page-subtitle">
        All GioJS configuration lives in <code>gio.toml</code> at the project root.
        Every field is optional — defaults are production-ready.
      </p>

      <h2>Full reference</h2>
      <CodeBlock lang="toml" code={`[app]
name = "my-app"
router = "app"          # "app" | "pages"

[server]
host = "0.0.0.0"        # bind address
port = 3000

[server.tls]
enabled = false         # set true to terminate TLS in GioJS directly
cert = "/path/to/cert.pem"
key  = "/path/to/key.pem"

[cache]
memory_mb = 128         # in-process LRU size

[cache.redis]
enabled = false
url     = "redis://localhost:6379"
prefix  = "gio:prod:"

[compression]
enabled = true          # brotli + gzip negotiation

[metrics]
enabled = false         # expose /_gio/metrics (Prometheus); off by default
token = ""              # require "Authorization: Bearer <token>" when set
ip_allowlist = []       # restrict by client IP, e.g. ["10.0.0.5"]

[[images.remotePatterns]]
hostname = "images.example.com"
protocol = "https"

[[redirects]]
source      = "/old-path"
destination = "/new-path"
permanent   = true

[[rewrites]]
source      = "/api/:path*"
destination = "http://internal-api/:path*"`} />

      <h2>Health &amp; metrics</h2>
      <p>
        GioJS serves two built-in observability endpoints directly from the Rust
        layer — no Node round-trip, so they stay responsive even under load:
      </p>
      <table>
        <thead>
          <tr><th>Endpoint</th><th>Default</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>/_gio/health</code></td>
            <td>always on</td>
            <td>Liveness probe — returns <code>200</code> once the server and the Node SSR worker are ready. Point your load balancer or container healthcheck here.</td>
          </tr>
          <tr>
            <td><code>/_gio/metrics</code></td>
            <td>off</td>
            <td>Prometheus exposition (request counts, latency histograms, cache hit ratio, IPC timing). Returns <code>404</code> until enabled via <code>[metrics]</code>.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Metrics are opt-in so you never expose them by accident. Turn them on,
        and lock them down for anything beyond localhost:
      </p>
      <CodeBlock lang="toml" code={`[metrics]
enabled = true          # serve /_gio/metrics

# Secure it for production — use either or both:
token        = "a-long-random-secret"     # require Authorization: Bearer <token>
ip_allowlist = ["10.0.0.5", "10.0.0.6"]   # only allow these client IPs`} />
      <CodeBlock lang="bash" code={`# Scrape with a token:
curl -H "Authorization: Bearer a-long-random-secret" \\
  http://localhost:3000/_gio/metrics`} />
      <div className="callout">
        With <code>enabled = true</code> but no <code>token</code> or
        <code>ip_allowlist</code>, GioJS logs a warning at startup —
        unauthenticated metrics are fine on localhost but should never face the
        public internet.
      </div>

      <h2>Environment variables</h2>
      <p>Environment variables override <code>gio.toml</code> at runtime:</p>
      <table>
        <thead>
          <tr><th>Variable</th><th>Description</th><th>Default</th></tr>
        </thead>
        <tbody>
          <tr><td><code>PORT</code></td><td>HTTP listen port</td><td>3000</td></tr>
          <tr><td><code>NODE_ENV</code></td><td>Runtime mode</td><td>development</td></tr>
          <tr><td><code>GIO_CACHE_REDIS_URL</code></td><td>Redis connection URL</td><td>unset</td></tr>
          <tr><td><code>GIO_SOCKET_PATH</code></td><td>IPC socket path (Linux/macOS)</td><td>/tmp/giojs.sock</td></tr>
          <tr><td><code>RUST_LOG</code></td><td>Rust log level (info/debug/trace)</td><td>info</td></tr>
        </tbody>
      </table>

      <h2>Static page caching</h2>
      <p>
        Export <code>revalidate</code> from any page module to control caching:
      </p>
      <CodeBlock lang="typescript" code={`// Cache forever (ISR: never revalidate)
export const revalidate = false;

// Cache for 60 seconds, then revalidate
export const revalidate = 60;

// Never cache (default when not set)
// (omit the export)`} />
      <div className="callout">
        <code>revalidate = false</code> maps to a one-year TTL (31536000 seconds) in the
        Rust cache layer — the standard sentinel for "cache indefinitely."
      </div>
    </>
  );
}
