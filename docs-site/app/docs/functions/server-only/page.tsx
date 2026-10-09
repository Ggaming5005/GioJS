import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'server-only',
  description:
    'Mark a module as server-only with one import, so a client bundle that pulls it in is refused instead of shipping it to the browser.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>server-only</h1>
      <p className="page-subtitle">
        Mark a module as server-only with one import, so a client bundle that pulls it in is
        refused instead of shipping it to the browser.
      </p>
      <CodeBlock lang="ts" title="lib/db.ts" code={`import '@gio.js/core/server-only';

export const db = createClient(process.env.DATABASE_URL);`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>@gio.js/core/server-only</code> exports nothing; you import it for its effect.
        On the server it does nothing at all. The client build resolves it to a marker and,
        after tree-shaking each route&apos;s bundle, refuses any bundle in which the marker is
        still reachable.
      </p>
      <h3 id="three-ways-to-mark-a-module">Three ways to mark a module</h3>
      <ul>
        <li><code>import &apos;@gio.js/core/server-only&apos;;</code> at the top of the module.</li>
        <li>
          <code>import &apos;server-only&apos;;</code> - the bare specifier is recognized too.
          Prefer the GioJS one: the npm <code>server-only</code> package throws when it is
          loaded outside React Server Components, which includes GioJS&apos;s server render.
        </li>
        <li>
          A file name ending in <code>.server.ts</code> (<code>.tsx</code>, <code>.js</code>,{' '}
          <code>.jsx</code>, <code>.mts</code>, <code>.cts</code>, <code>.mjs</code>,{' '}
          <code>.cjs</code>), with no import at all. This applies to your own files, not to
          files inside dependencies.
        </li>
      </ul>
      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          A route whose client bundle still reaches a marked module after tree-shaking gets no
          bundle: the bundle is never written to disk, and the page server-renders without
          hydrating (no client JavaScript).
        </li>
        <li>
          The error names the import chain. It is logged at startup and, in development, shown
          in the error overlay when you open the page. Other routes are unaffected.
        </li>
        <li>
          <code>gio export</code> writes such a route as HTML only and lists it.
        </li>
        <li>
          Code that only <code>getServerSideProps</code>, <code>getStaticPaths</code> or other
          server exports import is tree-shaken out of client bundles anyway; the marker turns a
          mistake - a component importing it - into an error instead of a leak.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-leak-caught">A leak, caught</h3>
      <CodeBlock lang="ts" title="lib/stats.ts" code={`import '@gio.js/core/server-only';

export function dbUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://localhost/app';
}`} />
      <CodeBlock lang="tsx" title="app/leaky/page.tsx" code={`import { dbUrl } from '../../lib/stats.ts';

export default function Leaky() {
  return <h1>{dbUrl().length}</h1>;   // a component - this code goes to the browser
}`} />
      <p>
        At startup the worker logs an error (<code>client bundle imports server-only code -
        route will render without hydration</code>) whose message names the chain:
      </p>
      <CodeBlock lang="text" code={`client bundle for route "/leaky" imports server-only code: app/leaky/page.tsx -> lib/stats.ts -> @gio.js/core/server-only. The page still server-renders but will NOT hydrate (no client JS) until this import is removed from client code - keep server-only modules behind getServerSideProps or route.ts.`} />
      <h3 id="the-fix">The fix</h3>
      <CodeBlock lang="tsx" title="app/leaky/page.tsx" code={`import type { GetServerSideProps, InferPageProps } from '@gio.js/core';
import { dbUrl } from '../../lib/stats.ts';

export const getServerSideProps = (async () => {
  return { props: { length: dbUrl().length } };   // runs on the server only
}) satisfies GetServerSideProps;

export default function Leaky({ length }: InferPageProps<typeof getServerSideProps>) {
  return <h1>{length}</h1>;
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Opt-in per module, and not switchable.</strong> GioJS cannot know which of
          your modules hold secrets, so nothing is marked for you; and a marked module is
          always refused in a client bundle - there is no setting to let it through.
        </li>
        <li>
          <strong>Tree-shaking keeps calls it cannot prove harmless.</strong> A server export
          built by a call at module scope (
          <code>{'export const getServerSideProps = withAuth(...)'}</code>) is kept in the
          client bundle with everything it wraps. Call the wrapper inside a function
          declaration instead, and mark the helper module server-only so a leak fails loudly.
        </li>
        <li>
          <strong>Environment variables</strong> other than <code>GIO_PUBLIC_*</code> are{' '}
          <code>undefined</code> in the browser anyway; the marker protects code (queries,
          keys in source, internal logic), not just values.
        </li>
        <li>
          <code>@gio.js/core/testing</code> imports the marker itself, so a page that imports
          the test kit is refused too.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration#server-only">Keeping server code out of the browser</a></li>
        <li><a href="/docs/guides/environment-variables">Environment Variables</a></li>
        <li><a href="/docs/file-conventions/private-folders">Private folders</a></li>
        <li><a href="/docs/page-exports/get-server-side-props">getServerSideProps</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Introduced <code>@gio.js/core/server-only</code>, the bare{' '}
              <code>server-only</code> specifier and <code>*.server.ts</code> file names.
            </>
          ),
        },
      ]} />
    </>
  );
}
