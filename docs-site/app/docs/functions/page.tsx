import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Functions',
  description: 'Server-side functions, page exports and router hooks.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Functions</h1>
      <p className="page-subtitle">Server-side functions, page exports and router hooks.</p>

      <h2 id="getserversidepropsctx">getServerSideProps(ctx)</h2>
      <p>
        Async data loader, run per request. The context carries the full request:{' '}
        <code>method</code>, <code>path</code>, <code>params</code>, <code>query</code>,
        lowercased <code>headers</code>, parsed <code>cookies</code>, and{' '}
        <code>locale</code>. Return <code>props</code>, a <code>redirect</code>,{' '}
        <code>{'{ notFound: true }'}</code>, or props plus response <code>headers</code>{' '}
        (typed: <code>{"GetServerSideProps<Props, '/route/:param'>"}</code>, see{' '}
        <a href="#types">Types</a>):
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

      <h2 id="export-const-revalidate">export const revalidate</h2>
      <p>
        A number (seconds), or <code>false</code> to cache indefinitely. Controls the
        ISR cache TTL for the page. Pages without it render on every request.
      </p>

      <h2 id="export-const-tags">export const tags</h2>
      <p>
        Cache tags for every render of a cached page, e.g.{' '}
        <code>{"export const tags = ['posts']"}</code>. <code>revalidateTag()</code> and{' '}
        <code>POST /_gio/revalidate</code> purge the pages carrying a tag - see{' '}
        <a href="/docs/caching">Caching</a>.
      </p>

      <h2 id="revalidatetagtag-revalidatepathpath-options">revalidateTag(tag) / revalidatePath(path, options?)</h2>
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

      <h2 id="getstaticpaths">getStaticPaths()</h2>
      <p>
        On static export, tells <code>gio export</code> which concrete paths to
        pre-render for a dynamic route: return{' '}
        <code>{'{ paths: [{ params: { id: "1" } }] }'}</code>. Typed as{' '}
        <code>{"GetStaticPaths<'/posts/:id'>"}</code>, every entry must carry the
        route&apos;s params. A catch-all takes the path below it as one string{' '}
        (<code>{"'guides/setup'"}</code>) or as its segments (<code>{"['guides', 'setup']"}</code>).
      </p>

      <h2 id="route-handler-exports">Route handler exports</h2>
      <p>
        <code>route.ts</code> files export <code>GET</code> / <code>POST</code> /{' '}
        <code>PUT</code> / <code>PATCH</code> / <code>DELETE</code> (API endpoints,
        SSE) and <code>wsHandler</code> (WebSockets) - see Route Handlers.
      </p>

      <h2 id="router-hooks">Router hooks</h2>
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

      <h2 id="broadcast">broadcast()</h2>
      <p>
        <code>broadcast(room, data, {'{'} except? {'}'})</code> from <code>@gio.js/core</code>{' '}
        sends a text (string) or binary (<code>Uint8Array</code>) message to every WebSocket
        that joined <code>room</code> with <code>socket.join(room)</code>, from any route
        handler or <code>wsHandler</code>. It returns <code>false</code> when no WebSocket
        server is connected - see <a href="/docs/websockets">WebSockets</a>.
      </p>

      <h2 id="cspnonce">cspNonce()</h2>
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

      <h2 id="types">Types</h2>
      <p>
        <code>@gio.js/core</code> exports a type for every file convention, so app code
        never restates the shapes inline (<code>import type</code> - nothing ships to the
        browser). Every runtime export&apos;s parameter and result types are exported too
        (<code>CookieOptions</code>, <code>SessionStorage</code>, <code>RevalidateResult</code>,{' '}
        <code>MiddlewareRules</code>, <code>RedirectInit</code>, <code>IPCRequest</code> /{' '}
        <code>IPCResponse</code> for plugins, ...).
      </p>
      <table>
        <thead><tr><th>Type</th><th>For</th></tr></thead>
        <tbody>
          <tr><td><code>{'GetServerSideProps<Props, Route>'}</code></td><td>A page&apos;s loader: types <code>ctx</code> (<code>{'GsspContext<Route>'}</code>) and the result (<code>{'GetServerSidePropsResult<Props>'}</code>: props, redirect, notFound, <code>redirect()</code>).</td></tr>
          <tr><td><code>{'InferPageProps<typeof getServerSideProps>'}</code></td><td>The props a page with a loader renders with - exactly what it returned.</td></tr>
          <tr><td><code>{'PageProps<Route>'}</code></td><td>A page <em>without</em> a loader: <code>{'{ params, searchParams }'}</code>.</td></tr>
          <tr><td><code>LayoutProps</code></td><td><code>{'{ children, path }'}</code> (<code>path</code>: the page&apos;s path, for active links).</td></tr>
          <tr><td><code>ErrorPageProps</code></td><td><code>error.tsx</code>: <code>{'{ error: { message, digest? }, reset? }'}</code>.</td></tr>
          <tr><td><code>NotFoundPageProps</code></td><td><code>not-found.tsx</code> (no props).</td></tr>
          <tr><td><code>{'GetStaticPaths<Route>'}</code></td><td><code>getStaticPaths</code> for <code>gio export</code>.</td></tr>
          <tr><td><code>{'RouteHandler<Route>'}</code>, <code>{'GioRequest<Route>'}</code></td><td><code>route.ts</code> method handlers and their request.</td></tr>
          <tr><td><code>{'ActionArgs<Route>'}</code>, <code>{'WithActionData<typeof action, Props>'}</code></td><td>A page <code>action</code>&apos;s request, and page props with its <code>actionData</code> - see <a href="/docs/forms">Forms</a>.</td></tr>
          <tr><td><code>Metadata</code>, <code>{'GenerateMetadata<Route>'}</code></td><td>Head metadata - see <a href="/docs/metadata">Metadata</a>.</td></tr>
          <tr><td><code>GioNodePlugin</code>, <code>MiddlewareRules</code>, <code>WsHandler</code> / <code>GioSocket</code></td><td>gio.config.ts plugins, middleware.ts rules, WebSocket handlers.</td></tr>
        </tbody>
      </table>
      <p>
        <code>Route</code> is a route pattern as the router writes it -{' '}
        <code>{"'/posts/:id'"}</code>, <code>{"'/docs/*slug'"}</code> (one string with{' '}
        <code>/</code> separators), <code>{"'/shop/*path?'"}</code> (optional) - or a params
        shape like <code>{'{ id: string }'}</code>. Once the generated{' '}
        <code>.gio/routes.d.ts</code> is in your tsconfig <code>include</code> (it is in the
        starters), a pattern must be one of your app&apos;s routes, so a typo fails{' '}
        <code>tsc</code> and editors autocomplete it - the same registry{' '}
        <code>href()</code> and <code>useParams()</code> use. Before the server first runs,
        any pattern is accepted and its params are read from the pattern itself. Leaving{' '}
        <code>Route</code> out types params as <code>{'Record<string, string>'}</code>.
      </p>
      <CodeBlock lang="tsx" code={`import type { GetStaticPaths, PageProps, RouteHandler } from '@gio.js/core';

// app/docs/[...slug]/page.tsx - no getServerSideProps
export default function Doc({ params }: PageProps<'/docs/*slug'>) {
  return <h1>{params.slug.split('/').join(' / ')}</h1>;
}

export const getStaticPaths: GetStaticPaths<'/docs/*slug'> = () => ({
  paths: [{ params: { slug: 'intro' } }, { params: { slug: ['guides', 'setup'] } }],
});

// app/api/posts/[id]/route.ts
export const DELETE: RouteHandler<'/api/posts/:id'> = async (req) => {
  await db.posts.delete(req.params.id);
  return null;                                   // 204
};`} />
    </>
  );
}
