import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Endpoints',
  description:
    'The URLs the GioJS server answers itself: the /_gio endpoints, /_next/static assets and public/ files, with their methods, auth, responses and switches.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Endpoints</h1>
      <p className="page-subtitle">
        The URLs the GioJS server answers itself: the <code>/_gio</code> endpoints,{' '}
        <code>/_next/static</code> assets and <code>public/</code> files, with their methods,
        auth, responses and switches.
      </p>
      <CodeBlock lang="bash" code={`curl -s http://localhost:3000/_gio/health
{"cacheEntries":0,"deploymentId":"0e92bc3a01f4ea44","http2":true,"nodeReady":true,"status":"ok","tls":false,"uptimeSecs":28,"workers":{"configured":1,"ready":1}}`} />
      <p>
        These are answered by the Rust server, never by your app: no page,{' '}
        <code>route.ts</code> or <code>gio.config.ts</code> plugin can take over a path
        under <code>/_gio/</code>.
      </p>

      <h2 id="reference">Reference</h2>
      <table>
        <thead>
          <tr><th>Endpoint</th><th>Exists</th><th>Access</th><th>Turn it off</th></tr>
        </thead>
        <tbody>
          <tr><td><a href="#gio-health"><code>GET /_gio/health</code></a></td><td>always</td><td>anyone</td><td><code>[health] enabled = false</code></td></tr>
          <tr><td><a href="#gio-metrics"><code>GET /_gio/metrics</code></a></td><td>with a <code>[metrics]</code> section</td><td>loopback, or <code>token</code> / <code>ip_allowlist</code></td><td>leave out <code>[metrics]</code>, or <code>enabled = false</code></td></tr>
          <tr><td><a href="#gio-image"><code>GET /_gio/image</code></a></td><td>always</td><td>anyone; guards apply to local files</td><td><code>[images] enabled = false</code></td></tr>
          <tr><td><a href="#post-gio-revalidate"><code>POST /_gio/revalidate</code></a></td><td>with a revalidation token</td><td><code>Authorization: Bearer</code></td><td>no token</td></tr>
          <tr><td><a href="#gio-fonts"><code>GET /_gio/fonts/*</code></a></td><td>always</td><td>anyone</td><td>-</td></tr>
          <tr><td><a href="#gio-devtools"><code>/_gio/devtools*</code></a></td><td>development only</td><td>local hosts and <code>[dev] allowed_hosts</code></td><td><code>[dev] devtools = false</code></td></tr>
          <tr><td><a href="#next-static"><code>GET /_next/static/*</code></a></td><td>always</td><td>anyone</td><td>-</td></tr>
          <tr><td><a href="#public-files"><code>public/</code> files</a></td><td>always</td><td>anyone; rules apply</td><td>-</td></tr>
        </tbody>
      </table>
      <p>
        Any other path under <code>/_gio/</code> answers <code>404</code> (see{' '}
        <a href="#gio-namespace">The /_gio namespace</a>). An endpoint that is turned off is
        not routed, so it answers that same <code>404</code>.
      </p>

      <h3 id="gio-health"><code>/_gio/health</code></h3>
      <p>
        <code>GET</code>. The liveness and readiness endpoint for load balancers, orchestrators and uptime
        monitors. Always <code>200</code> with <code>application/json</code>, even while every
        worker is restarting: cached pages and static files keep serving then, so the
        server is up. Readiness probes should read <code>nodeReady</code>.
      </p>
      <PropsTable kind="Field" rows={[
        { name: 'status', type: '"ok"', description: 'Always "ok".' },
        { name: 'nodeReady', type: 'boolean', description: <><code>false</code> only while no render worker is connected (all of them restarting at once).</> },
        { name: 'deploymentId', type: 'string', description: <>The current <a href="/docs/env-vars#gio-deployment-id">deployment ID</a>.</> },
        { name: 'workers', type: '{ configured: number; ready: number }', description: <>The pool size and how many workers are connected.</> },
        { name: 'http2', type: 'boolean', description: 'Whether the server negotiates HTTP/2.' },
        { name: 'tls', type: 'boolean', description: <>Whether <code>[server.tls]</code> is on.</> },
        { name: 'cacheEntries', type: 'number', description: 'Pages in the in-memory cache.' },
        { name: 'uptimeSecs', type: 'number', description: 'Seconds since the server started.' },
      ]} />
      <p>
        With <a href="/docs/configuration/health"><code>[health] details = false</code></a>{' '}
        the body is only <code>{'{"nodeReady":true,"status":"ok"}'}</code>, for a server
        reachable from the internet that should not tell visitors its deployment ID or
        topology. With <code>enabled = false</code> the path is a <code>404</code>;{' '}
        <code>gio dev</code>, <code>gio start</code> and the testing kit then take that{' '}
        <code>404</code> as ready, since the port only opens once a worker is connected.
      </p>

      <h3 id="gio-metrics"><code>/_gio/metrics</code></h3>
      <p>
        <code>GET</code>, in Prometheus text format (<code>text/plain; version=0.0.4</code>). The route answers{' '}
        <code>404</code> unless <code>gio.toml</code> has a{' '}
        <a href="/docs/configuration/metrics"><code>[metrics]</code></a> section (whose{' '}
        <code>enabled</code> defaults to <code>true</code>). Who may scrape it:
      </p>
      <ul>
        <li>With <code>ip_allowlist</code>: clients in the listed IPs or CIDR blocks, else <code>403</code>.</li>
        <li>With neither <code>ip_allowlist</code> nor <code>token</code>: loopback clients only, else <code>403</code>. A loopback request carrying <code>X-Forwarded-For</code>, <code>Forwarded</code> or <code>X-Real-IP</code> from a proxy <code>[server] trusted_proxies</code> does not list is refused too.</li>
        <li>With <code>token</code>: also <code>Authorization: Bearer &lt;token&gt;</code>, compared in constant time, else <code>401</code>.</li>
      </ul>
      <p>The client is the one resolved through <code>trusted_proxies</code>. The metrics:</p>
      <table>
        <thead>
          <tr><th>Metric</th><th>Type</th><th>Labels</th></tr>
        </thead>
        <tbody>
          <tr><td><code>gio_requests_total</code></td><td>counter</td><td><code>method</code>, <code>status</code>, <code>cache</code>, <code>route</code></td></tr>
          <tr><td><code>gio_request_duration_seconds</code></td><td>histogram</td><td><code>route</code></td></tr>
          <tr><td><code>gio_node_ipc_latency_seconds</code></td><td>histogram</td><td><code>route</code></td></tr>
          <tr><td><code>gio_cache_entries</code>, <code>gio_cache_size_bytes</code></td><td>gauge</td><td>-</td></tr>
          <tr><td><code>gio_prefetch_rejected_total</code></td><td>counter</td><td>-</td></tr>
          <tr><td><code>gio_image_processed_total</code></td><td>counter</td><td><code>format</code></td></tr>
          <tr><td><code>gio_ratelimit_checked_total</code></td><td>counter</td><td><code>path</code></td></tr>
          <tr><td><code>gio_ratelimit_rejected_total</code></td><td>counter</td><td><code>path</code>, <code>rule</code></td></tr>
          <tr><td><code>gio_memory_bytes</code></td><td>gauge</td><td><code>type=&quot;rss&quot;</code> (the Rust process only; 0 off Linux)</td></tr>
          <tr><td><code>gio_workers</code></td><td>gauge</td><td>-</td></tr>
          <tr><td><code>gio_worker_ready</code>, <code>gio_worker_in_flight</code></td><td>gauge</td><td><code>worker</code></td></tr>
          <tr><td><code>gio_worker_restarts_total</code></td><td>counter</td><td><code>worker</code></td></tr>
        </tbody>
      </table>
      <p>
        <code>route</code> is the matched pattern (<code>/posts/:id</code>), or{' '}
        <code>static</code> (assets and public files), <code>internal</code> (the{' '}
        <code>/_gio</code> endpoints) or <code>unmatched</code>, so the label set stays
        bounded however many URLs are requested; past 1024 patterns, the others count as{' '}
        <code>_other</code>. <code>cache</code> is <code>hit</code>, <code>stale</code>,{' '}
        <code>miss</code> (rendered by the worker, stored or not), <code>stream</code> (a
        streamed render), <code>error</code> (the worker failed or timed out),{' '}
        <code>bypass</code> (the <code>/_gio</code> endpoints, and a body over{' '}
        <code>max_body_bytes</code>) or <code>static</code>.
      </p>

      <h3 id="gio-image"><code>/_gio/image</code></h3>
      <p>
        <code>GET</code>. The image optimizer behind <a href="/docs/components/gio-image"><code>&lt;GioImage&gt;</code></a>:
        it resizes and re-encodes a source image, caches the result on disk, and serves it.
      </p>
      <PropsTable kind="Parameter" rows={[
        { name: 'src', type: 'string', required: true, description: <>A file in <code>public/</code> (<code>/hero.jpg</code> or <code>/public/hero.jpg</code>) or an <code>http(s)</code> URL matching <code>[images] remote_patterns</code>.</> },
        { name: 'w', type: 'number', description: <>Target width; must be one of <code>[images] allowed_widths</code> (default <code>16</code> ... <code>3840</code>). Left out, the source width is kept.</> },
        { name: 'q', type: 'number', default: '[images] quality (75)', description: <>Quality, <code>1</code>-<code>100</code>.</> },
        { name: 'f', type: '"avif" | "webp" | "jpeg" | "jpg" | "png"', description: <>Force an output format. A modern format left out of <code>[images] formats</code>, or an unknown value, falls back to negotiation.</> },
      ]} />
      <p>
        Without <code>f</code>, the format is the first of <code>[images] formats</code>{' '}
        (default AVIF, then WebP) that the request&apos;s <code>Accept</code> header names,
        else JPEG. A <code>200</code> carries <code>Vary: Accept</code>,{' '}
        <code>X-Gio-Cache: HIT</code> or <code>MISS</code> (the optimizer&apos;s own disk
        cache), and <code>Cache-Control: public, max-age=31536000, immutable</code>, or{' '}
        <code>private, no-cache</code> when a guard covers the source file and admitted this
        visitor.
      </p>
      <table>
        <thead>
          <tr><th>Status</th><th>When</th></tr>
        </thead>
        <tbody>
          <tr><td><code>400</code></td><td><code>w</code> not in <code>allowed_widths</code>, <code>q</code> outside 1-100, a remote image over <code>max_remote_bytes</code>, or a malformed query</td></tr>
          <tr><td><code>403</code></td><td>a remote host not in <code>remote_patterns</code>, a remote redirect, a path leaving <code>public/</code>, or a <a href="/docs/configuration/guards">guard</a> that turns this visitor away from the local file</td></tr>
          <tr><td><code>404</code></td><td>no <code>src</code>, or no such file</td></tr>
          <tr><td><code>500</code></td><td>the download failed (including an HTTP error status), or the image could not be decoded within <code>max_source_dimension</code> / <code>max_decode_bytes</code></td></tr>
        </tbody>
      </table>
      <p>
        Unlike the other <code>/_gio</code> endpoints, it counts against{' '}
        <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a> rules that
        match it: it is the most CPU-expensive endpoint there is. See{' '}
        <a href="/docs/configuration/images"><code>[images]</code></a> for every limit.
      </p>

      <h3 id="post-gio-revalidate"><code>/_gio/revalidate</code></h3>
      <p>
        <code>POST</code> only. On-demand revalidation for CMS webhooks, deploy scripts and other systems outside
        the app (code inside it calls <a href="/docs/functions/revalidate-tag"><code>revalidateTag</code></a>{' '}
        and <a href="/docs/functions/revalidate-path"><code>revalidatePath</code></a>). The
        route exists only when <a href="/docs/env-vars#gio-revalidate-token"><code>GIO_REVALIDATE_TOKEN</code></a>{' '}
        or <a href="/docs/configuration/revalidate"><code>[revalidate] token</code></a> is
        set (at least 32 bytes); otherwise it is a <code>404</code>.
      </p>
      <PropsTable kind="Field" rows={[
        { name: 'tags', type: 'string[]', description: <>Purge every page tagged with one of these (up to 64; each 1-256 bytes, no control characters, not starting with <code>_gio:</code>).</> },
        { name: 'paths', type: 'string[]', description: <>Purge these URL paths (up to 64; each starts with <code>/</code>, at most 2048 bytes, no <code>.</code>/<code>..</code> segments or malformed escapes; a query string is ignored). Pages are cached under their locale-free path, so <code>/fr/blog</code> purges <code>/blog</code> in every locale.</> },
        { name: 'prefix', type: 'boolean', default: 'false', description: <>Purge each path and everything below it.</> },
      ]} />
      <p>
        Send <code>Authorization: Bearer &lt;token&gt;</code> and a JSON body (the{' '}
        <code>Content-Type</code> is not checked) of at most 64 KiB with at least one tag or
        path. Unknown fields are an error, so a misspelled <code>tag</code> cannot silently
        purge nothing. Every answer is JSON with <code>Cache-Control: no-store</code>:
      </p>
      <table>
        <thead>
          <tr><th>Status</th><th>Body</th><th>When</th></tr>
        </thead>
        <tbody>
          <tr><td><code>200</code></td><td><code>{'{"ok":true,"purged":2}'}</code></td><td>Done: the entries are gone from memory and disk, PPR shells included. <code>purged</code> counts the entries removed.</td></tr>
          <tr><td><code>400</code></td><td><code>{'{"error":"..."}'}</code></td><td>Not the expected JSON, an unknown field, an invalid tag or path, too many, or nothing to revalidate.</td></tr>
          <tr><td><code>401</code></td><td><code>{'{"error":"unauthorized"}'}</code></td><td>Missing or wrong token; carries <code>WWW-Authenticate: Bearer</code>.</td></tr>
          <tr><td><code>408</code></td><td><code>{'{"error":"request body timed out"}'}</code></td><td>The body took longer than <code>[server] request_body_timeout_secs</code>.</td></tr>
          <tr><td><code>413</code></td><td><code>{'{"error":"request body too large"}'}</code></td><td>Over 64 KiB.</td></tr>
          <tr><td><code>429</code></td><td><code>{'{"error":"too many failed attempts"}'}</code></td><td>After 10 failed attempts from one client (an IPv6 client counts by its <code>/64</code>), every request from it is refused this way, with <code>Retry-After</code> and before its token is even checked, until a minute has passed since its first failure. The 10 failures themselves get <code>401</code>.</td></tr>
        </tbody>
      </table>

      <h3 id="gio-fonts"><code>/_gio/fonts</code></h3>
      <p>
        <code>GET /_gio/fonts/*</code>: the self-hosted <a href="/docs/font-optimization"><code>[[fonts]]</code></a> files,
        downloaded or copied at startup into <code>.gio/fonts</code> (
        <a href="/docs/env-vars#gio-fonts-dir"><code>GIO_FONTS_DIR</code></a>), and{' '}
        <code>/_gio/fonts/fonts.css</code> with their <code>@font-face</code> rules. Pages
        link the stylesheet and preload each font (unless <code>preload = false</code>). Font
        files are immutable (<code>public, max-age=31536000, immutable</code>);{' '}
        <code>fonts.css</code> is rewritten at every start under the same URL, so it
        revalidates (<code>public, max-age=0, must-revalidate</code>). Both carry{' '}
        <code>X-Gio-Cache: static</code>.
      </p>

      <h3 id="gio-devtools"><code>/_gio/devtools</code></h3>
      <p>
        Development endpoints, routed only when the server runs in development mode and{' '}
        <a href="/docs/configuration/dev"><code>[dev] devtools</code></a> is on (the
        default). In production they are <code>404</code>. Every one checks the request
        before it runs: the <code>Host</code> must be a localhost name or loopback IP (on a
        connection from this machine), the specific <code>[server] host</code>, or an entry
        of <code>[dev] allowed_hosts</code>; otherwise a <code>403</code> explains which
        entry to add. This defeats DNS rebinding.
      </p>
      <table>
        <thead>
          <tr><th>Endpoint</th><th>Answers</th><th>Extra check</th></tr>
        </thead>
        <tbody>
          <tr><td><code>GET /_gio/devtools</code></td><td>The dev dashboard (HTML): routes, cache, connections, memory, live log.</td><td>Host only.</td></tr>
          <tr><td><code>GET /_gio/devtools/state</code></td><td>The dashboard&apos;s data as JSON.</td><td>Not cross-site: <code>Sec-Fetch-Site</code> other than <code>cross-site</code>, and an <code>Origin</code> (if any) naming the host.</td></tr>
          <tr><td><code>GET /_gio/devtools/stream</code></td><td><code>text/event-stream</code> of log lines and snapshots; the live-reload channel.</td><td>Same as <code>state</code>.</td></tr>
          <tr><td><code>GET /_gio/devtools/codeframe?file=&amp;line=</code></td><td><code>{'{ file, line, lines: [{ no, text }] }'}</code>: the line and 4 lines around it, for the error overlay. <code>403</code> outside the project root (symlinks resolved), <code>404</code> for a missing file, <code>400</code> for a non-source file, a line out of range or a file over 2 MiB.</td><td>Same as <code>state</code>.</td></tr>
          <tr><td><code>POST /_gio/devtools/open-in-editor?file=&amp;line=</code></td><td><code>{'{"ok":true}'}</code> after launching <a href="/docs/env-vars#gio-editor"><code>GIO_EDITOR</code></a> on the file. <code>GET</code> is <code>405</code>.</td><td>Same-origin only: <code>Sec-Fetch-Site</code>, when sent, must be <code>same-origin</code> or <code>none</code>, and an <code>Origin</code> must name the host.</td></tr>
        </tbody>
      </table>
      <p>
        With <code>[dev] devtools = false</code> none of them is routed, and the error
        overlay shows no codeframes, editor links or live reload.
      </p>

      <h3 id="next-static"><code>/_next/static</code></h3>
      <p>
        <code>GET /_next/static/*</code>: the client bundles and stylesheets the worker builds at startup:{' '}
        <code>/_next/static/chunks/</code> (route chunks) and <code>/_next/static/css/</code>{' '}
        (route stylesheets, CSS Modules). Names carry a content hash, so they are served with{' '}
        <code>Cache-Control: public, max-age=31536000, immutable</code> and{' '}
        <code>X-Gio-Cache: static</code>. The directory is <code>.gio/build/static</code> (
        <a href="/docs/env-vars#gio-static-dir"><code>GIO_STATIC_DIR</code></a>).
      </p>

      <h3 id="public-files"><code>public/</code> files</h3>
      <p>
        Every file in <code>public/</code> (<a href="/docs/env-vars#gio-public-dir"><code>GIO_PUBLIC_DIR</code></a>)
        answers at two URLs:
      </p>
      <ul>
        <li>
          At the site root, <code>/robots.txt</code> for <code>public/robots.txt</code>, on{' '}
          <code>GET</code> and <code>HEAD</code>, ahead of your pages: a public file wins
          over a page with the same path. Served with{' '}
          <code>Cache-Control: public, max-age=0, must-revalidate</code> and{' '}
          <code>Last-Modified</code>, since the URL stays the same across deploys. Dotfiles
          (except under <code>.well-known/</code>), symlinks and a top-level{' '}
          <code>public/_gio/</code> are never served here. The set of files is indexed at
          startup (and by the dev watcher): in production, a file added later needs a
          restart.
        </li>
        <li>
          Under <code>/public/</code>, <code>/public/robots.txt</code>, with{' '}
          <code>Last-Modified</code> and no <code>Cache-Control</code> of its own. An escaped
          separator (<code>%2F</code>, <code>%5C</code>) is a <code>400</code> there.
        </li>
      </ul>
      <p>
        Both answer <code>X-Gio-Cache: static</code> and never reach Node. Guards, header
        rules and rate limits written for the <code>/public/...</code> URL also apply to the
        root URL. A file named like a metadata route (<code>public/robots.txt</code>,{' '}
        <code>public/sitemap.xml</code>, <code>public/manifest.webmanifest</code>) wins over{' '}
        <code>app/robots.ts</code> and the others, with a startup warning.
      </p>

      <h3 id="gio-namespace">The <code>/_gio</code> namespace</h3>
      <p>
        <code>/_gio/</code> belongs to the server. A path under it that is not one of the
        endpoints above answers <code>404</code> from Rust before rate limits, rules, the
        cache or Node see it, so <code>/_gio/settings</code> can never render{' '}
        <code>app/[org]/settings</code> with <code>org = &quot;_gio&quot;</code>, and a guard
        on <code>/:org/settings</code> cannot be sidestepped that way. The check uses the
        first non-empty segment of the normalized path (<code>//_gio/x</code> counts), and
        also applies after a locale prefix is stripped or a rewrite lands there. It cannot be
        turned off.
      </p>

      <h2 id="examples">Examples</h2>

      <h3 id="kubernetes-probes">Kubernetes probes</h3>
      <CodeBlock lang="yaml" code={`livenessProbe:
  httpGet: { path: /_gio/health, port: 3000 }
readinessProbe:
  exec:
    command: ["node", "-e", "fetch('http://127.0.0.1:3000/_gio/health').then(r => r.json()).then(h => process.exit(h.nodeReady ? 0 : 1), () => process.exit(1))"]`} />

      <h3 id="purge-from-a-cms-webhook">Purge from a CMS webhook</h3>
      <CodeBlock lang="bash" code={`curl -X POST https://example.com/_gio/revalidate \\
  -H "Authorization: Bearer $GIO_REVALIDATE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"tags":["post:42"],"paths":["/blog"],"prefix":true}'
# {"ok":true,"purged":3}`} />

      <h3 id="scrape-metrics-from-a-prometheus-server">Scrape metrics from a Prometheus server</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[metrics]
token = "a-long-random-scrape-token"
ip_allowlist = ["10.0.0.0/8"]`} />
      <CodeBlock lang="yaml" title="prometheus.yml" code={`scrape_configs:
  - job_name: giojs
    metrics_path: /_gio/metrics
    authorization:
      credentials: a-long-random-scrape-token
    static_configs:
      - targets: ["app-1:3000", "app-2:3000"]`} />

      <h3 id="request-an-optimized-image">Request an optimized image</h3>
      <CodeBlock lang="bash" code={`curl -sI "http://localhost:3000/_gio/image?src=/hero.jpg&w=640&q=75" -H "Accept: image/avif,image/webp"
# HTTP/1.1 200 OK
# content-type: image/avif
# cache-control: public, max-age=31536000, immutable
# vary: Accept
# x-gio-cache: MISS`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The <code>/_gio</code> endpoints are exempt from <code>[[rate_limits]]</code> (except{' '}
          <code>/_gio/image</code>), from guards, redirects, rewrites and header rules, and
          from the CSRF check; each has its own access control instead. They still get the
          default security headers and an <code>X-Request-Id</code>.
        </li>
        <li>
          Fixed, by design: the closed <code>/_gio</code> namespace, the same-origin check on
          open-in-editor (even with <code>allowed_hosts = [&quot;*&quot;]</code>), the
          optimizer&apos;s path-traversal and redirect checks, and the 32-byte minimum for the
          revalidation token.
        </li>
        <li>
          <code>/_gio/health</code> is answered even when the app cannot render, so it
          proves the server is up, not that your pages work; probe a page of your own for
          that.
        </li>
        <li>
          A static export has no server: none of these endpoints exist there, and{' '}
          <code>&lt;GioImage&gt;</code> renders its plain <code>src</code>.
        </li>
        <li>
          Metadata routes (<code>/sitemap.xml</code>, <code>/robots.txt</code>,{' '}
          <code>/manifest.webmanifest</code>) are app routes rendered by the worker; see{' '}
          <a href="/docs/file-conventions/sitemap">sitemap</a>,{' '}
          <a href="/docs/file-conventions/robots">robots</a> and{' '}
          <a href="/docs/file-conventions/manifest">manifest</a>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/headers">Headers</a> - what these endpoints and your pages send and read</li>
        <li><a href="/docs/deployment#health-check">Health check</a> and <a href="/docs/observability#metrics">Metrics</a> in production</li>
        <li><a href="/docs/caching#from-outside-post-giorevalidate">On-demand revalidation</a></li>
        <li><a href="/docs/image-optimization">Image Optimization</a> and <a href="/docs/font-optimization">Font Optimization</a></li>
        <li><a href="/docs/error-handling#development-error-overlay">Development error overlay</a></li>
        <li><a href="/docs/configuration/health"><code>[health]</code></a>, <a href="/docs/configuration/metrics"><code>[metrics]</code></a>, <a href="/docs/configuration/images"><code>[images]</code></a>, <a href="/docs/configuration/revalidate"><code>[revalidate]</code></a>, <a href="/docs/configuration/dev"><code>[dev]</code></a></li>
        <li><a href="/docs/guides/security-switches">Turning Protections On and Off</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              <code>POST /_gio/revalidate</code> added. Unknown <code>/_gio/</code> paths
              answer <code>404</code> in Rust. <code>public/</code> served at the site root.{' '}
              <code>[health] enabled</code> / <code>details</code>,{' '}
              <code>[images] enabled</code> and <code>[dev] devtools</code> switches.{' '}
              <code>/_gio/metrics</code> answers loopback clients only without a token or
              allowlist, adds route labels and worker metrics; <code>/_gio/health</code> adds{' '}
              <code>workers</code>. Dev endpoints answer local hosts only, and open-in-editor
              is same-origin <code>POST</code>. Guards cover local <code>/_gio/image</code>{' '}
              sources. <code>fonts.css</code> revalidates, and the fonts carry{' '}
              <code>X-Gio-Cache: static</code>. <code>/_gio/health</code> sends a{' '}
              <code>Content-Length</code> instead of a chunked body.
            </>
          ),
        },
        { version: 'v0.1.0-beta.6', changes: <><code>/_gio/health</code> reports <code>deploymentId</code>, <code>nodeReady</code>, <code>cacheEntries</code> and <code>uptimeSecs</code>. <code>/_gio/image</code> honors <code>[[rate_limits]]</code>. Dev codeframe and open-in-editor endpoints.</> },
        { version: 'v0.1.0-beta.1', changes: <><code>/_gio/health</code>, <code>/_gio/metrics</code>, <code>/_gio/image</code>, <code>/_gio/devtools</code>, <code>/_next/static</code> and <code>public/</code> serving introduced.</> },
      ]} />
    </>
  );
}
