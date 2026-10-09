import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'usePathname',
  description:
    "Read the path of the current page - without query, hash or locale prefix - on the server and in the browser.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>usePathname</h1>
      <p className="page-subtitle">
        Read the path of the current page - without query, hash or locale prefix - on the server
        and in the browser.
      </p>
      <CodeBlock lang="tsx" code={`import { usePathname } from '@gio.js/react';

export function Breadcrumb() {
  const pathname = usePathname(); // '/blog/hello-world'
  return <p>You are at {pathname}</p>;
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <p><code>usePathname</code> takes no parameters.</p>
      <h3 id="returns">Returns</h3>
      <p>
        A <code>string</code>: the path the page was rendered for, starting with{' '}
        <code>/</code>.
      </p>
      <table>
        <thead><tr><th>URL</th><th><code>usePathname()</code></th></tr></thead>
        <tbody>
          <tr><td><code>/</code></td><td><code>&apos;/&apos;</code></td></tr>
          <tr><td><code>/blog/hello?tab=comments#top</code></td><td><code>&apos;/blog/hello&apos;</code></td></tr>
          <tr><td><code>/fr/about</code> (with <code>[i18n]</code> locales <code>en</code>, <code>fr</code>)</td><td><code>&apos;/about&apos;</code></td></tr>
          <tr><td><code>/docs</code> rewritten to <code>/help</code> by a <code>[[rewrites]]</code> rule</td><td><code>&apos;/help&apos;</code></td></tr>
          <tr><td><code>/blog/caf%C3%A9</code></td><td><code>&apos;/blog/caf%C3%A9&apos;</code></td></tr>
        </tbody>
      </table>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The value comes from the route the server matched. The server render and the
          hydration render read the same value, so there is never a hydration mismatch.
        </li>
        <li>
          After a soft navigation, every hydrated component reads the new page&apos;s path. After
          a redirect it is where the redirect landed.
        </li>
        <li>
          In a <code>not-found.tsx</code> or <code>error.tsx</code> page it is the path that was
          requested.
        </li>
        <li>
          Outside a tree GioJS rendered (a component rendered by a unit test or in a separate
          React root) it falls back to <code>window.location.pathname</code>, and{' '}
          <code>&apos;/&apos;</code> on the server.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>

      <h3 id="marking-the-active-link">Marking the active link</h3>
      <CodeBlock lang="tsx" title="app/(site)/nav.tsx" code={`import { GioLink, usePathname } from '@gio.js/react';

export function Nav() {
  const pathname = usePathname();
  const link = (href: string, label: string) => (
    <GioLink href={href} aria-current={pathname === href ? 'page' : undefined}>
      {label}
    </GioLink>
  );
  return (
    <nav>
      {link('/', 'Home')}
      {link('/pricing', 'Pricing')}
    </nav>
  );
}`} />

      <h3 id="tracking-page-views">Tracking page views</h3>
      <p>
        The effect runs on the first render in the browser and again after every navigation to
        another path. <code>sendBeacon</code> rather than a <code>POST</code>{' '}
        <code>fetch()</code>: the router treats every same-origin <code>fetch()</code> mutation
        as a change and empties its prefetch cache.
      </p>
      <CodeBlock lang="tsx" title="app/(site)/analytics.tsx" code={`import { useEffect } from 'react';
import { usePathname } from '@gio.js/react';

export function Analytics() {
  const pathname = usePathname();
  useEffect(() => {
    navigator.sendBeacon('/api/page-view', JSON.stringify({ path: pathname }));
  }, [pathname]);
  return null;
}`} />
      <p>
        Code outside React can listen for the <code>gio:navigated</code> event on{' '}
        <code>window</code> instead, which the router dispatches each time it renders a page in
        place (links, back and forward, form answers).
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>In the root layout it never updates.</strong> <code>app/layout.tsx</code> is
          server-only HTML that a soft navigation does not re-render, so there the value stays
          that of the page loaded in full. Read it in a route group&apos;s layout or a page.
        </li>
        <li>
          Escapes in the path are kept as the server canonicalized it: unreserved characters are
          decoded, everything else stays percent-encoded (<code>%20</code>,{' '}
          <code>%C3%A9</code>). Decode with <code>decodeURIComponent</code> before showing it.
        </li>
        <li>
          A trailing slash in the URL is kept (<code>/blog/</code>), although the router ignores
          it when it matches the route.
        </li>
        <li>
          With <code>[i18n]</code>, combine it with{' '}
          <a href="/docs/hooks/use-locale"><code>useLocale()</code></a> to rebuild the prefixed
          URL.
        </li>
        <li>
          A <code>route.ts</code> handler has no hook: read <code>req.path</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/linking-and-navigating#router-hooks">Linking &amp; Navigating</a> - the router hooks together.</li>
        <li><a href="/docs/hooks/use-params"><code>useParams</code></a>, <a href="/docs/hooks/use-search-params"><code>useSearchParams</code></a> - the rest of the URL.</li>
        <li><a href="/docs/hooks/use-router"><code>useRouter</code></a> - navigate from code.</li>
        <li><a href="/docs/components/gio-link"><code>&lt;GioLink&gt;</code></a> - links that navigate on the client.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
