import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Caching Layers',
  description: 'In-process LRU over a persistent disk tier, per instance.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Caching Layers</h1>
      <p className="page-subtitle">In-process LRU over a persistent disk tier, per instance.</p>
      <p>
        The page cache is layered: a bounded in-memory LRU (L1, 1000 entries by default) over
        an on-disk tier (L2) that persists entries across restarts. Lookups check memory first,
        then disk; all writes go to memory immediately and to disk in a background task. The
        disk tier is bounded (512 MiB by default), with the oldest files evicted past the
        limit. Both bounds and the disk directory are set in <code>gio.toml</code>:
      </p>
      <CodeBlock lang="toml" code={`[cache]
memory_max_entries = 1000           # L1 size
disk_path = ".gio/cache/pages"      # L2 directory; GIO_CACHE_DIR overrides
disk_max_bytes = 536870912          # L2 cap; 0 = unbounded`} />
      <p>
      </p>
      <p>
        On-demand purges (<a href="/docs/caching">revalidateTag, revalidatePath and{' '}
        <code>POST /_gio/revalidate</code></a>) reach both tiers: a tag index covers entries
        in memory and on disk - including the ones a previous run left behind, indexed in the
        background at startup - so a purged page can never come back from disk.
      </p>
      <p>
        The architecture includes a storage-backend seam (L3) where a shared cluster-wide tier
        could slot in, but no shared backend ships yet - the cache is per-instance. For
        multi-instance deployments, set <code>GIO_DEPLOYMENT_ID</code> to the same value on
        every instance so their caches agree on the deployment ID, and send on-demand purges
        (<code>POST /_gio/revalidate</code>) to every instance.
      </p>
      <p>
        Persisted entries survive a restart only while the deployment ID stays the same. The
        derived ID covers the client build the server produces at startup (every chunk and
        stylesheet name is a content hash) and the app&apos;s server-side sources: every file
        under <code>app/</code> - the root layout, <code>metadata</code> and{' '}
        <code>revalidate</code> exports, <code>getServerSideProps</code>, route handlers -
        plus <code>middleware.ts</code>, <code>gio.config.ts</code>, the project modules they
        import, the tsconfig and the lockfile. So a restart after a code or CSS change starts
        with an empty cache instead of serving pages the previous code rendered (or that link
        its deleted files), and a restart of the same code keeps the cache. Data your pages
        read at runtime (files, a database, <code>.env</code> values) is not part of the ID:
        after changing it, purge with <code>revalidatePath()</code> or{' '}
        <code>POST /_gio/revalidate</code>. It also covers the
        gio.toml settings pages are rendered with (<code>[images]</code> decides every{' '}
        <code>GioImage</code> srcset, plus the served <code>[[fonts]]</code> and the i18n
        default locale), so changing those settings drops persisted pages too. A pinned{' '}
        <code>GIO_DEPLOYMENT_ID</code> is used as given: change it with every deploy.
      </p>
      <h2 id="observing-the-cache-x-gio-cache">Observing the cache: X-Gio-Cache</h2>
      <p>
        Every response carries an <code>X-Gio-Cache</code> header saying which tier
        answered and why, so cache behavior is observable from any{' '}
        <code>curl -I</code> instead of reverse-engineered:
      </p>
      <ul>
        <li><code>hit; ttl=&lt;secs&gt;</code> - served from the Rust page cache without touching Node; <code>ttl</code> is the seconds until the entry goes stale</li>
        <li><code>stale; age=&lt;secs&gt;; revalidating</code> - served instantly from the cache past its TTL while one background render refreshes the entry; <code>age</code> is seconds since it was rendered. A refresh that answers 404 (the page called <code>notFound()</code>) evicts the entry instead</li>
        <li><code>miss; stored</code> - rendered by the Node worker and stored; the next request for this key is a hit</li>
        <li><code>bypass</code> - rendered (or redirected) but not cached: the page did not declare <code>revalidate</code>, the request was not GET/HEAD, the response varies per user, it set per-request headers, or its <code>getServerSideProps</code> read the visitor&apos;s cookies, authorization header, IP (<code>ctx.ip</code>) or the host it asked for (<code>ctx.host</code>, <code>ctx.scheme</code>)</li>
        <li><code>static</code> - served by the Rust static file layer (public/ assets at the site root or under /public/*, hashed chunks, fonts); never touches the cache or Node</li>
      </ul>
      <p>
        Internal <code>/_gio/*</code> endpoints are not stamped
        (<code>/_gio/image</code> reports its own image cache as{' '}
        <code>HIT</code>/<code>MISS</code>).
      </p>
      <p>The CLI decodes the header for you:</p>
      <CodeBlock lang="bash" code={`$ gio cache explain /posts/1
GET http://localhost:3000/posts/1
  status       200
  x-gio-cache  hit; ttl=42
  → Served from the Rust page cache without touching Node. "ttl" is the
    seconds until this entry goes stale.`} />

      <h2 id="partial-prerendering-ppr">Partial prerendering (PPR)</h2>
      <p>
        A cached page is fast but shared; a personalized page is per-user but pays full render
        cost on every request. PPR splits the page: everything before your{' '}
        <code>&lt;Suspense&gt;</code> boundaries (the <em>shell</em>) is cached in Rust and
        served instantly, while the Suspense content (the <em>holes</em>) re-renders per
        request - <code>getServerSideProps</code> reruns with the requester's own cookies -
        and streams into the same response behind the shell.
      </p>
      <p>
        Opt in by exporting <code>shell = 'cache'</code> next to <code>revalidate</code> on a
        page with Suspense boundaries:
      </p>
      <CodeBlock lang="tsx" code={`import React, { Suspense, use } from 'react';

export const revalidate = 60;
export const shell = 'cache';

export default function Page({ who }: PageProps): React.JSX.Element {
  return (
    <main>
      <h1>Storefront</h1>{/* shell: cached, identical for everyone */}
      <Suspense fallback={<p>Loading your cart…</p>}>
        <Cart cart={cartFor(who)} />{/* hole: suspends, re-rendered per request, streamed in */}
      </Suspense>
    </main>
  );
}

// The hole waits for this visitor's cart, so React sends it after the shell.
// cartFor() stands for your data call (it runs again in the browser while
// the page hydrates).
function Cart({ cart }: { cart: Promise<CartItem[]> }): React.JSX.Element {
  const items = use(cart);
  return <p>{items.length} items in your cart</p>;
}

export async function getServerSideProps(ctx: GsspContext) {
  // Reruns for every request on a shell cache hit - cookies are per-user here.
  return { props: { who: ctx.cookies['who'] ?? 'anon' } };
}`} />
      <p>
        On the first request the page streams normally; Node marks the pre-Suspense boundary
        and Rust captures and caches the shell bytes (composed exactly as that client saw
        them, capped at 4&nbsp;MB). On a hit, the cached shell goes out immediately - the
        instant TTFB - and a fresh holes-only render appends the personalized chunks. Stale
        shells follow stale-while-revalidate like any other entry.
      </p>
      <p>
        <strong>The contract:</strong> the shell must render identically for every visitor -
        same tree structure, same bytes. Only Suspense content may be personalized. React's
        Suspense replacement scripts target boundary IDs by tree position, and on a hit the
        cached shell and the holes come from different render passes - a shell that varies
        per visitor would mismatch. The page must also be shareable in the usual sense
        (<code>revalidate</code> set, no per-request response headers, no vary); a page that
        isn't falls back to plain streaming with a warning. Cookies cannot be set from a
        holes render - the cached shell has already sent the response headers - so they are
        dropped with a warning; set them from a route handler or a non-PPR page.
      </p>
      <p>
        Reading cookies in <code>getServerSideProps</code> is expected here. The hydration
        envelope (the serialized props) is streamed right after the shell boundary on every
        response, so each visitor hydrates with their own props. What the holes render from
        those props stays out of the shell only if the hole <em>suspends</em>: Suspense
        content that renders without suspending - or whose data arrives before the shell has
        been sent - is flushed with the shell. GioJS checks the shell before Rust stores it:
        when <code>getServerSideProps</code> read credentials and the shell holds rendered
        Suspense content (or no pending hole at all), the shell is not stored and a warning
        names the route; the page still streams, rendered in full for every request.
        Rendering those props <em>outside</em> a Suspense boundary breaks the contract - the
        first visitor&apos;s values would be cached in the shell.
      </p>
      <p>
        A <code>loading.tsx</code> is a Suspense boundary too, around everything below its
        folder. On a PPR page whose content suspends, the cached shell therefore ends there:
        it holds the layouts above the <code>loading.tsx</code> and its loading UI, and the
        page itself streams per request as a hole. A page that renders without suspending is
        part of the shell, and the contract applies to it. A page that throws before it
        suspends is answered with its <code>error.tsx</code> and a 500 - a broken render is
        never stored as a shell. Neither is a shell holding a boundary React gave up on (an
        error inside any Suspense boundary before the shell was sent): that response still
        streams, but nothing is cached, and the next request renders again.
      </p>
      <p>
        PPR degrades gracefully: if the holes render fails or times out, the body simply ends
        after the shell and the Suspense fallbacks remain visible - the user gets the cached
        page with "Loading…" states instead of an error.
      </p>
      <p>
        <code>getServerSideProps</code> may still answer a visitor with something other than
        holes - <code>redirect(&apos;/login&apos;)</code> for a visitor who is not signed in,{' '}
        <code>notFound()</code>, an error. On a shell hit that answer comes after the
        shell&apos;s <code>200</code> has been sent, so the page finishes itself and takes the
        visitor there. A redirect to an <code>http(s)</code> or relative URL that sets no
        cookies becomes <code>location.replace(url)</code> (plus a{' '}
        <code>&lt;meta http-equiv=&quot;refresh&quot;&gt;</code> for visitors without
        JavaScript). Anything else - a 404, an error page, a redirect that sets cookies -
        reloads the page once with a short-lived <code>__gio_ppr_bypass</code> cookie, and
        that request skips the cached shell: the whole page renders, with its real status,{' '}
        <code>Location</code> and cookies. The scripts carry the CSP nonce. The visitor still
        sees the shell for a moment first, so for pages most visitors are redirected away from,
        prefer a <a href="/docs/middleware">guard</a>, which answers before any shell is sent.
      </p>
      <p><code>X-Gio-Cache</code> labels PPR responses distinctly:</p>
      <ul>
        <li><code>ppr; shell=stored</code> - full render served, and its shell was captured and cached</li>
        <li><code>ppr; shell=hit</code> - cached shell served instantly, holes streamed behind it</li>
        <li><code>ppr; shell=stale; age=&lt;secs&gt;; revalidating</code> - stale shell served while a background render refreshes it</li>
      </ul>
    </>
  );
}
