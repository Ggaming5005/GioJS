import React from 'react';

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
    </>
  );
}
