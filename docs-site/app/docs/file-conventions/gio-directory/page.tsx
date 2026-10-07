import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: '.gio/',
  description:
    'The working directory GioJS writes in the project root: client bundles, stylesheets, caches, fonts and the generated route types.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>.gio/</h1>
      <p className="page-subtitle">
        The working directory GioJS writes in the project root: client bundles, stylesheets,
        caches, fonts and the generated route types.
      </p>
      <CodeBlock lang="text" code={`.gio/
  build/
    manifest.json        what the last build produced
    entries/             generated hydration entry files
    css-entries/         generated stylesheet entry files
    static/chunks/       client bundles        -> /_next/static/chunks/
    static/css/          route stylesheets     -> /_next/static/css/
  cache/
    pages/               the page cache's disk tier
    images/              optimized images
  fonts/                 [[fonts]] files and fonts.css -> /_gio/fonts/
  routes.d.ts            route types
  css-modules.d.ts       types for CSS imports
  ipc-<id>.sock          worker sockets (Unix)`} />

      <h2 id="reference">Reference</h2>
      <table>
        <thead><tr><th>Path</th><th>Written by</th><th>Override</th></tr></thead>
        <tbody>
          <tr>
            <td><code>build/</code></td>
            <td>The worker at every start (in a pool, the first worker; the others reuse it)</td>
            <td><code>GIO_STATIC_DIR</code> changes the directory the server serves <code>/_next/static/</code> from (default <code>.gio/build/static</code>)</td>
          </tr>
          <tr>
            <td><code>cache/pages/</code></td>
            <td>The server, for every cached page</td>
            <td><a href="/docs/configuration/cache"><code>[cache] disk_path</code></a>, <code>GIO_CACHE_DIR</code></td>
          </tr>
          <tr>
            <td><code>cache/images/</code></td>
            <td>The image optimizer (<code>/_gio/image</code>)</td>
            <td><code>GIO_IMAGE_CACHE_DIR</code></td>
          </tr>
          <tr>
            <td><code>fonts/</code></td>
            <td>The server at every start, from <code>[[fonts]]</code></td>
            <td><code>GIO_FONTS_DIR</code></td>
          </tr>
          <tr>
            <td><code>routes.d.ts</code>, <code>css-modules.d.ts</code></td>
            <td>The worker at every start, and <code>gio typegen</code></td>
            <td>-</td>
          </tr>
          <tr>
            <td><code>ipc-*.sock</code>, <code>ws-*.sock</code></td>
            <td>The server, per instance (Unix only; Windows uses named pipes)</td>
            <td><code>GIO_SOCKET_PATH</code>, <code>GIO_WS_SOCKET_PATH</code></td>
          </tr>
          <tr>
            <td><code>export/</code></td>
            <td><code>gio export</code>, for its generated entry files</td>
            <td>-</td>
          </tr>
        </tbody>
      </table>
      <p>
        The directory is created in the project root (the parent of <code>app/</code>). The
        socket files are the exception: they go in the <code>.gio/</code> of the directory the
        server was started in, normally the same one.
      </p>

      <h3 id="routes-d-ts">routes.d.ts</h3>
      <p>
        Declares every page and <code>route.ts</code> pattern with its params in the global{' '}
        <code>GioJS.RegisteredRoutes</code> interface. <code>href()</code>,{' '}
        <code>useParams()</code>, <code>PageProps</code>, <code>GetServerSideProps</code>,{' '}
        <code>RouteHandler</code> and the other route-typed helpers read it, so a pattern
        that is not one of your routes fails <code>tsc</code>:
      </p>
      <CodeBlock lang="ts" title=".gio/routes.d.ts" code={`/// <reference path="./css-modules.d.ts" />
declare global {
  namespace GioJS {
    interface RegisteredRoutes {
      '/': Record<string, never>;
      '/blog/:slug': { slug: string };
      '/docs/*slug': { slug: string };
      '/shop/*path?': { path?: string };
    }
  }
}
export {};`} />

      <h3 id="css-modules-d-ts">css-modules.d.ts</h3>
      <p>
        Types <code>import styles from &apos;./x.module.css&apos;</code> as a map of class
        names to strings, and lets plain <code>.css</code> imports through.{' '}
        <code>routes.d.ts</code> references it, so including one includes both.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="tsconfig-and-gitignore">tsconfig.json and .gitignore</h3>
      <CodeBlock lang="json" title="tsconfig.json" code={`{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["app", "components", "lib", ".gio/routes.d.ts"]
}`} />
      <CodeBlock lang="text" title=".gitignore" code={`.gio/`} />
      <p>
        Projects made with <code>create-giojs</code> have both already.
      </p>

      <h3 id="types-in-ci">Types in CI</h3>
      <p>
        On a fresh checkout the type files do not exist until the server has started once.
        Write them without a server before <code>tsc</code>:
      </p>
      <PmTabs command={`npx gio typegen
npx tsc --noEmit`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Everything in <code>.gio/</code> is regenerated, so never commit or edit it. Deleting
          it while the server is stopped is safe; you lose the page and image caches.
        </li>
        <li>
          The dev watcher ignores <code>.gio/</code>, so the files GioJS writes never restart
          the worker.
        </li>
        <li>
          The page cache directory may not be, contain or sit inside <code>app/</code> or{' '}
          <code>public/</code>: startup refuses such a <code>[cache] disk_path</code>.
        </li>
        <li>
          Two servers started from the same project share <code>.gio/</code>: the build, the
          caches and the type files. Give each its own <code>GIO_CACHE_DIR</code> if they must
          not share cached pages.
        </li>
        <li>
          A standalone build folder has its own layout (<code>static/</code>,{' '}
          <code>worker.js</code>, a <code>.gio/manifest.json</code>); see{' '}
          <a href="/docs/standalone">Standalone</a>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/typescript">TypeScript</a> - typed routes.</li>
        <li><a href="/docs/cli/typegen"><code>gio typegen</code></a>, <a href="/docs/cli/routes"><code>gio routes</code></a></li>
        <li><a href="/docs/caching-layers">Caching Layers</a>, <a href="/docs/env-vars">Environment variables</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>routes.d.ts</code> fills the global <code>GioJS.RegisteredRoutes</code> registry; <code>css-modules.d.ts</code>; route stylesheets in <code>build/static/css/</code>; <code>gio typegen</code> writes the types without a server.</> },
        { version: 'v0.1.0-beta.6', changes: <><code>routes.d.ts</code> is generated at every start.</> },
        { version: 'v0.1.0-beta.5', changes: <>Client bundles are built into <code>build/static/chunks/</code>.</> },
      ]} />
    </>
  );
}
