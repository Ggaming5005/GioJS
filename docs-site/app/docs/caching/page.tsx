import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Caching & Revalidating',
  description:
    'Incremental Static Regeneration with stale-while-revalidate semantics and on-demand ' +
    'purges.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Caching & Revalidating</h1>
      <p className="page-subtitle">Incremental Static Regeneration with stale-while-revalidate semantics and on-demand purges.</p>
      <p>Export revalidate from a page to control how long its rendered HTML is cached by the Rust layer.</p>
      <CodeBlock lang="tsx" code={`// cache for 60s, then revalidate in the background
export const revalidate = 60;

// cache indefinitely
export const revalidate = false;

// never cache (default)
// (omit the export)`} />
      <h2 id="how-it-works">How it works</h2>
      <p>Cached pages are served from memory in microseconds. When a page is stale, GioJS serves the stale copy immediately and revalidates in the background - visitors never wait.</p>
      <div className="callout">Cache keys are deployment-ID aware, and the derived ID changes with the app&apos;s client and server code, so a redeploy of changed code automatically invalidates stale entries. Data read at runtime (files, a database, <code>.env</code> values) is not part of the ID: purge after changing it. See <a href="/docs/caching-layers">Caching layers</a>.</div>

      <h2 id="on-demand-revalidation">On-demand revalidation</h2>
      <p>
        <code>revalidate</code> bounds how long a page can be out of date. When you know the
        moment its data changed - a post was published, a price edited in the CMS - purge it
        right away instead. A purge removes the matching pages from the cache (memory and
        disk, <a href="/docs/caching-layers">PPR shells</a> included): the next request for
        each is a miss and renders fresh, so nobody is served the old page after the purge
        returns. That is unlike the stale-while-revalidate refresh, which serves the stale
        copy one more time.
      </p>

      <h3 id="tagging-pages">Tagging pages</h3>
      <p>
        Give a page tags to purge it by. Static tags apply to every render of the page;
        tags returned next to <code>props</code> from <code>getServerSideProps</code> are
        added per render:
      </p>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`export const revalidate = 3600;
export const tags = ['posts'];            // every post page

export async function getServerSideProps(ctx) {
  const post = await db.posts.find(ctx.params.id);
  return {
    props: { post },
    tags: [\`post:\${post.id}\`, \`author:\${post.authorId}\`],
  };
}`} />
      <p>
        A tag is a string of 1-256 bytes without control characters, and well-formed
        Unicode (an emoji cut in half by <code>title.slice(0, 20)</code> is not); a render
        keeps at most 64 (duplicates are dropped), and tags starting with{' '}
        <code>_gio:</code> are reserved. Invalid tags are ignored with a warning in the log rather than failing the
        render. Tags only matter on pages that are cached (<code>revalidate</code> set).
        Every cached page is also purgeable by its path - no tag needed.
      </p>

      <h3 id="revalidatetag-and-revalidatepath">revalidateTag() and revalidatePath()</h3>
      <p>
        Call them from server code - route handlers, <code>getServerSideProps</code>,
        anything the worker runs - after the data changed:
      </p>
      <CodeBlock lang="ts" title="app/api/posts/[id]/route.ts" code={`import { revalidatePath, revalidateTag } from '@gio.js/core';

export async function PUT(req) {
  await db.posts.update(req.params.id, req.json());
  await revalidateTag(\`post:\${req.params.id}\`);     // pages tagged post:<id>
  await revalidatePath('/');                           // the home page
  await revalidatePath('/blog', { type: 'prefix' });   // /blog and everything below it
  return { ok: true };
}`} />
      <ul>
        <li><code>revalidateTag(tag)</code> purges every cached page carrying the tag.</li>
        <li>
          <code>revalidatePath(path)</code> purges the page at that URL path - all of its
          query strings and locales. With <code>{"{ type: 'prefix' }"}</code> it purges the
          path and everything below it, at segment boundaries (<code>/blog</code> covers{' '}
          <code>/blog/a</code>, not <code>/blogger</code>). A query or fragment in the path is
          ignored, and so is a leading locale segment (<code>/fr/about</code> purges{' '}
          <code>/about</code> in every locale - pages are cached under their locale-free
          path, so a bare <code>/fr</code> with <code>{"{ type: 'prefix' }"}</code> purges
          every page of the site, and the server logs a warning when it does). The path is
          the one the page renders at - after any <code>[[rewrites]]</code>.
        </li>
        <li>
          Paths may be given decoded or percent-encoded: <code>/blog/café</code> and{' '}
          <code>/blog/caf%C3%A9</code> (or <code>/blog/a b</code> and{' '}
          <code>/blog/a%20b</code>) purge the same page, so a slug straight from your CMS or
          database works. A <code>%</code> always starts an escape - write a literal{' '}
          <code>%</code> as <code>%25</code>.
        </li>
      </ul>
      <p>
        Both resolve once the server confirmed the purge, with{' '}
        <code>{'{ ok: true, purged }'}</code> (the number of cache entries removed - each
        query-string and locale variant counts). If the confirmation does not arrive within
        5 seconds, or the server connection drops, they resolve with <code>ok: false</code>{' '}
        and an <code>error</code>, and log a warning - they do not throw, so a write that
        already succeeded is not failed over its cache refresh. To purge a batch, call them
        in parallel - <code>{'await Promise.all(ids.map(id => revalidateTag(`post:${id}`)))'}</code>:
        the worker sends at most 16 at a time and the rest wait their turn, within the same
        5 seconds. An invalid tag or path - an
        unpaired surrogate, a <code>.</code> or <code>..</code> segment, a <code>%</code>{' '}
        that does not start an escape, a path under <code>/_gio</code> - is a programming
        error and rejects with a <code>TypeError</code>. Under{' '}
        <code>gio export</code> (and in unit tests) there is no cache to purge: they do
        nothing and warn once.
      </p>
      <p>
        A render that was already running when the purge happened (a cache miss or a
        background refresh) still answers the requests that were waiting for it, but its
        result is not cached - it may have read the old data - and a request that arrives
        after the purge renders on its own instead of joining it, so the purge always wins.
      </p>

      <h3 id="from-outside-post-giorevalidate">From outside: POST /_gio/revalidate</h3>
      <p>
        External systems - a CMS webhook, a deploy script - purge through an HTTP endpoint.
        It exists only when you configure a token of at least 32 bytes, in the environment
        (wins) or in <code>gio.toml</code>; without one, <code>/_gio/revalidate</code> is a
        404:
      </p>
      <CodeBlock lang="bash" code={`# generate a token
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export GIO_REVALIDATE_TOKEN=<token>     # or [revalidate] token = "..." in gio.toml`} />
      <CodeBlock lang="bash" code={`curl -X POST https://example.com/_gio/revalidate \\
  -H "Authorization: Bearer $GIO_REVALIDATE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "tags": ["post:42"], "paths": ["/blog"], "prefix": true }'
# {"ok":true,"purged":7}`} />
      <p>
        The JSON body takes <code>tags</code> and/or <code>paths</code> (up to 64 each, same
        rules as above) and <code>prefix</code> (<code>true</code> purges every path as a
        prefix). The answer is <code>200</code> with the number of purged entries,{' '}
        <code>400</code> for a malformed body (unknown fields included, so a misspelled{' '}
        <code>tag</code> is an error, not a silent no-op), and <code>401</code> for a
        missing or wrong token. The token is compared in constant time, and a client that
        sends 10 wrong tokens within a minute gets <code>429</code> for the rest of that
        minute - even with the right token (behind a reverse proxy, list it in{' '}
        <code>[server] trusted_proxies</code> so clients are told apart by their own
        address, not the proxy&apos;s). The endpoint is authenticated by its bearer
        token, not by cookies, so the cross-site request checks of{' '}
        <a href="/docs/security">[security.csrf]</a> do not apply to it; call it over HTTPS.
      </p>
      <div className="callout">
        The cache belongs to each server instance - there is no shared cache backend yet.
        With several instances behind a load balancer, call the endpoint on every instance
        (by its own address, not through the balancer); <code>revalidateTag()</code> and{' '}
        <code>revalidatePath()</code> only purge the instance whose worker runs them.
        Instances that share a disk cache directory (<code>[cache] disk_path</code> or{' '}
        <code>GIO_CACHE_DIR</code>) serve the
        pages each other stored, but each keeps its own memory cache - purge every one of
        them all the same.
      </div>

      <h2 id="personalized-pages-are-never-shared">Personalized pages are never shared</h2>
      <p>
        A cached page is served to everyone, so it must not depend on who is asking. When{' '}
        <code>getServerSideProps</code> reads the visitor&apos;s credentials - any access to{' '}
        <code>ctx.cookies</code>, <code>ctx.ip</code>, <code>ctx.host</code> or{' '}
        <code>ctx.scheme</code>, or reading the <code>cookie</code>,{' '}
        <code>authorization</code>, a client-address (<code>x-forwarded-for</code>,{' '}
        <code>forwarded</code>, <code>x-real-ip</code>) or a host (<code>host</code>,{' '}
        <code>x-forwarded-host</code>, <code>x-forwarded-proto</code>) entry of{' '}
        <code>ctx.headers</code> (including spreading or
        enumerating the headers) - GioJS marks that render personalized and does not cache it,
        even though the page exports <code>revalidate</code>. A warning is logged once per
        route. Headers an <code>onRequest</code> plugin added, changed or removed count as
        credentials too; other headers (<code>accept-language</code>, <code>user-agent</code>, ...) do not.
        A plugin that reads the credential headers and then rewrites the request&apos;s path,
        query or locale personalizes the render too: Rust keys the cache on the URL as
        requested, so that render (say, an admin dashboard picked from a <code>role</code>{' '}
        cookie) is never stored under it.
      </p>
      <p>
        To keep a personalized page fast, either drop <code>revalidate</code> (it renders per
        request, streamed) or cache the shared part with{' '}
        <a href="/docs/caching-layers">partial prerendering</a>:{' '}
        <code>shell = &apos;cache&apos;</code> plus <code>&lt;Suspense&gt;</code> holes for the
        personalized parts.
      </p>
      <h2 id="browser-and-cdn-caching">Browser and CDN caching</h2>
      <p>
        Page responses tell browsers and CDNs the same thing the Rust cache knows. A page
        cached for everyone gets:
      </p>
      <CodeBlock lang="bash" code={`Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=540
ETag: W/"4f1c0a9be27d63e5d1b8a04c9f2e7a13"`} />
      <ul>
        <li><code>s-maxage</code> - what is left of the page&apos;s <code>revalidate</code> window, so a CDN in front of GioJS caches it no longer than GioJS does</li>
        <li><code>stale-while-revalidate</code> - the rest of the window in which GioJS itself serves the page stale while it refreshes (nine times <code>revalidate</code>)</li>
        <li><code>max-age=0</code> - browsers revalidate every time; with the ETag that costs a <code>304 Not Modified</code> without a body while the page is unchanged</li>
      </ul>
      <p>
        An on-demand purge (above) reaches browsers at once:
        the re-rendered page has a new ETag, so their next revalidation gets a 200 instead
        of a 304. It does not reach a CDN, which may serve its copy for the rest of{' '}
        <code>s-maxage</code>. Purge the CDN from the same webhook, or keep{' '}
        <code>revalidate</code> short on pages you purge on demand.
      </p>
      <p>
        The ETag is a hash of the stored page, computed once when it is cached. It is weak
        (<code>W/</code>): the same page goes out gzip, brotli or uncompressed under it, and
        a strong ETag would have to differ between those encodings. A
        request whose <code>If-None-Match</code> names it gets a 304 with the same headers
        (<code>X-Request-Id</code>, security headers, header rules and the{' '}
        <code>Vary: accept-encoding</code> of a compressed page included). The dev
        server sends no page ETags: it inlines your current CSS into every response, so a
        stylesheet edit always reaches the browser. Pages
        rendered per visitor - personalized, uncached, streamed, every{' '}
        <a href="/docs/caching-layers">PPR</a> response (its holes are personal) and error
        pages - get <code>Cache-Control: private, no-cache</code>: no shared cache stores
        them, and browsers still keep the back/forward cache (<code>no-store</code> would
        disable it).
      </p>
      <p>
        A <code>Cache-Control</code> you set yourself always wins - from{' '}
        <code>getServerSideProps</code> <code>headers</code>, a route handler&apos;s{' '}
        <code>Response</code>, or a <code>[[headers]]</code> rule. Route handler responses
        get no default at all, whatever their content type and whether or not their body
        streams - only an event stream gets <code>no-cache</code> (see{' '}
        <a href="/docs/route-handlers">Route Handlers</a>). In these cases GioJS never makes
        a page <code>public</code> or sends an ETag, because one URL is not the same page
        for everyone who asks:
      </p>
      <ul>
        <li>
          A page behind a <a href="/docs/middleware">guard</a> (<code>[[guards]]</code> in
          gio.toml or <code>guards</code> in middleware.ts), and any page requested with an{' '}
          <code>Authorization</code> header, is <code>private, no-cache</code>. A CDN keys
          by URL and never runs the guard: storing the page for an admitted visitor would
          serve it to everyone the guard turns away.
        </li>
        <li>
          With <code>[i18n]</code> detecting the locale from <code>accept-language</code> or
          a cookie, an unprefixed URL is <code>private, no-cache</code> (locale-prefixed URLs
          like <code>/de/about</code> stay public).
        </li>
        <li>
          With CSP nonces (<code>{'{nonce}'}</code> in <code>[security] csp</code>) every
          response is unique, so even cached pages are <code>private, no-cache</code> - a CDN
          replaying one would hand every visitor the same nonce.
        </li>
      </ul>
      <p>
        GioJS still caches all of these pages itself (its guards run before its cache) and
        fills in a fresh nonce per response.
      </p>
    </>
  );
}
