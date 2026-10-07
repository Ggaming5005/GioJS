import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Dynamic Routes',
  description:
    'Folders named [param], [...param] or [[...param]] match URL segments that are not known in advance and pass them to the route as params.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Dynamic Routes</h1>
      <p className="page-subtitle">
        Folders named <code>[param]</code>, <code>[...param]</code> or{' '}
        <code>[[...param]]</code> match URL segments that are not known in advance and pass
        them to the route as params.
      </p>
      <CodeBlock lang="text" code={`app/
  blog/[slug]/page.tsx           /blog/:slug       /blog/hello
  docs/[...path]/page.tsx        /docs/*path       /docs/a, /docs/a/b/c
  shop/[[...filters]]/page.tsx   /shop/*filters?   /shop, /shop/red/large`} />

      <h2 id="reference">Reference</h2>
      <h3 id="convention">Convention</h3>
      <table>
        <thead><tr><th>Folder</th><th>Pattern</th><th>Matches</th><th>Param value</th></tr></thead>
        <tbody>
          <tr>
            <td><code>[id]</code></td>
            <td><code>:id</code></td>
            <td>Exactly one segment</td>
            <td><code>/posts/7</code> → <code>{'{ id: \'7\' }'}</code></td>
          </tr>
          <tr>
            <td id="catch-all-segments"><code>[...slug]</code></td>
            <td><code>*slug</code></td>
            <td>One or more segments (not the parent URL)</td>
            <td><code>/docs/a/b</code> → <code>{'{ slug: \'a/b\' }'}</code></td>
          </tr>
          <tr>
            <td id="optional-catch-all-segments"><code>[[...slug]]</code></td>
            <td><code>*slug?</code></td>
            <td>Zero or more segments, so the parent URL too</td>
            <td><code>/shop</code> → <code>{'{ slug: \'\' }'}</code>, <code>/shop/a/b</code> → <code>{'{ slug: \'a/b\' }'}</code></td>
          </tr>
        </tbody>
      </table>
      <p>
        The pattern column is how GioJS writes the route everywhere else: in{' '}
        <code>gio routes</code>, in <code>.gio/routes.d.ts</code>, in the type helpers (
        <code>{'PageProps<\'/blog/:slug\'>'}</code>) and in <code>href()</code>.
      </p>

      <h3 id="param-values">Param values</h3>
      <ul>
        <li>
          Every value is a <code>string</code>. A catch-all is <strong>one</strong> string
          that keeps its <code>/</code> separators, not an array as in Next.js: split it
          yourself (<code>{'slug.split(\'/\')'}</code>). An optional catch-all that matched
          nothing is <code>&apos;&apos;</code>.
        </li>
        <li>
          Values come from the path as the client sent it, after the server&apos;s cleanup:
          repeated and trailing slashes are collapsed and escapes of unreserved characters
          decoded (<code>%41</code> is <code>A</code>). Other escapes stay as they are:{' '}
          <code>/blog/caf%C3%A9</code> gives <code>{'{ slug: \'caf%C3%A9\' }'}</code>, so use{' '}
          <code>decodeURIComponent()</code> when you need the text. Paths with{' '}
          <code>.</code> or <code>..</code> segments, or a broken <code>%</code> escape, are
          refused with <code>400</code> before any route runs.
        </li>
      </ul>

      <h3 id="where-params-arrive">Where params arrive</h3>
      <table>
        <thead><tr><th>In</th><th>Read them from</th></tr></thead>
        <tbody>
          <tr><td>A page without <code>getServerSideProps</code></td><td>The <code>params</code> prop</td></tr>
          <tr><td><code>getServerSideProps</code>, <code>generateMetadata</code></td><td><code>ctx.params</code></td></tr>
          <tr><td>A page <code>action</code>, a <code>route.ts</code> handler</td><td><code>req.params</code></td></tr>
          <tr><td>A <code>wsHandler</code></td><td><code>socket.params</code></td></tr>
          <tr><td>Any component, layouts included</td><td><a href="/docs/hooks/use-params"><code>useParams()</code></a></td></tr>
        </tbody>
      </table>

      <h3 id="name-rules">Name rules</h3>
      <p>Malformed folder names stop startup with an error naming the file:</p>
      <ul>
        <li>
          A name may not start with <code>.</code> and may not contain <code>[</code>,{' '}
          <code>]</code>, <code>/</code>, <code>?</code>, <code>:</code> or <code>*</code>.{' '}
          <code>[id?]</code> or <code>[a]b</code> fails with{' '}
          <code>unsupported dynamic segment &quot;[id?]&quot; - use [name], [...name] or [[...name]]</code>.
        </li>
        <li>
          A folder named <code>:id</code> or <code>*rest</code> fails too: it would read back
          as a pattern.
        </li>
        <li>
          A param name may appear once per route (<code>[id]/edit/[id]</code> fails), and a
          catch-all must be the last segment (<code>[...a]/b</code> fails).
        </li>
      </ul>

      <h3 id="matching-order">Matching order</h3>
      <p>
        When several routes match a URL, the most specific one answers. Patterns are compared
        segment by segment from the left, and the first segment that differs decides:
      </p>
      <ol>
        <li>a static segment (<code>about</code>)</li>
        <li>a dynamic segment (<code>[slug]</code>)</li>
        <li>a catch-all (<code>[...slug]</code>)</li>
        <li>the end of the pattern</li>
        <li>an optional catch-all (<code>[[...slug]]</code>)</li>
      </ol>
      <p>
        So <code>/blog/about</code> renders <code>blog/about/page.tsx</code> even next to{' '}
        <code>blog/[slug]/page.tsx</code>, and with <code>shop/page.tsx</code> and{' '}
        <code>shop/[[...path]]/page.tsx</code>, <code>/shop</code> renders the static page and{' '}
        <code>/shop/a</code> the catch-all. Pages and <code>route.ts</code> files share this
        order, so a catch-all <code>route.ts</code> never shadows a more specific page.
      </p>

      <h3 id="conflicts">Conflicts</h3>
      <p>
        Two routes that would match exactly the same URLs stop startup, because no order
        could pick between them:
      </p>
      <CodeBlock lang="text" code={`route conflict: app/posts/[id]/page.tsx and app/posts/[slug]/page.tsx both resolve to "/posts/:id" and "/posts/:slug" (the same URLs under different param names) - every URL must be served by exactly one file`} />
      <p>
        <code>docs/[...a]</code> next to <code>docs/[[...b]]</code> fails the same way: the
        catch-all outranks the optional one on every URL below <code>/docs</code>, which would
        leave it only <code>/docs</code> itself. Keep one, and add{' '}
        <code>docs/page.tsx</code> if <code>/docs</code> needs its own page.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-docs-section-with-a-catch-all">A docs section with a catch-all</h3>
      <CodeBlock lang="tsx" title="app/docs/[...path]/page.tsx" code={`import React from 'react';
import { notFound } from '@gio.js/core';
import type { GetServerSideProps, InferPageProps } from '@gio.js/core';
import { loadDoc } from '../../../lib/docs';

export const getServerSideProps: GetServerSideProps<{ title: string; html: string }, '/docs/*path'> =
  async (ctx) => {
    const segments = ctx.params.path.split('/'); // '/docs/guides/setup' -> ['guides', 'setup']
    const doc = await loadDoc(segments);
    if (doc === null) notFound();
    return { props: { title: doc.title, html: doc.html } };
  };

export default function DocPage({ title, html }: InferPageProps<typeof getServerSideProps>) {
  return (
    <article>
      <h1>{title}</h1>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}`} />

      <h3 id="an-optional-catch-all-for-filters">An optional catch-all for filters</h3>
      <CodeBlock lang="tsx" title="app/shop/[[...filters]]/page.tsx" code={`import React from 'react';
import type { PageProps } from '@gio.js/core';

export default function Shop({ params }: PageProps<'/shop/*filters?'>) {
  const filters = params.filters ? params.filters.split('/') : [];
  return <h1>{filters.length === 0 ? 'All products' : \`Filtered by \${filters.join(', ')}\`}</h1>;
}`} />

      <h3 id="pre-render-dynamic-routes-for-a-static-export">Pre-render dynamic routes for a static export</h3>
      <p>
        The server renders any param on demand. <code>gio export</code> needs the list, from{' '}
        <a href="/docs/page-exports/get-static-paths"><code>getStaticPaths</code></a>; a
        catch-all param may be given as a string or as its segments:
      </p>
      <CodeBlock lang="ts" title="app/docs/[...path]/page.tsx" code={`import type { GetStaticPaths } from '@gio.js/core';

export const getStaticPaths: GetStaticPaths<'/docs/*path'> = () => ({
  paths: [
    { params: { path: 'getting-started' } },
    { params: { path: ['guides', 'setup'] } },
  ],
});`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          On a soft navigation between two URLs of the same route (<code>/blog/a</code> to{' '}
          <code>/blog/b</code>) the page remounts, and so does every layout inside the dynamic
          folder, so no state leaks from one value to the next.
        </li>
        <li>
          Layouts, <code>loading.tsx</code>, <code>error.tsx</code> and{' '}
          <code>not-found.tsx</code> work inside dynamic folders and apply to every URL below
          them.
        </li>
        <li>
          In <code>.gio/routes.d.ts</code> a dynamic param is <code>string</code> and an
          optional catch-all <code>string | undefined</code> (<code>{'{ filters?: string }'}</code>),
          so typed code handles the empty case.
        </li>
        <li>
          <code>href(&apos;/shop/*filters?&apos;)</code> without the param gives{' '}
          <code>/shop</code>; values are URL-encoded per segment, catch-alls keeping their
          slashes.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/layouts-and-pages#dynamic-routes">Layouts &amp; Pages: Dynamic routes</a></li>
        <li><a href="/docs/file-conventions/route-groups">Route Groups</a>, <a href="/docs/file-conventions/private-folders">Private Folders</a></li>
        <li><a href="/docs/hooks/use-params"><code>useParams</code></a>, <a href="/docs/functions/href"><code>href</code></a>, <a href="/docs/typescript">TypeScript</a></li>
        <li><a href="/docs/cli/routes"><code>gio routes</code></a> - lists every pattern without starting the server.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>[...slug]</code> matches one or more segments and <code>[[...slug]]</code> zero or more, as one <code>/</code>-joined string. Deterministic precedence shared by pages and <code>route.ts</code>; conflicting files and malformed names stop startup.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced: <code>[param]</code> folders.</> },
      ]} />
    </>
  );
}
