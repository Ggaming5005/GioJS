import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: '<JsonLd>',
  description:
    'Render schema.org structured data as a JSON-LD script block, escaped so that no value can break out of it.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>&lt;JsonLd&gt;</h1>
      <p className="page-subtitle">
        Render schema.org structured data as a JSON-LD script block, escaped so that no value
        can break out of it.
      </p>
      <CodeBlock lang="tsx" code={`import { JsonLd } from '@gio.js/react';

<JsonLd data={{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme', url: 'https://acme.example' }} />`} />

      <h2 id="reference">Reference</h2>
      <PropsTable rows={[
        {
          name: 'data',
          type: 'JsonLdData',
          required: true,
          description: <>One schema.org object, or an array of them: <code>{'Record<string, unknown> | ReadonlyArray<Record<string, unknown>>'}</code>.</>,
        },
        {
          name: 'id',
          type: 'string',
          description: <>An <code>id</code> for the <code>&lt;script&gt;</code> element, for example to find it in tests.</>,
        },
      ]} />
      <p>The props and data types are exported as <code>JsonLdProps</code> and <code>JsonLdData</code>.</p>

      <h3 id="returns">Returns</h3>
      <p>
        A <code>&lt;script type=&quot;application/ld+json&quot;&gt;</code> element holding{' '}
        <code>JSON.stringify(data)</code>, rendered where you place the component. Inside it,{' '}
        <code>&lt;</code>, <code>&gt;</code> and <code>&amp;</code> are written as{' '}
        <code>\u003c</code>, <code>\u003e</code> and <code>\u0026</code>, and the line
        separators U+2028 and U+2029 as <code>\u2028</code> and <code>\u2029</code>. Every JSON
        parser reads the same data, but a string such as a post title containing{' '}
        <code>&lt;/script&gt;</code> can no longer end the element and inject markup.
      </p>
      <CodeBlock lang="text" code={`<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Hello \\u003c/script\\u003e\\u003cb\\u003ex\\u003c/b\\u003e \\u0026 more"}</script>`} />
      <p>
        When <code>JSON.stringify</code> gives nothing (<code>data</code> is{' '}
        <code>undefined</code> at run time), nothing is rendered.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="an-article">An article</h3>
      <CodeBlock lang="tsx" title="app/blog/[slug]/page.tsx" code={`import type { GetServerSideProps } from '@gio.js/core';
import { JsonLd } from '@gio.js/react';

interface Post {
  slug: string;
  title: string;
  author: string;
  publishedAt: string;
}

export const getServerSideProps: GetServerSideProps<{ post: Post }, '/blog/:slug'> = async (ctx) => {
  return { props: { post: await posts.get(ctx.params.slug) } };
};

export default function PostPage({ post }: { post: Post }) {
  return (
    <article>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: post.title,
          author: { '@type': 'Person', name: post.author },
          datePublished: post.publishedAt,
          url: \`https://acme.example/blog/\${post.slug}\`,
        }}
      />
      <h1>{post.title}</h1>
    </article>
  );
}`} />

      <h3 id="several-items-in-one-block">Several items in one block</h3>
      <p>Pass an array, or one object with an <code>@graph</code>:</p>
      <CodeBlock lang="tsx" code={`<JsonLd
  data={{
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'Acme', url: 'https://acme.example' },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Blog', item: 'https://acme.example/blog' },
          { '@type': 'ListItem', position: 2, name: 'Launch notes' },
        ],
      },
    ],
  }}
/>`} />

      <h3 id="site-wide-data-in-the-root-layout">Site-wide data in the root layout</h3>
      <p>
        The block is plain HTML, so it works in the server-only root layout too, where it
        appears on every page.
      </p>
      <CodeBlock lang="tsx" title="app/layout.tsx" code={`import type { LayoutProps } from '@gio.js/core';
import { JsonLd } from '@gio.js/react';

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <body>
        <JsonLd data={{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme', logo: 'https://acme.example/logo.png' }} />
        {children}
      </body>
    </html>
  );
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The type <code>application/ld+json</code> makes it a data block the browser never
          runs, so it needs no CSP nonce, also under a strict{' '}
          <a href="/docs/guides/content-security-policy">Content Security Policy</a>.
        </li>
        <li>
          The escaping is fixed: it is what makes rendering user content into the block safe.
        </li>
        <li>
          <code>JSON.stringify</code> rules apply: <code>Date</code>s become ISO strings,{' '}
          <code>undefined</code> values and functions are dropped, and a <code>BigInt</code> or
          a circular object throws during the render.
        </li>
        <li>
          GioJS does not check the vocabulary. Validate the output with a structured-data
          testing tool.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/metadata#structured-data-json-ld">Metadata &amp; SEO</a> - titles, Open Graph and structured data.</li>
        <li><a href="/docs/page-exports/metadata"><code>metadata</code></a> and <a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a> - the head tags.</li>
        <li><a href="/docs/file-conventions/sitemap"><code>sitemap</code></a> and <a href="/docs/file-conventions/robots"><code>robots</code></a> - the other SEO files.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
