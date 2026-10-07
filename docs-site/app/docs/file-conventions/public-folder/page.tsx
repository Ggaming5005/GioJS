import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'public/',
  description:
    'Static files the Rust server serves as they are, at the site root and under /public/, before any page renders.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>public/</h1>
      <p className="page-subtitle">
        Static files the Rust server serves as they are, at the site root and under{' '}
        <code>/public/</code>, before any page renders.
      </p>
      <CodeBlock lang="text" code={`public/
  favicon.ico                 /favicon.ico               and /public/favicon.ico
  robots.txt                  /robots.txt                and /public/robots.txt
  images/hero.webp            /images/hero.webp          and /public/images/hero.webp
  .well-known/security.txt    /.well-known/security.txt  and /public/.well-known/security.txt`} />

      <h2 id="reference">Reference</h2>
      <h3 id="location">Location</h3>
      <p>
        The <code>public/</code> folder next to <code>app/</code>.{' '}
        <code>GIO_PUBLIC_DIR</code> points the server at another directory.
      </p>

      <h3 id="urls">URLs</h3>
      <table>
        <thead><tr><th>URL</th><th>What is served</th><th>Caching</th></tr></thead>
        <tbody>
          <tr>
            <td>The site root: <code>public/a/b.png</code> at <code>/a/b.png</code></td>
            <td>Regular files, <code>GET</code> and <code>HEAD</code> only, except dotfiles (other than the top-level <code>.well-known/</code>), symlinks and a top-level <code>public/_gio/</code></td>
            <td><code>Cache-Control: public, max-age=0, must-revalidate</code> and <code>Last-Modified</code></td>
          </tr>
          <tr>
            <td><code>/public/</code> + the path: <code>/public/a/b.png</code></td>
            <td>Every file in the folder, dotfiles included</td>
            <td><code>Last-Modified</code>, no <code>Cache-Control</code></td>
          </tr>
        </tbody>
      </table>
      <p>
        Both answer conditional and range requests, with a <code>Content-Type</code> from the
        file extension, and <code>X-Gio-Cache: static</code>. Neither ever reaches the Node
        worker or the page cache.
      </p>

      <h3 id="precedence">Precedence</h3>
      <ul>
        <li>
          A file at the site root wins over a page or <code>route.ts</code> with the same path:
          the server answers before routing.
        </li>
        <li>
          It also wins over <a href="/docs/file-conventions/sitemap">app/sitemap.ts</a>,{' '}
          <a href="/docs/file-conventions/robots">app/robots.ts</a> and{' '}
          <a href="/docs/file-conventions/manifest">app/manifest.ts</a>, which then never run;
          startup warns about each.
        </li>
        <li>
          Guards, header rules and <code>[[rate_limits]]</code> written for a file&apos;s{' '}
          <code>/public/...</code> URL also apply at its root URL, so protecting{' '}
          <code>/public/members/*rest</code> protects <code>/members/...</code> too.
        </li>
      </ul>

      <h3 id="the-root-index">The root index</h3>
      <p>
        Which files answer at the root is decided by an index the server builds at startup,
        so a request never costs a filesystem lookup. In development, changes under{' '}
        <code>public/</code> refresh it and reload open browser tabs (the worker does not
        restart). In production a file added after startup answers under{' '}
        <code>/public/</code> right away and at the root after the next restart. The index
        holds up to 100,000 files; any beyond that are served under <code>/public/</code> only.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="favicon-and-touch-icon">A favicon and a touch icon</h3>
      <CodeBlock lang="tsx" title="app/layout.tsx" code={`import React from 'react';
import type { LayoutProps, Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
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
        With <code>public/favicon.ico</code> and <code>public/apple-touch-icon.png</code> in
        place, browsers that request <code>/favicon.ico</code> without reading the page find
        it too.
      </p>

      <h3 id="optimized-images-from-public">Optimized images from public/</h3>
      <CodeBlock lang="tsx" code={`import { GioImage } from '@gio.js/react';

<GioImage src="/images/hero.webp" alt="" width={1200} height={600} priority />`} />
      <p>
        <a href="/docs/components/gio-image"><code>&lt;GioImage&gt;</code></a> resizes files
        from <code>public/</code> through <code>/_gio/image</code>; <code>src</code> may be the
        root URL or the <code>/public/</code> one.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Everything in <code>public/</code> is public.</strong> Dotfiles are kept off
          the root, but stay reachable under <code>/public/</code>: never put{' '}
          <code>.env</code> files, keys or backups there.
        </li>
        <li>
          File names carry no content hash, so browsers revalidate root files on every use. For
          assets that should be cached for a year, reference them from CSS (
          <code>url(./bg.png)</code> next to an imported stylesheet is copied with a hashed
          name) or put a version in the file name.
        </li>
        <li>
          Directory listings are never served, and <code>public/index.html</code> does not
          answer <code>/</code>.
        </li>
        <li>
          <code>gio export</code> copies the folder to <code>out/</code> and{' '}
          <code>out/public/</code>, so static hosts serve the same URLs; a file whose output
          path a rendered page needs is skipped, and the export says so.{' '}
          <code>gio build standalone</code> ships the folder in the deploy directory.
        </li>
        <li>
          Local <code>[[fonts]]</code> are read from <code>public/</code> (
          <code>url = &quot;/public/fonts/inter.woff2&quot;</code>) and served from{' '}
          <code>/_gio/fonts/</code> under a content-hashed name.
        </li>
        <li>
          A path with an encoded slash (<code>%2F</code>) or backslash under{' '}
          <code>/public/</code> is refused with <code>400</code>, and never matches a root
          file: the rules for <code>/members/*rest</code> could not see it.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/project-structure#public">Project Structure: public/</a></li>
        <li><a href="/docs/middleware#public-files-at-the-site-root">Middleware: public/ files at the site root</a></li>
        <li><a href="/docs/deployment#static-files">Deployment: static files</a></li>
        <li><a href="/docs/image-optimization">Images</a>, <a href="/docs/font-optimization">Fonts</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Files are also served at the site root, ahead of pages, with <code>max-age=0, must-revalidate</code>; dotfiles (except <code>.well-known/</code>), symlinks and <code>public/_gio/</code> stay off the root. The folder defaults to the one next to <code>app/</code>. Rules for <code>/public/...</code> URLs cover the root URLs.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced: files served under <code>/public/</code>.</> },
      ]} />
    </>
  );
}
