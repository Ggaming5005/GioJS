import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: '<LocaleLink>',
  description:
    "A GioLink that keeps the visitor's language: it adds the request locale as a path prefix when it is not the default locale.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>&lt;LocaleLink&gt;</h1>
      <p className="page-subtitle">
        A <code>GioLink</code> that keeps the visitor&apos;s language: it adds the request
        locale as a path prefix when it is not the default locale.
      </p>
      <CodeBlock lang="tsx" code={`import { LocaleLink } from '@gio.js/react';

<LocaleLink href="/pricing">Pricing</LocaleLink>
// on a French page: <a href="/fr/pricing">`} />

      <h2 id="reference">Reference</h2>
      <PropsTable rows={[
        {
          name: 'href',
          type: 'string',
          required: true,
          description: <>The path without a locale prefix, starting with <code>/</code>. Other URLs pass through unchanged (see <a href="#behavior">Behavior</a>).</>,
        },
        {
          name: 'defaultLocale',
          type: 'string',
          default: '[i18n] default_locale',
          description: <>The locale that gets no prefix. Leave it out: it is read from <code>gio.toml</code>. Pass it only to override that for one link.</>,
        },
        {
          name: 'className',
          type: 'string',
          description: <>Passed to the <code>&lt;a&gt;</code>.</>,
        },
        {
          name: 'children',
          type: 'React.ReactNode',
          required: true,
          description: 'The link content.',
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        The locale comes from <a href="/docs/hooks/use-locale"><code>useLocale()</code></a>.
        When it is not empty and differs from <code>defaultLocale</code>, a path that starts with{' '}
        <code>/</code> gets <code>/&lt;locale&gt;</code> in front. Everything else is used as
        written: absolute URLs (<code>https:</code>, <code>mailto:</code>), protocol-relative ones
        (<code>//cdn.example.com</code>), relative paths, <code>?query</code> and{' '}
        <code>#hash</code> hrefs, and paths whose first segment already is one of your{' '}
        <code>locales</code>. The result is a{' '}
        <a href="/docs/components/gio-link"><code>&lt;GioLink&gt;</code></a> with its defaults:
        client-side navigation and hover prefetch. The locale is known during server rendering, so
        the prefixed <code>href</code> is already in the HTML.
      </p>
      <p>
        With <code>default_locale = &quot;en&quot;</code>:
      </p>
      <table>
        <thead><tr><th>Request locale</th><th><code>href</code></th><th>Rendered</th></tr></thead>
        <tbody>
          <tr><td><code>&apos;&apos;</code> (no <code>[i18n]</code>)</td><td><code>/pricing</code></td><td><code>/pricing</code></td></tr>
          <tr><td><code>en</code> (the default)</td><td><code>/pricing</code></td><td><code>/pricing</code></td></tr>
          <tr><td><code>fr</code></td><td><code>/pricing</code></td><td><code>/fr/pricing</code></td></tr>
          <tr><td><code>fr</code></td><td><code>/</code></td><td><code>/fr/</code></td></tr>
          <tr><td><code>fr</code></td><td><code>/de/preise</code></td><td><code>/de/preise</code></td></tr>
          <tr><td><code>fr</code></td><td><code>https://example.com/</code></td><td><code>https://example.com/</code></td></tr>
        </tbody>
      </table>
      <p>
        The default locale is <code>[i18n] default_locale</code>. The server hands the{' '}
        <code>[i18n]</code> settings to the worker, and every hydration envelope of an app with{' '}
        <code>locales</code> carries them to the browser, so the server HTML and the hydrated link
        agree. A <code>LocaleLink</code> rendered outside a GioJS page tree (in a React root of your
        own) reads <code>window.__GIO_DEFAULT_LOCALE__</code> and{' '}
        <code>window.__GIO_LOCALES__</code>, which the server puts in every page. Without them -
        in <a href="#good-to-know"><code>renderPage</code></a>, for one - the default is <code>en</code>{' '}
        and only an <code>href</code> that starts with the current or default locale counts as
        already prefixed.
      </p>
      <p>
        The request locale is what the server detected: the URL prefix, the{' '}
        <code>Accept-Language</code> header or the <code>gio_locale</code> cookie, in the order{' '}
        <code>[i18n] detect_from</code> sets. A French browser on <code>/pricing</code> - no
        prefix - therefore gets links to <code>/fr/...</code>.
      </p>

      <h2 id="examples">Examples</h2>

      <h3 id="localized-navigation">Localized navigation</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[i18n]
locales = ["de", "en", "fr"]
default_locale = "de"`} />
      <CodeBlock lang="tsx" title="app/(site)/nav.tsx" code={`import { LocaleLink } from '@gio.js/react';

export function Nav() {
  return (
    <nav>
      <LocaleLink href="/">Start</LocaleLink>
      <LocaleLink href="/preise">Preise</LocaleLink>
    </nav>
  );
}`} />

      <h3 id="a-language-switcher">A language switcher</h3>
      <p>
        <code>LocaleLink</code> always keeps the current locale. To switch, link to the path
        with the target locale&apos;s prefix - the default locale&apos;s too, since a path
        without a prefix is detected from the browser&apos;s language again. A plain{' '}
        <code>&lt;a&gt;</code> loads the page in full, so the server-only root layout is rendered
        in the new language too; a soft navigation would leave it as it was.
      </p>
      <CodeBlock lang="tsx" title="app/(site)/language-switcher.tsx" code={`import { useLocale, usePathname } from '@gio.js/react';

const LANGUAGES = [
  { locale: 'de', label: 'Deutsch' },
  { locale: 'en', label: 'English' },
  { locale: 'fr', label: 'Français' },
];

export function LanguageSwitcher() {
  const current = useLocale();
  const pathname = usePathname(); // without the locale prefix
  return (
    <ul>
      {LANGUAGES.map(({ locale, label }) => (
        <li key={locale}>
          <a href={\`/\${locale}\${pathname}\`} hrefLang={locale} aria-current={locale === current ? 'page' : undefined}>
            {label}
          </a>
        </li>
      ))}
    </ul>
  );
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          German pages of a site with <code>default_locale = &quot;de&quot;</code> link to{' '}
          <code>/preise</code>, English ones to <code>/en/preise</code> - no prop needed.
        </li>
        <li>
          A path that already starts with a locale is left alone, so{' '}
          <code>&lt;LocaleLink href=&quot;/de/preise&quot;&gt;</code> always points at the German
          page. Matching is exact, as for the URL prefix itself: <code>/english</code> is a path,
          not the <code>en</code> locale.
        </li>
        <li>
          <a href="/docs/functions/render-page"><code>renderPage</code></a> runs no <code>[i18n]</code>: there
          the default locale is <code>en</code> and only a path starting with the current or
          default locale is left alone, so pass <code>defaultLocale</code> in tests of a site
          whose default is another one.
        </li>
        <li>
          Only <code>href</code>, <code>defaultLocale</code>, <code>className</code> and{' '}
          <code>children</code> are taken: <code>prefetch</code>, <code>transition</code>,{' '}
          <code>replace</code> and <code>scroll</code> keep the <code>GioLink</code> defaults.
        </li>
        <li>
          GioJS never sets the <code>gio_locale</code> cookie. Set it yourself (for example from
          a route handler) to remember a choice for URLs without a prefix.
        </li>
        <li>
          In the server-only root layout the link is a plain <code>&lt;a&gt;</code>, as for{' '}
          <code>GioLink</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/i18n">Internationalization</a> - locale detection and routing.</li>
        <li><a href="/docs/configuration/i18n"><code>[i18n]</code></a> - <code>locales</code>, <code>default_locale</code>, <code>detect_from</code>.</li>
        <li><a href="/docs/hooks/use-locale"><code>useLocale</code></a> - the request locale.</li>
        <li><a href="/docs/components/gio-link"><code>&lt;GioLink&gt;</code></a> - the link it renders.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>The prefixed <code>href</code> is rendered on the server, since <code>useLocale()</code> returns the request locale there. <code>defaultLocale</code> defaults to <code>[i18n] default_locale</code> instead of <code>&apos;en&apos;</code>. Absolute, protocol-relative and relative URLs, <code>?query</code> and <code>#hash</code> hrefs and paths that already start with a locale are no longer prefixed.</> },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
