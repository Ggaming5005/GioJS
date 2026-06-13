import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Caching & Revalidating</h1>
      <p className="page-subtitle">Incremental Static Regeneration with stale-while-revalidate semantics.</p>
      <p>Export revalidate from a page to control how long its rendered HTML is cached by the Rust layer.</p>
      <CodeBlock lang="tsx" code={`// cache for 60s, then revalidate in the background
export const revalidate = 60;

// cache indefinitely
export const revalidate = false;

// never cache (default)
// (omit the export)`} />
      <h2>How it works</h2>
      <p>Cached pages are served from memory in microseconds. When a page is stale, GioJS serves the stale copy immediately and revalidates in the background — visitors never wait.</p>
      <div className="callout">Cache keys are deployment-ID aware, so a redeploy automatically invalidates stale entries.</div>
    </>
  );
}
