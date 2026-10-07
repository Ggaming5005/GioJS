import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'page.tsx',
  description:
    'The file that makes a folder under app/ a route. Its default export is the React component GioJS renders for that URL.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>page.tsx</h1>
      <p className="page-subtitle">
        The file that makes a folder under <code>app/</code> a route. Its default export is the
        React component GioJS renders for that URL.
      </p>
      <CodeBlock lang="tsx" title="app/blog/[slug]/page.tsx" code={`import React from 'react';
import type { PageProps } from '@gio.js/core';

export default function BlogPost({ params, searchParams }: PageProps<'/blog/:slug'>) {
  return (
    <article>
      <h1>{params.slug}</h1>
      {searchParams.preview === '1' && <p>Preview mode</p>}
    </article>
  );
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        A <code>page</code> file may sit in <code>app/</code> or any folder below it, except
        inside a <a href="/docs/file-conventions/private-folders">private folder</a>. The folder
        path is the URL: <code>app/page.tsx</code> answers <code>/</code>,{' '}
        <code>app/blog/[slug]/page.tsx</code> answers <code>/blog/:slug</code>, and{' '}
        <a href="/docs/file-conventions/route-groups">route groups</a> add nothing to it.
      </p>
      <table>
        <thead><tr><th>Extension</th><th>Precedence</th></tr></thead>
        <tbody>
          <tr><td><code>page.tsx</code></td><td>Used first</td></tr>
          <tr><td><code>page.jsx</code></td><td>Used when there is no <code>page.tsx</code></td></tr>
          <tr><td><code>page.js</code></td><td>Used when there is neither</td></tr>
        </tbody>
      </table>
      <p>
        A folder with several of them uses the first one and ignores the others, so a stray
        compiled <code>page.js</code> next to <code>page.tsx</code> never changes what renders.{' '}
        <code>page.ts</code> is not a page: pages contain JSX.
      </p>

      <h3 id="props">Props</h3>
      <p>
        A page <strong>without</strong> <code>getServerSideProps</code> renders with these
        props:
      </p>
      <PropsTable rows={[
        {
          name: 'params',
          type: 'Record<string, string>',
          description: (
            <>
              The <a href="/docs/file-conventions/dynamic-routes">dynamic segments</a> of the
              URL, by folder name: <code>{'{ slug: \'hello\' }'}</code>. A catch-all is one
              string with its <code>/</code> separators (<code>&apos;a/b&apos;</code>), an empty
              optional catch-all is <code>&apos;&apos;</code>, and a static route gets{' '}
              <code>{'{}'}</code>.
            </>
          ),
        },
        {
          name: 'searchParams',
          type: 'Record<string, string>',
          description: (
            <>
              The query string, decoded (<code>+</code> becomes a space). One value per name:
              for <code>?tag=a&amp;tag=b</code> the last one wins.
            </>
          ),
        },
        {
          name: 'actionData',
          type: 'unknown',
          description: (
            <>
              Only on the render that answers a <code>POST</code> to a page with an{' '}
              <a href="/docs/page-exports/action"><code>action</code></a>: what the action
              returned.
            </>
          ),
        },
      ]} />
      <p>
        A page <strong>with</strong> <code>getServerSideProps</code> renders with exactly the
        props it returned, plus <code>actionData</code> after an action. Type them with{' '}
        <code>InferPageProps&lt;typeof getServerSideProps&gt;</code>; type the plain props with{' '}
        <code>PageProps&lt;&apos;/blog/:slug&apos;&gt;</code>. Both come from{' '}
        <code>@gio.js/core</code>, and the route pattern is checked against your routes (see{' '}
        <a href="/docs/file-conventions/gio-directory">.gio/</a>).
      </p>

      <h3 id="module-exports">Module exports</h3>
      <p>The default export is required. Everything else is optional:</p>
      <table>
        <thead><tr><th>Export</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>default</code></td><td>The page component.</td></tr>
          <tr><td><a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a></td><td>Loads the props on the server for every render; can redirect or answer 404.</td></tr>
          <tr><td><a href="/docs/page-exports/action"><code>action</code></a></td><td>Handles <code>POST</code> requests to the page&apos;s URL (forms).</td></tr>
          <tr><td><a href="/docs/page-exports/metadata"><code>metadata</code></a> / <a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a></td><td>Title, description and the other <code>&lt;head&gt;</code> tags.</td></tr>
          <tr><td><a href="/docs/page-exports/revalidate"><code>revalidate</code></a></td><td>Caches the rendered page for that many seconds.</td></tr>
          <tr><td><a href="/docs/page-exports/tags"><code>tags</code></a></td><td>Cache tags for <code>revalidateTag()</code>.</td></tr>
          <tr><td><a href="/docs/page-exports/shell"><code>shell</code></a></td><td><code>&apos;cache&apos;</code> turns on partial prerendering.</td></tr>
          <tr><td><a href="/docs/page-exports/get-static-paths"><code>getStaticPaths</code></a></td><td>The params <code>gio export</code> writes for a dynamic route.</td></tr>
        </tbody>
      </table>
      <p>
        All page exports are listed on <a href="/docs/page-exports">Page Exports</a>.{' '}
        <code>getServerSideProps</code> and <code>getStaticPaths</code> are removed from the
        browser bundle, together with the imports only they use.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Methods.</strong> A page answers <code>GET</code> and <code>HEAD</code>, and{' '}
          <code>POST</code> when it exports <code>action</code>. Any other method gets{' '}
          <code>405</code> with a JSON body <code>{'{"error":"Method Not Allowed"}'}</code> and an{' '}
          <code>Allow</code> header (<code>GET, HEAD</code>, plus <code>POST</code> with an
          action, plus the methods of a <code>route.ts</code> in the same folder).
        </li>
        <li>
          <strong>Rendering.</strong> The page renders on the server inside its{' '}
          <a href="/docs/file-conventions/layout">layouts</a>, then hydrates in the browser
          from a per-route bundle. Its props travel in the HTML as JSON (
          <code>&lt;script id=&quot;__gio_props&quot;&gt;</code>), so they must be
          JSON-serializable: a page whose props are not renders without hydration, with a
          warning in the log.
        </li>
        <li>
          <strong>Status.</strong> <code>200</code> with{' '}
          <code>Content-Type: text/html; charset=utf-8</code>. <code>notFound()</code> answers{' '}
          <code>404</code> with the nearest{' '}
          <a href="/docs/file-conventions/not-found">not-found.tsx</a>, and a thrown error{' '}
          <code>500</code> with the nearest <a href="/docs/file-conventions/error">error.tsx</a>.
        </li>
        <li>
          <strong>Caching.</strong> Without <code>revalidate</code> every request renders and
          the response is <code>Cache-Control: private, no-cache</code>. See{' '}
          <a href="/docs/caching">Caching &amp; Revalidating</a>.
        </li>
        <li>
          <strong>Navigation.</strong> On a soft navigation the page remounts whenever the path
          changes (<code>/posts/1</code> to <code>/posts/2</code>), so its state starts fresh;
          a query-only change keeps it mounted.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="read-params-and-the-query">Read params and the query string</h3>
      <CodeBlock lang="tsx" title="app/shop/[category]/page.tsx" code={`import React from 'react';
import type { PageProps } from '@gio.js/core';

export default function Category({ params, searchParams }: PageProps<'/shop/:category'>) {
  const sort = searchParams.sort ?? 'popular';
  return (
    <h1>
      {params.category} - sorted by {sort}
    </h1>
  );
}`} />
      <p>
        <code>/shop/shoes?sort=price</code> renders &quot;shoes - sorted by price&quot;.
      </p>

      <h3 id="load-data-on-the-server">Load data on the server</h3>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`import React from 'react';
import { notFound } from '@gio.js/core';
import type { GetServerSideProps, InferPageProps } from '@gio.js/core';
import { getPost } from '../../../lib/posts';

export const getServerSideProps: GetServerSideProps<{ title: string; body: string }, '/posts/:id'> =
  async (ctx) => {
    const post = await getPost(ctx.params.id);
    if (post === null) notFound();
    return { props: { title: post.title, body: post.body } };
  };

export default function Post({ title, body }: InferPageProps<typeof getServerSideProps>) {
  return (
    <article>
      <h1>{title}</h1>
      <p>{body}</p>
    </article>
  );
}`} />

      <h3 id="a-javascript-page">A JavaScript page</h3>
      <CodeBlock lang="jsx" title="app/about/page.jsx" code={`/** @param {import('@gio.js/core').PageProps<'/about'>} props */
export default function About({ searchParams }) {
  return <h1>About{searchParams.ref ? \` (from \${searchParams.ref})\` : ''}</h1>;
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Only the <code>page</code> file (and the other special names on{' '}
          <a href="/docs/file-conventions">File Conventions</a>) is routed. Components,
          styles and tests can live next to it in the same folder without becoming URLs.
        </li>
        <li>
          A page is not a React Server Component. It renders on the server and again in the
          browser, so it cannot be an <code>async</code> function and cannot read files or
          secrets itself: load data in <code>getServerSideProps</code>.
        </li>
        <li>
          Unlike Next.js, <code>params</code> and <code>searchParams</code> are plain objects,
          not promises, and a page with <code>getServerSideProps</code> does not receive them
          unless it returns them.
        </li>
        <li>
          Param values are taken from the path as sent. GioJS decodes escapes of unreserved
          characters (<code>%41</code> is <code>A</code>), but other escapes stay encoded:{' '}
          <code>/blog/hello%20world</code> gives <code>{'{ slug: \'hello%20world\' }'}</code>.
          Call <code>decodeURIComponent()</code> when you need the text.
        </li>
        <li>
          Two pages that answer the same URLs (for example in two route groups) stop startup
          with an error naming both files. A <code>route.ts</code> in the same folder is
          allowed: it answers the methods it exports, and the page the rest.
        </li>
        <li>
          Everything in the props ends up in the page&apos;s HTML. Never return secrets from{' '}
          <code>getServerSideProps</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/layouts-and-pages">Layouts &amp; Pages</a> - the guide.</li>
        <li><a href="/docs/file-conventions/layout">layout.tsx</a>, <a href="/docs/file-conventions/route">route.ts</a>, <a href="/docs/file-conventions/dynamic-routes">Dynamic Routes</a></li>
        <li><a href="/docs/page-exports">Page Exports</a> - every export a page may have.</li>
        <li><a href="/docs/fetching-data">Fetching Data</a> and <a href="/docs/forms">Forms &amp; Mutations</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Pages answer <code>POST</code> through an <code>action</code> export. Pages inside <code>(group)</code> folders no longer carry the group in their URL, pages in <code>_private</code> folders are never routed, and two pages answering the same URLs stop startup. <code>PageProps</code> and <code>InferPageProps</code> types.</> },
        { version: 'v0.1.0-beta.5', changes: 'Pages hydrate in the browser from per-route client bundles.' },
        { version: 'v0.1.0-beta.1', changes: <>Introduced, as <code>page.tsx</code>, <code>page.jsx</code> or <code>page.js</code>.</> },
      ]} />
    </>
  );
}
