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
    </>
  );
}
