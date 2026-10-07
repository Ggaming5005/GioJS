import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'notFound',
  description:
    'Stop rendering and answer 404 with the nearest not-found.tsx - from getServerSideProps, a component, an action or a route handler.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>notFound</h1>
      <p className="page-subtitle">
        Stop rendering and answer <code>404</code> with the nearest{' '}
        <code>not-found.tsx</code> - from <code>getServerSideProps</code>, a component, an
        action or a route handler.
      </p>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`import { notFound, type GetServerSideProps } from '@gio.js/core';

export const getServerSideProps = (async (ctx) => {
  const post = await db.posts.find(ctx.params.id);
  if (post === null) notFound();
  return { props: { post } };
}) satisfies GetServerSideProps<{ post: Post }, '/posts/:id'>;`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>notFound()</code> takes no arguments. Its return type is <code>never</code>:
        it always throws, so TypeScript narrows the value you checked after the call (above,{' '}
        <code>post</code> is a <code>Post</code> on the last line).
      </p>

      <h3 id="behavior">Behavior</h3>
      <p>What answers depends on where it is called:</p>
      <table>
        <thead><tr><th>Called from</th><th>Response</th></tr></thead>
        <tbody>
          <tr>
            <td><code>getServerSideProps</code>, or a page or layout while it renders</td>
            <td>
              <code>404</code> with the nearest <code>not-found.tsx</code> at or above the
              page&apos;s folder, inside that folder&apos;s layouts. Without one, the built-in
              404 page.
            </td>
          </tr>
          <tr>
            <td>A page <code>action</code></td>
            <td>The same <code>404</code> page.</td>
          </tr>
          <tr>
            <td>A <code>route.ts</code> handler</td>
            <td><code>404</code> with the JSON body <code>{'{"error":"Not Found"}'}</code>.</td>
          </tr>
        </tbody>
      </table>
      <p>
        A <code>404</code> is never cached, even on a page that exports{' '}
        <code>revalidate</code>. When a cached page starts answering <code>404</code> - its
        data was deleted - the background revalidation that sees it evicts the cached copy.
        Returning <code>{'{ notFound: true }'}</code> from <code>getServerSideProps</code>{' '}
        has the same effect as calling <code>notFound()</code>. When an action re-rendered
        the page with headers (a flash cookie) and <code>getServerSideProps</code> then calls{' '}
        <code>notFound()</code>, those headers are sent with the <code>404</code>.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-missing-record-in-a-route-handler">A missing record in a route handler</h3>
      <CodeBlock lang="ts" title="app/api/posts/[id]/route.ts" code={`import { notFound, type GioRequest } from '@gio.js/core';

export async function GET(req: GioRequest<'/api/posts/:id'>) {
  const post = await db.posts.find(req.params.id);
  if (post === null) notFound();   // 404 {"error":"Not Found"}
  return post;                     // 200, JSON
}`} />
      <h3 id="a-section-with-its-own-404-page">A section with its own 404 page</h3>
      <CodeBlock lang="text" code={`app/
  not-found.tsx         # unmatched URLs, and pages without a closer file
  shop/
    layout.tsx
    not-found.tsx       # notFound() in any /shop page, rendered inside shop/layout.tsx
    [id]/page.tsx`} />
      <CodeBlock lang="tsx" title="app/shop/not-found.tsx" code={`import { GioLink } from '@gio.js/react';

export default function ProductNotFound() {
  return (
    <main>
      <h1>That product is gone</h1>
      <GioLink href="/shop">Back to the shop</GioLink>
    </main>
  );
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>It works by throwing.</strong> A <code>try</code>/<code>catch</code> around
          the call swallows it: call it outside the <code>try</code>, or rethrow what you did
          not expect.
        </li>
        <li>
          <strong>Streaming.</strong> Called before a streamed page suspends, the answer is a
          real <code>404</code>. Inside a suspended part (under <code>loading.tsx</code> or a{' '}
          <code>{'<Suspense>'}</code>), the <code>200</code> is already sent: React finishes
          that part in the browser, where <code>notFound()</code> shows the nearest{' '}
          <code>error.tsx</code>.
        </li>
        <li>
          <strong>URLs that match no route</strong> always get <code>app/not-found.tsx</code> -
          they belong to no folder.
        </li>
        <li>
          <strong>Static export.</strong> <code>gio export</code> skips pages that call{' '}
          <code>notFound()</code> and writes no HTML for them.
        </li>
        <li>
          <strong>Safe in the browser.</strong> The module has no Node imports, so a component
          that calls it may ship in a client bundle.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/error-handling#not-found">Error Handling: Not found</a></li>
        <li><a href="/docs/file-conventions/not-found">not-found.tsx</a></li>
        <li><a href="/docs/fetching-data#not-found">Fetching Data: Not found</a></li>
        <li><a href="/docs/functions/redirect">redirect</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Introduced: <code>getServerSideProps</code>, render, page actions and{' '}
              <code>route.ts</code> handlers, with per-folder <code>not-found.tsx</code>.
            </>
          ),
        },
      ]} />
    </>
  );
}
