import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Architecture</div>
      <h1>Caching Layers</h1>
      <p className="page-subtitle">In-process LRU, disk tier, and optional Redis for multi-instance.</p>
      <p>The page cache is layered: a bounded in-memory LRU (L1), an optional disk tier (L2), and an optional Redis backend (L3) for sharing cache across instances.</p>
      <CodeBlock lang="toml" code={`[cache]
memory_mb = 128

[cache.redis]
enabled = true
url = "redis://localhost:6379"`} />
    </>
  );
}
