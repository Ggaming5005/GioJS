import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'useLocale',
  description: 'Read the locale the server detected for this request, during server rendering and in the browser.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>useLocale</h1>
      <p className="page-subtitle">
        Read the locale the server detected for this request, during server rendering and in the
        browser.
      </p>
      <CodeBlock lang="tsx" code={`import { useLocale } from '@gio.js/react';

export function Price({ amount }: { amount: number }) {
  const locale = useLocale() || 'en';
  return <>{new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(amount)}</>;
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <p><code>useLocale</code> takes no parameters.</p>
      <h3 id="returns">Returns</h3>
      <p>A <code>string</code>:</p>
      <ul>
        <li>
          with <code>[i18n] locales</code> set in <code>gio.toml</code>, always one of them: the
          locale the server detected, or <code>default_locale</code> when nothing matched;
        </li>
        <li>without <code>[i18n]</code>, <code>&apos;&apos;</code>.</li>
      </ul>

      <h3 id="how-the-locale-is-detected">How the locale is detected</h3>
      <p>
        The Rust server tries the sources in <code>[i18n] detect_from</code> order (default{' '}
        <code>[&quot;path&quot;, &quot;accept-language&quot;, &quot;cookie&quot;]</code>) and takes
        the first that names a configured locale:
      </p>
      <ul>
        <li><code>path</code> - a first path segment that is a locale (<code>/fr/about</code>). The prefix is always removed before routing, so the page is <code>app/about/page.tsx</code> and <code>usePathname()</code> is <code>/about</code>.</li>
        <li><code>accept-language</code> - the first language in the header that is a locale, by full tag (<code>fr-CA</code>) or language (<code>fr</code>).</li>
        <li><code>cookie</code> - the <code>gio_locale</code> cookie.</li>
      </ul>
      <p>
        For HTML responses in a locale other than the default, the server also adds{' '}
        <code>lang=&quot;&lt;locale&gt;&quot;</code> to the <code>&lt;html&gt;</code> element.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The value travels with the page, so the server render and the hydration render agree
          and the server HTML already holds locale-dependent output, such as a{' '}
          <a href="/docs/components/locale-link"><code>&lt;LocaleLink&gt;</code></a>&apos;s prefixed{' '}
          <code>href</code>.
        </li>
        <li>After a soft navigation, hydrated components read the new page&apos;s locale.</li>
        <li>
          Outside a tree GioJS rendered (a unit test, a separate React root), it returns{' '}
          <code>&apos;&apos;</code> on the first render and then{' '}
          <code>document.documentElement.lang</code>, read in an effect so hydration cannot
          mismatch.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="translating-strings">Translating strings</h3>
      <CodeBlock lang="tsx" title="app/(site)/greeting.tsx" code={`import { useLocale } from '@gio.js/react';

const MESSAGES: Record<string, { hello: string }> = {
  en: { hello: 'Hello' },
  fr: { hello: 'Bonjour' },
};

export function Greeting() {
  const locale = useLocale();
  return <p>{(MESSAGES[locale] ?? MESSAGES.en).hello}</p>;
}`} />

      <h3 id="formatting-dates">Formatting dates</h3>
      <CodeBlock lang="tsx" code={`const locale = useLocale() || 'en';
const published = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(post.publishedAt));`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          On the server, route handlers and <code>getServerSideProps</code> read the same value
          as <code>req.locale</code> (<code>&apos;&apos;</code> without <code>[i18n]</code>) and{' '}
          <code>ctx.locale</code> (absent without <code>[i18n]</code>).
        </li>
        <li>
          The page cache keeps one copy per locale. A URL without a locale prefix depends on
          the visitor&apos;s headers, so its response is never marked <code>public</code> for CDNs
          and carries no <code>ETag</code>; link to prefixed URLs where shared caching matters.
        </li>
        <li>
          GioJS never sets the <code>gio_locale</code> cookie; set it yourself to remember a
          visitor&apos;s choice.
        </li>
        <li>
          In the server-only root layout the value is that of the page loaded in full.
        </li>
        <li>
          Locales are matched exactly as written in <code>locales</code> for the path and the
          cookie; the <code>Accept-Language</code> match ignores case.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/i18n">Internationalization</a> - the guide.</li>
        <li><a href="/docs/configuration/i18n"><code>[i18n]</code></a> - <code>locales</code>, <code>default_locale</code>, <code>detect_from</code>.</li>
        <li><a href="/docs/components/locale-link"><code>&lt;LocaleLink&gt;</code></a> - links that keep the locale.</li>
        <li><a href="/docs/hooks/use-pathname"><code>usePathname</code></a> - the path without the prefix.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Returns the request locale during server rendering too, from the navigation state GioJS provides.</> },
        { version: 'v0.1.0-beta.6', changes: 'No longer causes hydration mismatches.' },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
