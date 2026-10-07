import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'loading.tsx',
  description:
    'A Suspense fallback for a folder and everything below it: a streamed page sends it first while the content suspends.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>loading.tsx</h1>
      <p className="page-subtitle">
        A Suspense fallback for a folder and everything below it: a streamed page sends it
        first while the content suspends.
      </p>
      <CodeBlock lang="tsx" title="app/dashboard/loading.tsx" code={`import React from 'react';

export default function Loading() {
  return <p aria-busy="true">Loading dashboard…</p>;
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>loading.tsx</code>, <code>loading.jsx</code> or <code>loading.js</code>, in{' '}
        <code>app/</code> or any folder below it (route groups and dynamic folders included,
        private folders never). It covers its own folder and every folder below it; a deeper{' '}
        <code>loading.tsx</code> adds a boundary of its own inside it.
      </p>

      <h3 id="props">Props</h3>
      <p>
        None. The default export is rendered as <code>&lt;Loading /&gt;</code>. Read the URL
        with <a href="/docs/hooks/use-pathname"><code>usePathname()</code></a> or{' '}
        <a href="/docs/hooks/use-params"><code>useParams()</code></a> if the fallback needs it.
      </p>

      <h3 id="behavior">Behavior</h3>
      <p>
        GioJS wraps the folder&apos;s content in{' '}
        <code>{'<Suspense fallback={<Loading />}>'}</code>, inside the folder&apos;s layout and
        its <code>error.tsx</code> boundary:
      </p>
      <CodeBlock lang="text" code={`<DashboardLayout>        app/dashboard/layout.tsx
  <ErrorBoundary>        app/dashboard/error.tsx
    <Suspense>           app/dashboard/loading.tsx
      ...deeper layouts, then the page`} />
      <ul>
        <li>
          <strong>Streamed pages</strong> (every page that is rendered per request) send the
          layouts and the loading UI first and the content when it resolves, in the same
          response.
        </li>
        <li>
          <strong>What it covers.</strong> Only what suspends while rendering: React&apos;s{' '}
          <code>use()</code> on a promise, a <code>lazy()</code> component.{' '}
          <code>getServerSideProps</code> runs before rendering starts, so the loading UI is
          never shown while it runs.
        </li>
        <li>
          <strong>Cached pages</strong> (a page with <code>revalidate</code>) are rendered
          completely before they are stored, so visitors get the finished HTML and never see
          the loading UI. With <a href="/docs/page-exports/shell"><code>shell = &apos;cache&apos;</code></a>{' '}
          the boundary is an edge of the cached shell: the shell holds the layouts and the
          loading UI, and the content streams per request.
        </li>
        <li>
          <strong>Status codes.</strong> If the content throws or calls{' '}
          <code>notFound()</code> before it suspends, the answer is still the{' '}
          <code>500</code> or <code>404</code> page, exactly as without a{' '}
          <code>loading.tsx</code>. Once it has suspended, the <code>200</code> and the loading
          UI are already sent, so a later error is handled in the browser by the nearest{' '}
          <code>error.tsx</code> and the status stays <code>200</code>.
        </li>
        <li>
          <strong>Client navigation.</strong> The current page stays on screen until the next
          page&apos;s HTML has arrived; the loading UI shows only if the new page suspends in
          the browser.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="different-fallbacks-per-section">Different fallbacks per section</h3>
      <CodeBlock lang="text" code={`app/dashboard/
  layout.tsx
  loading.tsx            # fallback for /dashboard and everything below
  page.tsx
  analytics/
    loading.tsx          # a chart skeleton for /dashboard/analytics only
    page.tsx`} />
      <p>
        <code>/dashboard/analytics</code> gets both boundaries, nested: the dashboard layout
        stays on screen with the analytics skeleton inside it, because the inner boundary is
        the nearest one to the part that suspended.
      </p>

      <h3 id="a-boundary-around-one-part">A boundary around one part instead</h3>
      <p>
        <code>loading.tsx</code> replaces everything below its folder, the page included.
        When only one part of a page is slow, a <code>&lt;Suspense&gt;</code> of your own keeps
        the rest visible:
      </p>
      <CodeBlock lang="tsx" title="app/dashboard/page.tsx" code={`import React, { Suspense } from 'react';
import { RevenueChart } from './revenue-chart';

export default function Dashboard() {
  return (
    <>
      <h1>Dashboard</h1>
      <Suspense fallback={<div className="skeleton" aria-busy="true" />}>
        <RevenueChart />
      </Suspense>
    </>
  );
}`} />
      <p>
        The <a href="/docs/guides/streaming">Streaming</a> guide shows how a component
        suspends on data.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A page that renders without suspending looks exactly as it would without the file:
          the boundary only adds React&apos;s Suspense markers to the HTML.
        </li>
        <li>
          <code>loading.tsx</code> ships in the client bundle of every page below it, so it must
          be browser-safe.
        </li>
        <li>
          <code>gio routes</code> lists the <code>loading.tsx</code> that applies to each page.
        </li>
        <li>
          The loading UI is not a skeleton for <code>getServerSideProps</code>. If a page waits
          on slow data there, move that data into a promise the page renders with{' '}
          <code>use()</code>, or into a <code>route.ts</code> the browser fetches.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/layouts-and-pages#loading-ui">Layouts &amp; Pages: Loading UI</a></li>
        <li><a href="/docs/guides/streaming">Streaming</a></li>
        <li><a href="/docs/error-handling#streaming-and-loadingtsx">Error Handling: streaming and loading.tsx</a></li>
        <li><a href="/docs/file-conventions/error">error.tsx</a>, <a href="/docs/file-conventions/layout">layout.tsx</a>, <a href="/docs/page-exports/shell">shell</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced: <code>loading.tsx</code> wraps its folder in <code>&lt;Suspense&gt;</code>, in any folder of <code>app/</code>.</> },
      ]} />
    </>
  );
}
