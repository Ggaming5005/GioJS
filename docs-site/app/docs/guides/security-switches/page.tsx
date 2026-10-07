import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Turning Protections On and Off',
  description:
    'Every protection and feature GioJS turns on by default, the gio.toml key that turns it ' +
    'off or loosens it, what that costs, and the few behaviors that stay fixed.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Turning Protections On and Off</h1>
      <p className="page-subtitle">
        Every protection and feature GioJS turns on by default, the <code>gio.toml</code> key
        that turns it off or loosens it, what that costs, and the few behaviors that stay
        fixed.
      </p>

      <p>
        A new GioJS app is locked down without any configuration: cross-site requests are
        refused, responses carry security headers, connections and bodies are bounded, and
        the dev tools answer only your own machine. Each of these is a key in{' '}
        <code>gio.toml</code>, so an app with a reason to differ can turn one off - and the
        server tells you when you have. This page is the map: one table per area, with the
        key, its default, the value that turns it off, what you give up, and whether startup
        warns. Each section links to the full reference for its keys.
      </p>

      <h2 id="the-rules">The rules every switch follows</h2>
      <ul>
        <li>
          <strong>On by default.</strong> A feature section has <code>enabled = true</code>{' '}
          unless you write otherwise; sub-features have their own booleans, also{' '}
          <code>true</code>.
        </li>
        <li>
          <strong><code>0</code> lifts a limit.</strong> Every numeric limit uses{' '}
          <code>0</code> for unlimited and every timeout uses <code>0</code> for none, in
          every section. To turn a feature off, use its <code>enabled</code> key, not a limit
          of <code>0</code>.
        </li>
        <li>
          <strong>Never silent.</strong> Turning a protection off or loosening a limit to{' '}
          <code>0</code> logs one <code>warn</code> line at startup that names the key and
          what it costs. <a href="/docs/cli/giojs-server"><code>giojs-server --check-config</code></a> and{' '}
          <a href="/docs/cli/doctor"><code>gio doctor</code></a> report the same text under{' '}
          <code>warnings</code>, so CI can catch it before a deploy.
        </li>
        <li>
          <strong>Misspellings stop the server.</strong> An unknown key anywhere in{' '}
          <code>gio.toml</code> is a startup error naming the file, the line and the closest
          valid key. A typo such as <code>enabeld = false</code> can never leave a protection
          on that you meant to turn off, or the reverse.
        </li>
      </ul>
      <CodeBlock lang="bash" code={`# Print what startup would decide, without binding a port: errors, rules
# startup would skip, and one warning per loosened protection.
npx giojs-server --check-config`} />
      <p>
        The command loads the <code>.env</code> files and <code>gio.toml</code> exactly as
        startup does, prints a JSON report and exits with <code>1</code> when the server
        would refuse to start. It never prints secrets.
      </p>

      <h2 id="request-protections">Request protections</h2>
      <p>
        Enforced in the Rust server before any of your Node code runs. Reference:{' '}
        <a href="/docs/configuration/security"><code>[security]</code></a>,{' '}
        <a href="/docs/configuration/security-csrf"><code>[security.csrf]</code></a>,{' '}
        <a href="/docs/configuration/security-websocket"><code>[security.websocket]</code></a>.
      </p>
      <table>
        <thead>
          <tr><th>Protection</th><th>Key and default</th><th>Off or loosened</th><th>What you give up</th><th>Warns</th></tr>
        </thead>
        <tbody>
          <tr>
            <td id="csrf">CSRF check on <code>POST</code>, <code>PUT</code>, <code>PATCH</code>, <code>DELETE</code></td>
            <td><code>[security.csrf] enabled = true</code></td>
            <td><code>false</code>; or list origins in <code>trusted_origins</code> and paths in <code>exempt</code></td>
            <td>Any website can submit forms and other unsafe requests to your app with your visitors&apos; cookies.</td>
            <td>yes (off)</td>
          </tr>
          <tr>
            <td id="websocket-origin">WebSocket <code>Origin</code> check</td>
            <td><code>[security.websocket] check_origin = true</code></td>
            <td><code>false</code></td>
            <td>Any website can open a WebSocket to your app as the visitor (cross-site WebSocket hijacking). Independent of the CSRF switch.</td>
            <td>yes</td>
          </tr>
          <tr>
            <td id="default-headers">Default security headers: <code>X-Content-Type-Options: nosniff</code>, <code>X-Frame-Options: SAMEORIGIN</code>, <code>Referrer-Policy: strict-origin-when-cross-origin</code></td>
            <td><code>[security] default_headers = true</code></td>
            <td><code>false</code> drops all three; <code>[security.headers] name = &quot;&quot;</code> drops one</td>
            <td>MIME sniffing, framing by other sites (clickjacking) and full-URL referrers come back.</td>
            <td>yes (<code>default_headers = false</code>)</td>
          </tr>
          <tr>
            <td id="hsts">HSTS (<code>Strict-Transport-Security</code>)</td>
            <td><code>[security] hsts</code> unset: sent only when <a href="/docs/configuration/server-tls"><code>[server.tls]</code></a> is on</td>
            <td><code>false</code> or <code>&quot;&quot;</code> never sends it; <code>true</code>, a string or a table sends it behind a TLS proxy</td>
            <td>Browsers may reach the site over plain HTTP first.</td>
            <td>no</td>
          </tr>
          <tr>
            <td id="csp">Content-Security-Policy</td>
            <td>off: <code>[security] csp</code> and <code>csp_report_only</code> unset</td>
            <td>Opt-in - see <a href="/docs/guides/content-security-policy">Content Security Policy</a></td>
            <td>-</td>
            <td>-</td>
          </tr>
        </tbody>
      </table>
      <CodeBlock lang="toml" title="gio.toml" code={`# Loosen instead of turning off, wherever you can.
[security.csrf]
trusted_origins = ["https://admin.example.com"]    # another origin of yours
exempt = ["/api/webhooks/*rest", "/saml/acs"]      # endpoints other sites post to

[[headers]]
path = "/embed/*rest"
[headers.headers]
x-frame-options = ""                               # let partners frame one section`} />

      <h2 id="connection-and-request-limits">Connection and request limits</h2>
      <p>
        These bound what one client, or a flood of them, can make the server hold. Reference:{' '}
        <a href="/docs/configuration/server"><code>[server]</code></a> and{' '}
        <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a>.
      </p>
      <table>
        <thead>
          <tr><th>Limit</th><th>Key and default</th><th>Off</th><th>What you give up</th><th>Warns</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Request body size (<code>413</code> past it)</td>
            <td><code>[server] max_body_bytes = 2097152</code> (2 MiB)</td>
            <td><code>0</code></td>
            <td>Bodies are buffered in memory up to the worker&apos;s 64 MiB message cap (about 48 MiB of binary body), which still answers <code>413</code> above it.</td>
            <td>yes (also when set above what a message can carry)</td>
          </tr>
          <tr>
            <td>Open connections, server-wide</td>
            <td><code>[server] max_connections = 10000</code></td>
            <td><code>0</code></td>
            <td>A connection flood can exhaust file descriptors and memory.</td>
            <td>yes</td>
          </tr>
          <tr>
            <td>Worker answer deadline (<code>504</code> past it)</td>
            <td><code>[server] render_timeout_secs = 30</code></td>
            <td><code>0</code></td>
            <td>A render that never answers holds its connection and a worker slot for good.</td>
            <td>yes</td>
          </tr>
          <tr>
            <td>Slow clients: TLS handshake, request head, request body (<code>408</code>), idle connections</td>
            <td><code>tls_handshake_timeout_secs = 10</code>, <code>header_read_timeout_secs = 10</code>, <code>request_body_timeout_secs = 30</code>, <code>idle_timeout_secs = 60</code></td>
            <td><code>0</code> each</td>
            <td>Slowloris-style clients can keep connections open indefinitely.</td>
            <td>no</td>
          </tr>
          <tr>
            <td>HTTP/2 streams per connection, keep-alive pings</td>
            <td><code>http2_max_concurrent_streams = 250</code>, <code>http2_keep_alive_interval_secs = 20</code>, <code>http2_keep_alive_timeout_secs = 20</code></td>
            <td><code>0</code> each</td>
            <td>One connection can open any number of streams; dead peers are noticed later.</td>
            <td>no</td>
          </tr>
          <tr>
            <td>Rate-limit buckets kept in memory</td>
            <td><code>[server] rate_limit_max_buckets = 100000</code></td>
            <td><code>0</code></td>
            <td>Clients rotating addresses grow memory without bound. Warns only when <code>[[rate_limits]]</code> rules exist.</td>
            <td>yes</td>
          </tr>
          <tr>
            <td><code>key_header</code> values one client may hold a budget for</td>
            <td><code>[[rate_limits]] max_keys_per_client = 64</code></td>
            <td><code>0</code></td>
            <td>One client can mint a fresh budget for every header value it sends. Warns only for rules with a <code>key_header</code>.</td>
            <td>yes</td>
          </tr>
          <tr>
            <td>Prefetch budget per client (<code>429</code> past it)</td>
            <td><code>[prefetch] max_concurrent = 5</code>, <code>max_per_second = 20</code></td>
            <td><code>0</code> each; <code>[prefetch] enabled = false</code> refuses every prefetch</td>
            <td>Prefetching links can render pages for one client without limit.</td>
            <td>no</td>
          </tr>
          <tr>
            <td>WebSocket connections (closed with <code>1013</code> past it)</td>
            <td><code>[websocket] max_connections = 1000</code></td>
            <td><code>0</code></td>
            <td>Every open socket holds memory and a file descriptor, without a cap.</td>
            <td>yes</td>
          </tr>
        </tbody>
      </table>
      <p>
        <code>[[rate_limits]]</code> rules themselves are opt-in: no rule, no limit. See{' '}
        <a href="/docs/configuration#rate-limits">Rate limits</a>.
      </p>

      <h2 id="client-identity">Client identity</h2>
      <p>
        Who the client is decides rate limits, the metrics allowlist, logs and{' '}
        <code>ctx.ip</code>. Reference: <a href="/docs/configuration/server"><code>[server]</code></a>.
      </p>
      <table>
        <thead>
          <tr><th>Behavior</th><th>Key and default</th><th>Loosened</th><th>What you give up</th><th>Warns</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Forwarding headers are ignored unless a trusted proxy sent them</td>
            <td><code>[server] trusted_proxies = []</code> (trust nobody)</td>
            <td>a list of your proxies; an entry covering everything (<code>0.0.0.0/0</code>, <code>::/0</code>)</td>
            <td>With a <code>/0</code> entry, any client can pick its own IP, rate-limit bucket and request id.</td>
            <td>yes (<code>/0</code> only)</td>
          </tr>
          <tr>
            <td>An incoming <code>X-Request-Id</code> is kept only from a trusted proxy</td>
            <td><code>[server] accept_request_id = true</code></td>
            <td><code>false</code> is stricter: every id is generated here</td>
            <td>-</td>
            <td>no</td>
          </tr>
        </tbody>
      </table>

      <h2 id="operations-endpoints">Operations endpoints</h2>
      <p>
        Reference: <a href="/docs/configuration/metrics"><code>[metrics]</code></a>,{' '}
        <a href="/docs/configuration/health"><code>[health]</code></a>,{' '}
        <a href="/docs/configuration/revalidate"><code>[revalidate]</code></a>. See{' '}
        <a href="/docs/endpoints">Endpoints &amp; Headers</a> for every <code>/_gio</code>{' '}
        path.
      </p>
      <table>
        <thead>
          <tr><th>Endpoint</th><th>Key and default</th><th>Off or loosened</th><th>What you give up</th><th>Warns</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>/_gio/metrics</code> (Prometheus)</td>
            <td>off without a <code>[metrics]</code> section; with one and no <code>token</code> or <code>ip_allowlist</code>, loopback clients only</td>
            <td><code>ip_allowlist = [&quot;0.0.0.0/0&quot;, &quot;::/0&quot;]</code> opens it to everyone; <code>enabled = false</code> turns it off</td>
            <td>Anyone can read your traffic, routes and worker state.</td>
            <td>yes (open to everyone without a token)</td>
          </tr>
          <tr>
            <td><code>/_gio/health</code></td>
            <td><code>[health] enabled = true</code>, <code>details = true</code></td>
            <td><code>enabled = false</code> answers <code>404</code>; <code>details = false</code> answers only <code>{'{"status":"ok","nodeReady":...}'}</code></td>
            <td>Load balancers lose the endpoint; <a href="/docs/cli/dev"><code>gio dev</code></a>, <a href="/docs/cli/start"><code>gio start</code></a> and the testing kit then treat any answer as ready.</td>
            <td>no</td>
          </tr>
          <tr>
            <td><code>POST /_gio/revalidate</code></td>
            <td>off: exists only with <code>[revalidate] token</code> or <code>GIO_REVALIDATE_TOKEN</code></td>
            <td>Opt-in</td>
            <td>-</td>
            <td>-</td>
          </tr>
        </tbody>
      </table>

      <h2 id="development-server">Development server</h2>
      <p>
        These keys apply only when the server runs with <code>NODE_ENV=development</code>{' '}
        (<code>gio dev</code>). In production <code>/_gio/devtools*</code> always answers{' '}
        <code>404</code>. Reference: <a href="/docs/configuration/dev"><code>[dev]</code></a>.
      </p>
      <table>
        <thead>
          <tr><th>Behavior</th><th>Key and default</th><th>Off or loosened</th><th>What you give up</th><th>Warns</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Dev endpoints and error details answer only local hosts (DNS-rebinding protection)</td>
            <td><code>[dev] allowed_hosts = []</code></td>
            <td>list hostnames you browse from; <code>[&quot;*&quot;]</code> answers any <code>Host</code> from any machine</td>
            <td>With <code>&quot;*&quot;</code>, any site can read your source codeframes and live server state through DNS rebinding.</td>
            <td>yes (<code>&quot;*&quot;</code>; invalid entries are ignored with a warning)</td>
          </tr>
          <tr>
            <td>Dev dashboard, codeframes, open-in-editor, live reload</td>
            <td><code>[dev] devtools = true</code></td>
            <td><code>false</code>: <code>/_gio/devtools*</code> is not routed and the error overlay shows no codeframes or editor links</td>
            <td>The overlay tooling.</td>
            <td>no (logged as info)</td>
          </tr>
          <tr>
            <td>Restart the worker when a source file changes</td>
            <td><code>[dev] watch = true</code></td>
            <td><code>false</code>; or keep it and list paths in <code>watch_ignore</code></td>
            <td>Edits need a manual restart.</td>
            <td>no</td>
          </tr>
        </tbody>
      </table>

      <h2 id="features">Features</h2>
      <p>
        Turning one of these off saves work or hands it to something else (a CDN, an image
        service). None of them warns, except where a limit goes to <code>0</code>.
      </p>
      <table>
        <thead>
          <tr><th>Feature</th><th>Key and default</th><th>Off</th><th>What happens instead</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Page cache (memory and disk)</td>
            <td><a href="/docs/configuration/cache"><code>[cache] enabled = true</code></a></td>
            <td><code>false</code></td>
            <td>Every request renders (<code>X-Gio-Cache: bypass</code>). <code>Cache-Control</code> still follows <code>revalidate</code>, so a CDN can keep caching.</td>
          </tr>
          <tr>
            <td>Disk tier of the page cache</td>
            <td><code>[cache] disk_enabled = true</code></td>
            <td><code>false</code></td>
            <td>Memory only; nothing written, nothing survives a restart.</td>
          </tr>
          <tr>
            <td>Page <code>ETag</code> and <code>304</code></td>
            <td><code>[cache] etag = true</code></td>
            <td><code>false</code></td>
            <td>Pages are always sent in full.</td>
          </tr>
          <tr>
            <td>Serving stale pages while one refresh runs</td>
            <td><code>[cache] swr_multiplier = 10</code></td>
            <td><code>0</code></td>
            <td>A stale page is never served; <code>Cache-Control</code> drops <code>stale-while-revalidate</code>.</td>
          </tr>
          <tr>
            <td>Image optimizer (<code>/_gio/image</code>)</td>
            <td><a href="/docs/configuration/images"><code>[images] enabled = true</code></a></td>
            <td><code>false</code></td>
            <td><code>/_gio/image</code> answers <code>404</code>; <a href="/docs/components/gio-image"><code>&lt;GioImage&gt;</code></a> renders its plain <code>src</code> without a <code>srcset</code>.</td>
          </tr>
          <tr>
            <td>Image optimizer limits</td>
            <td><code>max_remote_bytes = 20971520</code>, <code>remote_timeout_secs = 30</code>, <code>max_source_dimension = 10000</code>, <code>max_decode_bytes = 268435456</code></td>
            <td><code>0</code> each (warns)</td>
            <td>Large or slow sources, or a small file declaring huge dimensions, can exhaust memory and CPU.</td>
          </tr>
          <tr>
            <td>Prefetching</td>
            <td><a href="/docs/configuration/prefetch"><code>[prefetch] enabled = true</code></a></td>
            <td><code>false</code></td>
            <td>Every prefetch gets <code>429</code> before it renders; links still navigate.</td>
          </tr>
          <tr>
            <td>Compression (gzip, Brotli)</td>
            <td><a href="/docs/configuration/compression"><code>[compression] enabled = true</code></a></td>
            <td><code>false</code></td>
            <td>Responses go out uncompressed (a proxy in front may compress them).</td>
          </tr>
          <tr>
            <td>CSS served by path, minification, critical CSS</td>
            <td><a href="/docs/configuration/css"><code>[css] enabled</code>, <code>minify</code>, <code>critical_extraction</code></a>, all <code>true</code></td>
            <td><code>false</code> each</td>
            <td><code>enabled</code> covers path-served <code>app/*.css</code> only; imported CSS is always bundled.</td>
          </tr>
          <tr>
            <td>Font preload</td>
            <td><a href="/docs/configuration/fonts"><code>[[fonts]] preload = true</code></a></td>
            <td><code>false</code> per entry</td>
            <td>The <code>@font-face</code> stays; the browser fetches the file when text needs it.</td>
          </tr>
          <tr>
            <td>WebSocket routes</td>
            <td><a href="/docs/configuration/websocket"><code>[websocket] enabled = true</code></a></td>
            <td><code>false</code></td>
            <td>Upgrades get <code>501</code>. <code>ping_interval_secs = 0</code> keeps sockets but sends no pings.</td>
          </tr>
          <tr>
            <td>Deployment skew protection</td>
            <td><a href="/docs/configuration/server"><code>[server] skew_protection = true</code></a></td>
            <td><code>false</code> (warns)</td>
            <td><code>x-deployment-id</code> is ignored: a tab running an older build keeps navigating softly, with no <code>409</code> hard reload.</td>
          </tr>
          <tr>
            <td><code>.env</code> file loading</td>
            <td><a href="/docs/configuration/env"><code>[env] files = true</code></a></td>
            <td><code>false</code>, or <code>GIO_ENV_FILES=0</code></td>
            <td>The process environment is all there is. <code>GIO_ENV_FILES</code> wins over the key (<code>1</code> forces loading on).</td>
          </tr>
          <tr>
            <td>HTTP/2</td>
            <td><code>[server] http2 = true</code></td>
            <td><code>false</code></td>
            <td>HTTP/1.1 only.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="what-stays-fixed">What stays fixed, and why</h2>
      <p>
        A few behaviors have no switch. Each one either protects every other rule on this
        page or keeps one visitor&apos;s data away from another, and none blocks something an
        app legitimately needs:
      </p>
      <ul>
        <li>
          <strong>Canonical request paths.</strong> Repeated and trailing slashes collapse and
          escaped unreserved characters are decoded before any rule matches; dot segments, a
          raw <code>\</code> and invalid <code>%</code> escapes get <code>400</code>. Every
          guard, rate limit, header rule and CSRF exemption relies on one spelling of a path -
          with it off, <code>/api//login</code> or <code>/api/%6Cogin</code> would slip past a
          rule for <code>/api/login</code>. Browsers never send the refused forms.
        </li>
        <li>
          <strong>The closed <code>/_gio</code> namespace.</strong> Paths under{' '}
          <code>/_gio/</code> that are not built-in endpoints answer <code>404</code> from Rust
          and never reach the app, so a dynamic route like <code>app/[org]/settings</code>{' '}
          cannot be rendered as <code>/_gio/settings</code> past its guard. Use any other
          prefix for your own routes.
        </li>
        <li>
          <strong>No error details in production.</strong> A failed render answers a generic
          page with a digest, and the message and stack are logged under that digest. Raw
          messages leak file paths, SQL and sometimes secrets; the digest leads you to the full
          log line. See <a href="/docs/error-handling#production-error-responses">Error Handling</a>.
        </li>
        <li>
          <strong>Personalized renders are never shared.</strong> A render that read cookies,
          credentials, the client&apos;s IP or host is never stored, whatever{' '}
          <code>revalidate</code> says. A switch would hand one visitor&apos;s page to
          everyone. To cache and personalize, cache the shell with{' '}
          <a href="/docs/page-exports/shell"><code>shell = &apos;cache&apos;</code></a> and
          personalize inside Suspense holes.
        </li>
        <li>
          <strong>The server-only import guard</strong> is opt-in per module: importing{' '}
          <code>@gio.js/core/server-only</code> or naming a file <code>*.server.ts</code> marks
          it. Removing the marker is the off switch; a global one would ship the marked
          modules (database clients, keys) to browsers. See{' '}
          <a href="/docs/functions/server-only"><code>server-only</code></a>.
        </li>
        <li>
          <strong>Unknown <code>gio.toml</code> keys are errors.</strong> Tables for other tools
          go in <code>[x-...]</code> tables, which the server skips.
        </li>
        <li>
          <strong>Only <code>GIO_PUBLIC_*</code> variables reach the browser.</strong> The prefix
          is the opt-in; rename a variable to expose it. See{' '}
          <a href="/docs/guides/environment-variables">Environment Variables</a>.
        </li>
      </ul>
      <p>Parts of switchable features stay fixed too:</p>
      <ul>
        <li>
          Open-in-editor requires a same-origin request (or <code>Sec-Fetch-Site: none</code>)
          even with <code>allowed_hosts = [&quot;*&quot;]</code>: no website should be able to
          launch your editor.
        </li>
        <li>
          The image optimizer always rejects path traversal, never follows redirects for
          remote sources, and holds a local <code>src</code> to the guards of its URL.
        </li>
        <li>
          An adopted <code>X-Request-Id</code> must be 1 to 128 characters of letters, digits,{' '}
          <code>.</code>, <code>_</code>, <code>:</code> and <code>-</code>; anything else is
          replaced, which keeps log and header injection out.
        </li>
        <li>
          The revalidation token must be at least 32 bytes: a short bearer token can be
          guessed, and a long one costs nothing.
        </li>
      </ul>

      <h2 id="example-an-internal-app">Example: an internal app behind a gateway</h2>
      <p>
        An admin tool reachable only through a company gateway that terminates TLS, adds its
        own headers and posts webhooks from a partner origin. Each loosening is deliberate,
        and startup lists them:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
trusted_proxies = ["10.0.0.0/8"]          # the gateway; never 0.0.0.0/0
max_body_bytes = 20971520                 # 20 MiB uploads

[security]
default_headers = false                   # the gateway sets them (warns)
hsts = true                               # TLS ends at the gateway

[security.csrf]
trusted_origins = ["https://partner.example.com"]

[metrics]
token = "\${METRICS_TOKEN}"                # placeholder: put the real token here, or use ip_allowlist

[health]
details = false                           # no deployment id or topology on a public probe`} />
      <CodeBlock lang="text" code={`WARN [security] default_headers = false: responses no longer carry x-content-type-options,
     x-frame-options or referrer-policy (MIME sniffing, clickjacking and full-URL referrers
     are back) unless [security.headers] sets them`} />
      <div className="callout warning">
        <code>gio.toml</code> does not expand variables: <code>{'"${METRICS_TOKEN}"'}</code>{' '}
        above stands for the token itself. Keep real tokens out of version control - the
        revalidation token can come from <code>GIO_REVALIDATE_TOKEN</code> instead.
      </div>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/security">Security</a> - how each protection works</li>
        <li><a href="/docs/guides/content-security-policy">Content Security Policy</a> - the one protection that is opt-in</li>
        <li><a href="/docs/configuration">gio.toml reference</a> - every key, with the full reference block</li>
        <li><a href="/docs/guides/production-checklist">Production Checklist</a></li>
        <li><a href="/docs/upgrading">Upgrading to beta.8</a> - defaults that changed</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Introduced the switches <code>[security] default_headers</code>,{' '}
              <code>[server] skew_protection</code>, <code>render_timeout_secs</code>,{' '}
              <code>rate_limit_max_buckets</code>, <code>[dev] devtools</code>,{' '}
              <code>watch</code>, <code>[health]</code>, <code>[env]</code>,{' '}
              <code>[images] enabled</code>, <code>[cache] enabled</code>,{' '}
              <code>disk_enabled</code>, <code>etag</code>, <code>swr_multiplier</code>,{' '}
              <code>[prefetch] enabled</code> and <code>[[fonts]] preload</code>.{' '}
              <code>0</code> now lifts every limit. One startup warning per loosened
              protection.
            </>
          ),
        },
      ]} />
    </>
  );
}
