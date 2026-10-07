import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Styling &amp; Assets</div>
      <h1>CSS & Styling</h1>
      <p className="page-subtitle">
        Import stylesheets and CSS Modules from any page, layout or component. GioJS bundles
        each route&apos;s CSS into content-hashed files and links them for you.
      </p>

      <h2>Global CSS</h2>
      <p>
        Import global stylesheets from the root layout. That is the recommended setup: every
        page, including not-found and error pages, gets them first.
      </p>
      <CodeBlock lang="tsx" code={`// app/layout.tsx
import React from 'react';
import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body>{children}</body>
    </html>
  );
}`} />
      <p>
        Side-effect imports (<code>import &apos;./x.css&apos;</code>) work in any page, layout,
        error/loading file or component. Never add a <code>&lt;link&gt;</code> for an imported
        file: GioJS links it.
      </p>

      <h2>How imported CSS ships</h2>
      <p>
        At startup (and after every change in dev) GioJS follows each route&apos;s imports and
        bundles the CSS it reaches. That covers the page, its layouts and error/loading files,
        the components they use, and the root layout, which never ships to the browser itself.
        Each page links two stylesheets: one shared by every page, holding the root
        layout&apos;s CSS, and one for the route that leaves out whatever the shared one already
        has. Cascade order follows the tree: root layout, then layouts outer to inner, then the
        page, and within a file the order of its imports.
      </p>
      <ul>
        <li>
          Files are served from <code>/_next/static/css/</code> with content-hashed names and{' '}
          <code>Cache-Control: public, max-age=31536000, immutable</code>, and minified in
          production.
        </li>
        <li>
          The links are React stylesheet resources (<code>precedence=&quot;default&quot;</code>),
          so they land in <code>&lt;head&gt;</code>, on streamed pages too. On client navigation
          the next route&apos;s new stylesheets load before it is shown, so it never flashes
          unstyled.
        </li>
        <li>
          <code>url()</code> references to files next to the CSS (images, fonts) are copied
          next to the stylesheet with hashed names. Site-absolute URLs such as{' '}
          <code>url(/public/bg.png)</code> stay as written.
        </li>
        <li>
          CSS that an npm package ships must be imported explicitly, e.g.{' '}
          <code>import &apos;some-lib/dist/styles.css&apos;</code>. GioJS does not look inside
          npm packages&apos; JavaScript for CSS imports.
        </li>
        <li>
          <code>@import</code> inside a stylesheet is bundled too, including a bare package
          name such as <code>@import &quot;modern-normalize&quot;;</code>. The package&apos;s
          stylesheet is found through its <code>style</code> export condition or{' '}
          <code>style</code> field, or else its <code>main</code>. Remote URLs (
          <code>@import url(&quot;https://…&quot;)</code>) and site-absolute paths stay as
          written.
        </li>
      </ul>
      <p>
        Global CSS stays global when you navigate. Once a route&apos;s stylesheet has loaded it
        stays in the page, so a global rule from one route can still apply after navigating to
        another. Keep page-specific styles in CSS Modules.
      </p>

      <h2>CSS Modules</h2>
      <p>
        A file named <code>*.module.css</code> has locally scoped class names. Import its
        default export and use the generated names:
      </p>
      <CodeBlock lang="css" code={`/* app/blog/card.module.css */
.card { padding: 1rem; }
.title { composes: heading from '../shared.module.css'; color: teal; }
:global(.prose) h2 { margin-top: 2rem; }`} />
      <CodeBlock lang="tsx" code={`import styles from './card.module.css';

export default function Card({ title }: { title: string }) {
  return (
    <article className={styles.card}>
      <h2 className={styles.title}>{title}</h2>
    </article>
  );
}`} />
      <p>
        The server render and the browser bundle use exactly the same class names, so pages
        hydrate cleanly. A name has the form <code>card_3fa9c1_title</code>: the file name, a
        hash, and the local name. The hash covers the package the file belongs to (the{' '}
        <code>name</code> in its package.json, plus the version for an installed package) and
        the file&apos;s path inside it. So <code>Button.module.css</code> in your app and in a
        workspace UI package get different names, and a name stays the same across builds and
        machines. Modules are compiled with esbuild&apos;s CSS Modules support, and these are
        its rules:
      </p>
      <ul>
        <li>Class names, ids and <code>@keyframes</code> names are local. Element selectors and attribute selectors are not affected.</li>
        <li><code>:global(.name)</code>, or <code>:global</code> before a selector, keeps the name global. <code>:local(...)</code> marks a name local explicitly.</li>
        <li>
          <code>composes: a b;</code> adds classes from the same file to a class&apos;s exported
          value, and <code>composes: a from &apos;./other.module.css&apos;;</code> adds classes
          from another module. <code>styles.title</code> above is{' '}
          <code>&quot;shared_…_heading card_…_title&quot;</code>.
        </li>
        <li>
          Use the default import (<code>import styles from</code>). Names that are not valid JS
          identifiers are read with brackets: <code>styles[&apos;nav-link&apos;]</code>.
        </li>
        <li>
          CSS Modules need an ES module project (<code>&quot;type&quot;: &quot;module&quot;</code>
          in package.json, which every new GioJS project has). In a CommonJS project, global CSS
          imports still work.
        </li>
      </ul>

      <h3>TypeScript</h3>
      <p>
        At every server start GioJS writes <code>.gio/css-modules.d.ts</code> next to the
        generated <code>.gio/routes.d.ts</code>, which references it. It types{' '}
        <code>import styles from &apos;./x.module.css&apos;</code> as a map of class names to
        strings and lets plain <code>.css</code> imports through:
      </p>
      <CodeBlock lang="ts" code={`declare module '*.module.css' {
  const classes: { readonly [className: string]: string };
  export default classes;
}
declare module '*.css' {}`} />
      <p>
        Projects scaffolded by <code>create-giojs</code> already include{' '}
        <code>.gio/routes.d.ts</code> in their tsconfig. In an existing project, add{' '}
        <code>&quot;.gio/routes.d.ts&quot;</code> to the <code>include</code> array of{' '}
        <code>tsconfig.json</code>. Both files are written when the server starts, so on a fresh
        checkout (in CI, for example) start it once before running <code>tsc</code>. With{' '}
        <code>noUncheckedIndexedAccess</code> on, a class reads as{' '}
        <code>string | undefined</code>, which <code>className</code> accepts.
      </p>

      <h2>Tailwind CSS</h2>
      <p>
        GioJS doesn&apos;t process Tailwind directives itself. Run Tailwind v4&apos;s CLI next to
        the server and import the CSS it generates. You can use{' '}
        <code>npx @tailwindcss/cli</code> or the dependency-free standalone{' '}
        <code>tailwindcss</code> binary. The input file is plain CSS:
      </p>
      <CodeBlock lang="css" code={`/* app/tailwind.css */
@import "tailwindcss";`} />
      <CodeBlock lang="bash" code={`# dev: rebuild the output whenever a class is added
npx @tailwindcss/cli -i ./app/tailwind.css -o ./app/tailwind.out.css --watch

# before deploying (or in CI)
npx @tailwindcss/cli -i ./app/tailwind.css -o ./app/tailwind.out.css --minify`} />
      <CodeBlock lang="tsx" code={`// app/layout.tsx
import './tailwind.out.css';`} />
      <p>
        Tailwind finds class names by scanning your project&apos;s source files. In dev, every
        CLI rebuild changes <code>tailwind.out.css</code>, and that rebuilds the stylesheets and
        reloads the browser. Import the output file, never the input: the bundler doesn&apos;t
        compile <code>@import &quot;tailwindcss&quot;</code>. Run the minify command before{' '}
        <code>gio export</code> or <code>gio build standalone</code> as well, so the output is
        up to date.
      </p>

      <h2>Stylesheets served by path (legacy)</h2>
      <p>
        Linking a stylesheet by URL still works. Files under <code>public/</code> are served
        directly by Rust:
      </p>
      <CodeBlock lang="tsx" code={`<link rel="stylesheet" href="/public/styles/globals.css" />`} />
      <p>
        Every non-module <code>.css</code> file under <code>app/</code> is also transformed (and
        minified in production) once at startup and served from memory at its path:
        app/globals.css answers at <code>/globals.css</code>. Those URLs carry no content hash,
        so they are served with <code>Cache-Control: public, max-age=0, must-revalidate</code>{' '}
        and a strong ETag. Browsers revalidate on each use and get a bodiless 304 while the file
        is unchanged.
      </p>
      <p>
        On cached pages that don&apos;t link imported stylesheets, app/globals.css is also the
        source for critical CSS extraction: the rules a page uses are inlined and the full file
        loads without blocking render. Pages that import CSS skip that step. Their CSS, often
        globals.css itself, is already linked, and loading the file a second time would let it
        override the route&apos;s own rules.
      </p>
      <ul>
        <li>
          Pick one way per file: import it, or link it by path. A file linked both ways loads
          twice, and stylesheets linked by hand in <code>&lt;head&gt;</code> come after the
          imported ones in the cascade.
        </li>
        <li>
          <code>*.module.css</code> files are never served by path. Their class names only
          exist in the import pipeline, so a second copy with different names would be
          useless.
        </li>
      </ul>

      <h2>Dev, export and standalone builds</h2>
      <p>
        In dev, editing any CSS file rebuilds the stylesheets, restarts the worker and reloads
        open tabs. <code>gio export</code> writes the stylesheets to{' '}
        <code>out/_next/static/css/</code>, and <code>gio build standalone</code> ships them in
        the deploy folder&apos;s <code>static/</code>, with the CSS Module class names compiled
        into <code>worker.js</code>. Both link them exactly as the server does.
      </p>
    </>
  );
}
