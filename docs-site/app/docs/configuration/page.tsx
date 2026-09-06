import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function ConfigurationPage(): React.JSX.Element {
  return (
    <>
      <h1>Configuration</h1>
      <p className="page-subtitle">
        All GioJS configuration lives in <code>gio.toml</code> at the project root.
        Every field is optional - defaults are production-ready.
      </p>

      <h2>Full reference</h2>
      <CodeBlock lang="toml" code={`[app]
name = "my-app"
router = "app"          # "app" | "pages"

[server]
host = "0.0.0.0"        # bind address
port = 3000
http2 = true            # HTTP/2 support
max_body_bytes = 2097152  # request body limit (2 MiB)

[server.tls]
enabled = false         # set true to terminate TLS in GioJS directly
cert_path = "/path/to/cert.pem"
key_path  = "/path/to/key.pem"

[[fonts]]               # self-hosted fonts, repeat per font file
family = "Inter"
url    = "/fonts/inter.woff2"
weight = 400            # default 400
style  = "normal"       # default "normal"

[images]
allowed_widths = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840]
quality = 75            # 1-100
disk_max_bytes = 536870912    # on-disk image cache cap (512 MiB)
max_remote_bytes = 20971520   # max fetched remote source size (20 MiB)

[[images.remote_patterns]]
protocol = "https"      # default "https"
hostname = "images.example.com"
pathname = "/photos/*"  # optional; exact match, or prefix with trailing *

[css]
enabled = true          # CSS pipeline
minify = true
critical_extraction = true

[websocket]
enabled = true
max_connections = 1000
ping_interval_secs = 30

[[rate_limits]]         # repeat per path rule; /_gio/image honors these too
path = "/api/*"
per_ip = 100            # requests per window (default 100)
window_seconds = 60     # default 60
burst = 20              # default 20
key_header = "x-api-key"  # optional: key on a header value instead of IP

[i18n]
locales = ["en", "de"]  # empty = i18n disabled
default_locale = "en"
detect_from = ["path", "accept-language", "cookie"]

[metrics]
enabled = false         # expose /_gio/metrics (Prometheus); off when this section is absent
token = ""              # require "Authorization: Bearer <token>" when set
ip_allowlist = []       # restrict by client IP, e.g. ["10.0.0.5"]`} />

      <h2>Health &amp; metrics</h2>
      <p>
        GioJS serves two built-in observability endpoints directly from the Rust
        layer - no Node round-trip, so they stay responsive even under load:
      </p>
      <table>
        <thead>
          <tr><th>Endpoint</th><th>Default</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>/_gio/health</code></td>
            <td>always on</td>
            <td>Liveness probe - always returns <code>200</code> with a JSON body: <code>{'{'}status, http2, tls, deploymentId, nodeReady, cacheEntries, uptimeSecs{'}'}</code>. <code>nodeReady</code> is <code>false</code> while the Node SSR worker is respawning (cached and static content still serves) - readiness probes should check that field.</td>
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

# Secure it for production - use either or both:
token        = "a-long-random-secret"     # require Authorization: Bearer <token>
ip_allowlist = ["10.0.0.5", "10.0.0.6"]   # only allow these client IPs`} />
      <CodeBlock lang="bash" code={`# Scrape with a token:
curl -H "Authorization: Bearer a-long-random-secret" \\
  http://localhost:3000/_gio/metrics`} />
      <div className="callout">
        In production (<code>NODE_ENV</code> not <code>development</code>), GioJS
        logs a warning at startup when neither <code>token</code> nor
        <code>ip_allowlist</code> is set - unauthenticated metrics are fine on
        localhost but should never face the public internet.
      </div>

      <h2>Environment variables</h2>
      <p>
        A few runtime knobs live in the environment rather than
        <code>gio.toml</code> (the listen host and port are configured in
        <code>[server]</code>, not via env):
      </p>
      <table>
        <thead>
          <tr><th>Variable</th><th>Description</th><th>Default</th></tr>
        </thead>
        <tbody>
          <tr><td><code>GIO_APP_DIR</code></td><td>Path to the <code>app/</code> directory; <code>gio.toml</code> is loaded from its parent</td><td>app</td></tr>
          <tr><td><code>GIO_DEPLOYMENT_ID</code></td><td>Pin the deployment ID across pods (otherwise derived from the build content)</td><td>content-derived</td></tr>
          <tr><td><code>GIO_SOCKET_PATH</code></td><td>Rust-to-Node IPC path; the server passes the resolved value to the Node worker</td><td><code>.gio/ipc.sock</code> (Unix), unique named pipe (Windows)</td></tr>
          <tr><td><code>GIO_SITE_URL</code></td><td>Absolute base URL for <code>sitemap.xml</code> during <code>gio export</code></td><td>unset</td></tr>
          <tr><td><code>NODE_ENV</code></td><td><code>development</code> enables dev mode (file watcher, dev endpoints)</td><td>unset</td></tr>
          <tr><td><code>RUST_LOG</code></td><td>Rust log filter (info/debug/trace)</td><td>info</td></tr>
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
        Rust cache layer - the standard sentinel for "cache indefinitely."
      </div>
    </>
  );
}
