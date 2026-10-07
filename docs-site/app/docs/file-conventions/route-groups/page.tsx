import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Route Groups',
  description:
    'A folder named (name) organizes routes and scopes a layout to them without adding a segment to their URLs.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Route Groups</h1>
      <p className="page-subtitle">
        A folder named <code>(name)</code> organizes routes and scopes a layout to them
        without adding a segment to their URLs.
      </p>
      <CodeBlock lang="text" code={`app/
  layout.tsx              # the document, for every page
  (marketing)/
    layout.tsx            # wraps /, /pricing
    page.tsx              # /
    pricing/page.tsx      # /pricing
  (app)/
    layout.tsx            # wraps /dashboard, /settings
    error.tsx             # 500 page and error boundary for them only
    dashboard/page.tsx    # /dashboard
    settings/page.tsx     # /settings`} />

      <h2 id="reference">Reference</h2>
      <h3 id="convention">Convention</h3>
      <p>
        A folder whose whole name is wrapped in parentheses, with at least one character and
        no other parentheses inside: <code>(marketing)</code>, <code>(site)</code>,{' '}
        <code>(auth-pages)</code>. It can sit at any depth, and groups can be nested.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>No URL segment.</strong> <code>app/(marketing)/pricing/page.tsx</code>{' '}
          answers <code>/pricing</code>; <code>/marketing/pricing</code> is a 404.
        </li>
        <li>
          <strong>Scoped files.</strong> A <code>layout.tsx</code>, <code>loading.tsx</code>,{' '}
          <code>error.tsx</code> or <code>not-found.tsx</code> in the group applies to the
          routes inside it and to no others, exactly as in any folder.
        </li>
        <li>
          <strong>Everything routes through it.</strong> Pages, <code>route.ts</code> files
          (WebSocket handlers included) and dynamic folders work inside groups.
        </li>
        <li>
          <strong>Conflicts.</strong> Two groups that both answer a URL stop startup:
        </li>
      </ul>
      <CodeBlock lang="text" code={`route conflict: app/(a)/about/page.tsx and app/(b)/about/page.tsx both resolve to "/about" - every URL must be served by exactly one file`} />
      <p>
        The same holds for a page in one group and a <code>route.ts</code> for the same URL in
        another.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="an-interactive-site-layout">An interactive site layout</h3>
      <p>
        The root layout never hydrates, so navigation that should prefetch, soft-navigate or
        keep state lives in a group&apos;s layout. This is how the <code>create-giojs</code>{' '}
        starter is built:
      </p>
      <CodeBlock lang="tsx" title="app/(site)/layout.tsx" code={`import React from 'react';
import type { LayoutProps } from '@gio.js/core';
import { Navbar } from '../../components/Navbar';
import { Footer } from '../../components/Footer';

export default function SiteLayout({ children }: LayoutProps) {
  return (
    <>
      <Navbar />
      <main>{children}</main>
      <Footer />
    </>
  );
}`} />

      <h3 id="pages-without-the-site-chrome">Pages without the site chrome</h3>
      <CodeBlock lang="text" code={`app/
  layout.tsx            # <html><body> only
  (site)/layout.tsx     # navbar + footer
  (site)/page.tsx       # /
  (site)/blog/...       # /blog/...
  (auth)/layout.tsx     # a centered card, no navbar
  (auth)/login/page.tsx # /login`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Unlike Next.js, a group cannot hold a second root layout. Only{' '}
          <code>app/layout.tsx</code> renders the document; a group&apos;s{' '}
          <code>layout.tsx</code> is always a nested layout rendered inside it, so it must not
          render <code>&lt;html&gt;</code> or <code>&lt;body&gt;</code>.
        </li>
        <li>
          A URL that no route answers gets <code>app/not-found.tsx</code>, never a
          group&apos;s: an unmatched URL belongs to no folder. A group&apos;s{' '}
          <code>not-found.tsx</code> is for <code>notFound()</code> calls from its own pages.
        </li>
        <li>
          Moving routes into or out of a group does not change their URLs, so links to them
          keep working.
        </li>
        <li>
          Folder names such as <code>(.)photo</code> or <code>@modal</code> are not special:
          GioJS has no intercepting or parallel routes, and those folders are ordinary URL
          segments.
        </li>
        <li>
          A stylesheet inside a group that is served by path keeps the group in its URL (
          <code>app/(site)/site.css</code> is <code>/(site)/site.css</code>). Import it instead
          (see <a href="/docs/file-conventions/css">CSS files</a>).
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/layouts-and-pages#route-groups">Layouts &amp; Pages: Route groups</a></li>
        <li><a href="/docs/file-conventions/layout">layout.tsx</a>, <a href="/docs/file-conventions/private-folders">Private Folders</a>, <a href="/docs/file-conventions/dynamic-routes">Dynamic Routes</a></li>
        <li><a href="/docs/project-structure">Project Structure</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced: <code>(group)</code> folders no longer appear in URLs, and their layouts and segment files apply only inside them. Overlapping routes stop startup.</> },
      ]} />
    </>
  );
}
