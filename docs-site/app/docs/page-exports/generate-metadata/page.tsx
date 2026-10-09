import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'generateMetadata',
  description:
    "Build a page's or layout's head metadata per request, from its params, query or the page's props.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>generateMetadata</h1>
      <p className="page-subtitle">
        Build a page&apos;s or layout&apos;s head metadata per request, from its params, query
        or the page&apos;s props.
      </p>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`import { notFound, type GenerateMetadata, type GetServerSideProps, type InferPageProps } from '@gio.js/core';
import { db, type Post } from '../../../lib/db.server.ts';

export const getServerSideProps: GetServerSideProps<{ post: Post }, '/posts/:id'> = async (ctx) => {
  const post = await db.posts.find(ctx.params.id);
  if (post === null) notFound();
  return { props: { post } };
};

// Reuses the post getServerSideProps already loaded - no second query.
export const generateMetadata: GenerateMetadata<'/posts/:id'> = (ctx, { props }) => {
  const { post } = props as InferPageProps<typeof getServerSideProps>;
  return {
    title: post.title,
    description: post.excerpt,
    openGraph: { images: post.coverUrl },
  };
};`} />

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <PropsTable kind="Parameter" rows={[
        { name: 'ctx', type: 'MetadataContext<Route>', required: true, description: <>The same context <a href="/docs/page-exports/get-server-side-props#parameters"><code>getServerSideProps</code></a> receives - <code>params</code>, <code>query</code>, <code>headers</code>, <code>cookies</code>, <code>locale</code>, <code>ip</code>, ... - with the same tracking of personal reads.</> },
        { name: 'extras.props', type: 'Record<string, unknown> | undefined', description: <>Pages only: the props the page renders with (what <code>getServerSideProps</code> returned, or <code>{'{ params, searchParams }'}</code>). <code>undefined</code> in a layout.</> },
      ]} />

      <h3 id="returns">Returns</h3>
      <p>
        A <a href="/docs/page-exports/metadata#fields"><code>Metadata</code></a> object, or a
        promise of one. It is merged over the module&apos;s static <code>metadata</code> export
        field by field, then into the other segments by the usual rules. <code>undefined</code>{' '}
        or <code>null</code> leaves the static <code>metadata</code> alone. Anything else (a
        string, a number) is a render error:{' '}
        <code>generateMetadata must return an object, got string</code>.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Where.</strong> Read from <code>layout.tsx</code>, <code>page.tsx</code>,{' '}
          <code>not-found.tsx</code> and <code>error.tsx</code>.
        </li>
        <li>
          <strong>When.</strong> On every render, after <code>getServerSideProps</code> and
          before the page renders, so the tags are in the <code>&lt;head&gt;</code> of the first
          bytes sent (and of a <a href="/docs/page-exports/shell">PPR shell</a>). The functions
          of the page and of every layout above it run concurrently. A cache hit runs none of
          them.
        </li>
        <li>
          <strong>Errors.</strong> A thrown <code>notFound()</code> answers <code>404</code>, a
          thrown <code>redirect()</code> redirects, and any other error answers{' '}
          <code>500</code> with the nearest <code>error.tsx</code>. On a not-found or error page,
          a failing <code>generateMetadata</code> never stops the page rendering: it renders
          with the static <code>metadata</code> exports only, and the failure is logged.
        </li>
        <li>
          <strong>Caching.</strong> Reading <code>ctx.cookies</code>, <code>ctx.ip</code>,{' '}
          <code>ctx.host</code>, <code>ctx.scheme</code> or a credential header makes the
          render personal, so a page with <code>revalidate</code> is not cached and a warning
          names the route. On a <code>shell = &apos;cache&apos;</code> page the head is part of
          the cached shell, so using <code>props</code> from a <code>getServerSideProps</code>{' '}
          that read credentials costs the shell its cache as well. Derive metadata from{' '}
          <code>params</code> and <code>query</code> on cached pages.
        </li>
        <li>
          <strong>Layouts.</strong> A layout&apos;s <code>generateMetadata</code> sees the
          params of the page being rendered, and on a not-found or error page the params of
          the route that was not found or failed (none for a URL no route matches).
        </li>
      </ul>

      <h3 id="types">Types</h3>
      <p>
        <code>{'GenerateMetadata<Route>'}</code> types the whole function, with{' '}
        <code>ctx.params</code> typed by <code>Route</code> (a pattern of your app such as{' '}
        <code>{"'/posts/:id'"}</code>, or a params shape). <code>{'MetadataContext<Route>'}</code>{' '}
        and <code>MetadataExtras</code> type the arguments alone.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="title-from-the-url">Title from the URL</h3>
      <p>Without <code>getServerSideProps</code>, read <code>ctx.params</code> directly:</p>
      <CodeBlock lang="tsx" title="app/tags/[tag]/page.tsx" code={`import type { GenerateMetadata, PageProps } from '@gio.js/core';

export const generateMetadata: GenerateMetadata<'/tags/:tag'> = (ctx) => ({
  title: \`Posts tagged \${ctx.params.tag}\`,
  alternates: { canonical: \`/tags/\${ctx.params.tag}\` },
});

export default function TagPage({ params }: PageProps<'/tags/:tag'>) {
  return <h1>Posts tagged {params.tag}</h1>;
}`} />

      <h3 id="keep-search-results-out-of-the-index">Keep search results out of the index</h3>
      <CodeBlock lang="tsx" title="app/search/page.tsx" code={`import type { GenerateMetadata, PageProps } from '@gio.js/core';

export const generateMetadata: GenerateMetadata = (ctx) => ({
  title: ctx.query.q ? \`Results for \${ctx.query.q}\` : 'Search',
  robots: { index: false },
});

export default function Search({ searchParams }: PageProps) {
  return <h1>{searchParams.q ? \`Results for \${searchParams.q}\` : 'Search'}</h1>;
}`} />

      <h3 id="a-layout-for-a-section">A layout for a section</h3>
      <CodeBlock lang="tsx" title="app/shop/[category]/layout.tsx" code={`import type { GenerateMetadata, LayoutProps } from '@gio.js/core';
import { db } from '../../../lib/db.server.ts';

// A params shape, not a pattern: the layout also wraps pages below /shop/:category.
export const generateMetadata: GenerateMetadata<{ category: string }> = async (ctx) => {
  const category = await db.categories.find(ctx.params.category);
  return { title: { default: category.name, template: \`%s - \${category.name}\` } };
};

export default function CategoryLayout({ children }: LayoutProps) {
  return <section>{children}</section>;
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Use <code>props</code> instead of loading the same data twice: the page&apos;s{' '}
          <code>getServerSideProps</code> has already run when <code>generateMetadata</code>{' '}
          does.
        </li>
        <li>
          <code>props</code> is read lazily: a <code>generateMetadata</code> that never touches
          it does not tie the head to the page&apos;s data.
        </li>
        <li>
          Under <code>gio export</code> it runs at build time, once per exported page, like{' '}
          <code>getServerSideProps</code>.
        </li>
        <li>
          Like every export but the default, it stays out of the browser bundle. The browser
          gets the resolved tags in the page&apos;s hydration data.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/metadata#generatemetadata">Metadata &amp; SEO</a> - the guide</li>
        <li><a href="/docs/page-exports/metadata"><code>metadata</code></a> - the static form, and every field</li>
        <li><a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a></li>
        <li><a href="/docs/caching#personalized-pages-are-never-shared">Personalized pages are never shared</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: 'Introduced.' },
      ]} />
    </>
  );
}
