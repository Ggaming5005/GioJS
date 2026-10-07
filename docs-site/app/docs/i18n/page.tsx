import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Internationalization',
  description:
    'Serve one app in several languages: locale detection from the URL prefix, the ' +
    'Accept-Language header or the gio_locale cookie, and reading the locale in pages.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Internationalization</h1>
      <p className="page-subtitle">
        Serve one app in several languages: locale detection from the URL prefix, the{' '}
        <code>Accept-Language</code> header or the <code>gio_locale</code> cookie, and reading
        the locale in pages.
      </p>
      <p>
        GioJS handles the routing half of internationalization: the Rust server decides each
        request&apos;s locale, strips a locale prefix from the URL before routing (so{' '}
        <code>/de/about</code> renders <code>app/about/page.tsx</code>), keys the page cache by
        locale and sets <code>&lt;html lang&gt;</code>. Translating the text is up to you -
        a dictionary per locale, or any i18n library that runs in React.
      </p>
      <p>
        Without an <code>[i18n]</code> section (or with an empty <code>locales</code> list)
        none of this runs, and the locale is <code>&apos;&apos;</code> everywhere.
      </p>

      <h2 id="configuration">Configuration</h2>
      <CodeBlock lang="toml" title="gio.toml" code={`[i18n]
locales = ["en", "de", "fr"]   # empty (the default) turns i18n off
default_locale = "en"          # default "en"
detect_from = ["path", "accept-language", "cookie"]   # the default order`} />
      <table>
        <thead>
          <tr><th>Key</th><th>Type</th><th>Default</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>locales</code></td><td><code>string[]</code></td><td><code>[]</code></td><td>The locales the app serves, as they appear in URLs. Empty: i18n is off.</td></tr>
          <tr><td><code>default_locale</code></td><td><code>string</code></td><td><code>&quot;en&quot;</code></td><td>The locale when nothing else matches. Its pages need no prefix.</td></tr>
          <tr><td><code>detect_from</code></td><td><code>string[]</code></td><td><code>[&quot;path&quot;, &quot;accept-language&quot;, &quot;cookie&quot;]</code></td><td>Where to look, in order; the first source that names a configured locale wins. Values: <code>&quot;path&quot;</code>, <code>&quot;accept-language&quot;</code>, <code>&quot;cookie&quot;</code>.</td></tr>
        </tbody>
      </table>
      <p>
        The full key reference is <a href="/docs/configuration/i18n"><code>[i18n]</code></a>.
      </p>

      <h2 id="how-the-locale-is-detected">How the locale is detected</h2>
      <p>For every request, the sources in <code>detect_from</code> are tried in order:</p>
      <ul>
        <li>
          <strong><code>&quot;path&quot;</code></strong> - the first path segment, when it is one
          of <code>locales</code>: <code>/de/about</code> is <code>de</code>. Matching is exact
          (<code>/DE/about</code> is not a locale prefix).
        </li>
        <li>
          <strong><code>&quot;accept-language&quot;</code></strong> - the browser&apos;s
          language list. Entries are read in the order the header lists them, and the first one
          that matches a locale wins: exactly (ignoring case), or by its language part, so{' '}
          <code>de-AT</code> matches <code>de</code>. Quality values (<code>;q=</code>) are not
          compared - browsers already send the preferred language first.
        </li>
        <li>
          <strong><code>&quot;cookie&quot;</code></strong> - a <code>gio_locale</code> cookie whose
          value is one of <code>locales</code>. GioJS reads the cookie but never sets it: your
          app sets it, typically from a language switcher (below).
        </li>
      </ul>
      <p>
        When no source matches, the locale is <code>default_locale</code>. A locale prefix is
        always removed from the path before routing, even when <code>&quot;path&quot;</code> is
        not in <code>detect_from</code>; an unknown first segment (<code>/xyz/about</code>) is
        left alone and routed as usual. A prefix for the default locale works too:{' '}
        <code>/en/about</code> renders the same page as <code>/about</code>.
      </p>
      <div className="callout">
        In the default order, <code>Accept-Language</code> comes before the cookie, so a
        visitor whose browser asks for German keeps getting German on unprefixed URLs even
        after choosing English in your switcher. To let a saved choice win, put{' '}
        <code>&quot;cookie&quot;</code> first after <code>&quot;path&quot;</code>:{' '}
        <code>detect_from = [&quot;path&quot;, &quot;cookie&quot;, &quot;accept-language&quot;]</code>.
      </div>

      <h2 id="reading-the-locale">Reading the locale</h2>
      <table>
        <thead>
          <tr><th>Where</th><th>How</th></tr>
        </thead>
        <tbody>
          <tr><td><code>getServerSideProps</code>, <code>generateMetadata</code></td><td><code>ctx.locale</code></td></tr>
          <tr><td>Page actions and route handlers</td><td><code>req.locale</code></td></tr>
          <tr><td>Components (server render and browser)</td><td><a href="/docs/hooks/use-locale"><code>useLocale()</code></a> from <code>@gio.js/react</code></td></tr>
        </tbody>
      </table>
      <p>
        <code>ctx.path</code>, <code>req.path</code> and{' '}
        <a href="/docs/hooks/use-pathname"><code>usePathname()</code></a> are the path without the
        locale prefix. A page that loads its strings in <code>getServerSideProps</code>:
      </p>
      <CodeBlock lang="tsx" title="app/greeting/page.tsx" code={`import React from 'react';
import type { GsspContext } from '@gio.js/core';
import { LocaleLink, useLocale } from '@gio.js/react';

const messages = {
  en: { hello: 'Hello' },
  de: { hello: 'Hallo' },
};
type Locale = keyof typeof messages;

export async function getServerSideProps(ctx: GsspContext) {
  const locale = (ctx.locale ?? 'en') as Locale;
  return { props: { hello: (messages[locale] ?? messages.en).hello } };
}

export default function Greeting({ hello }: { hello: string }): React.JSX.Element {
  const locale = useLocale(); // 'de' on /de/greeting
  return (
    <main lang={locale}>
      <h1>{hello}</h1>
      <LocaleLink href="/contact">Contact</LocaleLink>{/* /de/contact on German pages */}
    </main>
  );
}`} />
      <p>
        <a href="/docs/components/locale-link"><code>&lt;LocaleLink&gt;</code></a> prefixes its{' '}
        <code>href</code> with the current locale unless it is the default, already in the
        server HTML. It compares against its <code>defaultLocale</code> prop, which defaults to{' '}
        <code>&quot;en&quot;</code>: pass <code>defaultLocale</code> when yours is different.
      </p>

      <h2 id="a-language-switcher">A language switcher</h2>
      <p>
        Store the visitor&apos;s choice in the <code>gio_locale</code> cookie and send them to the
        page in that language. A page action does both, and works without JavaScript:
      </p>
      <CodeBlock lang="tsx" title="app/greeting/page.tsx" code={`import { redirect, serializeCookie, type ActionArgs } from '@gio.js/core';

const LOCALES = ['en', 'de'];

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const locale = String(form.get('locale'));
  if (!LOCALES.includes(locale)) return { status: 422, data: { error: 'Unknown locale' } };
  return redirect(locale === 'en' ? req.path : \`/\${locale}\${req.path}\`, {
    headers: {
      'set-cookie': serializeCookie('gio_locale', locale, { maxAge: 60 * 60 * 24 * 365 }),
    },
  });
}

// In the page component:
// <form method="post">
//   <button name="locale" value="de">Deutsch</button>
//   <button name="locale" value="en">English</button>
// </form>`} />
      <CodeBlock lang="text" code={`$ curl -si -X POST -d locale=de http://localhost:3000/greeting | grep -i 'location\\|set-cookie'
location: /de/greeting
set-cookie: gio_locale=de; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`} />
      <p>
        <code>serializeCookie</code> adds <code>Secure</code> in production only, so the cookie
        also works on <code>http://localhost</code> in development.
      </p>

      <h2 id="html-lang">The html lang attribute</h2>
      <p>
        For a locale other than the default, the server adds <code>lang=&quot;de&quot;</code> as
        the first attribute of the page&apos;s <code>&lt;html&gt;</code> tag, which browsers and
        screen readers use. Keep <code>lang</code> set to your default locale in the root
        layout; pages in the default locale keep it as written.
      </p>

      <h2 id="caching-and-seo">Caching and SEO</h2>
      <ul>
        <li>
          The page cache keys every page by locale, so <code>/de/about</code> and{' '}
          <code>/about</code> are separate entries.
        </li>
        <li>
          A page whose locale came from the URL prefix can be shared by CDNs as usual. One whose
          locale came from <code>Accept-Language</code> or the cookie (an unprefixed URL while{' '}
          <code>detect_from</code> lists them) serves different languages at one URL, so it is
          sent as <code>Cache-Control: private, no-cache</code> without an <code>ETag</code>.
          Link to prefixed URLs where CDN caching matters.
        </li>
        <li>
          Purging a page with <code>revalidatePath(&apos;/de/about&apos;)</code> or{' '}
          <code>/_gio/revalidate</code> purges it in every locale: the locale segment is
          dropped from the path.
        </li>
        <li>
          Tell search engines about the other languages with{' '}
          <a href="/docs/page-exports/metadata"><code>metadata</code></a>{' '}
          <code>alternates.languages</code>:
          <CodeBlock lang="ts" title="app/about/page.tsx" code={`export const metadata = {
  alternates: {
    canonical: '/about',
    languages: { en: '/about', de: '/de/about', fr: '/fr/about' },
  },
};`} />
        </li>
        <li>
          <code>default_locale</code> is part of the deployment ID: changing it drops the
          persisted page cache.
        </li>
      </ul>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A redirect built from <code>ctx.path</code> loses the prefix: add{' '}
          <code>ctx.locale</code> back when the target should stay in the visitor&apos;s
          language.
        </li>
        <li>
          <a href="/docs/middleware">Guards, redirects, rewrites and header rules</a>, rate
          limits and CSRF exemptions see the path after the prefix is removed: a guard on{' '}
          <code>/admin/*rest</code> also covers <code>/de/admin</code>. Their redirect targets
          are used as written, so <code>/de/blog/x</code> through a{' '}
          <code>/blog/:slug</code> rule lands on the unprefixed target.
        </li>
        <li>
          <a href="/docs/static-export">Static export</a> has no server, so there is no
          detection and no prefix handling: <code>useLocale()</code> returns{' '}
          <code>&apos;&apos;</code> in an exported site.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration/i18n"><code>[i18n]</code></a> reference</li>
        <li><a href="/docs/hooks/use-locale"><code>useLocale</code></a> and <a href="/docs/components/locale-link"><code>&lt;LocaleLink&gt;</code></a></li>
        <li><a href="/docs/metadata">Metadata &amp; SEO</a></li>
        <li><a href="/docs/caching">Caching &amp; Revalidating</a></li>
      </ul>
    </>
  );
}
