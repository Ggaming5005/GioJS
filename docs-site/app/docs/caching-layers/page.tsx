import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Architecture</div>
      <h1>Caching Layers</h1>
      <p className="page-subtitle">In-process LRU over a persistent disk tier, per instance.</p>
      <p>
        The page cache is layered: a bounded in-memory LRU (L1, 1000 entries) over an on-disk
        tier (L2) that persists entries across restarts. Lookups check memory first, then disk;
        all writes go to memory immediately and to disk in a background task. The disk tier is
        bounded, with the oldest files evicted past the limit.
      </p>
      <p>
        The architecture includes a storage-backend seam (L3) where a shared cluster-wide tier
        could slot in, but no shared backend ships yet - the cache is per-instance. For
        multi-instance deployments, set <code>GIO_DEPLOYMENT_ID</code> to the same value on
        every instance so their caches agree on the deployment ID.
      </p>
      <h2>Observing the cache: X-Gio-Cache</h2>
      <p>
        Every response carries an <code>X-Gio-Cache</code> header saying which tier
        answered and why, so cache behavior is observable from any{' '}
        <code>curl -I</code> instead of reverse-engineered:
      </p>
      <ul>
        <li><code>hit; ttl=&lt;secs&gt;</code> - served from the Rust page cache without touching Node; <code>ttl</code> is the seconds until the entry goes stale</li>
        <li><code>stale; age=&lt;secs&gt;; revalidating</code> - served instantly from the cache past its TTL while one background render refreshes the entry; <code>age</code> is seconds since it was rendered</li>
        <li><code>miss; stored</code> - rendered by the Node worker and stored; the next request for this key is a hit</li>
        <li><code>bypass</code> - rendered (or redirected) but not cached: the page did not declare <code>revalidate</code>, the request was not GET/HEAD, the response varies per user, or it set per-request headers</li>
        <li><code>static</code> - served by the Rust static file layer (public/ assets, hashed chunks, fonts); never touches the cache or Node</li>
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

      <h2>Partial prerendering (PPR)</h2>
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
      <CodeBlock lang="tsx" code={`import React, { Suspense } from 'react';

export const revalidate = 60;
export const shell = 'cache';

export default function Page({ who }: PageProps): React.JSX.Element {
  return (
    <main>
      <h1>Storefront</h1>{/* shell: cached, identical for everyone */}
      <Suspense fallback={<p>Loading your cart…</p>}>
        <Cart who={who} />{/* hole: re-rendered per request, streamed in */}
      </Suspense>
    </main>
  );
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
        isn't falls back to plain streaming with a warning.
      </p>
      <p>
        PPR degrades gracefully: if the holes render fails or times out, the body simply ends
        after the shell and the Suspense fallbacks remain visible - the user gets the cached
        page with "Loading…" states instead of an error.
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
