import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

/** Every gio.toml section, with its reference page. */
const SECTIONS: { href: string; name: string; what: string }[] = [
  { href: '/docs/configuration/app', name: '[app]', what: 'Informational name and router; never read.' },
  { href: '/docs/configuration/server', name: '[server]', what: 'Listen address, connection limits and timeouts, body limit, proxies, request ids, workers, skew protection.' },
  { href: '/docs/configuration/server-tls', name: '[server.tls]', what: 'Terminate TLS in GioJS from a PEM certificate and key.' },
  { href: '/docs/configuration/security', name: '[security]', what: 'Default security headers, HSTS, Content-Security-Policy with nonces.' },
  { href: '/docs/configuration/security-csrf', name: '[security.csrf]', what: 'Cross-site request protection, trusted origins and exempt paths.' },
  { href: '/docs/configuration/security-websocket', name: '[security.websocket]', what: 'The Origin check on WebSocket upgrades.' },
  { href: '/docs/configuration/cache', name: '[cache]', what: 'The page cache: memory and disk tiers, ETags, stale-while-revalidate.' },
  { href: '/docs/configuration/compression', name: '[compression]', what: 'Brotli and gzip.' },
  { href: '/docs/configuration/prefetch', name: '[prefetch]', what: 'Per-client prefetch budgets and the prefetch switch.' },
  { href: '/docs/configuration/images', name: '[images]', what: 'The /_gio/image optimizer: widths, quality, formats, remote sources, limits.' },
  { href: '/docs/configuration/fonts', name: '[[fonts]]', what: 'Self-hosted WOFF2 fonts and their preload links.' },
  { href: '/docs/configuration/css', name: '[css]', what: 'Path-served stylesheets, minification, critical CSS.' },
  { href: '/docs/configuration/websocket', name: '[websocket]', what: 'WebSocket routes: switch, connection cap, pings.' },
  { href: '/docs/configuration/rate-limits', name: '[[rate_limits]]', what: 'Token-bucket budgets per client and path.' },
  { href: '/docs/configuration/redirects', name: '[[redirects]]', what: 'Redirect rules evaluated before routing.' },
  { href: '/docs/configuration/rewrites', name: '[[rewrites]]', what: 'Serve another route under the requested URL.' },
  { href: '/docs/configuration/headers', name: '[[headers]]', what: 'Response headers for matching paths.' },
  { href: '/docs/configuration/guards', name: '[[guards]]', what: 'Session and cookie gates.' },
  { href: '/docs/configuration/i18n', name: '[i18n]', what: 'Locales and how the request locale is detected.' },
  { href: '/docs/configuration/metrics', name: '[metrics]', what: 'The Prometheus endpoint and who may scrape it.' },
  { href: '/docs/configuration/health', name: '[health]', what: 'The /_gio/health endpoint and its details.' },
  { href: '/docs/configuration/revalidate', name: '[revalidate]', what: 'The token for POST /_gio/revalidate.' },
  { href: '/docs/configuration/logging', name: '[logging]', what: 'Text or JSON server logs.' },
  { href: '/docs/configuration/env', name: '[env]', what: 'Whether .env files are loaded.' },
  { href: '/docs/configuration/dev', name: '[dev]', what: 'Dev-only: allowed hosts, devtools, the file watcher.' },
];

/**
 * Every protection and feature that is on by default, with the value that
 * turns it off or loosens it. `warns`: startup logs a warning naming the key
 * (config_check::protections_off_warnings).
 */
const SWITCHES: { what: string; key: string; href: string; on: string; off: string; lose: string; warns: boolean }[] = [
  { what: 'CSRF protection', key: '[security.csrf] enabled', href: '/docs/configuration/security-csrf', on: 'true', off: 'false', lose: 'Other websites can send form posts and other unsafe requests with the cookies of your visitors.', warns: true },
  { what: 'WebSocket origin check', key: '[security.websocket] check_origin', href: '/docs/configuration/security-websocket', on: 'true', off: 'false', lose: 'Other websites can open WebSockets with the cookies of your visitors.', warns: true },
  { what: 'Default security headers', key: '[security] default_headers', href: '/docs/configuration/security', on: 'true', off: 'false', lose: 'MIME sniffing, framing by other sites and full-URL referrers come back.', warns: true },
  { what: 'HSTS while TLS is on', key: '[security] hsts', href: '/docs/configuration/security', on: 'unset', off: 'false', lose: 'Browsers may connect over plain HTTP.', warns: false },
  { what: 'Request body limit', key: '[server] max_body_bytes', href: '/docs/configuration/server', on: '2097152', off: '0', lose: 'Each body is buffered up to the 64 MiB worker message cap.', warns: true },
  { what: 'Connection cap', key: '[server] max_connections', href: '/docs/configuration/server', on: '10000', off: '0', lose: 'A connection flood can exhaust file descriptors and memory.', warns: true },
  { what: 'Connection timeouts', key: '[server] *_timeout_secs', href: '/docs/configuration/server', on: '10 to 60', off: '0', lose: 'Slow or idle clients can hold connections open.', warns: false },
  { what: 'Render timeout', key: '[server] render_timeout_secs', href: '/docs/configuration/server', on: '30', off: '0', lose: 'A render that never answers holds its connection and a worker.', warns: true },
  { what: 'HTTP/2', key: '[server] http2', href: '/docs/configuration/server', on: 'true', off: 'false', lose: 'Clients speak HTTP/1.1 only (keep it on with TLS: a known issue).', warns: false },
  { what: 'Skew protection', key: '[server] skew_protection', href: '/docs/configuration/server', on: 'true', off: 'false', lose: 'Old clients keep navigating softly against a new deployment.', warns: true },
  { what: 'Trusting no proxy', key: '[server] trusted_proxies', href: '/docs/configuration/server', on: '[]', off: '["0.0.0.0/0"]', lose: 'Any client can pick its own IP, rate-limit bucket and request id.', warns: true },
  { what: 'Rate-limit memory cap', key: '[server] rate_limit_max_buckets', href: '/docs/configuration/server', on: '100000', off: '0', lose: 'Clients rotating addresses grow memory without bound.', warns: true },
  { what: 'Per-client key cap', key: '[[rate_limits]] max_keys_per_client', href: '/docs/configuration/rate-limits', on: '64', off: '0', lose: 'One client can mint a fresh budget per key_header value.', warns: true },
  { what: 'Page cache', key: '[cache] enabled', href: '/docs/configuration/cache', on: 'true', off: 'false', lose: 'Every request renders.', warns: false },
  { what: 'Disk cache tier', key: '[cache] disk_enabled', href: '/docs/configuration/cache', on: 'true', off: 'false', lose: 'The cache is memory only and starts empty after a restart.', warns: false },
  { what: 'Page ETags', key: '[cache] etag', href: '/docs/configuration/cache', on: 'true', off: 'false', lose: 'No 304 responses for pages.', warns: false },
  { what: 'Stale-while-revalidate', key: '[cache] swr_multiplier', href: '/docs/configuration/cache', on: '10', off: '0', lose: 'A stale page renders before it is served.', warns: false },
  { what: 'Compression', key: '[compression] enabled', href: '/docs/configuration/compression', on: 'true', off: 'false', lose: 'Bigger responses.', warns: false },
  { what: 'Prefetching', key: '[prefetch] enabled', href: '/docs/configuration/prefetch', on: 'true', off: 'false', lose: 'Links load on click, not ahead of it.', warns: false },
  { what: 'Prefetch budgets', key: '[prefetch] max_concurrent, max_per_second', href: '/docs/configuration/prefetch', on: '5, 20', off: '0', lose: 'The prefetches of one client are unbounded.', warns: false },
  { what: 'Image optimizer', key: '[images] enabled', href: '/docs/configuration/images', on: 'true', off: 'false', lose: 'Images are served at full size without a srcset.', warns: false },
  { what: 'Image limits', key: '[images] max_remote_bytes, remote_timeout_secs, max_source_dimension, max_decode_bytes', href: '/docs/configuration/images', on: '20 MiB, 30, 10000, 256 MiB', off: '0', lose: 'One image can cost unbounded memory, CPU or time.', warns: true },
  { what: 'Path-served CSS', key: '[css] enabled', href: '/docs/configuration/css', on: 'true', off: 'false', lose: 'app/*.css is not served by path, and no critical CSS.', warns: false },
  { what: 'CSS minification', key: '[css] minify', href: '/docs/configuration/css', on: 'true', off: 'false', lose: 'Bigger production stylesheets.', warns: false },
  { what: 'Critical CSS', key: '[css] critical_extraction', href: '/docs/configuration/css', on: 'true', off: 'false', lose: 'No inlined first-paint CSS.', warns: false },
  { what: 'Font preload', key: '[[fonts]] preload', href: '/docs/configuration/fonts', on: 'true', off: 'false', lose: 'The font loads when text needs it.', warns: false },
  { what: 'WebSockets', key: '[websocket] enabled', href: '/docs/configuration/websocket', on: 'true', off: 'false', lose: 'No WebSocket connections: upgrades get 501.', warns: false },
  { what: 'WebSocket cap', key: '[websocket] max_connections', href: '/docs/configuration/websocket', on: '1000', off: '0', lose: 'Open sockets are unbounded.', warns: true },
  { what: 'WebSocket pings', key: '[websocket] ping_interval_secs', href: '/docs/configuration/websocket', on: '30', off: '0', lose: 'Vanished peers are noticed later.', warns: false },
  { what: 'Metrics for this machine only', key: '[metrics] ip_allowlist', href: '/docs/configuration/metrics', on: '[]', off: '["0.0.0.0/0", "::/0"]', lose: 'Anyone can scrape /_gio/metrics.', warns: true },
  { what: 'Health endpoint', key: '[health] enabled', href: '/docs/configuration/health', on: 'true', off: 'false', lose: '/_gio/health answers 404.', warns: false },
  { what: 'Health details', key: '[health] details', href: '/docs/configuration/health', on: 'true', off: 'false', lose: 'No deployment id or worker topology in the answer.', warns: false },
  { what: '.env files', key: '[env] files', href: '/docs/configuration/env', on: 'true', off: 'false', lose: 'Only the process environment counts.', warns: false },
  { what: 'Dev host check', key: '[dev] allowed_hosts', href: '/docs/configuration/dev', on: '[]', off: '["*"]', lose: 'DNS rebinding can read the dev endpoints and error details.', warns: true },
  { what: 'Devtools', key: '[dev] devtools', href: '/docs/configuration/dev', on: 'true', off: 'false', lose: 'No dashboard, codeframes, editor links or live reload.', warns: false },
  { what: 'Dev watcher', key: '[dev] watch', href: '/docs/configuration/dev', on: 'true', off: 'false', lose: 'No restart on source changes.', warns: false },
];

export const metadata: Metadata = {
  title: 'Configuration',
  description:
    'All GioJS configuration lives in gio.toml at the project root. Every field is optional - ' +
    'defaults are production-ready - and an unknown key stops the server with a hint instead ' +
    'of being ignored.',
};

export const revalidate = false;

export default function ConfigurationPage(): React.JSX.Element {
  return (
    <>
      <h1>Configuration</h1>
      <p className="page-subtitle">
        All GioJS configuration lives in <code>gio.toml</code> at the project root.
        Every field is optional - defaults are production-ready - and an unknown key stops
        the server with a hint instead of being ignored.
      </p>

      <p>
        Every protection and feature is on by default, and each one can be turned off or loosened
        here. Doing so is never silent: the protections log a warning at startup that names the key
        (see <a href="#turning-things-off">Turning things off</a>).
      </p>

      <h2 id="sections">Sections</h2>
      <p>Each section has its own reference page, with every key, its default, what <code>0</code> or <code>false</code> means and what it costs to turn off:</p>
      <table>
        <thead>
          <tr><th>Section</th><th>What it configures</th></tr>
        </thead>
        <tbody>
          {SECTIONS.map((section) => (
            <tr key={section.href}>
              <td><a href={section.href}><code>{section.name}</code></a></td>
              <td>{section.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <code>gio.config.ts</code> holds what only JavaScript can express (Node plugins); see{' '}
        <a href="#gioconfigts">gio.config.ts</a> below and <a href="/docs/gio-config">its reference</a>.
      </p>

      <h2 id="full-reference">Full reference</h2>
      <p>
        Every key GioJS reads, with its default. Every section and key is optional, and a
        partial table keeps the defaults for what it leaves out (<code>[server]</code> with
        only <code>http2 = false</code> still listens on <code>0.0.0.0:3000</code>).
      </p>
      <CodeBlock lang="toml" code={`#:schema ./node_modules/@gio.js/server/gio.schema.json

[app]                   # informational
name = "my-app"
router = "app"          # the app/ router is the only one

[server]
host = "0.0.0.0"        # IP address to bind; GIO_HOST overrides
port = 3000             # GIO_PORT, then PORT, override
http2 = true            # HTTP/2 support
max_body_bytes = 2097152  # request body limit (2 MiB); 0 = none of its own (64 MiB IPC cap)
max_connections = 10000   # concurrent connections (see Connection limits)
tls_handshake_timeout_secs = 10
header_read_timeout_secs = 10       # slowloris guard; also the HTTP/1.1 idle timeout
request_body_timeout_secs = 30      # whole-body upload deadline, then 408
render_timeout_secs = 30            # worker answer deadline, then 504; 0 = none
idle_timeout_secs = 60              # close connections with nothing in flight
http2_max_concurrent_streams = 250
http2_keep_alive_interval_secs = 20 # PING HTTP/2 peers this often...
http2_keep_alive_timeout_secs = 20  # ...and drop them if the ack takes longer
trusted_proxies = []    # reverse proxies whose forwarding headers count (see Reverse proxies)
proxy_headers = "x-forwarded"       # "x-forwarded" (X-Forwarded-*) or "forwarded" (RFC 7239)
accept_request_id = true            # keep a trusted proxy's X-Request-Id (false = always generate)
skew_protection = true  # 409 + hard reload for a client from another deployment (false = ignore)
workers = 1             # Node render processes: a count or "auto" (see Render workers)
rate_limit_max_buckets = 100000     # live [[rate_limits]] buckets kept; 0 = unlimited

[server.tls]
enabled = false         # set true to terminate TLS in GioJS directly
cert_path = "/path/to/cert.pem"
key_path  = "/path/to/key.pem"

[cache]                 # the page cache (see Caching)
enabled = true          # false: store nothing, render every request (Cache-Control unchanged)
memory_max_entries = 1000           # pages kept in memory; the disk tier holds the rest
disk_enabled = true     # false: memory only, no files written
disk_path = ".gio/cache/pages"      # relative to the project root; GIO_CACHE_DIR overrides
disk_max_bytes = 536870912          # disk tier cap (512 MiB), oldest evicted first; 0 = unbounded
etag = true             # false: no page ETags, no 304s
swr_multiplier = 10     # serve stale until 10x revalidate old; 0 = never stale

[compression]
enabled = true          # gzip / Brotli, negotiated from Accept-Encoding
min_size_bytes = 1024   # smaller bodies are sent as-is (max 65535)
prefer_brotli = true    # false = gzip only

[prefetch]              # per-client budgets for <GioLink> prefetches (429 past them)
enabled = true          # false: every prefetch gets 429, nothing prefetches
max_concurrent = 5      # in flight at once; 0 = unlimited
max_per_second = 20     # 0 = unlimited

[[fonts]]               # self-hosted fonts, repeat per font file
family = "Inter"
url    = "/fonts/inter.woff2"   # public/fonts/inter.woff2, or an https:// URL (downloaded once)
weight = 400            # default 400
style  = "normal"       # default "normal"
preload = true          # false: no preload link (fonts used below the fold)

[images]
enabled = true          # false: /_gio/image is a 404 and <GioImage> renders plain src
allowed_widths = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840]
quality = 75            # 1-100
formats = ["avif", "webp"]    # modern formats to negotiate, in order; JPEG is the fallback
disk_max_bytes = 536870912    # on-disk image cache cap (512 MiB)
max_remote_bytes = 20971520   # max fetched remote source size (20 MiB); 0 = unlimited
remote_timeout_secs = 30      # whole remote download deadline; 0 = none
max_source_dimension = 10000  # widest/tallest source decoded, in px; 0 = unlimited
max_decode_bytes = 268435456  # decoder memory per source (256 MiB); 0 = unlimited

[[images.remote_patterns]]
protocol = "https"      # default "https"
hostname = "images.example.com"
pathname = "/photos/*"  # optional; exact match, or prefix with trailing *

[css]
enabled = true          # serve app/*.css by path (imported CSS is always bundled)
minify = true           # production CSS, path-served and bundled (standalone: at build time)
critical_extraction = true

[websocket]
enabled = true
max_connections = 1000  # 0 = unlimited
ping_interval_secs = 30 # 0 = no server pings

[[rate_limits]]         # repeat per path rule; /_gio/image honors these too
path = "/api/*rest"     # rule syntax: exact, :param, trailing *rest (covers /api too)
per_ip = 100            # requests per window (default 100)
window_seconds = 60     # default 60
burst = 20              # default 20
key_header = "x-api-key"  # optional: key on a header value instead of IP
max_keys_per_client = 64  # key_header values one client may hold a budget for; 0 = unlimited

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

[[guards]]              # session gate: redirect unless the session verifies
path = "/admin/*rest"
require_session = true  # signed, unexpired gio_session (GIO_SESSION_SECRET)
redirect_to = "/login"
# require_cookie = "session"  # alone: only checks the cookie is present

[security]              # see Security
default_headers = true  # false drops nosniff, X-Frame-Options and Referrer-Policy
csp = ""                # Content-Security-Policy (unset or "" = none); "{nonce}" = fresh nonce per response
csp_report_only = ""    # same syntax, sent as Content-Security-Policy-Report-Only
# hsts                  # unset: max-age=31536000 only with [server.tls]
#                       # true | false | "raw value" | { max_age = 31536000, include_subdomains = false, preload = false }

[security.headers]      # empty by default: override ("value"), remove (""), or add headers
x-frame-options = "SAMEORIGIN"
permissions-policy = "camera=()"

[security.csrf]         # cross-site request protection, on by default
enabled = true
trusted_origins = []    # other origins allowed to POST / open WebSockets
exempt = []             # paths never checked: webhooks, OAuth form_post / SAML callbacks

[security.websocket]
check_origin = true     # WebSocket Origin check, independent of [security.csrf] enabled

[i18n]
locales = ["en", "de"]  # empty = i18n disabled
default_locale = "en"
detect_from = ["path", "accept-language", "cookie"]

[metrics]               # /_gio/metrics (Prometheus) is off while this section is absent
enabled = true          # with the section present; false = 404
token = ""              # require "Authorization: Bearer <token>" when set
ip_allowlist = []       # client IPs or CIDRs, e.g. ["10.0.0.5", "10.1.0.0/16"]; with no token
                        # either, loopback clients only; ["0.0.0.0/0", "::/0"] = everyone

[health]
enabled = true          # serve /_gio/health (false = 404)
details = true          # false: only {"status":"ok","nodeReady":...}

[env]
files = true            # load the .env files at startup; GIO_ENV_FILES=0|1 wins

[logging]
format = "text"         # "json": one JSON object per line (GIO_LOG_FORMAT overrides)

[revalidate]            # see Caching
token = ""              # enables POST /_gio/revalidate (>= 32 bytes); GIO_REVALIDATE_TOKEN wins

[dev]                   # only read when NODE_ENV=development
allowed_hosts = []      # extra Host names the /_gio/devtools endpoints answer to; ["*"] = any
devtools = true         # false: /_gio/devtools* is a 404, the overlay shows no codeframes
watch = true            # restart the worker on source changes
watch_ignore = []       # globs the dev watcher never restarts for, e.g. ["data/**", "*.db"]

[x-mytool]              # tables named x-* are left alone, for other tools
anything = "goes"`} />

      <h2 id="strict-by-design">Strict by design</h2>
      <p>
        <code>gio.toml</code> is checked against this reference when the server starts. An
        unknown section or key anywhere - a typo, or a setting from another framework - stops
        the server with the file, the line, the full key path and the closest valid key,
        instead of being silently ignored while the default you meant to change stays in
        effect:
      </p>
      <CodeBlock lang="text" code={`giojs-server: configuration error: gio.toml:12: unknown key [image] - did you mean [images]?
giojs-server: configuration error: gio.toml:14: unknown key \`images.allowed_width\` - did you mean \`images.allowed_widths\`?
giojs-server: configuration error: gio.toml:21: invalid \`server.port\`: invalid type: string "http", expected u16`} />
      <p>
        The file is named as the server found it: <code>gio.toml</code> in the directory it runs
        in, or the path next to <code>GIO_APP_DIR</code> when that variable is set.
      </p>
      <ul>
        <li>
          Wrong values fail the same way: a malformed <code>trusted_proxies</code> entry, a{' '}
          <code>host</code> that is not an IP address, an unknown <code>[logging] format</code>,
          a <code>[[guards]]</code> entry that would not protect its path, a page cache
          directory inside <code>app/</code> or <code>public/</code>.
        </li>
        <li>
          Startup reports every refusal at once - the TLS certificate, <code>[security]</code>,
          the revalidation token and local <code>[[fonts]]</code> files included - before the
          worker starts.
        </li>
        <li>
          A <code>[[redirects]]</code>, <code>[[rewrites]]</code> or <code>[[headers]]</code> rule
          that cannot be compiled is skipped with a warning instead: the server starts without it.
        </li>
      </ul>
      <p>
        Strictness itself has no switch: a setting silently ignored is worse than a server that
        refuses to start. <code>[x-*]</code> tables are the escape hatch.
      </p>

      <h3 id="x-tables">[x-*] tables</h3>
      <p>
        Top-level tables named <code>x-...</code> (<code>[x-deploy]</code>) are never read, so
        other tools can keep their settings in the same file. Anywhere else an <code>x-</code> key
        is unknown like any other, and a top-level table with another unknown name is refused with
        a hint: <code>unknown key [mytool] - tables for other tools must be named x-... ([x-mytool])</code>.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[x-deploy]
region = "eu-west-1"
replicas = 3`} />

      <h3 id="retired-keys">Retired keys</h3>
      <p>Keys earlier versions documented but never acted on are refused with what to do instead:</p>
      <table>
        <thead>
          <tr><th>Key</th><th>Instead</th></tr>
        </thead>
        <tbody>
          <tr><td><code>[cache] memory_mb</code></td><td>The memory cache is bounded by entry count: use <a href="/docs/configuration/cache"><code>memory_max_entries</code></a> (default 1000).</td></tr>
          <tr><td><code>[cache.redis]</code></td><td>There is no Redis cache backend yet: each instance keeps its own memory and disk cache. Remove the table.</td></tr>
          <tr><td><code>[css] engine</code></td><td>Lightning CSS is the only CSS engine. Remove the key.</td></tr>
          <tr><td><code>[prefetch] strategy</code></td><td>Chosen per link: <code>{'<GioLink prefetch="hover" | "viewport" | {false}>'}</code> (default <code>&quot;hover&quot;</code>). Remove the key.</td></tr>
        </tbody>
      </table>

      <h3 id="check-config">Checking a configuration</h3>
      <p>
        <code>giojs-server --check-config</code> loads the <code>.env</code> files and{' '}
        <code>gio.toml</code> exactly as startup does, runs startup&apos;s checks, prints one JSON
        report and exits - <code>0</code> when the server would start, <code>1</code> when it would
        refuse - without binding a port. It never prints a secret, so it works as a CI step.{' '}
        <code>gio doctor</code> runs it for you.
      </p>
      <CodeBlock lang="bash" code={`npx giojs-server --check-config`} />
      <p>The report is one line of JSON; formatted, with one loosened limit:</p>
      <CodeBlock lang="json" code={`{
  "cacheDir": "/srv/my-app/.gio/cache/pages",
  "configFile": "gio.toml",
  "envFiles": [".env"],
  "envFilesDisabledBy": null,
  "errors": [],
  "listen": { "host": "0.0.0.0", "port": 3000, "portSource": "default", "tls": false },
  "mode": "production",
  "ok": true,
  "proxyHeaders": "x-forwarded",
  "rateLimitRules": 0,
  "sessionGuards": 0,
  "sessionSecret": "unset",
  "sessionSecretError": null,
  "trustedProxies": 0,
  "warnings": [
    "[server] max_connections = 0: concurrent connections are unlimited - a connection flood can exhaust file descriptors and memory"
  ]
}`} />

      <h2 id="editor-autocomplete">Editor autocomplete</h2>
      <p>
        <code>@gio.js/server</code> ships a JSON Schema for <code>gio.toml</code>, generated
        from the server&apos;s own config types, so it always matches what the server accepts.
        New apps start with the line that points editors at it; add it to the top of an
        existing <code>gio.toml</code>:
      </p>
      <CodeBlock lang="toml" code={`#:schema ./node_modules/@gio.js/server/gio.schema.json`} />
      <ul>
        <li>
          <strong>VS Code:</strong> install <em>Even Better TOML</em> (
          <code>tamasfe.even-better-toml</code>). Keys and values complete, unknown keys are
          underlined and hovering a key shows its documentation.
        </li>
        <li>
          <strong>Other editors:</strong> any editor using the Taplo language server (Zed,
          Neovim, Helix) reads the same <code>#:schema</code> directive. JetBrains IDEs can map{' '}
          <code>gio.toml</code> to the schema file under{' '}
          <em>Languages &amp; Frameworks › Schemas and DTDs › JSON Schema Mappings</em>.
        </li>
      </ul>

      <h2 id="listen-address">Listen address</h2>
      <p>
        The server listens on <code>[server] host</code> and <code>port</code>, which default
        to <code>0.0.0.0</code> and <code>3000</code>. The environment wins over the file, so
        one <code>gio.toml</code> serves every environment:
      </p>
      <table>
        <thead>
          <tr><th>Setting</th><th>Precedence (first set wins)</th></tr>
        </thead>
        <tbody>
          <tr><td>Port</td><td><code>GIO_PORT</code>, then <code>PORT</code>, then <code>[server] port</code>, then <code>3000</code></td></tr>
          <tr><td>Host</td><td><code>GIO_HOST</code>, then <code>[server] host</code>, then <code>0.0.0.0</code></td></tr>
        </tbody>
      </table>
      <p>
        The host is an IP address: <code>0.0.0.0</code> (every interface),{' '}
        <code>127.0.0.1</code> (this machine only), or IPv6 in brackets (<code>[::]</code>,{' '}
        <code>[::1]</code>).
      </p>
      <p>
        <code>PORT</code> is the variable Heroku, Render, Railway, Fly.io and Cloud Run set,
        so GioJS binds where the platform expects with no configuration. A plain{' '}
        <code>HOST</code> variable is not read: shells and CI images often set it to the
        machine&apos;s hostname. Empty values are ignored, and a malformed one (a port that
        is not a number, a host that is not an IP address) stops startup. The startup log
        names the address and where the port came from (
        <code>GioJS listening on 0.0.0.0:8080 port_from=&quot;PORT&quot;</code>).
      </p>

      <h2 id="page-cache-compression-prefetch">Page cache, compression &amp; prefetch</h2>
      <p>
        In short; <a href="/docs/configuration/cache"><code>[cache]</code></a>,{' '}
        <a href="/docs/configuration/compression"><code>[compression]</code></a> and{' '}
        <a href="/docs/configuration/prefetch"><code>[prefetch]</code></a> have the details.
      </p>
      <table>
        <thead>
          <tr><th>Key</th><th>Default</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>[cache] enabled</code></td><td>true</td><td><code>false</code> stores and serves nothing from the page cache: every request renders and answers <code>X-Gio-Cache: bypass</code>. Pages still send the <code>Cache-Control</code> their <code>revalidate</code> asks for, so a CDN in front can keep caching them.</td></tr>
          <tr><td><code>[cache] memory_max_entries</code></td><td>1000</td><td>Pages kept in the in-memory LRU. Pages pushed out of memory are still served from the disk tier. At least 1: <code>enabled = false</code> is the off switch.</td></tr>
          <tr><td><code>[cache] disk_enabled</code></td><td>true</td><td><code>false</code> keeps the memory LRU only: no entry files are written, a page the LRU drops renders again, and nothing survives a restart.</td></tr>
          <tr><td><code>[cache] disk_path</code></td><td><code>.gio/cache/pages</code></td><td>The disk tier&apos;s directory, relative to the project root: a directory below the root (not <code>.</code>, not outside the project). Eviction and development-mode clears only ever delete the cache&apos;s own entry files (<code>&lt;sha256&gt;.json</code>), so other files in the directory are safe, but a dedicated directory keeps things clear. It must not be, contain or sit inside <code>app/</code> or <code>public/</code> (where entries would be served as static files); startup stops if it does. <code>GIO_CACHE_DIR</code> overrides it, may be absolute, and is held to the same rule.</td></tr>
          <tr><td><code>[cache] disk_max_bytes</code></td><td>536870912 (512 MiB)</td><td>Size cap of the disk tier; the oldest entries are evicted past it. <code>0</code> disables the cap.</td></tr>
          <tr><td><code>[cache] etag</code></td><td>true</td><td><code>false</code> sends no ETag with pages and never answers <code>304</code>, for CDNs that mishandle weak validators or apps that set their own.</td></tr>
          <tr><td><code>[cache] swr_multiplier</code></td><td>10</td><td>A page stays servable stale (while one refresh runs) until it is this many times its <code>revalidate</code> old, and the <code>stale-while-revalidate</code> directive covers the same window. <code>0</code> never serves stale and drops the directive.</td></tr>
          <tr><td><code>[compression] enabled</code></td><td>true</td><td>Compress responses with Brotli or gzip, whichever the client accepts. Images, server-sent events and responses that already carry a <code>Content-Encoding</code> are never compressed. Turn it off when a proxy or CDN in front compresses instead.</td></tr>
          <tr><td><code>[compression] min_size_bytes</code></td><td>1024</td><td>Responses with a known length below this are sent as-is. Streamed responses have no known length and are always compressed. At most 65535.</td></tr>
          <tr><td><code>[compression] prefer_brotli</code></td><td>true</td><td><code>true</code>: Brotli for clients that accept it, gzip otherwise. <code>false</code>: gzip only.</td></tr>
          <tr><td><code>[prefetch] enabled</code></td><td>true</td><td><code>false</code> answers every prefetch request <code>429</code> before it renders, which turns prefetching off site-wide.</td></tr>
          <tr><td><code>[prefetch] max_concurrent</code></td><td>5</td><td>Prefetch requests (<code>Purpose: prefetch</code>, sent by <code>{'<GioLink>'}</code>) one client may have in flight. Past it the server answers <code>429</code>, which the client treats as &quot;not prefetched&quot;. <code>0</code> = unlimited.</td></tr>
          <tr><td><code>[prefetch] max_per_second</code></td><td>20</td><td>Prefetch requests one client may start per second. <code>0</code> = unlimited.</td></tr>
        </tbody>
      </table>

      <h2 id="dev-watcher">Dev watcher</h2>
      <p>
        In development the server restarts the Node worker when source changes anywhere in
        the project. Outside <code>app/</code> only source-like files count (
        <code>.ts</code>, <code>.tsx</code>, <code>.js</code>, <code>.json</code>,{' '}
        <code>.css</code>, <code>.toml</code>, ...), so SQLite databases, logs and uploads
        your app writes never restart it - but a JSON data file (a lowdb{' '}
        <code>db.json</code>) would, after every write. List such files in{' '}
        <code>[dev] watch_ignore</code>, or set <code>[dev] watch = false</code> to run
        without the watcher at all (a huge monorepo, a network filesystem, a container out
        of inotify watches) and restart the server yourself after a change (see{' '}
        <a href="/docs/configuration/dev"><code>[dev]</code></a>):
      </p>
      <CodeBlock lang="toml" code={`[dev]
watch_ignore = ["data/**", "*.db.json", "public/uploads"]`} />
      <ul>
        <li>
          Patterns are relative to the project root. <code>*</code> matches within one path
          segment, <code>?</code> one character, and <code>**</code> any number of segments;
          every other character is literal (<code>app/[slug]/cache.json</code> names that
          route folder).
        </li>
        <li>
          A pattern without a <code>/</code> matches a file or directory name at any depth (
          <code>*.db.json</code>, <code>uploads</code>); one with a <code>/</code> is anchored
          at the root. Matching a directory covers everything in it, and{' '}
          <code>data/**</code> covers <code>data/</code> itself: a top-level directory it
          matches is not watched at all.
        </li>
        <li>
          The default is empty. <code>node_modules</code>, hidden directories (
          <code>.git</code>, <code>.gio</code>) and build output (<code>dist</code>,{' '}
          <code>build</code>, <code>out</code>, ...) are always ignored. A malformed pattern
          (<code>..</code>, a backslash) stops startup.
        </li>
        <li>
          The page cache&apos;s own entry files are never a change, wherever{' '}
          <code>[cache] disk_path</code> puts them, so a visible cache directory needs no
          pattern. Other files in that directory still count.
        </li>
      </ul>

      <h2 id="gioconfigts">gio.config.ts</h2>
      <p>
        What only JavaScript can express lives in an optional <code>gio.config.ts</code> next
        to <code>gio.toml</code>. Today that is Node plugins (<code>GioNodePlugin</code>:{' '}
        <code>onRequest</code> / <code>onResponse</code> hooks around every request the worker
        handles). <code>defineConfig</code> types it:
      </p>
      <CodeBlock lang="ts" title="gio.config.ts" code={`import { defineConfig } from '@gio.js/core';
import { auditPlugin } from './lib/audit-plugin';

export default defineConfig({
  plugins: [auditPlugin],
});`} />
      <p>
        It is checked at boot like <code>gio.toml</code>: an unknown key (<code>plugin:</code>)
        or a plugin without a <code>name</code> stops the worker with an error naming the
        file.
      </p>

      <h2 id="connection-limits">Connection limits</h2>
      <p>
        The Rust server bounds what a single client can hold open, so slow or idle
        connections cannot exhaust it. Every field lives in{' '}
        <a href="/docs/configuration/server"><code>[server]</code></a>, and setting any of them
        to <code>0</code> disables that limit.
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
          <tr><td><code>render_timeout_secs</code></td><td>30</td><td>Deadline for the Node worker&apos;s answer: a whole buffered response, the head of a streamed one, and every gap between its chunks. Past it the request answers <code>504</code>, or a streamed body ends where it is. SSE streams are not bounded by it. <code>0</code> lets a render that never answers hold its connection and a worker slot indefinitely.</td></tr>
          <tr><td><code>idle_timeout_secs</code></td><td>60</td><td>Connections with no request in flight are closed after this long, gracefully for HTTP/2 (GOAWAY). In practice it applies to HTTP/2, because HTTP/1.1 idles are reaped by <code>header_read_timeout_secs</code> first.</td></tr>
          <tr><td><code>http2_max_concurrent_streams</code></td><td>250</td><td>Concurrent streams (requests) per HTTP/2 connection.</td></tr>
          <tr><td><code>http2_keep_alive_interval_secs</code><br /><code>http2_keep_alive_timeout_secs</code></td><td>20 / 20</td><td>The server PINGs each HTTP/2 connection on this interval and closes it if the ack does not arrive within the timeout, so dead peers are reaped. Setting either to <code>0</code> disables pings.</td></tr>
        </tbody>
      </table>
      <p>
        These deadlines never cut an established response. Streaming SSR, SSE streams,
        streamed route handler responses and WebSockets stay open as long as they run: the
        head deadline covers only the reading
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

      <h2 id="render-workers">Render workers</h2>
      <p>
        Pages, <code>getServerSideProps</code> and route handlers run in a Node worker
        process the Rust server supervises. By default there is one, so all rendering
        shares one CPU core: a slow render holds up the renders queued behind it (cache
        hits, static files and images never wait - Rust serves those). To render on
        several cores, run a pool:
      </p>
      <CodeBlock lang="toml" code={`[server]
workers = 4        # or "auto": one per CPU core, at most 8`} />
      <ul>
        <li>
          Each request goes to the ready worker with the fewest requests in flight (an
          open SSE stream or a streaming response counts until it ends). A
          streaming response, an SSE stream or a Partial Prerendering hole render stays
          on the worker that started it, and each WebSocket stays on one worker for its
          lifetime. Room broadcasts (<code>broadcast(room, ...)</code>) reach sockets on
          every worker - room membership lives in the Rust server.
        </li>
        <li>
          Workers are supervised one by one: a crashed worker fails only the requests it
          had in flight (503) and is respawned while the others keep serving.
        </li>
        <li>
          Only the first worker bundles the client code into <code>.gio/build</code> and
          writes <code>.gio/routes.d.ts</code>; the others start once it is ready and
          load its build, so a pool costs no extra build time. In production a respawned
          worker reuses that build too. No worker rebuilds while others serve from{' '}
          <code>.gio/build</code>: one that cannot load the build fails its boot and is
          retried, and a first worker that cannot record its build stops startup.
        </li>
        <li>
          Every worker loads the same app, and the middleware rules of{' '}
          <code>middleware.ts</code> are taken from the first ready worker.{' '}
          <code>revalidatePath</code> / <code>revalidateTag</code> purge the one cache
          the Rust server holds, whichever worker calls them.
        </li>
        <li>
          Module-level state is per worker. A counter or an in-memory store kept in a
          module variable exists once per worker, so it is not shared - keep shared state
          in a database, a cache server or the session cookie.
        </li>
        <li>
          Node plugin hooks (<code>plugins</code> in <code>gio.config.ts</code>) run per
          worker too: <code>onStartup</code> runs in every worker, and again when a
          worker is respawned, and <code>onShutdown</code> in every worker as it stops.
          One-time work (a migration, a scheduler, a queue consumer) belongs outside the
          server or behind a guard: each worker gets <code>GIO_WORKER_INDEX</code>{' '}
          (<code>&quot;0&quot;</code> for the first) and <code>GIO_WORKER_COUNT</code>, so{' '}
          <code>process.env.GIO_WORKER_INDEX === &apos;0&apos;</code> limits a job to one
          worker per server - keep it idempotent, as that worker can be respawned too.
        </li>
      </ul>
      <p>
        Every worker is a full Node process with its own copy of your app and React, so
        memory grows with the pool - plan for roughly the RSS of one worker (often
        100-200 MB) per worker, and see{' '}
        <a href="/docs/deployment#sizing">Sizing</a> before raising it. Dev mode always
        runs one worker: every edit restarts it with a fresh build.{' '}
        <code>/_gio/health</code> reports{' '}
        <code>workers: {'{'} configured, ready {'}'}</code>, and the metrics carry each
        worker&apos;s load and restarts.
      </p>

      <h2 id="reverse-proxies">Reverse proxies &amp; client IPs</h2>
      <p>
        Behind a reverse proxy or load balancer, every connection GioJS sees comes from
        the proxy. The real client is in a forwarding header the proxy adds - which any
        client can also send itself. <code>trusted_proxies</code> lists the peers whose
        forwarding headers GioJS believes; from everyone else they are ignored entirely:
      </p>
      <CodeBlock lang="toml" code={`[server]
trusted_proxies = ["127.0.0.1", "::1", "10.0.0.0/8"]   # IPs and CIDR blocks, IPv4 and IPv6`} />
      <p>
        The default is an empty list: nobody is trusted and the connecting address is the
        client, which is right when GioJS faces the internet directly. A malformed entry
        stops the server at startup. With trusted proxies configured, the client IP is
        found by walking <code>X-Forwarded-For</code> from right to left, skipping every
        trusted address; the first untrusted one is the client (if every hop is trusted,
        the leftmost). Entries left of it were written by the client and are never read -
        not even checked for being well-formed - so nothing a client sends there (a
        spoofed address, junk bytes, kilobytes of padding) changes the answer. Only when a
        hop a trusted proxy wrote is not an address (say, <code>unknown</code>) is the
        client unknown: the connecting address stands in for it in rate limits and{' '}
        <code>req.ip</code>, and the metrics allowlist refuses the request.
      </p>
      <p>
        From a trusted peer, <code>X-Forwarded-Proto</code> sets the scheme (otherwise{' '}
        <code>https</code> when <code>[server.tls]</code> is on, else <code>http</code>) and{' '}
        <code>X-Forwarded-Host</code> sets the host (otherwise the <code>Host</code>{' '}
        header). GioJS reads the value the nearest proxy wrote - the last one - so a proxy
        that appends to these headers instead of replacing them (HAProxy&apos;s{' '}
        <code>add-header</code>) is safe; behind a chain of proxies, have the inner one
        pass the outer one&apos;s value on. Set{' '}
        <code>proxy_headers = &quot;forwarded&quot;</code> if your proxy sends
        the standard RFC 7239 <code>Forwarded: for=...;proto=...;host=...</code> header
        instead; exactly one header family is read, because a proxy that manages one
        passes a client&apos;s copy of the other straight through.
      </p>
      <p>The resolved client is used everywhere a client matters:</p>
      <ul>
        <li><code>[[rate_limits]]</code> buckets (IPv6 clients are still grouped by /64) and prefetch budgets.</li>
        <li>The <code>[metrics] ip_allowlist</code> - allowlisting <code>127.0.0.1</code> no longer admits everything a local proxy forwards.</li>
        <li>
          <code>req.ip</code> in <a href="/docs/route-handlers">route handlers</a> and{' '}
          <code>ctx.ip</code> in <a href="/docs/fetching-data">getServerSideProps</a>, plus{' '}
          <code>scheme</code> and <code>host</code>.
        </li>
      </ul>
      <div className="callout">
        Only list proxies you control, and make sure each one <em>sets</em>{' '}
        <code>X-Forwarded-Proto</code> and <code>X-Forwarded-Host</code> (or strips them)
        rather than passing a client&apos;s values through. Some cannot: AWS ALB and
        Google Cloud&apos;s load balancer forward a client&apos;s{' '}
        <code>X-Forwarded-Host</code> untouched, as they do <code>Host</code>. The host
        is client-supplied unless your proxy pins it, so never use <code>req.host</code>{' '}
        / <code>ctx.host</code> to make a security decision. Never trust a range your
        visitors can connect from - with <code>0.0.0.0/0</code> every client picks its own
        IP. The <a href="/docs/deployment">deployment guide</a> has per-proxy settings.
      </div>

      <h2 id="request-ids">Request IDs</h2>
      <p>
        Every response carries an <code>X-Request-Id</code> header - cache hits, static
        files, redirects and errors included. The same id is on the server&apos;s log lines
        for that request and on every log line the Node worker writes while handling it
        (see <a href="/docs/observability">Observability</a>), and route handlers and{' '}
        <code>getServerSideProps</code> can read it as <code>req.requestId</code> /{' '}
        <code>ctx.requestId</code>.
      </p>
      <p>
        An incoming <code>X-Request-Id</code> is kept only when it comes from a trusted
        proxy and matches <code>^[A-Za-z0-9._:-]{'{'}1,128{'}'}$</code>, so a proxy&apos;s
        id follows the request through. Otherwise GioJS generates a UUID, so a client
        talking to GioJS directly cannot pick its own id. Behind a proxy, it is the proxy
        that decides: nginx with <code>proxy_set_header X-Request-Id $request_id</code>{' '}
        always sets its own, but many proxies pass a client&apos;s header through unchanged
        (Traefik, Caddy unless told otherwise, AWS ALB, Google Cloud&apos;s load balancer,
        Cloudflare), and ingress-nginx reuses an incoming one on purpose. Behind those,
        have the proxy set or strip the header, or turn adoption off and GioJS generates
        every id itself:
      </p>
      <CodeBlock lang="toml" code={`[server]
accept_request_id = false   # ignore incoming X-Request-Id, even from trusted proxies`} />

      <h2 id="health-and-metrics">Health &amp; metrics</h2>
      <p>
        GioJS serves its built-in endpoints directly from the Rust layer - no Node
        round-trip, so they stay responsive even under load. They are configured in{' '}
        <a href="/docs/configuration/health"><code>[health]</code></a>,{' '}
        <a href="/docs/configuration/metrics"><code>[metrics]</code></a> and{' '}
        <a href="/docs/configuration/revalidate"><code>[revalidate]</code></a>:
      </p>
      <table>
        <thead>
          <tr><th>Endpoint</th><th>Default</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>/_gio/health</code></td>
            <td>on</td>
            <td>Liveness probe - returns <code>200</code> with a JSON body: <code>{'{'}status, http2, tls, deploymentId, nodeReady, workers, cacheEntries, uptimeSecs{'}'}</code>. <code>nodeReady</code> is <code>false</code> while no Node SSR worker is ready - during a respawn of the only worker, or of every worker in a pool (cached and static content still serves) - so readiness probes should check that field. <code>workers</code> is <code>{'{'} configured, ready {'}'}</code> (see <a href="#render-workers">Render workers</a>). <code>[health] details = false</code> leaves only <code>{'{'}status, nodeReady{'}'}</code>, so the deployment ID and worker topology are not public; <code>[health] enabled = false</code> unroutes it (<code>404</code>).</td>
          </tr>
          <tr>
            <td><code>/_gio/metrics</code></td>
            <td>off</td>
            <td>Prometheus exposition (request counts and latency histograms labeled by route pattern, cache tiers, IPC timing - see <a href="/docs/observability">Observability</a>). Returns <code>404</code> until enabled via <code>[metrics]</code>.</td>
          </tr>
          <tr>
            <td><code>/_gio/revalidate</code></td>
            <td>off</td>
            <td><code>POST</code> purges cached pages by tag or path for CMS webhooks and scripts, authenticated with <code>Authorization: Bearer</code>. Returns <code>404</code> until a token is set (<code>GIO_REVALIDATE_TOKEN</code> or <code>[revalidate] token</code>) - see <a href="/docs/caching">Caching</a>.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Metrics are opt-in so you never expose them by accident. A{' '}
        <code>[metrics]</code> section with neither a token nor an allowlist answers only
        clients on this machine (loopback); anything else gets <code>403</code>. Open it up
        with either or both:
      </p>
      <CodeBlock lang="toml" code={`[metrics]
enabled = true          # serve /_gio/metrics

# Secure it for production - use either or both:
token        = "a-long-random-secret"     # require Authorization: Bearer <token>
ip_allowlist = ["10.0.0.5", "10.0.0.6"]   # only allow these client IPs (or CIDRs)`} />
      <p>
        The allowlist checks the client IP after <code>trusted_proxies</code> resolution:
        behind a trusted proxy it is the forwarded client, never the proxy itself.
      </p>
      <CodeBlock lang="bash" code={`# Scrape with a token:
curl -H "Authorization: Bearer a-long-random-secret" \\
  http://localhost:3000/_gio/metrics`} />
      <p>
        A malformed <code>ip_allowlist</code> entry (<code>&quot;10.0.0.0/33&quot;</code>)
        stops startup, like a malformed <code>trusted_proxies</code> one, instead of
        quietly matching nobody.
      </p>
      <div className="callout">
        Loopback means the client after <code>trusted_proxies</code> resolution: behind a
        proxy on the same machine, list it in <code>trusted_proxies</code> so its
        forwarded clients are not mistaken for local ones. Until you do, a request it
        forwards with <code>X-Forwarded-For</code>, <code>Forwarded</code> or{' '}
        <code>X-Real-IP</code> gets <code>403</code>, but one forwarded without any of
        those headers comes from <code>127.0.0.1</code> and is answered - whoever sent
        it. The startup line about loopback-only metrics says so whenever{' '}
        <code>trusted_proxies</code> is empty. To serve metrics to every
        client with no token, say so explicitly with{' '}
        <code>ip_allowlist = [&quot;0.0.0.0/0&quot;, &quot;::/0&quot;]</code> - the server
        then logs a warning at startup. With metrics off (no <code>[metrics]</code>{' '}
        section, or <code>enabled = false</code>) the endpoint answers <code>404</code>.
      </div>

      <h2 id="dev-endpoints-allowed-hosts">Dev endpoints &amp; allowed hosts</h2>
      <p>
        In development the server also serves <code>/_gio/devtools</code> and
        its sub-endpoints: the dashboard, its state and event stream (which also
        drives live reload), error-overlay codeframes that return project
        source, and open-in-editor. Because the starter binds{' '}
        <code>0.0.0.0</code>, they are locked down against browser-based
        attacks (every key is on the <a href="/docs/configuration/dev"><code>[dev]</code></a>{' '}
        page):
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
          The localhost names and loopback IPs count only on a connection from
          this machine. A client on another machine can send{' '}
          <code>Host: localhost</code> itself, so its requests must name the{' '}
          <code>[server] host</code> or an <code>allowed_hosts</code> entry.
        </li>
        <li>
          The state, stream and codeframe reads refuse requests a browser marks{' '}
          <code>Sec-Fetch-Site: cross-site</code>, and requests whose{' '}
          <code>Origin</code> is neither the requested host nor a host in{' '}
          <code>allowed_hosts</code> (the latter covers tunnels and port
          forwarders that rewrite <code>Host</code> to localhost).
        </li>
        <li>
          open-in-editor accepts <code>POST</code> only, also refuses{' '}
          <code>Sec-Fetch-Site: same-site</code> (only same-origin calls
          pass), and applies the same <code>Origin</code> rule, so a link,
          form or{' '}
          <code>&lt;img&gt;</code> on another site cannot launch your editor.
        </li>
        <li>
          The dashboard page itself only checks <code>Host</code>: following a
          link to it is harmless, and another site cannot read it.
        </li>
        <li>
          SSR error pages served to any other host leave out the error message
          and stack, which name files and code on your machine.
        </li>
      </ul>
      <p>
        If you browse the dev server from another machine or through a name -
        a VM, a container host, a phone on your LAN, a tunnel - add the
        hostname or IP you type in the address bar:
      </p>
      <CodeBlock lang="toml" code={`[dev]
allowed_hosts = ["192.168.1.20", "myvm.local", "*.tunnel.example"]  # "*." or "." = any subdomain`} />
      <p>
        Entries are hostnames or IPs; a port or a pasted{' '}
        <code>http(s)://</code> prefix is ignored, and an entry that is not a
        host is skipped with a startup warning naming it (<code>--check-config</code>{' '}
        and <code>gio doctor</code> report it too). Pages themselves
        are unaffected; without the entry only the overlay codeframes,
        open-in-editor, live reload, the dashboard, and the details on SSR
        error pages stop working from that host. When bound to{' '}
        <code>0.0.0.0</code> with no <code>allowed_hosts</code>, the server
        logs a reminder at startup. Blocked requests are logged once per
        distinct host or origin.
      </p>
      <div className="callout">
        An <code>allowed_hosts</code> entry opens the dev endpoints - project
        source included - to every client that can reach the port and sends
        that host, not only to you. On an untrusted network, list no hosts and
        bind the dev server to <code>127.0.0.1</code> (or publish the
        container port to <code>127.0.0.1</code> only). Behind a container
        port mapping the connection comes from another address, so{' '}
        <code>localhost</code> itself needs an entry there.
      </div>
      <p>
        <code>allowed_hosts = [&quot;*&quot;]</code> answers any <code>Host</code> from
        any machine, error details included, and logs a loud warning at startup: DNS
        rebinding is no longer blocked. The <code>Origin</code> and{' '}
        <code>Sec-Fetch-Site</code> checks still apply, so open-in-editor stays
        same-origin. To have no dev endpoints at all, set{' '}
        <code>[dev] devtools = false</code>: <code>/_gio/devtools*</code> answers{' '}
        <code>404</code>, and the error overlay shows the message and stack without
        codeframes, editor links or live reload.
      </p>

      <h2 id="security">Security</h2>
      <p>
        Without any <code>[security]</code> section every response carries{' '}
        <code>X-Content-Type-Options: nosniff</code>, <code>X-Frame-Options: SAMEORIGIN</code>{' '}
        and <code>Referrer-Policy: strict-origin-when-cross-origin</code> (plus{' '}
        <code>Strict-Transport-Security</code> when <code>[server.tls]</code> is enabled), and
        cross-site <code>POST</code>/<code>PUT</code>/<code>PATCH</code>/<code>DELETE</code>{' '}
        requests and WebSocket upgrades are refused with <code>403</code>. A
        Content-Security-Policy with per-response nonces is one line away. Headers your app
        or a <code>[[headers]]</code> rule sets win over these defaults, and{' '}
        <code>[security] default_headers = false</code> drops the three built-in ones. See{' '}
        <a href="/docs/security">Security</a> for every option.
      </p>
      <p>
        Every protection you turn off or loosen in <code>gio.toml</code> logs one warning at
        startup naming the key, and <code>giojs-server --check-config</code> (and{' '}
        <code>gio doctor</code>) reports the same text under <code>warnings</code>. The table in{' '}
        <a href="#turning-things-off">Turning things off</a> lists them all.
      </p>

      <h2 id="turning-things-off">Turning things off</h2>
      <p>
        Every protection and feature below is on by default. The &quot;Warns&quot; column marks
        the ones whose off value logs a startup warning; each section page quotes the exact text.
        The <a href="/docs/guides/security-switches">Turning Protections On and Off</a> guide walks
        through when each switch makes sense.
      </p>
      <table className="config-switches">
        <thead>
          <tr><th>Protection or feature</th><th>Key</th><th>Default</th><th>Off value</th><th>What you lose</th><th>Warns</th></tr>
        </thead>
        <tbody>
          {SWITCHES.map((row) => (
            <tr key={row.key}>
              <td>{row.what}</td>
              <td><a href={row.href}><code>{row.key}</code></a></td>
              <td><code>{row.on}</code></td>
              <td><code>{row.off}</code></td>
              <td>{row.lose}</td>
              <td>{row.warns ? 'yes' : 'no'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <code>[security] csp</code> is the one protection that is off by default: a policy only you
        can write, and nonces make every page private, so CDN caching and ETags are lost while it is
        on. See <a href="/docs/guides/content-security-policy">Content Security Policy</a>.
      </p>
      <p>Some behavior has no switch at all, on purpose:</p>
      <ul>
        <li>Path canonicalization and its <code>400</code>s, and the closed <code>/_gio</code> namespace (<a href="/docs/configuration/server#not-configurable"><code>[server]</code></a>).</li>
        <li>Hiding error details in production: the digest is kept, the message and stack go to the log (<a href="/docs/configuration/security#not-configurable"><code>[security]</code></a>).</li>
        <li>The cache bypass for personalized renders: use PPR holes instead (<a href="/docs/configuration/cache#not-configurable"><code>[cache]</code></a>).</li>
        <li>The server-only import guard, which each module opts into (<a href="#server-only">below</a>).</li>
        <li>Strict unknown-key errors (<a href="#x-tables"><code>[x-*]</code> tables</a> are the escape hatch) and the <code>GIO_PUBLIC_</code> prefix.</li>
        <li>
          Parts of switchable features: the same-origin check on open-in-editor (
          <a href="/docs/configuration/dev#not-configurable"><code>[dev]</code></a>), the image
          optimizer&apos;s path-traversal checks, redirect blocking and guard enforcement (
          <a href="/docs/configuration/images#not-configurable"><code>[images]</code></a>), request id
          validation, and the 32-byte minimum for the revalidation token (
          <a href="/docs/configuration/revalidate#not-configurable"><code>[revalidate]</code></a>).
        </li>
      </ul>

      <h2 id="rate-limits">Rate limits</h2>
      <p>
        Each <code>[[rate_limits]]</code> rule is a token bucket per client:{' '}
        <code>per_ip</code> requests per <code>window_seconds</code>, plus{' '}
        <code>burst</code> on top. <code>path</code> uses the rule pattern
        syntax (<code>/api/*rest</code>, <code>/users/:id</code>), and a path
        that cannot be parsed stops startup. When several rules match, the one
        covering most of the path wins. Limits run in Rust before routing, so a
        rejected request (<code>429</code> with <code>Retry-After</code>) never
        reaches Node. Every key is on the{' '}
        <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a> page.
      </p>
      <ul>
        <li>
          <strong>Paths are matched in canonical form</strong> - the same
          form <a href="/docs/middleware">middleware rules</a> use. Repeated
          and trailing slashes and percent-escaped letters, digits,{' '}
          <code>-</code>, <code>.</code>, <code>_</code>, <code>~</code> are
          normalized first, so <code>/api/login/</code>,{' '}
          <code>//api//login</code> and <code>/api/%6Cogin</code> all draw
          from the <code>/api/login</code> bucket, just as they all reach the
          same handler.
        </li>
        <li>
          <strong>
            <code>/api/*rest</code> also covers <code>/api</code> itself
          </strong>{' '}
          (<code>/api/</code> is the same path). An exact <code>/api</code>{' '}
          rule still takes precedence there, whichever order the two rules
          are listed in.
        </li>
        <li>
          <strong>A client is an IPv4 address or an IPv6 /64.</strong> IPv6
          hosts typically control a whole /64, so per-address buckets would let
          one host rotate into unlimited fresh budgets.
        </li>
        <li>
          <strong>Memory is bounded.</strong> Buckets that have refilled are
          dropped (a new one starts full, so nothing is lost), and the store
          holds at most <code>[server] rate_limit_max_buckets</code> buckets
          (100,000) - past that the least recently seen are evicted.{' '}
          <code>0</code> lifts the cap.
        </li>
        <li>
          <strong>
            <code>key_header</code> budgets are capped per client.
          </strong>{' '}
          One client gets its own bucket for at most{' '}
          <code>max_keys_per_client</code> (64) distinct header values per
          rule; further values share the client&apos;s own bucket, so rotating
          the header cannot mint fresh budgets. Set it to <code>0</code> (no
          cap) for an API gateway whose many keys arrive from one address.
        </li>
      </ul>

      <h2 id="environment-variables">Environment variables</h2>
      <p>
        A few runtime knobs live in the environment rather than
        <code>gio.toml</code>:
      </p>
      <table>
        <thead>
          <tr><th>Variable</th><th>Description</th><th>Default</th></tr>
        </thead>
        <tbody>
          <tr><td><code>GIO_APP_DIR</code></td><td>Path to the <code>app/</code> directory; <code>gio.toml</code> is loaded from its parent</td><td>app</td></tr>
          <tr><td><code>GIO_HOST</code> / <code>GIO_PORT</code></td><td>Override <code>[server] host</code> / <code>port</code> without editing <code>gio.toml</code> (a second instance, a test server). The host must be an IP address; a malformed value stops startup (see <a href="#listen-address">Listen address</a>)</td><td><code>[server]</code> values</td></tr>
          <tr><td><code>PORT</code></td><td>The port hosting platforms assign (Heroku, Render, Railway, Fly.io, Cloud Run): overrides <code>[server] port</code>; <code>GIO_PORT</code> wins over it</td><td>unset</td></tr>
          <tr><td><code>GIO_CACHE_DIR</code></td><td>Page cache directory, overriding <code>[cache] disk_path</code>; may be absolute</td><td><code>.gio/cache/pages</code></td></tr>
          <tr><td><code>GIO_ENV_FILES</code></td><td><code>0</code> skips the <a href="#env-files">.env files</a>, <code>1</code> loads them, whatever <code>[env] files</code> says (for platforms that inject the environment and should ignore stray files). Any other value stops startup</td><td>unset (<code>[env] files</code> decides)</td></tr>
          <tr><td><code>GIO_DEPLOYMENT_ID</code></td><td>Pin the deployment ID across pods (otherwise derived from the client build the server produced at startup, the app&apos;s server-side sources, the gio.toml <code>[images]</code> settings and <code>[css] minify</code>, the served <code>[[fonts]]</code> files, the i18n default locale and, in a standalone build, its <code>.gio/manifest.json</code>). Persisted pages are dropped when it changes, so change a pinned ID with every deploy</td><td>content-derived</td></tr>
          <tr><td><code>GIO_SOCKET_PATH</code></td><td>Rust-to-Node IPC path; the server passes the resolved value to the Node worker (in a <a href="#render-workers">worker pool</a>, the other workers get it with a <code>-w&lt;N&gt;</code> suffix)</td><td>per-instance <code>.gio/ipc-&lt;pid&gt;-&lt;rand&gt;.sock</code> (Unix), unique named pipe (Windows)</td></tr>
          <tr><td><code>GIO_IMAGE_CACHE_DIR</code></td><td>Directory of the optimized-image disk cache (see <a href="/docs/configuration/images"><code>[images]</code></a>)</td><td><code>.gio/cache/images</code></td></tr>
          <tr><td><code>GIO_FONTS_DIR</code></td><td>Directory the <a href="/docs/configuration/fonts"><code>[[fonts]]</code></a> files are fetched into and served from</td><td><code>.gio/fonts</code></td></tr>
          <tr><td><code>GIO_PUBLIC_DIR</code></td><td>Directory served at the site root and under <code>/public/*</code></td><td><code>public/</code> next to <code>app/</code></td></tr>
          <tr><td><code>GIO_REVALIDATE_TOKEN</code></td><td>Bearer token that enables <code>POST /_gio/revalidate</code> (<a href="/docs/caching">on-demand revalidation</a>); at least 32 bytes, or the server refuses to start. Overrides <code>[revalidate] token</code></td><td>unset (endpoint disabled)</td></tr>
          <tr><td><code>GIO_SESSION_SECRET</code></td><td>Key material for <a href="/docs/authentication">sessions</a> and <code>require_session</code> guards: at least 32 bytes, comma-separated to rotate (the first signs, all verify). Required in production once sessions are used</td><td>unset (development: an ephemeral secret per server start)</td></tr>
          <tr><td><code>GIO_SITE_URL</code></td><td>Absolute base URL of the site: resolves relative <a href="/docs/metadata">metadata</a> URLs (Open Graph, canonical) when no <code>metadataBase</code> is set, relative URLs from <code>app/sitemap.ts</code> / <code>app/robots.ts</code>, and the <code>sitemap.xml</code> <code>gio export</code> generates</td><td>unset</td></tr>
          <tr><td><code>NODE_ENV</code></td><td><code>development</code> enables dev mode (file watcher, dev endpoints, error details) and selects the <code>.env.development*</code> files; anything else - unset included - is production and selects <code>.env.production*</code>. The server passes the decided mode to the Node worker it spawns</td><td>unset</td></tr>
          <tr><td><code>RUST_LOG</code></td><td>Rust log filter (info/debug/trace)</td><td>info</td></tr>
          <tr><td><code>GIO_LOG_FORMAT</code></td><td><code>json</code> or <code>text</code>: the server&apos;s log format, overriding <code>[logging] format</code> (see <a href="/docs/observability">Observability</a>)</td><td>text</td></tr>
          <tr><td><code>GIO_EXIT_ON_STDIN_EOF</code></td><td><code>1</code>: shut down gracefully when stdin reaches end-of-file. Set by launchers that start the server with a piped stdin they hold open (<code>gio</code>, a standalone <code>run.mjs</code>), so a launcher killed outright never leaves the server behind; ignored when stdin is not a pipe (see <a href="/docs/deployment">Deployment</a>)</td><td>unset</td></tr>
          <tr><td><code>GIO_WORKER_INDEX</code> / <code>GIO_WORKER_COUNT</code></td><td>Set by the server in each Node worker, for your code to read: the worker&apos;s index in the pool (<code>0</code> for the first) and the pool size (see <a href="#render-workers">Render workers</a>). Any value you set is replaced</td><td>set per worker</td></tr>
          <tr><td><code>GIO_PUBLIC_*</code></td><td>Inlined into client bundles at build time (see below); every other variable is server-only</td><td>-</td></tr>
        </tbody>
      </table>

      <h2 id="env-files">.env files</h2>
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
      <CodeBlock lang="bash" title=".env" code={`DATABASE_URL="postgres://localhost/dev"
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
          A candidate that is not a regular file - such as the <code>.env/</code> directory{' '}
          <code>python -m venv .env</code> creates - is skipped with a warning.
        </li>
        <li>
          The files load once at startup; restart the server after editing them.
        </li>
        <li>
          <code>gio export</code> and <code>gio build standalone</code> load the same files
          with the same rules (<code>production</code> mode for standalone builds).
        </li>
        <li>
          <code>[env] files = false</code> in <code>gio.toml</code> loads none of them, and
          the environment is all there is. <code>GIO_ENV_FILES=0</code> does the same
          without editing the file, and <code>GIO_ENV_FILES=1</code> loads them even when{' '}
          <code>gio.toml</code> says no. The server, <code>gio export</code>,{' '}
          <code>gio build standalone</code> and the testing kit all follow both.
        </li>
      </ul>

      <h2 id="environment-variables-in-client-code">Environment variables in client code</h2>
      <p>
        Pages and components also run in the browser, where there is no{' '}
        <code>process.env</code>. Variables prefixed <code>GIO_PUBLIC_</code> that are set
        when the client bundles are built are inlined as string literals; every other{' '}
        <code>process.env.X</code> read in client code is <code>undefined</code>. Secrets
        can only ship to the browser if you name them <code>GIO_PUBLIC_*</code>. In the
        browser <code>process.env</code> is an object holding exactly those public values
        (plus <code>NODE_ENV</code>), so destructuring and <code>process.env[name]</code>{' '}
        see the same values the server rendered with.
      </p>
      <CodeBlock lang="tsx" code={`export default function Checkout() {
  // Inlined at build time: safe to read anywhere.
  const apiUrl = process.env.GIO_PUBLIC_API_URL;
  const { GIO_PUBLIC_STRIPE_KEY } = process.env; // works too
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

      <h2 id="server-only">Keeping server code out of the browser</h2>
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
      <CodeBlock lang="ts" title="lib/db.ts" code={`import '@gio.js/core/server-only';

export const db = createClient(process.env.DATABASE_URL);`} />
      <p>
        Using <code>db</code> from <code>getServerSideProps</code> or a{' '}
        <code>route.ts</code> handler is fine. If a component imports it - or reads a
        TypeScript enum it declares - that route's client bundle is rejected (it is never
        written to disk), and the error names the import chain:
      </p>
      <CodeBlock lang="text" code={`client bundle for route "/dashboard" imports server-only code:
app/dashboard/page.tsx -> components/Stats.tsx -> lib/db.ts -> @gio.js/core/server-only.
The page still server-renders but will NOT hydrate (no client JS) until this import
is removed from client code.`} />
      <p>
        The error is logged at startup and, in development (<code>NODE_ENV=development</code>
        ), shown in the error overlay when you open the page; in production it stays in the
        server log. Other routes are unaffected and keep their shared chunks. The bare{' '}
        <code>server-only</code>{' '}
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

      <h2 id="static-page-caching">Static page caching</h2>
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
      <p>
        To refresh a cached page as soon as its data changes, tag it and purge it with{' '}
        <code>revalidateTag()</code> / <code>revalidatePath()</code> or{' '}
        <code>POST /_gio/revalidate</code> - see <a href="/docs/caching">Caching</a>.
      </p>
    </>
  );
}
