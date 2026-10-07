import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'File Conventions',
  description:
    'The file and folder names GioJS gives a meaning to: route files in app/, special folders, metadata files, and the files in the project root.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>File Conventions</h1>
      <p className="page-subtitle">
        The file and folder names GioJS gives a meaning to: route files in{' '}
        <code>app/</code>, special folders, metadata files, and the files in the project root.
      </p>
      <CodeBlock lang="text" code={`my-app/
  app/
    layout.tsx          the document and the layout of every page
    page.tsx            /
    not-found.tsx       404 page (also for unmatched URLs)
    error.tsx           500 page and error boundary
    globals.css         imported by layout.tsx
    sitemap.ts          /sitemap.xml
    (site)/             route group: no URL segment
      layout.tsx
      blog/
        page.tsx        /blog
        loading.tsx     Suspense fallback for /blog/...
        [slug]/page.tsx /blog/:slug
      _components/      private folder: never routed
    api/posts/route.ts  GET/POST /api/posts
  public/               static files at the site root
  middleware.ts         redirects, rewrites, headers, guards
  gio.config.ts         Node plugins
  gio.toml              server settings
  .env.local            environment variables
  .gio/                 generated: builds, caches, route types`} />

      <h2 id="route-files">Route files</h2>
      <p>
        These names have a meaning in <code>app/</code> and every folder below it, except{' '}
        <a href="/docs/file-conventions/private-folders">private folders</a>. Component files
        may be <code>.tsx</code>, <code>.jsx</code> or <code>.js</code> (in that order of
        precedence); <code>route</code> may be <code>.ts</code> or <code>.js</code>.
      </p>
      <table>
        <thead><tr><th>File</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/file-conventions/page"><code>page.tsx</code></a></td><td>Makes a folder a route: the UI for its URL</td></tr>
          <tr><td><a href="/docs/file-conventions/layout"><code>layout.tsx</code></a></td><td>Wraps the pages in its folder and below; the root one renders the document</td></tr>
          <tr><td><a href="/docs/file-conventions/route"><code>route.ts</code></a></td><td>HTTP handlers (<code>GET</code>, <code>POST</code>, <code>PUT</code>, <code>PATCH</code>, <code>DELETE</code>), Server-Sent Events and a WebSocket handler</td></tr>
          <tr><td><a href="/docs/file-conventions/loading"><code>loading.tsx</code></a></td><td>Suspense fallback for its folder and below, streamed first while the content suspends</td></tr>
          <tr><td><a href="/docs/file-conventions/error"><code>error.tsx</code></a></td><td>The 500 page when a render fails on the server, and a client error boundary once hydrated</td></tr>
          <tr><td><a href="/docs/file-conventions/not-found"><code>not-found.tsx</code></a></td><td>The 404 page for <code>notFound()</code> at or below its folder; the one in <code>app/</code> also answers unmatched URLs and is exported to <code>404.html</code></td></tr>
        </tbody>
      </table>
      <p>
        Pages and layouts may also export <code>metadata</code> or{' '}
        <code>generateMetadata</code> for their <code>&lt;head&gt;</code> tags, and pages a
        few more values: see <a href="/docs/page-exports">Page Exports</a>.
      </p>
      <p>
        <code>error.tsx</code>, <code>not-found.tsx</code> and <code>loading.tsx</code> may sit
        in any folder, including route groups and dynamic folders, and the nearest one at or
        above a page wins. Inside a folder they nest like this:
      </p>
      <CodeBlock lang="text" code={`<Layout>                 layout.tsx
  <ErrorBoundary>        error.tsx   - catches everything below, not the layout above it
    <Suspense>           loading.tsx - fallback while anything below suspends
      ...the next folder's layout, or the page`} />
      <p>
        So an <code>error.tsx</code> never handles errors from the layout in its own folder -
        the <code>error.tsx</code> of a parent folder does. See{' '}
        <a href="/docs/error-handling">Error Handling</a> and{' '}
        <a href="/docs/layouts-and-pages">Layouts &amp; Pages</a>.
      </p>

      <h2 id="folder-conventions">Folder conventions</h2>
      <table>
        <thead><tr><th>Folder</th><th>Effect</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/file-conventions/dynamic-routes"><code>[id]</code></a></td><td>Dynamic segment - matches exactly one URL segment (<code>/posts/:id</code>)</td></tr>
          <tr><td><a href="/docs/file-conventions/dynamic-routes#catch-all-segments"><code>[...slug]</code></a></td><td>Catch-all - one or more segments; <code>params.slug</code> is <code>&apos;a/b&apos;</code></td></tr>
          <tr><td><a href="/docs/file-conventions/dynamic-routes#optional-catch-all-segments"><code>[[...slug]]</code></a></td><td>Optional catch-all - zero or more segments, so it also matches the parent URL (<code>params.slug</code> is <code>&apos;&apos;</code>)</td></tr>
          <tr><td><a href="/docs/file-conventions/route-groups"><code>(group)</code></a></td><td>Route group - organizes files and scopes a layout without adding a URL segment</td></tr>
          <tr><td><a href="/docs/file-conventions/private-folders"><code>_folder</code></a></td><td>Private - never routable; for colocated components and helpers</td></tr>
        </tbody>
      </table>
      <p>
        Layouts apply by folder ancestry: a page gets the <code>layout.tsx</code> of every
        folder from <code>app/</code> down to its own, groups and dynamic folders included.
        When several routes match a URL the most specific wins (see{' '}
        <a href="/docs/file-conventions/dynamic-routes#matching-order">matching order</a>), and
        two files that answer the same URLs stop startup with an error naming both.
      </p>
      <p>
        Param names may not start with <code>.</code> or contain <code>?</code>, <code>:</code>{' '}
        or <code>*</code>; a folder like <code>[...slug?]</code> or <code>[id?]</code> fails
        startup instead of quietly changing what the route matches.
      </p>

      <h2 id="metadata-files">Metadata files</h2>
      <p>
        Only at the root of <code>app/</code>, as <code>.ts</code> or <code>.js</code>. The
        default export is the data, or a function returning it; <code>export const
        revalidate</code> sets how long the output is cached (default 3600 seconds).
      </p>
      <table>
        <thead><tr><th>File</th><th>Serves</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/file-conventions/sitemap"><code>sitemap.ts</code></a></td><td><code>/sitemap.xml</code> from <code>[{'{'} url, lastModified, changeFrequency, priority, alternates {'}'}]</code></td></tr>
          <tr><td><a href="/docs/file-conventions/robots"><code>robots.ts</code></a></td><td><code>/robots.txt</code> from <code>{'{'} rules, sitemap, host {'}'}</code></td></tr>
          <tr><td><a href="/docs/file-conventions/manifest"><code>manifest.ts</code></a></td><td><code>/manifest.webmanifest</code> from a Web App Manifest object</td></tr>
        </tbody>
      </table>
      <p>
        A <code>public/</code> file with the same name wins (the server warns at startup);
        a page or <code>route.ts</code> at the same URL fails startup.
      </p>

      <h2 id="styles">Styles</h2>
      <table>
        <thead><tr><th>File</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/file-conventions/css#global-css-imports">Imported <code>.css</code></a></td><td>Bundled per route, content-hashed, linked in <code>&lt;head&gt;</code></td></tr>
          <tr><td><a href="/docs/file-conventions/css#css-modules"><code>*.module.css</code></a></td><td>Local class names, imported as a map</td></tr>
          <tr><td><a href="/docs/file-conventions/css#stylesheets-served-by-path"><code>app/**/*.css</code></a></td><td>Also served at their path inside <code>app/</code> (legacy)</td></tr>
        </tbody>
      </table>

      <h2 id="project-root-files">Project root files</h2>
      <table>
        <thead><tr><th>File or folder</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/file-conventions/public-folder"><code>public/</code></a></td><td>Static files, served at the site root and under <code>/public/</code></td></tr>
          <tr><td><a href="/docs/file-conventions/middleware"><code>middleware.ts</code></a></td><td>Redirects, rewrites, headers and guards, enforced by the Rust server</td></tr>
          <tr><td><a href="/docs/file-conventions/gio-config"><code>gio.config.ts</code></a></td><td>Node plugins</td></tr>
          <tr><td><a href="/docs/file-conventions/gio-toml"><code>gio.toml</code></a></td><td>Every server setting</td></tr>
          <tr><td><a href="/docs/file-conventions/env-files"><code>.env</code>, <code>.env.local</code>, ...</a></td><td>Environment variables loaded at startup</td></tr>
          <tr><td><a href="/docs/file-conventions/gio-directory"><code>.gio/</code></a></td><td>Generated: client bundles, stylesheets, caches, route types</td></tr>
        </tbody>
      </table>

      <h2 id="not-supported">Not supported</h2>
      <p>
        GioJS follows the App Router&apos;s names where it has the feature. These Next.js
        conventions have no GioJS equivalent; a file or folder with one of these names is an
        ordinary module or an ordinary URL segment:
      </p>
      <table>
        <thead><tr><th>Next.js</th><th>In GioJS</th></tr></thead>
        <tbody>
          <tr><td><code>global-error.tsx</code></td><td>Not supported. <code>app/error.tsx</code> covers every page; an error in the root layout itself gets the built-in error page.</td></tr>
          <tr><td><code>template.tsx</code></td><td>Not supported. Layouts keep their state across navigations; key a subtree yourself to reset it.</td></tr>
          <tr><td><code>default.tsx</code></td><td>Not supported (it belongs to parallel routes).</td></tr>
          <tr><td>Parallel routes (<code>@slot</code> folders)</td><td>Not supported. <code>@slot</code> is a literal URL segment.</td></tr>
          <tr><td>Intercepting routes (<code>(.)photo</code>, <code>(..)photo</code>, <code>(...)photo</code> folders)</td><td>Not supported. Such a folder is a literal URL segment. A folder named only <code>(.)</code> or <code>(..)</code> is a route group.</td></tr>
          <tr><td><code>forbidden.tsx</code>, <code>unauthorized.tsx</code></td><td>Not supported. Answer <code>401</code>/<code>403</code> with a <code>Response</code> from a <code>route.ts</code> or a page action, or redirect with a guard.</td></tr>
          <tr><td><code>opengraph-image.tsx</code>, <code>icon.png</code>, <code>apple-icon.png</code></td><td>Not supported. Use the <code>openGraph</code> and <code>icons</code> metadata fields with files from <code>public/</code>.</td></tr>
          <tr><td><code>instrumentation.ts</code></td><td>Not supported. Use a plugin&apos;s <code>onStartup</code> in <code>gio.config.ts</code>.</td></tr>
          <tr><td>A <code>src/</code> folder</td><td>Not supported. <code>app/</code> sits in the project root. <code>GIO_APP_DIR</code> can point at another folder, but <code>public/</code>, <code>gio.toml</code> and the other root files then belong next to that folder.</td></tr>
          <tr><td>Route segment config (<code>dynamic</code>, <code>runtime</code>, ...)</td><td>Different: see <a href="/docs/page-exports">Page Exports</a>.</td></tr>
        </tbody>
      </table>
    </>
  );
}
