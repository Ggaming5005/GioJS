import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">API Reference</div>
      <h1>Functions</h1>
      <p className="page-subtitle">Server-side functions and page exports.</p>

      <h2>getServerSideProps(ctx)</h2>
      <p>
        Async data loader, run per request. The context carries the full request:{' '}
        <code>method</code>, <code>path</code>, <code>params</code>, <code>query</code>,
        lowercased <code>headers</code>, parsed <code>cookies</code>, and{' '}
        <code>locale</code>. Return <code>props</code>, a <code>redirect</code>, or
        props plus response <code>headers</code>:
      </p>
      <CodeBlock lang="ts" code={`export async function getServerSideProps(ctx) {
  const user = await auth(ctx.cookies['session']);
  if (!user) {
    return { redirect: { destination: '/login', permanent: false } };
  }
  return {
    props: { name: user.name },
    headers: { 'set-cookie': 'seen=1; Path=/; HttpOnly' },  // optional
  };
}`} />
      <p>
        A page that returns response headers is automatically made uncacheable -
        caching a per-request <code>set-cookie</code> would replay one visitor&apos;s
        cookie to everyone.
      </p>

      <h2>export const revalidate</h2>
      <p>
        A number (seconds), or <code>false</code> to cache indefinitely. Controls the
        ISR cache TTL for the page. Pages without it render on every request.
      </p>

      <h2>getStaticPaths()</h2>
      <p>
        On static export, tells <code>gio export</code> which concrete paths to
        pre-render for a dynamic route: return{' '}
        <code>{'{ paths: [{ params: { id: "1" } }] }'}</code>.
      </p>

      <h2>Route handler exports</h2>
      <p>
        <code>route.ts</code> files export <code>GET</code> / <code>POST</code> /{' '}
        <code>PUT</code> / <code>PATCH</code> / <code>DELETE</code> (API endpoints,
        SSE) and <code>wsHandler</code> (WebSockets) - see Route Handlers.
      </p>
    </>
  );
}
