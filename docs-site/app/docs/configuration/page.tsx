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
ip_allowlist = []       # restrict by client IP, e.g. ["10.0.0.5"]

[dev]                   # only read when NODE_ENV=development
allowed_hosts = []      # extra Host names the /_gio/devtools endpoints answer to`} />

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

      <h2>Dev endpoints &amp; allowed hosts</h2>
      <p>
        In development the server also serves <code>/_gio/devtools</code> and
        its sub-endpoints: the dashboard, its state and event stream (which also
        drives live reload), error-overlay codeframes that return project
        source, and open-in-editor. Because the starter binds{' '}
        <code>0.0.0.0</code>, they are locked down against browser-based
        attacks:
      </p>
      <ul>
        <li>
          They only answer requests whose <code>Host</code> is{' '}
          <code>localhost</code>, <code>*.localhost</code>, a loopback IP
          (<code>127.0.0.1</code>, <code>[::1]</code>), the{' '}
          <code>[server] host</code> when it names a specific address, or an
          entry in <code>[dev] allowed_hosts</code>. Anything else gets a{' '}
          <code>403</code> - this defeats DNS rebinding, where a malicious site
          re-points its own domain at your machine.
        </li>
        <li>
          Requests a browser marks as cross-site (<code>Sec-Fetch-Site</code>,
          or an <code>Origin</code> that is not the requested host) are refused.
        </li>
        <li>
          open-in-editor accepts same-origin <code>POST</code> only, so a link
          or <code>&lt;img&gt;</code> on another site cannot launch your editor.
        </li>
      </ul>
      <p>
        If you browse the dev server from another machine or through a name -
        a VM, a container host, a phone on your LAN, a tunnel - add the
        hostname or IP you type in the address bar:
      </p>
      <CodeBlock lang="toml" code={`[dev]
allowed_hosts = ["192.168.1.20", "myvm.local", ".tunnel.example"]  # leading "." = any subdomain`} />
      <p>
        Pages themselves are unaffected; without the entry only the overlay
        codeframes, open-in-editor, live reload, and the dashboard stop working
        from that host. When bound to <code>0.0.0.0</code> with no{' '}
        <code>allowed_hosts</code>, the server logs a reminder at startup.
      </p>
      <div className="callout">
        These checks stop websites you visit, not people on your network: a
        client that can reach the port directly can send any headers. On an
        untrusted network, bind the dev server to <code>127.0.0.1</code> (or
        publish the container port to <code>127.0.0.1</code> only).
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
