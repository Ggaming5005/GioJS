import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'metadata',
  description:
    'Describe the document head of a page or layout - title, description, Open Graph, canonical URL and more - as a static object.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>metadata</h1>
      <p className="page-subtitle">
        Describe the document head of a page or layout - title, description, Open Graph,
        canonical URL and more - as a static object.
      </p>
      <CodeBlock lang="tsx" title="app/layout.tsx" code={`import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  metadataBase: 'https://acme.example',
  title: { default: 'Acme', template: '%s | Acme' },
  description: 'The Acme store.',
  openGraph: { siteName: 'Acme', images: '/og.png' },
};`} />
      <CodeBlock lang="tsx" title="app/pricing/page.tsx" code={`import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  title: 'Pricing',                                  // <title>Pricing | Acme</title>
  alternates: { canonical: '/pricing' },             // https://acme.example/pricing
};`} />
      <p>
        <code>metadata</code> is read from <code>layout.tsx</code>, <code>page.tsx</code>,{' '}
        <code>not-found.tsx</code> and <code>error.tsx</code>. For values that depend on the
        request or on data, export{' '}
        <a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a>{' '}
        instead (or as well).
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="fields">Fields</h3>
      <p>Every field is optional. <code>null</code> removes a value a layout above set.</p>
      <PropsTable kind="Field" rows={[
        { name: 'title', type: 'string | { default?, template?, absolute? }', description: <><code>&lt;title&gt;</code>. A string gets the nearest <code>template</code> set <em>above</em> this segment (<code>%s</code> is replaced). <code>default</code> is the title for segments below that set none, <code>template</code> applies to titles set below (<code>null</code> drops it), and <code>absolute</code> ignores every template.</> },
        { name: 'description', type: 'string', description: <><code>&lt;meta name=&quot;description&quot;&gt;</code>, and the default <code>og:description</code>.</> },
        { name: 'metadataBase', type: 'string | URL', description: <>The base for relative URLs in <code>openGraph</code>, <code>twitter</code>, <code>alternates</code> and <code>authors</code>. Its path is kept. Falls back to <code>GIO_SITE_URL</code>; only <code>http</code> and <code>https</code> bases are used.</> },
        { name: 'keywords', type: 'string | string[]', description: <><code>&lt;meta name=&quot;keywords&quot;&gt;</code>, a list joined with <code>, </code>.</> },
        { name: 'authors', type: '{ name?, url? } | Array', description: <><code>&lt;meta name=&quot;author&quot;&gt;</code> per name, <code>&lt;link rel=&quot;author&quot;&gt;</code> per URL.</> },
        { name: 'robots', type: 'string | RobotsMetadata', description: <><code>&lt;meta name=&quot;robots&quot;&gt;</code>: a string as is, or <code>index</code>, <code>follow</code>, <code>noarchive</code>, <code>nosnippet</code>, <code>noimageindex</code>, <code>nocache</code>, <code>max-snippet</code>, <code>max-image-preview</code>, <code>max-video-preview</code>. <code>googleBot</code> renders <code>&lt;meta name=&quot;googlebot&quot;&gt;</code>.</> },
        { name: 'alternates', type: '{ canonical?, languages? }', description: <><code>&lt;link rel=&quot;canonical&quot;&gt;</code>, and one <code>&lt;link rel=&quot;alternate&quot; hreflang&gt;</code> per entry of <code>languages</code> (a locale or <code>x-default</code> to a URL).</> },
        { name: 'openGraph', type: 'OpenGraphMetadata', description: <><code>og:title</code> and <code>og:description</code> (default: the resolved title and description), <code>og:url</code>, <code>og:site_name</code>, <code>og:locale</code>, <code>og:type</code>, and per image <code>og:image</code> with <code>:type</code>, <code>:width</code>, <code>:height</code>, <code>:alt</code>.</> },
        { name: 'twitter', type: 'TwitterMetadata', description: <><code>twitter:card</code> (<code>summary</code>, <code>summary_large_image</code>, <code>app</code>, <code>player</code>), <code>:site</code>, <code>:creator</code>, <code>:title</code>, <code>:description</code>, <code>:image</code> with <code>:alt</code>.</> },
        { name: 'icons', type: 'string | URL | IconDescriptor | Array | { icon?, apple?, shortcut? }', description: <><code>&lt;link rel=&quot;icon&quot;&gt;</code>, <code>apple-touch-icon</code> or <code>shortcut icon</code>, with <code>type</code>, <code>sizes</code>, <code>media</code>, <code>color</code>; a descriptor&apos;s <code>rel</code> overrides the group&apos;s.</> },
        { name: 'manifest', type: 'string | URL', description: <><code>&lt;link rel=&quot;manifest&quot;&gt;</code> (<code>app/manifest.ts</code> serves <code>/manifest.webmanifest</code>).</> },
        { name: 'themeColor', type: 'string | { color, media? } | Array', description: <><code>&lt;meta name=&quot;theme-color&quot;&gt;</code>, one per entry, with <code>media</code> for light and dark.</> },
        { name: 'other', type: 'Record<string, string | number | Array>', description: <>Extra <code>&lt;meta name content&gt;</code> tags, one per value (site verification codes, ...).</> },
      ]} />

      <h3 id="how-segments-merge">How segments merge</h3>
      <ul>
        <li>
          The root layout comes first, then each nested layout down to the page. The merge is
          shallow: the deepest segment that sets a top-level field wins it whole. A page that
          sets <code>openGraph</code> replaces the layout&apos;s entire <code>openGraph</code>{' '}
          object - share common values through a variable.
        </li>
        <li>
          <code>undefined</code> (a field left out) inherits; <code>null</code> removes the
          inherited value.
        </li>
        <li>
          A layout&apos;s <code>title.template</code> never applies to the layout&apos;s own
          title, only to titles set below it.
        </li>
        <li>
          In one module, what <code>generateMetadata</code> returns is merged over the static{' '}
          <code>metadata</code> field by field.
        </li>
      </ul>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The tags render into the <code>&lt;head&gt;</code> on the server, streamed pages
          included, and are replaced on every client-side navigation. Every value is rendered
          by React, so it is HTML-escaped.
        </li>
        <li>
          A metadata title supersedes a <code>&lt;title&gt;</code> a component renders: the
          server HTML keeps only the metadata one, and development mode warns.
        </li>
        <li>
          A URL that should be absolute but stays relative (no <code>metadataBase</code> and
          no <code>GIO_SITE_URL</code>) logs a warning once per route. The request&apos;s{' '}
          <code>Host</code> header is never used as a base: on a cached page a client-chosen
          host would reach every visitor.
        </li>
        <li>
          <code>icons</code> and <code>manifest</code> URLs are not resolved against{' '}
          <code>metadataBase</code>: the browser resolves them against the page.
        </li>
        <li>
          The static <code>metadata</code> export is plain data: a value that is not an object
          is ignored.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="keep-a-page-out-of-search-results">Keep a page out of search results</h3>
      <CodeBlock lang="tsx" title="app/account/page.tsx" code={`import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  title: 'Your account',
  robots: { index: false, follow: true },   // <meta name="robots" content="noindex, follow">
};

export default function Account() {
  return <h1>Your account</h1>;
}`} />

      <h3 id="alternate-languages">Alternate languages</h3>
      <CodeBlock lang="tsx" title="app/pricing/page.tsx" code={`import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  title: 'Pricing',
  alternates: {
    canonical: '/pricing',
    languages: { de: '/de/pricing', 'x-default': '/pricing' },
  },
};

export default function Pricing() {
  return <h1>Pricing</h1>;
}`} />

      <h3 id="a-not-found-page-that-is-not-indexed">A not-found page that is not indexed</h3>
      <CodeBlock lang="tsx" title="app/not-found.tsx" code={`import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = { title: 'Not found', robots: 'noindex' };

export default function NotFound() {
  return <h1>This page does not exist</h1>;
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Hand-written head tags in the root layout other than <code>&lt;title&gt;</code>{' '}
          (charset, viewport, a <code>description</code>) are not deduplicated: declare each
          tag in one place.
        </li>
        <li>
          There is no <code>viewport</code> export, no file-based icons (<code>app/icon.png</code>)
          and no generated Open Graph images (<code>opengraph-image.tsx</code>). Put icons in{' '}
          <code>public/</code> and reference them from <code>icons</code>.
        </li>
        <li>
          For JSON-LD structured data, render <a href="/docs/components/json-ld"><code>&lt;JsonLd&gt;</code></a>{' '}
          in the page.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/metadata">Metadata &amp; SEO</a> - the guide</li>
        <li><a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a></li>
        <li><a href="/docs/file-conventions/sitemap"><code>sitemap.ts</code></a>, <a href="/docs/file-conventions/robots"><code>robots.ts</code></a>, <a href="/docs/file-conventions/manifest"><code>manifest.ts</code></a></li>
        <li><a href="/docs/file-conventions/layout"><code>layout.tsx</code></a>, <a href="/docs/file-conventions/not-found"><code>not-found.tsx</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: 'Introduced.' },
      ]} />
    </>
  );
}
