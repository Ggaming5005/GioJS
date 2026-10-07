import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Metadata & SEO',
  description:
    'Titles, descriptions, Open Graph and Twitter cards, canonical URLs, sitemaps, robots.txt ' +
    'and structured data.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Metadata &amp; SEO</h1>
      <p className="page-subtitle">
        Titles, descriptions, Open Graph and Twitter cards, canonical URLs, sitemaps,
        robots.txt and structured data.
      </p>

      <p>
        Pages and layouts describe their <code>&lt;head&gt;</code> with a{' '}
        <code>metadata</code> export. GioJS merges the root layout, the nested layouts and the
        page into one set of tags and renders them into the document head - on the server
        (streamed pages included) and again in the browser, so a{' '}
        <code>&lt;GioLink&gt;</code> navigation swaps the title and every tag for the next
        page&apos;s.
      </p>
      <CodeBlock lang="tsx" code={`// app/layout.tsx
import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  metadataBase: 'https://example.com',
  title: { default: 'Acme', template: '%s | Acme' },
  description: 'Rust-fast React apps.',
  openGraph: { siteName: 'Acme', type: 'website' },
};

// app/pricing/page.tsx
export const metadata: Metadata = {
  title: 'Pricing',                       // → <title>Pricing | Acme</title>
  alternates: { canonical: '/pricing' },  // → https://example.com/pricing
};`} />

      <h2 id="titles">Titles</h2>
      <ul>
        <li>
          A string sets the title. The nearest <code>template</code> set by a layout{' '}
          <em>above</em> the segment is applied (<code>%s</code> is replaced) - a
          layout&apos;s template never applies to its own title.
        </li>
        <li>
          <code>{`{ default }`}</code> in a layout is the title for pages below it that set
          none.
        </li>
        <li>
          <code>{`{ absolute: 'Home' }`}</code> ignores every template.
        </li>
        <li>
          <code>null</code> removes an inherited title; <code>{`{ template: null }`}</code>{' '}
          stops templating below that layout.
        </li>
      </ul>

      <h2 id="generatemetadata">generateMetadata</h2>
      <p>
        When the head depends on data, export <code>generateMetadata</code> instead (or as
        well - its result is merged over the static <code>metadata</code> of the same
        file). It receives the <strong>same context</strong>{' '}
        <code>getServerSideProps</code> gets - <code>params</code>, <code>query</code>,{' '}
        <code>path</code>, <code>locale</code>, ... - and, on pages, the props the page
        renders with as <code>{`{ props }`}</code>, so nothing is fetched twice:
      </p>
      <CodeBlock lang="tsx" title="app/posts/[slug]/page.tsx" code={`import type { Metadata, MetadataContext, MetadataExtras } from '@gio.js/core';

export const revalidate = 300;

export async function getServerSideProps(ctx: MetadataContext) {
  const post = await db.posts.find(ctx.params.slug);
  if (!post) return { notFound: true };
  return { props: { post } };
}

export async function generateMetadata(ctx: MetadataContext, { props }: MetadataExtras): Promise<Metadata> {
  const { post } = props as { post: Post };          // the gSSP result - no second query
  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: \`/posts/\${ctx.params.slug}\` },
    openGraph: { type: 'article', images: [{ url: post.cover, width: 1200, height: 630 }] },
  };
}`} />
      <ul>
        <li>
          It runs after <code>getServerSideProps</code> (its props are ready) and before
          the render, so the tags are part of the first streamed bytes.
        </li>
        <li>
          Layouts&apos; <code>generateMetadata</code> get the context only (no{' '}
          <code>props</code>); all segments resolve in parallel.
        </li>
        <li>
          Reading credentials - <code>ctx.cookies</code>, <code>ctx.ip</code>,{' '}
          <code>ctx.host</code>, <code>ctx.scheme</code>, the cookie/authorization header -
          makes the render personal exactly like it does in{' '}
          <code>getServerSideProps</code>: a page exporting <code>revalidate</code> is not
          cached, with a warning. Unlike in <code>getServerSideProps</code>, this also holds
          for <code>shell = &apos;cache&apos;</code> (PPR) pages: the head is part of the
          shell every visitor shares. Derive metadata from params and query.
        </li>
        <li>
          The same goes for <code>{`{ props }`}</code> on a PPR page. There{' '}
          <code>getServerSideProps</code> may read credentials, because its props stream
          after the shell - but a title built from those props would land in the shared
          shell. So when <code>getServerSideProps</code> read credentials and{' '}
          <code>generateMetadata</code> takes <code>props</code>, the shell is not cached
          (the page streams without it, with a warning). On such pages, build metadata from{' '}
          <code>ctx.params</code>/<code>ctx.query</code> - fetching by slug again if
          needed - and leave <code>props</code> alone. Pages whose{' '}
          <code>getServerSideProps</code> reads nothing personal keep using{' '}
          <code>props</code> freely.
        </li>
        <li>
          <code>notFound()</code> answers 404; a throw answers 500 like a failing render.
        </li>
      </ul>

      <h2 id="how-segments-merge">How segments merge</h2>
      <p>
        Root layout first, then each nested layout, then the page. The merge is shallow and
        the deepest segment wins per top-level field: a page that sets{' '}
        <code>openGraph</code> replaces the layout&apos;s whole <code>openGraph</code> object
        (share common values through a variable). <code>undefined</code> inherits,{' '}
        <code>null</code> removes the inherited value. Titles follow the template rules above.
      </p>

      <h2 id="absolute-urls-metadatabase">Absolute URLs: metadataBase</h2>
      <p>
        Open Graph and Twitter images, <code>openGraph.url</code>, the canonical URL and
        alternate languages must be absolute for crawlers. Relative values resolve against the
        deepest <code>metadataBase</code> (a layout usually sets it), falling back to the{' '}
        <code>GIO_SITE_URL</code> environment variable. The base&apos;s path is kept:{' '}
        <code>metadataBase: &apos;https://example.com/blog&apos;</code> turns{' '}
        <code>/og.png</code> into <code>https://example.com/blog/og.png</code>. Without
        either, the URL stays relative and the worker logs a warning (once per route). The request&apos;s{' '}
        <code>Host</code> header is never used: on a cached page, a client-chosen host would
        end up in every visitor&apos;s canonical URL.
      </p>

      <h2 id="fields">Fields</h2>
      <table>
        <thead><tr><th>Field</th><th>Renders</th></tr></thead>
        <tbody>
          <tr><td><code>title</code></td><td><code>&lt;title&gt;</code></td></tr>
          <tr><td><code>description</code></td><td><code>&lt;meta name=&quot;description&quot;&gt;</code></td></tr>
          <tr><td><code>keywords</code></td><td><code>&lt;meta name=&quot;keywords&quot;&gt;</code> (array joined with commas)</td></tr>
          <tr><td><code>authors</code></td><td><code>&lt;meta name=&quot;author&quot;&gt;</code>, plus <code>&lt;link rel=&quot;author&quot;&gt;</code> for a <code>url</code></td></tr>
          <tr><td><code>robots</code></td><td><code>&lt;meta name=&quot;robots&quot;&gt;</code> from a string or <code>{`{ index, follow, noarchive, nosnippet, noimageindex, nocache, 'max-snippet', 'max-image-preview', 'max-video-preview' }`}</code>; <code>googleBot</code> renders <code>&lt;meta name=&quot;googlebot&quot;&gt;</code></td></tr>
          <tr><td><code>alternates</code></td><td><code>{`{ canonical, languages: { 'en-US': url } }`}</code> → <code>&lt;link rel=&quot;canonical&quot;&gt;</code> and <code>&lt;link rel=&quot;alternate&quot; hreflang&gt;</code></td></tr>
          <tr><td><code>openGraph</code></td><td><code>og:title</code>, <code>og:description</code>, <code>og:url</code>, <code>og:site_name</code>, <code>og:locale</code>, <code>og:type</code>, and per image <code>og:image</code> (+ <code>:type</code>, <code>:width</code>, <code>:height</code>, <code>:alt</code>)</td></tr>
          <tr><td><code>twitter</code></td><td><code>twitter:card</code>, <code>:site</code>, <code>:creator</code>, <code>:title</code>, <code>:description</code>, <code>:image</code> (+ <code>:alt</code>)</td></tr>
          <tr><td><code>icons</code></td><td>A URL, a list, or <code>{`{ icon, apple, shortcut }`}</code> → <code>&lt;link rel=&quot;icon&quot; | &quot;apple-touch-icon&quot; | &quot;shortcut icon&quot;&gt;</code> with <code>type</code>/<code>sizes</code>/<code>media</code></td></tr>
          <tr><td><code>manifest</code></td><td><code>&lt;link rel=&quot;manifest&quot;&gt;</code></td></tr>
          <tr><td><code>themeColor</code></td><td><code>&lt;meta name=&quot;theme-color&quot;&gt;</code>; a list of <code>{`{ color, media }`}</code> for light/dark</td></tr>
          <tr><td><code>other</code></td><td><code>{`{ name: content }`}</code> → extra <code>&lt;meta name content&gt;</code> tags (verification codes, ...)</td></tr>
        </tbody>
      </table>
      <p>
        Every value is rendered by React, so it is HTML-escaped - a post title from your
        database cannot break out of the head.
      </p>

      <h2 id="how-the-tags-are-rendered">How the tags are rendered</h2>
      <ul>
        <li>
          The tags are React elements rendered inside the page&apos;s tree; React 19 hoists{' '}
          <code>&lt;title&gt;</code>, <code>&lt;meta&gt;</code> and <code>&lt;link&gt;</code>{' '}
          into the <code>&lt;head&gt;</code> your root layout renders. Without a root layout
          they are written into the default document&apos;s head.
        </li>
        <li>
          The hydration envelope carries the same tags, and the browser renders them at the
          same place: hydration adopts the server&apos;s elements, and a soft navigation
          removes the previous page&apos;s tags and inserts the next page&apos;s - including
          tags the next page does not have.
        </li>
        <li>
          <strong>Metadata supersedes a hand-written title.</strong> A{' '}
          <code>&lt;title&gt;</code> rendered by a component - the root layout, a nested
          layout or the page itself - next to a metadata title would put two in the head
          (browsers, crawlers and React all use the first). Every one but the metadata title
          is removed from the server HTML, and development mode logs a warning. Do not mix
          the two: a title a page or nested layout renders is mounted again by React once the
          page hydrates, so the browser tab would end up showing it while crawlers and link
          previews read the metadata title. Set titles through metadata only - move the root
          layout&apos;s into{' '}
          <code>{`export const metadata = { title: { default: '...' } }`}</code>.
        </li>
        <li>
          Only titles are deduplicated. Other tags you hand-write in the root layout
          (charset, viewport, stylesheets) stay as they are, so do not also declare them in
          metadata - a <code>&lt;meta name=&quot;description&quot;&gt;</code> written in the
          root layout next to a metadata <code>description</code> gives the page two, and the
          hand-written one stays in the head through every navigation. Move it into the root
          layout&apos;s <code>metadata</code> as well.
        </li>
        <li>
          Special pages (<code>not-found.tsx</code>, <code>error.tsx</code>) resolve metadata
          the same way, so a 404 can say <code>{`robots: 'noindex'`}</code>. Their layouts&apos;{' '}
          <code>generateMetadata</code> get the params of the route that was not found or
          failed (none for a URL no route matches). Metadata never stops them rendering: when a{' '}
          <code>generateMetadata</code> throws (say the CMS is down - often the very error
          the error page answers), the special page renders with the static{' '}
          <code>metadata</code> exports only, and the failure is logged.
        </li>
      </ul>

      <h2 id="structured-data-json-ld">Structured data (JSON-LD)</h2>
      <CodeBlock lang="tsx" code={`import { JsonLd } from '@gio.js/react';

export default function Post({ post }: { post: Post }) {
  return (
    <article>
      <JsonLd data={{
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.title,
        datePublished: post.publishedAt,
      }} />
      <h1>{post.title}</h1>
    </article>
  );
}`} />
      <p>
        <code>&lt;JsonLd&gt;</code> renders a{' '}
        <code>&lt;script type=&quot;application/ld+json&quot;&gt;</code>. The JSON is written
        with <code>&lt;</code>, <code>&gt;</code>, <code>&amp;</code>, U+2028 and U+2029
        escaped, so a value containing <code>&lt;/script&gt;</code> cannot end the element.
        It is a data block the browser never executes, so it needs no CSP nonce.
      </p>

      <h2 id="sitemapxml-robotstxt-and-the-web-manifest">sitemap.xml, robots.txt and the web manifest</h2>
      <p>
        Three files at the root of <code>app/</code> generate the crawler files. Each default
        export is the data, or a (sync or async) function returning it:
      </p>
      <table>
        <thead><tr><th>File</th><th>Serves</th><th>Content type</th></tr></thead>
        <tbody>
          <tr><td><code>app/sitemap.ts</code></td><td><code>/sitemap.xml</code></td><td><code>application/xml</code></td></tr>
          <tr><td><code>app/robots.ts</code></td><td><code>/robots.txt</code></td><td><code>text/plain</code></td></tr>
          <tr><td><code>app/manifest.ts</code></td><td><code>/manifest.webmanifest</code></td><td><code>application/manifest+json</code></td></tr>
        </tbody>
      </table>
      <CodeBlock lang="ts" code={`// app/sitemap.ts
import type { MetadataRoute } from '@gio.js/core';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const posts = await db.posts.list();
  return [
    { url: '/', changeFrequency: 'daily', priority: 1 },
    ...posts.map(post => ({
      url: \`/posts/\${post.slug}\`,
      lastModified: post.updatedAt,               // Date or string
      alternates: { languages: { de: \`/de/posts/\${post.slug}\` } },
    })),
  ];
}

// app/robots.ts
import type { MetadataRoute } from '@gio.js/core';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: ['/admin', '/api'] },
      { userAgent: 'GPTBot', disallow: '/', crawlDelay: 10 },
    ],
    sitemap: '/sitemap.xml',
  };
}`} />
      <ul>
        <li>
          Relative URLs in the sitemap and robots <code>sitemap</code> resolve against{' '}
          <code>GIO_SITE_URL</code> (crawlers require absolute URLs). Values are XML-escaped;
          a robots value containing a line break is rejected rather than written, since it
          could smuggle in directives of its own. An invalid sitemap entry (no{' '}
          <code>url</code>, a <code>priority</code> outside 0-1, an unknown{' '}
          <code>changeFrequency</code>) answers 500 with the reason in the log.
        </li>
        <li>
          The generators get no request context, so their output is the same for everyone and
          is cached in the Rust cache for <code>revalidate</code> seconds -{' '}
          <strong>3600 by default</strong> (crawlers fetch these a few times a day, and a
          sitemap often queries every row of a table). Export{' '}
          <code>revalidate = 0</code> to generate per request, or <code>false</code> to keep
          the output until the next deploy.
        </li>
        <li>
          A file of the same name in <code>public/</code> wins: the server serves it before
          the request reaches the worker, and logs a startup warning naming the module that
          never runs. A <code>page.tsx</code> or <code>route.ts</code> answering the same URL
          fails startup.
        </li>
        <li>
          <a href="/docs/static-export"><code>gio export</code></a> writes{' '}
          <code>sitemap.xml</code>, <code>robots.txt</code> and{' '}
          <code>manifest.webmanifest</code> from these modules.
        </li>
      </ul>

      <h2 id="not-yet-available">Not yet available</h2>
      <p>
        Generated Open Graph images (an <code>opengraph-image.tsx</code> convention rendering
        JSX to PNG) are not part of GioJS yet. Point <code>openGraph.images</code> at a static
        file in <code>public/</code> or at an image your own <code>route.ts</code> produces.
        A separate <code>viewport</code> export, file-based icons (<code>app/icon.png</code>)
        and multiple sitemaps (<code>generateSitemaps</code>) are not supported either.
      </p>
    </>
  );
}
