import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Routing</div>
      <h1>Layouts & Pages</h1>
      <p className="page-subtitle">Build routes with page files and share UI with nested layouts.</p>
      <h2>Pages</h2>
      <p>A page is the default export of a page.tsx file. It renders the UI for a route.</p>
      <CodeBlock lang="tsx" code={`export default function Page() {
  return <h1>Hello, world</h1>;
}`} />
      <h2>Layouts</h2>
      <p>A layout.tsx wraps the pages in its folder and all nested folders. The root app/layout.tsx must render <code>&lt;html&gt;</code> and <code>&lt;body&gt;</code>.</p>
      <CodeBlock lang="tsx" code={`// app/layout.tsx - server-only HTML
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

// app/(site)/layout.tsx - hydrated: the Navbar's links soft-navigate
export default function SiteLayout({ children }) {
  return (
    <>
      <Navbar />
      <main>{children}</main>
    </>
  );
}`} />
      <p>
        Layouts follow the folder tree, not the URL: a page gets every layout.tsx in its own
        folder and each folder above it, outermost first. That includes layouts inside dynamic
        folders (<code>app/posts/[id]/layout.tsx</code> wraps every post) and inside route
        groups. The root <code>app/layout.tsx</code> is server-only HTML; the layouts nested
        under it render inside the hydrated region and ship in the page&apos;s client bundle.
        A <code>not-found.tsx</code> or <code>error.tsx</code> gets the layouts of its own
        folder and the folders above it - never those of the page below it that failed (see{' '}
        <a href="/docs/error-handling">Error Handling</a>).
      </p>
      <h2>Loading UI</h2>
      <p>
        A <code>loading.tsx</code> wraps everything below its folder - the page and the layouts
        of deeper folders - in a <code>&lt;Suspense&gt;</code> boundary with its default export
        as the fallback. When the page suspends while rendering (React&apos;s{' '}
        <code>use()</code> on a promise, a lazy component), a streamed response sends the
        layouts and the loading UI at once and the page as soon as it is ready.
      </p>
      <CodeBlock lang="tsx" code={`// app/dashboard/loading.tsx
export default function Loading() {
  return <p>Loading dashboard…</p>;
}`} />
      <p>
        <code>getServerSideProps</code> runs before rendering starts, so the loading UI does
        not cover it - it shows only for content that suspends during the render. Per folder,
        the boundary sits inside the folder&apos;s layout and its <code>error.tsx</code>{' '}
        boundary:
      </p>
      <CodeBlock lang="text" code={`<Layout>               dashboard/layout.tsx
  <ErrorBoundary>      dashboard/error.tsx
    <Suspense>         dashboard/loading.tsx
      <Page />`} />
      <ul>
        <li>
          A page that renders without suspending looks exactly as before; the boundary only
          adds React&apos;s Suspense markers to the HTML. A cacheable page is still rendered
          completely and cached.
        </li>
        <li>
          If the page throws or calls <code>notFound()</code> before it suspends, the response
          is still the error or not-found page, as without the <code>loading.tsx</code>. After
          it has suspended, the 200 and the loading UI are already on their way, so errors are
          handled like in any Suspense boundary (see{' '}
          <a href="/docs/error-handling">Error Handling</a>) - a page that suspends and then
          throws, a 500 without the <code>loading.tsx</code>, is a 200 with it. Streamed or
          rendered completely (a cacheable page), the answer is the same.
        </li>
        <li>
          With partial prerendering (<code>shell = &apos;cache&apos;</code>) the boundary is a
          shell edge like any <code>&lt;Suspense&gt;</code>: when the page suspends, the cached
          shell holds the layouts above it plus the loading UI, and the page streams per
          request as a hole (see <a href="/docs/caching-layers">Caching Layers</a>).
        </li>
        <li>
          Client-side navigation keeps the current page on screen until the next page&apos;s
          HTML has arrived (prefetching hides most of that wait), then renders it into the same
          React tree: layouts the two pages share keep their state (a layout inside a dynamic
          segment mounts fresh when that segment&apos;s value changes), and the loading UI shows
          only if the new page suspends in the browser.
        </li>
      </ul>
      <h2>Dynamic routes</h2>
      <p>Wrap a folder name in brackets to capture URL segments. Params reach{' '}
        <code>ctx.params</code> in getServerSideProps (and the <code>params</code> prop when
        there is none) as strings.</p>
      <table>
        <thead><tr><th>Folder</th><th>Pattern</th><th>Matches</th><th>params</th></tr></thead>
        <tbody>
          <tr><td><code>posts/[id]</code></td><td><code>/posts/:id</code></td><td>/posts/1 (exactly one segment)</td><td><code>{'{ id: \'1\' }'}</code></td></tr>
          <tr><td><code>docs/[...slug]</code></td><td><code>/docs/*slug</code></td><td>/docs/a, /docs/a/b - not /docs</td><td><code>{'{ slug: \'a/b\' }'}</code></td></tr>
          <tr><td><code>shop/[[...path]]</code></td><td><code>/shop/*path?</code></td><td>/shop, /shop/a, /shop/a/b</td><td><code>{'{ path: \'\' }'}</code> for /shop</td></tr>
        </tbody>
      </table>
      <p>
        A catch-all value is one string that keeps its <code>/</code> separators - split it
        yourself if you need the segments. An optional catch-all that matches nothing is the
        empty string. A catch-all must be the last segment of its route, and a param name may
        appear only once per route.
      </p>
      <h2>Route groups</h2>
      <p>
        Wrap a folder name in parentheses to organize routes without changing URLs:{' '}
        <code>app/(marketing)/about/page.tsx</code> serves <code>/about</code>. Groups work
        for pages, route.ts handlers, and layouts, so a group can carry its own layout:
      </p>
      <CodeBlock lang="text" code={`app/
  (marketing)/
    layout.tsx        # wraps /about and /pricing only
    about/page.tsx    # /about
    pricing/page.tsx  # /pricing
  (shop)/
    layout.tsx        # wraps /cart only
    cart/page.tsx     # /cart`} />
      <p>A group layout is always a nested layout; only app/layout.tsx renders the document.</p>
      <h2>Private folders</h2>
      <p>
        Folders whose name starts with an underscore (<code>app/_components</code>) are never
        routable - nothing inside them becomes a page, handler, or layout. Use them to colocate
        components and helpers with the routes that use them.
      </p>
      <h2>Matching order and conflicts</h2>
      <p>
        When several patterns match a URL, the most specific wins, compared segment by segment
        from the left: a static segment beats <code>[id]</code>, which beats{' '}
        <code>[...slug]</code>, which beats <code>[[...slug]]</code>. So with both{' '}
        <code>shop/page.tsx</code> and <code>shop/[[...path]]/page.tsx</code>, /shop renders
        the static page and /shop/a the catch-all.
      </p>
      <p>
        Pages and route.ts handlers share this order: <code>blog/about/page.tsx</code> serves
        /blog/about even beside <code>blog/[slug]/route.ts</code>, and a catch-all route.ts
        never shadows the pages below it.
      </p>
      <p>
        Two files that would answer the same URLs fail startup with an error naming both: two
        pages in different groups (<code>(a)/about</code> and <code>(b)/about</code>),{' '}
        <code>posts/[id]</code> next to <code>posts/[slug]</code>, or a page and a route.ts in
        different folders. So does <code>docs/[...a]</code> next to{' '}
        <code>docs/[[...b]]</code>: the catch-all wins every URL below /docs, which would leave
        the optional catch-all only /docs itself. A route.ts in the same folder as its page.tsx
        is fine - see Route Handlers.
      </p>
    </>
  );
}
