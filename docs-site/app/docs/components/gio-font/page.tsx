import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: '<GioFont>',
  description:
    'A typed marker for a font family declared in gio.toml. It renders nothing: the server self-hosts and preloads the files listed in [[fonts]].',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>&lt;GioFont&gt;</h1>
      <p className="page-subtitle">
        A typed marker for a font family declared in <code>gio.toml</code>. It renders nothing:
        the server self-hosts and preloads the files listed in <code>[[fonts]]</code>.
      </p>
      <CodeBlock lang="tsx" code={`import { GioFont } from '@gio.js/react';

<GioFont family="Inter" weights={[400, 700]} />`} />
      <p>
        Fonts in GioJS are configuration, not code. The Rust server reads{' '}
        <code>[[fonts]]</code> at startup, copies or downloads each <code>.woff2</code> file,
        serves it from <code>/_gio/fonts/</code>, and adds a{' '}
        <code>&lt;link rel=&quot;preload&quot;&gt;</code> per file and a generated{' '}
        <code>@font-face</code> stylesheet to the head of every page.{' '}
        <code>&lt;GioFont&gt;</code> lets a component say which family and weights it relies
        on, next to the CSS that uses them; it has no effect on what is served.
      </p>

      <h2 id="reference">Reference</h2>
      <PropsTable rows={[
        {
          name: 'family',
          type: 'string',
          required: true,
          description: <>The font family, as written in a <code>[[fonts]] family</code> entry and in your CSS <code>font-family</code>.</>,
        },
        {
          name: 'weights',
          type: 'number[]',
          description: <>The weights the component uses, each matching a <code>[[fonts]] weight</code> entry of that family.</>,
        },
      ]} />
      <h3 id="returns">Returns</h3>
      <p>
        <code>null</code>. Nothing reads the props - not the React render, not the client
        bundle, not the Rust server: a family or weight missing from <code>gio.toml</code> is not
        an error, and the text falls back to the next font in your CSS stack.
      </p>

      <h3 id="the-fonts-entries">The [[fonts]] entries</h3>
      <p>One entry per file - one weight and style of one family:</p>
      <PropsTable kind="Key" rows={[
        { name: 'family', type: 'string', required: true, description: <>The <code>font-family</code> name in the generated <code>@font-face</code> rule.</> },
        { name: 'url', type: 'string', required: true, description: <>A file in <code>public/</code> (<code>/public/fonts/inter-400.woff2</code> or <code>/fonts/inter-400.woff2</code>), read at every start, or an <code>https://</code> URL downloaded on the first start.</> },
        { name: 'weight', type: 'integer', default: '400', description: <>The <code>font-weight</code> of this file.</> },
        { name: 'style', type: 'string', default: '"normal"', description: <>The <code>font-style</code>, such as <code>&quot;italic&quot;</code>.</> },
        { name: 'preload', type: 'boolean', default: 'true', description: <>Preload the file from every page. <code>false</code> for fonts only used below the fold.</> },
      ]} />

      <h2 id="examples">Examples</h2>
      <h3 id="a-family-in-two-weights">A family in two weights</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[fonts]]
family = "Inter"
url = "/public/fonts/inter-400-normal.woff2"

[[fonts]]
family = "Inter"
url = "/public/fonts/inter-700-normal.woff2"
weight = 700`} />
      <CodeBlock lang="tsx" title="app/(site)/layout.tsx" code={`import type { LayoutProps } from '@gio.js/core';
import { GioFont } from '@gio.js/react';
import './site.css';

export default function SiteLayout({ children }: LayoutProps) {
  return (
    <>
      <GioFont family="Inter" weights={[400, 700]} />
      {children}
    </>
  );
}`} />
      <CodeBlock lang="css" title="app/(site)/site.css" code={`body {
  font-family: 'Inter', system-ui, sans-serif;
}

h1 {
  font-weight: 700;
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Unlike Next.js&apos;s <code>next/font</code>, nothing is generated from the component:
          no class name, no CSS variable, no subsetting. Use the family name in CSS.
        </li>
        <li>
          Every <code>@font-face</code> rule uses <code>font-display: swap</code>, so text shows
          in a fallback font until the file arrives. This is fixed.
        </li>
        <li>
          <code>[[fonts]]</code> is applied by the Rust server. A{' '}
          <a href="/docs/static-export">static export</a> declares its fonts with{' '}
          <code>@font-face</code> in an imported stylesheet instead (see{' '}
          <a href="/docs/font-optimization#static-export">Font Optimization</a>).
        </li>
        <li>
          The served <code>.woff2</code> files are cached as immutable. A local file gets a new,
          content-hashed URL when it changes; a remote one is downloaded only once, so give a
          changed remote font a new URL.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/font-optimization">Font Optimization</a> - local and remote fonts, caching, static export.</li>
        <li><a href="/docs/configuration/fonts"><code>[[fonts]]</code></a> - the configuration reference.</li>
        <li><a href="/docs/css">CSS</a> - importing the stylesheets that use the fonts.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>[[fonts]]</code> may name a file in <code>public/</code>, and takes <code>preload = false</code>.</> },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
