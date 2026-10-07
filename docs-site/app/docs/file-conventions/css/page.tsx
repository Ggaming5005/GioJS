import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'CSS files',
  description:
    'How GioJS treats .css files: global stylesheets you import, *.module.css files with local class names, and app/*.css files served by their path.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>CSS files</h1>
      <p className="page-subtitle">
        How GioJS treats <code>.css</code> files: global stylesheets you import,{' '}
        <code>*.module.css</code> files with local class names, and <code>app/*.css</code>{' '}
        files served by their path.
      </p>
      <CodeBlock lang="tsx" title="app/layout.tsx" code={`import React from 'react';
import type { LayoutProps } from '@gio.js/core';
import './globals.css';

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <head />
      <body>{children}</body>
    </html>
  );
}`} />

      <h2 id="reference">Reference</h2>
      <table>
        <thead><tr><th>File</th><th>How you use it</th><th>What GioJS does</th></tr></thead>
        <tbody>
          <tr>
            <td>Any <code>.css</code>, imported</td>
            <td><code>import &apos;./globals.css&apos;</code></td>
            <td>Bundles it into the importing route&apos;s stylesheet and links it in <code>&lt;head&gt;</code></td>
          </tr>
          <tr>
            <td><code>*.module.css</code></td>
            <td><code>import styles from &apos;./card.module.css&apos;</code></td>
            <td>Makes its class names local and returns the map; bundled like the above</td>
          </tr>
          <tr>
            <td>A non-module <code>.css</code> under <code>app/</code></td>
            <td><code>&lt;link href=&quot;/globals.css&quot;&gt;</code></td>
            <td>Also serves it at its path from memory (legacy)</td>
          </tr>
        </tbody>
      </table>

      <h3 id="global-css-imports">Global CSS imports</h3>
      <ul>
        <li>
          A side-effect import works in any page, layout, <code>loading</code>,{' '}
          <code>error</code> or <code>not-found</code> file, and in the components they use.
          Import site-wide styles from the root layout.
        </li>
        <li>
          When the worker starts, GioJS follows each route&apos;s imports and bundles the CSS
          it reaches with esbuild. Every page links up to two stylesheets: one shared by all
          pages with the root layout&apos;s CSS, and one for the route without what the shared
          one already holds (left out when there is nothing left). The cascade follows the tree: root layout, then layouts outer to
          inner, then the page, each file in import order.
        </li>
        <li>
          The files go to <code>.gio/build/static/css/</code> and are served from{' '}
          <code>/_next/static/css/</code> with content-hashed names and{' '}
          <code>Cache-Control: public, max-age=31536000, immutable</code>. Production output is
          minified unless <code>[css] minify = false</code>.
        </li>
        <li>
          <code>@import</code> is bundled, a bare package name included (
          <code>@import &quot;modern-normalize&quot;;</code>), and files referenced with{' '}
          <code>url()</code> next to the CSS are copied with hashed names.
        </li>
        <li>
          The links are React stylesheet resources: they land in <code>&lt;head&gt;</code>,
          and on client navigation the next route&apos;s stylesheets load before it is shown.
          Never add a <code>&lt;link&gt;</code> for an imported file yourself.
        </li>
      </ul>

      <h3 id="css-modules">CSS Modules</h3>
      <ul>
        <li>
          A file named <code>*.module.css</code> has local class names, ids and{' '}
          <code>@keyframes</code>. Its default export maps each local name to the generated
          one: <code>.title</code> in <code>card.module.css</code> becomes{' '}
          <code>card_3fa9c1_title</code>.
        </li>
        <li>
          The names are the same on the server and in the browser, and stable across builds
          and machines (the hash covers the owning package&apos;s name and the file&apos;s path
          in it), so pages hydrate cleanly and stylesheet URLs stay cacheable.
        </li>
        <li>
          <code>:global(...)</code>, <code>composes: a b;</code> and{' '}
          <code>composes: a from &apos;./other.module.css&apos;;</code> follow esbuild&apos;s
          rules. Use the default import; names that are not identifiers are read with brackets
          (<code>styles[&apos;nav-link&apos;]</code>).
        </li>
        <li>
          TypeScript types come from <code>.gio/css-modules.d.ts</code> (see{' '}
          <a href="/docs/file-conventions/gio-directory">.gio/</a>). CSS Modules need an ES
          module project (<code>&quot;type&quot;: &quot;module&quot;</code>, which every new
          project has).
        </li>
      </ul>

      <h3 id="stylesheets-served-by-path">Stylesheets served by path</h3>
      <ul>
        <li>
          Every <code>.css</code> file under <code>app/</code> except <code>*.module.css</code>{' '}
          is transformed with Lightning CSS when the server starts and served from memory at
          its path inside <code>app/</code>: <code>app/globals.css</code> at{' '}
          <code>/globals.css</code>, <code>app/_styles/print.css</code> at{' '}
          <code>/_styles/print.css</code>. Private folders and route groups get no special
          treatment here.
        </li>
        <li>
          The URLs have no content hash, so they are sent with{' '}
          <code>Cache-Control: public, max-age=0, must-revalidate</code> and a strong{' '}
          <code>ETag</code>: browsers revalidate on each use and get a <code>304</code> while
          the file is unchanged.
        </li>
        <li>
          On cached pages that link no imported stylesheet, <code>app/globals.css</code> is
          also the source for critical CSS: the rules the page uses are inlined and the file
          loads without blocking render (<code>[css] critical_extraction</code>).
        </li>
        <li>
          <a href="/docs/configuration/css"><code>[css] enabled = false</code></a> turns path
          serving off. It does not affect imported CSS, which is part of the module graph and
          always bundled.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-css-module-in-a-component">A CSS Module in a component</h3>
      <CodeBlock lang="css" title="components/card.module.css" code={`.card {
  padding: 1rem;
  border-radius: 8px;
}
.title {
  composes: heading from './typography.module.css';
  color: teal;
}`} />
      <CodeBlock lang="tsx" title="components/Card.tsx" code={`import React from 'react';
import styles from './card.module.css';

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className={styles.card}>
      <h2 className={styles.title}>{title}</h2>
      {children}
    </article>
  );
}`} />

      <h3 id="css-from-an-npm-package">CSS from an npm package</h3>
      <CodeBlock lang="tsx" title="app/layout.tsx" code={`import React from 'react';
import type { LayoutProps } from '@gio.js/core';
import 'modern-normalize/modern-normalize.css';
import './globals.css';

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <head />
      <body>{children}</body>
    </html>
  );
}`} />
      <p>
        GioJS does not look inside npm packages&apos; JavaScript for CSS imports, so a
        component library&apos;s stylesheet is imported explicitly.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Pick one way per file: import it or link it by path. A file used both ways loads
          twice.
        </li>
        <li>
          <code>*.module.css</code> files are never served by path (a request for one is a{' '}
          <code>404</code>): their class names exist only in the import pipeline.
        </li>
        <li>
          Global CSS stays global after navigation: once a route&apos;s stylesheet has loaded,
          it stays in the document. Keep page-specific styles in CSS Modules.
        </li>
        <li>
          In development a change to any CSS file rebuilds the stylesheets, restarts the
          worker and reloads open tabs. <code>gio export</code> and{' '}
          <code>gio build standalone</code> ship the same stylesheets and class names.
        </li>
        <li>
          There is no Sass, Less or PostCSS step. Tailwind runs as its own CLI next to the
          server; see the <a href="/docs/guides/tailwind">Tailwind guide</a>.
        </li>
        <li>
          Stylesheets in <code>public/</code> are plain <a href="/docs/file-conventions/public-folder">static files</a>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/css">CSS &amp; Styling</a> - the guide.</li>
        <li><a href="/docs/configuration/css"><code>[css]</code></a> - <code>enabled</code>, <code>minify</code>, <code>critical_extraction</code>.</li>
        <li><a href="/docs/file-conventions/layout">layout.tsx</a>, <a href="/docs/file-conventions/gio-directory">.gio/</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>CSS imports and CSS Modules: per-route, content-hashed, minified stylesheets linked in <code>&lt;head&gt;</code>; <code>.gio/css-modules.d.ts</code>. Path-served stylesheets revalidate with an <code>ETag</code> instead of being cached for a year; CSS Module files are no longer served by path. <code>[css] minify</code> also covers the bundled stylesheets.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced: <code>app/</code> stylesheets transformed with Lightning CSS at startup and served from memory, with critical CSS extraction.</> },
      ]} />
    </>
  );
}
