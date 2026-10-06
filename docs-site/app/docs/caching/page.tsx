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
      <p>Cached pages are served from memory in microseconds. When a page is stale, GioJS serves the stale copy immediately and revalidates in the background - visitors never wait.</p>
      <div className="callout">Cache keys are deployment-ID aware, so a redeploy automatically invalidates stale entries.</div>
      <h2>Personalized pages are never shared</h2>
      <p>
        A cached page is served to everyone, so it must not depend on who is asking. When{' '}
        <code>getServerSideProps</code> reads the visitor&apos;s credentials - any access to{' '}
        <code>ctx.cookies</code>, or reading the <code>cookie</code> or{' '}
        <code>authorization</code> entry of <code>ctx.headers</code> (including spreading or
        enumerating the headers) - GioJS marks that render personalized and does not cache it,
        even though the page exports <code>revalidate</code>. A warning is logged once per
        route. Headers an <code>onRequest</code> plugin added or changed count as credentials
        too; other headers (<code>accept-language</code>, <code>user-agent</code>, ...) do not.
      </p>
      <p>
        To keep a personalized page fast, either drop <code>revalidate</code> (it renders per
        request, streamed) or cache the shared part with{' '}
        <a href="/docs/caching-layers">partial prerendering</a>:{' '}
        <code>shell = &apos;cache&apos;</code> plus <code>&lt;Suspense&gt;</code> holes for the
        personalized parts.
      </p>
    </>
  );
}
