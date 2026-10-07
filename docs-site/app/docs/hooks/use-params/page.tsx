import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'useParams',
  description:
    "Read the dynamic segments of the current route, such as the id in /posts/:id, typed from your app's routes.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>useParams</h1>
      <p className="page-subtitle">
        Read the dynamic segments of the current route, such as the <code>id</code> in{' '}
        <code>/posts/:id</code>, typed from your app&apos;s routes.
      </p>
      <CodeBlock lang="tsx" title="app/posts/[id]/like-button.tsx" code={`import { useParams } from '@gio.js/react';

export function LikeButton() {
  const { id } = useParams<'/posts/:id'>(); // id: string
  return <button onClick={() => void like(id)}>Like</button>;
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="type-parameter">Type parameter</h3>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'T',
          type: "keyof GioJS.RegisteredRoutes | Record<string, string>",
          default: 'Record<string, string>',
          description: <>A route pattern (<code>&apos;/posts/:id&apos;</code>) types the result from the generated <code>.gio/routes.d.ts</code>; a shape (<code>{'{ id: string }'}</code>) is used as is.</>,
        },
      ]} />
      <p>The hook takes no arguments.</p>

      <h3 id="returns">Returns</h3>
      <p>An object with one string per dynamic segment of the matched route:</p>
      <table>
        <thead><tr><th>Route</th><th>URL</th><th><code>useParams()</code></th></tr></thead>
        <tbody>
          <tr><td><code>app/posts/[id]/page.tsx</code></td><td><code>/posts/42</code></td><td><code>{"{ id: '42' }"}</code></td></tr>
          <tr><td><code>app/[team]/[project]/page.tsx</code></td><td><code>/acme/site</code></td><td><code>{"{ team: 'acme', project: 'site' }"}</code></td></tr>
          <tr><td><code>app/docs/[...slug]/page.tsx</code></td><td><code>/docs/a/b</code></td><td><code>{"{ slug: 'a/b' }"}</code></td></tr>
          <tr><td><code>app/shop/[[...path]]/page.tsx</code></td><td><code>/shop</code></td><td><code>{"{ path: '' }"}</code></td></tr>
          <tr><td><code>app/about/page.tsx</code></td><td><code>/about</code></td><td><code>{'{}'}</code></td></tr>
        </tbody>
      </table>
      <p>
        A catch-all is one string with its <code>/</code> separators - split it yourself. An
        optional catch-all that matches no segment is <code>&apos;&apos;</code>; its type is
        optional (<code>{"useParams<'/shop/*path?'>()"}</code> gives{' '}
        <code>{'{ path?: string }'}</code>), so test it with <code>if (path)</code>.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The values are the router&apos;s match, the same ones <code>getServerSideProps</code>{' '}
          receives as <code>ctx.params</code>, on the server and in the browser alike.
        </li>
        <li>After a soft navigation, hydrated components read the new route&apos;s params.</li>
        <li>
          In a <code>not-found.tsx</code> or <code>error.tsx</code> page and its layouts, it
          returns the params of the route that was not found or failed - <code>{'{}'}</code> for
          a URL no route matches.
        </li>
        <li>Outside a tree GioJS rendered (a unit test), it returns <code>{'{}'}</code>.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="breadcrumbs-from-a-catch-all-route">Breadcrumbs from a catch-all route</h3>
      <CodeBlock lang="tsx" title="app/docs/[...slug]/breadcrumbs.tsx" code={`import { GioLink, useParams } from '@gio.js/react';

export function Breadcrumbs() {
  const { slug } = useParams<'/docs/*slug'>();
  const parts = slug.split('/');
  return (
    <ol>
      {parts.map((part, i) => (
        <li key={i}>
          <GioLink href={'/docs/' + parts.slice(0, i + 1).join('/')}>{decodeURIComponent(part)}</GioLink>
        </li>
      ))}
    </ol>
  );
}`} />

      <h3 id="a-params-shape-without-typed-routes">A params shape without typed routes</h3>
      <CodeBlock lang="tsx" code={`const { team, project } = useParams<{ team: string; project: string }>();`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Values are not decoded: <code>/posts/caf%C3%A9</code> gives{' '}
          <code>&apos;caf%C3%A9&apos;</code> (unreserved characters such as <code>%61</code> are
          already decoded by the server&apos;s path canonicalization). Use{' '}
          <code>decodeURIComponent</code> to show them.
        </li>
        <li>
          The pattern names come from the URL shape, so route groups never appear in them:{' '}
          <code>app/(shop)/products/[id]</code> is <code>&apos;/products/:id&apos;</code>.
        </li>
        <li>
          Patterns autocomplete once <code>.gio/routes.d.ts</code> exists (written at every
          server start) and is in your <code>tsconfig.json</code> <code>include</code>. Without
          it, a pattern is a type error: pass a shape such as <code>{'{ id: string }'}</code>.
        </li>
        <li>
          In the server-only root layout the value is that of the page loaded in full: soft
          navigations do not re-render it.
        </li>
        <li>
          A page also receives the params as a prop (<code>{"PageProps<'/posts/:id'>"}</code>)
          when it has no <code>getServerSideProps</code>; the hook saves passing them down.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/file-conventions/dynamic-routes">Dynamic routes</a> - <code>[id]</code>, <code>[...slug]</code> and <code>[[...slug]]</code>.</li>
        <li><a href="/docs/functions/href"><code>href</code></a> - build a URL from a pattern and params.</li>
        <li><a href="/docs/typescript">TypeScript</a> - typed routes.</li>
        <li><a href="/docs/hooks/use-pathname"><code>usePathname</code></a>, <a href="/docs/hooks/use-search-params"><code>useSearchParams</code></a>.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: <>Introduced, typed by <code>GioJS.RegisteredRoutes</code>.</> }]} />
    </>
  );
}
