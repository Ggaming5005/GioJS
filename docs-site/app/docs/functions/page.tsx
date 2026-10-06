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
      <CodeBlock lang="ts" code={`import { sessions } from '../lib/session.server.ts';   // see Authentication

export async function getServerSideProps(ctx) {
  const user = await findUser(sessions.getSession(ctx).get('userId'));
  if (!user) {
    return { redirect: { destination: '/login', permanent: false } };
  }
  return {
    props: { name: user.name },
    headers: {                                              // optional
      'set-cookie': ['seen=1; Path=/; HttpOnly', 'theme=dark; Path=/'],
    },
  };
}`} />
      <p>
        Header values are strings or string arrays: each <code>set-cookie</code> entry is
        sent as its own header, other arrays are joined with <code>, </code>. A{' '}
        <code>redirect</code> may carry <code>headers</code> too (e.g. clearing cookies on
        logout). A page that returns response headers is automatically made uncacheable -
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

      <h2>cspNonce()</h2>
      <p>
        The Content-Security-Policy nonce for an inline <code>&lt;script&gt;</code> you
        render, when <code>[security] csp</code> uses <code>{'{nonce}'}</code>;{' '}
        <code>undefined</code> otherwise. During server rendering it returns a placeholder the
        server replaces with each response&apos;s fresh nonce, so it is meant for{' '}
        <code>nonce</code> attributes only: pass it straight to the attribute (best in the root
        layout) and never derive anything from it - see <a href="/docs/security">Security</a>.
      </p>
      <CodeBlock lang="tsx" code={`import { cspNonce } from '@gio.js/core';

<script nonce={cspNonce()} dangerouslySetInnerHTML={{ __html: 'window.dataLayer = []' }} />`} />
    </>
  );
}
