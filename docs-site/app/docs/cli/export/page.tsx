import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio export',
  description:
    'Render every page of a GioJS app to static HTML in out/, with the client chunks that ' +
    'hydrate it, for any static host.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio export</h1>
      <p className="page-subtitle">
        Render every page of a GioJS app to static HTML in <code>out/</code>, with the client
        chunks that hydrate it, for any static host.
      </p>
      <PmTabs command={`npx gio export`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>gio export</code> takes no options besides <code>-h</code> /{' '}
        <code>--help</code>. It is configured through the environment:
      </p>
      <PropsTable kind="Option" rows={[
        {
          name: 'GIO_APP_DIR',
          type: 'path',
          default: './app',
          description: 'The app directory. The project root (public/, .env files) is its parent.',
        },
        {
          name: 'GIO_OUT_DIR',
          type: 'path',
          default: './out',
          description: 'Where the site is written.',
        },
        {
          name: 'NODE_ENV',
          type: 'string',
          default: 'production',
          description: <><code>development</code> exports with React&apos;s development build and the <code>.env.development*</code> files; anything else (or unset) is production. Use production for anything you publish: the development build writes error details into the HTML.</>,
        },
        {
          name: 'GIO_SITE_URL',
          type: 'URL',
          description: <>The site&apos;s origin (<code>https://example.com</code>). Makes the generated <code>sitemap.xml</code> possible and adds its URL to the generated <code>robots.txt</code>. Relative URLs that <code>app/sitemap.ts</code> or <code>app/robots.ts</code> return are resolved against it.</>,
        },
        {
          name: 'GIO_ENV_FILES',
          type: '0 | 1',
          description: <><code>0</code> or <code>false</code> loads no <code>.env</code> files; <code>1</code> or <code>true</code> loads them even when <code>[env] files = false</code>.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Loads the project&apos;s <code>.env</code> files with the server&apos;s precedence
          (variables already set win). <code>GIO_PUBLIC_*</code> values are frozen into the
          output.
        </li>
        <li>
          Renders each page through the same pipeline the server uses, running{' '}
          <code>getServerSideProps</code> at export time. A dynamic route is exported once per
          entry of its <code>getStaticPaths()</code>; without one it is skipped.
        </li>
        <li>
          Writes <code>out/&lt;path&gt;/index.html</code> per page,{' '}
          <code>out/404.html</code> (from <code>app/not-found</code>, or the built-in page),
          the client chunks under <code>out/_next/static/chunks/</code> and the stylesheets
          under <code>out/_next/static/css/</code>. Each page carries its props as JSON and
          hydrates, so <code>GioLink</code> navigation works on a static host.
        </li>
        <li>
          Copies <code>public/</code> to the root of <code>out/</code> and to{' '}
          <code>out/public/</code>, as the server serves it. A rendered page wins over a{' '}
          <code>public/</code> file with the same output path.
        </li>
        <li>
          Writes <code>app/sitemap.*</code>, <code>app/robots.*</code> and{' '}
          <code>app/manifest.*</code> as <code>sitemap.xml</code>, <code>robots.txt</code>{' '}
          and <code>manifest.webmanifest</code>, unless <code>public/</code> has the same
          file. Without them it generates a <code>robots.txt</code> that allows everything,
          and a <code>sitemap.xml</code> of every exported page when{' '}
          <code>GIO_SITE_URL</code> is set.
        </li>
        <li>
          Never starts the Rust server, so it works without the platform binary. Route
          handlers, WebSockets, middleware rules, image optimization and the page cache need
          the server and are not part of the export.
        </li>
      </ul>
      <p>The summary lists what was written, what ships without client JS, and what was skipped:</p>
      <CodeBlock lang="text" code={`[giojs] loaded env: .env.production
[giojs] static export: /home/me/site/app → /home/me/site/out

[giojs] rendered 6 page(s):
   ✓ / (index)
   ✓ /about
   ✓ /blog
   ✓ /posts/1
   ✓ /posts/2
   ✓ /posts/3

[giojs] skipped 1:
   - /drafts/:id  -  dynamic route without getStaticPaths()

[giojs] ✔ static export complete → /home/me/site/out
[giojs]   deploy the out/ folder to any static host (Cloudflare Pages, GitHub Pages, …)`} />
      <p>Reasons a page is skipped:</p>
      <table>
        <thead>
          <tr><th>Reason</th><th>Why</th></tr>
        </thead>
        <tbody>
          <tr><td><code>dynamic route without getStaticPaths()</code></td><td>The export cannot know which params to render.</td></tr>
          <tr><td><code>render error: ... (ref ..., details in the error log)</code></td><td>The page threw; the reference matches the logged line with the real message and stack.</td></tr>
          <tr><td><code>redirect (307) - server only</code></td><td>A redirect needs a server to answer it.</td></tr>
          <tr><td><code>notFound() - nothing written</code></td><td>The page called <code>notFound()</code>.</td></tr>
          <tr><td><code>streaming/SSE route - server only</code></td><td>An event stream cannot be a file.</td></tr>
        </tbody>
      </table>

      <h2 id="examples">Examples</h2>
      <h3 id="export-with-a-sitemap">Export with a sitemap</h3>
      <CodeBlock lang="bash" code={`GIO_SITE_URL=https://example.com npx gio export`} />

      <h3 id="export-to-another-directory">Export to another directory</h3>
      <CodeBlock lang="bash" code={`GIO_OUT_DIR=dist npx gio export`} />

      <h3 id="a-static-site-build-script">A static site&apos;s build script</h3>
      <CodeBlock lang="json" title="package.json" code={`{
  "scripts": {
    "build": "tsc --noEmit && gio export"
  }
}`} />
      <p>
        <code>npm create giojs@latest -- --static</code> writes this script; a type error
        stops the build before the export.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The exit code is <code>0</code> even when pages were skipped: read the summary, or
          check that the files you expect exist in CI. It is <code>1</code> when{' '}
          <code>@gio.js/core</code> or <code>tsx</code> is missing, a <code>.env</code> file
          cannot be parsed, or the export crashes (a route conflict, for example).
        </li>
        <li>
          <code>out/</code> is not emptied first: files from an earlier export that this one
          does not write stay there. Delete it in your build script if pages can disappear.
        </li>
        <li>
          Never return secrets from <code>getServerSideProps</code> of an exported page: the
          props are in the HTML.
        </li>
        <li>
          <code>&lt;GioImage&gt;</code> renders a plain <code>src</code> in an export (there is
          no optimizer on a static host).
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/static-export">Static Export</a> - the guide</li>
        <li><a href="/docs/cli/build-standalone"><code>gio build standalone</code></a> when you need the server</li>
        <li><a href="/docs/guides/environment-variables">Environment Variables</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Pages hydrate (client chunks and props are exported), stylesheets and CSS Modules ship, <code>public/</code> is copied to the root, <code>.env</code> files load, <code>NODE_ENV</code> defaults to production, <code>app/sitemap</code> / <code>robots</code> / <code>manifest</code> are written, and failed routes are listed with their error reference.</>,
        },
        { version: 'v0.1.0-beta.3', changes: <>Generates <code>robots.txt</code> and, with <code>GIO_SITE_URL</code>, <code>sitemap.xml</code>.</> },
        { version: 'v0.1.0-beta.2', changes: 'Introduced.' },
      ]} />
    </>
  );
}
