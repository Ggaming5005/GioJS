import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'useRouter',
  description:
    'Navigate from code: push, replace, back, forward, refresh the current page in place, or prefetch a page ahead of time.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>useRouter</h1>
      <p className="page-subtitle">
        Navigate from code: push, replace, back, forward, refresh the current page in place, or
        prefetch a page ahead of time.
      </p>
      <CodeBlock lang="tsx" code={`import { useRouter } from '@gio.js/react';

export function CloseButton() {
  const router = useRouter();
  return <button onClick={() => router.back()}>Close</button>;
}`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>useRouter()</code> takes no parameters and returns a <code>GioRouter</code>: one
        frozen object, the same on every render and in every component.
      </p>
      <PropsTable kind="Field" rows={[
        {
          name: 'push(href, options?)',
          type: 'Promise<void>',
          description: <>Navigate to <code>href</code>, adding a history entry.</>,
        },
        {
          name: 'replace(href, options?)',
          type: 'Promise<void>',
          description: <>Navigate to <code>href</code>, replacing the current history entry.</>,
        },
        {
          name: 'back()',
          type: 'void',
          description: <>Go back one entry (<code>history.back()</code>). The router renders that page and restores its scroll position.</>,
        },
        {
          name: 'forward()',
          type: 'void',
          description: <>Go forward one entry (<code>history.forward()</code>).</>,
        },
        {
          name: 'refresh()',
          type: 'Promise<void>',
          description: <>Fetch the current page again and render it in place: same URL, scroll position and component state, fresh props.</>,
        },
        {
          name: 'prefetch(href)',
          type: 'void',
          description: <>Fetch a page into the prefetch cache, as a hovered <code>GioLink</code> does.</>,
        },
      ]} />

      <h3 id="options">Options</h3>
      <p>
        The second argument of <code>push</code> and <code>replace</code> (the type{' '}
        <code>RouterNavigateOptions</code>):
      </p>
      <PropsTable kind="Option" rows={[
        {
          name: 'scroll',
          type: 'boolean',
          default: 'true',
          description: <>Scroll to the top of the new page, or to the element its <code>#hash</code> names. <code>false</code> keeps the position.</>,
        },
        {
          name: 'transition',
          type: "'fade' | 'slide-left' | 'slide-up' | 'scale' | false",
          default: 'false',
          description: <>Run the swap in a view transition, like <a href="/docs/components/gio-link#transition"><code>{'<GioLink transition>'}</code></a>.</>,
        },
      ]} />

      <h3 id="push-and-replace"><code>push</code> and <code>replace</code></h3>
      <ul>
        <li>
          <code>href</code> is resolved against the current URL, so a path (<code>/posts/2</code>),
          a query alone (<code>?page=2</code>) and a hash (<code>#comments</code>) all work.
        </li>
        <li>
          A same-origin page is fetched (or taken from a fresh prefetch) and rendered in place,
          then the router scrolls and moves focus. A hash on the current page only scrolls.
        </li>
        <li>
          Another origin, an answer that is not a GioJS page, a network failure or a new
          deployment becomes a full page load (<code>location.assign</code>, or{' '}
          <code>location.replace</code> for <code>replace</code>).
        </li>
        <li>
          A URL that is not <code>http:</code> or <code>https:</code> (<code>javascript:</code>,{' '}
          <code>mailto:</code>, <code>data:</code>) is refused: the promise rejects with a{' '}
          <code>TypeError</code>, so <code>router.push(userInput)</code> can never run script.
        </li>
        <li>
          The promise resolves once the new page is on screen, or once a full load has started.
          A navigation overtaken by a newer one resolves without rendering anything.
        </li>
      </ul>

      <h3 id="refresh"><code>refresh</code></h3>
      <p>
        <code>router.refresh()</code> empties the prefetch cache and fetches the current URL with{' '}
        <code>cache: &apos;no-cache&apos;</code>, so <code>getServerSideProps</code> runs again (or
        the server&apos;s page cache answers, for a page with <code>revalidate</code>). The answer
        is rendered into the same React root: layouts and the page keep their state, the scroll
        position and the history entry stay. When the answer is not a GioJS page, the browser
        reloads.
      </p>

      <h3 id="prefetch"><code>prefetch</code></h3>
      <p>
        <code>prefetch(href)</code> fetches a same-origin page into the cache the next
        navigation to it uses (30 seconds, at most 50 pages). It does nothing for other origins,
        for the current page and for a page already cached, and its request counts against the
        server&apos;s <a href="/docs/configuration/prefetch">prefetch budget</a>.
      </p>

      <h2 id="examples">Examples</h2>

      <h3 id="navigating-after-a-client-side-request">Navigating after a client-side request</h3>
      <CodeBlock lang="tsx" title="app/posts/new/editor.tsx" code={`import { useState } from 'react';
import { href, useRouter } from '@gio.js/react';

export function Editor() {
  const router = useRouter();
  const [title, setTitle] = useState('');

  async function save() {
    const res = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const { id } = (await res.json()) as { id: string };
    await router.push(href('/posts/:id', { id }));
  }

  return (
    <>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />
      <button onClick={save}>Publish</button>
    </>
  );
}`} />

      <h3 id="refreshing-data-after-a-change">Refreshing data after a change</h3>
      <CodeBlock lang="tsx" title="app/inbox/mark-all-read.tsx" code={`import { useRouter } from '@gio.js/react';

export function MarkAllRead() {
  const router = useRouter();
  async function markAll() {
    await fetch('/api/inbox/read', { method: 'POST' });
    await router.refresh(); // getServerSideProps runs again; state and scroll stay
  }
  return <button onClick={markAll}>Mark all as read</button>;
}`} />

      <h3 id="prefetching-the-likely-next-page">Prefetching the likely next page</h3>
      <p>
        Fetch the page a visitor will most likely open next once this one is on screen, so the
        click renders it without waiting.
      </p>
      <CodeBlock lang="tsx" title="app/cart/checkout-button.tsx" code={`import { useEffect } from 'react';
import { GioLink, useRouter } from '@gio.js/react';

export function CheckoutButton() {
  const router = useRouter();
  useEffect(() => {
    router.prefetch('/checkout');
  }, [router]);
  return <GioLink href="/checkout" prefetch={false}>Checkout</GioLink>;
}`} />

      <h3 id="paging-without-scrolling">Paging without scrolling</h3>
      <CodeBlock lang="tsx" title="app/posts/pager.tsx" code={`import { useRouter, useSearchParams } from '@gio.js/react';

export function Pager() {
  const router = useRouter();
  const page = Number(useSearchParams().get('page') ?? '1');
  return (
    <button onClick={() => void router.push(\`?page=\${page + 1}\`, { scroll: false })}>
      Next page
    </button>
  );
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Every navigation asks the server for the page (unless a fresh prefetch has it). There is
          no &quot;shallow&quot; mode that changes the URL without fetching.
        </li>
        <li>
          The router holds no URL state: read <a href="/docs/hooks/use-pathname"><code>usePathname</code></a>,{' '}
          <a href="/docs/hooks/use-params"><code>useParams</code></a> and{' '}
          <a href="/docs/hooks/use-search-params"><code>useSearchParams</code></a>.
        </li>
        <li>
          During server rendering every method does nothing (<code>push</code> resolves at
          once). Call them from event handlers and effects.
        </li>
        <li>
          Any same-origin <code>fetch()</code> other than <code>GET</code>, <code>HEAD</code> or{' '}
          <code>OPTIONS</code> empties the prefetch cache, so a navigation after a mutation never
          shows a page fetched before it.
        </li>
        <li>
          Outside components, use <a href="/docs/functions/navigate"><code>navigate(href, options)</code></a>,
          which also takes <code>replace</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/linking-and-navigating#navigating-from-code">Linking &amp; Navigating</a> - soft navigation, scroll and focus.</li>
        <li><a href="/docs/components/gio-link"><code>&lt;GioLink&gt;</code></a> - declarative navigation.</li>
        <li><a href="/docs/functions/href"><code>href</code></a> - typed paths.</li>
        <li><a href="/docs/functions/navigate"><code>navigate</code></a> - the function behind <code>push</code> and <code>replace</code>.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: <>Introduced: <code>push</code>, <code>replace</code>, <code>back</code>, <code>forward</code>, <code>refresh</code> and <code>prefetch</code>.</> }]} />
    </>
  );
}
