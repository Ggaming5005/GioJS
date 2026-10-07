import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Functions',
  description:
    'Every function GioJS exports: server functions from @gio.js/core, client functions from @gio.js/react, and the testing kit.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Functions</h1>
      <p className="page-subtitle">
        Every function GioJS exports: server functions from <code>@gio.js/core</code>, client
        functions from <code>@gio.js/react</code>, and the testing kit.
      </p>
      <p>
        Components and hooks have their own references (
        <a href="/docs/components">Components</a>, <a href="/docs/hooks">Hooks</a>), and so do
        the exports a page or route file declares (
        <a href="/docs/page-exports">Page Exports</a>).
      </p>

      <h2 id="server-functions">Server functions</h2>
      <p>
        From <code>@gio.js/core</code>. They run in the Node worker: in{' '}
        <code>getServerSideProps</code>, page actions, route handlers and plugins.
      </p>
      <table>
        <thead><tr><th>Function</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/functions/redirect"><code>redirect()</code></a>, <code>isActionRedirect()</code></td><td>Answer an action or <code>getServerSideProps</code> with a redirect (303 by default), returned or thrown.</td></tr>
          <tr><td><a href="/docs/functions/not-found"><code>notFound()</code></a></td><td>Answer 404 with the nearest <code>not-found.tsx</code>, or a JSON 404 in a route handler.</td></tr>
          <tr><td><a href="/docs/functions/revalidate-path"><code>revalidatePath()</code></a></td><td>Purge the cached page at a path, or everything below it.</td></tr>
          <tr><td><a href="/docs/functions/revalidate-tag"><code>revalidateTag()</code></a></td><td>Purge every cached page carrying a tag.</td></tr>
          <tr><td><a href="/docs/functions/create-session-storage"><code>createSessionStorage()</code></a></td><td>Encrypted cookie sessions that Rust guards can verify.</td></tr>
          <tr><td><a href="/docs/functions/cookies"><code>parseCookies()</code>, <code>serializeCookie()</code>, <code>signValue()</code>, <code>unsignValue()</code></a></td><td>Read and write cookies with secure defaults; sign values against tampering.</td></tr>
          <tr><td><a href="/docs/functions/csp-nonce"><code>cspNonce()</code></a></td><td>The CSP nonce for your own inline scripts.</td></tr>
          <tr><td><a href="/docs/functions/gio-event-stream"><code>GioEventStream</code>, <code>isGioEventStream()</code></a></td><td>Answer a route handler with Server-Sent Events.</td></tr>
          <tr><td><a href="/docs/functions/broadcast"><code>broadcast()</code></a></td><td>Send a message to every WebSocket in a room.</td></tr>
          <tr><td><a href="/docs/functions/request-errors"><code>UnsupportedMediaTypeError</code>, <code>MalformedBodyError</code></a> and their <code>is...()</code> guards</td><td>What <code>req.json()</code> and <code>req.formData()</code> throw (415 and 400).</td></tr>
          <tr><td><a href="/docs/functions/define-middleware"><code>defineMiddleware()</code></a></td><td>Type <code>middleware.ts</code>: redirects, rewrites, headers and guards run in Rust.</td></tr>
          <tr><td><a href="/docs/functions/define-config"><code>defineConfig()</code></a></td><td>Type <code>gio.config.ts</code>: Node plugins.</td></tr>
          <tr><td><a href="/docs/functions/server-only"><code>@gio.js/core/server-only</code></a></td><td>Mark a module so a client bundle that imports it is refused.</td></tr>
        </tbody>
      </table>

      <h2 id="client-functions">Client functions</h2>
      <p>
        From <code>@gio.js/react</code>. Safe to import during server rendering, where the
        ones that touch the browser do nothing.
      </p>
      <table>
        <thead><tr><th>Function</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/functions/navigate"><code>navigate()</code></a></td><td>Soft-navigate from any client code.</td></tr>
          <tr><td><a href="/docs/functions/href"><code>href()</code></a></td><td>Build a path from a route pattern, type-checked against your routes.</td></tr>
          <tr><td><a href="/docs/functions/deployment-helpers"><code>getDeploymentId()</code>, <code>isHardReloadResponse()</code>, <code>handleHardReload()</code>, <code>initDeploymentId()</code></a></td><td>Detect that a tab runs an older build, and reload it.</td></tr>
          <tr><td><code>initAnimateObserver()</code>, <code>observeElement()</code></td><td>The shared IntersectionObserver behind <a href="/docs/components/animate"><code>{'<Animate>'}</code></a> (below).</td></tr>
        </tbody>
      </table>
      <h3 id="initanimateobserver-and-observeelement">initAnimateObserver and observeElement</h3>
      <p>
        <code>{'<Animate>'}</code> uses one <code>IntersectionObserver</code> for every
        animated element on the page. <code>observeElement(el)</code> adds an element to it
        (creating the observer on first use); once at least 10% of the element is visible,
        its <code>data-gio-animate-state</code> attribute becomes <code>entered</code> and it
        is no longer observed. <code>initAnimateObserver()</code> only creates the observer.
        Both do nothing on the server. You need them only to give an element of your own the
        same entrance trigger.
      </p>

      <h2 id="testing-functions">Testing functions</h2>
      <p>
        From <code>@gio.js/core/testing</code> and <code>@gio.js/core/vitest</code>, for
        vitest and node:test. See the <a href="/docs/testing">Testing guide</a>.
      </p>
      <table>
        <thead><tr><th>Function</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/functions/render-page"><code>renderPage()</code></a></td><td>Render a page in-process: status, HTML, props, cookies, redirect, cacheability.</td></tr>
          <tr><td><a href="/docs/functions/call-route"><code>callRoute()</code></a></td><td>Call a route handler or page action in-process, with any method and body.</td></tr>
          <tr><td><a href="/docs/functions/create-test-server"><code>createTestServer()</code></a></td><td>Start the real server on a free port for end-to-end tests.</td></tr>
          <tr><td><a href="/docs/functions/reset-test-app"><code>resetTestApp()</code></a></td><td>Re-discover routes after a test added or removed files.</td></tr>
          <tr><td><a href="/docs/functions/gio-vitest"><code>gioVitest()</code></a></td><td>The vitest plugin for CSS Module class names.</td></tr>
        </tbody>
      </table>

      <h2 id="page-exports-and-hooks">Page exports and hooks</h2>
      <p>
        These used to be described on this page. Each now has its own reference; the short
        versions below keep their old links working.
      </p>

      <h3 id="getserversidepropsctx">getServerSideProps(ctx)</h3>
      <p>
        A page&apos;s per-request data loader. <code>ctx</code> carries <code>method</code>,{' '}
        <code>path</code>, <code>params</code>, <code>query</code>, lowercased{' '}
        <code>headers</code>, parsed <code>cookies</code> and <code>locale</code>. Return{' '}
        <code>{'{ props }'}</code> (optionally with response <code>headers</code> and cache{' '}
        <code>tags</code>), a redirect, or <code>{'{ notFound: true }'}</code>. See{' '}
        <a href="/docs/page-exports/get-server-side-props">getServerSideProps</a>.
      </p>

      <h3 id="export-const-revalidate">export const revalidate</h3>
      <p>
        Seconds a page is cached, or <code>false</code> to cache it until it is purged. Pages
        without it render on every request. See{' '}
        <a href="/docs/page-exports/revalidate">revalidate</a>.
      </p>

      <h3 id="export-const-tags">export const tags</h3>
      <p>
        Cache tags for every render of a cached page, purged with{' '}
        <a href="/docs/functions/revalidate-tag"><code>revalidateTag()</code></a>. See{' '}
        <a href="/docs/page-exports/tags">tags</a>.
      </p>

      <h3 id="revalidatetagtag-revalidatepathpath-options">revalidateTag(tag) / revalidatePath(path, options?)</h3>
      <p>
        Purge cached pages from server code. See{' '}
        <a href="/docs/functions/revalidate-tag">revalidateTag</a> and{' '}
        <a href="/docs/functions/revalidate-path">revalidatePath</a>.
      </p>

      <h3 id="getstaticpaths">getStaticPaths()</h3>
      <p>
        Lists the concrete paths <code>gio export</code> pre-renders for a dynamic route. See{' '}
        <a href="/docs/page-exports/get-static-paths">getStaticPaths</a>.
      </p>

      <h3 id="route-handler-exports">Route handler exports</h3>
      <p>
        A <code>route.ts</code> exports method handlers - <code>GET</code>,{' '}
        <code>POST</code>, <code>PUT</code>, <code>PATCH</code>, <code>DELETE</code> - and{' '}
        <code>wsHandler</code> for WebSockets. See{' '}
        <a href="/docs/page-exports/http-methods">HTTP methods</a> and{' '}
        <a href="/docs/page-exports/ws-handler">wsHandler</a>.
      </p>

      <h3 id="router-hooks">Router hooks</h3>
      <p>
        <code>usePathname()</code>, <code>useParams()</code>, <code>useSearchParams()</code>,{' '}
        <code>useLocale()</code> and <code>useRouter()</code> from <code>@gio.js/react</code>{' '}
        read the page the router matched, on the server and in the browser alike. See{' '}
        <a href="/docs/hooks">Hooks</a>; outside components, use{' '}
        <a href="/docs/functions/navigate"><code>navigate()</code></a>.
      </p>

      <h3 id="broadcast">broadcast()</h3>
      <p>
        See <a href="/docs/functions/broadcast">broadcast</a>.
      </p>

      <h3 id="cspnonce">cspNonce()</h3>
      <p>
        See <a href="/docs/functions/csp-nonce">cspNonce</a>.
      </p>

      <h2 id="types">Types</h2>
      <p>
        <code>@gio.js/core</code> exports a type for every file convention, so app code
        never restates the shapes inline (<code>import type</code> - nothing ships to the
        browser). Every runtime export&apos;s parameter and result types are exported too
        (<code>CookieOptions</code>, <code>SessionStorage</code>, <code>RevalidateResult</code>,{' '}
        <code>MiddlewareRules</code>, <code>RedirectInit</code>, <code>IPCRequest</code> /{' '}
        <code>IPCResponse</code> for plugins, ...). The <a href="/docs/typescript">TypeScript</a>{' '}
        reference lists them all.
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
        <a href="/docs/functions/href"><code>href()</code></a> and <code>useParams()</code>{' '}
        use. Before the server first runs, any pattern is accepted and its params are read
        from the pattern itself. Leaving <code>Route</code> out types params as{' '}
        <code>{'Record<string, string>'}</code>.
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
