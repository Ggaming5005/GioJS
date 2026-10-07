import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Components',
  description: 'The React components exported from @gio.js/react: links, images, forms, fonts, structured data and animations.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Components</h1>
      <p className="page-subtitle">
        The React components exported from <code>@gio.js/react</code>: links, images, forms,
        fonts, structured data and animations.
      </p>
      <CodeBlock lang="tsx" code={`import { GioLink, GioImage, GioForm, GioFont, JsonLd, Animate, LocaleLink } from '@gio.js/react';`} />
      <table>
        <thead><tr><th>Component</th><th>What it is for</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/components/gio-link"><code>&lt;GioLink&gt;</code></a></td><td>Links that navigate on the client, with prefetch and view transitions.</td></tr>
          <tr><td><a href="/docs/components/gio-image"><code>&lt;GioImage&gt;</code></a></td><td>Images resized and converted by the built-in optimizer.</td></tr>
          <tr><td><a href="/docs/components/gio-form"><code>&lt;GioForm&gt;</code></a></td><td>Forms that post to a page action, with or without JavaScript.</td></tr>
          <tr><td><a href="/docs/components/gio-font"><code>&lt;GioFont&gt;</code></a></td><td>A typed marker for a font declared in <code>[[fonts]]</code>.</td></tr>
          <tr><td><a href="/docs/components/json-ld"><code>&lt;JsonLd&gt;</code></a></td><td>Structured data for search engines.</td></tr>
          <tr><td><a href="/docs/components/animate"><code>&lt;Animate&gt;</code></a></td><td>Entrance animations when content scrolls into view.</td></tr>
          <tr><td><a href="/docs/components/locale-link"><code>&lt;LocaleLink&gt;</code></a></td><td>A <code>GioLink</code> that keeps the visitor&apos;s locale prefix.</td></tr>
        </tbody>
      </table>
      <p>
        The hooks from the same package - <code>usePathname</code>, <code>useRouter</code>,{' '}
        <code>useWebSocket</code> and the rest - are listed under <a href="/docs/hooks">Hooks</a>.
      </p>
      <div className="callout">
        The root layout (<code>app/layout.tsx</code>) is server-rendered HTML that never
        hydrates. Components that need JavaScript - <code>GioLink</code>&apos;s client
        navigation, <code>GioForm</code>&apos;s interception, <code>Animate</code> - only work in
        pages and nested layouts. Put shared navigation in a route group&apos;s layout, such as{' '}
        <code>app/(site)/layout.tsx</code>.
      </div>

      <h2 id="giolink">GioLink</h2>
      <p>
        Renders an <code>&lt;a&gt;</code> whose clicks the client router handles: it fetches the
        next page and renders it into the same React root, so shared layouts keep their state.
        It prefetches on hover by default (<code>prefetch=&quot;viewport&quot;</code> or{' '}
        <code>false</code> to change that) and takes <code>replace</code>, <code>scroll</code>{' '}
        and <code>transition</code>.
      </p>
      <CodeBlock lang="tsx" code={`<GioLink href="/about" transition="fade">About</GioLink>`} />
      <p><a href="/docs/components/gio-link">GioLink reference</a></p>

      <h2 id="gioimage">GioImage</h2>
      <p>
        Renders an <code>&lt;img&gt;</code> pointed at the <code>/_gio/image</code> optimizer,
        with a <code>srcset</code> of the widths <code>[images] allowed_widths</code> permits.
        Takes <code>width</code>, <code>height</code> and <code>alt</code>, plus{' '}
        <code>sizes</code>, <code>fill</code>, <code>quality</code>, <code>priority</code>,{' '}
        <code>placeholder</code>/<code>blurDataURL</code> and <code>unoptimized</code>.
      </p>
      <CodeBlock lang="tsx" code={`<GioImage src="/photo.jpg" alt="" width={800} height={600} priority />`} />
      <p><a href="/docs/components/gio-image">GioImage reference</a></p>

      <h2 id="gioform">GioForm</h2>
      <p>
        A <code>&lt;form method=&quot;post&quot;&gt;</code> that posts to the page&apos;s{' '}
        <code>action</code> export. Without JavaScript it is a normal form; once hydrated it
        submits with <code>fetch</code> and renders the answer in place.{' '}
        <code>useGioFormState()</code> reads its pending state.
      </p>
      <CodeBlock lang="tsx" code={`<GioForm>
  <input name="email" type="email" />
  <button>Subscribe</button>
</GioForm>`} />
      <p><a href="/docs/components/gio-form">GioForm reference</a></p>

      <h2 id="giofont">GioFont</h2>
      <p>
        A typed marker that renders nothing. Fonts are self-hosted from <code>[[fonts]]</code> in{' '}
        <code>gio.toml</code>: the server copies them from <code>public/</code> (or downloads
        them once) and injects the preload and stylesheet links itself.
      </p>
      <CodeBlock lang="tsx" code={`<GioFont family="Inter" weights={[400, 700]} />`} />
      <p><a href="/docs/components/gio-font">GioFont reference</a></p>

      <h2 id="jsonld">JsonLd</h2>
      <p>
        Renders schema.org data as a <code>&lt;script type=&quot;application/ld+json&quot;&gt;</code>,
        escaped so no value can close the element. It needs no CSP nonce.
      </p>
      <CodeBlock lang="tsx" code={`<JsonLd data={{ '@context': 'https://schema.org', '@type': 'Article', headline: post.title }} />`} />
      <p><a href="/docs/components/json-ld">JsonLd reference</a></p>

      <h2 id="animate">Animate</h2>
      <p>
        Fades, zooms or slides its children in when they scroll into view, using CSS keyframes
        and one shared <code>IntersectionObserver</code>. <code>initAnimateObserver</code> and{' '}
        <code>observeElement</code> expose that observer for your own elements.
      </p>
      <CodeBlock lang="tsx" code={`<Animate enter="fade-up" delay={100}>...</Animate>`} />
      <p><a href="/docs/components/animate">Animate reference</a></p>

      <h2 id="localelink">LocaleLink</h2>
      <p>
        A <code>GioLink</code> that prefixes <code>href</code> with the request locale when it is
        not <code>defaultLocale</code> (default <code>&quot;en&quot;</code>). The locale comes from{' '}
        <code>useLocale()</code>, so the prefixed href is already in the server HTML.
      </p>
      <CodeBlock lang="tsx" code={`<LocaleLink href="/pricing">Pricing</LocaleLink>   // /fr/pricing on a French page`} />
      <p><a href="/docs/components/locale-link">LocaleLink reference</a></p>

      <h2 id="props-of-your-app-components">Props of your app components</h2>
      <p>
        The props GioJS passes to the components in <code>app/</code> are typed by{' '}
        <code>@gio.js/core</code>: <code>LayoutProps</code> (<code>{'{ children, path }'}</code>),{' '}
        <code>{"PageProps<'/posts/:id'>"}</code> for a page without{' '}
        <code>getServerSideProps</code> (<code>{'{ params, searchParams }'}</code> - a page
        with one renders with exactly the props it returned),{' '}
        <code>ErrorPageProps</code> and <code>NotFoundPageProps</code>. See{' '}
        <a href="/docs/functions#types">Functions</a> for the full list.
      </p>
      <CodeBlock lang="tsx" code={`import type { ErrorPageProps, LayoutProps } from '@gio.js/core';

export default function RootLayout({ children }: LayoutProps) {
  return <html lang="en"><body>{children}</body></html>;
}

// app/error.tsx
export default function Error({ error, reset }: ErrorPageProps) {
  return <p>Something went wrong ({error.digest}) {reset && <button onClick={reset}>Retry</button>}</p>;
}`} />
    </>
  );
}
