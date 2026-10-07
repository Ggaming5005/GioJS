import React from 'react';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Deployment &amp; Operations</div>
      <h1>Production Checklist</h1>
      <p className="page-subtitle">
        What to check before a GioJS app takes real traffic - and what you can leave alone
        because the defaults already got it right.
      </p>

      <p>
        GioJS starts with production-safe defaults: no error details in responses, security
        headers on every response, cross-site form posts refused, dev endpoints off, metrics
        off. Most of this list is about the parts only you can know: your secrets, your
        proxy, your traffic. Each item links to the page with the details.
      </p>

      <h2>Runtime mode</h2>
      <ul>
        <li>
          <strong>Start in production mode.</strong> Anything but{' '}
          <code>NODE_ENV=development</code> is production - <code>npm start</code> and a
          standalone <code>run.mjs</code> default to it, <code>npm run dev</code> does not.
          The server decides once and starts its workers in the same mode.
        </li>
        <li>
          <strong>Check an error page.</strong> In production a failed render shows only an
          error reference (digest); the message and stack go to the log under the same
          digest. If you see a stack trace in the browser, the server is in development
          mode. See <a href="/docs/error-handling">Error Handling</a>.
        </li>
        <li>
          <strong>Use Node 20 or newer</strong>, and keep <code>@gio.js/server</code>,{' '}
          <code>@gio.js/core</code> and <code>@gio.js/react</code> on the same version - they
          are released in lockstep.
        </li>
        <li>
          <strong>Check where fonts come from.</strong> A <code>[[fonts]]</code> file in{' '}
          <code>public/</code> (the starter&apos;s) is copied at every start and needs no
          network - make sure it is in the image or standalone folder, since a missing file
          stops startup. An <code>https://</code> font <code>url</code> is downloaded into{' '}
          <code>.gio/fonts/</code> on a fresh host&apos;s first start, and a failed download
          stops startup: allow outbound HTTPS to that URL, persist the folder, or move the
          file into <code>public/</code>. See{' '}
          <a href="/docs/font-optimization#local-and-remote">Font Optimization</a>.
        </li>
      </ul>

      <h2>Secrets and environment</h2>
      <ul>
        <li>
          <strong>Set <code>GIO_SESSION_SECRET</code></strong> (32+ bytes) if you use{' '}
          <a href="/docs/authentication">sessions</a> or <code>require_session</code>{' '}
          guards. Without it, <code>createSessionStorage()</code> throws, so every page and{' '}
          <code>route.ts</code> importing your session module answers 500 (the log names the
          file and the missing secret under the response&apos;s digest), and guards deny every
          request. The server still starts - check <code>npx gio routes</code> with the
          production environment for routes marked <code>(failed to load)</code>.
        </li>
        <li>
          <strong>Set <code>GIO_REVALIDATE_TOKEN</code></strong> (32+ bytes) only if a CMS or
          script calls <code>POST /_gio/revalidate</code>; without it the endpoint does not
          exist.
        </li>
        <li>
          <strong>Keep secrets out of the browser.</strong> Nothing secret is named{' '}
          <code>GIO_PUBLIC_*</code>, <code>getServerSideProps</code> returns only what the
          page shows (props are sent to the browser), and modules holding secrets import{' '}
          <code>@gio.js/core/server-only</code>.
        </li>
        <li>
          <strong>Keep secrets out of git</strong>: <code>.env*.local</code> is ignored, and
          production values live in the host&apos;s environment. See{' '}
          <a href="/docs/guides/environment-variables">Environment Variables</a>.
        </li>
      </ul>

      <h2>Security headers and CSP</h2>
      <ul>
        <li>
          <strong>Defaults are on</strong>: <code>X-Content-Type-Options</code>,{' '}
          <code>X-Frame-Options: SAMEORIGIN</code>, <code>Referrer-Policy</code>. Add{' '}
          <code>Permissions-Policy</code> and the cross-origin policies your app can live
          with in <code>[security.headers]</code>.
        </li>
        <li>
          <strong>Add a Content-Security-Policy.</strong> Start with{' '}
          <code>csp_report_only</code>, watch the browser console on every page, then switch
          to <code>csp</code>. Nonces are fresh per response, cache hits included; nonce your
          own inline and third-party scripts with <code>cspNonce()</code>. See{' '}
          <a href="/docs/security#csp">Content-Security-Policy</a>.
        </li>
        <li>
          <strong>HSTS.</strong> GioJS sends <code>Strict-Transport-Security</code> on its own
          only when it terminates TLS. Behind a TLS proxy or a platform, set{' '}
          <code>[security] hsts = true</code> once the whole site is HTTPS.
        </li>
      </ul>
      <CodeBlock lang="toml" code={`[security]
csp_report_only = "default-src 'self'; script-src 'self' 'nonce-{nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
hsts = true

[security.headers]
permissions-policy = "camera=(), microphone=(), geolocation=()"`} />

      <h2>CSRF and origins</h2>
      <ul>
        <li>
          <strong>Same-origin forms and <code>fetch</code> calls just work</strong>; cross-site{' '}
          <code>POST</code>/<code>PUT</code>/<code>PATCH</code>/<code>DELETE</code> requests
          and WebSocket upgrades get a 403 before Node sees them.
        </li>
        <li>
          <strong>List other origins of yours</strong> that post to this app (an admin
          subdomain, a marketing site) in <code>[security.csrf] trusted_origins</code>.
        </li>
        <li>
          <strong>Exempt cross-site callbacks</strong> - OAuth/OIDC{' '}
          <code>response_mode=form_post</code>, SAML ACS, payment-provider returns, webhooks
          that send an <code>Origin</code> - in <code>[security.csrf] exempt</code>, and make
          sure each verifies its own signature or state. See{' '}
          <a href="/docs/security#csrf">CSRF protection</a>.
        </li>
        <li>
          <strong>Keep state changes off <code>GET</code></strong>, and session cookies{' '}
          <code>SameSite=Lax</code> (the default) or <code>Strict</code>.
        </li>
      </ul>

      <h2>Reverse proxy and client IPs</h2>
      <ul>
        <li>
          <strong>Trust exactly your proxy</strong> in <code>[server] trusted_proxies</code>,
          so rate limits, the metrics allowlist and <code>req.ip</code> see visitors instead of
          the proxy. Leave it empty when GioJS faces the internet directly.
        </li>
        <li>
          <strong>Make GioJS unreachable around the proxy</strong>: bind{' '}
          <code>host = &quot;127.0.0.1&quot;</code> or firewall the port.
        </li>
        <li>
          <strong>Pass the original <code>Host</code> through</strong> - the CSRF and
          WebSocket checks compare the browser&apos;s <code>Origin</code> with it.
        </li>
        <li>
          <strong>Decide who sets <code>X-Request-Id</code></strong>: let the proxy set it, or{' '}
          <code>accept_request_id = false</code> if the proxy passes a client&apos;s through.
        </li>
        <li>
          <strong>Line up keep-alive timeouts</strong> with a proxy that pools connections, or
          it can answer with sporadic 502s; turn off response buffering (nginx{' '}
          <code>proxy_buffering off</code>) so streamed pages stream. See{' '}
          <a href="/docs/deployment#reverse-proxy">Behind a reverse proxy</a>.
        </li>
      </ul>

      <h2>Limits</h2>
      <ul>
        <li>
          <strong>Rate-limit what attackers hammer</strong>: login and signup actions,
          password resets, expensive APIs. <code>[[rate_limits]]</code> run in Rust before
          routing. See <a href="/docs/configuration#rate-limits">Rate limits</a>.
        </li>
        <li>
          <strong>Size request bodies</strong>: <code>[server] max_body_bytes</code> (2 MiB by
          default) caps uploads - raise it for file uploads, and match the proxy&apos;s limit
          (nginx <code>client_max_body_size</code>).
        </li>
        <li>
          <strong>Keep the file-descriptor limit</strong> (<code>ulimit -n</code>,{' '}
          <code>LimitNOFILE=</code> in systemd) above <code>[server] max_connections</code>{' '}
          (10000). See <a href="/docs/configuration#connection-limits">Connection limits</a>.
        </li>
        <li>
          <strong>Allow only the image hosts you use</strong> in{' '}
          <code>[[images.remote_patterns]]</code>, with a <code>pathname</code> where you can.
        </li>
      </ul>

      <h2>Caching</h2>
      <ul>
        <li>
          <strong>Cache what can be shared.</strong> Pages without{' '}
          <code>export const revalidate</code> render on every request. Check what each route
          does with <code>gio cache explain &lt;url&gt;</code> or the{' '}
          <code>X-Gio-Cache</code> header. Personalized pages are never cached - see{' '}
          <a href="/docs/caching">Caching &amp; Revalidating</a>.
        </li>
        <li>
          <strong>Size the cache</strong>: <code>[cache] memory_max_entries</code> (1000
          pages) and <code>disk_max_bytes</code> (512 MiB). Put <code>disk_path</code> (or{' '}
          <code>GIO_CACHE_DIR</code>) on a persistent volume if a restart should come back
          warm.
        </li>
        <li>
          <strong>Purge on change</strong> with <code>revalidateTag()</code> /{' '}
          <code>revalidatePath()</code> or a CMS webhook to <code>/_gio/revalidate</code>.
          The cache is per instance: with several instances, purge each one.
        </li>
        <li>
          <strong>Several instances of one release</strong>: set{' '}
          <code>GIO_DEPLOYMENT_ID</code> to the same value (the release SHA) on all of them.
          See <a href="/docs/deployment#multi-instance">Multi-instance deployments</a>.
        </li>
      </ul>

      <h2>Render workers</h2>
      <ul>
        <li>
          <strong>Pick a worker count.</strong> One worker is plenty when most traffic is
          cache hits and static files. When uncached renders queue up, set{' '}
          <code>[server] workers</code> to a number or <code>&quot;auto&quot;</code>.
        </li>
        <li>
          <strong>Budget memory per worker</strong> - each is a full Node process (often
          100-200 MB) - and set container limits for the whole pool.
        </li>
        <li>
          <strong>Run one-time jobs once</strong>: plugin <code>onStartup</code> runs in every
          worker; guard migrations and schedulers with{' '}
          <code>process.env.GIO_WORKER_INDEX === &apos;0&apos;</code> or move them out of the
          server. See <a href="/docs/deployment#sizing">Sizing</a>.
        </li>
      </ul>

      <h2>Logs, metrics and health</h2>
      <ul>
        <li>
          <strong>JSON logs</strong> for a log shipper: <code>GIO_LOG_FORMAT=json</code> (or{' '}
          <code>[logging] format = &quot;json&quot;</code>). Every line of a request carries
          its request id in both processes. See <a href="/docs/observability">Observability</a>.
        </li>
        <li>
          <strong>Metrics</strong>: <code>[metrics] enabled = true</code> with an{' '}
          <code>ip_allowlist</code> or <code>token</code> - without either it answers only
          this machine, and an allowlist of <code>0.0.0.0/0</code> with no token logs a
          warning at startup. Alert
          on 5xx rates per <code>route</code>, p95 latency, and a climbing{' '}
          <code>gio_worker_restarts_total</code>.
        </li>
        <li>
          <strong>Health checks</strong> on <code>/_gio/health</code>. It always answers 200
          while the server runs; read <code>nodeReady</code> for &quot;can render
          right now&quot;. <code>[health] details = false</code> keeps the deployment id and
          worker counts out of it; <code>[health] enabled = false</code> turns it into a{' '}
          <code>404</code>, so point every probe at a page of your own first. See <a href="/docs/deployment#health-check">Health check</a>.
        </li>
        <li>
          <strong>Graceful stops</strong>: stop with <code>SIGTERM</code> and allow at least
          15-20 seconds (requests drain for up to 8, then workers get a few more). Several
          defaults are shorter: Docker&apos;s 10 seconds (use <code>--stop-timeout 20</code>),
          Fly.io&apos;s 5 (<code>kill_timeout = 20</code>) and Railway&apos;s 0
          (<code>&quot;drainingSeconds&quot;: 20</code>) - see{' '}
          <a href="/docs/guides/deploying">Deploying</a>. In systemd use{' '}
          <code>KillMode=mixed</code>.
        </li>
      </ul>

      <h2>SEO and URLs</h2>
      <ul>
        <li>
          <strong>Set <code>GIO_SITE_URL</code></strong> (or <code>metadataBase</code>) so
          canonical and Open Graph URLs, <code>sitemap.xml</code> and{' '}
          <code>robots.txt</code> are absolute. See <a href="/docs/metadata">Metadata &amp; SEO</a>.
        </li>
        <li>
          <strong>Never derive URLs or security decisions from <code>req.host</code></strong>{' '}
          - the host header is client-supplied.
        </li>
      </ul>

      <h2>Before every release</h2>
      <CodeBlock lang="bash" code={`npm run build            # typecheck (tsc --noEmit) - normal deploys have no other build step
npm test                 # your tests - @gio.js/core/testing has renderPage, callRoute, createTestServer
npx gio build standalone # if you ship a standalone folder or image`} />
      <p>
        Then deploy with one of the <a href="/docs/guides/deploying">deployment recipes</a>,
        and keep an eye on <a href="/docs/known-issues">known limitations</a> when planning
        features.
      </p>
    </>
  );
}
