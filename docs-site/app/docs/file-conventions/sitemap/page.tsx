import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'sitemap.ts',
  description:
    'Generate /sitemap.xml from code: app/sitemap.ts returns the list of URLs and GioJS writes the XML.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>sitemap.ts</h1>
      <p className="page-subtitle">
        Generate <code>/sitemap.xml</code> from code: <code>app/sitemap.ts</code> returns the
        list of URLs and GioJS writes the XML.
      </p>
      <CodeBlock lang="ts" title="app/sitemap.ts" code={`import type { MetadataRoute } from '@gio.js/core';
import { listPosts } from '../lib/posts';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const posts = await listPosts();
  return [
    { url: '/', changeFrequency: 'weekly', priority: 1 },
    ...posts.map((post) => ({ url: \`/blog/\${post.slug}\`, lastModified: post.updatedAt })),
  ];
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>app/sitemap.ts</code> or <code>app/sitemap.js</code>, at the root of{' '}
        <code>app/</code> only: a <code>sitemap.ts</code> in a subfolder is an ordinary module.
        It answers <code>/sitemap.xml</code>.
      </p>

      <h3 id="exports">Exports</h3>
      <PropsTable kind="Field" rows={[
        {
          name: 'default',
          type: 'Sitemap | (() => Sitemap | Promise<Sitemap>)',
          required: true,
          description: 'The entries, or a function returning them. The function gets no arguments: the sitemap is the same for every visitor.',
        },
        {
          name: 'revalidate',
          type: 'number | false',
          default: '3600',
          description: (
            <>
              Seconds the output is cached. <code>false</code> keeps it until the next deploy
              (one year), <code>0</code> (or a negative number) generates it on every request.
            </>
          ),
        },
      ]} />

      <h3 id="sitemap-entries">Sitemap entries</h3>
      <PropsTable kind="Field" rows={[
        { name: 'url', type: 'string', required: true, description: <>The page&apos;s URL, absolute or relative to <code>GIO_SITE_URL</code>. Becomes <code>&lt;loc&gt;</code>.</> },
        { name: 'lastModified', type: 'string | Date', description: <>Becomes <code>&lt;lastmod&gt;</code>; a <code>Date</code> is written as an ISO timestamp, a string as given.</> },
        { name: 'changeFrequency', type: "'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'", description: <>Becomes <code>&lt;changefreq&gt;</code>.</> },
        { name: 'priority', type: 'number', description: <>From <code>0</code> to <code>1</code>. Becomes <code>&lt;priority&gt;</code>.</> },
        { name: 'alternates.languages', type: 'Record<string, string>', description: <>Translations of the URL, by language: one <code>&lt;xhtml:link rel=&quot;alternate&quot; hreflang&gt;</code> each.</> },
      ]} />
      <p>
        The types are <code>MetadataRoute.Sitemap</code> (an array of{' '}
        <code>SitemapEntry</code>) and <code>ChangeFrequency</code>, from{' '}
        <code>@gio.js/core</code>.
      </p>

      <h3 id="response">Response</h3>
      <ul>
        <li>
          <code>200</code>, <code>Content-Type: application/xml; charset=utf-8</code>, a{' '}
          <code>urlset</code> in the sitemaps.org namespace (with the <code>xhtml</code>{' '}
          namespace when an entry has alternates). Text is XML-escaped, and characters XML
          forbids are dropped.
        </li>
        <li>
          Only <code>GET</code> and <code>HEAD</code>: other methods get <code>405</code> with{' '}
          <code>Allow: GET, HEAD</code>.
        </li>
        <li>
          The server&apos;s page cache keeps the output for <code>revalidate</code> seconds (
          <code>X-Gio-Cache</code> shows hits) and answers with an <code>ETag</code>. Unlike
          HTML pages it gets no automatic <code>Cache-Control</code>; add a{' '}
          <a href="/docs/configuration/headers"><code>[[headers]]</code></a> rule if a CDN
          should cache it.
        </li>
        <li>
          An invalid entry (not an object, no <code>url</code>, an unknown{' '}
          <code>changeFrequency</code>, a <code>priority</code> outside 0-1, an invalid{' '}
          <code>Date</code>) or a function that throws answers <code>500</code>{' '}
          <code>Internal Server Error (ref &lt;digest&gt;)</code>, never cached, with the reason
          in the log. A sitemap search engines would reject is never served.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="output">Output</h3>
      <CodeBlock lang="ts" title="app/sitemap.ts" code={`import type { MetadataRoute } from '@gio.js/core';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: '/', lastModified: new Date('2026-10-01T00:00:00Z'), changeFrequency: 'weekly', priority: 1 },
    { url: '/blog/hello', alternates: { languages: { de: '/de/blog/hello' } } },
  ];
}`} />
      <p>With <code>GIO_SITE_URL=https://example.com</code>, <code>/sitemap.xml</code> is:</p>
      <CodeBlock lang="text" code={`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url>
<loc>https://example.com/</loc>
<lastmod>2026-10-01T00:00:00.000Z</lastmod>
<changefreq>weekly</changefreq>
<priority>1</priority>
</url>
<url>
<loc>https://example.com/blog/hello</loc>
<xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/blog/hello"/>
</url>
</urlset>`} />

      <h3 id="refresh-once-a-day">Refresh once a day</h3>
      <CodeBlock lang="ts" title="app/sitemap.ts" code={`import type { MetadataRoute } from '@gio.js/core';
import { listProducts } from '../lib/catalog';

export const revalidate = 86400;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const products = await listProducts();
  return products.map((product) => ({ url: \`/products/\${product.id}\`, lastModified: product.updatedAt }));
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Relative URLs are resolved against <code>GIO_SITE_URL</code> (not{' '}
          <code>metadataBase</code>, which belongs to page metadata). Without it they stay
          relative and the server warns once per URL: crawlers need absolute URLs.
        </li>
        <li>
          A <code>public/sitemap.xml</code> wins: it is served before the request reaches the
          worker, the module never runs, and startup warns. A page or <code>route.ts</code> at{' '}
          <code>/sitemap.xml</code> stops startup.
        </li>
        <li>
          <code>gio export</code> writes <code>out/sitemap.xml</code> from it. Without an{' '}
          <code>app/sitemap.ts</code>, the export generates one listing every exported page,
          but only when <code>GIO_SITE_URL</code> is set.
        </li>
        <li>
          One file serves one sitemap: there is no <code>generateSitemaps</code> for sitemap
          indexes yet. A sitemap holds at most 50,000 URLs, so split larger sites by hand with{' '}
          <code>route.ts</code> files.
        </li>
        <li>
          In development a change to the file restarts the worker and clears the cache.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/metadata#sitemapxml-robotstxt-and-the-web-manifest">Metadata &amp; SEO</a> - the guide.</li>
        <li><a href="/docs/file-conventions/robots">robots.ts</a>, <a href="/docs/file-conventions/manifest">manifest.ts</a>, <a href="/docs/file-conventions/public-folder">public/</a></li>
        <li><a href="/docs/env-vars">Environment variables</a> (<code>GIO_SITE_URL</code>)</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced: <code>app/sitemap.ts</code> serves <code>/sitemap.xml</code>, on the server, in standalone builds and in <code>gio export</code>.</> },
        { version: 'v0.1.0-beta.3', changes: <><code>gio export</code> generates a <code>sitemap.xml</code> of the exported pages when <code>GIO_SITE_URL</code> is set.</> },
      ]} />
    </>
  );
}
