import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[i18n]',
  description:
    'Locale routing: the locales a site serves, the default one, and the order the URL prefix, ' +
    'Accept-Language and the gio_locale cookie are read in.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[i18n]</h1>
      <p className="page-subtitle">
        Locale routing: the locales a site serves, the default one, and the order the URL prefix,{' '}
        <code>Accept-Language</code> and the <code>gio_locale</code> cookie are read in.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[i18n]
locales = ["en", "de", "fr"]
default_locale = "en"`} />
      <p>
        With no locales, i18n is off and costs nothing. In components,{' '}
        <a href="/docs/hooks/use-locale"><code>useLocale()</code></a> returns the request&apos;s
        locale and <a href="/docs/components/locale-link"><code>&lt;LocaleLink&gt;</code></a>{' '}
        prefixes links with it. See <a href="/docs/i18n">Internationalization</a>.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'locales', type: 'string[]', default: '[]', zero: <>Empty: i18n is off</>, description: <>The locales the site serves, as they appear in URLs (<code>/de/about</code>).</> },
        { key: 'default_locale', type: 'string', default: '"en"', description: <>The locale when nothing else decides. Pages in it are served without a prefix, and <code>&lt;html lang&gt;</code> is left as the root layout renders it.</> },
        { key: 'detect_from', type: 'string[]', default: '["path", "accept-language", "cookie"]', description: <>Where the locale comes from, tried in this order: <code>&quot;path&quot;</code> (the first URL segment), <code>&quot;accept-language&quot;</code> (the header), <code>&quot;cookie&quot;</code> (<code>gio_locale</code>). The first that names a configured locale wins.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          A leading locale segment is always removed before routing, whether or not{' '}
          <code>&quot;path&quot;</code> is in <code>detect_from</code>: <code>/de/about</code> renders{' '}
          <code>app/about/page.tsx</code> and <code>/de</code> renders the home page.
        </li>
        <li>
          <code>Accept-Language</code> entries are tried by quality value, highest first (the
          browser&apos;s order breaks ties); <code>q=0</code> or a malformed <code>q</code> rules
          an entry out. An entry matches a locale exactly, ignoring case (<code>pt-br</code>{' '}
          picks <code>pt-BR</code>), or by its language (<code>de-AT</code> picks{' '}
          <code>de</code>). The result is always spelled as in <code>locales</code>.
        </li>
        <li>
          The <code>gio_locale</code> cookie must hold one of the configured locales. GioJS reads
          it and never sets it; your app sets it, for example from a language switcher.
        </li>
        <li>
          When the locale is not the default, the server writes it into <code>&lt;html lang&gt;</code>,
          replacing the root layout&apos;s <code>lang</code>.
        </li>
        <li>
          <a href="/docs/components/locale-link"><code>&lt;LocaleLink&gt;</code></a> leaves{' '}
          <code>default_locale</code> unprefixed. The server passes this section to the worker
          (<code>GIO_I18N_CONFIG</code>), so changing it changes the deployment id.
        </li>
        <li>
          Cached pages are stored per locale. While <code>detect_from</code> reads a header or the
          cookie, a page requested without a locale prefix is sent{' '}
          <code>Cache-Control: private, no-cache</code> without an ETag: one URL serves several
          languages there, and shared caches key by URL. Prefixed URLs stay shareable.
        </li>
      </ul>
      <p>No key in this section logs a warning. Startup logs the locales when i18n is on.</p>

      <h2 id="examples">Examples</h2>
      <h3 id="url-prefixes-only">URL prefixes only</h3>
      <p>Every language has its own URLs, which CDNs can cache:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[i18n]
locales = ["en", "de"]
default_locale = "en"
detect_from = ["path"]`} />

      <h3 id="a-remembered-choice-wins-over-the-browser">A remembered choice wins over the browser</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[i18n]
locales = ["en", "de", "fr"]
detect_from = ["path", "cookie", "accept-language"]`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A value in <code>detect_from</code> other than the three above is ignored without an
          error, so check the spelling (<code>&quot;accept-language&quot;</code>).
        </li>
        <li>
          <code>default_locale</code> is not checked against <code>locales</code>; keep it in the
          list.
        </li>
        <li>
          The URL prefix and the cookie match <code>locales</code> exactly: <code>/pt-br/</code>{' '}
          is not the <code>pt-BR</code> locale. Only <code>Accept-Language</code> ignores case.
        </li>
        <li>
          <code>revalidatePath</code> and <code>POST /_gio/revalidate</code> drop a leading locale
          from a path, so a purge reaches every language of the page.
        </li>
        <li>The section is part of the deployment id: changing it drops persisted pages.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/i18n">Internationalization</a></li>
        <li><a href="/docs/hooks/use-locale"><code>useLocale</code></a> and <a href="/docs/components/locale-link"><code>&lt;LocaleLink&gt;</code></a></li>
        <li><a href="/docs/configuration/cache"><code>[cache]</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Pages whose locale was negotiated from request headers are never <code>public</code> and get no ETag. <code>useLocale()</code> returns the request locale during server rendering too. <code>Accept-Language</code> is read by quality value and gives the locale as spelled in <code>locales</code> (an exact match was lowercased). <code>&lt;html lang&gt;</code> replaces the root layout&apos;s <code>lang</code> instead of adding a second one. <code>&lt;LocaleLink&gt;</code> defaults to <code>default_locale</code>.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced with <code>locales</code>, <code>default_locale</code> and <code>detect_from</code>.</> },
      ]} />
    </>
  );
}
