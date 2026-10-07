import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'useSearchParams',
  description: "Read the current page's query string as a read-only URLSearchParams.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>useSearchParams</h1>
      <p className="page-subtitle">
        Read the current page&apos;s query string as a read-only <code>URLSearchParams</code>.
      </p>
      <CodeBlock lang="tsx" code={`import { useSearchParams } from '@gio.js/react';

export function SortLabel() {
  const searchParams = useSearchParams();
  const sort = searchParams.get('sort') ?? 'newest'; // /products?sort=price -> 'price'
  return <span>Sorted by {sort}</span>;
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <p><code>useSearchParams</code> takes no parameters.</p>
      <h3 id="returns">Returns</h3>
      <p>
        A <code>ReadonlyURLSearchParams</code>: a <code>URLSearchParams</code> whose reading
        methods all work - <code>get</code>, <code>getAll</code>, <code>has</code>,{' '}
        <code>keys</code>, <code>entries</code>, <code>forEach</code>, <code>toString</code>,{' '}
        <code>size</code> and iteration - and whose <code>set</code>, <code>append</code>,{' '}
        <code>delete</code> and <code>sort</code> throw:
      </p>
      <CodeBlock lang="text" code={`Error: useSearchParams() is read-only: build a new URLSearchParams(searchParams) and navigate to it`} />
      <p>
        The object is created again only when the query changes, so it is stable across
        renders of the same page and safe in effect dependencies.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The query is the one the server rendered the page for, carried into the browser with
          the page, so server and hydration renders agree. After a soft navigation it is the new
          page&apos;s query.
        </li>
        <li>
          <strong>Each key has one value</strong>, the last one in the URL:{' '}
          <code>?tag=a&amp;tag=b</code> gives <code>getAll(&apos;tag&apos;)</code> ={' '}
          <code>[&apos;b&apos;]</code>. The order of the keys is not kept either.
        </li>
        <li>
          Outside a tree GioJS rendered (a unit test), it reads{' '}
          <code>window.location.search</code>, or nothing on the server.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>

      <h3 id="updating-the-query">Updating the query</h3>
      <p>
        Copy the params, change the copy, and navigate. <code>replace</code> keeps one history
        entry, and <code>scroll: false</code> keeps the position.
      </p>
      <CodeBlock lang="tsx" title="app/products/sort-select.tsx" code={`import type { ChangeEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from '@gio.js/react';

export function SortSelect() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(searchParams.toString());
    next.set('sort', event.target.value);
    next.delete('page');
    void router.replace(\`\${pathname}?\${next}\`, { scroll: false });
  }

  return (
    <select value={searchParams.get('sort') ?? 'newest'} onChange={onChange}>
      <option value="newest">Newest</option>
      <option value="price">Price</option>
    </select>
  );
}`} />

      <h3 id="search-as-you-type">Search as you type</h3>
      <p>
        A navigation that only changes the query keeps focus in the field that still exists, so
        the visitor keeps typing.
      </p>
      <CodeBlock lang="tsx" title="app/search/search-box.tsx" code={`import { useRouter, useSearchParams } from '@gio.js/react';

export function SearchBox() {
  const router = useRouter();
  const q = useSearchParams().get('q') ?? '';
  return (
    <input
      type="search"
      defaultValue={q}
      onChange={(event) => void router.replace('/search?q=' + encodeURIComponent(event.target.value), { scroll: false })}
    />
  );
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Repeated keys keep only the last value.</strong> The server parses the query
          into one value per key before the page renders, so{' '}
          <code>getAll()</code> returns at most one item. For lists, use one key with a
          separator (<code>?tags=a,b</code>).
        </li>
        <li>
          <strong>In a static export the query is always empty.</strong> Pages are rendered once,
          without a query, and the browser reads the value the HTML was built with. Read{' '}
          <code>window.location.search</code> in an effect there.
        </li>
        <li>
          On a page cached with <code>revalidate</code>, each distinct query string is rendered
          and cached as its own entry, so a query a visitor can vary freely multiplies the
          cache entries.
        </li>
        <li>
          In the server-only root layout the value is that of the page loaded in full.
        </li>
        <li>
          On the server, <code>getServerSideProps</code> reads the same values as{' '}
          <code>ctx.query</code>, and a route handler as <code>req.query</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/hooks/use-router"><code>useRouter</code></a> - change the query by navigating.</li>
        <li><a href="/docs/hooks/use-pathname"><code>usePathname</code></a>, <a href="/docs/hooks/use-params"><code>useParams</code></a> - the rest of the URL.</li>
        <li><a href="/docs/linking-and-navigating#focus-and-announcements">Focus and announcements</a> - why the search field keeps focus.</li>
        <li><a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a> - read the query on the server.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
