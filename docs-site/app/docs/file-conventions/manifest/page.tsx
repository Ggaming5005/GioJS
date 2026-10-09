import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'manifest.ts',
  description:
    'Generate the web app manifest from code: app/manifest.ts returns the manifest object and GioJS serves it at /manifest.webmanifest.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>manifest.ts</h1>
      <p className="page-subtitle">
        Generate the web app manifest from code: <code>app/manifest.ts</code> returns the
        manifest object and GioJS serves it at <code>/manifest.webmanifest</code>.
      </p>
      <CodeBlock lang="ts" title="app/manifest.ts" code={`import type { MetadataRoute } from '@gio.js/core';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Acme Store',
    short_name: 'Acme',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0f172a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>app/manifest.ts</code> or <code>app/manifest.js</code>, at the root of{' '}
        <code>app/</code> only. It answers <code>/manifest.webmanifest</code>.
      </p>

      <h3 id="exports">Exports</h3>
      <PropsTable kind="Field" rows={[
        {
          name: 'default',
          type: 'Manifest | (() => Manifest | Promise<Manifest>)',
          required: true,
          description: (
            <>
              A Web App Manifest object, or a function returning one. <code>Manifest</code> is{' '}
              <code>Record&lt;string, unknown&gt;</code>: any member the specification defines
              may be used.
            </>
          ),
        },
        {
          name: 'revalidate',
          type: 'number | false',
          default: '3600',
          description: (
            <>
              Seconds the output is cached. <code>false</code> keeps it until the next deploy,{' '}
              <code>0</code> generates it on every request.
            </>
          ),
        },
      ]} />

      <h3 id="response">Response</h3>
      <ul>
        <li>
          <code>200</code>, <code>Content-Type: application/manifest+json; charset=utf-8</code>,
          the object as JSON (indented by two spaces).
        </li>
        <li>
          Only <code>GET</code> and <code>HEAD</code>: other methods get <code>405</code> with{' '}
          <code>Allow: GET, HEAD</code>.
        </li>
        <li>
          Cached by the server for <code>revalidate</code> seconds, with an <code>ETag</code>{' '}
          and no automatic <code>Cache-Control</code>.
        </li>
        <li>
          A result that is not a plain object (an array, <code>null</code>), or a function that
          throws, answers <code>500</code> <code>Internal Server Error (ref &lt;digest&gt;)</code>.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="link-the-manifest-from-every-page">Link the manifest from every page</h3>
      <p>
        Browsers find the manifest through a <code>&lt;link rel=&quot;manifest&quot;&gt;</code>,
        which GioJS does not add by itself. Set it once in the root layout&apos;s metadata:
      </p>
      <CodeBlock lang="tsx" title="app/layout.tsx" code={`import React from 'react';
import type { LayoutProps, Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  title: { default: 'Acme Store', template: '%s | Acme Store' },
  manifest: '/manifest.webmanifest',
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <head />
      <body>{children}</body>
    </html>
  );
}`} />
      <p>
        Every page then carries{' '}
        <code>&lt;link rel=&quot;manifest&quot; href=&quot;/manifest.webmanifest&quot;&gt;</code>.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          GioJS does not check the manifest&apos;s members and does not resolve URLs in it:
          write <code>start_url</code> and icon <code>src</code> values as the browser should
          read them. Icons are ordinary files in <code>public/</code>.
        </li>
        <li>
          A <code>public/manifest.webmanifest</code> wins over <code>app/manifest.ts</code>,
          with a startup warning. A page or <code>route.ts</code> at that URL stops startup.
          A static <code>public/manifest.json</code> is a different URL and does not conflict.
        </li>
        <li>
          <code>gio export</code> writes <code>out/manifest.webmanifest</code> from it.
        </li>
        <li>
          There are no file-based icons (<code>app/icon.png</code>,{' '}
          <code>app/apple-icon.png</code>): use the <code>icons</code> metadata field.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/metadata#sitemapxml-robotstxt-and-the-web-manifest">Metadata &amp; SEO</a> - the guide.</li>
        <li><a href="/docs/file-conventions/sitemap">sitemap.ts</a>, <a href="/docs/file-conventions/robots">robots.ts</a>, <a href="/docs/page-exports/metadata"><code>metadata</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced: <code>app/manifest.ts</code> serves <code>/manifest.webmanifest</code>, on the server, in standalone builds and in <code>gio export</code>.</> },
      ]} />
    </>
  );
}
