import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Headers',
  description:
    'Every HTTP header GioJS sets on responses or reads from requests: cache status, request ids, caching, security, rate limits, prefetch and deployment skew.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Headers</h1>
      <p className="page-subtitle">
        Every HTTP header GioJS sets on responses or reads from requests: cache status,
        request ids, caching, security, rate limits, prefetch and deployment skew.
      </p>
      <CodeBlock lang="bash" code={`$ curl -sI http://localhost:3000/
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
x-gio-cache: hit; ttl=58
cache-control: public, max-age=0, s-maxage=58, stale-while-revalidate=540
etag: W/"223308d35592e3fbfac8c9538b61702b"
x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
referrer-policy: strict-origin-when-cross-origin
x-request-id: 65bde6d2-1ddc-4563-a81b-48e1ee673182
keep-alive: timeout=10`} />
      <p>
        That is a page with <code>export const revalidate = 60</code>, served from the page
        cache, with the default <code>gio.toml</code>. Header names are case-insensitive;
        GioJS sends them lowercase (HTTP/2 requires it).
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="response-headers-at-a-glance">Response headers at a glance</h3>
      <table>
        <thead>
          <tr><th>Header</th><th>Sent on</th><th>Switch</th></tr>
        </thead>
        <tbody>
          <tr><td><a href="#x-gio-cache"><code>X-Gio-Cache</code></a></td><td>every response except the <code>/_gio</code> endpoints</td><td>-</td></tr>
          <tr><td><a href="#x-request-id"><code>X-Request-Id</code></a></td><td>every response</td><td><code>[server] accept_request_id</code></td></tr>
          <tr><td><a href="#cache-control"><code>Cache-Control</code></a></td><td>pages, assets, public files, endpoints</td><td><code>[cache]</code>, <code>[[headers]]</code></td></tr>
          <tr><td><a href="#etag"><code>ETag</code></a></td><td>cached pages, path-served CSS</td><td><code>[cache] etag</code></td></tr>
          <tr><td><a href="#default-security-headers"><code>X-Content-Type-Options</code>, <code>X-Frame-Options</code>, <code>Referrer-Policy</code></a></td><td>every response</td><td><code>[security] default_headers</code>, <code>[security.headers]</code></td></tr>
          <tr><td><a href="#strict-transport-security"><code>Strict-Transport-Security</code></a></td><td>every response, with TLS or <code>hsts</code></td><td><code>[security] hsts</code></td></tr>
          <tr><td><a href="#content-security-policy"><code>Content-Security-Policy</code></a></td><td>every response, when configured</td><td><code>[security] csp</code>, <code>csp_report_only</code></td></tr>
          <tr><td><a href="#x-ratelimit-limit"><code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>, <code>Retry-After</code></a></td><td>paths a <code>[[rate_limits]]</code> rule covers</td><td><code>[[rate_limits]]</code></td></tr>
          <tr><td><a href="#x-gio-refused"><code>X-Gio-Refused</code></a></td><td>a <code>429</code> or <code>413</code> sent before the body was read</td><td>-</td></tr>
          <tr><td><a href="#x-gio-action"><code>X-Gio-Action</code></a></td><td>the <code>409</code> for deployment skew</td><td><code>[server] skew_protection</code></td></tr>
          <tr><td><a href="#x-gio-redirect"><code>X-Gio-Redirect</code></a></td><td>a redirect answering a <code>&lt;GioForm&gt;</code> post</td><td>-</td></tr>
          <tr><td><a href="#keep-alive"><code>Keep-Alive</code></a></td><td>HTTP/1.1 responses</td><td><code>[server] header_read_timeout_secs</code>, <code>idle_timeout_secs</code></td></tr>
          <tr><td><a href="#content-encoding-and-vary"><code>Content-Encoding</code>, <code>Vary</code></a></td><td>compressed responses, images</td><td><code>[compression]</code></td></tr>
        </tbody>
      </table>

      <h3 id="request-headers-at-a-glance">Request headers GioJS reads</h3>
      <table>
        <thead>
          <tr><th>Header</th><th>What it does</th></tr>
        </thead>
        <tbody>
          <tr><td><a href="#x-deployment-id"><code>x-deployment-id</code></a></td><td>The client&apos;s build; a different one gets a <code>409</code>.</td></tr>
          <tr><td><a href="#purpose-prefetch"><code>Purpose</code> / <code>Sec-Purpose: prefetch</code></a></td><td>Marks a prefetch, which spends the client&apos;s prefetch budget.</td></tr>
          <tr><td><a href="#x-gio-form"><code>x-gio-form: 1</code></a></td><td>Marks a <code>&lt;GioForm&gt;</code> post: redirects come back as <code>204</code> + <code>X-Gio-Redirect</code>.</td></tr>
          <tr><td><a href="#forwarding-headers"><code>X-Forwarded-For</code>, <code>-Proto</code>, <code>-Host</code>, <code>Forwarded</code></a></td><td>The client behind a proxy listed in <code>[server] trusted_proxies</code>.</td></tr>
          <tr><td><a href="#x-request-id"><code>X-Request-Id</code></a></td><td>Adopted from a trusted proxy.</td></tr>
          <tr><td><a href="#sec-fetch-site-and-origin"><code>Sec-Fetch-Site</code>, <code>Origin</code></a></td><td>CSRF, WebSocket and dev-endpoint checks.</td></tr>
          <tr><td><a href="#if-none-match"><code>If-None-Match</code></a></td><td>A <code>304</code> when the cached page has not changed.</td></tr>
          <tr><td><a href="#authorization-and-cookie"><code>Authorization</code>, <code>Cookie</code></a></td><td>Make a page personal: never stored, <code>private</code>.</td></tr>
          <tr><td><a href="#accept-language"><code>Accept-Language</code></a></td><td>Locale detection with <code>[i18n]</code>.</td></tr>
          <tr><td><a href="#accept-and-accept-encoding"><code>Accept</code>, <code>Accept-Encoding</code></a></td><td>Image format and compression negotiation.</td></tr>
        </tbody>
      </table>

      <h2 id="caching-headers">Caching</h2>

      <h3 id="x-gio-cache">X-Gio-Cache</h3>
      <p>
        Which cache tier answered and why, so cache behavior is visible from{' '}
        <code>curl -I</code> (<code>gio cache explain &lt;url&gt;</code> decodes it):
      </p>
      <table>
        <thead>
          <tr><th>Value</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>hit; ttl=&lt;secs&gt;</code></td><td>Served from the Rust page cache without Node; <code>ttl</code> is the seconds until the entry goes stale.</td></tr>
          <tr><td><code>stale; age=&lt;secs&gt;; revalidating</code></td><td>Served from the cache past its <code>revalidate</code> while one background render refreshes it; <code>age</code> is seconds since it was rendered.</td></tr>
          <tr><td><code>miss; stored</code></td><td>Rendered by the worker and stored; the next request is a hit.</td></tr>
          <tr><td><code>bypass</code></td><td>Rendered (or refused) and not stored: no <code>revalidate</code>, not <code>GET</code>/<code>HEAD</code>, personal, a route handler, the page cache off (<code>[cache] enabled = false</code>), a worker error (<code>500</code>, <code>504</code>), a rule redirect, or one of the server&apos;s own refusals (a <code>400</code> for a malformed path, a CSRF <code>403</code>, a rate-limit <code>429</code>, a refused prefetch&apos;s <code>429</code>, a skew <code>409</code>).</td></tr>
          <tr><td><code>static</code></td><td>A file, answered without the page pipeline: <code>public/</code> files, <code>/_next/static</code> assets, the CSS compiled at startup, and the self-hosted fonts under <code>/_gio/fonts/</code>.</td></tr>
          <tr><td><code>ppr; shell=stored</code></td><td>A <a href="/docs/page-exports/shell">PPR</a> page rendered in full; its shell was captured and stored.</td></tr>
          <tr><td><code>ppr; shell=hit</code></td><td>The cached shell was sent at once and the holes streamed behind it.</td></tr>
          <tr><td><code>ppr; shell=stale; age=&lt;secs&gt;; revalidating</code></td><td>A stale shell sent while a background render refreshes it.</td></tr>
          <tr><td><code>HIT</code>, <code>MISS</code></td><td>On <code>/_gio/image</code> only: its own disk cache of encoded images.</td></tr>
        </tbody>
      </table>
      <p>
        The other <code>/_gio</code> endpoints (everything but <code>/_gio/fonts/</code>{' '}
        and <code>/_gio/image</code>) and <code>101</code> WebSocket upgrades carry no{' '}
        <code>X-Gio-Cache</code>. The <code>cache</code> label of{' '}
        <code>gio_requests_total</code> uses similar words with its own meaning: there, a
        render the worker answered is a <code>miss</code> whether it was stored or not (see{' '}
        <a href="/docs/endpoints#gio-metrics">the metrics</a>).
      </p>

      <h3 id="cache-control">Cache-Control</h3>
      <p>
        GioJS sets <code>Cache-Control</code> only where the response has none: a value from
        a route handler, <code>getServerSideProps</code> <code>headers</code>, a plugin or a{' '}
        <code>[[headers]]</code> / <code>middleware.ts</code> header rule always wins.
      </p>
      <table>
        <thead>
          <tr><th>Response</th><th>Cache-Control</th></tr>
        </thead>
        <tbody>
          <tr><td>HTML page that may be shared (<code>revalidate</code> set, nothing personal)</td><td><code>public, max-age=0, s-maxage=&lt;fresh&gt;, stale-while-revalidate=&lt;swr&gt;</code></td></tr>
          <tr><td>Any other HTML page: personal, streamed, PPR, an error, guarded, a request with <code>Authorization</code>, a locale negotiated from headers, or CSP nonces on</td><td><code>private, no-cache</code></td></tr>
          <tr><td>Route handler (<code>route.ts</code>)</td><td>none: the handler decides</td></tr>
          <tr><td><code>/_next/static/*</code>, <code>/_gio/fonts/*.woff2</code>, <code>/_gio/image</code></td><td><code>public, max-age=31536000, immutable</code></td></tr>
          <tr><td><code>public/</code> files at the site root, path-served CSS, <code>/_gio/fonts/fonts.css</code></td><td><code>public, max-age=0, must-revalidate</code></td></tr>
          <tr><td>A guarded file through <code>/_gio/image</code></td><td><code>private, no-cache</code></td></tr>
          <tr><td><code>/_gio/revalidate</code>, <code>/_gio/devtools*</code> JSON, a CSRF <code>403</code></td><td><code>no-store</code></td></tr>
        </tbody>
      </table>
      <p>
        For a shared page, <code>&lt;fresh&gt;</code> is what is left of its{' '}
        <code>revalidate</code> window and <code>&lt;swr&gt;</code> what is left of the stale
        window, which ends at <code>revalidate</code> times{' '}
        <code>[cache] swr_multiplier</code> (default <code>10</code>). So a{' '}
        <code>revalidate = 60</code> page rendered just now sends{' '}
        <code>s-maxage=60, stale-while-revalidate=540</code>. With{' '}
        <code>swr_multiplier = 0</code> the <code>stale-while-revalidate</code> directive is
        left out. Browsers always revalidate (<code>max-age=0</code>), and a CDN in front
        caches for <code>s-maxage</code>: an on-demand purge does not reach a CDN.{' '}
        <code>private, no-cache</code> rather than <code>no-store</code> keeps the
        back/forward cache working.
      </p>

      <h3 id="etag">ETag</h3>
      <p>
        A cached page carries a weak <code>ETag</code> (<code>W/&quot;...&quot;</code>), a
        hash of the stored page: one tag covers its gzip, Brotli and uncompressed bytes. A
        request whose <code>If-None-Match</code> matches gets <code>304 Not Modified</code>{' '}
        with the same headers and no body. Pages get no ETag when{' '}
        <code>[cache] etag = false</code>, in development, with CSP nonces (every body is
        unique), or when the URL serves several audiences (the cases that make a page{' '}
        <code>private</code> above). Path-served CSS (<code>/globals.css</code>) carries a
        strong ETag and answers <code>304</code>s too.
      </p>

      <h2 id="identity-headers">Request identity</h2>

      <h3 id="x-request-id">X-Request-Id</h3>
      <p>
        Every response carries one, including cache hits, static files, redirects, errors
        and the <code>/_gio</code> endpoints. It is a UUID the server generates, set on the
        request before your code runs (<code>req.requestId</code>,{' '}
        <code>ctx.requestId</code>, <code>socket.requestId</code>), and on every server log
        line (<code>request_id</code>) and worker log line (<code>requestId</code>) for that
        request, error digests included.
      </p>
      <p>
        An incoming <code>X-Request-Id</code> is kept only from a peer in{' '}
        <code>[server] trusted_proxies</code>, only when it matches{' '}
        <code>^[A-Za-z0-9._:-]{'{1,128}'}$</code>, and only while{' '}
        <code>[server] accept_request_id</code> is <code>true</code> (the default). From
        anyone else it is replaced, so a client cannot inject ids into your logs.
      </p>

      <h3 id="forwarding-headers">X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host, Forwarded</h3>
      <p>
        Read only from peers listed in <a href="/docs/configuration/server"><code>[server] trusted_proxies</code></a>{' '}
        (default: nobody), and only one family: <code>X-Forwarded-*</code> (the default) or
        RFC 7239 <code>Forwarded</code> with <code>proxy_headers = &quot;forwarded&quot;</code>.
        The client address is found by walking the chain right to left past trusted hops, so
        nothing a client writes there is read. The result is <code>req.ip</code>,{' '}
        <code>req.scheme</code> and <code>req.host</code>, and what rate limits, prefetch
        budgets, <code>[metrics] ip_allowlist</code>, the CSRF host comparison and the logs
        use. <code>X-Real-IP</code> is never used for the address; it only marks a request as
        forwarded for the <code>/_gio/metrics</code> loopback check.
      </p>

      <h2 id="security-headers">Security</h2>

      <h3 id="default-security-headers">X-Content-Type-Options, X-Frame-Options, Referrer-Policy</h3>
      <p>Stamped on every response, <code>/_gio</code> endpoints and errors included:</p>
      <CodeBlock lang="text" code={`x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
referrer-policy: strict-origin-when-cross-origin`} />
      <p>
        A header the response already has wins, so a route handler or a{' '}
        <code>[[headers]]</code> rule can change one for some paths, and an empty value
        there removes it. <a href="/docs/configuration/security"><code>[security.headers]</code></a>{' '}
        changes or adds headers for every response (<code>&quot;&quot;</code> removes one),
        and <code>[security] default_headers = false</code> drops the three. GioJS also
        removes any <code>X-Powered-By</code> header, always.
      </p>

      <h3 id="strict-transport-security">Strict-Transport-Security</h3>
      <p>
        <code>max-age=31536000</code> on every response when <code>[server.tls]</code> is on.
        Behind a TLS-terminating proxy set <code>[security] hsts = true</code>, a table (
        <code>max_age</code>, <code>include_subdomains</code>, <code>preload</code>) or a raw
        string. <code>hsts = false</code> turns it off even with TLS. It cannot be set
        through <code>[security.headers]</code>.
      </p>

      <h3 id="content-security-policy">Content-Security-Policy</h3>
      <p>
        Off by default. <code>[security] csp</code> and <code>csp_report_only</code> set{' '}
        <code>Content-Security-Policy</code> and{' '}
        <code>Content-Security-Policy-Report-Only</code>; a <code>{'{nonce}'}</code> in either
        becomes a fresh 192-bit nonce per response, which every framework inline script
        carries. With nonces on, pages are <code>private, no-cache</code> without an ETag,
        because each body is unique. See the{' '}
        <a href="/docs/guides/content-security-policy">Content Security Policy guide</a>.
      </p>

      <h3 id="sec-fetch-site-and-origin">Sec-Fetch-Site and Origin</h3>
      <p>
        For <code>POST</code>, <code>PUT</code>, <code>PATCH</code> and <code>DELETE</code>{' '}
        (<a href="/docs/configuration/security-csrf"><code>[security.csrf]</code></a>) and
        WebSocket upgrades (<a href="/docs/configuration/security-websocket"><code>[security.websocket]</code></a>),
        the server reads <code>Sec-Fetch-Site</code>, or without it compares{' '}
        <code>Origin</code> with the host the client addressed. A cross-site request gets{' '}
        <code>403</code> with a <code>text/plain</code> body naming the setting to change; a
        request with neither header (curl, server-to-server webhooks) passes. The{' '}
        <code>/_gio/devtools</code> endpoints apply their own, stricter version.
      </p>

      <h2 id="rate-limit-headers">Rate limits and refusals</h2>

      <h3 id="x-ratelimit-limit">X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After</h3>
      <p>
        On a request that a <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a>{' '}
        rule covers, the response carries the size of the client&apos;s bucket,{' '}
        <code>per_ip + burst</code>, as <code>X-RateLimit-Limit</code>, and in{' '}
        <code>X-RateLimit-Remaining</code> the requests the client has left right now (never
        more than the limit), so <code>Limit - Remaining</code> is what it has used. A fresh
        client of a <code>per_ip = 3</code> rule with the default <code>burst = 20</code> sees{' '}
        <code>23</code> and <code>22</code>. Over the limit, the server answers before any app
        code runs:
      </p>
      <CodeBlock lang="text" code={`HTTP/1.1 429 Too Many Requests
content-type: application/json
retry-after: 20
x-ratelimit-limit: 23
x-ratelimit-remaining: 0
x-gio-refused: unread

{"error":"rate limit exceeded"}`} />
      <p>
        <code>Retry-After</code> is in seconds: <code>window_seconds</code> divided by{' '}
        <code>per_ip</code>, the time one request&apos;s worth of budget takes to come back (at least{' '}
        <code>1</code>).{' '}
        <code>POST /_gio/revalidate</code> also
        sends it on the <code>429</code>s that refuse a client after repeated wrong
        tokens.
      </p>

      <h3 id="x-gio-refused">X-Gio-Refused</h3>
      <p>
        <code>x-gio-refused: unread</code> marks a refusal the server sent before reading the
        request body: the rate-limit <code>429</code> and the <code>413</code> for a body over{' '}
        <code>[server] max_body_bytes</code> (default 2 MiB). <code>&lt;GioForm&gt;</code>{' '}
        resubmits natively only those (and the skew <code>409</code>), never a{' '}
        <code>413</code> or <code>429</code> your action or route handler returned, because
        by then the action may have run.
      </p>

      <h2 id="navigation-headers">Client router</h2>

      <h3 id="x-deployment-id">x-deployment-id</h3>
      <p>
        The client router sends the deployment ID the page was rendered with on soft
        navigations, prefetches, <code>router.refresh()</code> and{' '}
        <code>&lt;GioForm&gt;</code> posts. When it differs from the server&apos;s, the server
        answers <code>409 Conflict</code> before rendering anything.
      </p>

      <h3 id="x-gio-action">X-Gio-Action</h3>
      <p>
        <code>x-gio-action: hard-reload</code> on that <code>409</code>: the tab is running an
        older (or newer) build, so the router loads the URL in full instead of rendering it
        with stale code. A prefetch that gets it is dropped quietly; the click reloads.{' '}
        <code>[server] skew_protection = false</code> ignores <code>x-deployment-id</code>{' '}
        (no <code>409</code>s). For your own <code>fetch</code> calls that send the header,{' '}
        <code>isHardReloadResponse(res)</code> from <code>@gio.js/react</code> recognizes
        this answer and <code>handleHardReload()</code> reloads the page.
      </p>

      <h3 id="purpose-prefetch">Purpose: prefetch</h3>
      <p>
        <code>&lt;GioLink&gt;</code> and <code>router.prefetch()</code> send{' '}
        <code>Purpose: prefetch</code> and <code>Sec-Purpose: prefetch</code>. The server
        treats a request with either as a prefetch, and reads both as lists whose items may
        carry parameters, so a browser&apos;s speculation-rules prerender (
        <code>Sec-Purpose: prefetch;prerender</code>) counts too: it counts against the
        client&apos;s{' '}
        <a href="/docs/configuration/prefetch"><code>[prefetch]</code></a> budget (
        <code>max_concurrent</code>, <code>max_per_second</code>), and over budget, or with{' '}
        <code>[prefetch] enabled = false</code>, it is refused with an empty{' '}
        <code>429</code> before rendering. The router treats a failed prefetch as &quot;not
        prefetched&quot;; the click still navigates. An admitted prefetch is an ordinary
        request otherwise: it is served from, and stored in, the page cache.
      </p>

      <h3 id="x-gio-form">x-gio-form</h3>
      <p>
        <code>&lt;GioForm&gt;</code> sends <code>x-gio-form: 1</code> with its{' '}
        <code>POST</code>s once hydrated. A <code>301</code>, <code>302</code> or{' '}
        <code>303</code> answering such a post (from the action, its{' '}
        <code>getServerSideProps</code>, a route handler or a plugin) becomes a{' '}
        <code>204</code> carrying the target in <code>X-Gio-Redirect</code>, with its cookies
        and other headers kept.
      </p>

      <h3 id="x-gio-redirect">X-Gio-Redirect</h3>
      <p>
        The redirect target of that <code>204</code>. The client router fetches a same-origin
        target itself and hands any other to the browser. <code>fetch</code> would otherwise
        follow the redirect on its own, and one leading to another site (a payment page, a
        sign-in) would fail the CORS check after the action had already run.
        <code>307</code> and <code>308</code> are passed through, since they repeat the{' '}
        <code>POST</code>.
      </p>

      <h2 id="other-headers">Content negotiation and connections</h2>

      <h3 id="if-none-match">If-None-Match</h3>
      <p>
        Compared, weakly, with a cached page&apos;s <a href="#etag">ETag</a>: a match (or{' '}
        <code>*</code>) on what would be a <code>200</code> becomes a <code>304</code>.
      </p>

      <h3 id="authorization-and-cookie">Authorization and Cookie</h3>
      <p>
        A <code>getServerSideProps</code> that reads <code>ctx.cookies</code> or the{' '}
        <code>cookie</code> or <code>authorization</code> header renders per request and is
        never stored, whatever <code>revalidate</code> says, and neither is any response
        that sets a cookie. A request with <code>Authorization</code> gets{' '}
        <code>private, no-cache</code> and no ETag even for a shared page. The server also
        reads cookies itself: <a href="/docs/configuration/guards"><code>require_cookie</code> and <code>require_session</code></a>{' '}
        guards, the <code>gio_locale</code> cookie for <code>[i18n]</code>, and{' '}
        <code>__gio_ppr_bypass</code>, a short-lived cookie a PPR page sets to fetch a
        redirect or error the cached shell could not deliver. Each <code>Set-Cookie</code>{' '}
        a handler appends is sent as its own header.
      </p>

      <h3 id="accept-language">Accept-Language</h3>
      <p>
        With <a href="/docs/configuration/i18n"><code>[i18n]</code></a>, one of the sources{' '}
        <code>detect_from</code> lists (default <code>path</code>,{' '}
        <code>accept-language</code>, <code>cookie</code>, in that order). While{' '}
        <code>detect_from</code> lists <code>accept-language</code> or <code>cookie</code>,
        every page requested without a locale prefix is <code>private, no-cache</code> with
        no <code>ETag</code> - whether or not the request carried the header or the cookie,
        since one URL then serves several languages. URLs with a locale prefix stay
        shareable.
      </p>

      <h3 id="accept-and-accept-encoding">Accept and Accept-Encoding</h3>
      <p>
        <code>/_gio/image</code> picks AVIF or WebP from <code>Accept</code> and answers{' '}
        <code>Vary: Accept</code>. <code>Accept-Encoding</code> picks Brotli or gzip; see
        below.
      </p>

      <h3 id="content-encoding-and-vary">Content-Encoding and Vary</h3>
      <p>
        With <a href="/docs/configuration/compression"><code>[compression]</code></a> on (the
        default), responses of at least <code>min_size_bytes</code> (1024), and every
        streamed one except Server-Sent Events, are compressed with Brotli when the client
        accepts it (gzip with{' '}
        <code>prefer_brotli = false</code>), else gzip, and carry{' '}
        <code>Vary: accept-encoding</code>. Images are never recompressed. A{' '}
        <code>304</code> keeps the <code>Vary</code> of its <code>200</code>.
      </p>

      <h3 id="keep-alive">Keep-Alive</h3>
      <p>
        HTTP/1.1 responses carry <code>Keep-Alive: timeout=N</code>, the seconds an idle
        connection stays open: the smaller of <code>[server] header_read_timeout_secs</code>{' '}
        (default <code>10</code>) and <code>idle_timeout_secs</code> (<code>60</code>),
        leaving out one set to <code>0</code>. With both at <code>0</code> the header is not
        sent. Clients that honor it stop reusing the socket first, instead of racing the
        server&apos;s close. Keep a proxy&apos;s upstream idle timeout below it.
      </p>
      <p>
        The value is always the server&apos;s: a <code>Keep-Alive</code> or{' '}
        <code>Connection</code> header a page or <code>route.ts</code> sets is dropped,
        like the other connection-specific headers (<code>Transfer-Encoding</code>,{' '}
        <code>Upgrade</code>, <code>TE</code>, <code>Trailer</code>,{' '}
        <code>Proxy-Connection</code>), which describe one hop and are not allowed on
        HTTP/2.
      </p>

      <h2 id="examples">Examples</h2>

      <h3 id="watch-a-page-go-from-miss-to-hit">Watch a page go from miss to hit</h3>
      <CodeBlock lang="bash" code={`$ curl -sI http://localhost:3000/ | grep -i x-gio-cache
x-gio-cache: miss; stored
$ curl -sI http://localhost:3000/ | grep -i x-gio-cache
x-gio-cache: hit; ttl=60`} />

      <h3 id="revalidate-with-an-etag">Revalidate with an ETag</h3>
      <CodeBlock lang="bash" code={`ETAG=$(curl -sI http://localhost:3000/ | grep -i '^etag' | cut -d' ' -f2 | tr -d '\\r')
curl -s -o /dev/null -w "%{http_code}\\n" -H "If-None-Match: $ETAG" http://localhost:3000/
# 304`} />

      <h3 id="allow-framing-on-one-path">Allow framing on one path</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[headers]]
path = "/embed/*rest"
headers = { "x-frame-options" = "", "content-security-policy" = "frame-ancestors https://partner.example" }`} />
      <p>
        The empty value removes the default <code>X-Frame-Options</code> on those paths
        only; everything else keeps <code>SAMEORIGIN</code>.
      </p>

      <h3 id="set-cache-control-from-a-route-handler">Set Cache-Control from a route handler</h3>
      <CodeBlock lang="ts" title="app/api/prices/route.ts" code={`export function GET() {
  return Response.json(
    { usd: 1, eur: 0.92 },
    { headers: { 'Cache-Control': 'public, max-age=60' } },
  );
}`} />

      <h3 id="log-the-request-id-in-a-route-handler">Log the request id in a route handler</h3>
      <CodeBlock lang="ts" title="app/api/hello/route.ts" code={`import type { GioRequest } from '@gio.js/core';

export function GET(req: GioRequest) {
  return Response.json({ hello: 'world', requestId: req.requestId });
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Security headers are stamped when a response is served, never stored with a cached
          page, so a <code>gio.toml</code> change reaches cached pages at the next restart.
        </li>
        <li>
          A <code>Set-Cookie</code> header is never stored in the page cache, and a response
          that sets one is never shared between visitors.
        </li>
        <li>
          Fixed, by design: request-id validation, the trusted-proxy rule for forwarding
          headers, removal of <code>X-Powered-By</code>, and the cache bypass for personal
          renders (use <a href="/docs/page-exports/shell">PPR holes</a> to cache the rest of
          such a page).
        </li>
        <li>
          A static export has no server: none of these response headers are added. Set them
          on your static host.
        </li>
        <li>
          WebSocket handlers see a fixed subset of the upgrade request&apos;s headers in{' '}
          <code>socket.headers</code>: <code>cookie</code>, <code>authorization</code>,{' '}
          <code>user-agent</code>, <code>accept-language</code>, <code>origin</code> and{' '}
          <code>x-request-id</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/endpoints">Endpoints</a> - the <code>/_gio</code> URLs and their responses</li>
        <li><a href="/docs/caching#browser-and-cdn-caching">Browser and CDN caching</a> and <a href="/docs/caching-layers#observing-the-cache-x-gio-cache">Observing the cache</a></li>
        <li><a href="/docs/security#default-security-headers">Default security headers</a> and <a href="/docs/guides/content-security-policy">Content Security Policy</a></li>
        <li><a href="/docs/deployment#reverse-proxy">Behind a reverse proxy</a> and <a href="/docs/observability#request-ids">Request IDs</a></li>
        <li><a href="/docs/configuration/headers"><code>[[headers]]</code></a>, <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a>, <a href="/docs/configuration/cache"><code>[cache]</code></a>, <a href="/docs/configuration/security"><code>[security]</code></a></li>
        <li><a href="/docs/components/gio-link"><code>&lt;GioLink&gt;</code></a> and <a href="/docs/components/gio-form"><code>&lt;GioForm&gt;</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Default security headers, HSTS and CSP with nonces. <code>X-Request-Id</code>{' '}
              on every response, adopted only from trusted proxies. Pages send{' '}
              <code>Cache-Control</code> and a weak <code>ETag</code> with <code>304</code>s.{' '}
              <code>X-Gio-Refused</code>, <code>X-Gio-Redirect</code> /{' '}
              <code>x-gio-form</code>, and <code>Keep-Alive: timeout=N</code> added. The
              router sends <code>x-deployment-id</code> on every navigation, prefetch,
              refresh and form post; <code>[server] skew_protection</code> turns the{' '}
              <code>409</code> off. Forwarding headers read only from{' '}
              <code>trusted_proxies</code>. <code>X-RateLimit-Limit</code> is the bucket
              size, <code>per_ip + burst</code> (it was <code>per_ip</code>, below what{' '}
              <code>X-RateLimit-Remaining</code> could show). The server&apos;s own
              refusals carry <code>X-Gio-Cache: bypass</code> instead of{' '}
              <code>static</code>, and self-hosted fonts carry <code>static</code>.{' '}
              <code>Sec-Purpose: prefetch;prerender</code> counts as a prefetch. Server-sent
              event streams no longer repeat <code>Cache-Control</code>, and no response
              forwards a <code>Connection</code> or <code>Keep-Alive</code> header the app
              set.
            </>
          ),
        },
        { version: 'v0.1.0-beta.7', changes: <><code>X-Gio-Cache</code> labels PPR responses (<code>ppr; shell=...</code>).</> },
        { version: 'v0.1.0-beta.6', changes: <><code>X-Gio-Cache</code> on every response; skew detection fires for soft navigations.</> },
        { version: 'v0.1.0-beta.1', changes: <>Version skew detection with <code>x-deployment-id</code>; rate limiting; prefetch budgets.</> },
      ]} />
    </>
  );
}
