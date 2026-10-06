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
max_connections = 10000   # concurrent connections (see Connection limits)
tls_handshake_timeout_secs = 10
header_read_timeout_secs = 10       # slowloris guard; also the HTTP/1.1 idle timeout
request_body_timeout_secs = 30      # whole-body upload deadline, then 408
idle_timeout_secs = 60              # close connections with nothing in flight
http2_max_concurrent_streams = 250
http2_keep_alive_interval_secs = 20 # PING HTTP/2 peers this often...
http2_keep_alive_timeout_secs = 20  # ...and drop them if the ack takes longer

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

[[redirects]]           # evaluated in Rust before routing (see Middleware)
from = "/old-blog/:slug"
to = "/posts/:slug"
status = 301            # 301/302/307/308, default 302

[[rewrites]]            # serve another route without changing the URL
from = "/latest"
to = "/posts/newest"

[[headers]]             # stamp response headers on matching paths
path = "/api/*"
[headers.headers]
x-frame-options = "DENY"

[[guards]]              # cookie gate: redirect when the cookie is absent
path = "/admin/*"
require_cookie = "session"
redirect_to = "/login"

[i18n]
locales = ["en", "de"]  # empty = i18n disabled
default_locale = "en"
detect_from = ["path", "accept-language", "cookie"]

[metrics]
enabled = false         # expose /_gio/metrics (Prometheus); off when this section is absent
token = ""              # require "Authorization: Bearer <token>" when set
ip_allowlist = []       # restrict by client IP, e.g. ["10.0.0.5"]`} />

      <h2>Connection limits</h2>
      <p>
        The Rust server bounds what a single client can hold open, so slow or idle
        connections cannot exhaust it. Every field lives in <code>[server]</code>, and
        setting any of them to <code>0</code> disables that limit.
      </p>
      <table>
        <thead>
          <tr><th>Field</th><th>Default</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>max_connections</code></td><td>10000</td><td>Concurrent client connections. At the cap the server stops accepting, and new clients wait in the OS listen backlog until a connection closes. Upgraded WebSockets are not counted here; <code>[websocket] max_connections</code> caps them. Keep the process file-descriptor limit (<code>ulimit -n</code>) above this value.</td></tr>
          <tr><td><code>tls_handshake_timeout_secs</code></td><td>10</td><td>Deadline for completing the TLS handshake when <code>[server.tls]</code> is enabled.</td></tr>
          <tr><td><code>header_read_timeout_secs</code></td><td>10</td><td>Deadline for receiving a complete request head (the slowloris guard). A new connection must send its first request within it, including the HTTP/2 handshake. Because the timer restarts while an HTTP/1.1 connection waits for its next request, it is also the HTTP/1.1 keep-alive idle timeout.</td></tr>
          <tr><td><code>request_body_timeout_secs</code></td><td>30</td><td>Deadline for receiving a whole request body. A client that sends the body too slowly gets <code>408 Request Timeout</code>.</td></tr>
          <tr><td><code>idle_timeout_secs</code></td><td>60</td><td>Connections with no request in flight are closed after this long, gracefully for HTTP/2 (GOAWAY). In practice it applies to HTTP/2, because HTTP/1.1 idles are reaped by <code>header_read_timeout_secs</code> first.</td></tr>
          <tr><td><code>http2_max_concurrent_streams</code></td><td>250</td><td>Concurrent streams (requests) per HTTP/2 connection.</td></tr>
          <tr><td><code>http2_keep_alive_interval_secs</code><br /><code>http2_keep_alive_timeout_secs</code></td><td>20 / 20</td><td>The server PINGs each HTTP/2 connection on this interval and closes it if the ack does not arrive within the timeout, so dead peers are reaped. Setting either to <code>0</code> disables pings.</td></tr>
        </tbody>
      </table>
      <p>
        These deadlines never cut an established response. Streaming SSR, SSE streams and
        WebSockets stay open as long as they run: the head deadline covers only the reading
        of request heads, and a connection with a response still streaming is never idle.
      </p>
      <div className="callout">
        HTTP/1.1 responses carry <code>Keep-Alive: timeout=N</code>, so clients stop reusing
        a connection before the server closes it. Proxies and load balancers that pool
        upstream connections to GioJS (nginx <code>keepalive</code>, ingress-nginx, AWS ALB)
        ignore that hint and keep idle connections for 60 seconds by default, longer than
        the 10-second HTTP/1.1 idle close. Set the proxy&apos;s upstream idle timeout below{' '}
        <code>header_read_timeout_secs</code>, or raise both <code>header_read_timeout_secs</code>{' '}
        and <code>idle_timeout_secs</code> above the proxy&apos;s timeout (the proxy already
        absorbs slow clients). Otherwise the proxy can reuse a connection at the moment
        GioJS closes it and answer that request with a 502. The{' '}
        <a href="/docs/deployment">deployment guide</a> has settings for each proxy.
      </div>

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
          <tr><td><code>GIO_SOCKET_PATH</code></td><td>Rust-to-Node IPC path; the server passes the resolved value to the Node worker</td><td>per-instance <code>.gio/ipc-&lt;pid&gt;-&lt;rand&gt;.sock</code> (Unix), unique named pipe (Windows)</td></tr>
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
