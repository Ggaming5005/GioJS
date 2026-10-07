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

      <p>
        On a cached page, <code>getServerSideProps</code> may also return{' '}
        <code>tags</code> next to <code>props</code> - <code>{"{ props, tags: ['post:42'] }"}</code>{' '}
        - added to the page&apos;s <code>export const tags</code> for this render.
      </p>

      <h2>export const revalidate</h2>
      <p>
        A number (seconds), or <code>false</code> to cache indefinitely. Controls the
        ISR cache TTL for the page. Pages without it render on every request.
      </p>

      <h2>export const tags</h2>
      <p>
        Cache tags for every render of a cached page, e.g.{' '}
        <code>{"export const tags = ['posts']"}</code>. <code>revalidateTag()</code> and{' '}
        <code>POST /_gio/revalidate</code> purge the pages carrying a tag - see{' '}
        <a href="/docs/caching">Caching</a>.
      </p>

      <h2>revalidateTag(tag) / revalidatePath(path, options?)</h2>
      <p>
        Purge cached pages from server code, so the next request renders them fresh.{' '}
        <code>revalidatePath</code> takes <code>{"{ type: 'page' }"}</code> (default: that
        page, every query string and locale) or <code>{"{ type: 'prefix' }"}</code> (the path
        and everything below it); the path may be decoded (<code>/blog/café</code>) or
        percent-encoded (<code>/blog/caf%C3%A9</code>). Both resolve with{' '}
        <code>{'{ ok, purged, error? }'}</code>{' '}
        once the server confirmed the purge, and resolve <code>ok: false</code> instead of
        throwing when it could not be confirmed in time.
      </p>
      <CodeBlock lang="ts" code={`import { revalidatePath, revalidateTag } from '@gio.js/core';

await revalidateTag('posts');
await revalidatePath('/blog', { type: 'prefix' });`} />

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
