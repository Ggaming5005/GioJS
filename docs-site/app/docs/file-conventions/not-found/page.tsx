import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'not-found.tsx',
  description:
    'The 404 page for a folder and everything below it, shown when a page calls notFound(). The one in app/ also answers unmatched URLs.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>not-found.tsx</h1>
      <p className="page-subtitle">
        The 404 page for a folder and everything below it, shown when a page calls{' '}
        <code>notFound()</code>. The one in <code>app/</code> also answers unmatched URLs.
      </p>
      <CodeBlock lang="tsx" title="app/not-found.tsx" code={`import React from 'react';
import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <p>This page does not exist or was moved.</p>
      <a href="/">Go home</a>
    </main>
  );
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>not-found.tsx</code>, <code>not-found.jsx</code> or <code>not-found.js</code>,
        in <code>app/</code> or any folder below it (route groups and dynamic folders
        included, private folders never).
      </p>

      <h3 id="props">Props</h3>
      <p>
        None (<code>NotFoundPageProps</code> is an empty object). The navigation hooks still
        work while it renders: <a href="/docs/hooks/use-pathname"><code>usePathname()</code></a>{' '}
        gives the requested path and <a href="/docs/hooks/use-params"><code>useParams()</code></a>{' '}
        the params of the route that called <code>notFound()</code> (<code>{'{}'}</code> for an
        unmatched URL).
      </p>

      <h3 id="module-exports">Module exports</h3>
      <p>
        <code>default</code> (required), and optionally{' '}
        <a href="/docs/page-exports/metadata"><code>metadata</code></a> or{' '}
        <a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a>, which
        receives the failed route&apos;s params.
      </p>

      <h3 id="when-it-is-shown">When it is shown</h3>
      <table>
        <thead><tr><th>Cause</th><th>Which not-found.tsx</th></tr></thead>
        <tbody>
          <tr>
            <td><a href="/docs/functions/not-found"><code>notFound()</code></a> in <code>getServerSideProps</code>, a page action or during the render</td>
            <td>The nearest one at or above the page&apos;s folder</td>
          </tr>
          <tr>
            <td><code>{'return { notFound: true }'}</code> from <code>getServerSideProps</code></td>
            <td>The same</td>
          </tr>
          <tr>
            <td>A URL no page, <code>route.ts</code> or <code>public/</code> file answers</td>
            <td><code>app/not-found.tsx</code> only: an unmatched URL belongs to no folder</td>
          </tr>
        </tbody>
      </table>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The status is <code>404</code> and the response is never cached, even on a page
          with <code>revalidate</code>: a 404 can depend on what <code>getServerSideProps</code>{' '}
          read, and a cached one would outlive the content appearing.
        </li>
        <li>
          It renders inside the layouts of its own folder, never those of the page that
          called <code>notFound()</code>. If those layouts throw, the{' '}
          <code>not-found.tsx</code> of the folder above is tried. With none left, the server
          answers with a built-in 404 page.
        </li>
        <li>
          It is server-only HTML: it does not hydrate, so keep it free of state and effects.
          Links in it are plain links.
        </li>
        <li>
          In a <code>route.ts</code>, <code>notFound()</code> answers a JSON{' '}
          <code>{'{"error":"Not Found"}'}</code> with status <code>404</code> instead.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-404-for-one-section">A 404 for one section</h3>
      <CodeBlock lang="tsx" title="app/blog/[slug]/page.tsx" code={`import React from 'react';
import { notFound } from '@gio.js/core';
import type { GetServerSideProps, InferPageProps } from '@gio.js/core';
import { findPost } from '../../../lib/posts';

export const getServerSideProps: GetServerSideProps<{ title: string }, '/blog/:slug'> = async (ctx) => {
  const post = await findPost(ctx.params.slug);
  if (post === undefined) notFound();
  return { props: { title: post.title } };
};

export default function Post({ title }: InferPageProps<typeof getServerSideProps>) {
  return <h1>{title}</h1>;
}`} />
      <CodeBlock lang="tsx" title="app/blog/not-found.tsx" code={`import React from 'react';
import { usePathname } from '@gio.js/react';

export default function PostNotFound() {
  const pathname = usePathname();
  return (
    <section>
      <h1>No post at {pathname}</h1>
      <a href="/blog">All posts</a>
    </section>
  );
}`} />
      <p>
        <code>/blog/missing</code> answers <code>404</code> with the blog&apos;s own message,
        inside <code>app/blog/layout.tsx</code> if there is one. <code>/nowhere</code> still
        gets <code>app/not-found.tsx</code>.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>gio export</code> writes <code>app/not-found.tsx</code> to{' '}
          <code>out/404.html</code>, which static hosts serve for unknown paths. Without one it
          writes the built-in 404 page there.
        </li>
        <li>
          A <code>public/</code> file wins over a page at the same path, so it never reaches the
          404 either.
        </li>
        <li>
          If a streamed page calls <code>notFound()</code> after it has suspended inside a{' '}
          <a href="/docs/file-conventions/loading">loading.tsx</a> boundary, the{' '}
          <code>200</code> is already sent; the browser then shows the nearest{' '}
          <a href="/docs/file-conventions/error">error.tsx</a>. Call it before suspending.
        </li>
        <li>
          On client navigation the 404 page renders in place like any GioJS page.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/error-handling#not-found">Error Handling: Not found</a> - the guide.</li>
        <li><a href="/docs/functions/not-found"><code>notFound</code></a></li>
        <li><a href="/docs/file-conventions/error">error.tsx</a>, <a href="/docs/file-conventions/layout">layout.tsx</a></li>
        <li><a href="/docs/static-export">Static Export</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Works in any folder: <code>notFound()</code> and <code>{'{ notFound: true }'}</code> use the nearest one. <code>metadata</code> exports. 404s are never cached.</> },
        { version: 'v0.1.0-beta.5', changes: <>Introduced for <code>app/not-found.tsx</code>: unmatched URLs render it with status <code>404</code>.</> },
      ]} />
    </>
  );
}
