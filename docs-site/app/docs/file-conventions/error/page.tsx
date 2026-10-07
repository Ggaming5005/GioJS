import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'error.tsx',
  description:
    'The error UI for a folder and everything below it: the 500 page when a render fails on the server, and an error boundary in the browser.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>error.tsx</h1>
      <p className="page-subtitle">
        The error UI for a folder and everything below it: the <code>500</code> page when a
        render fails on the server, and an error boundary in the browser.
      </p>
      <CodeBlock lang="tsx" title="app/dashboard/error.tsx" code={`import React from 'react';
import type { ErrorPageProps } from '@gio.js/core';

export default function DashboardError({ error, reset }: ErrorPageProps) {
  return (
    <div role="alert">
      <h2>The dashboard could not be shown</h2>
      {error.digest !== undefined && <p>Reference: {error.digest}</p>}
      {reset !== undefined && <button onClick={reset}>Try again</button>}
    </div>
  );
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>error.tsx</code>, <code>error.jsx</code> or <code>error.js</code>, in{' '}
        <code>app/</code> or any folder below it (route groups and dynamic folders included,
        private folders never). The nearest one at or above the page that failed is used.
      </p>

      <h3 id="props">Props</h3>
      <PropsTable rows={[
        {
          name: 'error.message',
          type: 'string',
          required: true,
          description: (
            <>
              The error&apos;s message in development. In production it is always generic:{' '}
              <code>Internal Server Error</code> for a server failure,{' '}
              <code>Application Error</code> for one in the browser, and{' '}
              <code>Not Found</code> for a <code>notFound()</code> call caught in the browser.
            </>
          ),
        },
        {
          name: 'error.digest',
          type: 'string | undefined',
          description: (
            <>
              A short reference the server logged the real error under (for example{' '}
              <code>140011e66130</code>). Show it, so users can quote it in a report. Errors
              that only happened in the browser have none.
            </>
          ),
        },
        {
          name: 'reset',
          type: '(() => void) | undefined',
          description: (
            <>
              Renders the failed segment again. Only present when the error was caught in the
              browser: a server-rendered <code>500</code> page is static HTML.
            </>
          ),
        },
      ]} />
      <p>
        Type them with <code>ErrorPageProps</code> from <code>@gio.js/core</code>.
      </p>

      <h3 id="module-exports">Module exports</h3>
      <p>
        <code>default</code> (required), and optionally{' '}
        <a href="/docs/page-exports/metadata"><code>metadata</code></a> or{' '}
        <a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a> for
        the head of the server-rendered <code>500</code> page. If{' '}
        <code>generateMetadata</code> throws (often the same outage the page reports), the
        static <code>metadata</code> exports are used instead.
      </p>

      <h3 id="behavior">Behavior</h3>
      <p><strong>On the server.</strong> When <code>getServerSideProps</code>, the page or a layout throws before the response has started:</p>
      <ul>
        <li>
          The response is <code>500</code> with the nearest <code>error.tsx</code>, rendered
          inside the layouts of <em>its own</em> folder (not those of the page that failed).
          It is never cached.
        </li>
        <li>
          The message and stack go to the log under the digest; the page gets only the digest
          in production.
        </li>
        <li>
          If that <code>error.tsx</code> cannot render either (its own layouts throw), the one
          in the folder above is tried, and so on. With none left, the server answers with its
          built-in error page.
        </li>
        <li>
          The <code>500</code> page is server-only HTML: it does not hydrate, so it has no{' '}
          <code>reset</code>, and links in it are plain links.
        </li>
      </ul>
      <p><strong>In the browser.</strong> Every <code>error.tsx</code> is also bundled into the pages below its folder as a React error boundary:</p>
      <ul>
        <li>
          A render error after hydration (or during a soft navigation) replaces only that
          folder&apos;s segment with the error UI; layouts above it stay.
        </li>
        <li>
          <code>reset()</code> clears the error and renders the segment again. Navigating to
          another URL, or only to another query string, clears it too.
        </li>
        <li>
          React error boundaries do not catch errors in event handlers or in async code
          outside rendering: handle those where they happen.
        </li>
      </ul>

      <h3 id="where-the-boundary-sits">Where the boundary sits</h3>
      <CodeBlock lang="text" code={`<Layout>               app/dashboard/layout.tsx  - NOT caught by dashboard/error.tsx
  <ErrorBoundary>      app/dashboard/error.tsx
    <Suspense>         app/dashboard/loading.tsx
      <Page />         app/dashboard/page.tsx    - caught`} />
      <p>
        So an <code>error.tsx</code> never handles an error thrown by the layout in its own
        folder. Put an <code>error.tsx</code> in the parent folder for that.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-root-error-page">A root error page</h3>
      <CodeBlock lang="tsx" title="app/error.tsx" code={`import React from 'react';
import type { ErrorPageProps } from '@gio.js/core';

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <main className="status">
      <h1>Something went wrong</h1>
      {process.env.NODE_ENV === 'development' && <pre>{error.message}</pre>}
      {error.digest !== undefined && (
        <p>
          Error reference: <code>{error.digest}</code>
        </p>
      )}
      {reset !== undefined ? (
        <button type="button" onClick={reset}>Try again</button>
      ) : (
        <a href="/">Go home</a>
      )}
    </main>
  );
}`} />

      <h3 id="find-the-error-in-the-logs">Find the error in the logs</h3>
      <p>
        The digest a user reports matches the <code>digest</code> field of the log line
        written when the render failed:
      </p>
      <CodeBlock lang="text" code={`{"ts":"2026-10-07T15:19:31.677Z","level":"error","msg":"ssr render failed","requestId":"b0533d97-...","path":"/dashboard/boom","digest":"140011e66130","error":"boom from gssp","stack":"Error: boom from gssp\\n    at getServerSideProps (app/dashboard/[id]/page.tsx:6:39) ..."}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>error.tsx</code> runs in the browser, so it must be browser-safe. One that
          imports server-only code leaves the pages below it without hydration, and the build
          error names the file. No <code>&apos;use client&apos;</code> directive is needed.
        </li>
        <li>
          After a streamed page has suspended inside a{' '}
          <a href="/docs/file-conventions/loading">loading.tsx</a> boundary, the{' '}
          <code>200</code> is already sent. A later error is shown by the browser&apos;s error
          boundary and the status stays <code>200</code>.
        </li>
        <li>
          Route handlers (<code>route.ts</code>) never use <code>error.tsx</code>: they answer
          a JSON <code>500</code> with a <code>digest</code>.
        </li>
        <li>
          Hiding the error details in production is fixed: it cannot be turned off, because
          messages and stacks can contain secrets, SQL or file paths. Read them in the log.
        </li>
        <li>
          There is no <code>global-error.tsx</code>. An error in the root layout itself gets
          the built-in error page, since every <code>error.tsx</code> renders inside it.
        </li>
        <li>
          <code>gio export</code> reports a page that fails to render, with its digest, instead
          of writing the error page in its place.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/error-handling#errors">Error Handling</a> - the guide.</li>
        <li><a href="/docs/file-conventions/not-found">not-found.tsx</a>, <a href="/docs/file-conventions/loading">loading.tsx</a>, <a href="/docs/file-conventions/layout">layout.tsx</a></li>
        <li><a href="/docs/observability">Observability</a> - reading the logs.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Works in any folder, with the nearest one applying. Also a client error boundary with <code>reset</code>. Production shows only a digest: the props are <code>{'{ error: { message, digest } }'}</code>. <code>ErrorPageProps</code> type.</> },
        { version: 'v0.1.0-beta.5', changes: <>Introduced for <code>app/error.tsx</code>: the server renders it with status <code>500</code> when a page throws.</> },
      ]} />
    </>
  );
}
