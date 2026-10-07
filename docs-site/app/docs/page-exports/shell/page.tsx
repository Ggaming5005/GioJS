import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'shell',
  description:
    "Partial prerendering: cache the part of a page before its Suspense boundaries and stream each visitor's holes behind it.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>shell</h1>
      <p className="page-subtitle">
        Partial prerendering: cache the part of a page before its Suspense boundaries and
        stream each visitor&apos;s holes behind it.
      </p>
      <CodeBlock lang="tsx" title="app/store/page.tsx" code={`export const revalidate = 60;
export const shell = 'cache';`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        { name: 'shell', type: "'cache'", default: '(not set)', description: <>Turns on partial prerendering (PPR) for the page. Needs <a href="/docs/page-exports/revalidate"><code>revalidate</code></a> above <code>0</code>. Any other value is ignored.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>First request</strong> (<code>X-Gio-Cache: ppr; shell=stored</code>): the
          page renders in full and streams. The worker marks where React&apos;s shell ends -
          everything up to the pending Suspense boundaries - and the Rust server stores those
          bytes, up to 4 MB.
        </li>
        <li>
          <strong>Later requests</strong> (<code>ppr; shell=hit</code>): the stored shell is
          sent at once, then a holes-only render runs for this visitor -{' '}
          <code>getServerSideProps</code> included, with their cookies - and its Suspense
          content and hydration data stream into the same response.
        </li>
        <li>
          <strong>Stale shells</strong> (<code>ppr; shell=stale; age=...; revalidating</code>)
          follow stale-while-revalidate like any cached page, and purges remove them.
        </li>
        <li>
          Every PPR response is <code>Cache-Control: private, no-cache</code>: its holes are
          personal.
        </li>
        <li>
          If the holes render fails or times out, the body ends after the shell and the
          Suspense fallbacks stay on screen.
        </li>
      </ul>

      <h3 id="the-contract">The contract</h3>
      <p>
        The shell must be the same, byte for byte, for every visitor: only Suspense content
        may depend on who is asking. On a hit the shell and the holes come from different
        renders, and React places the holes by their position in the tree.
      </p>
      <ul>
        <li>
          <code>getServerSideProps</code> may read cookies on a PPR page - that is the point.
          Render what comes from them only inside a Suspense boundary that{' '}
          <em>suspends</em> (with <code>use()</code> on a per-request promise, for example).
        </li>
        <li>
          Before the shell is stored, the worker checks it. If <code>getServerSideProps</code>{' '}
          read credentials and the shell holds rendered Suspense content (a boundary that did
          not suspend, or resolved before the shell was sent) or no pending boundary at all,
          the shell is not stored, the page still streams, and a warning names the route.
        </li>
        <li>
          Metadata is part of the shell (it is in the <code>&lt;head&gt;</code>). A{' '}
          <code>generateMetadata</code> that reads credentials, or uses the props of a{' '}
          <code>getServerSideProps</code> that did, keeps the shell from being stored.
        </li>
        <li>
          Cookies cannot be set from a holes render: the stored shell already sent the
          headers. They are dropped with a warning.
        </li>
      </ul>

      <h3 id="when-it-falls-back">When it falls back</h3>
      <p>
        The page renders without PPR - as an ordinary page, under the usual caching rules -
        when:
      </p>
      <ul>
        <li>
          the render is not shareable: no <code>revalidate</code> (or <code>0</code>), or{' '}
          <code>getServerSideProps</code> returned response headers. The worker logs{' '}
          <code>shell=&apos;cache&apos; requires a shareable render (revalidate set, no per-request headers) - falling back</code>;
        </li>
        <li>a Node plugin with an <code>onResponse</code> hook is installed (it needs the whole body);</li>
        <li>the request is not a <code>GET</code> (a <code>HEAD</code>, or a page action&apos;s re-render).</li>
      </ul>
      <p>
        Under <code>gio export</code> nothing streams, so the page is exported in full.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-shared-page-with-a-personal-part">A shared page with a personal part</h3>
      <CodeBlock lang="tsx" title="app/store/page.tsx" code={`import React, { Suspense, use } from 'react';
import type { GetServerSideProps, InferPageProps } from '@gio.js/core';

export const revalidate = 60;
export const shell = 'cache';

export const getServerSideProps: GetServerSideProps<{ who: string }> = async (ctx) => ({
  props: { who: ctx.cookies['who'] ?? 'guest' },     // reruns for every visitor
});

// Runs on the server for the holes, and again in the browser while the page
// hydrates: keep it browser-safe (a fetch, not a database import).
async function greetingFor(who: string): Promise<string> {
  const res = await fetch(\`\${process.env.GIO_PUBLIC_API_URL}/greeting?who=\${encodeURIComponent(who)}\`);
  const { text } = (await res.json()) as { text: string };
  return text;
}

function Greeting({ text }: { text: Promise<string> }) {
  return <p>{use(text)}</p>;                          // suspends: stays out of the shell
}

export default function Store({ who }: InferPageProps<typeof getServerSideProps>) {
  return (
    <main>
      <h1>Store</h1>{/* the shell: the same for everyone */}
      <Suspense fallback={<p>Loading...</p>}>
        <Greeting text={greetingFor(who)} />
      </Suspense>
    </main>
  );
}`} />
      <CodeBlock lang="bash" code={`curl -sI http://localhost:3000/store | grep -i x-gio-cache   # ppr; shell=stored
curl -sI http://localhost:3000/store | grep -i x-gio-cache   # ppr; shell=hit`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A <code>loading.tsx</code> is a Suspense boundary around its folder: on a PPR page
          whose content suspends, the stored shell ends there.
        </li>
        <li>
          A per-visitor <code>redirect()</code> or <code>notFound()</code> from{' '}
          <code>getServerSideProps</code> on a shell hit arrives after the shell&apos;s{' '}
          <code>200</code>. The page then finishes itself: a redirect that sets no cookies
          becomes <code>location.replace()</code>; anything else reloads once, skipping the
          stored shell, to get the real status. A <a href="/docs/configuration/guards">guard</a>{' '}
          answers before any shell is sent.
        </li>
        <li>
          Rendering credential-derived props <em>outside</em> a Suspense boundary breaks the
          contract: the first visitor&apos;s values would be stored in the shell.
        </li>
        <li>
          The holes hydrate like the rest of the page, so the code they render runs in the
          browser too: a <code>*.server.ts</code> import there keeps the whole route from
          hydrating. Load data in <code>getServerSideProps</code>, or fetch it from a route
          handler.
        </li>
        <li><code>shell</code> is read from <code>page.tsx</code> only.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/caching-layers#partial-prerendering-ppr">Partial prerendering (PPR)</a> - the guide</li>
        <li><a href="/docs/page-exports/revalidate"><code>revalidate</code></a></li>
        <li><a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a></li>
        <li><a href="/docs/file-conventions/loading"><code>loading.tsx</code></a></li>
        <li><a href="/docs/guides/streaming">Streaming</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Hydration data streams after the shell; a shell holding content rendered from credentials is not stored; a per-visitor <code>redirect()</code> or <code>notFound()</code> on a shell hit reaches the visitor; renders that recovered from a Suspense error are not stored.</> },
        { version: 'v0.1.0-beta.7', changes: 'Introduced.' },
      ]} />
    </>
  );
}
