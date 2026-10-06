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
          <tr><td><code>GIO_SOCKET_PATH</code></td><td>Rust-to-Node IPC path; the server passes the resolved value to the Node worker</td><td>per-instance <code>.gio/ipc-&lt;pid&gt;-&lt;rand&gt;.sock</code> (Unix), unique named pipe (Windows)</td></tr>
          <tr><td><code>GIO_SITE_URL</code></td><td>Absolute base URL for <code>sitemap.xml</code> during <code>gio export</code></td><td>unset</td></tr>
          <tr><td><code>NODE_ENV</code></td><td><code>development</code> enables dev mode (file watcher, dev endpoints) and selects the <code>.env.development*</code> files; anything else selects <code>.env.production*</code></td><td>unset</td></tr>
          <tr><td><code>RUST_LOG</code></td><td>Rust log filter (info/debug/trace)</td><td>info</td></tr>
          <tr><td><code>GIO_PUBLIC_*</code></td><td>Inlined into client bundles at build time (see below); every other variable is server-only</td><td>-</td></tr>
        </tbody>
      </table>

      <h2>.env files</h2>
      <p>
        The server loads <code>.env</code> files from the project root (the parent of{' '}
        <code>app/</code>) at startup - before <code>gio.toml</code> is read and before
        the Node worker starts, so both see the values. Files are applied in this order,
        and the first file to define a variable wins:
      </p>
      <table>
        <thead>
          <tr><th>Order</th><th>File</th><th>Commit it?</th></tr>
        </thead>
        <tbody>
          <tr><td>1</td><td><code>.env.{'{mode}'}.local</code></td><td>no - local overrides, secrets</td></tr>
          <tr><td>2</td><td><code>.env.local</code></td><td>no - local overrides, secrets</td></tr>
          <tr><td>3</td><td><code>.env.{'{mode}'}</code></td><td>yes - per-mode defaults</td></tr>
          <tr><td>4</td><td><code>.env</code></td><td>yes - shared defaults</td></tr>
        </tbody>
      </table>
      <p>
        <code>{'{mode}'}</code> is <code>development</code> when{' '}
        <code>NODE_ENV=development</code> and <code>production</code> otherwise. Variables
        already set in the real environment always win over every file, so deploy-time
        configuration never gets shadowed by a file left on disk. Add{' '}
        <code>.env*.local</code> to <code>.gitignore</code>.
      </p>
      <CodeBlock lang="bash" code={`# .env
DATABASE_URL="postgres://localhost/dev"
GIO_PUBLIC_API_URL=https://api.example.com

# multiline values, single quotes (no substitution), \${VAR} references
export PRIVATE_KEY="-----BEGIN KEY-----
...
-----END KEY-----"
GREETING='Hello $USER'
API_ENDPOINT=\${GIO_PUBLIC_API_URL}/v2`} />
      <ul>
        <li>The startup log lists the files it loaded - names only, never values.</li>
        <li>
          A file that exists but cannot be parsed stops startup with the file name and
          line number, like an invalid <code>gio.toml</code>.
        </li>
        <li>
          <code>NODE_ENV</code> inside a <code>.env</code> file is ignored (with a warning):
          the mode is decided before the files are read. Set it in the real environment.
        </li>
        <li>
          The files load once at startup; restart the server after editing them.
        </li>
        <li>
          <code>gio export</code> and <code>gio build standalone</code> load the same files
          with the same rules (<code>production</code> mode for standalone builds).
        </li>
      </ul>

      <h2>Environment variables in client code</h2>
      <p>
        Pages and components also run in the browser, where there is no{' '}
        <code>process.env</code>. Variables prefixed <code>GIO_PUBLIC_</code> that are set
        when the client bundles are built are inlined as string literals; every other{' '}
        <code>process.env.X</code> read in client code is <code>undefined</code>. Secrets
        can only ship to the browser if you name them <code>GIO_PUBLIC_*</code>.
      </p>
      <CodeBlock lang="tsx" code={`export default function Checkout() {
  // Inlined at build time: safe to read anywhere.
  const apiUrl = process.env.GIO_PUBLIC_API_URL;
  // Server-only: undefined in the browser. Read it in getServerSideProps.
  const key = process.env.STRIPE_SECRET_KEY;
  // ...
}`} />
      <div className="callout">
        Client bundles are built when the server starts, so a normal deploy picks up new{' '}
        <code>GIO_PUBLIC_*</code> values on restart. A standalone build freezes them at
        build time (in the client chunks and in <code>worker.js</code>, so server and client
        render the same value) - changing one needs a rebuild. Server-only variables are
        always read at runtime.
      </div>

      <h2>Keeping server code out of the browser</h2>
      <p>
        Each route's client bundle imports only the page's (and its layouts') default
        export. <code>getServerSideProps</code> and <code>getStaticPaths</code> are
        tree-shaken away in every export form - declarations,{' '}
        <code>export {'{'} loader as getServerSideProps {'}'}</code>,{' '}
        <code>export ... from './data'</code>, <code>export * from</code> - together with
        everything only they import: your helper modules, Node builtins, and npm packages
        such as database clients. Code is never rewritten as text, so strings and comments
        that look like exports are left alone. Bare side-effect imports (
        <code>import './polyfill'</code>) are kept.
      </p>
      <p>
        To turn an accidental client import into a loud error, mark server modules as
        server-only - either import the guard or name the file <code>*.server.ts</code>{' '}
        (<code>.tsx</code>, <code>.js</code>, <code>.jsx</code>):
      </p>
      <CodeBlock lang="ts" code={`// lib/db.ts
import '@gio.js/core/server-only';

export const db = createClient(process.env.DATABASE_URL);`} />
      <p>
        Using <code>db</code> from <code>getServerSideProps</code> or a{' '}
        <code>route.ts</code> handler is fine. If a component imports it, that route's
        client bundle is rejected - it is never written to disk - and the error names the
        import chain:
      </p>
      <CodeBlock lang="text" code={`client bundle for route "/dashboard" imports server-only code:
app/dashboard/page.tsx -> components/Stats.tsx -> lib/db.ts -> @gio.js/core/server-only.
The page still server-renders but will NOT hydrate (no client JS) until this import
is removed from client code.`} />
      <p>
        The error is logged at startup and, in development, shown in the error overlay when
        you open the page. Other routes are unaffected. The bare <code>server-only</code>{' '}
        specifier is recognized too, but prefer <code>@gio.js/core/server-only</code>: the
        npm <code>server-only</code> package throws when loaded outside React Server
        Components, which includes GioJS's server render.
      </p>
      <div className="callout">
        Tree-shaking can only drop code it can prove unused. A server export built by
        calling a function at module scope (
        <code>export const getServerSideProps = withAuth(async () =&gt; ...)</code>) is
        kept, because the call might have side effects - and with it the code it wraps.
        Call the wrapper inside a declaration instead (
        <code>export async function getServerSideProps(ctx) {'{'} return withAuth(ctx, load); {'}'}</code>
        ), and keep such helpers in <code>server-only</code> modules so any leak fails the
        build instead of shipping.
      </div>

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
