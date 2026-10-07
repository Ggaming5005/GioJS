import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio routes',
  description:
    'List every URL a GioJS app serves - pages, route handlers, WebSockets and metadata ' +
    'routes - discovered exactly as the server does, without starting it.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio routes</h1>
      <p className="page-subtitle">
        List every URL a GioJS app serves - pages, route handlers, WebSockets and metadata
        routes - discovered exactly as the server does, without starting it.
      </p>
      <PmTabs command={`npx gio routes`} />
      <CodeBlock lang="bash" code={`gio routes [--json]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        {
          name: '--json',
          type: 'boolean',
          default: 'false',
          description: <>Print <code>{'{ "routes": [...] }'}</code> instead of the table (see <a href="#json-output">JSON output</a>).</>,
        },
        {
          name: '-h, --help',
          type: 'boolean',
          description: <>Print the help and exit with <code>0</code>.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        <code>gio routes</code> runs the route discovery of <code>@gio.js/core</code> through{' '}
        <code>tsx</code>, so it needs no server binary. It loads the project&apos;s{' '}
        <code>.env</code> files first (development files when{' '}
        <code>NODE_ENV=development</code>, production otherwise), then imports every{' '}
        <code>route.ts</code> to read its exports, as the server does at startup. Page modules
        are not imported.
      </p>
      <CodeBlock lang="text" code={`Route            Type            File                            Wrapped by
/                page            app/(site)/page.tsx             layout app/ > app/(site)/  error app/  not-found app/
/about           page            app/(site)/about/page.tsx       layout app/ > app/(site)/  error app/  not-found app/
/api/notes       route GET,POST  app/api/notes/route.ts
/posts/:id       page            app/(site)/posts/[id]/page.tsx  layout app/ > app/(site)/  loading app/(site)/posts/[id]/  error app/  not-found app/
/robots.txt      metadata        app/robots.ts
/ws/rooms/:room  websocket       app/ws/rooms/[room]/route.ts

6 routes, 2 dynamic   (:param one segment, *param catch-all, *param? optional catch-all)`} />
      <table>
        <thead>
          <tr><th>Type</th><th>What it is</th></tr>
        </thead>
        <tbody>
          <tr><td><code>page</code></td><td>A <code>page.tsx</code>. <strong>Wrapped by</strong> lists its layouts, outermost first, and the nearest <code>loading</code>, <code>error</code> and <code>not-found</code> file, by folder.</td></tr>
          <tr><td><code>route GET,POST</code></td><td>A <code>route.ts</code> with the HTTP methods it exports.</td></tr>
          <tr><td><code>route (failed to load)</code></td><td>A <code>route.ts</code> that threw when imported. The reason is printed below the table.</td></tr>
          <tr><td><code>websocket</code></td><td>A <code>route.ts</code> that exports <code>wsHandler</code>. One that also exports methods gets a <code>route</code> row too.</td></tr>
          <tr><td><code>metadata</code></td><td><code>app/sitemap.*</code>, <code>app/robots.*</code> or <code>app/manifest.*</code>, at <code>/sitemap.xml</code>, <code>/robots.txt</code> and <code>/manifest.webmanifest</code>.</td></tr>
        </tbody>
      </table>
      <p>
        Patterns use the router&apos;s syntax: <code>:id</code> for a <code>[id]</code>{' '}
        folder, <code>*slug</code> for <code>[...slug]</code> and <code>*slug?</code> for{' '}
        <code>[[...slug]]</code>. Route groups (<code>(site)</code>) do not appear in the URL.
        Static segments sort before dynamic ones, the way matching prefers them.
      </p>

      <h3 id="json-output">JSON output</h3>
      <p>Each entry of <code>routes</code>:</p>
      <PropsTable kind="Field" rows={[
        { name: 'pattern', type: 'string', description: <>The URL pattern, <code>/posts/:id</code>.</> },
        { name: 'kind', type: 'string', description: <><code>page</code>, <code>route</code>, <code>websocket</code> or <code>metadata</code>.</> },
        { name: 'methods', type: 'string[]', description: <><code>[&quot;GET&quot;]</code> for pages and metadata routes, the exported methods for a route, <code>[]</code> for a WebSocket handler or a route that failed to load.</> },
        { name: 'file', type: 'string', description: 'Project-relative path, with / separators.' },
        { name: 'params', type: 'object[]', description: <>The dynamic segments, in order: <code>{'{ name, catchAll, optional }'}</code>.</> },
        { name: 'layouts', type: 'string[]', description: 'Pages: the layout files, outermost first. Empty otherwise.' },
        { name: 'loading', type: 'string | null', description: <>Pages: the nearest <code>loading</code> file.</> },
        { name: 'error', type: 'string | null', description: <>Pages: the nearest <code>error</code> file.</> },
        { name: 'notFound', type: 'string | null', description: <>Pages: the nearest <code>not-found</code> file.</> },
        { name: 'loadError', type: 'string', description: <>Only on a <code>route.ts</code> that failed to import: the error message.</> },
      ]} />
      <CodeBlock lang="json" code={`{
  "routes": [
    {
      "pattern": "/posts/:id",
      "kind": "page",
      "methods": ["GET"],
      "file": "app/(site)/posts/[id]/page.tsx",
      "params": [{ "name": "id", "catchAll": false, "optional": false }],
      "layouts": ["app/layout.tsx", "app/(site)/layout.tsx"],
      "loading": "app/(site)/posts/[id]/loading.tsx",
      "error": "app/error.tsx",
      "notFound": "app/not-found.tsx"
    }
  ]
}`} />
      <p>
        Anything a <code>route.ts</code> prints while it is imported goes to stderr, so the
        JSON on stdout stays parseable.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-route-that-fails-to-load">A route that fails to load</h3>
      <CodeBlock lang="text" code={`$ npx gio routes
Route       Type                    File                            Wrapped by
/           page                    app/(site)/page.tsx             layout app/ > app/(site)/  error app/  not-found app/
/logout     route (failed to load)  app/logout/route.ts
...

5 routes, 1 dynamic   (:param one segment, *param catch-all, *param? optional catch-all)
! app/logout/route.ts failed to load - the server answers 500 for its URL (and closes WebSocket connections with 1011) until it is fixed: GIO_SESSION_SECRET is not set. Sessions need a secret of at least 32 bytes in production. ...`} />
      <p>
        The server starts anyway and answers that URL with <code>500</code>. Here the module
        creates its session storage at import time and production needs a secret:{' '}
        <code>NODE_ENV=development npx gio routes</code> lists it with the development{' '}
        <code>.env</code> files.
      </p>

      <h3 id="list-the-api-routes-in-a-script">List the API routes in a script</h3>
      <CodeBlock lang="bash" code={`npx gio routes --json | node -e '
  const { routes } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  for (const r of routes) if (r.kind === "route") console.log(r.methods.join(","), r.pattern);
'`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Route conflicts (two files claiming one URL) fail the command with the same error
          the server would stop with, and exit code <code>1</code>.
        </li>
        <li>
          There must be an <code>app/</code> directory: without one it exits with{' '}
          <code>1</code> and says to run from the project root or set{' '}
          <code>GIO_APP_DIR</code>.
        </li>
        <li>
          A <code>route.ts</code> that fails to import is listed, not fatal: the exit code
          stays <code>0</code>.
        </li>
        <li>
          Rewrites, redirects and guards from <code>gio.toml</code> or{' '}
          <code>middleware.ts</code> are not routes and are not listed.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/cli/typegen"><code>gio typegen</code></a> - the same discovery, written as types</li>
        <li><a href="/docs/layouts-and-pages">Layouts &amp; Pages</a> and <a href="/docs/route-handlers">Route Handlers</a></li>
        <li><a href="/docs/project-structure">Project Structure</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
