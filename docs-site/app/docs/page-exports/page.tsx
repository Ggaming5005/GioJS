import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Page Exports',
  description:
    'Every module export GioJS reads from the files of an app - pages, layouts, route handlers, special files and config - and what each one does.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Page Exports</h1>
      <p className="page-subtitle">
        Every module export GioJS reads from the files of an app - pages, layouts, route
        handlers, special files and config - and what each one does.
      </p>
      <p>
        GioJS configures a route with what its files export, not with a config object. The
        tables below list every export the framework reads, by file. An export that is not
        listed is ignored: it is an ordinary export of your module and nothing more.
      </p>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`export const revalidate = 3600;                       // cache the render for an hour
export const tags = ['posts'];                         // purge it with revalidateTag('posts')

export async function getServerSideProps(ctx) { /* load the post */ }
export async function generateMetadata(ctx, { props }) { /* its <title> */ }
export async function action(req) { /* handle the comment form's POST */ }

export default function PostPage({ post }) { /* render it */ }`} />

      <h2 id="pages">Pages</h2>
      <p><code>app/**/page.tsx</code> (or <code>.jsx</code>, <code>.js</code>):</p>
      <table>
        <thead><tr><th>Export</th><th>Type</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>default</code></td><td>React component</td><td>The page. Receives what <code>getServerSideProps</code> returned, or <code>{'{ params, searchParams }'}</code> without it, plus <code>actionData</code> after an action. See <a href="/docs/file-conventions/page"><code>page.tsx</code></a>.</td></tr>
          <tr><td><a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a></td><td>async function</td><td>Loads data on the server for each render; may redirect, answer 404 or set headers.</td></tr>
          <tr><td><a href="/docs/page-exports/action"><code>action</code></a></td><td>async function</td><td>Handles a <code>POST</code> to the page&apos;s URL: redirect, re-render with <code>actionData</code>, or a <code>Response</code>.</td></tr>
          <tr><td><a href="/docs/page-exports/metadata"><code>metadata</code></a></td><td><code>Metadata</code></td><td>Static head metadata: title, description, Open Graph, canonical URL, ...</td></tr>
          <tr><td><a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a></td><td>function</td><td>Head metadata per request, from params, query or the page&apos;s props.</td></tr>
          <tr><td><a href="/docs/page-exports/revalidate"><code>revalidate</code></a></td><td><code>number | false</code></td><td>Caches the render in the Rust server for that many seconds (<code>false</code>: until a purge or deploy). Not set: rendered per request.</td></tr>
          <tr><td><a href="/docs/page-exports/tags"><code>tags</code></a></td><td><code>string[]</code></td><td>Cache tags for <code>revalidateTag()</code>.</td></tr>
          <tr><td><a href="/docs/page-exports/shell"><code>shell</code></a></td><td><code>&apos;cache&apos;</code></td><td>Partial prerendering: caches the part before the Suspense boundaries, streams the holes per visitor.</td></tr>
          <tr><td><a href="/docs/page-exports/get-static-paths"><code>getStaticPaths</code></a></td><td>function</td><td>The params of a dynamic page to write under <code>gio export</code>. The server ignores it.</td></tr>
          <tr><td><a href="#the-legacy-page-get-export"><code>GET</code></a></td><td>function</td><td>Legacy: a page with no default export can answer with Server-Sent Events.</td></tr>
          <tr><td><a href="#dynamic-has-no-effect"><code>dynamic</code></a></td><td>string</td><td>Typed, but has no effect.</td></tr>
        </tbody>
      </table>

      <h2 id="layouts">Layouts</h2>
      <p><code>app/**/layout.tsx</code> (or <code>.jsx</code>, <code>.js</code>):</p>
      <table>
        <thead><tr><th>Export</th><th>Type</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>default</code></td><td>React component</td><td>Wraps every page below its folder; receives <code>{'{ children, path }'}</code>. The root layout renders <code>&lt;html&gt;</code> and is never hydrated. See <a href="/docs/file-conventions/layout"><code>layout.tsx</code></a>.</td></tr>
          <tr><td><a href="/docs/page-exports/metadata"><code>metadata</code></a></td><td><code>Metadata</code></td><td>Head metadata, merged under the pages below (title templates, a site-wide <code>openGraph</code>, <code>metadataBase</code>).</td></tr>
          <tr><td><a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a></td><td>function</td><td>Head metadata per request; <code>props</code> is <code>undefined</code> in a layout.</td></tr>
        </tbody>
      </table>
      <p>
        <code>revalidate</code>, <code>tags</code>, <code>shell</code> and{' '}
        <code>getServerSideProps</code> are read from pages only: in a layout they have no
        effect.
      </p>

      <h2 id="route-handlers">Route handlers</h2>
      <p><code>app/**/route.ts</code> (or <code>.js</code>):</p>
      <table>
        <thead><tr><th>Export</th><th>Type</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/page-exports/http-methods"><code>GET</code>, <code>POST</code>, <code>PUT</code>, <code>PATCH</code>, <code>DELETE</code></a></td><td><code>RouteHandler</code></td><td>Answer that HTTP method with a <code>Response</code>, JSON, <code>null</code> (204) or a <code>GioEventStream</code>. <code>HEAD</code> runs <code>GET</code>.</td></tr>
          <tr><td><a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a></td><td><code>WsHandler</code></td><td>Accepts WebSocket connections at the same path.</td></tr>
        </tbody>
      </table>
      <p>
        Route handler responses are never cached, so <code>revalidate</code> has no effect in
        a <code>route.ts</code>. See <a href="/docs/file-conventions/route"><code>route.ts</code></a>.
      </p>

      <h2 id="special-files">Special files</h2>
      <table>
        <thead><tr><th>File</th><th>Exports</th><th>What they do</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/file-conventions/error"><code>error.tsx</code></a></td><td><code>default</code>, <code>metadata</code>, <code>generateMetadata</code></td><td>The error page of its folder: a client error boundary that receives <code>{'{ error, reset }'}</code>.</td></tr>
          <tr><td><a href="/docs/file-conventions/not-found"><code>not-found.tsx</code></a></td><td><code>default</code>, <code>metadata</code>, <code>generateMetadata</code></td><td>The 404 page of its folder; the component gets no props.</td></tr>
          <tr><td><a href="/docs/file-conventions/loading"><code>loading.tsx</code></a></td><td><code>default</code></td><td>The Suspense fallback around its folder.</td></tr>
          <tr><td><a href="/docs/file-conventions/sitemap"><code>app/sitemap.ts</code></a>, <a href="/docs/file-conventions/robots"><code>app/robots.ts</code></a>, <a href="/docs/file-conventions/manifest"><code>app/manifest.ts</code></a></td><td><code>default</code>, <code>revalidate</code></td><td>The data of <code>/sitemap.xml</code>, <code>/robots.txt</code> and <code>/manifest.webmanifest</code>: a value, or a function returning (a promise of) one. Cached for <code>revalidate</code> seconds, <code>3600</code> by default.</td></tr>
        </tbody>
      </table>

      <h2 id="project-files">Project files</h2>
      <table>
        <thead><tr><th>File</th><th>Export</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/file-conventions/middleware"><code>middleware.ts</code></a></td><td><code>default</code></td><td><code>defineMiddleware({'{ redirects, rewrites, headers, guards }'})</code>: request rules the Rust server applies before rendering.</td></tr>
          <tr><td><a href="/docs/file-conventions/gio-config"><code>gio.config.ts</code></a></td><td><code>default</code></td><td><code>defineConfig({'{ plugins }'})</code>: Node plugins. Unknown keys stop startup.</td></tr>
        </tbody>
      </table>

      <h2 id="where-exports-run">Where exports run</h2>
      <p>
        Everything on this page runs on the server. The browser bundle of a route imports only
        the <code>default</code> exports of its page, its nested layouts and its{' '}
        <code>error.tsx</code> and <code>loading.tsx</code> files, so the other exports - and
        the modules only they import, such as a database client - are left out of it. The
        root layout is never sent to the browser at all. A helper built by a module-scope call
        (<code>export const getServerSideProps = withAuth(...)</code>) can keep its imports in
        the bundle: mark such modules <a href="/docs/functions/server-only">server-only</a>{' '}
        so a leak fails the build.
      </p>

      <h2 id="the-legacy-page-get-export">The legacy page GET export</h2>
      <p>
        Before route handlers existed, a page could stream Server-Sent Events. That still
        works, for compatibility: a <code>page.tsx</code> with <em>no</em> default export whose{' '}
        <code>GET(req)</code> returns a <code>GioEventStream</code> answers with the event
        stream.
      </p>
      <CodeBlock lang="tsx" title="app/legacy-feed/page.tsx" code={`import { GioEventStream } from '@gio.js/core';

// No default export: GET answers the request.
export function GET() {
  return new GioEventStream((stream) => {
    stream.send({ hello: 'world' });
    stream.close();
    return () => {};                               // nothing to clean up
  });
}`} />
      <ul>
        <li>
          A page that has a default export never calls its <code>GET</code>: the component
          renders.
        </li>
        <li>
          Write new streams as a <a href="/docs/page-exports/http-methods"><code>GET</code> in a{' '}
          <code>route.ts</code></a> instead: it can also return any <code>Response</code>,
          a streamed body included, and it sits next to the other methods of the endpoint.
        </li>
      </ul>

      <h2 id="dynamic-has-no-effect">dynamic has no effect</h2>
      <p>
        The page module type declares{' '}
        <code>{"dynamic?: 'force-dynamic' | 'force-static' | 'auto'"}</code>, but GioJS never
        reads it. Whether a page is cached is decided by{' '}
        <a href="/docs/page-exports/revalidate"><code>revalidate</code></a> alone: leave it out
        to render per request, export a number or <code>false</code> to cache.{' '}
        <code>gio migrate</code> rewrites a Next.js <code>dynamic = &apos;force-static&apos;</code>{' '}
        page to <code>revalidate = false</code>. The same goes for the other Next.js segment
        options (<code>runtime</code>, <code>fetchCache</code>, <code>dynamicParams</code>,{' '}
        <code>preferredRegion</code>, <code>maxDuration</code>): GioJS ignores them.
      </p>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/layouts-and-pages">Layouts and Pages</a></li>
        <li><a href="/docs/fetching-data">Fetching Data</a>, <a href="/docs/forms">Forms and Mutations</a>, <a href="/docs/caching">Caching &amp; Revalidating</a></li>
        <li><a href="/docs/file-conventions">File Conventions</a></li>
        <li><a href="/docs/typescript">TypeScript</a> - the types for every export</li>
      </ul>
    </>
  );
}
