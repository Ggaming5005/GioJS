import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'getStaticPaths',
  description: 'List the params a dynamic page is exported for when gio export writes a static site.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>getStaticPaths</h1>
      <p className="page-subtitle">
        List the params a dynamic page is exported for when <code>gio export</code> writes a
        static site.
      </p>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`import type { GetStaticPaths } from '@gio.js/core';
import { db } from '../../../lib/db.server.ts';

export const getStaticPaths: GetStaticPaths<'/posts/:id'> = async () => {
  const ids = await db.posts.allIds();
  return { paths: ids.map((id) => ({ params: { id } })) };
};`} />
      <p>
        A static host has no server to render <code>/posts/42</code> on demand, so{' '}
        <code>gio export</code> needs the list up front. It calls{' '}
        <code>getStaticPaths</code> once per dynamic page and renders one HTML file per entry.
        The GioJS server never calls it: there, any params render on demand.
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="returns">Returns</h3>
      <p>
        <code>getStaticPaths</code> takes no arguments and returns (or resolves to){' '}
        <code>{'{ paths }'}</code>:
      </p>
      <PropsTable kind="Field" rows={[
        { name: 'paths', type: 'Array<{ params }>', required: true, description: 'One entry per page to write.' },
        { name: 'paths[].params', type: 'StaticParamsOf<Route>', required: true, description: <>A value for every dynamic segment of the route. <code>[id]</code> takes a string. A catch-all (<code>[...slug]</code>) takes the path below it as one string (<code>&apos;guides/setup&apos;</code>) or as its segments (<code>[&apos;guides&apos;, &apos;setup&apos;]</code>). An optional catch-all (<code>[[...slug]]</code>) may also be left out, <code>&apos;&apos;</code> or <code>[]</code>, for the bare parent path.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Each entry becomes a URL path, and the page renders for it as on the server -{' '}
          <code>getServerSideProps</code> and <code>generateMetadata</code> included - with the
          params filled in and no query, headers or cookies. <code>/posts/1</code> is written to{' '}
          <code>out/posts/1/index.html</code>.
        </li>
        <li>
          An invalid entry is skipped with a reason, and the rest are exported:
          <ul>
            <li><code>getStaticPaths entry is missing param &quot;id&quot;</code></li>
            <li><code>param &quot;id&quot; is a single segment but &quot;a/b&quot; contains &apos;/&apos;</code></li>
            <li><code>param &quot;slug&quot; has an empty, relative or backslashed segment: &quot;../x&quot;</code> - nothing is ever written outside <code>out/</code></li>
          </ul>
        </li>
        <li>
          A rendered entry that answers <code>404</code> (<code>notFound()</code>) is skipped
          (<code>notFound() - nothing written</code>), and so is a redirect (
          <code>redirect (303) - server only</code>) or a render error (with its error
          reference).
        </li>
        <li>
          A dynamic page without <code>getStaticPaths</code> is skipped:{' '}
          <code>dynamic route without getStaticPaths()</code>.
        </li>
        <li>
          If <code>getStaticPaths</code> throws or rejects, <code>gio export</code> stops with
          the error and exits with code <code>1</code>.
        </li>
      </ul>

      <h3 id="types">Types</h3>
      <p>
        <code>{'GetStaticPaths<Route>'}</code> types the function and checks every entry
        against the route&apos;s params; <code>Route</code> is a pattern of your app (
        <code>{"'/posts/:id'"}</code>, <code>{"'/docs/*slug'"}</code>,{' '}
        <code>{"'/shop/*path?'"}</code>) or a params shape. <code>{'StaticPathsResult<Route>'}</code>{' '}
        types the result alone.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-catch-all-route">A catch-all route</h3>
      <CodeBlock lang="tsx" title="app/docs/[[...slug]]/page.tsx" code={`import type { GetStaticPaths, PageProps } from '@gio.js/core';

export default function Doc({ params }: PageProps<'/docs/*slug?'>) {
  return <h1>{params.slug === '' ? 'Docs' : params.slug}</h1>;
}

export const getStaticPaths: GetStaticPaths<'/docs/*slug?'> = () => ({
  paths: [
    { params: { slug: [] } },                    // /docs
    { params: { slug: 'intro' } },               // /docs/intro
    { params: { slug: ['guides', 'setup'] } },   // /docs/guides/setup
  ],
});`} />
      <p>Run the export; its summary lists every page written and every entry skipped:</p>
      <PmTabs command={`npx gio export`} pnpm={`pnpm gio export`} />
      <CodeBlock lang="text" code={`[giojs] rendered 3 page(s):
   ✓ /docs
   ✓ /docs/guides/setup
   ✓ /docs/intro`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          There is no <code>fallback</code>: a path that was not listed does not exist on the
          static host, which serves the exported <code>404.html</code>.
        </li>
        <li>
          Pages with no dynamic segment need no <code>getStaticPaths</code>; they are exported
          once.
        </li>
        <li>
          The data is frozen at export time: re-run <code>gio export</code> to publish new
          posts.
        </li>
        <li>
          <code>getStaticPaths</code> and the modules only it imports are left out of the
          browser bundle.
        </li>
        <li>
          Exported pages carry their <code>getServerSideProps</code> props as JSON for
          hydration, so never return secrets from it.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/static-export#dynamic-routes">Static Export</a> - the guide</li>
        <li><a href="/docs/cli/export"><code>gio export</code></a></li>
        <li><a href="/docs/file-conventions/dynamic-routes">Dynamic routes</a></li>
        <li><a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Catch-all and optional catch-all routes, with strings or segment arrays; invalid entries are skipped with a reason; nothing is written outside <code>out/</code>; typed with <code>GetStaticPaths</code>.</> },
        { version: 'v0.1.0-beta.2', changes: <>Introduced, with <code>gio export</code>.</> },
      ]} />
    </>
  );
}

