import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">API Reference</div>
      <h1>Functions</h1>
      <p className="page-subtitle">Server-side functions, page exports and router hooks.</p>

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

      <h2>Router hooks</h2>
      <p>
        From <code>@gio.js/react</code>. They read the page the router matched, on the server
        (root layout included) and in the browser with identical values, and follow soft
        navigations. See <a href="/docs/linking-and-navigating">Linking &amp; Navigating</a>.
      </p>
      <table>
        <thead><tr><th>Hook</th><th>Returns</th></tr></thead>
        <tbody>
          <tr><td><code>usePathname()</code></td><td>The routed path, without query, hash or locale prefix.</td></tr>
          <tr><td><code>{'useParams<T>()'}</code></td><td>The dynamic segment values; <code>T</code> is a registered pattern (<code>{"'/posts/:id'"}</code>) or a params shape.</td></tr>
          <tr><td><code>useSearchParams()</code></td><td>The query as a read-only <code>URLSearchParams</code>.</td></tr>
          <tr><td><code>useLocale()</code></td><td>The request locale (<code>&apos;&apos;</code> without i18n).</td></tr>
          <tr><td><code>useRouter()</code></td><td><code>{'{ push, replace, back, forward, refresh, prefetch }'}</code> - one stable object; no-ops on the server.</td></tr>
        </tbody>
      </table>
      <CodeBlock lang="tsx" code={`import { usePathname, useRouter, navigate } from '@gio.js/react';

const router = useRouter();
await router.push('/posts/2', { scroll: false });
router.refresh();                       // fresh props, same URL and state

await navigate('/login', { replace: true });   // outside components`} />

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
