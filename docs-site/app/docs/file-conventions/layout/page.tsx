import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'layout.tsx',
  description:
    'UI shared by every page in a folder and the folders below it. The root layout renders the HTML document.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>layout.tsx</h1>
      <p className="page-subtitle">
        UI shared by every page in a folder and the folders below it. The root layout renders
        the HTML document.
      </p>
      <CodeBlock lang="tsx" title="app/dashboard/layout.tsx" code={`import React from 'react';
import type { LayoutProps } from '@gio.js/core';

export default function DashboardLayout({ children }: LayoutProps) {
  return (
    <div className="dashboard">
      <nav>{/* sidebar */}</nav>
      <main>{children}</main>
    </div>
  );
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>layout.tsx</code>, <code>layout.jsx</code> or <code>layout.js</code> (in that
        order of precedence), in <code>app/</code> or any folder below it except{' '}
        <a href="/docs/file-conventions/private-folders">private folders</a>. A layout wraps
        every page in its own folder and in all the folders below it.
      </p>

      <h3 id="props">Props</h3>
      <PropsTable rows={[
        {
          name: 'children',
          type: 'React.ReactNode',
          required: true,
          description: 'The page, wrapped in this folder\'s error and loading boundaries and in everything the folders below add.',
        },
        {
          name: 'path',
          type: 'string',
          description: (
            <>
              The request path without the query string (<code>/dashboard/settings</code>),
              for example to mark the active link. With i18n it is the path after the locale
              prefix was removed.
            </>
          ),
        },
      ]} />
      <p>
        Type them with <code>LayoutProps</code> from <code>@gio.js/core</code>. Layouts get no{' '}
        <code>params</code> prop and have no <code>getServerSideProps</code>: read the route&apos;s
        params with <a href="/docs/hooks/use-params"><code>useParams()</code></a> and load data
        in the page.
      </p>

      <h3 id="module-exports">Module exports</h3>
      <table>
        <thead><tr><th>Export</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>default</code> (required)</td><td>The layout component.</td></tr>
          <tr><td><a href="/docs/page-exports/metadata"><code>metadata</code></a></td><td>Head tags for every page below; a page&apos;s own fields win.</td></tr>
          <tr><td><a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a></td><td>The same, computed per request from the route&apos;s params.</td></tr>
        </tbody>
      </table>

      <h3 id="nesting">How layouts nest</h3>
      <p>
        Layouts follow the folder tree, not the URL. A page gets the layout of{' '}
        <code>app/</code> and of every folder from there down to its own, outermost first.
        That includes <a href="/docs/file-conventions/route-groups">route groups</a> and{' '}
        <a href="/docs/file-conventions/dynamic-routes">dynamic folders</a>. Inside each
        folder the layout wraps that folder&apos;s error and loading boundaries:
      </p>
      <CodeBlock lang="text" code={`app/layout.tsx              <html><body>              server-only
  app/(shop)/layout.tsx       <ShopLayout>            hydrated
    app/(shop)/error.tsx        <ErrorBoundary>
      app/(shop)/loading.tsx      <Suspense>
        app/(shop)/cart/page.tsx    <Cart />`} />

      <h3 id="root-layout">The root layout</h3>
      <p>
        <code>app/layout.tsx</code> renders the document: <code>&lt;html&gt;</code>,{' '}
        <code>&lt;head&gt;</code> and <code>&lt;body&gt;</code>. It is different from every
        other layout:
      </p>
      <ul>
        <li>
          <strong>It never hydrates.</strong> It stays server-rendered HTML around the
          hydrated region (<code>&lt;div id=&quot;__gio&quot;&gt;</code>). State, effects and
          event handlers in it do nothing in the browser, a{' '}
          <a href="/docs/components/gio-link"><code>&lt;GioLink&gt;</code></a> in it is a plain
          link, and UI that depends on the URL is not updated on soft navigation. Put
          navigation bars and other interactive chrome in a nested layout, such as a route
          group&apos;s.
        </li>
        <li>
          <strong>It is optional.</strong> Without it, GioJS writes a minimal document (
          <code>&lt;!DOCTYPE html&gt;&lt;html&gt;&lt;head&gt;&lt;meta charset=&quot;utf-8&quot;&gt;</code>{' '}
          and a body) with the metadata tags in the head. It has no viewport tag, so most apps
          want their own.
        </li>
        <li>
          <strong>Its CSS is shared.</strong> Stylesheets imported in the root layout go into
          one stylesheet every page links first, not-found and error pages included (see{' '}
          <a href="/docs/file-conventions/css">CSS files</a>).
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-root-layout">A root layout</h3>
      <CodeBlock lang="tsx" title="app/layout.tsx" code={`import React from 'react';
import type { LayoutProps, Metadata } from '@gio.js/core';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Acme', template: '%s | Acme' },
  description: 'Acme makes things.',
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  );
}`} />

      <h3 id="active-links-in-a-hydrated-layout">Active links in a hydrated layout</h3>
      <p>
        A nested layout hydrates and stays mounted while the user moves between the pages it
        wraps, so <code>usePathname()</code> keeps the active link in sync on every soft
        navigation.
      </p>
      <CodeBlock lang="tsx" title="app/(site)/layout.tsx" code={`import React from 'react';
import { GioLink, usePathname } from '@gio.js/react';
import type { LayoutProps } from '@gio.js/core';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/blog', label: 'Blog' },
  { href: '/about', label: 'About' },
];

export default function SiteLayout({ children }: LayoutProps) {
  const pathname = usePathname();
  return (
    <>
      <nav>
        {LINKS.map((link) => (
          <GioLink
            key={link.href}
            href={link.href}
            aria-current={pathname === link.href ? 'page' : undefined}
          >
            {link.label}
          </GioLink>
        ))}
      </nav>
      <main>{children}</main>
    </>
  );
}`} />

      <h3 id="a-layout-inside-a-dynamic-folder">A layout inside a dynamic folder</h3>
      <CodeBlock lang="tsx" title="app/teams/[team]/layout.tsx" code={`import React from 'react';
import { useParams } from '@gio.js/react';
import type { LayoutProps } from '@gio.js/core';

export default function TeamLayout({ children }: LayoutProps) {
  const { team } = useParams<'/teams/:team'>();
  return (
    <section>
      <h2>Team {team}</h2>
      {children}
    </section>
  );
}`} />
      <p>
        It wraps <code>/teams/a</code>, <code>/teams/a/members</code> and every other page
        under <code>app/teams/[team]/</code>. Going from <code>/teams/a</code> to{' '}
        <code>/teams/b</code> mounts it fresh, so state from team a never shows under team b.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Layouts that two pages share keep their state when the user navigates between those
          pages. A layout below a dynamic folder remounts when that segment&apos;s value
          changes.
        </li>
        <li>
          An error thrown by a layout is not caught by the <code>error.tsx</code> in the same
          folder: that boundary sits inside the layout. The <code>error.tsx</code> of a folder
          above handles it (see <a href="/docs/file-conventions/error">error.tsx</a>).
        </li>
        <li>
          <code>not-found.tsx</code> and <code>error.tsx</code> pages render inside the
          layouts of their own folder, never those of the page that failed.
        </li>
        <li>
          Every nested layout ships in the client bundle of each page below it, so it must be
          browser-safe: no secrets, no <code>node:*</code> imports.
        </li>
        <li>
          There is no <code>template.tsx</code> in GioJS. To reset a subtree on every
          navigation, key it yourself (<code>{'<Section key={pathname}>'}</code>).
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/layouts-and-pages">Layouts &amp; Pages</a> - the guide.</li>
        <li><a href="/docs/file-conventions/page">page.tsx</a>, <a href="/docs/file-conventions/loading">loading.tsx</a>, <a href="/docs/file-conventions/error">error.tsx</a>, <a href="/docs/file-conventions/route-groups">Route Groups</a></li>
        <li><a href="/docs/metadata">Metadata &amp; SEO</a> - how layout and page metadata merge.</li>
        <li><a href="/docs/hooks/use-pathname"><code>usePathname</code></a> and <a href="/docs/hooks/use-params"><code>useParams</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Layouts follow the folder tree, so layouts inside dynamic folders and route groups apply; nested layouts keep their state across soft navigations. <code>metadata</code> and <code>generateMetadata</code> exports. <code>LayoutProps</code> type.</> },
        { version: 'v0.1.0-beta.5', changes: 'Nested layouts hydrate with the page; the root layout stays server-rendered.' },
        { version: 'v0.1.0-beta.1', changes: <>Introduced, as <code>layout.tsx</code>, <code>layout.jsx</code> or <code>layout.js</code>.</> },
      ]} />
    </>
  );
}
