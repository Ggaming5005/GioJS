import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Routing</div>
      <h1>Linking & Navigating</h1>
      <p className="page-subtitle">Client-side navigation, router hooks, prefetching, scroll and focus.</p>
      <p>Use GioLink for internal navigation. It prefetches on hover intent by default and swaps content without a full reload. Set <code>prefetch=&quot;viewport&quot;</code> to instead prefetch once when the link scrolls into view (via IntersectionObserver), or <code>prefetch={'{false}'}</code> to disable prefetching.</p>
      <CodeBlock lang="tsx" code={`import { GioLink } from '@gio.js/react';

<GioLink href="/about">About</GioLink>
<GioLink href="/posts/1" prefetch="viewport">First post</GioLink>
<GioLink href="/search?q=gio" replace scroll={false}>Search</GioLink>
<GioLink href="#comments">Jump to comments</GioLink>`} />

      <h2>How a soft navigation works</h2>
      <p>
        A click fetches the next page&apos;s HTML (or takes a fresh prefetch), loads the
        route&apos;s client chunk and any of its <a href="/docs/css">stylesheets</a> the page
        does not have yet (waiting at most 3 seconds for them), and renders the new page into
        the same React root. Layouts
        the two pages share stay mounted, so their state (an open sidebar, a search box, a
        playing video) survives the navigation; the page itself mounts fresh, also when only
        a dynamic segment changes (<code>/posts/1</code> to <code>/posts/2</code>). So does a
        layout inside a dynamic segment when that segment&apos;s value changes:{' '}
        <code>app/teams/[team]/layout.tsx</code> mounts fresh from <code>/teams/a</code> to{' '}
        <code>/teams/b</code>, and keeps its state between the pages of one team. An error a
        folder&apos;s <code>error.tsx</code> boundary caught is cleared by the next
        navigation, also one that only changes the query (<code>?q=bad</code> to{' '}
        <code>?q=good</code>).
      </p>
      <p>
        Only GioJS pages are rendered in place - HTML with the page boundary, including your
        <code> not-found.tsx</code> and <code>error.tsx</code> pages. Anything else falls back
        to a normal full page load, so it shows with its real status: a non-HTML response, a{' '}
        <code>503</code> from the server, a network error, a static host&apos;s{' '}
        <code>404.html</code>, or a link to another origin. After a redirect, the address bar
        and the router hooks show the URL the redirect landed on. When a new deployment went
        live since the page loaded, the navigation becomes a full load of the new build.
      </p>
      <div className="callout">
        The root layout (<code>app/layout.tsx</code>) is server-only HTML: a soft navigation
        does not re-render it, so anything it derives from the URL (an active nav link) keeps
        the value of the page that was loaded in full. Put URL-dependent UI in a component
        below it - for a layout shared by every page, use a route group such as{' '}
        <code>app/(site)/layout.tsx</code>.
      </div>

      <h2>Router hooks</h2>
      <p>
        <code>usePathname</code>, <code>useParams</code> and <code>useSearchParams</code> read
        the page the router matched. They work during server rendering - in the root layout
        too - and return the same values when the page hydrates, so they never cause a
        hydration mismatch; after a soft navigation they return the new page&apos;s values.
      </p>
      <CodeBlock lang="tsx" code={`import { usePathname, useParams, useSearchParams } from '@gio.js/react';

export default function PostPage() {
  const pathname = usePathname();               // '/posts/42'
  const { id } = useParams<'/posts/:id'>();      // typed from your routes
  const searchParams = useSearchParams();       // read-only URLSearchParams
  const tab = searchParams.get('tab') ?? 'overview';
  // ...
}`} />
      <ul>
        <li>
          <code>usePathname()</code> is the path the page was rendered for, without query or
          hash. With i18n the locale prefix is not part of it (<code>/fr/about</code> gives{' '}
          <code>/about</code>; combine it with <code>useLocale()</code>), and after a{' '}
          <code>[[rewrites]]</code> rule it is the rewritten path.
        </li>
        <li>
          <code>useParams()</code> returns the dynamic segment values. Pass a route pattern
          (<code>{"useParams<'/posts/:id'>()"}</code>) for typed params from the generated
          typed routes, or a shape (<code>{'useParams<{ id: string }>()'}</code>). In a{' '}
          <code>not-found.tsx</code> or <code>error.tsx</code> page and its layouts it
          returns the params of the route that was not found or failed - the ones their{' '}
          <code>generateMetadata</code> gets - and <code>{'{}'}</code> for a URL no route
          matches.
        </li>
        <li>
          <code>useSearchParams()</code> returns the query as a read-only{' '}
          <code>URLSearchParams</code>: <code>set</code>, <code>append</code>,{' '}
          <code>delete</code> and <code>sort</code> throw. To change the query, navigate. A
          query key that appears more than once keeps one value (the last).
        </li>
        <li>
          <code>useLocale()</code> returns the request locale, during server rendering too, so{' '}
          <code>&lt;LocaleLink&gt;</code> renders its prefixed href in the server HTML.
        </li>
      </ul>

      <h2>Navigating from code</h2>
      <CodeBlock lang="tsx" code={`import { useRouter, href } from '@gio.js/react';

function SaveButton({ id }: { id: string }) {
  const router = useRouter();
  async function save() {
    await fetch('/api/posts', { method: 'POST', body: '...' });
    router.push(href('/posts/:id', { id }));
  }
  return <button onClick={save}>Save</button>;
}`} />
      <table>
        <thead><tr><th>Method</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>push(href, {'{ scroll? }'})</code></td><td>Soft-navigate, adding a history entry.</td></tr>
          <tr><td><code>replace(href, {'{ scroll? }'})</code></td><td>Soft-navigate, replacing the current entry.</td></tr>
          <tr><td><code>back()</code> / <code>forward()</code></td><td>Move through history; the router renders the page and restores its scroll position.</td></tr>
          <tr><td><code>refresh()</code></td><td>Re-fetch the current page, bypassing (and clearing) the prefetch cache, and re-render it in place: same URL, same scroll position, component state kept, fresh props.</td></tr>
          <tr><td><code>prefetch(href)</code></td><td>Fetch a page into the prefetch cache ahead of a navigation.</td></tr>
        </tbody>
      </table>
      <p>
        <code>useRouter()</code> returns the same object on every render, so it is safe in
        effect dependencies; outside components, <code>navigate(href, {'{ replace, scroll }'})</code>{' '}
        does the same as <code>push</code>/<code>replace</code>. All of them return a promise
        that settles once the new page is on screen, accept any same-origin href (build typed
        ones with <code>href()</code>), turn other origins into full page loads, refuse{' '}
        <code>javascript:</code> URLs, and do nothing during server rendering.
      </p>

      <h2>Scroll</h2>
      <ul>
        <li>
          A navigation scrolls to the top of the new page, or to the element its{' '}
          <code>#hash</code> names. Pass <code>scroll={'{false}'}</code> (on GioLink or to{' '}
          <code>push</code>/<code>replace</code>) to keep the position - handy for tabs or
          filters that only change the query.
        </li>
        <li>
          Back and forward restore each page&apos;s scroll position once that page has
          rendered - also for entries a plain <code>&lt;a href=&quot;#note&quot;&gt;</code>{' '}
          created. The router keeps the position of the current entry as you scroll and takes
          over <code>history.scrollRestoration</code> while it is active; full page loads and
          reloads keep the browser&apos;s own restoration.
        </li>
        <li>
          Links to a hash on the current page (<code>#comments</code>,{' '}
          <code>/docs#install</code> while on <code>/docs</code>) only scroll: nothing is
          fetched. <code>href=&quot;#&quot;</code> scrolls to the top, as in the browser.
        </li>
      </ul>

      <h2>Prefetching</h2>
      <p>
        Prefetched pages are kept for 30 seconds (<code>PREFETCH_TTL_MS</code>), at most 50 of
        them; an older entry is fetched again when it is used. The cache is cleared by{' '}
        <code>router.refresh()</code> and by any non-GET <code>fetch()</code> to your own
        origin (an API mutation), so a navigation after a change never shows a
        page prefetched before it. Hovering a link again within those 30 seconds never
        refetches it, whatever the answer was. A link whose prefetch got a page that cannot be
        rendered in place (JSON, a page without GioJS) goes straight to a full page load when
        clicked; a prefetch that failed - a network error, or any non-2xx status such as the{' '}
        <code>429</code> the server answers once a client&apos;s prefetch budget is spent - never
        decides the click: the navigation fetches the page itself.
      </p>
      <div className="callout">
        Prefetching is budgeted by the Rust prefetch manager, so a page full of links will not
        flood your server: each client may have 5 prefetches in flight and start 20 per second,
        set by <code>[prefetch] max_concurrent</code> and <code>max_per_second</code> in{' '}
        <code>gio.toml</code>.
      </div>

      <h2>Focus and announcements</h2>
      <p>
        After a soft navigation to another page, focus moves to the new page&apos;s{' '}
        <code>&lt;main&gt;</code> (or the page container when there is none), so keyboard and
        screen-reader users start at the new content rather than on a link that may be gone,
        and the new page&apos;s title (or its first <code>&lt;h1&gt;</code>) is announced
        through a visually hidden live region. Give every page a meaningful title. Focus stays
        where it is when the page focused something itself (an <code>autoFocus</code> input),
        when it is in a text field that is still on the page - so search-as-you-type with{' '}
        <code>router.replace(&apos;?q=&apos; + value)</code> keeps typing in the field - and
        when a <code>scroll={'{false}'}</code> navigation (tabs) leaves the focused element in
        place. A navigation that only changes the query (filters, sorting,{' '}
        <code>?page=2</code>) announces nothing and moves focus only if the element that had
        it is gone.
      </p>

      <h2>View transitions</h2>
      <p>Set a transition preset to animate between pages using the View Transitions API.</p>
      <CodeBlock lang="tsx" code={`<GioLink href="/about" transition="fade">About</GioLink>

router.push('/about', { transition: 'slide-left' });`} />

      <h2>Typed routes</h2>
      <p>
        The <code>href()</code> helper builds URLs from your route patterns with full
        type checking. At every server start GioJS generates{' '}
        <code>.gio/routes.d.ts</code> from the discovered routes; the file fills the global{' '}
        <code>GioJS.RegisteredRoutes</code> registry (declaration merging), so patterns
        autocomplete and params typecheck with zero annotations in your code. The same
        registry types params in <code>useParams()</code> and in the{' '}
        <code>@gio.js/core</code> types - <code>{"PageProps<'/posts/:id'>"}</code>,{' '}
        <code>{"GetServerSideProps<Props, '/posts/:id'>"}</code>,{' '}
        <code>{"GioRequest<'/api/posts/:id'>"}</code> (see{' '}
        <a href="/docs/functions#types">Functions</a>).
      </p>
      <CodeBlock lang="tsx" code={`import { GioLink, href } from '@gio.js/react';

// '/posts/:id' autocompletes from your app/ directory.
// A wrong pattern or a missing/misspelled param is a type error.
<GioLink href={href('/posts/:id', { id: post.id })}>{post.title}</GioLink>

href('/about');                        // static routes take no params
href('/docs/*rest', { rest: 'a/b' });  // catch-all keeps its slashes
href('/shop/*path?');                  // optional catch-all: '/shop'
href('/shop/*path?', { path: 'a/b' }); // '/shop/a/b'`} />
      <p>
        Patterns are the URL shapes of your routes, so route groups never appear in them:{' '}
        <code>[id]</code> is <code>:id</code>, <code>[...slug]</code> is <code>*slug</code>, and{' '}
        <code>[[...slug]]</code> is <code>*slug?</code>. Param values are URL-encoded per
        segment (a catch-all value keeps its <code>/</code> separators); an empty or omitted
        optional catch-all drops its segment entirely. Projects scaffolded by <code>create-giojs</code>{' '}
        already include the generated file in their tsconfig; in an existing project,
        add <code>&quot;.gio/routes.d.ts&quot;</code> to the <code>include</code> array
        of <code>tsconfig.json</code>.</p>
    </>
  );
}
