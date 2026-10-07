import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Security &amp; Auth</div>
      <h1>Security</h1>
      <p className="page-subtitle">
        Security headers, Content-Security-Policy with per-request nonces, CSRF protection,
        and WebSocket origin checks - enforced by the Rust server.
      </p>

      <p>
        Every protection on this page runs in the Rust HTTP layer, on every response and
        before any request reaches your Node code. Two of them are on without any
        configuration: the default security headers and cross-site request (CSRF)
        protection. A Content-Security-Policy is opt-in because only you know which
        third-party origins your app loads. Everything is configured in the{' '}
        <code>[security]</code> section of <code>gio.toml</code>; a misspelled key there
        stops the server at startup instead of silently leaving a protection off.
      </p>

      <h2>Default security headers</h2>
      <p>Every response - pages, cache hits, route handlers, static and public/ files, redirects, errors and <code>/_gio</code> endpoints - carries:</p>
      <table>
        <thead>
          <tr><th>Header</th><th>Value</th><th>Why</th></tr>
        </thead>
        <tbody>
          <tr><td><code>X-Content-Type-Options</code></td><td><code>nosniff</code></td><td>Browsers never guess a script or stylesheet out of an upload served as text or an image.</td></tr>
          <tr><td><code>X-Frame-Options</code></td><td><code>SAMEORIGIN</code></td><td>Other sites cannot frame your pages (clickjacking).</td></tr>
          <tr><td><code>Referrer-Policy</code></td><td><code>strict-origin-when-cross-origin</code></td><td>Full URLs (with their query strings) are only sent to your own origin.</td></tr>
          <tr><td><code>Strict-Transport-Security</code></td><td><code>max-age=31536000</code></td><td>Only when <code>[server.tls]</code> is enabled - see <a href="#hsts">HSTS</a>.</td></tr>
        </tbody>
      </table>
      <p>
        <code>X-Powered-By</code> is always removed. The headers are added when a response
        is sent, never stored in the page cache, so a config change applies to cached pages
        immediately.
      </p>
      <p>
        Change, remove or add default headers in <code>[security.headers]</code>. An empty
        value removes a default. Headers that can break an app - <code>Permissions-Policy</code>,{' '}
        <code>Cross-Origin-Opener-Policy</code>, <code>Cross-Origin-Resource-Policy</code> - are
        not sent unless you add them here:
      </p>
      <CodeBlock lang="toml" code={`[security.headers]
x-frame-options = "DENY"                 # override a default
referrer-policy = ""                     # remove a default
permissions-policy = "camera=(), microphone=(), geolocation=()"
cross-origin-opener-policy = "same-origin"
cross-origin-resource-policy = "same-site"`} />
      <p>
        To drop all three built-in headers at once - a CDN or proxy in front sets its own -
        use <code>[security] default_headers = false</code>. Startup then logs a warning.
        Entries in <code>[security.headers]</code> are still sent (and an empty value there
        still removes a single header), and HSTS keeps its own <code>hsts</code> setting.
      </p>
      <CodeBlock lang="toml" code={`[security]
default_headers = false                  # no nosniff, X-Frame-Options or Referrer-Policy

[security.headers]
x-content-type-options = "nosniff"       # but keep this one`} />

      <h3>Precedence</h3>
      <p>
        A default never replaces a header the response already has. Headers set by your
        app - a route handler&apos;s <code>Response</code> headers, headers returned from{' '}
        <code>getServerSideProps</code> - and by <code>[[headers]]</code> or{' '}
        <code>middleware.ts</code> header rules win. A rule with an empty value removes the
        default for its paths only, for example to let partners frame one section:
      </p>
      <CodeBlock lang="toml" code={`[[headers]]
path = "/embed/*rest"
[headers.headers]
x-frame-options = ""            # no X-Frame-Options on /embed/...`} />

      <h3 id="hsts">HSTS</h3>
      <p>
        <code>Strict-Transport-Security</code> tells browsers to use HTTPS only. GioJS sends
        it automatically only when it terminates TLS itself (<code>[server.tls] enabled = true</code>).
        Behind a proxy that terminates TLS, GioJS sees plain HTTP and cannot know your site
        is HTTPS-only, so you turn it on explicitly - it is then sent on every response:
      </p>
      <CodeBlock lang="toml" code={`[security]
hsts = true                                     # max-age=31536000
# hsts = { max_age = 63072000, include_subdomains = true, preload = true }
# hsts = "max-age=63072000; includeSubDomains"  # raw value
# hsts = false                                  # never, even with [server.tls]`} />
      <div className="callout">
        Only enable <code>include_subdomains</code> and <code>preload</code> when every
        subdomain serves HTTPS - browsers remember the policy for <code>max_age</code> seconds
        and preload lists are hard to leave.
      </div>

      <h2 id="csp">Content-Security-Policy</h2>
      <p>
        A CSP with a nonce is the strongest defense against cross-site scripting: the
        browser runs only scripts carrying the nonce of the current response, so markup an
        attacker manages to inject cannot execute. Write <code>{'{nonce}'}</code> where the
        nonce goes:
      </p>
      <CodeBlock lang="toml" code={`[security]
csp = """
  default-src 'self';
  script-src 'self' 'nonce-{nonce}' 'strict-dynamic';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'self'
"""`} />
      <p>
        Every response gets a fresh, random 192-bit nonce, and every script GioJS writes
        carries it: the hydration bootstrap and its module preloads, React&apos;s streaming
        Suspense scripts, the deployment script, the critical-CSS loader, and in development
        the error overlay. Line breaks in the policy are allowed; they are sent as spaces.
      </p>

      <h3>How nonces work with caching</h3>
      <p>
        Pages are cached and PPR shells are replayed, so a page cannot be rendered with the
        nonce of the response that will eventually carry it. Instead the Node worker renders
        with a secret placeholder, and the Rust server replaces it with the response&apos;s
        nonce every time it serves the page - fresh renders, cache hits, stale-while-revalidate,
        PPR shells and their streamed holes, and streaming SSR alike, before compression. The
        placeholder is random and never sent to a browser, so a stored-XSS string cannot
        contain it and can never be turned into a valid nonce.
      </p>
      <p>
        The replacement covers the headers and body of every dynamic response - pages, route
        handlers and SSE streams, whatever their content type (HTML, JSON, JavaScript, CSS,
        XML, ...) - so even a route handler that echoes <code>cspNonce()</code> sends the
        response&apos;s nonce, not the placeholder. The nonce is exactly as long as the
        placeholder, so <code>Content-Length</code> and byte ranges stay valid. Only{' '}
        <code>public/</code> and build assets are served untouched. A dynamic response that sets
        its own <code>Content-Encoding</code> (a body your handler compressed itself) cannot be
        searched, so while nonces are on it is refused with a <code>500</code> and an error in
        the server log: drop the header and let GioJS compress the response.
      </p>
      <p>
        The placeholder is kept in the page cache directory&apos;s <code>meta/</code> (
        <code>.gio/cache/pages/meta/</code> by default) so the disk cache stays
        valid across restarts. The worker needs it before it builds, so it changes with
        what the deployment ID covers apart from that build: a new{' '}
        <code>GIO_DEPLOYMENT_ID</code>, a new standalone build, or a change to the gio.toml
        settings pages render with. A code-only redeploy keeps it (its cached pages are
        still dropped: the cache is keyed by the full deployment ID). To rotate it, delete{' '}
        <code>.gio/cache/pages/meta/csp-nonce-placeholder-*</code> and restart; cached pages
        are then rendered again. Turning CSP on or off invalidates cached pages automatically.
      </p>

      <h3>Your own inline scripts: cspNonce()</h3>
      <p>
        Inline scripts you write need the nonce too. <code>cspNonce()</code> from{' '}
        <code>@gio.js/core</code> returns it during server rendering (or{' '}
        <code>undefined</code> when no CSP uses <code>{'{nonce}'}</code>). It is meant for{' '}
        <code>nonce</code> attributes only: pass it straight to the attribute - its value is
        only final in the response, so never hash, slice or encode it or derive anything else
        from it. Put inline scripts in the root layout, which is server-rendered only:
      </p>
      <CodeBlock lang="tsx" code={`// app/layout.tsx
import { cspNonce } from '@gio.js/core';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          nonce={cspNonce()}
          dangerouslySetInnerHTML={{ __html: "document.documentElement.dataset.theme = localStorage.theme ?? 'light'" }}
        />
        <script nonce={cspNonce()} async src="https://analytics.example.com/script.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}`} />
      <ul>
        <li>
          With <code>&apos;strict-dynamic&apos;</code>, scripts loaded by a nonced script are
          trusted too, so code splitting and client-side navigation (which imports the next
          route&apos;s chunk) keep working, and host allowlists in <code>script-src</code> are
          ignored by modern browsers - nonce third-party <code>&lt;script src&gt;</code> tags
          as above.
        </li>
        <li>
          Inline event handler attributes (<code>onclick=&quot;...&quot;</code>) and{' '}
          <code>javascript:</code> URLs cannot carry a nonce and are blocked. React&apos;s{' '}
          <code>onClick</code> props are not affected - they are attached by JavaScript.
        </li>
        <li>
          Styles: keep <code>style-src &apos;self&apos; &apos;unsafe-inline&apos;</code>, without
          a nonce. React renders <code>style</code> props as <code>style=&quot;...&quot;</code>{' '}
          attributes, which only <code>&apos;unsafe-inline&apos;</code> allows, and{' '}
          <code>&lt;Animate&gt;</code> and <code>&lt;Link&gt;</code> view transitions add
          inline <code>&lt;style&gt;</code> elements that React hoists into the head without a
          nonce (<code>&lt;Animate&gt;</code> sets a <code>style</code> attribute as well). Adding{' '}
          <code>&apos;nonce-{'{nonce}'}&apos;</code> or a hash to <code>style-src</code> makes
          browsers ignore <code>&apos;unsafe-inline&apos;</code> and blocks all of these.
          GioJS&apos;s critical CSS and built-in 404 page carry the nonce, so a nonce-only{' '}
          <code>style-src</code> is possible only for an app that uses no{' '}
          <code>style</code> props, no <code>&lt;Animate&gt;</code> and no{' '}
          <code>&lt;Link&gt;</code> transitions.
        </li>
        <li>
          Static export (<code>gio export</code>) has no server to set the header or the
          nonces; <code>cspNonce()</code> returns <code>undefined</code> there.
        </li>
      </ul>

      <h3>Rolling out with report-only</h3>
      <p>
        <code>csp_report_only</code> takes the same syntax and is sent as{' '}
        <code>Content-Security-Policy-Report-Only</code>: browsers report violations in the
        console (or to a <code>report-uri</code>) without blocking anything. Both may be set
        at once and share the response&apos;s nonce. A page or route handler that sets its own{' '}
        <code>Content-Security-Policy</code> header keeps it; an empty <code>[[headers]]</code>{' '}
        value removes the policy for those paths.
      </p>

      <h2 id="csrf">CSRF protection</h2>
      <p>
        On by default. Requests that change state - every method except{' '}
        <code>GET</code>, <code>HEAD</code>, <code>OPTIONS</code> and <code>TRACE</code> - to
        pages and route handlers are checked before the body is read and before Node sees
        them, using the headers browsers attach to every request:
      </p>
      <table>
        <thead>
          <tr><th>Request</th><th>Result</th></tr>
        </thead>
        <tbody>
          <tr><td><code>Sec-Fetch-Site: same-origin</code> or <code>none</code> (typed URL, bookmark)</td><td>allowed</td></tr>
          <tr><td><code>Sec-Fetch-Site: cross-site</code></td><td>403</td></tr>
          <tr><td><code>Sec-Fetch-Site: same-site</code> (a sibling subdomain)</td><td>403 - subdomains can be controlled by someone else</td></tr>
          <tr><td>no <code>Sec-Fetch-Site</code>, <code>Origin</code> equals the request&apos;s host</td><td>allowed</td></tr>
          <tr><td>no <code>Sec-Fetch-Site</code>, any other <code>Origin</code> (including <code>null</code>)</td><td>403</td></tr>
          <tr><td>neither header (curl, webhooks, server-to-server calls)</td><td>allowed - not sent by a browser page, so it cannot be forged by one</td></tr>
          <tr><td><code>Origin</code> listed in <code>trusted_origins</code></td><td>allowed</td></tr>
          <tr><td>path listed in <code>exempt</code></td><td>not checked</td></tr>
        </tbody>
      </table>
      <CodeBlock lang="toml" code={`[security.csrf]
enabled = true                                       # default
trusted_origins = ["https://admin.example.com"]      # scheme://host[:port]
exempt = [                                           # same patterns as [[redirects]]
  "/api/webhooks/*rest",                             # webhooks
  "/auth/callback/apple",                            # OAuth/OIDC response_mode=form_post
  "/saml/acs",                                       # SAML assertion consumer service
]`} />
      <div className="callout">
        Some legitimate requests are cross-site form posts by design: another site&apos;s page
        posts the user&apos;s browser back to you, so the browser labels the request{' '}
        <code>Sec-Fetch-Site: cross-site</code>. OAuth/OpenID Connect callbacks with{' '}
        <code>response_mode=form_post</code> (Sign in with Apple, Microsoft Entra ID / Azure
        AD), SAML assertion consumer service (ACS) endpoints, and 3-D Secure or other
        payment-provider returns all work this way, and get a <code>403</code> until you list
        their paths in <code>exempt</code> - check yours when upgrading. Such endpoints must
        verify the request themselves (signature, <code>state</code> or{' '}
        <code>RelayState</code>, assertion), which they do anyway. Webhooks called server to
        server send neither header and pass without an entry; exempt them only if the sender
        adds an <code>Origin</code>.
      </div>
      <p>
        Exempt patterns use the <a href="/docs/middleware">middleware rule</a> syntax and
        match the normalized path, so spelling variants of a URL cannot dodge or abuse an
        entry. A refused request gets a <code>403</code> whose plain-text body names the
        setting to change, and is logged once per origin. Rust&apos;s own{' '}
        <code>/_gio</code> endpoints have their own checks.
      </p>
      <p>
        <code>enabled = false</code> turns the check off, for apps whose forms carry their own
        CSRF tokens; startup logs a warning naming the key. Prefer{' '}
        <code>trusted_origins</code> or <code>exempt</code> when only some origins or paths
        need it.
      </p>
      <div className="callout">
        CSRF protection covers state-changing methods only. Keep <code>GET</code> handlers
        free of side effects, and keep setting <code>SameSite=Lax</code> (or{' '}
        <code>Strict</code>) on session cookies as a second layer.
      </div>
      <p>
        Route handlers add one more guard: <code>req.json()</code> only parses bodies sent
        with <code>Content-Type: application/json</code> (or <code>application/*+json</code>).
        Anything else - including the <code>text/plain</code> and form bodies an HTML form on
        another site can send without a CORS preflight - makes it throw{' '}
        <code>UnsupportedMediaTypeError</code>, answered with <code>415</code> unless you catch
        it. <code>req.body</code> always has the raw body.
      </p>

      <h2>WebSocket origin checks</h2>
      <p>
        Browsers let any website open a WebSocket to your server and send your users&apos;
        cookies with it (cross-site WebSocket hijacking). Upgrade requests get the same check
        as unsafe methods: an <code>Origin</code> from your own host or from{' '}
        <code>[security.csrf] trusted_origins</code> is accepted, as is a client that sends no{' '}
        <code>Origin</code> (not a browser); anything else is refused with <code>403</code>{' '}
        before the connection is upgraded. <code>[security.csrf] exempt</code> paths are
        skipped here too - exempt a public WebSocket API meant to be used from any site.
      </p>
      <p>
        The check has its own switch and stays on when you set{' '}
        <code>[security.csrf] enabled = false</code> (for example because your forms carry
        their own CSRF tokens) - token-protected forms do nothing for WebSockets. Turning it
        off logs a warning at startup:
      </p>
      <CodeBlock lang="toml" code={`[security.websocket]
check_origin = true      # default; false accepts upgrades from any website`} />

      <h2>Behind a reverse proxy</h2>
      <p>
        The CSRF and WebSocket checks compare <code>Origin</code> with the{' '}
        <code>Host</code> header GioJS receives, so the proxy must pass the original host
        through. With nginx keep:
      </p>
      <CodeBlock lang="nginx" code={`location / {
    proxy_pass       http://127.0.0.1:3000;
    proxy_set_header Host $host;   # required: Origin is compared with it
}`} />
      <p>
        A proxy that rewrites <code>Host</code> to an internal name makes every same-origin
        browser request look cross-origin (403). If you cannot pass the host through, list
        your public origin in <code>trusted_origins</code>. When the proxy terminates TLS,
        also set <code>hsts</code> explicitly (see <a href="#hsts">HSTS</a>).
      </p>

      <h2>Reference</h2>
      <CodeBlock lang="toml" code={`[security]
default_headers = true    # false drops nosniff, X-Frame-Options and Referrer-Policy
csp = "default-src 'self'; script-src 'self' 'nonce-{nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
csp_report_only = ""      # same syntax, sent as Content-Security-Policy-Report-Only
hsts = true               # unset: only with [server.tls]; true | false | "raw" | { max_age, include_subdomains, preload }

[security.headers]        # override ("value"), remove (""), or add default headers
permissions-policy = "camera=()"

[security.csrf]
enabled = true
trusted_origins = []      # e.g. ["https://admin.example.com"]
exempt = []               # e.g. ["/api/webhooks/*rest", "/auth/callback/apple"]

[security.websocket]
check_origin = true       # independent of [security.csrf] enabled`} />
    </>
  );
}
