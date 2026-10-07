import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../components/PmTabs.tsx';

export const metadata: Metadata = {
  title: 'Upgrading',
  description:
    'Move an app from GioJS 0.1.0-beta.7 to 0.1.0-beta.8 step by step: packages, scripts, ' +
    'gio.toml, routes, the new security defaults, caching, errors and deploys.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Upgrading</h1>
      <p className="page-subtitle">
        Move an app from GioJS <code>0.1.0-beta.7</code> to <code>0.1.0-beta.8</code> step by
        step: packages, scripts, <code>gio.toml</code>, routes, the new security defaults,
        caching, errors and deploys.
      </p>

      <p>
        Beta.8 turns on production defaults - CSRF protection, security headers, bounded
        connections, strict configuration - and changes a few behaviors apps relied on. Most
        apps need only steps 1 to 4; the rest apply when you use the feature they name. Each
        step says what changed, how to tell whether it affects you, and what to change. The
        complete list is the <a href="/releases">release notes</a>; what each new default
        protects, and how to turn it off, is in{' '}
        <a href="/docs/guides/security-switches">Turning Protections On and Off</a>.
      </p>

      <h2 id="1-update-the-packages">1. Update the packages</h2>
      <p>
        Install the new versions together: the server binary and <code>@gio.js/core</code>{' '}
        check each other&apos;s protocol version when the worker starts, and{' '}
        <a href="/docs/cli/doctor"><code>gio doctor</code></a> reports <code>@gio.js/*</code> packages that are not in
        lockstep. Add{' '}
        <code>@gio.js/core</code> if it is not a direct dependency yet (types and server
        helpers are imported from it), and move <code>cross-env</code> to{' '}
        <code>dependencies</code>, since <code>npm start</code> now uses it in production:
      </p>
      <PmTabs command={`npm install @gio.js/server@0.1.0-beta.8 @gio.js/core@0.1.0-beta.8 @gio.js/react@0.1.0-beta.8 cross-env`} />
      <p>
        Building the server from source (instead of the published binary) needs Rust 1.89 or
        newer.
      </p>

      <h2 id="2-fix-the-start-script">2. Fix the start script</h2>
      <p>
        <strong>What changed:</strong> the server decides the runtime mode, and the Node
        worker follows it - <code>development</code> only when the server starts with{' '}
        <code>NODE_ENV=development</code>, <code>production</code> otherwise. Beta.7 ran a
        development worker (dev bundles, source maps, error stacks) behind a production
        server when <code>NODE_ENV</code> was unset.
      </p>
      <CodeBlock lang="diff" title="package.json" code={`   "scripts": {
     "dev": "cross-env NODE_ENV=development giojs-server",
-    "start": "giojs-server"
+    "start": "cross-env NODE_ENV=production giojs-server"
   },`} />
      <p>
        The new <a href="/docs/cli/dev"><code>gio dev</code></a> and{' '}
        <a href="/docs/cli/start"><code>gio start</code></a> set the mode themselves. Bare{' '}
        <code>gio</code> no longer starts a server: it prints the help and exits with code{' '}
        <code>2</code>. Replace it in scripts and Dockerfiles:
      </p>
      <CodeBlock lang="diff" title="Dockerfile" code={`- CMD ["npx", "gio"]
+ CMD ["npx", "gio", "start"]`} />

      <h2 id="3-validate-your-configuration">3. Validate your configuration</h2>
      <p>
        <strong>What changed:</strong> an unknown section or key anywhere in{' '}
        <code>gio.toml</code> now stops startup with the file, the line and the closest valid
        key. <a href="/docs/gio-config"><code>gio.config.ts</code></a> is validated too (unknown keys, plugins without a{' '}
        <code>name</code>), and a <a href="/docs/configuration/guards"><code>[[guards]]</code></a> entry with a misspelled key, no
        requirement or an invalid path fails startup instead of being skipped. Run the check
        before you deploy. It never binds a port, and lists every validation problem at
        once; an unknown key or a TOML syntax error is reported on its own, so run it again
        after fixing one:
      </p>
      <CodeBlock lang="bash" code={`npx giojs-server --check-config     # JSON report; exit code 1 when startup would fail
npx gio doctor                       # the same check, plus Node, versions, tsconfig and the port`} />
      <CodeBlock lang="text" code={`gio.toml:5: unknown key [image] - did you mean [images]?`} />
      <p>Keys that never did anything are now rejected with what to use instead:</p>
      <CodeBlock lang="diff" title="gio.toml" code={`  [cache]
- memory_mb = 256
+ memory_max_entries = 1000      # pages kept in memory

- [cache.redis]                  # no Redis backend exists yet: remove it
- url = "redis://cache:6379"

- [css]
- engine = "lightningcss"        # remove: there is one engine

- [prefetch]
- strategy = "hover"             # remove: choose per link with <GioLink prefetch>

- [my-tool]                      # settings for other tools: name the table x-...
+ [x-my-tool]
  option = true`} />
      <p>Also check these, which changed meaning:</p>
      <ul>
        <li>
          <strong><code>0</code> now lifts a limit everywhere.</strong> In beta.7,{' '}
          <a href="/docs/configuration/websocket"><code>[websocket] max_connections = 0</code></a> closed every socket,{' '}
          <code>[websocket] ping_interval_secs = 0</code> crashed every connection, and{' '}
          <code>[images] max_remote_bytes = 0</code> rejected every remote image. Each now
          means unlimited (no pings). If you used <code>0</code> to turn something off, use
          its switch:
          <CodeBlock lang="diff" title="gio.toml" code={`  [websocket]
- max_connections = 0
+ enabled = false`} />
          The <a href="/docs/configuration/prefetch"><code>[prefetch]</code></a> keys are new in beta.8 - beta.7 ignored the section and
          always used the built-in budget - and follow the same rule:{' '}
          <code>max_concurrent = 0</code> or <code>max_per_second = 0</code> lifts that
          budget, and <code>[prefetch] enabled = false</code> turns prefetching off.
        </li>
        <li>
          <strong><code>[server] max_body_bytes = 0</code></strong> used to answer{' '}
          <code>413</code> to every body; it now means no limit of its own (the worker&apos;s
          message cap, about 48 MiB of binary body, still applies) and logs a warning.
        </li>
        <li>
          <strong>A malformed <code>[metrics] ip_allowlist</code> entry</strong> stops startup,
          like a malformed <code>trusted_proxies</code> entry.
        </li>
        <li>
          <strong>The page cache directory</strong> (<a href="/docs/configuration/cache"><code>[cache] disk_path</code></a> or{' '}
          <code>GIO_CACHE_DIR</code>) may no longer be, contain or sit inside{' '}
          <code>app/</code> or <a href="/docs/file-conventions/public-folder"><code>public/</code></a>.
        </li>
      </ul>
      <p>
        New apps&apos; <code>gio.toml</code> starts with a schema line that gives editors
        completion and hover docs; add it to yours:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`#:schema ./node_modules/@gio.js/server/gio.schema.json`} />

      <h2 id="4-review-env-files">4. Review your .env files</h2>
      <p>
        <strong>What changed:</strong> the server now loads <code>.env.{'{mode}'}.local</code>,{' '}
        <code>.env.local</code>, <code>.env.{'{mode}'}</code> and <code>.env</code> from the
        project root at startup, with variables already in the environment winning. A
        committed <code>.env</code> that was ignored before now applies - check what it sets.{' '}
        <code>NODE_ENV</code> in a file is ignored, and a file that cannot be parsed stops
        startup with its name and line. To keep the old behavior, turn loading off:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[env]
files = false        # or GIO_ENV_FILES=0 in the environment`} />
      <p>
        Only <code>GIO_PUBLIC_*</code> variables reach browser code. See{' '}
        <a href="/docs/guides/environment-variables">Environment Variables</a>.
      </p>

      <h2 id="5-check-your-routes">5. Check your routes</h2>
      <p>
        <strong>What changed:</strong> <code>app/</code> follows the App Router folder rules.
        Run <a href="/docs/cli/routes"><code>gio routes</code></a> before and after upgrading
        and compare the URLs:
      </p>
      <ul>
        <li>
          <code>(group)</code> folders no longer appear in URLs, and <code>_private</code>{' '}
          folders are never routed: move routes out of <code>_</code>-prefixed folders.
        </li>
        <li>
          <code>[...slug]</code> matches one or more segments and <code>[[...slug]]</code> zero
          or more; the param is one <code>/</code>-joined string (<code>&apos;a/b&apos;</code>,
          or <code>&apos;&apos;</code> for an optional catch-all that matched nothing):
          <CodeBlock lang="ts" title="app/docs/[...slug]/page.tsx" code={`import type { GsspContext } from '@gio.js/core';

export async function getServerSideProps(ctx: GsspContext<'/docs/*slug'>) {
  const parts = ctx.params.slug.split('/'); // /docs/guides/install -> ['guides', 'install']
  return { props: { parts } };
}`} />
        </li>
        <li>
          Layouts come from the folder tree, so layouts inside dynamic folders and route
          groups now apply. Two files that answer the same URL fail startup, naming both.
        </li>
        <li>
          <code>public/</code> is served at the site root (<code>/favicon.ico</code>,{' '}
          <code>/robots.txt</code>) ahead of pages: a public file wins over a page with the
          same path. It defaults to the directory next to <code>app/</code>{' '}
          (<code>GIO_PUBLIC_DIR</code> overrides it).
        </li>
        <li>
          <code>/_gio/</code> belongs to the framework: an app route there now answers{' '}
          <code>404</code>.
        </li>
        <li>
          Request paths are canonical: repeated and trailing slashes collapse before rules
          match, and paths with <code>.</code> or <code>..</code> segments or a bad{' '}
          <code>%</code> escape get <code>400</code>.
        </li>
        <li>
          <code>*rest</code> in guards, redirects, rewrites and header rules now also matches
          zero segments: <code>/admin/*rest</code> covers <code>/admin</code>, and a{' '}
          <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a> path <code>/api/*</code> covers <code>/api</code>.
        </li>
        <li>
          A <a href="/docs/file-conventions/route"><code>route.ts</code></a> that throws while it is imported now answers <code>500</code>{' '}
          instead of <code>404</code>.
        </li>
      </ul>

      <h2 id="6-allow-legitimate-cross-site-requests">6. Allow legitimate cross-site requests</h2>
      <p>
        <strong>What changed:</strong> CSRF protection is on. Cross-site <code>POST</code>,{' '}
        <code>PUT</code>, <code>PATCH</code> and <code>DELETE</code> requests from browsers get{' '}
        <code>403</code> before your code runs; cross-origin WebSocket upgrades get{' '}
        <code>403</code> too. Requests without browser headers - curl, server-to-server
        webhooks - pass. You are affected if another site posts the browser to you: OAuth/OIDC{' '}
        <code>response_mode=form_post</code> callbacks (Sign in with Apple, Entra ID), SAML ACS
        endpoints, 3-D Secure returns, or a second front-end on another origin:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[security.csrf]
exempt = ["/auth/callback/apple", "/saml/acs", "/api/webhooks/*rest"]
trusted_origins = ["https://admin.example.com"]   # your other origins (also for WebSockets)`} />
      <p>
        Behind nginx, keep <code>proxy_set_header Host $host</code> (or list the proxy in{' '}
        <a href="/docs/configuration/server"><code>[server] trusted_proxies</code></a> so <code>X-Forwarded-Host</code> counts): the check
        compares <code>Origin</code> with the host. See{' '}
        <a href="/docs/security#csrf">Security: CSRF protection</a>.
      </p>

      <h2 id="7-check-pages-embedded-in-frames">7. Check pages embedded in frames</h2>
      <p>
        <strong>What changed:</strong> every response carries{' '}
        <code>X-Content-Type-Options: nosniff</code>, <code>X-Frame-Options: SAMEORIGIN</code>{' '}
        and <code>Referrer-Policy: strict-origin-when-cross-origin</code> (plus HSTS with{' '}
        <a href="/docs/configuration/server-tls"><code>[server.tls]</code></a>), and <code>X-Powered-By</code> is removed. If other sites
        embed your pages in an <code>&lt;iframe&gt;</code>, lift the frame header for those
        paths:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[headers]]
path = "/embed/*rest"
[headers.headers]
x-frame-options = ""          # "" removes the default for these paths`} />

      <h2 id="8-send-a-json-content-type">8. Send a JSON content type</h2>
      <p>
        <strong>What changed:</strong> in route handlers, <code>req.json()</code> only parses
        bodies sent as <code>application/json</code> or <code>application/*+json</code>; anything
        else throws <code>UnsupportedMediaTypeError</code>, a <code>415</code> unless caught.
        Make your <code>fetch()</code> calls say what they send:
      </p>
      <CodeBlock lang="diff" code={`  await fetch('/api/posts', {
    method: 'POST',
+   headers: { 'content-type': 'application/json' },
    body: JSON.stringify(post),
  });`} />
      <p>
        <code>req.body</code> still holds the raw body for other formats, and{' '}
        <code>req.formData()</code> parses forms. See{' '}
        <a href="/docs/functions/request-errors">Request errors</a>.
      </p>

      <h2 id="9-check-cached-pages-that-read-cookies">9. Check cached pages that read cookies</h2>
      <p>
        <strong>What changed:</strong> a page that exports <code>revalidate</code> but whose{' '}
        <a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a> reads <code>ctx.cookies</code>, the{' '}
        <code>cookie</code> or <code>authorization</code> header, <code>ctx.ip</code>,{' '}
        <code>ctx.host</code> or <code>ctx.scheme</code> now renders per request and is never
        stored - beta.7 cached it and served the first visitor&apos;s page to everyone. Neither
        is a response that sets a cookie. A warning in the server log names each such route.
        Either drop <code>revalidate</code>, or cache the shared part and personalize
        inside Suspense holes:
      </p>
      <CodeBlock lang="diff" title="app/shop/page.tsx" code={`  export const revalidate = 60;
+ export const shell = 'cache';   // cache everything above the first pending <Suspense>`} />
      <p>
        Cached pages also send{' '}
        <code>Cache-Control: public, max-age=0, s-maxage=&lt;revalidate&gt;, stale-while-revalidate=...</code>{' '}
        now, so a CDN in front caches them - and an on-demand purge does not reach the CDN. Set
        your own <code>Cache-Control</code> with a <a href="/docs/configuration/headers"><code>[[headers]]</code></a> rule where that is
        not wanted. See <a href="/docs/caching#browser-and-cdn-caching">Caching</a>.
      </p>

      <h2 id="10-update-error-tsx">10. Update error.tsx</h2>
      <p>
        <strong>What changed:</strong> in production a failed render shows only a digest - a
        short reference the real error is logged under - and <a href="/docs/file-conventions/error"><code>error.tsx</code></a> receives{' '}
        <code>{'{ error: { message, digest }, reset }'}</code>, where <code>message</code> is{' '}
        <code>Internal Server Error</code>. <code>error.tsx</code> is also a client error
        boundary now, bundled into every page below its folder, so it must not import
        server-only code:
      </p>
      <CodeBlock lang="diff" title="app/error.tsx" code={`- interface ErrorPageProps { error?: { message: string } }
+ import type { ErrorPageProps } from '@gio.js/core';

- export default function Error({ error }: ErrorPageProps) {
+ export default function Error({ error, reset }: ErrorPageProps) {
    return (
      <div>
        <h1>Something went wrong</h1>
+       {error.digest !== undefined && <p>Error reference: <code>{error.digest}</code></p>}
+       {reset !== undefined && <button onClick={reset}>Try again</button>}
      </div>
    );
  }`} />
      <p>
        Search your logs for the digest to find the message and stack. See{' '}
        <a href="/docs/error-handling#production-error-responses">Error Handling</a>.
      </p>

      <h2 id="11-websockets">11. WebSockets</h2>
      <p>If you use <a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a> or <a href="/docs/hooks/use-web-socket"><code>useWebSocket</code></a>:</p>
      <ul>
        <li>
          <code>useWebSocket</code> reconnects by default, with backoff. Pass{' '}
          <code>reconnect: false</code> for the old behavior.
        </li>
        <li>
          A path with no <code>wsHandler</code> closes with <code>4404</code>.
        </li>
        <li>
          An async <code>wsHandler</code> now decides the connection: the socket gets
          broadcasts only once it resolves (to anything but <code>false</code>), and a rejected
          promise closes it with <code>1011</code>. A handler that awaits for the socket&apos;s
          whole lifetime must return once its listeners are set up:
          <CodeBlock lang="diff" title="app/chat/route.ts" code={`  import { broadcast, type GioSocket } from '@gio.js/core';

  export async function wsHandler(socket: GioSocket) {
    socket.join('lobby');
    socket.on('message', (data) => broadcast('lobby', String(data)));
-   await new Promise((resolve) => socket.on('close', resolve));   // pending while the socket is open
  }`} />
        </li>
      </ul>
      <p>See <a href="/docs/websockets">WebSockets</a>.</p>

      <h2 id="12-plugins-and-header-rules-that-touch-cookies">12. Plugins and header rules that touch cookies</h2>
      <p>
        Cookies a page or route handler sets now reach an <code>onResponse</code> plugin in{' '}
        <code>res.setCookies</code>, not <code>res.headers[&apos;set-cookie&apos;]</code>; set{' '}
        <code>setCookies: []</code> to strip them. A <code>set-cookie</code> header rule adds its
        cookie next to the response&apos;s own instead of replacing them. Header rules also
        apply to redirect and guard responses, and match the requested path rather than a
        rewritten one.
      </p>

      <h2 id="13-typed-routes">13. Typed routes</h2>
      <p>
        <code>.gio/routes.d.ts</code> now fills a global registry that <a href="/docs/functions/href"><code>href()</code></a>,{' '}
        <a href="/docs/hooks/use-params"><code>useParams()</code></a> and the <code>@gio.js/core</code> types all read. Routes you
        added by hand to <code>@gio.js/react</code>&apos;s <code>GioRegisteredRoutes</code> still
        type <code>href()</code>; move them so the core types see them too:
      </p>
      <CodeBlock lang="diff" title="types/routes.d.ts" code={`- declare module '@gio.js/react' {
-   interface GioRegisteredRoutes {
-     '/legacy/:id': { id: string };
-   }
- }
+ declare global {
+   namespace GioJS {
+     interface RegisteredRoutes {
+       '/legacy/:id': { id: string };
+     }
+   }
+ }
+ export {};`} />
      <p>
        In CI, run <a href="/docs/cli/typegen"><code>gio typegen</code></a> before{' '}
        <code>tsc</code> so the file exists without starting a server.
      </p>

      <h2 id="14-development-from-another-machine">14. Development from another machine</h2>
      <p>
        <strong>What changed:</strong> the dev endpoints (error-overlay codeframes,
        open-in-editor, the dashboard) and dev error details answer only local hosts on a
        connection from the same machine. If you open the dev server from a VM, a container
        port mapping, a phone on your network or a tunnel, list that host:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[dev]
allowed_hosts = ["myvm.local", "192.168.1.20", "*.tunnel.example"]`} />
      <p>
        An entry of <code>&quot;*&quot;</code>, which beta.7 dropped as invalid, now opens the
        dev endpoints and error details to every host and every machine, with a startup
        warning. Open-in-editor still takes same-origin requests only.
      </p>

      <h2 id="15-deploys">15. Deploys</h2>
      <ul>
        <li>
          <strong>Keep-alive.</strong> Idle HTTP/1.1 keep-alive connections now close after 10
          seconds (<code>[server] header_read_timeout_secs</code>). A proxy that pools upstream
          connections longer - nginx <code>keepalive</code>, ingress-nginx and AWS ALB default
          to 60 seconds - can answer with occasional <code>502</code>s. Keep the proxy&apos;s
          upstream idle timeout below 10 seconds, or raise{' '}
          <code>header_read_timeout_secs</code> and <code>idle_timeout_secs</code> above it.
        </li>
        <li>
          <strong>Metrics.</strong> A <a href="/docs/configuration/metrics"><code>[metrics]</code></a> section with neither{' '}
          <code>token</code> nor <code>ip_allowlist</code> answers only this machine now. Give
          your scraper a token or an allowlist:
          <CodeBlock lang="toml" title="gio.toml" code={`[metrics]
ip_allowlist = ["10.0.0.0/8"]          # your Prometheus network
# ip_allowlist = ["0.0.0.0/0", "::/0"] # everyone, as before (startup warns)`} />
          Behind a proxy on the same machine, list it in{' '}
          <code>[server] trusted_proxies</code>, or every client looks local.
        </li>
        <li>
          <strong>Static export.</strong> <a href="/docs/cli/export"><code>gio export</code></a> now ships client bundles and
          each page&apos;s <code>getServerSideProps</code> props as JSON: never return secrets
          from it. <code>public/</code> is copied to the root of <code>out/</code>.
        </li>
        <li>
          <strong>create-giojs</strong> rejects unknown flags and needs <code>--force</code> for
          a non-empty directory; it runs <code>git init</code> unless you pass{' '}
          <code>--no-git</code>.
        </li>
      </ul>

      <h2 id="16-verify">16. Verify</h2>
      <CodeBlock lang="bash" code={`npx gio doctor --prod        # configuration, versions, secrets, port
npx gio routes               # the URLs your app answers
npm start                    # production mode; read the startup warnings
curl -sI http://localhost:3000/ | grep -i 'x-frame-options\\|cache-control\\|x-gio-cache'`} />
      <p>
        Every startup warning names a <code>gio.toml</code> key that loosens a protection;
        each one should be deliberate. Then follow the{' '}
        <a href="/docs/guides/production-checklist">Production Checklist</a>.
      </p>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/releases">Release notes</a></li>
        <li><a href="/docs/guides/security-switches">Turning Protections On and Off</a></li>
        <li><a href="/docs/configuration">gio.toml reference</a></li>
        <li><a href="/docs/cli">CLI reference</a></li>
        <li><a href="/docs/migration">Migrating from Next.js</a></li>
      </ul>
    </>
  );
}
