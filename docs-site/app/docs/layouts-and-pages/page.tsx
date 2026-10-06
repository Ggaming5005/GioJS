import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Layouts & Pages</h1>
      <p className="page-subtitle">Build routes with page files and share UI with nested layouts.</p>
      <h2>Pages</h2>
      <p>A page is the default export of a page.tsx file. It renders the UI for a route.</p>
      <CodeBlock lang="tsx" code={`export default function Page() {
  return <h1>Hello, world</h1>;
}`} />
      <h2>Layouts</h2>
      <p>A layout.tsx wraps the pages in its folder and all nested folders. The root app/layout.tsx must render <code>&lt;html&gt;</code> and <code>&lt;body&gt;</code>.</p>
      <CodeBlock lang="tsx" code={`export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>
        <Navbar />
        <main>{children}</main>
      </body>
    </html>
  );
}`} />
      <p>
        Layouts follow the folder tree, not the URL: a page gets every layout.tsx in its own
        folder and each folder above it, outermost first. That includes layouts inside dynamic
        folders (<code>app/posts/[id]/layout.tsx</code> wraps every post) and inside route
        groups. The root <code>app/layout.tsx</code> is server-only HTML; the layouts nested
        under it render inside the hydrated region and ship in the page&apos;s client bundle.
        The root <code>not-found.tsx</code> and <code>error.tsx</code> get only the root layout.
      </p>
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
