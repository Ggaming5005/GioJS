import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: '<GioLink>',
  description:
    'A link that navigates on the client, prefetches the next page ahead of the click, and can animate the swap with a view transition.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>&lt;GioLink&gt;</h1>
      <p className="page-subtitle">
        A link that navigates on the client, prefetches the next page ahead of the click, and
        can animate the swap with a view transition.
      </p>
      <CodeBlock lang="tsx" title="app/(site)/layout.tsx" code={`import type { LayoutProps } from '@gio.js/core';
import { GioLink } from '@gio.js/react';

export default function SiteLayout({ children }: LayoutProps) {
  return (
    <>
      <nav>
        <GioLink href="/">Home</GioLink>
        <GioLink href="/blog">Blog</GioLink>
      </nav>
      {children}
    </>
  );
}`} />
      <p>
        <code>GioLink</code> renders a real <code>&lt;a href&gt;</code>, so the link works
        before the page hydrates and in a browser without JavaScript. Once hydrated, a plain
        click fetches the next page and renders it into the same React root: shared layouts
        keep their state, and nothing is reloaded.
      </p>

      <h2 id="reference">Reference</h2>
      <PropsTable rows={[
        {
          name: 'href',
          type: 'string',
          required: true,
          description: <>A path starting with <code>/</code> (written out or built with <a href="/docs/functions/href"><code>href()</code></a>), or a same-page <code>#hash</code>. Anything else is a plain link the browser follows.</>,
        },
        {
          name: 'prefetch',
          type: "'hover' | 'viewport' | false",
          default: "'hover'",
          description: <>When to fetch the page ahead of the click. See <a href="#prefetch"><code>prefetch</code></a>.</>,
        },
        {
          name: 'transition',
          type: "'fade' | 'slide-left' | 'slide-up' | 'scale' | false",
          default: 'false',
          description: <>Animate the swap with a view transition. See <a href="#transition"><code>transition</code></a>.</>,
        },
        {
          name: 'replace',
          type: 'boolean',
          default: 'false',
          description: 'Replace the current history entry instead of adding one.',
        },
        {
          name: 'scroll',
          type: 'boolean',
          default: 'true',
          description: <>Scroll to the top of the new page, or to the element its <code>#hash</code> names. <code>false</code> keeps the scroll position.</>,
        },
        {
          name: 'children',
          type: 'React.ReactNode',
          required: true,
          description: 'The link content.',
        },
        {
          name: 'className',
          type: 'string',
          description: <>Passed to the <code>&lt;a&gt;</code>.</>,
        },
        {
          name: 'target',
          type: 'React.HTMLAttributeAnchorTarget',
          description: <>Passed to the <code>&lt;a&gt;</code>. Any value other than <code>_self</code> leaves the click to the browser.</>,
        },
        {
          name: 'download',
          type: 'string | boolean',
          description: <>Passed to the <code>&lt;a&gt;</code>. A download link is always left to the browser.</>,
        },
        {
          name: 'aria-current',
          type: "'page' | 'step' | 'location' | 'date' | 'time' | boolean",
          description: <>Passed to the <code>&lt;a&gt;</code>. Mark the link to the current page with <code>&quot;page&quot;</code>.</>,
        },
      ]} />
      <p>
        These are all the props <code>GioLink</code> takes: <code>id</code>,{' '}
        <code>style</code>, <code>rel</code>, <code>title</code>, <code>onClick</code> and{' '}
        <code>data-*</code> attributes are not forwarded, and TypeScript rejects them. Wrap the
        link, or use a plain <code>&lt;a&gt;</code> where you need them.
      </p>

      <h3 id="href"><code>href</code></h3>
      <p>
        A click is handled by the client router only when <code>href</code> starts with{' '}
        <code>/</code> (but not <code>//</code>) or with <code>#</code>. Every other value -{' '}
        <code>https://...</code>, <code>mailto:</code>, a protocol-relative{' '}
        <code>//cdn.example.com</code>, a relative <code>about</code> or a query-only{' '}
        <code>?page=2</code> - is left to the browser: a normal full page load, with no
        prefetch. Write the full path (<code>/blog?page=2</code>) to keep a query change on the
        client.
      </p>

      <h3 id="prefetch"><code>prefetch</code></h3>
      <ul>
        <li>
          <code>&apos;hover&apos;</code> (default) - fetches the page when the pointer enters
          the link, a moment before the click. Links the visitor never points at cost
          nothing.
        </li>
        <li>
          <code>&apos;viewport&apos;</code> - fetches the page once, when the link first scrolls
          into view (an <code>IntersectionObserver</code>). Use it for the few links a visitor is
          likely to follow next; a long list of them sends one request per link.
        </li>
        <li><code>false</code> - never prefetches. The click still navigates on the client.</li>
      </ul>
      <p>
        A prefetch is a <code>GET</code> with <code>Purpose: prefetch</code> and{' '}
        <code>Sec-Purpose: prefetch</code>. It is skipped for a <code>#hash</code> link, for the
        page already on screen, and for a page already in the prefetch cache. The cache keeps a
        page for 30 seconds (<code>PREFETCH_TTL_MS</code>), holds at most 50, and is emptied by{' '}
        <code>router.refresh()</code>, by every <code>&lt;GioForm&gt;</code> submission and by
        any <code>fetch()</code> to your own origin other than <code>GET</code>,{' '}
        <code>HEAD</code> or <code>OPTIONS</code>. The server budgets prefetches per client
        (<code>429</code> once the budget is spent, or for every prefetch with{' '}
        <code>[prefetch] enabled = false</code>); a prefetch that failed never decides the click - the navigation
        fetches the page itself. See <a href="/docs/configuration/prefetch"><code>[prefetch]</code></a>.
      </p>

      <h3 id="transition"><code>transition</code></h3>
      <p>
        With a preset, the DOM swap runs inside <code>document.startViewTransition()</code>, and{' '}
        <code>data-gio-transition=&quot;&lt;preset&gt;&quot;</code> is set on{' '}
        <code>&lt;html&gt;</code> until the transition finishes. The keyframes come in a{' '}
        <code>&lt;style&gt;</code> element that React hoists into the head once per page. The
        preset type is exported as <code>TransitionPreset</code>.
      </p>
      <table>
        <thead><tr><th>Preset</th><th>Old page</th><th>New page</th><th>Duration</th></tr></thead>
        <tbody>
          <tr><td><code>fade</code></td><td>fades out</td><td>fades in</td><td>200 ms</td></tr>
          <tr><td><code>slide-left</code></td><td>moves 40px left, fading</td><td>comes in from 40px right</td><td>220 ms</td></tr>
          <tr><td><code>slide-up</code></td><td>moves 24px up, fading</td><td>comes in from 24px below</td><td>220 ms</td></tr>
          <tr><td><code>scale</code></td><td>grows to 104%, fading</td><td>grows from 96%</td><td>200 ms</td></tr>
        </tbody>
      </table>
      <p>
        Browsers without the View Transitions API swap the page without an animation, and{' '}
        <code>prefers-reduced-motion: reduce</code> turns the animation off. Back and forward
        never animate. To restyle a preset, target{' '}
        <code>:root[data-gio-transition=&quot;fade&quot;]::view-transition-new(root)</code> in
        your own CSS.
      </p>

      <h3 id="behavior">Behavior</h3>
      <p>The browser handles the click itself - a normal navigation - when:</p>
      <ul>
        <li>a modifier key is held (Ctrl, Cmd, Shift or Alt) or a button other than the left one is used, so &quot;open in new tab&quot; works;</li>
        <li><code>target</code> is set to anything but <code>_self</code>, or <code>download</code> is set;</li>
        <li><code>href</code> is not a <code>/</code> path or a <code>#hash</code> (see <a href="#href"><code>href</code></a>).</li>
      </ul>
      <p>
        Otherwise the router takes over: it uses a fresh prefetch or fetches the page, loads
        the route&apos;s client chunk and new stylesheets, renders the page in place, updates
        history, scrolls, and moves focus to the new <code>&lt;main&gt;</code>. A link to the
        URL already shown replaces the history entry, as browsers do. A{' '}
        <code>#hash</code> link to the current page only scrolls. The navigation becomes a full
        page load when the answer is not a GioJS page (JSON, a <code>503</code>, a static
        host&apos;s <code>404.html</code>), when the network fails, and when a new deployment
        went live since the page loaded. The details are in{' '}
        <a href="/docs/linking-and-navigating#how-a-soft-navigation-works">How a soft navigation works</a>.
      </p>

      <h2 id="examples">Examples</h2>

      <h3 id="linking-to-a-dynamic-route">Linking to a dynamic route</h3>
      <p>
        Build the path with <code>href()</code>: the pattern autocompletes from your{' '}
        <code>app/</code> directory, and a missing or misspelled param is a type error.
      </p>
      <CodeBlock lang="tsx" title="app/blog/page.tsx" code={`import { GioLink, href } from '@gio.js/react';

interface Post {
  slug: string;
  title: string;
}

export default function Blog({ posts }: { posts: Post[] }) {
  return (
    <ul>
      {posts.map((post) => (
        <li key={post.slug}>
          <GioLink href={href('/blog/:slug', { slug: post.slug })}>{post.title}</GioLink>
        </li>
      ))}
    </ul>
  );
}`} />

      <h3 id="marking-the-active-link">Marking the active link</h3>
      <p>
        Compare the link with <code>usePathname()</code> and set <code>aria-current</code>,
        which screen readers announce and CSS can target (
        <code>a[aria-current=&quot;page&quot;]</code>). Put the navigation in a layout below the
        root layout, such as a route group&apos;s, so it re-renders on every soft navigation.
      </p>
      <CodeBlock lang="tsx" title="app/(site)/nav.tsx" code={`import { GioLink, usePathname } from '@gio.js/react';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/blog', label: 'Blog' },
  { href: '/about', label: 'About' },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav>
      {LINKS.map((link) => {
        const active =
          pathname === link.href || (link.href !== '/' && pathname.startsWith(\`\${link.href}/\`));
        return (
          <GioLink key={link.href} href={link.href} aria-current={active ? 'page' : undefined}>
            {link.label}
          </GioLink>
        );
      })}
    </nav>
  );
}`} />

      <h3 id="tabs-that-keep-the-scroll-position">Tabs that keep the scroll position</h3>
      <p>
        Tabs that only change the query should neither scroll to the top nor add a history
        entry per click. Write the full path - a query-only <code>href</code> is a full page
        load.
      </p>
      <CodeBlock lang="tsx" title="app/products/[id]/tabs.tsx" code={`import { GioLink, usePathname, useSearchParams } from '@gio.js/react';

const TABS = ['details', 'reviews', 'shipping'];

export function Tabs() {
  const pathname = usePathname();
  const current = useSearchParams().get('tab') ?? 'details';
  return (
    <div role="tablist">
      {TABS.map((tab) => (
        <GioLink
          key={tab}
          href={\`\${pathname}?tab=\${tab}\`}
          replace
          scroll={false}
          aria-current={tab === current ? 'page' : undefined}
        >
          {tab}
        </GioLink>
      ))}
    </div>
  );
}`} />

      <h3 id="prefetching-the-next-step">Prefetching the next step</h3>
      <p>
        A call-to-action the visitor will probably click can be fetched as soon as it is on
        screen. Links that are rarely followed can opt out.
      </p>
      <CodeBlock lang="tsx" code={`<GioLink href="/checkout" prefetch="viewport">Continue to checkout</GioLink>
<GioLink href="/terms" prefetch={false}>Terms of service</GioLink>`} />

      <h3 id="animating-page-changes">Animating page changes</h3>
      <CodeBlock lang="tsx" code={`<GioLink href="/gallery/2" transition="slide-left">Next photo</GioLink>
<GioLink href="/gallery" transition="fade">Back to the gallery</GioLink>`} />

      <h3 id="links-to-other-sites-and-files">Links to other sites and files</h3>
      <p>
        <code>GioLink</code> works for these, but it adds nothing: they are left to the browser.
        A plain <code>&lt;a&gt;</code> also lets you set <code>rel</code>.
      </p>
      <CodeBlock lang="tsx" code={`<a href="https://github.com/Ggaming5005/GioJS" target="_blank" rel="noreferrer">GitHub</a>
<GioLink href="/reports/2026.pdf" download>Download the report</GioLink>`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>In the root layout a <code>GioLink</code> is a plain link.</strong>{' '}
          <code>app/layout.tsx</code> is server-rendered HTML that never hydrates, so a link there
          neither prefetches nor navigates on the client. Put site navigation in a route
          group&apos;s layout (<code>app/(site)/layout.tsx</code>), as the{' '}
          <code>create-giojs</code> starter does.
        </li>
        <li>
          Keyboard focus does not prefetch; only the pointer entering the link (or, with{' '}
          <code>&apos;viewport&apos;</code>, the link becoming visible) does. Where{' '}
          <code>IntersectionObserver</code> is missing, <code>&apos;viewport&apos;</code> never
          prefetches.
        </li>
        <li>
          After a mutation (a <code>&lt;GioForm&gt;</code> post or any same-origin{' '}
          <code>POST</code>/<code>PUT</code>/<code>PATCH</code>/<code>DELETE</code>{' '}
          <code>fetch()</code>), pages prefetched before it are dropped, so a click never shows
          data from before the change.
        </li>
        <li>
          In a <a href="/docs/static-export">static export</a>, links navigate on the client on
          any static host; the server&apos;s prefetch budget does not exist there.
        </li>
        <li>
          Shift-click and middle-click open the link the browser&apos;s way. This cannot be
          turned off.
        </li>
        <li>
          <code>router.push()</code> and <code>router.replace()</code> take the same{' '}
          <code>transition</code> option. The preset keyframes arrive with the first{' '}
          <code>GioLink</code> on the page that has a <code>transition</code>; without one, a
          view transition started from code runs the browser&apos;s default cross-fade.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/linking-and-navigating">Linking &amp; Navigating</a> - how soft navigation, scroll and focus work.</li>
        <li><a href="/docs/hooks/use-router"><code>useRouter</code></a> - navigate from code.</li>
        <li><a href="/docs/hooks/use-pathname"><code>usePathname</code></a> - mark the active link.</li>
        <li><a href="/docs/functions/href"><code>href</code></a> - typed paths for dynamic routes.</li>
        <li><a href="/docs/functions/navigate"><code>navigate</code></a> - navigate outside components.</li>
        <li><a href="/docs/components/locale-link"><code>&lt;LocaleLink&gt;</code></a> - a <code>GioLink</code> that adds the locale prefix.</li>
        <li><a href="/docs/configuration/prefetch"><code>[prefetch]</code></a> - the server&apos;s prefetch budget.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Added <code>replace</code> and <code>scroll</code>. Prefetched pages expire after 30 seconds and are dropped after a mutation; a failed prefetch no longer turns the click into a full page load; a click after a new deployment loads the new build in full.</>,
        },
        { version: 'v0.1.0-beta.6', changes: <><code>prefetch=&quot;viewport&quot;</code> implemented.</> },
        {
          version: 'v0.1.0-beta.5',
          changes: <>Modified clicks, <code>target=&quot;_blank&quot;</code> and <code>download</code> links are left to the browser; a failed client navigation falls back to a full page load.</>,
        },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
