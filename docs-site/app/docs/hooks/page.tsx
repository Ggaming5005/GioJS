import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Hooks',
  description: 'The React hooks exported from @gio.js/react: the router, the URL, the locale, form state and WebSockets.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Hooks</h1>
      <p className="page-subtitle">
        The React hooks exported from <code>@gio.js/react</code>: the router, the URL, the
        locale, form state and WebSockets.
      </p>
      <CodeBlock lang="tsx" code={`import {
  usePathname,
  useParams,
  useSearchParams,
  useRouter,
  useLocale,
  useGioFormState,
  useWebSocket,
} from '@gio.js/react';`} />

      <h2 id="router-and-url">Router and URL</h2>
      <p>
        These read the route the server matched. The value travels with the page, so the server
        render and the hydration render agree, and after a soft navigation hydrated components
        read the new page&apos;s values.
      </p>
      <table>
        <thead><tr><th>Hook</th><th>Returns</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/hooks/use-pathname"><code>usePathname()</code></a></td><td>The path, without query, hash or locale prefix: <code>&apos;/blog/hello&apos;</code>.</td></tr>
          <tr><td><a href="/docs/hooks/use-params"><code>{'useParams<T>()'}</code></a></td><td>The dynamic segments: <code>{"{ id: '42' }"}</code>, typed from a route pattern.</td></tr>
          <tr><td><a href="/docs/hooks/use-search-params"><code>useSearchParams()</code></a></td><td>The query as a read-only <code>URLSearchParams</code>.</td></tr>
          <tr><td><a href="/docs/hooks/use-router"><code>useRouter()</code></a></td><td><code>{'{ push, replace, back, forward, refresh, prefetch }'}</code> - one stable object.</td></tr>
          <tr><td><a href="/docs/hooks/use-locale"><code>useLocale()</code></a></td><td>The request locale, <code>&apos;&apos;</code> without <code>[i18n]</code>.</td></tr>
        </tbody>
      </table>
      <CodeBlock lang="tsx" title="app/posts/[id]/toolbar.tsx" code={`import { usePathname, useParams, useRouter, useSearchParams } from '@gio.js/react';

export function Toolbar() {
  const pathname = usePathname();                // '/posts/42'
  const { id } = useParams<'/posts/:id'>();      // '42'
  const tab = useSearchParams().get('tab');     // 'comments' or null
  const router = useRouter();
  return (
    <button onClick={() => void router.push(\`\${pathname}?tab=comments\`, { scroll: false })}>
      Comments on post {id} {tab === 'comments' ? '(open)' : ''}
    </button>
  );
}`} />

      <h2 id="forms">Forms</h2>
      <table>
        <thead><tr><th>Hook</th><th>Returns</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/hooks/use-gio-form-state"><code>useGioFormState()</code></a></td><td><code>{'{ pending, lastResult }'}</code> of the enclosing <a href="/docs/components/gio-form"><code>&lt;GioForm&gt;</code></a>.</td></tr>
        </tbody>
      </table>

      <h2 id="realtime">Realtime</h2>
      <table>
        <thead><tr><th>Hook</th><th>Returns</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/hooks/use-web-socket"><code>useWebSocket(url, options)</code></a></td><td><code>{'{ send, lastMessage, readyState, reconnectAttempts, isReconnecting, close, reconnect }'}</code>, with automatic reconnects.</td></tr>
        </tbody>
      </table>

      <h2 id="where-hooks-work">Where hooks work</h2>
      <ul>
        <li>
          Pages and nested layouts are rendered on the server and hydrated in the browser: hooks
          work there as in any React app. GioJS has no Server Components, so there is no{' '}
          <code>&apos;use client&apos;</code> directive to add.
        </li>
        <li>
          The root layout (<code>app/layout.tsx</code>) is rendered on the server only. The URL
          hooks return the values of the page loaded in full and are not updated by soft
          navigations, and effects never run there, so <code>useWebSocket</code> never connects.
        </li>
        <li>
          Outside a tree GioJS rendered - a component in a unit test or a separate React root -
          the URL hooks fall back to <code>window.location</code> (and <code>&apos;/&apos;</code>,{' '}
          <code>{'{}'}</code> on the server), and <code>useLocale</code> to{' '}
          <code>document.documentElement.lang</code>.
        </li>
        <li>
          To navigate outside components, use <a href="/docs/functions/navigate"><code>navigate()</code></a>.
        </li>
      </ul>
    </>
  );
}
